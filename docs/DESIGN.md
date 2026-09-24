# Design notes

Reasoning behind this plugin, with the evidence it rests on. Every line reference was read from the
installed build named under *Compatibility* in the README; the raw session logs it was measured on are
kept locally and are not part of this repository.

## The failure this targets

A stalled session's log ends like this, with no error anywhere:

```
agent/inbox/spliced     ← the user message is accepted
turn/start              ← the turn opens
                        ← and then nothing: no step/start, no assistant frames
```

The silence sits exactly in the `preStep` window — between `turn/start` (`dsh-agent-loop/lib/index.js:528`)
and `step/start` (`:553`), with only `await this.preStep(...)` (`:539`) in between. Two earlier guesses
were wrong and are recorded here so they are not re-derived: it is **not** a missing timeout, and it is
**not** the network.

**The causal step below is FALSIFIED — see *Measured falsification* immediately after the table.** Every
row in the table is a code-level fact; "therefore this replay stalls the turn" is not, and the replay has
since been measured directly and is far too small to be the cause.

### The mechanism

| Step | Source |
|---|---|
| A restart or a session load creates a **new `Session` object** | `@deepseek-ai/dsh-session/lib/index.js:1322` appends `session/end-seed` when a stored session is loaded |
| The token meter's replay state is a `WeakMap` keyed by that object | `@deepseek-ai/dsh-token-meter/lib/index.js:589` |
| A new object ⇒ empty state ⇒ `consumedEvents = 0` ⇒ replay the entire log | `dsh-token-meter/lib/index.js:679-697`, `while (state.consumedEvents < session.seq)` |
| Something calls it on **every** pre-step | `dsh-compaction-basic/lib/index.js:782` registers `agent/pre-step`; `:784` calls `compactIfNeeded`; `:862` calls `meter.measure(session)` |
| Automatic compaction is on by default, so that listener is always mounted | `dsh-compaction-basic/lib/index.js:76` `auto: config.auto ?? true` (no `compaction` entry exists in the observed `settings.yaml` or profile patch) |
| That replay therefore runs between `turn/start` and `step/start` | as above |

`_sync` is **synchronous**: it blocks the event loop, so `step/start` can never be appended and
`while (await this.turn())` (`dsh-agent-loop:484`) never returns. The UI spins forever, and the log
stays silent — which is precisely the observed signature.

Note that the replay walks the **integer seq space**, not the number of stored records. The log on disk
batches streaming deltas into `reasoning-chunks` / `tool-call-chunks` / `text-chunks` records carrying a
`seq0` plus a `dt` delta array, so ~17 k records expand to a dense ~517 k-event timeline in memory.

### Measured falsification (supersedes the causal claim above)

`tools/measure-replay.js` reconstructs the dense seq timeline from the real log — batched chunk records
expanded, `sourceEventSeqs` ranges flattened into per-event seqs — and then runs the **product's own
`TokenMeter._sync`** over it. The reconstruction validates itself: **12,071 of 12,073** fill-ins were
independently confirmed as chunk seqs by the `sourceEventSeqs` ranges (99.98%), and the replay's own
invariant checks (every cited source seq must be an `assistant/chunk` of the same turn and step) pass.

| seq reconstructed | cold `_sync` |
|---|---|
| 50,000 | 10.7 ms |
| 200,000 | 17.3 ms |
| 400,000 | 34.8 ms |
| **526,383 — the entire session** | **47.0 ms** |

A full cold replay of the whole session costs **47 milliseconds**. The cold first turn this was supposed to
explain took **16,008 ms**; the turns at seq 93 k and beyond never returned. The replay is ~340× too small
for the first and cannot explain the second. **The replay is not the cause of the stall.**

The production side agrees: `/compact` calls `tokenMeter.measure(session)` as its *first* step
(`dsh-compaction-basic:935`), and both observed cold-start `/compact` runs reached `compaction/start` in
1,013 ms and 1,117 ms at seq 388,770 and 446,452.

What still stands: the cold first turn *is* catastrophically slower than a warm one on the same session
(16,008 ms vs 231 ms), it grows with session size, and `/compact` was the only observed recovery.
**What owns that time is unknown.**

The likely *shape* of the answer is an awaited blocking operation inside an `agent/pre-step` or
`system-prompt/assemble` listener. A concrete instance of that pattern exists in this very composition:
`dsh-vision-router/lib/ollama-cold-start.js` installs an `agent/pre-step` wrapper that
`await manager.ensure(provider, …)` — a network warmup bounded by `OLLAMA_WARMUP_TIMEOUT_MS = 120000` — and
its own comment describes the intent as letting "a large cold model … load once instead of being
misclassified as a 45s inference timeout". Its trigger conditions (a local Ollama provider *and* an image
in the turn) do not match the observed text-only sessions, so it is a **template for the fault class, not
the culprit** — but it shows this composition does contain listeners that block pre-step on network I/O.

### Measurements

One real session (`session-db08f763`, 5.9 MB on disk, seq up to ~517 k), `preStep` = `turn/start` →
first `step/start`:

| Turn | seq at start | cold or warm | `preStep` |
|---|---|---|---|
| 2 | 35,236 | warm (same process) | 231 ms |
| 5 | 45,585 | **cold** (process had just restarted) | **16,008 ms** |
| 7 | 93,333 | **cold** | never returned (user gave up after 22 s) |
| 28 / 29 / 30 | 388,757 | **cold** | never returned (32–47 s) |
| 34 / 35 | 446,442 | **cold** | never returned (40–41 s) |
| 8 / 31 / 36 | same sizes, **after `/compact`** | cold | 1,637 / 10,142 / 4,730 ms |

Process restarts were matched to the harness log's `[desktop] starting` timestamps: **every** stalled
turn is the first turn after a restart, and in three separate episodes `/compact` was the only thing
that restored service — restarting again did not.

Three consequences, each checkable against the logs:

1. **Restarting makes it worse.** Each restart is another cold replay of a longer log.
2. **`/compact` works.** It is the only observed recovery.
3. **Absolute size is not the trigger.** Turn 6 succeeded at 232,878 tokens; turn 7 failed cold at the
   same size. What decides the outcome is *when* the replay is paid.

## Why the v0.1 approach was removed

v0.1 detected a stall, cancelled the turn (`ctx.agents.get(id).cancel(...)`) and attempted a bounded cold
rebuild. That action model **cannot work for this failure**: the block is a synchronous CPU loop, so the
event loop never yields and `signal.throwIfAborted()` (`dsh-agent-loop:503`) never runs. Nothing in the
harness can interrupt it. The module was deleted rather than left in place, so the code does not advertise
a capability it lacks.

## How the fix works

The replay is unavoidable; **where it is paid is not.** Paid inside the user's first turn it is a permanent
hang; paid while the agent is idle right after a load it is a slow start. And once compaction has run, the
following cold starts stay cheap in every episode observed.

1. **GUARD** — when a session is first seen in this process and `seq` is already past the danger threshold,
   compact it before the user's first turn, on `agent/status → idle`.
2. **COMPACT** — between turns, while the agent is idle, compact once the session has grown by
   `minGrowthSeq` since the last compaction.
3. **Report** — `/rescue status` shows `seq`, cold/warm state, and the plugin's own `preStep` measurements.

The only action taken is the official compaction seam,
`ctx.compaction.compactNow(agent, signal, commandId)`
(`@deepseek-ai/dsh-command-compact/lib/index.js:8,54`). It is fetched with `ctx.get('compaction')` rather
than declared in `inject`, so the plugin still loads and reports honestly in compositions without it.

### Anti-thrash: the trigger must be a growth delta

Compaction **does not shrink `session.seq`**. The log is append-only and compaction appends
`compaction/start`, `compaction/summary` and `compaction/end` of its own. A rule of the form "compact when
`seq >= threshold`" would therefore re-fire on every idle period, forever, each time paying an LLM call.
The trigger is instead "grown by at least `minGrowthSeq` since the last compaction", and a successful
compaction pushes that baseline to the current `seq`. `test/guard.test.js` asserts this property directly.

### `busy` is not a failure

`ManualCompactionError` with code `busy` means the core refused the call — a compaction is already running,
or the agent is not idle. **No replay was paid**, so the session is *not* marked warm; marking it warm
would let a cold session miss its GUARD and the next user turn would hang again. Retries are bounded by a
cooldown and a consecutive-`busy` cap (`maxBusyStreak`).

## Bounds, safety, non-goals

- The plugin only ever calls the documented compaction seam. It does not modify Harness packages, does not
  write session logs, does not touch other sessions and never restarts the app.
- One compaction attempt at a time per session; re-entrancy guarded; per-session attempt cap, cooldown, and
  an abort signal with a timeout on each call.
- It does not create sessions and does not resume them — that would duplicate what the app already does.
- With `enabled: false` it observes and reports only.

## Verification performed

Offline and isolated only. The running Harness instance was never used as a test target — that mistake
was made once, cost the user a hung session, and is not repeated.

| What | How | Result |
|---|---|---|
| Decision logic | `test/size.test.js` + `test/guard.test.js`, pure state machine, no I/O | pass |
| Plugin wiring | `test/host.test.js` against a fake cordis context: event delivery, GUARD/COMPACT paths, anti-thrash, `busy` semantics, caps, command branches | pass |
| Stall signature vs. real logs | `tools/replay.js` on an observed 5.9 MB session | 5/5 known stalls hit, 0 false positives |
| **Bundle loading, hooks and the compaction seam in a real Harness** | `dsh --profile headless` in an **isolated** `DSH_HOME` with the plugin linked in and `dangerSeq: 0` forced | the run wrote a real `compaction/start` frame carrying `sourceCommandId: "session-rescue-guard-1"` — the plugin's own id. Reproduced twice. |

`node --test test/*.test.js` → **55 pass, 0 fail**.

What the isolated run proves: the plugin loads as a bundle in a real profile; `session/event` and
`agent/status` fire and the idle handler runs; `ctx.get('compaction')` resolves to the real compaction
service; `compactNow(agent, signal, commandId)` is callable and opens a genuine compaction transaction; a
failure inside it is recorded honestly in `compaction/end` without breaking the harness; and exactly one
attempt is made — anti-thrash holds in a live harness, not just in tests.

What it does **not** prove: the cold-start stall was not reproduced under control, and the
"GUARD runs before the user's first turn" ordering was not exercised, because headless dispatches its task
immediately and so never leaves an idle window before turn 1. That ordering is covered by unit tests only.
Reproducing the stall itself needs a session loaded from disk plus a resume path (`dsh-acp`
`session.resume` / `session.prompt`, or `dsh-agent-loop`'s configured `resumeSessionId`); that harness has
not been built.

## Open questions (stated, not hidden)

- **★ The cause is unknown; the replay is excluded by measurement.** See *Measured falsification*: the
  full cold replay of this session is 47 ms, against a 16,008 ms cold pre-step. The blocker is therefore
  something else in the same window — most plausibly an awaited operation in one of the
  `agent/pre-step` / `system-prompt/assemble` listeners. **No listener has been timed yet**, and timing
  them needs a controlled reproduction (a session loaded from disk plus a scripted turn), which has not
  been built.
- **Candidates examined and set aside so far** — recorded with their evidence so they are not re-derived:
  - `dsh-mnemon` — `preStep` awaits `next()` first (`:5389-5391`); its per-turn memory work is
    `compose({scope, scenario, budget})` (`:1743-1749`), which never receives the conversation. Its
    `hostSessionEvents(this.agent.session)` calls (`:5320`, `:5343`, `:5347`, `:5457`, `:5469`, `:5549`)
    do materialise the whole `session.events` array, but the ones inspected are
    `snapshot()` / `turnMemoryActivities()` / `assistantMessageText()` — diagnostics and accessors, not
    pre-step work. **Not formally excluded.**
  - `@vectorize-io/hindsight-coding-agents` — its `agent/pre-step` hook is real and awaits
    `workspace.core.onPrompt(sessionId, prompt)` (`dist/dsh.js:18157`), plus once per process a
    `seedIfCold` that awaits `ensureDaemon(..., { waitMs: 12e3 })` (`:17883`, with
    `DAEMON_WAIT_SESSION_START_MS = 12000` at `:1781`) and `buildSessionStartContext` (`:17886`); all
    errors are swallowed (`:17900`). **On this machine it appears inert**: `~/.hindsight` does not exist
    at all (no config, runtime dir or logs), there is no `%TEMP%\hindsight-*` session cache, and the
    observed workspace is a git repo with **no remote** — `deriveBankIdOrSkip` returns `null` on
    "repository could not be identified" (`:364-376`), which sets `cfg.disabled = true`, makes
    `workspaceFor` return `undefined`, and makes the hook return early at `:18151`. **Not formally
    excluded** (the bank-id rule was not read in full).
  - `dsh-vision-router/lib/ollama-cold-start.js` — awaits a network warmup on `agent/pre-step`
    (`OLLAMA_WARMUP_TIMEOUT_MS = 120000`) but only for a local Ollama provider with an image in the turn.
    A template for the fault class, not the culprit for these text-only sessions.
- **★ New clue: the warm turns are expensive too, and the curve saturates.** The earlier framing assumed
  only the cold path was costly. Warm pre-step rises from 231 ms at seq 35 k to ~1.1 s at seq 212 k, then
  **saturates around 3–6 s from seq ~273 k onward** regardless of further growth. A saturating curve fits
  a fixed-cost operation whose latency grew — e.g. a network round-trip through a degrading proxy — far
  better than a linear `O(seq)` scan; the token meter's own `O(seq)` cost is 0.09 µs/seq, roughly **140×
  cheaper** than the warm path's early slope. Whatever the cause is, **it is in the every-turn path, not
  only in a cold one-time path.**
- **Attribution now requires measurement, not more reading.** Two rounds of source review have produced
  three set-aside candidates and no conviction. The cost has to be measured inside a live pre-step
  waterfall — which needs a session loaded from disk plus a scripted turn in an isolated `DSH_HOME`, and
  then bisecting the composition bundle by bundle.
- **Why compaction makes the next cold start cheap is not established** either. The measured effect is
  solid (never-returning → 1.6–10 s in all three observed episodes), but since `seq` does not shrink it
  cannot be a shorter replay; a smaller visible surface lowering per-event cost is a hypothesis.
- **The replay cost has now been measured directly** (`tools/measure-replay.js`): 47 ms for all 526,383
  seqs, ≈0.09 µs/seq. The earlier ≈350 µs/event figure was inferred from the cold/warm pre-step delta and
  is **retracted** — it attributed another listener's cost to the replay.
- **The thresholds are a calibrated proxy, not a derived bound.** `seq` is cheap to read and does relate to
  the replay, so it is what the plugin watches; the crossing point depends on machine and session shape.
- **"Never returned" means "longer than the user was willing to wait" (20–47 s in the observed cases).**
  Nothing here proves the loop is non-terminating.

### What this means for the plugin

The plugin's rationale is weaker than the design assumed, and the README says so:

- **The GUARD does not absorb the mystery cost.** `compactNow` begins with `measure()`, which is cheap
  (47 ms for the whole session), so compacting at load does not pay whatever the slow listener charges.
- What the plugin actually delivers is the automation of the one operation observed to restore service:
  proactive compaction, at load when a session is already large and between turns as it grows. If the slow
  listener scales with the visible **surface**, keeping the surface small helps — a hypothesis, not a
  result.
- `seq` remains a reasonable thing to watch: free to read, monotonic, and a decent proxy for "this session
  has grown large". It is a proxy for the risk, not a measurement of the cost.

The design is retained because the alternative — do nothing and let the user rediscover the wedge by hand —
is worse, and because compaction is the only measured remedy. It is **not** retained because the cause is
understood: the cause is not understood.

## Appendix: offline forensics (still shipped, never acts)

`src/detect.js`, `src/frames.js`, `tools/replay.js` and the `bin/` scan CLI are read-only analysis tools.
They are not wired into the running plugin; they exist to validate the stall signature against real logs.
Two traps are encoded in them because both make the detector fail **silently**:

- a `turn/end {reason:{kind:"interrupted"}}` frame is a **synthetic closer written during a later cold
  load**, and it copies the timestamp of the last real event — so it looks like the turn closed 1 ms after
  it opened. Treating it as a real close makes every stall invisible (`…/dsh-session/lib/types/repair.js:125`).
- the first record of a session log has no `time`; using it to seed a replay clock yields `NaN` and every
  later comparison is false.

Detection rules and their powers:

| signal | condition | power |
|---|---|---|
| `never-started` | `turn/start` seen, no `step/start` within the window | matched every known stall |
| `mid-turn` | turn had activity, then went quiet | report only — fires on ordinary long silences |

Current result of `node tools/replay.js <log> 20000` on the observed session: 5 synthetic closers, 5
known stalled turns, **5/5 hit, 0 false positives**.

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

What follows is the **leading hypothesis**, not a proven cause — see *Open questions* for the
counter-evidence that keeps it provisional. Everything in the table is a code-level fact; the *causal*
step from that replay to a stalled turn is the part that is not established.

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

- **★ The causal link from the replay to the stall is NOT established, and there is counter-evidence.**
  The cold full replay is real at code level, and it does run inside the pre-step window — but the
  `/compact` path calls `tokenMeter.measure(session)` as its *first* step
  (`dsh-compaction-basic/lib/index.js:935`) before it appends anything, and both observed cold-start
  `/compact` runs reached `compaction/start` in **1,013 ms** (seq 388,770) and **1,117 ms** (seq 446,452).
  Either the meter was already warm, or the replay itself costs about a second at ~400 k seq — and **both
  branches bound it at ≈1 s, which cannot explain a 16 s pre-step or a turn that never returns.** So the
  replay is a *leading candidate for what the plugin should stay away from*, not a proven cause of the
  stall.
- **The cold first turn's cost has never been attributed to a specific listener.** What is measured is the
  total: 231 ms warm at seq 35,236 versus 16,008 ms cold at seq 45,585, growing with session size and
  never returning at seq 93 k and beyond. Which of the `agent/pre-step` or `system-prompt/assemble`
  listeners spends that time is unknown. `dsh-mnemon` is *unlikely* on code grounds — its `preStep`
  awaits `next()` first (`dsh-mnemon/lib/index.js:5389-5391`) and its per-turn memory work is a
  budget-capped `compose({scope, scenario, budget})` (`:1743-1749`) that never receives the conversation —
  but that is an argument, not a measurement, and other listeners (`dsh-hindsight-coding-agents`,
  `dsh-vision-router`, the core reminder/instruction hooks) are untested.
- **Why compaction makes the next cold start cheap is not established** either. The measured effect is
  solid (never-returning → 1.6–10 s in all three observed episodes), but since `seq` does not shrink it
  cannot be a shorter replay; a smaller visible surface lowering per-event cost is a hypothesis.
- **The per-event replay cost was never measured directly.** The ≈350 µs/event figure is an inference
  from the cold/warm pre-step delta, and it is the number the counter-evidence above calls into question.
- **The thresholds are a calibrated proxy, not a derived bound.** `seq` is cheap to read and does relate to
  the replay, so it is what the plugin watches; the crossing point depends on machine and session shape.
- **"Never returned" means "longer than the user was willing to wait" (20–47 s in the observed cases).**
  Nothing here proves the loop is non-terminating.

### What this means for the plugin

The prevention design is built on the leading hypothesis, deliberately: it keeps a session small and pays
the cold-start cost once, at load, instead of inside the user's turn. That is defensible even if the cause
turns out to be a different cold listener, because the measured effect — compaction restores service — is
independent of the explanation. But the README must not claim the mechanism is proven, and it does not.

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

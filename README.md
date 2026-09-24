# dsh-session-rescue

> **Status: v0.2.0 — prevention, not detection.** The failure mechanism below was traced to specific
> source lines and measured on a real 5.9 MB session log; the plugin logic is covered by 55 tests
> (55 pass / 0 fail), and the plugin has been loaded and exercised in an **isolated** `DSH_HOME`
> (never against the running instance). The stall itself has **not** been reproduced under control yet,
> and one mechanism detail is still formally unproven — see *Limitations*.

A DeepSeek Harness plugin that stops the **cold-start turn stall**: after a restart or a session load,
the first turn can block forever with the UI spinning and nothing in the log. This plugin prevents that
by compacting the session **before** its size reaches the zone where the stall becomes fatal.

## The problem, precisely

A stalled session log looks like this, with no error anywhere:

```
agent/inbox/spliced     ← the user message is accepted
turn/start              ← the turn is opened
                        ← and then nothing, forever: no step/start, no assistant frames
```

The silence sits exactly in the `preStep` window, between `turn/start` and `step/start`. The cause is
not a missing timeout and not the network — it is a **synchronous full replay of the whole session log**
that runs inside that window:

| Step | Evidence |
|---|---|
| A restart or session load creates a **new `Session` object** | `@deepseek-ai/dsh-session/lib/index.js:1322` appends `session/end-seed` on load |
| The token meter's replay state is a `WeakMap<Session, state>` | `@deepseek-ai/dsh-token-meter/lib/index.js:589` |
| A new object ⇒ empty state ⇒ replay from 0 | `dsh-token-meter/lib/index.js:679-697`, `while (state.consumedEvents < session.seq)` |
| Something calls it on **every** pre-step | `dsh-compaction-basic/lib/index.js:782` (`agent/pre-step`) → `:862` `meter.measure(session)` |
| So the replay runs between `turn/start` and `step/start` | `dsh-agent-loop/lib/index.js:528` → `:539` → `:553` |

That loop is **synchronous**: it blocks the event loop, so `step/start` can never be written and
`while (await this.turn())` never returns. The UI spins forever.

Measured on one real session (`session-db08f763`, 5.9 MB, seq space ≈ 517 k):

| Turn | seq at start | cold or warm | `preStep` duration |
|---|---|---|---|
| 2 | 35,236 | warm (same process) | **231 ms** |
| 5 | 45,585 | **cold** (process just restarted) | **16,008 ms** |
| 7 / 28–30 / 34–35 | 93 k / 389 k / 446 k | **cold** | never returned (user gave up after 20–47 s) |
| 8 / 31 / 36 | same sizes, **after `/compact`** | cold | 1.6 s / 10.1 s / 4.7 s ✅ |

Three properties follow from this, all confirmed against the real logs:

- **Restarting does not help** — it makes it worse. Every restart is another cold replay of an
  ever-longer log.
- **`/compact` does help** — it was the only thing that ever recovered these sessions.
- **Size alone is not the trigger** — a turn at 232,878 tokens succeeded warm while one at the same
  size failed cold. *When* the replay happens is what decides the outcome.

## How the plugin fixes it

The replay is unavoidable — but **where you pay for it is not**. Paid inside the user's first turn it
is a permanent hang; paid while the agent sits idle after a load it is just a slow start. And once
compaction has run, the following cold starts stay cheap.

1. **GUARD** — when a session is loaded into this process and its `seq` is already past the danger
   threshold, compact it **before the user's first turn** (`agent/status → idle`). This moves the
   unavoidable cost out of the turn and shrinks the surface at the same time.
2. **COMPACT** — between turns, while the agent is idle, compact whenever the session has grown by a
   configured amount. This keeps future cold starts in the seconds range.
3. **Report** — `/rescue status` shows the per-session `seq`, whether this process has already paid the
   replay ("warm") or not ("cold"), and the plugin's own measurement of the `preStep` window
   (`turn/start` → first `step/start`) for both cold and warm turns.

Only one API is used to act: the official compaction seam,
`ctx.compaction.compactNow(agent, signal, commandId)`
(`@deepseek-ai/dsh-command-compact/lib/index.js:8,54`). The service is fetched with `ctx.get('compaction')`
rather than injected, so the plugin still loads and reports in compositions that have no compaction.

### Anti-thrash (why the trigger is a growth delta)

Compaction **does not shrink `session.seq`** — the log is append-only and compaction appends its own
records. A plain "compact when `seq >= threshold`" rule would therefore re-fire on every idle forever.
The trigger is instead *"grown by at least `minGrowthSeq` since the last compaction"*, and a successful
compaction pushes that baseline to the current `seq`. Both are property-tested in `test/guard.test.js`.

`busy` is also treated specially: it means the core refused the call because a compaction is already
running or the agent is not idle. **No replay was paid**, so the plugin does *not* mark that session
warm (otherwise the cold session would miss its GUARD and the next user turn would hang again). Retries
are throttled by a cooldown and a consecutive-`busy` cap.

## Configuration

```yaml
- insert:
    - id: session-rescue
      name: dsh-session-rescue
      config:
        enabled: true        # false = observe and report only, never compact
        warnSeq: 40000       # start warning/compacting from here
        dangerSeq: 80000     # cold first turn may never return past here
        minGrowthSeq: 20000  # compact only after this much growth since the last compaction
        cooldownMs: 60000
        maxAttemptsPerSession: 6
        maxBusyStreak: 5
        pollMs: 30000
        compactionTimeoutMs: 600000
```

The default thresholds are calibrated from the table above (`40 k` is where a cold first turn is
already ~16 s; `80 k` is inside the "never returned" range). They are machine- and session-dependent —
measure your own with `/rescue status` and adjust.

## What is in the repository

| Path | What it is |
|---|---|
| `src/host.js` | Host plugin entry: `session/event` + `agent/status` wiring, GUARD/COMPACT execution, `/rescue`. |
| `src/guard.js` | Pure decision state machine — when to guard, when to compact, cooldown, caps, `busy` handling. |
| `src/size.js` | Size metric and thresholds for the danger zone, with the calibration data in comments. |
| `src/detect.js` | *Offline only.* Stall-signature detector over session events (used by the replay tool). |
| `src/frames.js` | *Offline only.* Read-only session-log analysis: per-frame zstd decode, synthetic-closer detection. |
| `bin/dsh-session-rescue.mjs` | Read-only scan CLI — usable **without installing the plugin**. |
| `tools/replay.js` | Replays a real session log through the detector to check hit/miss rates. |
| `test/*.test.js` | 55 unit and integration tests (`node --test`), run against a fake cordis context. |
| `tools/Install-Plugin.ps1` | Idempotent install / rollback for a DSH profile — dry-run by default, snapshot-based. |
| `docs/DESIGN.md` | Design notes: the mechanism with source citations, the fix, bounds and open questions. |

## Limitations stated up front

- **Verified in an isolated `DSH_HOME`, not end-to-end against the stall.** A real headless Harness run
  loaded the plugin, fired its `agent/status` hook, resolved `ctx.get('compaction')`, and opened a real
  compaction transaction (`compaction/start` carrying `sourceCommandId: "session-rescue-guard-1"`) —
  reproduced twice. The stall itself was **not** reproduced, and the "compact before the first turn"
  ordering is covered by unit tests only. See `docs/DESIGN.md` → *Verification performed*.
- **The size threshold is a proxy.** What actually costs time is the replay's per-event work, which
  cannot be measured from outside without paying for it. `seq` is the driver of the loop and is free to
  read, so it is used as the proxy — calibrated, not derived.
- **One link is unproven.** Compaction demonstrably made the next cold start cheap in all three observed
  episodes (never-returning → 1.6–10 s), but *why* is not established: it cannot be by shortening the
  replay, since `seq` does not shrink. The plugin relies on the measured effect, and `docs/DESIGN.md`
  records the question as open.
- **Compaction costs an LLM call** (15–20 s on the observed 300 k-token sessions) and rewrites history
  into a summary. That is a real change to your conversation, by design — the same operation `/compact`
  performs. Set `enabled: false` for report-only mode.
- The earlier v0.1 approach (detect a stalled turn → cancel → cold rebuild) has been **removed**: the
  stall is a synchronous CPU loop, so `signal.throwIfAborted()` never gets a chance to run and
  cancellation cannot interrupt it.

## Read-only scan CLI (no install required)

```sh
node bin/dsh-session-rescue.mjs scan --stalled-only     # sessions that stalled or have an unclosed turn
node bin/dsh-session-rescue.mjs scan --all --json       # every workspace bucket, machine readable
```

It reads session logs (read-only, tail window only, **never prints message bodies**).

## Development

```sh
node --test test/size.test.js test/guard.test.js test/host.test.js
node --test test/detect.test.js test/frames.test.js   # offline forensics
```

## Compatibility

Developed against **DSH Desktop 0.8.2 with `@deepseek-ai/dsh@0.1.2-rc.1`** — every line reference above
was read from that installed build.

## License

MIT

# dsh-session-rescue

> **Status: work in progress — not verified on a live harness yet.** The host-side plugin body, the
> detection / strategy / log-analysis modules and a read-only scan CLI are implemented and covered by
> 50 tests. **Nothing has been installed into a DSH profile yet**, and the client-side status UI is
> not implemented. This README only claims what the code actually does.

A Harness plugin that recovers a **stalled session turn** in place, instead of asking the user
to restart the whole application.

## The problem this targets

When a Harness session hangs, its session log ends like this:

```
agent/inbox/spliced     ← the user message is accepted
turn/start              ← the turn is opened
                        ← and then nothing: no step/start, no assistant frames
```

That path has no deadline, the `session/prompt` call cannot be cancelled, and the web client has
no request timeout either — so the UI spins forever and reports no error. The one action that has
been observed to bring such a session back is a **cold rebuild from disk**, which the app performs
when it restarts (it closes the dangling turn and writes a `session/end-seed` frame) — an expensive,
all-sessions operation, and `/compact` only gets through afterwards because the agent is idle again.

## Intended behaviour

1. **Detect** a stalled turn: `turn/start` with no `step/start` (or no further activity) for a
   configurable window.
2. **Release** the hung turn for that session without restarting the application.
3. **Rebuild** that single session from disk in place — the same repair a restart performs, but
   scoped to one session.
4. **Re-deliver** the user message that was left unprocessed, so the turn actually runs.
5. **Report** what happened through a slash command and a status surface.

Never: modify Harness packages, edit session logs, touch other sessions, or restart the app.

## What is in the repository today

| Path | What it is |
|---|---|
| `src/host.js` | Host plugin entry: subscribes to `session/event`, polls for stalls, plans a repair; in apply mode it releases the hung turn and then attempts a bounded cold resume. |
| `src/detect.js` | Stall detector — dependency-free, clock-injectable state machine over session events. |
| `src/repair-plan.js` | Bounded repair strategy: per-session attempt caps, cooldown, dry-run by default, conservative redelivery. |
| `src/frames.js` | Read-only session-log analysis: per-frame zstd decode, synthetic-closer detection, unprocessed-message lookup. |
| `bin/dsh-session-rescue.mjs` | Read-only scan CLI — usable **without installing the plugin**. |
| `test/*.test.js` | 46 unit and smoke tests (`node --test`). |
| `cordis.patch.yml` | Loader patch shipped by the plugin (`dsh.bundle.patch`). |
| `tools/Install-Plugin.ps1` | Idempotent install / rollback for a DSH profile - dry-run by default, snapshot-based, with an offline self-test. |
| `docs/DESIGN.md` | Design notes: the failure this targets, why recovery needs care, detection rules, bounds. |
| `tools/Install-Plugin.ps1` | Idempotent install / rollback for a DSH profile — dry-run by default, snapshot-based, with an offline self-test. |
| `docs/DESIGN.md` | Design notes: the failure this targets, why recovery needs care, detection rules, bounds. |

## Limitations stated up front

- **In-place session rebuild is not implemented.** This harness build exposes no public API to reload a
  live session, and the only handle able to dispose a live agent is given to its creator
  (see `docs/DESIGN.md`). The plugin therefore releases the hung turn and preserves the pending
  message instead of pretending to rebuild. `rebuild-session` is recorded as `no-public-api`, never faked.
- The detector's `mid-turn` signal is **report-only** by default: in real logs it fires on ordinary long
  silences (31–119 s observed), while `never-started` matched every known stall with no false positives.
- Nothing has been validated against a live harness yet — see `docs/DESIGN.md`.

## Read-only scan CLI (no install required)

```sh
node bin/dsh-session-rescue.mjs scan --stalled-only     # sessions that stalled or have an unclosed turn
node bin/dsh-session-rescue.mjs scan --all --json        # every workspace bucket, machine readable
node bin/dsh-session-rescue.mjs scan --window 2097152    # read more history per session (slower)
```

It reads session logs (read-only, tail window only, **never prints message bodies**) and reports: how many
turns were closed by a synthetic cold-load closer, whether a turn is currently unclosed, and the byte length
of any unprocessed user message. Note that **"currently unclosed" is not the same as "stalled"** — a turn
that is running normally is unclosed too. Run it on your own machine — it only reads logs.

## Development

```sh
node --test test/
node --check src/detect.js
```

No build step is required for the detection core; whether the packaged plugin needs one depends on
the loader contract and is documented in `docs/DESIGN.md`.

## Compatibility

Developed against **DSH Desktop 0.8.2 with `@deepseek-ai/dsh@0.1.2-rc.1`** (the version actually installed;
the per-package evidence was measured locally). Exact peer ranges will be declared once the
plugin entry points exist.

## License

MIT

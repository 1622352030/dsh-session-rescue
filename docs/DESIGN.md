# Design notes

Short version of the reasoning behind this plugin. The investigation notes it is based on are kept
locally, not in this repository.

## The failure this targets

When a Harness session hangs, the tail of its session log looks like this:

```
agent/inbox/spliced     ← the user message is accepted
turn/start              ← the turn opens
                        ← and then nothing: no step/start, no assistant frames
```

Two properties of the harness make this state permanent from the user's point of view:

1. **No deadline on the turn path.** The turn is advanced after the `session/prompt` call has already
   returned (the message is only spliced into the agent inbox), so nothing in the request path can time
   it out; and the web client has no request timeout either (a search for `AbortSignal.timeout`,
   `giveUp`, `requestTimeout`, `rpcTimeout` across the shipped packages finds nothing).
2. **The recovery path is a cold rebuild.** Restarting the app makes the harness reload each session
   from disk, which closes the dangling turn and writes a `session/end-seed` frame — after that the
   session works again. `/compact` also only gets through once that has happened, because it needs an
   idle agent.

So the useful primitive is: **close the dangling turn, let the session retire, and let the agent be
resumed from disk — for one session, without restarting the app.**

## Why this needs care

- `ctx.agents.get(id)` returns a **bare `Agent`** (enough to `cancel`, not to release).
- Only `ctx.agents.resume(options)` returns an `AgentHandle` (`{ agent, dispose }`) — i.e. **whoever
  resumes owns the handle**.
- `persistence.prepare(id)` first **waits for the session to retire** (`waitForRetirement`) and throws
  `cannot prepare session "…" while it is live` if it is still in the session store. That wait has no
  timeout, which is exactly why a resume can hang indefinitely.

This repository therefore does **not** dispose anything it did not create. It releases the hung turn,
then waits — with a bound — for the session to retire before attempting a resume.

## Detection rules

Two signals, with deliberately different powers:

| signal | condition | default action |
|---|---|---|
| `never-started` | `turn/start` seen, no `step/start` within the window | auto-repair (allowed) |
| `mid-turn` | turn had activity, then went quiet for the window | **report only** |

`mid-turn` is report-only because it fires on ordinary long silences in real logs, while
`never-started` matched every known stall with no false positives in the logs available.

Two implementation traps are encoded in the code and covered by tests, because both cause the
detector to fail **silently**:

- a `turn/end {reason:{kind:"interrupted"}}` frame is a **synthetic closer written during a cold
  load**, and it copies the timestamp of the last real event — so it looks like the turn closed 1 ms
  after it opened. Treating it as a real close makes every stall invisible.
- the first frame of a session log has no `time`; using it to seed a clock produces `NaN` and every
  later comparison is false.

## Bounds

- Default **dry-run**: the plugin reports and does nothing until `/rescue apply`.
- Per-session attempt cap and cooldown, so a pathological session cannot be released in a loop.
- Redelivery of the pending user message is **not** automatic — the release uses `keepInbox` so the
  message is not discarded, and an explicit re-post would risk re-running the user's tool calls.

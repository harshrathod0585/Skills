---
name: auto-gear-usage
description: >
  Show which models and reasoning-effort levels routing actually used — counts
  per tier, how often calls were rerouted, and what they were moved off of.
  Trigger: /auto-gear-usage, "auto-gear usage", "auto-gear stats", "which models
  am I using", "what is routing costing me", "how often does it downgrade".
  Read-only history; for the current cap use `auto-gear-status`, and to change
  it use `auto-gear-set`.
created_at: 2026-08-09T22:18:13Z
updated_at: 2026-08-09T22:18:13Z
---

# Auto Gear — Usage

One-shot display of what routing did. Changes nothing.

Run it:

```sh
node "${CLAUDE_PLUGIN_ROOT}/hooks/usage.js"        # all recorded history
node "${CLAUDE_PLUGIN_ROOT}/hooks/usage.js" 7      # last 7 days
```

Print the output as-is. It is already formatted, and rewriting it into prose
loses the per-surface split that makes it worth reading.

## Reading the two surfaces

The report splits by where the decision happened, and the distinction matters
more than the totals:

- **`agent`** — subagent dispatches, decided by the `PreToolUse` hook. Present
  in any session with the plugin installed.
- **`proxy`** — main-loop turns, decided by `proxy.js`. Only present if the
  session was launched through the proxy
  (`ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude`).

An empty or missing `proxy` section is the normal state, not a fault. It means
main-loop turns went straight to the API and were never routed — so the session
model applied, whatever the cap says. Say that plainly rather than letting a
zero read as "nothing was spent there".

## Interpreting it honestly

`rerouted` counts decisions, not savings. A dispatch already at the right tier
is recorded too, because stats that only counted clamps would flatter the
routing by hiding every call it correctly left alone.

The `moves` line is the one that carries the money: a downgrade off the top tier
is real, one between adjacent cheap tiers mostly isn't. Lead with that when
someone asks whether routing is worth it.

`forks` are dispatches that could not be capped at all — they ignore the model
parameter and ran on the session model. If that count is high, the cap is doing
less than the other numbers suggest, and it's worth saying so.

Every count is calls, never tokens or cost. The log records which model was
chosen, not what it spent. Don't convert these into dollar figures; if someone
wants spend, point them at their Anthropic console.

## When there is no data

A missing log means nothing has routed yet — most often a fresh install, or a
session that never dispatched a subagent. Report the reason rather than an empty
table, and don't create the file.

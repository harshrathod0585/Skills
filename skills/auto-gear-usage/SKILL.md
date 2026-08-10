---
name: auto-gear-usage
description: >
  Show which models routing actually used, and at what reasoning effort, as a
  bar chart. Trigger: /auto-gear-usage, "auto-gear usage", "auto-gear stats",
  "which models am I using", "what have I been running on". Read-only history;
  for the current cap use `auto-gear-status`, and to change it use
  `auto-gear-set`.
created_at: 2026-08-09T22:18:13Z
updated_at: 2026-08-10T00:00:00Z
---

# Auto Gear — Usage

One-shot display of which models ran. Changes nothing.

```sh
node "${CLAUDE_PLUGIN_ROOT}/hooks/usage.js"        # all recorded history
node "${CLAUDE_PLUGIN_ROOT}/hooks/usage.js" 7      # last 7 days
```

Print the output as-is — it is already formatted, and restating it as prose just
makes it longer.

## What the numbers mean

Each bar is one model+effort pair, counted in calls. `Opus(max)` and `Opus(low)`
are separate bars because they are separate spends.

Fork subagents are excluded — they ignore the model parameter and run on the
session model, so there is no routed model to report. That means the chart does
not account for every dispatch, and a fork-heavy session is spending more than
it shows.

Counts are calls, never tokens or cost — the log records which model was chosen,
not what it spent. Don't convert these into dollar figures; point anyone asking
about spend at their Anthropic console.

## When there is no data

A missing log means nothing has routed yet — usually a fresh install, or a
session that never dispatched a subagent and never went through the proxy.
Report that reason rather than an empty chart, and don't create the file.

Main-loop turns only appear if the session was launched through the proxy
(`bin/claude-gear`, or `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude`).
Without it, those turns went straight to the API and were never routed, so they
are absent from the chart entirely rather than showing up as the session model.

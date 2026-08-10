---
name: auto-gear-proxy
description: >
  Start the main-loop routing proxy, so ordinary conversation turns get routed
  to a cheaper model instead of always running on the session model. Trigger:
  /auto-gear-proxy, "start the proxy", "route my main loop", "make my chat
  cheaper", "why is my simple question running on opus", "cap the session
  model". The subagent cap is the `auto-gear` skill; this is the only thing that
  can reach the session model.
created_at: 2026-08-10T00:00:00Z
updated_at: 2026-08-10T00:00:00Z
---

# Auto Gear — Proxy

The `PreToolUse` hook can only rewrite tool inputs, and the session model is
fixed before any hook exists. So a one-line question runs on whatever tier the
session started with, no matter what the cap says. The proxy closes that gap by
sitting in front of the API rather than inside Claude Code.

## What to do

1. **Check whether it's already running** before starting another:

   ```sh
   lsof -tiTCP:${AUTO_GEAR_PORT:-8787} -sTCP:LISTEN
   ```

   Output means it's up — skip to step 3 rather than starting a duplicate that
   will fail on `EADDRINUSE`.

2. **Start it in the background**, from wherever the plugin is installed:

   ```sh
   nohup node "${CLAUDE_PLUGIN_ROOT}/proxy.js" > "${TMPDIR:-/tmp}/auto-gear-proxy.log" 2>&1 &
   ```

3. **Give the user the launch line and stop.** This is the part you cannot do
   for them:

   ```sh
   ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
   ```

   Say plainly that it has to be a **new session** in their own terminal. The
   base URL is read at startup, so the session running right now cannot be
   switched over — no amount of restarting the proxy changes that.

If the plugin ships `bin/claude-gear`, offer it as the one-command alternative:
it starts the proxy and launches Claude Code through it in a single step.

## What not to claim

Do not report that routing is now active. Starting the proxy is necessary but
not sufficient — nothing is routed until the user opens a session pointed at it,
and that hasn't happened yet when this skill finishes.

The honest status is "proxy is up, here's how to use it". A user told that
routing is live, who then watches their next question run on the session model
anyway, has been misled about which half of the setup is done.

## Verifying it later

The proxy logs one line per decision, and `/auto-gear-usage` reports the same
data over time. No lines at all means the session isn't going through it — that
is the check that settles "is this working", and it's worth pointing at rather
than guessing.

## Worth telling them once

Two things decide whether this is a win, and both are easy to miss:

- **Only chat-shaped turns are downgraded** — no tool results, short, near the
  start of a conversation. Real coding work keeps the session model, so the
  savings land on questions, not on the work.
- **Prompt caches are per-model.** Mixing tiers within a session means the next
  turn on the higher tier pays a cold cache write. On a long session that can
  cost more than the routing saves, so it's worth measuring rather than
  assuming.

Stop it with `kill $(lsof -tiTCP:8787 -sTCP:LISTEN)`.

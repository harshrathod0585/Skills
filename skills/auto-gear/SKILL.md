---
name: auto-gear
description: Manage the auto-gear model-routing proxy for Claude Code — a local HTTP proxy that inspects each request and routes it to Haiku, Sonnet, or Opus based on how complex the query actually looks, so simple turns don't burn Opus-tier quota. Use this skill whenever the user says "/auto-gear", "start the proxy", "stop the proxy", "routing proxy status", "auto-gear status", or asks why a simple question ran on an expensive model, wants to check live routing stats, or wants to start/stop the background proxy process. For changing the model ceiling or effort caps themselves, defer to the auto-gear-set skill instead of handling it here.
created_at: 2026-08-10T12:14:05Z
updated_at: 2026-08-10T12:14:05Z
---

# auto-gear

`auto-gear` is a local HTTP proxy (`proxy.js`) that sits between Claude Code and `api.anthropic.com`. It reads each outgoing request, classifies how complex the query looks, and rewrites the `model` field before forwarding — so a one-line question doesn't run on the same model as a multi-file refactor. It only takes effect once `ANTHROPIC_BASE_URL` points at it; nothing changes until then.

This skill covers the three things you do with the *running proxy*: start it, stop it, check its stats. To change *what it decides* (the max model ceiling, per-tier effort caps), use the `auto-gear-set` skill — don't duplicate that logic here.

## Start the proxy

`/auto-gear-set` is optional, not a prerequisite. With no `~/.claude/model-policy.json` at all, the proxy still runs the classifier fully and defaults to uncapped (`opus` ceiling, `max` effort) — so first-time use is zero-config and never silently restricts the user to a lower tier they didn't ask for. `/auto-gear-set` exists for the opposite direction: dial the ceiling *down* to save spend once the user knows they want that.

If the user hasn't set a policy, it's worth mentioning once that they're running uncapped and can restrict it with `/auto-gear-set` — but don't block starting the proxy on it.

1. Check whether port `8787` is already in use: `lsof -i :8787`. If something's already listening there, it's probably already running — don't start a second copy.
2. If it's free, launch it in the background so it survives the current command:
   ```bash
   nohup node "${CLAUDE_PLUGIN_ROOT}/proxy.js" > /tmp/auto-gear-proxy.log 2>&1 &
   ```
3. Tell the user it's running and that they still need to point Claude Code at it — the proxy being up doesn't do anything until this is set:
   ```bash
   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
   ```

## Check status

`GET /stats` on the running proxy returns live counters — total requests, how many routed to each tier, and how many were clamped by the ceiling:

```bash
curl -s http://127.0.0.1:8787/stats
```

Summarize it in plain terms (e.g. "42 requests so far, 18 stayed on Haiku, ceiling caught 3 that would've hit Opus") rather than dumping the raw JSON, unless the user wants the raw numbers.

## Stop the proxy

```bash
kill $(lsof -t -i:8787)
```

Confirm it stopped. If the user also exported `ANTHROPIC_BASE_URL`, mention that requests will fail until they unset it or point it back at the real API — the proxy going away doesn't undo that env var.

## Why this exists

Every request Claude Code sends looks identical from the outside whether it's "what's 2+2" or "refactor this module" — nothing downgrades the model automatically. The proxy is what makes that judgment call, at the network layer, without touching prompts or adding visible ceremony in the transcript. Keep changes to the *decision logic* in `proxy.js` and the `auto-gear-set` skill; this skill is only about operating the process.

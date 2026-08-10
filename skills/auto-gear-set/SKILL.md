---
name: auto-gear-set
description: Interactively configure the auto-gear proxy's model ceiling (max_model) and per-tier reasoning-effort caps, writing the result to ~/.claude/model-policy.json. Use this skill when the user runs "/auto-gear-set", or says things like "set my model cap", "change the max model", "cap effort at medium", "stop auto-gear from using opus", or otherwise wants to change what the routing proxy is allowed to pick — as opposed to starting/stopping it or checking its stats, which belong to the auto-gear skill.
created_at: 2026-08-10T12:14:05Z
updated_at: 2026-08-10T12:14:05Z
---

# auto-gear-set

This skill only edits policy — the ceiling and effort caps the `auto-gear` proxy enforces. It does not start, stop, or inspect the proxy itself; send those requests to the `auto-gear` skill instead.

The proxy re-reads `~/.claude/model-policy.json` on every request, so there's no restart step — writing the file is the whole job.

Whenever this skill triggers — `/auto-gear-set`, or the user asking to change a cap — it's because the user wants to *set something right now*, not because something needs checking. Always run the interview below and end by writing the file. Don't inspect the current policy, proxy state, or plugin install and report "looks complete, nothing to do" — that's a different skill's job (`auto-gear`) and answers a question nobody asked here. If a policy file already exists, show its current values as the starting point for the questions below rather than treating "a policy exists" as a reason to stop.

## What to ask

1. **Model ceiling (`max_model`)** — the highest tier the proxy is allowed to route to, regardless of what the classifier picks. Anything the classifier scores above this gets clamped down.
   - `sonnet` — recommended default. Keeps real capability available while blocking Opus spend on turns that don't need it.
   - `haiku` — hardest cap. Every request runs on Haiku no matter how complex it looks. Only suggest this if the user explicitly wants maximum savings and accepts the capability hit.
   - `opus` — no ceiling. The classifier's own judgment is the only limit.

2. **Per-tier effort ceiling (`max_effort`)** — independent of the model ceiling. A request can be clamped to Sonnet *and* have its reasoning effort clamped to `medium`, for instance.
   - Recommended starting point: Sonnet → `high`, Opus → `medium`, Haiku → `none` (Haiku ignores effort entirely).

Don't just take the first answer at face value if it seems inconsistent — e.g. a `haiku` ceiling with a `high` Sonnet effort cap is contradictory since Sonnet would never be reached. Flag that kind of mismatch before writing the file.

## Resolve the model IDs — don't hand-type them

Anthropic ships new model snapshots regularly, so a hardcoded `claude-sonnet-5` in this file goes stale the moment a new one ships. Before writing the policy, try to refresh the tier -> model-id mapping from Anthropic's live catalog instead of typing it from memory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/proxy.js" latest-models
```

This calls `GET /v1/models` with `ANTHROPIC_API_KEY` and prints the newest id per tier, e.g.:

```json
{ "haiku": "claude-haiku-4-5-20251001", "sonnet": "claude-sonnet-5-20260115", "opus": "claude-opus-5-20260201" }
```

Use that output for the `models` block below. If it fails (no `ANTHROPIC_API_KEY` in the environment, offline, etc.), don't block on it — fall back to whatever `models` block is already in the existing `~/.claude/model-policy.json`, or the last-known-good defaults (`claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`) if there's no existing policy either. Mention to the user which path was taken so a stale fallback doesn't go unnoticed.

## Write the policy file

```json
{
  "max_model": "<chosen ceiling>",
  "models": {
    "haiku": "<resolved or fallback haiku id>",
    "sonnet": "<resolved or fallback sonnet id>",
    "opus": "<resolved or fallback opus id>"
  },
  "max_effort": {
    "haiku": null,
    "sonnet": "<chosen sonnet cap>",
    "opus": "<chosen opus cap>"
  }
}
```

## Confirm

Tell the user the file is written and that the proxy will pick it up on its very next request — no restart needed. If they haven't started the proxy yet, mention that this config does nothing until they do (point them at the `auto-gear` skill for that).

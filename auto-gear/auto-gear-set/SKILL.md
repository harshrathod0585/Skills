---
name: auto-gear-set
description: >
  Use when the user asks to set, change, or reset their subagent model cap or
  reasoning-effort ceiling — "set model cap", "change my max model", "reset my
  cap", "auto-gear-set", "/auto-gear-set". Setup only; the routing that applies
  the cap is the `auto-gear` skill, and read-only viewing is `auto-gear-status`.
---

# Auto Gear — Set

Writes `~/.claude/model-policy.json`. This skill only writes config; it never
decides a model for a task.

## Never guess the lineup

Before asking the user anything, invoke the **`claude-api`** skill for the
current model list, their relative capability, the exact alias strings the Agent
tool's `model` param accepts, and which models support reasoning effort. Model
names and rankings change; a guessed `order` silently caps at the wrong tier.

If `claude-api` doesn't cover a model, WebFetch Anthropic's model docs before
falling back to asking the user.

## Steps

1. Read the policy file (`$AUTO_GEAR_POLICY`, else `$CLAUDE_CONFIG_DIR`/`~/.claude`
   + `/model-policy.json`). If it exists, show the current settings first and
   confirm they want to change them.
2. Get the lineup from `claude-api`. Build `order` weakest → strongest.
3. Ask with `AskUserQuestion`:
   - "Highest model subagents may use?" — options are the lineup you just got,
     labelled with rough relative cost so the choice is informed.
   - Then, batched up to 4 per call, "Max reasoning effort for `<model>`?" for
     each model at or below the cap that supports effort. Models without an
     effort concept get `null` and no question.
   - "Enforcement?" — `clamp` (recommended: silently downgrade over-cap calls),
     `warn` (ask first), `off` (advisory only). Default `clamp` if they don't
     care.
4. Write the file, creating the directory first:

```json
{
  "version": 2,
  "max_model": "sonnet",
  "order": ["haiku", "sonnet", "opus"],
  "max_effort": { "haiku": null, "sonnet": "high" },
  "enforce": "clamp"
}
```

5. Verify before confirming: re-read the file and check `max_model` is in
   `order` and every `max_effort` key is too. A policy that fails validation is
   ignored wholesale by the hook, which reads as "the cap silently stopped
   working."
6. Confirm in one line, and note that the cap takes effect for new subagent
   dispatches immediately — no restart needed.

Rerunning always overwrites. Don't merge, don't ask "are you sure".

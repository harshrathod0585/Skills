---
name: auto-gear-status
description: >
  Show the active model cap, effort ceilings, and enforcement mode without
  changing anything. Trigger: /auto-gear-status, "what's my model cap", "show
  my model policy", "auto-gear status", "am I capped". Read-only — to change
  the cap use `auto-gear-set`.
---

# Auto Gear — Status

One-shot display. Do NOT write, migrate, or "fix" the policy file here; if it's
broken, say so and offer `/auto-gear-set`.

## Steps

1. Run `node "${CLAUDE_PLUGIN_ROOT}/hooks/status.js"` and show its output.
2. If it reports no policy, say subagents are currently uncapped and point at
   `/auto-gear-set`.
3. If it reports an invalid policy, name the specific problem it printed — an
   invalid policy is ignored entirely by the enforcement hook, so the user is
   uncapped without knowing it.

Example output:

```
auto-gear  cap=sonnet  enforce=clamp
  allowed   haiku < sonnet
  effort    haiku: none   sonnet: high
  policy    /Users/me/.claude/model-policy.json
```

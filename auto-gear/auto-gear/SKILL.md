---
name: auto-gear
description: >
  Use before every Agent-tool subagent dispatch to pick which model tier the
  subagent runs on, clamped to the user's configured cap. Triggers whenever
  spawning a subagent for any task, and on "which model should this use",
  "route this task", "auto-gear". For setting or changing the cap itself use
  `auto-gear-set`; to view it use `auto-gear-status`.
---

# Auto Gear

Pick the cheapest model tier that can do the task, never above the user's cap.

Running every subagent on the strongest model burns money on trivial work;
running everything on the cheapest one fails the hard tasks and you pay twice.
This makes the tier an explicit decision instead of a silent default.

## Policy

`~/.claude/model-policy.json` (override: `$CLAUDE_CONFIG_DIR`, or
`$AUTO_GEAR_POLICY` for the exact file):

```json
{
  "version": 2,
  "max_model": "sonnet",
  "order": ["haiku", "sonnet", "opus"],
  "max_effort": { "haiku": null, "sonnet": "high", "opus": "medium" },
  "enforce": "clamp"
}
```

- `order` — weakest → strongest, using the exact strings the Agent tool's
  `model` param accepts. Written at setup time from the `claude-api` skill, not
  hardcoded, so a new model release doesn't need a plugin update.
- `max_effort` — per-model ceiling. `null` = that model has no reasoning-effort
  concept, so the param gets dropped rather than clamped.
- `enforce` — `clamp` (rewrite silently, default), `warn` (prompt instead of
  rewriting), `off` (advisory only).

No policy file → invoke `auto-gear-set` before dispatching anything.

## Routing

For each Agent call: classify the task, take the lowest tier that clears it,
clamp to `max_model`, pass it as `model`.

| Tier | Take it when the task is… | Examples |
|---|---|---|
| **cheapest** | mechanical, one right answer, verifiable by looking | list files matching a pattern, read a known file and summarize, rename a symbol in one file, format/lint fix, extract values from structured output |
| **mid** | ordinary engineering — known shape, bounded scope, recoverable if wrong | implement a described feature, fix a reproduced bug, write tests for existing code, review a small diff, research across a handful of files |
| **top** | ambiguous, cross-cutting, or expensive to get wrong | design and architecture decisions, underspecified problems needing judgment, security or auth changes, data migrations, concurrency, debugging with no reproduction, anything irreversible |

Tie-break rules, in order:

1. **Escalate on stakes, not on size.** A one-line change to auth is top tier;
   a 400-line mechanical rename is cheapest.
2. **Escalate on ambiguity.** If you can't state the success criterion in one
   sentence, the subagent can't either — go up a tier.
3. **Escalate on unverifiability.** If nothing downstream checks the output (no
   test, no compile, no review), go up a tier. Cheap-tier work is safe largely
   because its mistakes are visible.
4. **Otherwise, go down.** Between two defensible tiers, take the cheaper one.
   The clamp only protects the ceiling; the savings come from this rule.
5. **Fan-out inherits per item, not per batch.** Ten independent lookups are ten
   cheap-tier calls, not one top-tier call — classify the item, not the fan-out.

Then set effort: look up the chosen model in `max_effort`. `null` → omit the
param entirely. A value → never exceed it. Never borrow another model's ceiling.

## Clamping

Clamp downward only, never up. Cap `sonnet`, task needs `opus` → run `sonnet`
**and tell the user in one line** that the task was capped and may want a manual
top-tier run. A silent cap on a top-tier task is how a bad result gets trusted.

An unrecognized model name counts as above the cap — an unknown name is more
likely a new flagship than a new budget model.

## Enforcement

The `PreToolUse` hook rewrites any Agent call above the cap, including calls
with no `model` at all (which would otherwise inherit the session model). That
is the hard boundary; this skill is what makes the pick *good* rather than just
legal. Don't lean on the clamp — it can only make a call cheaper, never correct.

Not covered by the hook: work you do yourself in the main thread. The cap
governs subagent dispatch, not the session model.

---
name: auto-gear-help
description: >
  Quick-reference card for auto-gear commands, config, and enforcement modes.
  One-shot display, changes nothing. Trigger: /auto-gear-help, "auto-gear
  help", "how do I use auto-gear", "what auto-gear commands".
---

# Auto Gear Help

Display this card. One-shot: do not read, write, or change the policy.

## Commands

| Command | What it does |
|---|---|
| `/auto-gear-set` | Set or change the cap, effort ceilings, and enforcement mode. |
| `/auto-gear-status` | Show the active cap. Read-only. |
| `/auto-gear <task>` | Ask which tier a given task should route to, and why. |
| `/auto-gear-help` | This card. |

## Tiers

| Tier | Task shape |
|---|---|
| cheapest | mechanical, one right answer, mistakes visible |
| mid | ordinary engineering, bounded scope, recoverable |
| top | ambiguous, cross-cutting, or expensive to get wrong |

Ties go **down** a tier. Stakes, ambiguity, and unverifiable output push **up**.

## Config

`~/.claude/model-policy.json` — override the dir with `$CLAUDE_CONFIG_DIR`, or
the exact file with `$AUTO_GEAR_POLICY` (handy for testing).

```json
{
  "version": 2,
  "max_model": "sonnet",
  "order": ["haiku", "sonnet", "opus"],
  "max_effort": { "haiku": null, "sonnet": "high" },
  "enforce": "clamp"
}
```

| `enforce` | Behavior on an over-cap Agent call |
|---|---|
| `clamp` (default) | Rewritten to the cap automatically. |
| `warn` | You're asked to approve the call instead. |
| `off` | Nothing enforced; the skill's advice still applies. |

## What is and isn't capped

Capped: every `Agent`/`Task` subagent dispatch, including ones that specify no
model at all. Not capped: the main session model (change that with `/model`),
and anything spawned outside this Claude Code session.

An invalid policy file is ignored **entirely** — that means uncapped, not
partially capped. `/auto-gear-status` tells you which state you're in.

## More

https://github.com/harshrathod0585/auto-gear

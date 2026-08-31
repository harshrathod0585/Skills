# auto-gear

**A hard ceiling on which Claude model your subagents may use — plus a routing rubric that sends each task to the cheapest tier that can actually do it.**

Claude Code spawns subagents constantly. Every one of them inherits your session
model unless something says otherwise. That means a file listing can run on Opus
and a production data migration can run on Haiku, and nothing in the loop objects
to either.

auto-gear fixes both directions:

- **The cap is enforced, not suggested.** A `PreToolUse` hook rewrites any
  `Agent`/`Task` dispatch above your configured model — including dispatches that
  specify no model at all. It is not a line in a prompt the model can talk itself
  out of.
- **The routing is rubric-driven.** A skill classifies each task and picks the
  lowest tier that clears it, so the cap isn't only protecting the ceiling — it's
  saving money below it.

```
/plugin marketplace add harshrathod0585/auto-gear
/plugin install auto-gear
/auto-gear-set
```

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [How routing works](#how-routing-works)
- [How enforcement works](#how-enforcement-works)
- [Configuration](#configuration)
- [What is and isn't capped](#what-is-and-isnt-capped)
- [Benchmarks](#benchmarks)
- [Testing it yourself](#testing-it-yourself)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Contributing](#contributing)

---

## Install

```
/plugin marketplace add harshrathod0585/auto-gear
/plugin install auto-gear
```

Restart Claude Code (or `/reload-plugins`) so the hooks register, then run
`/auto-gear-set` once.

**Requirements:** Claude Code with plugin support, and Node.js on `PATH` (the
hooks are plain Node scripts — no dependencies, nothing to install).

If `/plugin` isn't recognized, your Claude Code is out of date:
`npm install -g @anthropic-ai/claude-code@latest`, then restart.

## Quick start

```
/auto-gear-set        # pick your cap — asks 2-3 questions, writes one JSON file
/auto-gear-status     # confirm it's active
```

That's the whole setup. From then on, every subagent dispatch is capped, and the
routing rubric is in context automatically at session start.

To see what it would do without dispatching anything:

```
/auto-gear review the JWT refresh flow for auth bypass risks
→ top tier · security stakes, expensive to get wrong · capped to sonnet
```

## Commands

| Command | What it does |
|---|---|
| `/auto-gear-set` | Set the cap, per-model effort ceilings, and enforcement mode. Rerun anytime to change your mind. |
| `/auto-gear-status` | Show the active policy. Read-only — and it tells you *why* if the policy is being ignored. |
| `/auto-gear <task>` | Which tier would this task route to, and why. Answers in three lines; dispatches nothing. |
| `/auto-gear-help` | Reference card: tiers, config, enforcement modes. |

## How routing works

Before each `Agent` call, the task is classified and the **lowest tier that
clears it** wins — then that choice is clamped to your cap.

| Tier | Take it when the task is… | Examples |
|---|---|---|
| **cheapest** | mechanical, one right answer, mistakes visible on sight | list files matching a pattern, read a known file and summarize, rename a symbol in one file, format/lint fix, extract values from structured output |
| **mid** | ordinary engineering — known shape, bounded scope, recoverable if wrong | implement a described feature, fix a reproduced bug, write tests for existing code, review a small diff, research across a handful of files |
| **top** | ambiguous, cross-cutting, or expensive to get wrong | architecture decisions, underspecified problems, security/auth changes, data migrations, concurrency, debugging with no reproduction, anything irreversible |

Five tie-breaks, applied in order:

1. **Escalate on stakes, not on size.** A one-line change to auth is top tier; a
   400-line mechanical rename is cheapest.
2. **Escalate on ambiguity.** If you can't state the success criterion in one
   sentence, the subagent can't either.
3. **Escalate on unverifiability.** If nothing downstream checks the output — no
   test, no compile, no review — go up a tier. Cheap-tier work is safe largely
   because its mistakes are visible.
4. **Otherwise, go down.** Between two defensible tiers, take the cheaper one.
   The clamp only protects the ceiling; the savings come from this rule.
5. **Fan-out is classified per item, not per batch.** Ten independent lookups are
   ten cheap-tier calls, not one top-tier call.

Then effort: the chosen model's entry in `max_effort` is a ceiling, never
exceeded, never borrowed from another model. A model with no reasoning-effort
concept gets the parameter dropped rather than clamped.

**When the cap bites**, you're told. Cap `sonnet` + a task that wanted `opus`
runs on `sonnet` *and* says so in one line — a silent downgrade on a high-stakes
task is how a bad result gets trusted.

## How enforcement works

The routing rubric makes the pick *good*. The hook makes the ceiling *hold*.

```
Agent tool call
      │
      ▼
PreToolUse hook  ──►  read ~/.claude/model-policy.json
      │                     │
      │                     ├─ no policy / invalid?  → allow unchanged (fail open)
      │                     ├─ enforce=off           → allow unchanged
      │                     ├─ enforce=warn          → ask the user first
      │                     └─ enforce=clamp         → rewrite `model` + `effort`
      ▼
 tool runs with the clamped input
```

Four cases the hook catches that a prompt-only approach misses:

| Case | Without the hook | With it |
|---|---|---|
| Model picked above the cap | dispatched as-is | rewritten to the cap |
| **No `model` on the call at all** | inherits the session model — often the most expensive one you own | pinned to the cap |
| Unrecognized model name | dispatched as-is | treated as over-cap (an unknown name is more likely a new flagship than a new budget model) |
| Effort above the per-model ceiling | dispatched as-is | clamped, or dropped if that model has no effort concept |

Clamping is **downward only, always**. There is no path through the code that
raises a model tier — worth stating plainly, because a "policy" that can also
escalate is a budget risk, not a budget control.

**Failure mode is fail-open, deliberately.** A missing, corrupt, or invalid
policy file means dispatches proceed unclamped rather than every subagent in your
session breaking. The cost of that choice is that "no cap" and "broken cap" look
identical from the outside — which is exactly why `/auto-gear-status` reports
them as different states and names the specific problem.

## Configuration

`~/.claude/model-policy.json` — override the directory with `$CLAUDE_CONFIG_DIR`,
or the exact file with `$AUTO_GEAR_POLICY` (handy for testing).

```json
{
  "version": 2,
  "max_model": "sonnet",
  "order": ["haiku", "sonnet", "opus"],
  "max_effort": { "haiku": null, "sonnet": "high" },
  "enforce": "clamp"
}
```

| Field | Meaning |
|---|---|
| `max_model` | The ceiling. Must appear in `order`, or the whole policy is rejected. |
| `order` | Weakest → strongest, using the exact strings the Agent tool's `model` param accepts. Written at setup time from the bundled `claude-api` skill — **not hardcoded in the plugin**, so a new model release doesn't require a plugin update. |
| `max_effort` | Per-model ceiling. `null` means that model has no reasoning-effort concept, so the param is dropped rather than clamped. |
| `enforce` | `clamp` / `warn` / `off` — see below. |

### Enforcement modes

| Mode | Behavior on an over-cap dispatch | Use when |
|---|---|---|
| `clamp` *(default)* | Silently rewritten to the cap. | You want the ceiling to just hold. |
| `warn` | You're asked to approve the call instead. | You're tuning the rubric and want to see what it would have done. |
| `off` | Nothing enforced; the skill's advice still applies. | You want the routing rubric without the hard cap. |

### Why the model ordering lives in the config

Hardcoding `["haiku", "sonnet", "opus"]` in the plugin would mean every model
release ships a broken cap until the plugin updates. Instead `/auto-gear-set`
pulls the current lineup from the `claude-api` skill at setup time and writes the
ordering into your policy. The hook ranks against *your* file.

The tradeoff, stated plainly: a policy written a year ago won't know about models
released since, and an unknown model name is treated as over-cap. That fails
safe (you get the cap, not the unknown model), but rerun `/auto-gear-set` after a
major model release to pick the new tier up properly.

## What is and isn't capped

**Capped:** every `Agent`/`Task` subagent dispatch in the session, including ones
that specify no model at all.

**Not capped:**

- **The main session model.** Use `/model` for that — auto-gear governs what your
  session *delegates*, not what it runs on.
- **Anything outside this Claude Code session** — a `claude -p` you launch from a
  Bash tool call runs in its own process with its own hooks.
- **API spend generally.** This is a model-tier policy, not a billing limit.

**An invalid policy file is ignored entirely** — which means *uncapped*, not
partially capped. `/auto-gear-status` distinguishes "no policy", "invalid policy",
and "active", and names the specific problem in the invalid case.

## Benchmarks

Two things can break, and they need different tests.

| Property | Test | Command | Needs API key |
|---|---|---|---|
| **The cap holds** — an over-cap dispatch never reaches the API | 16 deterministic unit + hook tests | `npm test` | No |
| **The routing is good** — the right tier gets picked | Model-in-the-loop, 18 labeled tasks × 2 arms | `npm run bench` | No (uses your Claude Code auth) |

### Measured routing results

18 labeled tasks (6 per tier), 3 runs, Haiku 4.5 as the classifier, medians:

| arm | accuracy | spend vs all-top | **under-routed top** | over-routed cheap |
|---|--:|--:|--:|--:|
| baseline (bare "which tier?") | 78% | 56% | **17%** | 0% |
| **auto-gear** | **83%** | 58% | **0%** | 0% |

| arm | decision cost / task | decision latency |
|---|--:|--:|
| baseline | $0.0123 | 4.6s |
| auto-gear | $0.0136 | 7.1s |

**Read this honestly.** The headline is not accuracy — it's the third column.
The baseline sent **17% of top-tier tasks** (a no-repro double-charge bug, a prod
data migration, an auth review) to a mid-tier model. auto-gear sent none.

**Spend is a wash** (56% vs 58%). auto-gear is *not* a cost-cutter on this
benchmark, and presenting it as one would overstate the result. What it buys is
not paying twice on the tasks where being wrong is expensive.

Both arms share the same weak spot — `mid→cheapest`, 6 occurrences each, mostly
one genuinely borderline task. The rubric did not fix that.

Full write-up, methodology, and limits: [benchmarks/results/2026-08-04-routing-haiku.md](benchmarks/results/2026-08-04-routing-haiku.md).

### Why "cheaper" alone is not a passing score

The benchmark reports three numbers because accuracy is gameable:

| Degenerate strategy | accuracy | spend | under-routed top |
|---|--:|--:|--:|
| always answer "cheapest" | 33% | 20% | **100%** |
| always answer "top" | 33% | 100% | 0% |

A change that lowers spend while raising `under-routed top` made the plugin
worse, not better. That's why it's a separate column and not a footnote.

## Testing it yourself

```bash
git clone https://github.com/harshrathod0585/auto-gear
cd auto-gear

npm test        # enforcement — deterministic, no API key, under a second
npm run bench   # routing — model-in-the-loop, uses your Claude Code auth
```

The enforcement tests cover: over-cap clamped, within-cap untouched, missing
`model` pinned to the cap, unknown model treated as over-cap, per-model effort
ceilings (never borrowed across models), `enforce=warn|off`, corrupt/missing
policy failing open, and the exact `hookSpecificOutput` JSON shape Claude Code
acts on. If you change `hooks/policy.js`, this is the check that has to stay
green.

Benchmark options:

```bash
node benchmarks/route.js --via cli --model haiku --repeat 5     # your CC auth
node benchmarks/route.js --via api --model claude-sonnet-5      # needs ANTHROPIC_API_KEY
node benchmarks/route.js --via cli --repeat 5 --concurrency 4   # gentler on the laptop
```

`--repeat 1` is a smoke test, not a result — tier choice on borderline tasks
flips run to run. Use 5+ before believing a delta.

**Adding tasks:** append to `benchmarks/tasks.json` with `task`, `tier`, and a
one-line `why`. Keep the tiers balanced — an unbalanced set makes "always answer
the majority tier" look smart. The `why` isn't read by the harness; it exists so
a disputed label is arguable instead of assumed.

## Architecture

```
.claude-plugin/
  plugin.json          manifest → points at hooks/hooks.json
  marketplace.json
hooks/
  policy.js            single source of truth: load, validate, clamp
  pretool-agent.js     PreToolUse on Agent|Task — the hard cap
  session-start.js     injects the active policy into context each session
  status.js            read-only diagnostics for /auto-gear-status
  hooks.json           event wiring
skills/
  auto-gear/           routing rubric (the decision)
  auto-gear-set/       interactive setup (the only writer of the policy file)
  auto-gear-status/    read-only display
  auto-gear-help/      reference card
commands/              four .toml slash commands
tests/                 16 tests, node --test, zero dependencies
benchmarks/            labeled tasks + two-arm harness + results
```

Two deliberate constraints:

- **`hooks/policy.js` is the only place clamping logic exists.** The hooks, the
  status printer, and the tests all import it. Nothing re-implements the rules.
- **Only `auto-gear-set` writes the policy file.** The routing skill and status
  command read it; neither "helpfully fixes" a broken one, because a config that
  silently rewrites itself is a config you can't reason about.

## Troubleshooting

**"Is it actually on?"** — `/auto-gear-status`. Three distinct answers:

```
auto-gear  cap=sonnet  enforce=clamp          ← active
auto-gear  NO POLICY — subagents are uncapped ← run /auto-gear-set
auto-gear  INVALID POLICY — ignored           ← names the exact problem
```

| Symptom | Cause | Fix |
|---|---|---|
| Subagents still run above the cap | Hooks didn't register | Restart Claude Code or `/reload-plugins`; confirm `node` is on `PATH` |
| Status says INVALID POLICY | `max_model` not in `order`, or malformed JSON | Rerun `/auto-gear-set` — it overwrites cleanly |
| A new model isn't recognized | Your `order` predates it, so it's treated as over-cap | Rerun `/auto-gear-set` to refresh the lineup |
| Cap seems to apply to your own work | It doesn't — only subagent dispatch | Use `/model` for the session model |
| Everything routes to the cap | Cap is set at the cheapest tier, so every tier clamps to it | Raise the cap, or that's working as configured |

## FAQ

**Does this reduce my bill?**
On the published benchmark, spend was a wash versus a bare prompt — because even
an unguided model won't send `ls src/` to Opus. What it reliably does is stop
top-tier work landing on a mid-tier model. Savings versus *routing everything to
your best model* are large in both arms; savings versus *a sensible default* are
not the claim.

**Can Claude ignore the cap?**
Not the hook. The rubric is guidance the model follows; the `PreToolUse` rewrite
happens outside the model's control, and it applies even to dispatches that never
mention a model.

**What if my policy file is broken?**
Dispatches proceed unclamped (fail-open — a broken config shouldn't break your
session), and `/auto-gear-status` tells you exactly what's wrong. It will not
silently repair itself.

**Why not just set a cheaper session model?**
Different lever. The session model governs your main thread; this governs what
that thread delegates. Most sessions want a capable main model and cheap
subagents for the mechanical fan-out.

**Does it work with custom agent types?**
Yes — the hook matches on the `Agent`/`Task` tool, not on agent type, so custom
subagents are capped too.

**Does it slow things down?**
The hook is a Node process read of one small JSON file — milliseconds, and it
runs only on dispatch. The routing *decision* costs more (benchmarked at
+$0.0013 and +2.5s per dispatch versus no rubric), which is trivially repaid when
it routes one task to Haiku instead of Opus, and isn't repaid on a session that
fans out hundreds of trivial subagents. Measure before assuming.

## Contributing

Issues and PRs welcome. `master` is protected: all changes go through a pull
request, and `npm test` must be green.

```bash
npm test    # required before opening a PR
```

If you change routing behavior, include a benchmark run (`npm run bench
--repeat 5`) in the PR — and report `under-routed top` alongside spend. A change
that only makes routing cheaper is not obviously an improvement.

## License

MIT

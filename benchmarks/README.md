# Benchmarks

Two things can break in auto-gear, and they need different tests.

| What | How it's tested | Command |
|---|---|---|
| **The cap holds** — an over-cap Agent call never reaches the API | Deterministic unit + hook tests. No API key, runs in under a second. | `npm test` |
| **The routing is good** — the right tier gets picked | Model-in-the-loop benchmark against labeled tasks. Needs an API key. | `npm run bench` |

The first is the safety property and it is either true or false. The second is a
quality property and it is a distribution — treat the numbers accordingly.

## 1. Enforcement tests

```bash
npm test          # node --test tests/*.test.js, Node ≥ 18
```

Covers: over-cap clamped, within-cap untouched, missing `model` pinned to the
cap, unknown model treated as over-cap, per-model effort ceilings (never
borrowed across models), `enforce=warn|off`, corrupt/missing policy failing open,
and the exact `hookSpecificOutput` JSON shape Claude Code acts on.

If you change `hooks/policy.js`, this is the check that has to stay green.

## 2. Routing benchmark

```bash
export ANTHROPIC_API_KEY=sk-...
node benchmarks/route.js --model claude-sonnet-5 --repeat 5
```

18 labeled tasks (6 per tier) in `tasks.json`, two arms — `baseline` (bare "which
tier?" prompt) and `auto-gear` (the rubric from `skills/auto-gear/SKILL.md` in
context) — repeated N times, medians reported.

Three numbers, and you need all three:

| Metric | Meaning | Degenerate strategy that games it |
|---|---|---|
| `accuracy` | matched the human label | — |
| `spend vs all-top` | cost of the chosen routing ÷ routing everything top-tier | always answer "cheapest" → 7% |
| `downgraded-a-top-task` | top-tier task sent to the cheapest tier | always answer "top" → 0 |

Cheap and wrong is not a win. A change that lowers spend while raising
`downgraded-a-top-task` made the plugin worse, not better.

`--repeat 1` is a smoke test, not a result; tier choice on borderline tasks
flips run to run. Use 5+ before believing a delta.

### Adding tasks

Append to `tasks.json` with `task`, `tier`, and a one-line `why`. Keep the tiers
balanced — an unbalanced set makes "always answer the majority tier" look smart.
The `why` field isn't read by the harness; it's there so a disputed label is
arguable instead of assumed.

### Cost

18 tasks × 2 arms × N runs, ~16 output tokens each. At `--repeat 5` that's 180
tiny calls — cents, not dollars.

## Honest limits

- Labels are one person's judgment. "Port three components to hooks" is
  defensibly mid or top. Treat single-task disagreements as noise; a systematic
  shift across a tier is signal.
- Single-turn classification, not a real session. It measures whether the rubric
  makes the *decision* better, not end-to-end session cost — a cheap subagent
  that fails and gets retried on a stronger model costs more than routing it
  correctly the first time, and nothing here captures that.
- No quality measurement of the delegated work itself. The benchmark assumes the
  labels are the right answer; it does not verify the cheapest tier actually
  succeeds at the tasks labeled cheapest.
- `WEIGHT` in `route.js` is a fixed price ratio (1 / 3 / 15). Real pricing
  drifts; the spend column is a relative indicator, not a bill.

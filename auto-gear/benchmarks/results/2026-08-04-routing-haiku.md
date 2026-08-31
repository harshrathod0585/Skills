# Routing benchmark — Haiku 4.5, 2026-08-04

18 labeled tasks (6 per tier), 2 arms, 3 runs each = 108 classifications.
Medians reported.

```
node benchmarks/route.js --via cli --model haiku --repeat 3
```

Harness: `claude -p --output-format json --disable-slash-commands`, each call in an
empty temp cwd with `PONYTAIL_DEFAULT_MODE=off`, so no CLAUDE.md, skill, or
session hook could answer for the model or bias tier choice. Both arms ran under
identical conditions; the only difference is whether the auto-gear rubric was in
the prompt.

## Results

| arm | accuracy | spend vs all-top | under-routed top | over-routed cheap |
|---|--:|--:|--:|--:|
| baseline (bare "which tier?") | 78% | 56% | **17%** | 0% |
| **auto-gear (rubric in context)** | **83%** | 58% | **0%** | 0% |

| arm | decision cost / task | decision latency (median) |
|---|--:|--:|
| baseline | $0.0123 | 4.6s |
| auto-gear | $0.0136 | 7.1s |

Misroutes across all runs:

```
baseline:  mid→cheapest 6,  mid→top 1,  top→mid 3
auto-gear: mid→cheapest 6,  mid→top 3
```

## Reading this honestly

**The headline is not the accuracy number — it's the third column.** Baseline
sent 17% of top-tier tasks (no-repro double-charge bug, prod data migration,
auth review) to a mid-tier model. auto-gear sent none. That is the failure that
costs real money: you pay for a weak answer, then pay again to redo it.

**Spend is a wash** (56% vs 58% of routing-everything-top-tier). Anyone
presenting auto-gear as a cost-cutter based on this run would be overstating it.
What it buys is *not paying twice on the tasks where being wrong is expensive* —
the savings versus a naive all-top policy are already there in both arms, because
even a bare prompt won't send `ls src/` to Opus.

**Both arms share one weakness**: `mid→cheapest` (6 occurrences each) — chiefly
"port three React class components to hooks", which is defensibly either tier.
The rubric did not fix that, and the write-up should not pretend it did.

**Cost of deciding is small but real**: +$0.0013 and +2.5s per dispatch. On a
task routed correctly to Haiku instead of Opus, the saving dwarfs it. On a
session that dispatches hundreds of trivial subagents, it doesn't — measure
before assuming.

## Limits

- **n=3 runs.** Borderline tasks flip between runs; treat single-task moves as
  noise. The 17% → 0% under-routing gap held across all three runs, which is why
  it's the claim being made.
- **Classifier model was Haiku 4.5**, chosen because it's the cheapest arm to
  run 108 times. A stronger classifier would likely narrow the gap — the rubric
  helps most exactly where the model is weakest.
- **Single-turn classification, not a real session.** It measures whether the
  rubric improves the *decision*, not end-to-end session cost. A cheap subagent
  that fails and gets retried on a stronger model costs more than routing it
  right the first time; nothing here captures that.
- **Labels are one person's judgment** (`tasks.json` carries a `why` per task so
  a disputed label is arguable rather than assumed).
- **Spend weights are price ratios** (1 / 3 / 5, from Haiku $5, Sonnet $15,
  Opus $25 per Mtok output), not a bill.

## Not measured here

The enforcement half — whether the cap actually holds — is not in this
benchmark. That's deterministic and lives in `npm test` (16 tests, no API key).
A routing benchmark cannot tell you the hook works.

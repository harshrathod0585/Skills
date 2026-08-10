# Benchmarks & evals

Two different things live here, testing two different failure modes:

- **`tests/proxy.test.js`** (`npm test`) — unit tests for the mechanics: does the ceiling clamp actually clamp, does the response-header injector survive a payload split across two network chunks, does an unrecognized `max_model` fail to the right default. These are pass/fail on exact behavior.
- **`benchmarks/eval-set.js` + `run-eval.js`** (`npm run eval`) — a labeled set of realistic-shaped request payloads with the tier/effort a *correct classification* should produce. This is the one that would have caught the classifier bug where any tool call anywhere in a transcript permanently pinned every later turn to `sonnet/high` — that's a routing-quality regression, not a mechanics bug, and unit tests testing one call in isolation don't catch drift across a whole labeled set.

## Running

```bash
npm run eval
```

Prints a pass/fail line per case, a per-category rollup, overall accuracy, and a relative-cost comparison against a naive "route everything to Opus" baseline (arbitrary weights: haiku=1, sonnet=5, opus=25 — not real pricing, just enough to make the relative savings legible as one number).

## Eval set

`benchmarks/eval-set.js` is a plain JS module (not JSON — a couple of cases need `'x'.repeat(n)` to build a long prompt), each case shaped like:

```js
{
  id: 'simple-trivia',
  category: 'simple',
  expected_tier: 'haiku',
  expected_effort: null,
  payload: { messages: [{ role: 'user', content: 'Who is Virat Kohli' }] }
}
```

Categories covered: `simple` (short chat, including a follow-up right after a tool-heavy turn — the regression case above), `standard` (ordinary engineering asks), `heavy-turn` (a turn that itself carries a tool_result), `high` (long/architecture/security-flavored prompts), `edge` (empty message list, last message from an assistant, a short prompt with an incidental code keyword).

Add a case when you notice the classifier get something wrong in real usage — that's a stronger signal than inventing more synthetic prompts. Each addition should point at a specific misclassification you actually saw, not fill out a category for its own sake.

## Results

Dated snapshots live in `results/`. Rerun `npm run eval` after any change to `classifyQuery()` in `proxy.js` and add a new dated file if the numbers move — don't overwrite an old one, the history of "did this change help or hurt" is the point.

- [2026-08-10-classifier-eval.md](results/2026-08-10-classifier-eval.md) — 12/12 (100%), 72% lower relative cost vs. always-Opus.

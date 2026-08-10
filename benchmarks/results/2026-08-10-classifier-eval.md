# Classifier eval — 2026-08-10

100 labeled cases across 5 categories (simple, standard, heavy-turn, high, edge), run against `classifyQuery()` directly — no network, no live model calls, pure function over a message payload.

## Run 1 — 86/100 (86%)

First pass at 100 cases surfaced a real classifier bug, not a test-data mistake: the simple-chat check ran *before* the high-complexity keyword check, and the two checks used different keyword lists. A short prompt like `"Plan a database migration strategy for this schema"` contains none of the simple-chat exclusion words (`function/class/import/.../fix/test/build/file`), so it read as trivial chat and returned Haiku — despite naming exactly the kind of task the high tier exists for. 14 of the 25 `high` cases failed this way.

Fixed in `proxy.js` by checking the high-complexity keywords first; a request that matches one is decided regardless of length before the simple-chat check ever runs.

## Run 2 (post-fix) — 100/100 (100%)

```
Overall accuracy: 100/100 (100%)
Relative cost vs. an always-Opus baseline: 896/2500 (64% lower)
```

| Category | Count | Pass |
|---|--:|--:|
| simple | 25 | 25/25 |
| standard | 25 | 25/25 |
| high | 25 | 25/25 |
| heavy-turn | 10 | 10/10 |
| edge | 15 | 15/15 |

Relative cost uses arbitrary weights (haiku=1, sonnet=5, opus=25) — not real API pricing — purely to make "how much cheaper than routing everything to Opus" legible as one number. The 64% here (down from the earlier 12-case run's 72%) is expected and correct, not a regression: this set has proportionally more `high` cases now, and fixing the bug above means more of them correctly land on the expensive tier instead of incorrectly landing on Haiku.

Reproduce with `npm run eval`.

**Known gap:** this only tests the classifier in isolation. It does not (yet) cover `routeRequest`'s ceiling clamp, `refreshPolicyModels`, or the response-header transform — those are covered by `tests/proxy.test.js` instead.

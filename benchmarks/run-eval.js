#!/usr/bin/env node
// Classifier accuracy eval + a naive-baseline cost comparison.
//
// This is deliberately not a code-golf benchmark -- the thing that can silently
// break here is the classifier routing everything to one tier (see the
// "history pins to sonnet/high forever" bug this eval would have caught).
// Run with: npm run eval

const { classifyQuery } = require('../proxy');

const evalSet = require('./eval-set.js');

// Cost weights are relative, not real prices -- just enough to make "how much
// would an always-Opus baseline have cost vs. the classifier's picks" legible.
const RELATIVE_COST = { haiku: 1, sonnet: 5, opus: 25 };

function run() {
  const results = evalSet.cases.map(c => {
    const got = classifyQuery(c.payload);
    const tierMatch = got.tier === c.expected_tier;
    const effortMatch = (got.effort || null) === (c.expected_effort || null);
    return { ...c, got, tierMatch, effortMatch, pass: tierMatch && effortMatch };
  });

  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] ||= { total: 0, pass: 0 };
    byCategory[r.category].total++;
    if (r.pass) byCategory[r.category].pass++;
  }

  const totalPass = results.filter(r => r.pass).length;
  const baselineCost = results.length * RELATIVE_COST.opus;
  const actualCost = results.reduce((sum, r) => sum + RELATIVE_COST[r.got.tier], 0);
  const savingsPct = Math.round((1 - actualCost / baselineCost) * 100);

  console.log('auto-gear classifier eval\n');
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    const effortStr = r.got.effort ? `(${r.got.effort})` : '';
    console.log(`  [${mark}] ${r.id.padEnd(38)} -> ${r.got.tier}${effortStr}${r.pass ? '' : `  (expected ${r.expected_tier}${r.expected_effort ? `(${r.expected_effort})` : ''})`}`);
  }

  console.log('\nBy category:');
  for (const [cat, { total, pass }] of Object.entries(byCategory)) {
    console.log(`  ${cat.padEnd(12)} ${pass}/${total}`);
  }

  console.log(`\nOverall accuracy: ${totalPass}/${results.length} (${Math.round((totalPass / results.length) * 100)}%)`);
  console.log(`Relative cost vs. an always-Opus baseline: ${actualCost}/${baselineCost} (${savingsPct}% lower)`);

  if (totalPass !== results.length) process.exitCode = 1;
}

if (require.main === module) run();
module.exports = { run };

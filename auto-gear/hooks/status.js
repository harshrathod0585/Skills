#!/usr/bin/env node
// auto-gear — read-only status printer, used by the auto-gear-status skill.
// Diagnoses *why* a policy is inactive; "no cap" and "broken cap" look
// identical from the outside and only one of them is the user's intent.

const fs = require('fs');
const { loadPolicy, policyPath, normalize } = require('./policy');

const file = policyPath();
const policy = loadPolicy(file);

if (policy) {
  const below = policy.order.slice(0, policy.order.indexOf(policy.max_model) + 1);
  const efforts = below
    .map(m => `${m}: ${policy.max_effort[m] === null ? 'none' : policy.max_effort[m] || 'unset'}`)
    .join('   ');
  console.log(`auto-gear  cap=${policy.max_model}  enforce=${policy.enforce}`);
  console.log(`  allowed   ${below.join(' < ')}`);
  console.log(`  effort    ${efforts}`);
  console.log(`  policy    ${file}`);
  process.exit(0);
}

if (!fs.existsSync(file)) {
  console.log(`auto-gear  NO POLICY — subagents are uncapped.\n  expected  ${file}\n  fix       run /auto-gear-set`);
  process.exit(0);
}

let why = 'unreadable or not valid JSON';
try {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!normalize(raw)) {
    why = !raw || typeof raw !== 'object'
      ? 'not a JSON object'
      : `max_model ${JSON.stringify(raw.max_model)} is not in order ${JSON.stringify(raw.order)}`;
  }
} catch (e) {
  why = e.message;
}
console.log(`auto-gear  INVALID POLICY — ignored, subagents are uncapped.\n  policy    ${file}\n  problem   ${why}\n  fix       run /auto-gear-set`);

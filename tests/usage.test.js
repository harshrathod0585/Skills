// The recorder and the report. Both must survive a missing/torn log rather than
// taking a dispatch down with them.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { record } = require('../hooks/policy');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-gear-usage-'));

const report = (log, arg) => execFileSync('node', [path.join(ROOT, 'hooks', 'usage.js'), ...(arg ? [arg] : [])], {
  env: { ...process.env, AUTO_GEAR_USAGE: log }, encoding: 'utf8',
});

test('record appends one json line and stamps a timestamp', () => {
  const log = path.join(dir, 'a.jsonl');
  record({ surface: 'proxy', from: 'claude-opus-5', model: 'claude-haiku-4-5', effort: null, changed: true }, log);
  record({ surface: 'agent', from: 'sonnet', model: 'sonnet', effort: 'medium', changed: false }, log);

  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.match(rows[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(rows[0].model, 'claude-haiku-4-5');
});

test('record never throws on an unwritable path', () => {
  assert.doesNotThrow(() => record({ surface: 'proxy' }, '/no/such/dir/x.jsonl'));
});

test('report counts model and effort per surface', () => {
  const log = path.join(dir, 'b.jsonl');
  record({ surface: 'proxy', from: 'claude-opus-5', model: 'claude-haiku-4-5', effort: null, changed: true }, log);
  record({ surface: 'proxy', from: 'claude-opus-5', model: 'claude-opus-5', effort: 'medium', changed: false }, log);
  record({ surface: 'agent', from: 'opus', model: 'haiku', effort: null, changed: true }, log);

  const out = report(log);
  assert.match(out, /3 routed call\(s\)/);
  assert.match(out, /proxy \(main loop\)\s+2/);
  assert.match(out, /agent \(subagents\)\s+1/);
  assert.match(out, /Opus\(medium\)/);
  assert.match(out, /moves\s+.*Opus -> Haiku/);
});

test('rerouted counts unchanged calls in the denominator', () => {
  const log = path.join(dir, 'c.jsonl');
  record({ surface: 'agent', from: 'opus', model: 'haiku', effort: null, changed: true }, log);
  record({ surface: 'agent', from: 'haiku', model: 'haiku', effort: null, changed: false }, log);
  assert.match(report(log), /rerouted\s+1 of 2 \(50%\)/);
});

test('an effort-only clamp is not reported as a tier move', () => {
  const log = path.join(dir, 'f.jsonl');
  record({ surface: 'agent', from: 'opus', model: 'opus', effort: 'medium', changed: true }, log);
  const out = report(log);
  assert.doesNotMatch(out, /opus -> opus/);
  assert.match(out, /effort-only 1/);
});

test('a fork gets its own bar rather than vanishing from the chart', () => {
  const log = path.join(dir, 'g.jsonl');
  record({ surface: 'agent', kind: 'fork', from: null, model: null, effort: null, changed: false }, log);
  record({ surface: 'agent', from: 'haiku', model: 'haiku', effort: null, changed: false }, log);
  const out = report(log);
  assert.match(out, /Haiku\(none\)\s+█+\s+1\s+50%/);
  assert.match(out, /Fork\(uncapped\)\s+█+\s+1\s+50%/);
  assert.doesNotMatch(out, /^\s*None\(/mi); // a fork is never labelled as a tier
});

test('bars are scaled to the largest bucket, and a rare one stays visible', () => {
  const log = path.join(dir, 'h.jsonl');
  for (let i = 0; i < 40; i++) record({ surface: 'agent', from: 'haiku', model: 'haiku', effort: null, changed: false }, log);
  record({ surface: 'agent', from: 'opus', model: 'opus', effort: 'medium', changed: false }, log);

  const out = report(log);
  const bar = k => (out.match(new RegExp(`^\\s*${k.replace(/[()]/g, '\\$&')}\\s+(█+)`, 'm')) || [])[1] || '';
  assert.ok(bar('Haiku(none)').length > bar('Opus(medium)').length, 'the common tier should dominate');
  assert.ok(bar('Opus(medium)').length >= 1, 'a 1-in-41 bucket must not round away to nothing');
});

test('forks are surfaced as uncappable', () => {
  const log = path.join(dir, 'd.jsonl');
  record({ surface: 'agent', kind: 'fork', from: null, model: null, effort: null, changed: false }, log);
  assert.match(report(log), /Fork\(uncapped\)\s+█+\s+1\s+100%/);
});

test('a missing log explains itself instead of printing an empty table', () => {
  const out = report(path.join(dir, 'absent.jsonl'));
  assert.match(out, /NO DATA YET/);
  assert.doesNotMatch(out, /routed call/);
});

test('a torn final line does not lose the rest of the file', () => {
  const log = path.join(dir, 'e.jsonl');
  record({ surface: 'agent', from: 'opus', model: 'haiku', effort: null, changed: true }, log);
  fs.appendFileSync(log, '{"surface":"agent","mod');
  assert.match(report(log), /1 routed call\(s\)/);
});

// The recorder and the report. Both must survive a missing/torn log rather than
// taking a dispatch down with them.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { record } = require('../hooks/router');

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

test('models are shown by tier name, with effort, regardless of surface', () => {
  const log = path.join(dir, 'b.jsonl');
  // The proxy records full wire ids and the hook records bare tiers; both must
  // land in the same bucket or one tier appears twice under two spellings.
  record({ surface: 'proxy', model: 'claude-opus-5', effort: 'medium' }, log);
  record({ surface: 'agent', model: 'opus', effort: 'medium' }, log);

  const out = report(log);
  assert.match(out, /Opus\(medium\)\s+█+\s+2\s+100%/);
  assert.doesNotMatch(out, /claude-opus-5/); // wire ids never reach the display
});

test('forks are left out — they have no tier to report', () => {
  const log = path.join(dir, 'c.jsonl');
  record({ surface: 'agent', kind: 'fork', model: null, effort: null }, log);
  record({ surface: 'agent', model: 'haiku', effort: null }, log);

  const out = report(log);
  assert.match(out, /Haiku\(none\)\s+█+\s+1\s+100%/); // % is of routed calls, not all
  assert.doesNotMatch(out, /Fork/);
});

test('a log of nothing but forks says so instead of drawing an empty chart', () => {
  const log = path.join(dir, 'g.jsonl');
  record({ surface: 'agent', kind: 'fork', model: null, effort: null }, log);
  assert.match(report(log), /nothing routed/);
});

test('bars are scaled to the largest bucket, and a rare one stays visible', () => {
  const log = path.join(dir, 'd.jsonl');
  for (let i = 0; i < 40; i++) record({ surface: 'agent', model: 'haiku', effort: null }, log);
  record({ surface: 'agent', model: 'opus', effort: 'medium' }, log);

  const out = report(log);
  const bar = k => (out.match(new RegExp(`${k.replace(/[()]/g, '\\$&')}\\s+(█+)`)) || [])[1] || '';
  assert.ok(bar('Haiku(none)').length > bar('Opus(medium)').length, 'the common tier should dominate');
  assert.ok(bar('Opus(medium)').length >= 1, 'a 1-in-41 bucket must not round away to nothing');
});

test('a day window filters older entries out', () => {
  const log = path.join(dir, 'e.jsonl');
  fs.writeFileSync(log, JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', model: 'opus', effort: null }) + '\n');
  record({ surface: 'agent', model: 'haiku', effort: null }, log);

  assert.match(report(log), /Opus\(none\)/);        // the 2020 entry is in range
  assert.doesNotMatch(report(log, '7'), /Opus/);   // and out of it with a window
});

test('a missing log explains itself instead of printing an empty chart', () => {
  const out = report(path.join(dir, 'absent.jsonl'));
  assert.match(out, /NO DATA YET/);
  assert.doesNotMatch(out, /█/);
});

test('a torn final line does not lose the rest of the file', () => {
  const log = path.join(dir, 'f.jsonl');
  record({ surface: 'agent', model: 'haiku', effort: null }, log);
  fs.appendFileSync(log, '{"surface":"agent","mod');
  assert.match(report(log), /Haiku\(none\)\s+█+\s+1/);
});

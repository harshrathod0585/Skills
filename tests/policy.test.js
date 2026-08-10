const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize, loadPolicy, clamp } = require('../hooks/policy');

const P = normalize({
  max_model: 'sonnet',
  order: ['haiku', 'sonnet', 'opus'],
  max_effort: { haiku: null, sonnet: 'high', opus: 'medium' },
});

test('normalize rejects a cap that is not in the ordering', () => {
  assert.equal(normalize({ max_model: 'gpt', order: ['haiku', 'sonnet'] }), null);
  assert.equal(normalize({ order: ['haiku'] }), null);
  assert.equal(normalize(null), null);
});

test('normalize defaults enforce to clamp and accepts the legacy effort key', () => {
  const p = normalize({ max_model: 'sonnet', order: ['haiku', 'sonnet'], max_reasoning_effort_by_model: { sonnet: 'HIGH ' } });
  assert.equal(p.enforce, 'clamp');
  assert.equal(p.max_effort.sonnet, 'high');
});

test('over-cap model is clamped down, at-or-under is untouched', () => {
  assert.equal(clamp(P, 'opus').model, 'sonnet');
  assert.equal(clamp(P, 'opus').changed, true);
  assert.equal(clamp(P, 'haiku').changed, false);
  assert.equal(clamp(P, 'sonnet').changed, false);
});

test('unknown model name is treated as above the cap', () => {
  assert.equal(clamp(P, 'some-new-flagship').model, 'sonnet');
});

test('missing model is pinned to the cap, not left to inherit the session model', () => {
  const r = clamp(P, undefined);
  assert.equal(r.model, 'sonnet');
  assert.match(r.reason, /no model specified/);
});

test('effort is clamped to the chosen model, never borrowed from another', () => {
  assert.equal(clamp(P, 'sonnet', 'max').effort, 'high');
  assert.equal(clamp(P, 'sonnet', 'low').effort, 'low');
  // opus allows only medium; clamping opus->sonnet must use sonnet's ceiling
  assert.equal(clamp(P, 'opus', 'max').effort, 'high');
});

test('a model with no effort concept has the param dropped', () => {
  const r = clamp(P, 'haiku', 'high');
  assert.equal(r.effort, undefined);
  assert.equal(r.changed, true);
});

test('enforce=off never changes anything', () => {
  const off = normalize({ max_model: 'haiku', order: ['haiku', 'opus'], enforce: 'off' });
  assert.equal(clamp(off, 'opus', 'max').changed, false);
});

test('corrupt or missing policy file loads as null instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-gear-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(loadPolicy(bad), null);
  assert.equal(loadPolicy(path.join(dir, 'nope.json')), null);
  assert.equal(clamp(null, 'opus').changed, false);
});

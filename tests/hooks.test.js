// End-to-end: feed the hooks the real stdin payload shape and assert the JSON
// Claude Code would act on. The unit tests cover the clamp; these cover the
// wiring, which is where a hook silently does nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-gear-hooks-'));
const policyFile = path.join(dir, 'model-policy.json');
fs.writeFileSync(policyFile, JSON.stringify({
  version: 2,
  max_model: 'sonnet',
  order: ['haiku', 'sonnet', 'opus'],
  max_effort: { haiku: null, sonnet: 'high' },
  enforce: 'clamp',
}));

function run(script, stdin, policy = policyFile) {
  const out = execFileSync('node', [path.join(ROOT, 'hooks', script)], {
    input: JSON.stringify(stdin),
    env: { ...process.env, AUTO_GEAR_POLICY: policy },
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

const call = (model, effort) => ({
  tool_name: 'Agent',
  tool_input: { prompt: 'do a thing', ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
});

test('over-cap Agent call is rewritten via updatedInput', () => {
  const out = run('pretool-agent.js', call('opus', 'max'));
  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, 'allow');
  assert.equal(h.updatedInput.model, 'sonnet');
  assert.equal(h.updatedInput.effort, 'high');
  assert.equal(h.updatedInput.prompt, 'do a thing', 'must preserve the rest of the input');
});

test('within-cap Agent call is left completely alone', () => {
  assert.equal(run('pretool-agent.js', call('haiku')), null);
});

test('missing policy file fails open rather than blocking dispatch', () => {
  assert.equal(run('pretool-agent.js', call('opus'), path.join(dir, 'absent.json')), null);
});

test('enforce=warn asks instead of rewriting', () => {
  const warn = path.join(dir, 'warn.json');
  fs.writeFileSync(warn, JSON.stringify({ max_model: 'haiku', order: ['haiku', 'opus'], enforce: 'warn' }));
  const h = run('pretool-agent.js', call('opus'), warn).hookSpecificOutput;
  assert.equal(h.permissionDecision, 'ask');
  assert.equal(h.updatedInput, undefined);
});

test('session-start injects the active cap into context', () => {
  const h = run('session-start.js', {}).hookSpecificOutput;
  assert.equal(h.hookEventName, 'SessionStart');
  assert.match(h.additionalContext, /AUTO-GEAR ACTIVE/);
  assert.match(h.additionalContext, /cap=sonnet/);
});

test('session-start says so loudly when no policy exists', () => {
  const h = run('session-start.js', {}, path.join(dir, 'absent.json')).hookSpecificOutput;
  assert.match(h.additionalContext, /no policy/i);
});

test('status names the reason an invalid policy is being ignored', () => {
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, JSON.stringify({ max_model: 'opus', order: ['haiku', 'sonnet'] }));
  const out = execFileSync('node', [path.join(ROOT, 'hooks', 'status.js')], {
    env: { ...process.env, AUTO_GEAR_POLICY: broken }, encoding: 'utf8',
  });
  assert.match(out, /INVALID POLICY/);
  assert.match(out, /not in order/);
});

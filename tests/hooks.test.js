// End-to-end: feed the hooks the real stdin payload shape and assert the JSON
// Claude Code would act on. The unit tests cover classification; these cover the
// wiring, which is where a hook silently does nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-gear-hooks-'));

function run(script, stdin) {
  const out = execFileSync('node', [path.join(ROOT, 'hooks', script)], {
    input: JSON.stringify(stdin),
    // Keep the usage log out of the real config dir — these runs record.
    env: { ...process.env, AUTO_GEAR_USAGE: path.join(dir, 'usage.jsonl') },
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

const call = (input) => ({ tool_name: 'Agent', tool_input: { prompt: 'do a thing', ...input } });

test('a dispatch with no model is routed from the task prompt', () => {
  const out = run('pretool-agent.js', call({}));
  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, 'allow');
  assert.equal(h.updatedInput.model, 'claude-haiku-4-5'); // short prompt
  assert.equal(h.updatedInput.prompt, 'do a thing', 'must preserve the rest of the input');
  assert.ok(!('effort' in h.updatedInput), 'haiku takes no effort parameter');
});

test('a long task prompt routes up to opus, with effort set', () => {
  const out = run('pretool-agent.js', call({ prompt: 'x'.repeat(1600) }));
  const h = out.hookSpecificOutput;
  assert.equal(h.updatedInput.model, 'claude-opus-5');
  assert.equal(h.updatedInput.effort, 'high');
});

test('an explicit model is deliberate and is left completely alone', () => {
  assert.equal(run('pretool-agent.js', call({ model: 'opus' })), null);
  assert.equal(run('pretool-agent.js', call({ model: 'claude-fable-5' })), null);
});

test('forks produce no output — their model cannot be set, so nothing is claimed', () => {
  assert.equal(run('pretool-agent.js', call({ subagent_type: 'fork' })), null);
});

test('unparseable payload fails open rather than blocking dispatch', () => {
  const out = execFileSync('node', [path.join(ROOT, 'hooks', 'pretool-agent.js')], {
    input: 'not json', encoding: 'utf8',
  });
  assert.equal(out.trim(), '');
});

test('session-start reports routing as active with no setup step', () => {
  const out = run('session-start.js', {});
  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, 'SessionStart');
  assert.match(h.additionalContext, /AUTO-GEAR ACTIVE/);
  assert.doesNotMatch(h.additionalContext, /auto-gear-set|cap/i, 'no setup step to advertise');
});

test('status prints the tier table and the proxy state', () => {
  const out = execFileSync('node', [path.join(ROOT, 'hooks', 'status.js')], { encoding: 'utf8' });
  assert.match(out, /haiku/);
  assert.match(out, /opus/);
  assert.match(out, /main loop/);
});

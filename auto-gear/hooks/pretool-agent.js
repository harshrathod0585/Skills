#!/usr/bin/env node
// auto-gear — PreToolUse hook on Agent/Task.
//
// This is the hard cap. The skill guides the *choice* of tier; this rewrites
// the tool input so a choice above the cap can't happen, whether the model
// forgot the skill, was talked out of it, or never had it in context.

const { loadPolicy, clamp } = require('./policy');

let input = '';
let done = false;

function finish() {
  if (done) return;
  done = true;

  let payload;
  try {
    payload = JSON.parse(input.replace(/^\uFEFF/, ''));
  } catch (e) {
    process.exit(0); // Unparseable payload: fail open, never block a dispatch.
  }

  const policy = loadPolicy();
  if (!policy) process.exit(0);

  const toolInput = payload.tool_input || {};
  const result = clamp(policy, toolInput.model, toolInput.effort);
  if (!result.changed) process.exit(0);

  if (policy.enforce === 'warn') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `auto-gear: ${result.reason} (enforce=warn, not applied)`,
      },
    }));
    process.exit(0);
  }

  const updated = { ...toolInput, model: result.model };
  if (result.effort === undefined) delete updated.effort;
  else if (result.effort !== undefined) updated.effort = result.effort;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `auto-gear: ${result.reason}`,
      updatedInput: updated,
    },
  }));
  process.exit(0);
}

process.stdin.on('data', c => { input += c; });
process.stdin.on('end', finish);
process.stdin.on('error', () => process.exit(0));
// auto-gear: 2s ceiling so a stalled stdin can never hang a subagent spawn.
setTimeout(() => process.exit(0), 2000).unref();

#!/usr/bin/env node
// auto-gear — SessionStart hook.
//
// Puts the active policy in context so routing decisions are made against the
// real cap instead of the model's memory of one. If no policy exists yet, say
// so once — silent inaction is how a cap ends up never being set.

const { loadPolicy, policyPath, summary } = require('./policy');

const policy = loadPolicy();
const context = policy
  ? `AUTO-GEAR ACTIVE — ${summary(policy)}\n\n` +
    'Before every Agent tool call, pass an explicit `model`: the cheapest tier that can do the task, ' +
    'never above the cap. A PreToolUse hook clamps anything above it, so an over-picked model is ' +
    'silently downgraded — pick correctly rather than relying on the clamp. Use the `auto-gear` skill ' +
    'for the tier rubric.'
  : `AUTO-GEAR INSTALLED — no policy at ${policyPath()}. ` +
    'Subagents run uncapped until the user runs `/auto-gear-set`. Mention this once if they dispatch a subagent.';

try {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
} catch (e) {
  // A stdout failure at hook exit must not surface as a hook error.
}

#!/usr/bin/env node
// auto-gear — PreToolUse hook on Agent/Task.
//
// Fills in the blank. A dispatch that names no model would inherit the session
// model — usually the most expensive tier in play, for work that rarely needs
// it. This classifies the task prompt and picks instead.
//
// A dispatch that *does* name a model is left alone. There is no cap any more:
// an explicit choice is treated as deliberate, and the router only decides what
// would otherwise be decided by inheritance.

const { classify, record, TIER_MODELS } = require('./router');

let input = '';
let done = false;

function finish() {
  if (done) return;
  done = true;

  let payload;
  try {
    payload = JSON.parse(input.replace(/^﻿/, ''));
  } catch (e) {
    process.exit(0); // Unparseable payload: fail open, never block a dispatch.
  }

  const toolInput = payload.tool_input || {};

  // Forks always run on the parent's model; a `model` override is ignored, so
  // an updatedInput here would be a lie. Record it and stay out of the way —
  // with no cap to violate there is nothing to warn about, and a permission
  // prompt on every fork was pure friction.
  if (String(toolInput.subagent_type || '').trim().toLowerCase() === 'fork') {
    record({ surface: 'agent', kind: 'fork', from: toolInput.model || null, model: null, effort: null, changed: false });
    process.exit(0);
  }

  // An explicit model is a decision someone already made. Record what it was so
  // the usage chart stays honest about total spend, then leave it untouched.
  if (typeof toolInput.model === 'string' && toolInput.model.trim()) {
    record({
      surface: 'agent',
      from: toolInput.model,
      model: toolInput.model,
      effort: toolInput.effort || null,
      changed: false,
    });
    process.exit(0);
  }

  // Nothing specified: route it. The task prompt is the query here — the same
  // signal the proxy reads from the last user turn.
  const prompt = [toolInput.prompt, toolInput.description].filter(Boolean).join('\n');
  const decision = classify(prompt);

  record({
    surface: 'agent',
    from: null,
    model: decision.model,
    effort: decision.effort === undefined ? null : decision.effort,
    changed: true,
  });

  const updated = { ...toolInput, model: TIER_MODELS[decision.model] || decision.model };
  // Haiku takes no effort parameter at all — the key must be absent, not empty.
  if (decision.effort === undefined) delete updated.effort;
  else updated.effort = decision.effort;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `auto-gear: no model specified; routed to ${decision.model} — ${decision.reason}`,
      updatedInput: updated,
    },
  }));
  process.exit(0);
}

process.stdin.on('data', c => { input += c; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 1000).unref();

module.exports = { finish };

#!/usr/bin/env node
// auto-gear — the router.
//
// One idea, one function: look at a query, pick the model and effort that fit
// it. No policy file, no cap, no setup. Both surfaces import `classify` from
// here — the proxy for main-loop turns, the PreToolUse hook for subagent
// dispatches — so there is exactly one place where tier choice is decided.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Tier table, cheapest first. Fable is deliberately absent: it is ~2x Opus and
// nothing should reach it without the user asking by name. Override the wire
// ids with AUTO_GEAR_MODELS rather than editing this file — these strings are
// the only thing here that drifts on a model release.
const TIER_MODELS = Object.assign(
  { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' },
  (() => { try { return JSON.parse(process.env.AUTO_GEAR_MODELS || '{}'); } catch (e) { return {}; } })()
);

const ORDER = ['haiku', 'sonnet', 'opus'];

// Context window per tier, in tokens. This is not decoration: routing a turn to
// a tier whose window it does not fit is how a session lands at 89% context on
// its first message. `fits()` below is the guard.
const WINDOW = { haiku: 200000, sonnet: 1000000, opus: 1000000 };

// Effort per tier. Haiku has no effort parameter at all — sending one is an
// API error, so it must be undefined rather than a level.
const TIER_EFFORT = { haiku: undefined, sonnet: 'medium', opus: 'high' };

// Tier tokens we know how to name, wider than ORDER so a model the router will
// never pick still gets a readable label in the status line and usage report.
const TIERS = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'];

function configDir() {
  // Matches Claude Code's own override.
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function usagePath() {
  return process.env.AUTO_GEAR_USAGE || path.join(configDir(), 'auto-gear-usage.jsonl');
}

// "claude-haiku-4-5" -> "Haiku". Version suffixes are noise in a status line,
// and they split one tier into separate buckets in the usage report — the proxy
// sees full wire ids while the hook sees bare tiers. Unrecognized names pass
// through untouched rather than being guessed at.
function tierLabel(model) {
  const id = String(model || '').toLowerCase();
  const hit = TIERS.find(t => id.includes(t));
  return hit ? hit[0].toUpperCase() + hit.slice(1) : String(model || '');
}

function tierOf(modelId) {
  const id = String(modelId || '').toLowerCase();
  return ORDER.find(t => id.includes(t)) || '';
}

// ponytail: bytes/4 is the standard rough token estimate. Good enough to keep a
// 600KB prompt off a 200K-window model, which is all it is for. Swap in
// count_tokens if a decision ever turns on a number this close to a boundary.
function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text || ''), 'utf8') / 4);
}

// Would this many tokens fit the tier, with room to answer? 60% leaves headroom
// for the reply and a few follow-up turns before auto-compact.
function fits(tier, tokens) {
  return tokens <= WINDOW[tier] * 0.6;
}

// The whole product, in one function. Returns {model, effort, reason}, where
// `model` is a bare tier name — callers map it through TIER_MODELS if they need
// a wire id.
//
// ponytail: pure heuristic, no model call. Asking a model which model to use
// costs more than it saves. Tune the thresholds, not the approach.
function classify(text, opts = {}) {
  const body = String(text || '');
  const tokens = opts.tokens || estimateTokens(body);

  // Anything carrying real work — tool results, images, documents — is not a
  // lookup, regardless of how short the last message reads.
  let tier;
  let reason;
  if (opts.hasWork) {
    tier = 'opus';
    reason = 'tool results or attachments present';
  } else if (body.length <= 200 && !/\n/.test(body)) {
    tier = 'haiku';
    reason = 'short single-line query';
  } else if (body.length <= 1500) {
    tier = 'sonnet';
    reason = 'medium-length query';
  } else {
    tier = 'opus';
    reason = 'long or complex query';
  }

  // Never hand a request to a tier it does not fit in. Walk up until it does;
  // the largest tier is the floor if nothing fits.
  if (!fits(tier, tokens)) {
    const roomy = ORDER.find(t => fits(t, tokens)) || ORDER[ORDER.length - 1];
    if (ORDER.indexOf(roomy) > ORDER.indexOf(tier)) {
      reason = `${reason}; raised to ${roomy} — ${tokens} tokens exceeds ${tier} window`;
      tier = roomy;
    }
  }

  return { model: tier, effort: TIER_EFFORT[tier], reason };
}

// One line per routing decision, from both surfaces. Never throws: a stats file
// failing to append must not break a dispatch or an API request — the log is an
// observation, not part of the decision.
//
// ponytail: append-only, never rotated. A line is ~120 bytes; add trimming if a
// heavy user's file ever gets large enough to notice.
function record(entry, file = usagePath()) {
  try {
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    /* observation only */
  }
}

function summary() {
  return ORDER.map(t => `${t}:${TIER_EFFORT[t] || 'none'}`).join('  ');
}

module.exports = {
  ORDER, TIER_MODELS, TIER_EFFORT, WINDOW, TIERS,
  configDir, usagePath, tierLabel, tierOf, estimateTokens, fits,
  classify, record, summary,
};

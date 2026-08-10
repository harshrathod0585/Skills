#!/usr/bin/env node
// auto-gear — shared policy loader and clamp.
//
// One source of truth for: where the policy lives, what a valid policy is,
// and what clamping a (model, effort) pair against it means. Both hooks and
// the tests import this; nothing else duplicates the rules.

const fs = require('fs');
const path = require('path');
const os = require('os');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Fallback only — the real ordering is written into the policy at setup time
// by the auto-gear-set skill (from the claude-api skill), so a new model
// release doesn't require shipping a new plugin version.
const FALLBACK_ORDER = ['haiku', 'sonnet', 'opus'];

function configDir() {
  // Matches Claude Code's own override.
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function policyPath() {
  return process.env.AUTO_GEAR_POLICY || path.join(configDir(), 'model-policy.json');
}

// Tier tokens we know how to name. Wider than any one policy's `order`, because
// a display label is still wanted for a tier the user hasn't ranked — an
// unranked model gets clamped, and "Fable" reads better than "claude-fable-5"
// while that happens.
const TIERS = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'];

// "claude-haiku-4-5" -> "Haiku", "opus" -> "Opus". Version suffixes are noise in
// a status line, and they also split the same tier into separate buckets in the
// usage report — the proxy sees full wire ids while the hook sees bare tiers.
// Unrecognized names pass through untouched rather than being guessed at.
function tierLabel(model) {
  const id = String(model || '').toLowerCase();
  const hit = TIERS.find(t => id.includes(t));
  return hit ? hit[0].toUpperCase() + hit.slice(1) : String(model || '');
}

function usagePath() {
  return process.env.AUTO_GEAR_USAGE || path.join(configDir(), 'auto-gear-usage.jsonl');
}

// One line per routing decision, from both surfaces: the proxy (main loop) and
// the PreToolUse hook (subagent dispatch). Neither knew what the other did, so
// there was no way to answer "what am I actually spending on".
//
// Never throws. A stats file failing to append must not break a dispatch or an
// API request — the log is an observation, not part of the decision.
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

// Never throws. Missing/corrupt/invalid policy => null, and callers no-op.
// A broken config file must not break every Agent dispatch in the session.
function loadPolicy(file = policyPath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return null;
  }
  return normalize(raw);
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const order = (Array.isArray(raw.order) ? raw.order : FALLBACK_ORDER)
    .filter(m => typeof m === 'string' && m.trim())
    .map(m => m.trim().toLowerCase());
  if (!order.length) return null;

  const max = String(raw.max_model || '').trim().toLowerCase();
  // A cap naming a model that isn't in the ordering is unrankable — refuse to
  // guess where it sits rather than silently capping at the wrong tier.
  if (!order.includes(max)) return null;

  const effort = {};
  const rawEffort = raw.max_effort || raw.max_reasoning_effort_by_model || {};
  for (const [model, level] of Object.entries(rawEffort)) {
    const key = String(model).trim().toLowerCase();
    if (level === null) { effort[key] = null; continue; }
    const val = String(level).trim().toLowerCase();
    if (EFFORTS.includes(val)) effort[key] = val;
  }

  const enforce = ['clamp', 'warn', 'off'].includes(raw.enforce) ? raw.enforce : 'clamp';

  return { order, max_model: max, max_effort: effort, enforce };
}

// Clamp downward only. Returns {model, effort, changed, reason}.
// Unknown model (not in `order`) is treated as above the cap: an unrecognized
// name is more likely a new top-tier model than a new cheap one, and capping
// something cheap costs nothing but capability we were told not to buy.
function clamp(policy, model, effort) {
  const out = { model, effort, changed: false, reason: '' };
  if (!policy || policy.enforce === 'off') return out;

  const capIdx = policy.order.indexOf(policy.max_model);
  const asked = typeof model === 'string' ? model.trim().toLowerCase() : '';
  const askedIdx = asked ? policy.order.indexOf(asked) : -1;

  if (!asked) {
    // No model on the call => it would inherit the session model, which can sit
    // above the cap. Pin it to the cap so the ceiling actually holds.
    out.model = policy.max_model;
    out.changed = true;
    out.reason = `no model specified; pinned to cap "${policy.max_model}"`;
  } else if (askedIdx === -1 || askedIdx > capIdx) {
    out.model = policy.max_model;
    out.changed = true;
    out.reason = `"${asked}" exceeds cap; clamped to "${policy.max_model}"`;
  }

  const ceiling = policy.max_effort[out.model];
  if (typeof effort === 'string' && Object.prototype.hasOwnProperty.call(policy.max_effort, out.model)) {
    if (ceiling === null) {
      out.effort = undefined;
      out.changed = true;
      out.reason += `${out.reason ? '; ' : ''}"${out.model}" takes no reasoning effort; dropped`;
    } else {
      const askedE = EFFORTS.indexOf(effort.trim().toLowerCase());
      const capE = EFFORTS.indexOf(ceiling);
      if (askedE === -1 || askedE > capE) {
        out.effort = ceiling;
        out.changed = true;
        out.reason += `${out.reason ? '; ' : ''}effort "${effort}" clamped to "${ceiling}"`;
      }
    }
  }

  return out;
}

function summary(policy) {
  if (!policy) return '';
  const below = policy.order.slice(0, policy.order.indexOf(policy.max_model) + 1);
  const efforts = below
    .map(m => `${m}:${policy.max_effort[m] === null ? 'none' : policy.max_effort[m] || 'unset'}`)
    .join(' ');
  return `cap=${policy.max_model} | allowed=${below.join(' < ')} | effort ceilings ${efforts} | enforce=${policy.enforce}`;
}

module.exports = {
  EFFORTS, FALLBACK_ORDER, TIERS, configDir, policyPath, usagePath, tierLabel,
  loadPolicy, normalize, clamp, summary, record,
};

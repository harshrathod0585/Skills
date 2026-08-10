#!/usr/bin/env node
// auto-gear — statusline. One line showing what routing last did.
//
// The proxy knows which model served a turn, but it only knows it in its own
// terminal. This puts that answer next to the conversation without injecting
// anything into the reply itself — a marker in the response text would become
// part of the transcript, get replayed on every later turn, and the model would
// start imitating it.
//
// Wire it up in settings.json:
//   "statusLine": { "type": "command", "command": "node <path>/hooks/statusline.js" }

const fs = require('fs');
const { spawnSync } = require('child_process');
const { loadPolicy, usagePath, tierLabel } = require('./policy');

// Claude Code allows exactly one statusLine, so composing is the only way to
// keep an existing one. Set AUTO_GEAR_STATUSLINE_WRAP to that command and its
// output is rendered first, with the auto-gear segment appended.
//
//   AUTO_GEAR_STATUSLINE_WRAP='npx -y ccstatusline@latest'
//
// The wrapped command gets the same stdin Claude Code sent us, since it expects
// the session JSON too.
const WRAP = process.env.AUTO_GEAR_STATUSLINE_WRAP;
const WRAP_TIMEOUT = Number(process.env.AUTO_GEAR_STATUSLINE_TIMEOUT) || 5000;

function wrapped(stdin) {
  if (!WRAP) return '';
  try {
    const r = spawnSync(WRAP, { shell: true, input: stdin, encoding: 'utf8', timeout: WRAP_TIMEOUT });
    // A wrapped command that fails or times out must not blank the whole line —
    // degrade to the auto-gear segment alone rather than showing nothing.
    return r.status === 0 && r.stdout ? r.stdout.trim() : '';
  } catch (e) {
    return '';
  }
}

// Claude Code sends session JSON on stdin. We don't need any of it, but the
// stream has to be drained or the process can sit waiting on a pipe that never
// closes — a statusline that hangs stalls the display.
let input = '';
let done = false;

function lastDecision() {
  let raw;
  try {
    raw = fs.readFileSync(usagePath(), 'utf8');
  } catch (e) {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  // Walk backward: the newest line wins, and a torn tail from a killed process
  // shouldn't blank the display when the line before it is perfectly good.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]);
      if (r.model) return r;
    } catch (e) {
      /* keep walking */
    }
  }
  return null;
}

function render(session, prefix = '') {
  const parts = [];

  // Skip the session model when something else already renders it — repeating
  // it just spends width on a duplicate.
  const now = session && session.model && (session.model.display_name || session.model.id);
  if (now && !prefix) parts.push(String(now));

  const last = lastDecision();
  if (last) parts.push(`▸ ${tierLabel(last.model)}(${last.effort || 'none'})`);

  const policy = loadPolicy();
  parts.push(policy ? `cap ${tierLabel(policy.max_model)}` : 'uncapped');

  const mine = `auto-gear ${parts.join(' · ')}`;
  return prefix ? `${prefix}  ·  ${mine}` : mine;
}

function finish() {
  if (done) return;
  done = true;
  let session = null;
  try {
    session = JSON.parse(input);
  } catch (e) {
    /* no session context: still worth showing the cap and last decision */
  }
  console.log(render(session, wrapped(input)));
  process.exit(0);
}

process.stdin.on('data', c => { input += c; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
// auto-gear: 1s ceiling on *stdin* — render with what we have rather than wait
// on a pipe that never closes. A wrapped command adds its own budget on top
// (AUTO_GEAR_STATUSLINE_TIMEOUT), so total worst case is this plus that.
setTimeout(finish, 1000).unref();

module.exports = { render, lastDecision };

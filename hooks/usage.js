#!/usr/bin/env node
// auto-gear — usage stats, used by the auto-gear-usage skill.
//
// Answers "what did routing actually do", per model and per reasoning effort,
// split by surface: `proxy` is main-loop turns, `agent` is subagent dispatches.
// Neither surface could see the other before this; the shared log is the only
// place the two halves meet.
//
// Read-only. Takes an optional day window: `node usage.js 7`.

const fs = require('fs');
const { usagePath, tierLabel } = require('./policy');

const file = usagePath();
const days = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : null;

let lines;
try {
  lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
} catch (e) {
  console.log(`auto-gear usage  NO DATA YET\n  expected  ${file}\n  why       nothing has routed yet — the log is written by the PreToolUse hook\n            on subagent dispatch, and by proxy.js on main-loop turns.`);
  process.exit(0);
}

const since = days ? Date.now() - days * 86400000 : 0;
const rows = [];
for (const line of lines) {
  try {
    const r = JSON.parse(line);
    if (!since || Date.parse(r.ts) >= since) rows.push(r);
  } catch (e) {
    /* a torn final line from a killed process shouldn't lose the whole file */
  }
}

if (!rows.length) {
  console.log(`auto-gear usage  no entries${days ? ` in the last ${days} day(s)` : ''}\n  log       ${file}`);
  process.exit(0);
}

const tally = (list, key) => list.reduce((acc, r) => {
  const k = r[key] === null || r[key] === undefined ? 'none' : r[key];
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});

const fmt = counts => Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k} ${n}`)
  .join('   ') || '—';

// A bar chart beats a count list here because the question people actually ask
// is proportional — "am I mostly on the cheap tier?" — and eyeballing ratios in
// a row of numbers is work. Bars are scaled to the largest bucket, so the
// longest is always full width and the rest read against it.
const WIDTH = 28;
function histogram(counts, total, indent = '    ') {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return `${indent}—`;
  const max = Math.max(...rows.map(r => r[1]));
  const pad = Math.max(...rows.map(r => r[0].length));
  return rows.map(([k, n]) => {
    // Never round a non-zero bucket down to nothing; an invisible bar reads as
    // "this never happened", which is a different claim than "this is rare".
    const w = Math.max(1, Math.round((n / max) * WIDTH));
    const pct = String(Math.round((n / total) * 100)).padStart(3);
    return `${indent}${k.padEnd(pad)}  ${'█'.repeat(w).padEnd(WIDTH)} ${String(n).padStart(4)}  ${pct}%`;
  }).join('\n');
}

const window = days ? `last ${days} day(s)` : `since ${rows[0].ts.slice(0, 10)}`;
console.log(`auto-gear usage  ${rows.length} routed call(s), ${window}`);

for (const surface of ['proxy', 'agent']) {
  const list = rows.filter(r => r.surface === surface);
  if (!list.length) continue;
  const label = surface === 'proxy' ? 'main loop' : 'subagents';
  console.log(`\n  ${surface} (${label})  ${list.length}`);

  // Forks carry no chosen model, so counting them here would invent a tier
  // called "none" and quietly inflate whatever it sorted next to.
  // Model and effort are one choice, not two — `opus(max)` and `opus(low)` are
  // different spends, and splitting them into separate charts hides which
  // combination you actually ran. One distribution over the pair.
  const picked = list.filter(r => r.model);
  if (picked.length) {
    const pairs = picked.reduce((acc, r) => {
      const k = `${tierLabel(r.model)}(${r.effort || 'none'})`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    console.log(histogram(pairs, picked.length, '    '));
  }

  const changed = list.filter(r => r.changed).length;
  const pct = Math.round((changed / list.length) * 100);
  console.log(`    rerouted  ${changed} of ${list.length} (${pct}%)`);

  // What each rerouted call was moved off. This is the number that says whether
  // routing is earning its keep — a downgrade from the top tier is real money,
  // one between adjacent cheap tiers mostly isn't.
  //
  // Only genuine tier changes count. A call clamped on effort alone stayed on
  // the same model, and listing it as "opus -> opus" reads as a saving that
  // never happened — it belongs on its own line.
  const moves = list.filter(r => r.changed && r.from && r.model && tierLabel(r.from) !== tierLabel(r.model))
    .reduce((acc, r) => {
      const k = `${tierLabel(r.from)} -> ${tierLabel(r.model)}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
  if (Object.keys(moves).length) console.log(`    moves     ${fmt(moves)}`);

  const effortOnly = list.filter(r => r.changed && r.from && tierLabel(r.from) === tierLabel(r.model)).length;
  if (effortOnly) console.log(`    effort-only ${effortOnly} (same tier, reasoning trimmed)`);

  const forks = list.filter(r => r.kind === 'fork').length;
  if (forks) console.log(`    forks     ${forks} (uncappable — ran on the session model)`);
}

console.log(`\n  log       ${file}`);

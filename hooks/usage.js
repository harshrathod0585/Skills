#!/usr/bin/env node
// auto-gear — usage stats, used by the auto-gear-usage skill.
//
// Answers one question: which models actually ran, and at what reasoning
// effort. Model and effort are a single choice — `Opus(max)` and `Opus(low)`
// are different spends — so they share one bar rather than two charts.
//
// Read-only. Takes an optional day window: `node usage.js 7`.

const fs = require('fs');
const { usagePath, tierLabel } = require('./router');

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

// Only calls that landed on a model. Forks have no tier — they ignore the model
// parameter and run on the session model — so they have nothing to report here.
const routed = rows.filter(r => r.model);

if (!routed.length) {
  console.log(`auto-gear usage  nothing routed${days ? ` in the last ${days} day(s)` : ''}\n  log  ${file}`);
  process.exit(0);
}

const counts = routed.reduce((acc, r) => {
  const k = `${tierLabel(r.model)}(${r.effort || 'none'})`;
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});

const WIDTH = 28;
const bars = Object.entries(counts).sort((a, b) => b[1] - a[1]);
const max = Math.max(...bars.map(b => b[1]));
const pad = Math.max(...bars.map(b => b[0].length));

const window = days ? `last ${days} day(s)` : `since ${rows[0].ts.slice(0, 10)}`;
console.log(`auto-gear usage  ${window}\n`);

for (const [k, n] of bars) {
  // Never round a non-zero bucket down to nothing; an invisible bar reads as
  // "this never happened", which is a different claim than "this is rare".
  const w = Math.max(1, Math.round((n / max) * WIDTH));
  const pct = String(Math.round((n / routed.length) * 100)).padStart(3);
  console.log(`  ${k.padEnd(pad)}  ${'█'.repeat(w).padEnd(WIDTH)} ${String(n).padStart(4)}  ${pct}%`);
}

console.log(`\n  log  ${file}`);

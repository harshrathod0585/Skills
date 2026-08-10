#!/usr/bin/env node
// auto-gear — /auto-gear-status. Read-only.
//
// There is no configuration to report any more, so this answers the two
// questions that are still real: what will the router pick, and is the proxy
// actually up (without it, main-loop turns never reach the router at all).

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { ORDER, TIER_MODELS, TIER_EFFORT, WINDOW, configDir } = require('./router');

const PORT = Number(process.env.AUTO_GEAR_PORT) || 8787;

function report(proxyUp) {
  console.log('auto-gear  no configuration — routing is automatic');
  console.log('  tiers     ' + ORDER.map(t =>
    `${t}(${TIER_EFFORT[t] || 'no effort'}, ${WINDOW[t] / 1000}K)`).join('  <  '));
  console.log('  models    ' + ORDER.map(t => TIER_MODELS[t]).join('  '));
  console.log('  subagents routed automatically when no model is given');
  console.log(`  main loop ${proxyUp
    ? `routed — proxy up on :${PORT}`
    : `NOT routed — proxy down. Launch with \`claude-gear\` to route main-loop turns`}`);

  // v2 wrote a policy file. It no longer does anything, and silently ignoring a
  // file the user believes is in force is exactly the failure this tool exists
  // to prevent — so say so rather than leave them guessing.
  const legacy = process.env.AUTO_GEAR_POLICY || path.join(configDir(), 'model-policy.json');
  if (fs.existsSync(legacy)) {
    console.log(`  note      ${legacy} is from auto-gear v2 and is no longer read.`);
    console.log('            Caps and effort ceilings were removed; delete it when convenient.');
  }
}

const sock = net.connect({ port: PORT, host: '127.0.0.1' });
let settled = false;
const finish = up => { if (settled) return; settled = true; sock.destroy(); report(up); };
sock.setTimeout(300);
sock.once('connect', () => finish(true));
sock.once('error', () => finish(false));
sock.once('timeout', () => finish(false));

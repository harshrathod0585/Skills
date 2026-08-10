#!/usr/bin/env node
// auto-gear — SessionStart hook.
//
// Puts the active policy in context so routing decisions are made against the
// real cap instead of the model's memory of one. If no policy exists yet, say
// so once — silent inaction is how a cap ends up never being set.

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { summary } = require('./router');

// If the session was launched pointing at our proxy but nothing is listening,
// every request in it fails with ECONNREFUSED. Start the proxy rather than let
// the user hit a dead session.
//
// Gated on ANTHROPIC_BASE_URL naming our port, deliberately: that env var is
// how the user opts in, and starting a background server for someone who never
// asked for one is a side effect a plugin has no business having. The gate also
// means this can't help a session that wasn't launched through the proxy — the
// base URL is read at process start, long before this hook runs, so there is
// nothing here to point at it.
function ensureProxy(done) {
  const m = String(process.env.ANTHROPIC_BASE_URL || '')
    .match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
  if (!m) return done();

  let settled = false;
  const finish = listening => {
    if (settled) return;
    settled = true;
    if (!listening) {
      try {
        const log = fs.openSync(path.join(os.tmpdir(), 'auto-gear-proxy.log'), 'a');
        spawn(process.execPath, [path.join(__dirname, '..', 'proxy.js')], {
          detached: true, stdio: ['ignore', log, log],
        }).unref();
      } catch (e) {
        /* the session still works, just unrouted — never fail the hook for this */
      }
    }
    done();
  };

  const sock = net.connect({ port: Number(m[1]), host: '127.0.0.1' });
  sock.setTimeout(300); // a hook that stalls delays every session start
  sock.once('connect', () => { sock.destroy(); finish(true); });
  sock.once('error', () => { sock.destroy(); finish(false); });
  sock.once('timeout', () => { sock.destroy(); finish(false); });
}

const context =
  `AUTO-GEAR ACTIVE — routing tiers ${summary()}\n\n` +
  'Agent dispatches that specify no `model` are routed automatically from the task prompt, so ' +
  'omitting it is the normal path and costs nothing. Pass an explicit `model` only when you have a ' +
  'reason the task text does not convey — an explicit choice is treated as deliberate and is left ' +
  'untouched. Use the `auto-gear` skill for the tier rubric.';

ensureProxy(() => {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }));
  } catch (e) {
    // A stdout failure at hook exit must not surface as a hook error.
  }
});

#!/usr/bin/env node
// auto-gear proxy — model routing for the main loop.
//
// The PreToolUse hook can only rewrite Agent dispatches. The session model is
// fixed before any hook exists, so trivial main-thread turns run on whatever
// tier the session started with. This sits in front of the API instead:
// every request, main loop included, gets its `model` rewritten on the way out.
//
//   ANTHROPIC_BASE_URL=http://localhost:8787 claude
//
// Env: AUTO_GEAR_PORT (8787), AUTO_GEAR_MODELS (JSON tier->id), AUTO_GEAR_QUIET.

const http = require('node:http');
const https = require('node:https');
const { loadPolicy, clamp } = require('./hooks/policy');

const PORT = Number(process.env.AUTO_GEAR_PORT) || 8787;
const UPSTREAM = 'api.anthropic.com';

// ponytail: hardcoded tier -> concrete model id. These are the only strings that
// actually drift on a model release; override with AUTO_GEAR_MODELS rather than
// editing this file. A tier missing here is left at whatever the client sent.
const TIER_MODELS = Object.assign(
  { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' },
  JSON.parse(process.env.AUTO_GEAR_MODELS || '{}')
);

// Which tier a wire model id belongs to. Substring match, because ids carry
// versions ("claude-sonnet-5") and the policy speaks in bare tiers ("sonnet").
function tierOf(modelId, order) {
  const id = String(modelId || '').toLowerCase();
  return order.find(t => id.includes(t)) || '';
}

// The routing decision. Returns a tier name, or null for "no opinion" (the
// caller then just enforces the cap and leaves the tier alone).
//
// Deliberately conservative: it only downgrades turns that are plainly chat —
// no tool results, no images, short, near the start of a conversation. Anything
// carrying real work keeps the tier the client asked for.
//
// ponytail: pure heuristic, no model call. A router that asks a model which
// model to use costs more than it saves. Tune the thresholds, not the approach.
function classify(payload, order) {
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  if (!msgs.length || msgs.length > 4) return null;

  // Clients send plain text either as a string or as text blocks. Anything
  // else in the array — tool_result, image, document — means real work.
  const plain = m =>
    typeof m.content === 'string' ||
    (Array.isArray(m.content) && m.content.every(b => b && b.type === 'text'));
  if (!msgs.every(plain)) return null;

  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') return null;
  const text = typeof last.content === 'string'
    ? last.content
    : last.content.map(b => b.text || '').join('');
  if (text.length > 400) return null;

  return order[0];
}

function route(policy, payload) {
  const asked = tierOf(payload.model, policy.order);
  const wanted = classify(payload, policy.order) || asked;
  const effort = payload.output_config && payload.output_config.effort;

  const result = clamp(policy, wanted, effort);
  const id = TIER_MODELS[result.model];
  if (!id || id === payload.model) return null;

  const reason = wanted !== asked && wanted === result.model
    ? `routed ${asked || '?'} -> ${result.model}`
    : result.reason;
  return { model: id, effort: result.effort, reason };
}

function apply(payload, decision) {
  payload.model = decision.model;
  if (payload.output_config) {
    if (decision.effort === undefined) delete payload.output_config.effort;
    else payload.output_config.effort = decision.effort;
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    // ponytail: buffers the whole request to rewrite one JSON field. Requests can
    // be large; responses are piped, so only the upload is held. Stream-parse if
    // it ever matters.
    let body = Buffer.concat(chunks);

    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      try {
        const payload = JSON.parse(body.toString('utf8'));
        const policy = loadPolicy();
        const decision = policy && route(policy, payload);
        if (decision) {
          apply(payload, decision);
          body = Buffer.from(JSON.stringify(payload));
          if (!process.env.AUTO_GEAR_QUIET) {
            console.log(`auto-gear  ${decision.model}  (${decision.reason})`);
          }
        }
      } catch (e) {
        // Unparseable or non-JSON body: forward untouched. Never break a request.
      }
    }

    const headers = { ...req.headers, host: UPSTREAM };
    delete headers['content-length'];
    if (body.length) headers['content-length'] = String(body.length);

    const upstream = https.request(
      { hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
      up => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res); // piped, so SSE streams through unbuffered
      }
    );
    upstream.on('error', err => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
    });
    upstream.end(body);
  });
});

if (require.main === module) {
  const policy = loadPolicy();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`auto-gear proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
    console.log(policy ? `cap=${policy.max_model} enforce=${policy.enforce}` : 'NO VALID POLICY — passing everything through');
    console.log(`ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} claude`);
  });
}

module.exports = { classify, tierOf, route, TIER_MODELS };

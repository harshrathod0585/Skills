#!/usr/bin/env node
// auto-gear proxy — model routing for the main loop.
//
// The PreToolUse hook can only rewrite Agent dispatches. The session model is
// fixed before any hook exists, so trivial main-thread turns run on whatever
// tier the session started with. This sits in front of the API instead:
// every request, main loop included, gets its `model` picked by the router.
//
//   ANTHROPIC_BASE_URL=http://localhost:8787 claude
//
// Env: AUTO_GEAR_PORT (8787), AUTO_GEAR_MODELS (JSON tier->id), AUTO_GEAR_QUIET.

const http = require('node:http');
const https = require('node:https');
const { classify, tierOf, estimateTokens, record, summary, TIER_MODELS } = require('./hooks/router');

const PORT = Number(process.env.AUTO_GEAR_PORT) || 8787;
const UPSTREAM = 'api.anthropic.com';

// Pull the routing signals out of a Messages API payload: the text of the last
// user turn, whether anything in the conversation is real work rather than
// chat, and the size of the whole request.
//
// Size matters here in a way it does not for subagents: the main loop carries
// the entire system prompt, every tool schema, and the full history. That total
// — not the length of the question — decides which windows it still fits.
function signals(payload) {
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];

  // Clients send plain text either as a string or as text blocks. Anything else
  // in the array — tool_result, image, document — means real work.
  const plain = m =>
    typeof m.content === 'string' ||
    (Array.isArray(m.content) && m.content.every(b => b && b.type === 'text'));

  const last = msgs[msgs.length - 1];
  const text = !last ? ''
    : typeof last.content === 'string' ? last.content
    : Array.isArray(last.content) ? last.content.map(b => b.text || '').join('')
    : '';

  return {
    text,
    hasWork: msgs.length > 4 || !msgs.every(plain) || !last || last.role !== 'user',
    tokens: estimateTokens(JSON.stringify(payload)),
  };
}

function route(payload) {
  const { text, hasWork, tokens } = signals(payload);
  const decision = classify(text, { hasWork, tokens });

  const id = TIER_MODELS[decision.model];
  if (!id || id === payload.model) return null;
  return { model: id, effort: decision.effort, reason: decision.reason };
}

function apply(payload, decision) {
  payload.model = decision.model;
  // Haiku takes no effort parameter — sending one is a 400, so the key has to
  // come off rather than be set to a level.
  if (decision.effort === undefined) {
    if (payload.output_config) delete payload.output_config.effort;
  } else {
    payload.output_config = { ...(payload.output_config || {}), effort: decision.effort };
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    // ponytail: buffers the whole request to rewrite two JSON fields. Requests
    // can be large; responses are piped, so only the upload is held.
    // Stream-parse if it ever matters.
    let body = Buffer.concat(chunks);

    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      try {
        const payload = JSON.parse(body.toString('utf8'));
        const asked = payload.model;
        const askedEffort = (payload.output_config && payload.output_config.effort) || null;
        const decision = route(payload);
        if (decision) {
          apply(payload, decision);
          body = Buffer.from(JSON.stringify(payload));
          if (!process.env.AUTO_GEAR_QUIET) {
            console.log(`auto-gear  ${decision.model}${decision.effort ? ` (${decision.effort})` : ''}  ${decision.reason}`);
          }
        }
        record({
          surface: 'proxy',
          from: asked || null,
          model: decision ? decision.model : asked || null,
          effort: decision ? (decision.effort === undefined ? null : decision.effort) : askedEffort,
          changed: Boolean(decision),
        });
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
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`auto-gear proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
    console.log(`routing  ${summary()}`);
    console.log(`ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} claude`);
  });
}

module.exports = { signals, route, apply, tierOf, TIER_MODELS };

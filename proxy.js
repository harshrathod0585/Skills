#!/usr/bin/env node
/**
 * Lightweight, transparent model routing proxy for Anthropic API / Claude Code.
 * Dynamically routes model and reasoning effort based solely on query complexity,
 * while enforcing hard model & effort ceiling caps.
 * 
 * Usage:
 *   node proxy.js
 *   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
 *   claude
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Transform } = require('node:stream');

const PORT = Number(process.env.AUTO_GEAR_PORT) || 8787;
const UPSTREAM = 'api.anthropic.com';

const MODEL_ORDER = ['haiku', 'sonnet', 'opus'];
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

function policyFilePath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return process.env.AUTO_GEAR_POLICY || path.join(configDir, 'model-policy.json');
}

/**
 * Dynamically loads model policy ceiling and tier mappings from ~/.claude/model-policy.json or env
 */
function loadPolicy() {
  const policyFile = policyFilePath();

  // No policy file (auto-gear-set never run) -> uncapped. The classifier already
  // picks the tier a request needs; a ceiling below the top is an opt-in restriction
  // for saving spend, not a safety requirement, so the unconfigured default is full
  // capability rather than an artificial restriction the user never asked for.
  let policy = {
    max_model: (process.env.MAX_MODEL || 'opus').toLowerCase(),
    models: {
      haiku: 'claude-haiku-4-5',
      sonnet: 'claude-sonnet-5',
      opus: 'claude-opus-5'
    },
    max_effort: {
      haiku: null,
      sonnet: 'max',
      opus: 'max'
    }
  };

  try {
    if (fs.existsSync(policyFile)) {
      const data = JSON.parse(fs.readFileSync(policyFile, 'utf8').replace(/^\uFEFF/, ''));
      if (data && typeof data === 'object') {
        if (data.max_model) policy.max_model = String(data.max_model).toLowerCase();
        if (data.models && typeof data.models === 'object') policy.models = { ...policy.models, ...data.models };
        if (data.max_effort && typeof data.max_effort === 'object') policy.max_effort = { ...policy.max_effort, ...data.max_effort };
      }
    }
  } catch (e) {}

  if (process.env.AUTO_GEAR_MODELS) {
    try {
      policy.models = { ...policy.models, ...JSON.parse(process.env.AUTO_GEAR_MODELS) };
    } catch (e) {}
  }

  if (process.env.MAX_EFFORT) {
    const globalMax = process.env.MAX_EFFORT.toLowerCase();
    policy.max_effort.sonnet = globalMax;
    policy.max_effort.opus = globalMax;
  }

  // An unrecognized max_model (typo, stray whitespace, a tier that no longer exists) must
  // resolve to a defined value -- MODEL_ORDER.indexOf(-1) downstream would otherwise disable
  // the clamp check's own indexOf comparison unpredictably. Fall back to the same "opus"
  // used when there's no policy at all, so a broken value behaves like no restriction was
  // ever configured, instead of silently landing on some other implicit cap.
  if (!MODEL_ORDER.includes(policy.max_model)) {
    if (process.env.DEBUG || process.env.AUTO_GEAR_VERBOSE) {
      console.log(`[proxy] unrecognized max_model "${policy.max_model}", falling back to "opus" (uncapped)`);
    }
    policy.max_model = 'opus';
  }

  return policy;
}

// In-memory stats counter for subscription usage preservation
const stats = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  haikuRouted: 0,
  sonnetRouted: 0,
  opusRouted: 0,
  highTierQuotaSavedTurns: 0,
  modelCapEnforcedCount: 0
};

/**
 * Pure Query Complexity Classifier:
 * Evaluates prompt context solely on query complexity (intent, tool payloads, code scope).
 */
function classifyQuery(payload) {
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  if (!msgs.length) return { tier: 'sonnet', effort: 'medium' };

  const lastMsg = msgs[msgs.length - 1];
  if (!lastMsg) return { tier: 'sonnet', effort: 'medium' };

  const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : null;

  // Only the CURRENT turn's payload decides complexity. Checking the whole history
  // (like an earlier version did) means one tool call anywhere in the transcript
  // pins every later turn to sonnet/high forever, even a plain "thanks, one more thing" --
  // exactly the kind of turn that should be free to route back down to Haiku.
  const hasHeavyBlocks = blocks && blocks.some(block => block && block.type !== 'text');
  if (hasHeavyBlocks) {
    return { tier: 'sonnet', effort: 'high' };
  }

  if (lastMsg.role !== 'user') {
    return { tier: 'sonnet', effort: 'medium' };
  }

  const text = typeof lastMsg.content === 'string'
    ? lastMsg.content
    : (blocks || []).map(b => b.text || '').join('');

  const cleanText = text.trim();

  const highKeywords = /\b(architecture|refactor|security|migration|concurrency|database|multi-file|debug)\b/i;
  const codeKeywords = /\b(function|class|import|def|const|let|var|code|refactor|debug|fix|test|build|file)\b/i;

  // High complexity must be checked before "is this simple chat" -- otherwise a short
  // prompt like "Plan a database migration strategy" (no code-ish keyword, so it looks
  // like simple chat under the check below) never reaches this branch at all and gets
  // misrouted to Haiku despite naming exactly the kind of task this tier exists for.
  if (cleanText.length > 1500 || highKeywords.test(cleanText)) {
    return { tier: 'opus', effort: 'high' };
  }

  // Simple query complexity: general knowledge, short chat, basic question without code context
  const isSimpleChat = cleanText.length > 0 && cleanText.length <= 400 && !codeKeywords.test(cleanText);
  if (isSimpleChat) {
    return { tier: 'haiku', effort: undefined };
  }

  // Standard query complexity: regular engineering task, standard bug fix
  return { tier: 'sonnet', effort: 'medium' };
}

function routeRequest(payload) {
  const policy = loadPolicy();
  const decision = classifyQuery(payload);
  let targetTier = decision.tier;
  let targetEffort = decision.effort;

  // Enforce MAX_MODEL ceiling cap
  const targetIdx = MODEL_ORDER.indexOf(targetTier);
  const maxIdx = MODEL_ORDER.indexOf(policy.max_model);
  let wasCapClamped = false;

  if (targetIdx > maxIdx && maxIdx !== -1) {
    targetTier = policy.max_model;
    wasCapClamped = true;
    stats.modelCapEnforcedCount++;
  }

  const concreteModel = policy.models[targetTier] || payload.model;

  // Enforce effort ceiling cap for the target model tier
  const maxEffortForTier = policy.max_effort[targetTier];
  if (maxEffortForTier === null || targetTier === 'haiku') {
    targetEffort = undefined;
  } else if (targetEffort && maxEffortForTier) {
    const currentEffortIdx = EFFORT_ORDER.indexOf(String(targetEffort).toLowerCase());
    const maxEffortIdx = EFFORT_ORDER.indexOf(String(maxEffortForTier).toLowerCase());
    if (currentEffortIdx > maxEffortIdx && maxEffortIdx !== -1) {
      targetEffort = maxEffortForTier;
    }
  }

  // Update stats
  stats.totalRequests++;
  if (targetTier === 'haiku') {
    stats.haikuRouted++;
    stats.highTierQuotaSavedTurns++;
  } else if (targetTier === 'sonnet') {
    stats.sonnetRouted++;
  } else if (targetTier === 'opus') {
    stats.opusRouted++;
  }

  return {
    model: concreteModel,
    effort: targetEffort,
    tier: targetTier,
    originalModel: payload.model,
    wasCapClamped: wasCapClamped
  };
}

// Transforms SSE stream or JSON response to prepend [routed:tier(effort)] on the first line.
// Buffers across chunks (rather than resetting per-chunk) so a `"text":"` boundary split
// across two TCP reads still gets caught, with a size cap so a payload that never
// contains a text field doesn't stall the stream forever.
function createResponseHeaderTransform(tierName, effortLevel) {
  const MAX_BUFFER = 4096;
  let headerInjected = false;
  let buffer = '';
  const effortSuffix = effortLevel ? `(${effortLevel})` : '';
  const headerText = `[routed:${tierName}${effortSuffix}]\n\n`.replace(/\n/g, '\\n');
  const textKeyPattern = /"text"\s*:\s*"/;

  function flushBuffer(stream) {
    if (buffer.length) stream.push(buffer);
    buffer = '';
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      if (headerInjected) {
        this.push(chunk);
        return callback();
      }

      buffer += chunk.toString('utf8');
      const match = buffer.match(textKeyPattern);

      if (match) {
        const insertAt = match.index + match[0].length;
        buffer = buffer.slice(0, insertAt) + headerText + buffer.slice(insertAt);
        headerInjected = true;
        flushBuffer(this);
      } else if (buffer.length > MAX_BUFFER) {
        headerInjected = true;
        flushBuffer(this);
      }

      callback();
    },
    flush(callback) {
      flushBuffer(this);
      callback();
    }
  });
}

const server = http.createServer((req, res) => {
  // Stats Endpoint
  if (req.method === 'GET' && (req.url === '/stats' || req.url === '/v1/stats')) {
    const policy = loadPolicy();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...stats, policy }, null, 2));
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    let decision = null;

    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      try {
        const payload = JSON.parse(body.toString('utf8'));
        decision = routeRequest(payload);

        payload.model = decision.model;
        if (payload.output_config) {
          if (decision.effort === undefined) {
            delete payload.output_config.effort;
          } else {
            payload.output_config.effort = decision.effort;
          }
        }

        body = Buffer.from(JSON.stringify(payload));

        if (process.env.DEBUG || process.env.AUTO_GEAR_VERBOSE) {
          console.log(`[proxy] ${decision.originalModel} -> ${decision.model} (Tier: ${decision.tier}, Effort: ${decision.effort || 'none'})`);
        }
      } catch (e) {
        // Forward unparseable body untouched
      }
    }

    const headers = { ...req.headers, host: UPSTREAM };
    delete headers['content-length'];
    if (body.length) headers['content-length'] = String(body.length);
    // The header-injection transform below does string/regex surgery on the response
    // bytes, which corrupts a gzip/br-compressed body -- the client's own decompressor
    // then fails (ZlibError). Force an uncompressed upstream response so the transform's
    // "this is plain UTF-8 text" assumption is actually true, not just usually true.
    headers['accept-encoding'] = 'identity';

    const upstream = https.request(
      { hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
      up => {
        const responseHeaders = { ...up.headers };
        if (decision && up.statusCode === 200) {
          // Body length changes once the [routed:...] tag is spliced in -- forwarding
          // upstream's original content-length would truncate or mismatch the payload.
          delete responseHeaders['content-length'];
          res.writeHead(up.statusCode, responseHeaders);
          const transformStream = createResponseHeaderTransform(decision.tier, decision.effort);
          up.pipe(transformStream).pipe(res);
        } else {
          res.writeHead(up.statusCode, responseHeaders);
          up.pipe(res);
        }
      }
    );

    upstream.on('error', err => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
    });

    upstream.end(body);
  });
});

// Fetches the live model catalog from Anthropic so tier -> concrete-model-id mappings
// don't have to be hand-updated in a config file every time a new model ships.
function fetchModelCatalog(apiKey = process.env.ANTHROPIC_API_KEY) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error('ANTHROPIC_API_KEY not set'));
    https.get(
      { hostname: UPSTREAM, path: '/v1/models?limit=1000', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!Array.isArray(parsed.data)) throw new Error(parsed.error?.message || 'unexpected /v1/models response');
            resolve(parsed.data);
          } catch (e) { reject(e); }
        });
      }
    ).on('error', reject);
  });
}

function modelFamily(id) {
  if (/haiku/i.test(id)) return 'haiku';
  if (/sonnet/i.test(id)) return 'sonnet';
  if (/opus/i.test(id)) return 'opus';
  return null;
}

// Anthropic model ids carry a release date suffix (e.g. claude-sonnet-4-5-20250929),
// so within a family the lexicographically-greatest id is the newest release.
function latestModelsByTier(catalogEntries) {
  const latest = {};
  for (const entry of catalogEntries) {
    const family = modelFamily(entry.id);
    if (!family) continue;
    if (!latest[family] || entry.id > latest[family]) latest[family] = entry.id;
  }
  return latest;
}

// Writes freshly-resolved model ids into the policy file's `models` block, keeping
// everything else (max_model, max_effort) untouched. No-ops quietly if there's no
// API key, no network, or no policy file yet -- a refresh failing must never be the
// reason routing stops working.
async function refreshPolicyModels() {
  let latest;
  try {
    latest = latestModelsByTier(await fetchModelCatalog());
  } catch (e) {
    if (process.env.DEBUG || process.env.AUTO_GEAR_VERBOSE) console.log(`[proxy] model catalog refresh skipped: ${e.message}`);
    return null;
  }

  const file = policyFilePath();

  // Only refresh a policy the user already created via /auto-gear-set. A user who has
  // never opted in still gets fully-functional routing off the in-code defaults (see
  // loadPolicy) -- this background cycle must not be the thing that conjures a config
  // file onto their disk that they never asked for.
  if (!fs.existsSync(file)) {
    if (process.env.DEBUG || process.env.AUTO_GEAR_VERBOSE) console.log('[proxy] no policy file yet, skipping refresh (run /auto-gear-set first)');
    return null;
  }

  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {}

  const models = { ...(onDisk.models || {}), ...latest };
  fs.writeFileSync(file, JSON.stringify({ ...onDisk, models }, null, 2));

  if (process.env.DEBUG || process.env.AUTO_GEAR_VERBOSE) console.log(`[proxy] model catalog refreshed: ${JSON.stringify(latest)}`);
  return models;
}

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day is plenty; model releases aren't hourly

if (require.main === module) {
  if (process.argv[2] === 'latest-models') {
    fetchModelCatalog()
      .then(catalog => { process.stdout.write(JSON.stringify(latestModelsByTier(catalog), null, 2) + '\n'); })
      .catch(err => { console.error(`Could not fetch model catalog: ${err.message}`); process.exit(1); });
  } else {
    const policy = loadPolicy();
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Proxy running on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
      console.log(`Caps active: Max Model = ${policy.max_model}`);
      console.log(`Model Tiers: Haiku = ${policy.models.haiku}, Sonnet = ${policy.models.sonnet}, Opus = ${policy.models.opus}`);
      console.log(`Per-model effort ceilings: Sonnet = ${policy.max_effort.sonnet}, Opus = ${policy.max_effort.opus}, Haiku = none`);
      console.log(`Live stats available at: http://127.0.0.1:${PORT}/stats`);
    });
    refreshPolicyModels();
    setInterval(refreshPolicyModels, REFRESH_INTERVAL_MS).unref();
  }
}

module.exports = {
  routeRequest, classifyQuery, createResponseHeaderTransform, loadPolicy, stats,
  fetchModelCatalog, latestModelsByTier, refreshPolicyModels, policyFilePath
};

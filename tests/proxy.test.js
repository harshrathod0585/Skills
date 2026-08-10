const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routeRequest, classifyQuery, createResponseHeaderTransform, loadPolicy, latestModelsByTier, refreshPolicyModels } = require('../proxy');

const chat = text => ({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: text }]
});

test('simple query complexity classifies to Haiku with no effort', () => {
  const result = classifyQuery(chat('Who is virat kohli'));
  assert.equal(result.tier, 'haiku');
  assert.equal(result.effort, undefined);
});

test('standard query complexity classifies to Sonnet with medium effort', () => {
  const result = classifyQuery(chat('Write a function to format dates in JavaScript'));
  assert.equal(result.tier, 'sonnet');
  assert.equal(result.effort, 'medium');
});

test('high query complexity classifies to Opus with high effort', () => {
  const result = classifyQuery(chat('Analyze this multi-file architecture security and database migration plan: ' + 'x'.repeat(1500)));
  assert.equal(result.tier, 'opus');
  assert.equal(result.effort, 'high');
});

test('with no policy file and no env override, routing is uncapped (opus ceiling)', () => {
  const tmpFile = path.join(os.tmpdir(), `auto-gear-policy-test-${Date.now()}-nopolicy.json`);
  const prevPolicyEnv = process.env.AUTO_GEAR_POLICY;
  const prevMaxModelEnv = process.env.MAX_MODEL;
  process.env.AUTO_GEAR_POLICY = tmpFile; // points at a file that doesn't exist
  delete process.env.MAX_MODEL;
  try {
    const policy = loadPolicy();
    assert.equal(policy.max_model, 'opus');

    const payload = chat('Analyze this multi-file architecture security and database migration plan: ' + 'x'.repeat(1500));
    const decision = routeRequest(payload);
    assert.equal(decision.tier, 'opus');
    assert.equal(decision.model, 'claude-opus-5');
  } finally {
    if (prevPolicyEnv === undefined) delete process.env.AUTO_GEAR_POLICY; else process.env.AUTO_GEAR_POLICY = prevPolicyEnv;
    if (prevMaxModelEnv === undefined) delete process.env.MAX_MODEL; else process.env.MAX_MODEL = prevMaxModelEnv;
  }
});

test('an explicit MAX_MODEL still clamps high complexity queries down', () => {
  const tmpFile = path.join(os.tmpdir(), `auto-gear-policy-test-${Date.now()}-envcap.json`);
  const prevPolicyEnv = process.env.AUTO_GEAR_POLICY;
  const prevMaxModelEnv = process.env.MAX_MODEL;
  process.env.AUTO_GEAR_POLICY = tmpFile;
  process.env.MAX_MODEL = 'sonnet';
  try {
    const payload = chat('Analyze this multi-file architecture security and database migration plan: ' + 'x'.repeat(1500));
    const decision = routeRequest(payload);
    assert.equal(decision.tier, 'sonnet');
    assert.equal(decision.model, 'claude-sonnet-5');
  } finally {
    if (prevPolicyEnv === undefined) delete process.env.AUTO_GEAR_POLICY; else process.env.AUTO_GEAR_POLICY = prevPolicyEnv;
    if (prevMaxModelEnv === undefined) delete process.env.MAX_MODEL; else process.env.MAX_MODEL = prevMaxModelEnv;
  }
});

test('createResponseHeaderTransform prepends [routed:tier(effort)] to text stream payload', async () => {
  const transform = createResponseHeaderTransform('sonnet', 'medium');
  let output = '';

  transform.on('data', chunk => {
    output += chunk.toString('utf8');
  });

  transform.write('{"type":"content_block_delta","delta":{"type":"text_delta","text":"Virat Kohli"}}');
  transform.end();

  await new Promise(resolve => transform.on('end', resolve));
  assert.ok(output.includes('[routed:sonnet(medium)]'));
});

test('createResponseHeaderTransform catches a "text": key split across two chunks', async () => {
  const transform = createResponseHeaderTransform('haiku', undefined);
  let output = '';

  transform.on('data', chunk => {
    output += chunk.toString('utf8');
  });

  transform.write('{"type":"content_block_delta","delta":{"type":"text_delta","te');
  transform.write('xt":"Virat Kohli"}}');
  transform.end();

  await new Promise(resolve => transform.on('end', resolve));
  assert.ok(output.includes('[routed:haiku]'));
  assert.ok(output.includes('Virat Kohli'));
});

test('a plain follow-up after a tool-carrying turn routes on its own merits, not pinned to sonnet/high', () => {
  const followUp = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'Fix the bug in this file' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] },
      { role: 'assistant', content: 'Fixed it.' },
      { role: 'user', content: 'Who is virat kohli' }
    ]
  };
  const result = classifyQuery(followUp);
  assert.equal(result.tier, 'haiku');
  assert.equal(result.effort, undefined);
});

test('an unrecognized max_model resolves to the same uncapped default as no policy at all', () => {
  const tmpFile = path.join(os.tmpdir(), `auto-gear-policy-test-${Date.now()}-badmax.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ max_model: 'sonnett' })); // typo

  const prevPolicyEnv = process.env.AUTO_GEAR_POLICY;
  process.env.AUTO_GEAR_POLICY = tmpFile;
  try {
    const policy = loadPolicy();
    assert.equal(policy.max_model, 'opus');

    const highComplexity = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Analyze this multi-file architecture security and database migration plan: ' + 'x'.repeat(1500) }] };
    const decision = routeRequest(highComplexity);
    assert.equal(decision.tier, 'opus');
  } finally {
    if (prevPolicyEnv === undefined) delete process.env.AUTO_GEAR_POLICY; else process.env.AUTO_GEAR_POLICY = prevPolicyEnv;
    fs.unlinkSync(tmpFile);
  }
});

test('refreshPolicyModels never creates a policy file for a user who has not run auto-gear-set', async () => {
  const tmpFile = path.join(os.tmpdir(), `auto-gear-policy-test-${Date.now()}-nofile.json`);
  assert.equal(fs.existsSync(tmpFile), false);

  const prevPolicyEnv = process.env.AUTO_GEAR_POLICY;
  process.env.AUTO_GEAR_POLICY = tmpFile;
  try {
    const result = await refreshPolicyModels();
    assert.equal(result, null);
    assert.equal(fs.existsSync(tmpFile), false);
  } finally {
    if (prevPolicyEnv === undefined) delete process.env.AUTO_GEAR_POLICY; else process.env.AUTO_GEAR_POLICY = prevPolicyEnv;
  }
});

test('refreshPolicyModels fails open and leaves the policy file untouched with no API key', async () => {
  const tmpFile = path.join(os.tmpdir(), `auto-gear-policy-test-${Date.now()}.json`);
  const original = { max_model: 'sonnet', models: { haiku: 'stub-haiku' }, max_effort: { sonnet: 'high' } };
  fs.writeFileSync(tmpFile, JSON.stringify(original));

  const prevPolicyEnv = process.env.AUTO_GEAR_POLICY;
  const prevKeyEnv = process.env.ANTHROPIC_API_KEY;
  process.env.AUTO_GEAR_POLICY = tmpFile;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const result = await refreshPolicyModels();
    assert.equal(result, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(tmpFile, 'utf8')), original);
  } finally {
    if (prevPolicyEnv === undefined) delete process.env.AUTO_GEAR_POLICY; else process.env.AUTO_GEAR_POLICY = prevPolicyEnv;
    if (prevKeyEnv !== undefined) process.env.ANTHROPIC_API_KEY = prevKeyEnv;
    fs.unlinkSync(tmpFile);
  }
});

test('latestModelsByTier picks the newest dated release per family, not the first listed', () => {
  const catalog = [
    { id: 'claude-sonnet-4-5-20250929' },
    { id: 'claude-haiku-4-5-20251001' },
    { id: 'claude-sonnet-5-20260115' },
    { id: 'claude-opus-5-20260201' },
    { id: 'claude-2.1' } // unrelated family -> ignored
  ];
  const latest = latestModelsByTier(catalog);
  assert.equal(latest.sonnet, 'claude-sonnet-5-20260115');
  assert.equal(latest.haiku, 'claude-haiku-4-5-20251001');
  assert.equal(latest.opus, 'claude-opus-5-20260201');
});

test('a turn that itself carries fresh tool results still classifies as high complexity', () => {
  const heavyTurn = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'Fix the bug in this file' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] }
    ]
  };
  const result = classifyQuery(heavyTurn);
  assert.equal(result.tier, 'sonnet');
  assert.equal(result.effort, 'high');
});

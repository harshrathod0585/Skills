// The routing decision, without a socket. The server is a pipe; `route` is the
// part that can be wrong.
const { test } = require('node:test');
const assert = require('node:assert');
const { classify, tierOf, route } = require('../proxy');

const ORDER = ['haiku', 'sonnet', 'opus'];
const policy = {
  order: ORDER,
  max_model: 'opus',
  max_effort: { haiku: null, sonnet: 'medium', opus: 'medium' },
  enforce: 'clamp',
};

const chat = text => ({ model: 'claude-opus-5', messages: [{ role: 'user', content: text }] });

test('tier is read out of a versioned wire model id', () => {
  assert.equal(tierOf('claude-opus-5', ORDER), 'opus');
  assert.equal(tierOf('claude-haiku-4-5', ORDER), 'haiku');
  assert.equal(tierOf('claude-fable-5', ORDER), ''); // unknown tier: no match
});

test('short plain chat routes to the cheapest tier', () => {
  assert.equal(classify(chat('who is virat kohli'), ORDER), 'haiku');
  assert.equal(route(policy, chat('who is virat kohli')).model, 'claude-haiku-4-5');
});

test('text blocks are chat, not work — the shape real clients send', () => {
  const payload = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'who is virat kohli' }] }],
  };
  assert.equal(classify(payload, ORDER), 'haiku');
  assert.equal(route(policy, payload).model, 'claude-haiku-4-5');
});

test('a long question sent as text blocks is still left alone', () => {
  const payload = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(401) }] }],
  };
  assert.equal(classify(payload, ORDER), null);
});

test('tool results keep the tier the client asked for', () => {
  const payload = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }],
  };
  assert.equal(classify(payload, ORDER), null);
  assert.equal(route(policy, payload), null); // nothing to rewrite
});

test('long prompts and long conversations are left alone', () => {
  assert.equal(classify(chat('x'.repeat(401)), ORDER), null);
  const long = { model: 'claude-opus-5', messages: Array(5).fill({ role: 'user', content: 'hi' }) };
  assert.equal(classify(long, ORDER), null);
});

test('effort is clamped to the routed tier, not the requested one', () => {
  const payload = { ...chat('hi'), output_config: { effort: 'max' } };
  const decision = route(policy, payload);
  assert.equal(decision.model, 'claude-haiku-4-5');
  assert.equal(decision.effort, undefined); // haiku takes no effort => dropped
});

test('the cap still binds when the heuristic has no opinion', () => {
  const capped = { ...policy, max_model: 'sonnet' };
  const payload = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }],
  };
  assert.equal(route(capped, payload).model, 'claude-sonnet-5');
});

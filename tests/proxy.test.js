// The routing decision, without a socket. The server is a pipe; `route` and
// `classify` are the parts that can be wrong.
const { test } = require('node:test');
const assert = require('node:assert');
const { route, signals, tierOf } = require('../proxy');
const { classify, estimateTokens } = require('../hooks/router');

const chat = text => ({ model: 'claude-opus-5', messages: [{ role: 'user', content: text }] });

test('tier is read out of a versioned wire model id', () => {
  assert.equal(tierOf('claude-opus-5'), 'opus');
  assert.equal(tierOf('claude-haiku-4-5'), 'haiku');
  assert.equal(tierOf('claude-fable-5'), ''); // not in the tier table
});

test('short single-line query routes to haiku, with no effort key', () => {
  const d = route(chat('who is virat kohli'));
  assert.equal(d.model, 'claude-haiku-4-5');
  assert.equal(d.effort, undefined); // haiku takes no effort parameter
});

test('text blocks are read the same as a plain string — the shape real clients send', () => {
  const payload = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'who is virat kohli' }] }],
  };
  assert.equal(route(payload).model, 'claude-haiku-4-5');
});

test('a medium query routes to sonnet', () => {
  assert.equal(route(chat('x'.repeat(400))).model, 'claude-sonnet-5');
});

test('a long query routes to opus with high effort', () => {
  // Starts on haiku: route() returns null when the routed tier is already the
  // one the payload names, so the fixture has to differ from the answer.
  const d = route({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'x'.repeat(1600) }] });
  assert.equal(d.model, 'claude-opus-5');
  assert.equal(d.effort, 'high');
});

test('tool results are work, so they route to opus however short they are', () => {
  const payload = {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }],
  };
  assert.equal(route(payload).model, 'claude-opus-5');
});

test('a long conversation is work even when every turn is plain text', () => {
  const long = { model: 'claude-haiku-4-5', messages: Array(5).fill({ role: 'user', content: 'hi' }) };
  assert.equal(route(long).model, 'claude-opus-5');
});

test('every request gets a decision — nothing passes through unrouted', () => {
  // Same tier in and out is the one case with nothing to rewrite.
  assert.equal(route({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }), null);
  assert.ok(route(chat('hi'))); // opus in, haiku out
});

// The bug this guard exists for: a short question in a session whose system
// prompt and tool schemas are enormous. The question says "haiku"; the payload
// does not fit haiku's 200K window, and routing it there put a real session at
// 89% context on its first message.
test('a huge payload is not routed to a tier it cannot fit in', () => {
  const payload = {
    model: 'claude-opus-5',
    system: 'x'.repeat(600000), // ~150K tokens, over 60% of haiku's 200K
    messages: [{ role: 'user', content: 'hi' }],
  };
  const s = signals(payload);
  assert.ok(s.tokens > 200000 * 0.6, 'fixture must exceed the haiku threshold');
  assert.notEqual(route(payload), null);
  assert.notEqual(route(payload).model, 'claude-haiku-4-5');
});

test('classify raises the tier rather than lowering it when the payload is large', () => {
  const d = classify('hi', { tokens: 500000 }); // fits opus/sonnet, not haiku
  assert.notEqual(d.model, 'haiku');
  assert.match(d.reason, /exceeds haiku window/);
});

test('token estimate is bytes/4 and counts multi-byte characters honestly', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.ok(estimateTokens('日本語') > 2); // 3 chars, 9 bytes
});

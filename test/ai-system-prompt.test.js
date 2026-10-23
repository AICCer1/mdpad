'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessages } = require('../src/ai');

test('a custom system prompt is appended to the built-in one', () => {
  const messages = buildMessages({ instruction: 'tighten this', systemPrompt: 'Keep sentences short.' });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /writing assistant/);
  assert.match(messages[0].content, /Keep sentences short\./);
});

test('no system prompt keeps the built-in message unchanged', () => {
  const messages = buildMessages({ instruction: 'go' });
  assert.doesNotMatch(messages[0].content, /Additional guidance/);
});

test('the custom prompt is capped', () => {
  const messages = buildMessages({ instruction: 'go', systemPrompt: 'x'.repeat(5000) });
  assert.ok(messages[0].content.length < 2600);
});

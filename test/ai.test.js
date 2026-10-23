'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/ai');

test('endpointFrom normalizes base URLs', () => {
  assert.equal(ai.endpointFrom('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(ai.endpointFrom('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(
    ai.endpointFrom('http://127.0.0.1:11434/v1/chat/completions'),
    'http://127.0.0.1:11434/v1/chat/completions'
  );
  assert.throws(() => ai.endpointFrom(''), /not configured/);
});

test('buildMessages carries context, selection and task', () => {
  const messages = ai.buildMessages({
    instruction: 'tighten this',
    selection: 'very long sentence',
    context: 'the document',
    language: 'Chinese',
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /markdown editor/);
  assert.match(messages[1].content, /the document/);
  assert.match(messages[1].content, /very long sentence/);
  assert.match(messages[1].content, /Task: tighten this/);
  assert.match(messages[1].content, /Write in Chinese/);
});

test('buildMessages falls back to a continue task', () => {
  const messages = ai.buildMessages({});
  assert.match(messages[1].content, /Task: Continue writing/);
});

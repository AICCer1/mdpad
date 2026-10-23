'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { endpointFrom, normalizeBaseUrl, versionedEndpointFrom } = require('../src/ai-endpoint');

test('a bare host still resolves to the chat endpoint', () => {
  assert.equal(endpointFrom('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
});

test('a versioned base keeps its path', () => {
  assert.equal(endpointFrom('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(endpointFrom('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
});

test('a full endpoint is used as-is', () => {
  assert.equal(
    endpointFrom('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions'
  );
});

test('an empty endpoint is refused instead of producing a relative URL', () => {
  assert.equal(normalizeBaseUrl(''), '');
  assert.throws(() => endpointFrom(''), /not configured/);
});

test('the versioned fallback only applies to a host without a path', () => {
  assert.equal(versionedEndpointFrom('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(versionedEndpointFrom('https://api.deepseek.com/v1'), '');
  assert.equal(versionedEndpointFrom('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1/chat/completions');
});

test('ollama style hosts without a version are left alone by the normaliser', () => {
  assert.equal(endpointFrom('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/chat/completions');
});

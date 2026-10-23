'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseAiError } = require('../src/ai-errors');

test('an auth failure points at the key', () => {
  assert.match(diagnoseAiError('HTTP 401 Unauthorized'), /API key/i);
});

test('a bad path points at the base URL', () => {
  assert.match(diagnoseAiError('HTTP 404 not found'), /base URL/i);
});

test('a refused connection suggests starting the local server', () => {
  assert.match(diagnoseAiError('connect ECONNREFUSED 127.0.0.1:11434'), /ollama serve/i);
});

test('DNS failures are named as such', () => {
  assert.match(diagnoseAiError('getaddrinfo ENOTFOUND api.example.com'), /resolve/i);
  assert.notEqual(
    diagnoseAiError('getaddrinfo ENOTFOUND api.example.com'),
    diagnoseAiError('HTTP 401 Unauthorized')
  );
});

test('timeouts suggest a smaller context', () => {
  assert.match(diagnoseAiError('request cancelled or timed out'), /paragraph/i);
});

test('an unknown error gets a generic but useful hint', () => {
  assert.match(diagnoseAiError('weird failure'), /OpenAI chat-completions/i);
  assert.ok(diagnoseAiError(null).length > 10);
});

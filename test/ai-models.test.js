'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { modelsUrlFrom, parseModels, listModels } = require('../src/ai-models');

test('the models URL sits beside chat/completions', () => {
  assert.equal(modelsUrlFrom('https://api.example.com/v1'), 'https://api.example.com/v1/models');
  assert.equal(modelsUrlFrom('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
  assert.equal(
    modelsUrlFrom('https://api.example.com/v1/chat/completions'),
    'https://api.example.com/v1/models'
  );
  assert.throws(() => modelsUrlFrom(''), /not configured/);
});

test('model ids are deduplicated, trimmed and sorted', () => {
  const payload = {
    data: [{ id: 'zeta' }, { id: ' alpha ' }, { id: 'zeta' }, { name: 'beta' }, {}, null],
  };
  assert.deepEqual(parseModels(payload), ['alpha', 'beta', 'zeta']);
});

test('a payload without a data array yields no models', () => {
  assert.deepEqual(parseModels(null), []);
  assert.deepEqual(parseModels({}), []);
  assert.deepEqual(parseModels({ data: 'nope' }), []);
});

test('listModels sends the bearer token and parses the answer', async () => {
  let seen = null;
  const models = await listModels({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'secret',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'm2' }, { id: 'm1' }] }),
      };
    },
  });
  assert.deepEqual(models, ['m1', 'm2']);
  assert.equal(seen.url, 'http://127.0.0.1:1234/v1/models');
  assert.equal(seen.options.headers.authorization, 'Bearer secret');
});

test('an HTTP error surfaces the status', async () => {
  await assert.rejects(
    () =>
      listModels({
        baseUrl: 'http://127.0.0.1:1234/v1',
        fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'not found' }),
      }),
    /HTTP 404/
  );
});

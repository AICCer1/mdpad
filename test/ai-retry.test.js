'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { completeStream } = require('../src/ai');

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

const args = { baseUrl: 'http://127.0.0.1:9/v1', model: 'stub', instruction: 'go' };

test('retries once after a network failure', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    return sseResponse(['hello', ' world']);
  };
  try {
    const text = await completeStream(args, () => {});
    assert.equal(text, 'hello world');
    assert.equal(calls, 2);
  } finally {
    global.fetch = original;
  }
});

test('retries once on HTTP 503', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, text: async () => 'busy' };
    return sseResponse(['ok']);
  };
  try {
    assert.equal(await completeStream(args, () => {}), 'ok');
    assert.equal(calls, 2);
  } finally {
    global.fetch = original;
  }
});

test('does not retry a 400', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 400, text: async () => 'bad request' };
  };
  try {
    await assert.rejects(() => completeStream(args, () => {}), /HTTP 400/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = original;
  }
});

test('gives up after the retry also fails', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('offline');
  };
  try {
    await assert.rejects(() => completeStream(args, () => {}), /offline/);
    assert.equal(calls, 2);
  } finally {
    global.fetch = original;
  }
});

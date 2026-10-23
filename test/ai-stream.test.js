'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ai = require('../src/ai');

function withStreamServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('completeStream forwards deltas and returns the joined text', async () => {
  const { server, port } = await withStreamServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const deltas = [];
  const text = await ai.completeStream(
    { baseUrl: `http://127.0.0.1:${port}/v1`, instruction: 'say hello' },
    (delta) => deltas.push(delta)
  );
  server.close();

  assert.equal(text, 'hello');
  assert.deepEqual(deltas, ['he', 'llo']);
});

test('completeStream can be cancelled through its signal', async () => {
  const { server, port } = await withStreamServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    // keep the connection open so cancellation is what ends it
  });

  const controller = new AbortController();
  const seen = [];
  const promise = ai.completeStream(
    { baseUrl: `http://127.0.0.1:${port}/v1`, instruction: 'x' },
    (delta) => {
      seen.push(delta);
      controller.abort();
    },
    controller.signal
  );

  await assert.rejects(promise, /cancelled or timed out/);
  server.close();
  assert.deepEqual(seen, ['partial']);
});

test('completeStream surfaces HTTP failures', async () => {
  const { server, port } = await withStreamServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"bad key"}');
  });

  await assert.rejects(
    ai.completeStream({ baseUrl: `http://127.0.0.1:${port}/v1`, instruction: 'x' }, () => {}),
    /HTTP 401/
  );
  server.close();
});

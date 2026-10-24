'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createFeedServer, bumpPatch } = require('../scripts/feed.js');

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}

test('bumpPatch raises the patch component', () => {
  assert.equal(bumpPatch('1.29.0'), '1.29.1');
  assert.equal(bumpPatch('2.0'), '2.0.1');
  assert.equal(bumpPatch('1.2.3'), '1.2.4');
});

test('feed serves latest.yml and rewrites the version when asked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-feed-'));
  fs.writeFileSync(
    path.join(dir, 'latest.yml'),
    'version: 1.2.3\nfiles:\n  - url: mdpad 1.2.3.exe\n    sha512: abc\n    size: 3\n',
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'mdpad 1.2.3.exe'), 'xyz');

  const server = createFeedServer({ dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const plain = await get(port, '/latest.yml');
  assert.equal(plain.status, 200);
  assert.match(plain.body, /version: 1\.2\.3/);

  const bumpedServer = createFeedServer({ dir, bump: true, version: '1.2.3' });
  await new Promise((resolve) => bumpedServer.listen(0, '127.0.0.1', resolve));
  const bumped = await get(bumpedServer.address().port, '/latest.yml');
  assert.match(bumped.body, /version: 1\.2\.4/);
  assert.match(bumped.body, /mdpad 1\.2\.3\.exe/);

  const asset = await get(port, '/mdpad%201.2.3.exe');
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'xyz');

  const missing = await get(port, '/nope.exe');
  assert.equal(missing.status, 404);
  const traversal = await get(port, '/..%2Fpackage.json');
  assert.equal(traversal.status, 404);

  server.close();
  bumpedServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

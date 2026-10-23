'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveImage, embedImages } = require('../src/exporters/epub');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('resolves a local image with its mime type', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-epub-'));
  fs.writeFileSync(path.join(dir, 'pic.png'), PNG);
  const image = resolveImage('pic.png', dir);
  assert.equal(image.mime, 'image/png');
  assert.ok(image.buffer.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decodes a data url', () => {
  const image = resolveImage(`data:image/png;base64,${PNG.toString('base64')}`, os.tmpdir());
  assert.equal(image.ext, 'png');
  assert.equal(image.mime, 'image/png');
});

test('remote urls and missing files are skipped', () => {
  assert.equal(resolveImage('https://example.com/a.png', os.tmpdir()), null);
  assert.equal(resolveImage('//cdn.example.com/a.png', os.tmpdir()), null);
  assert.equal(resolveImage('nope.png', os.tmpdir()), null);
});

test('embedImages rewrites src and records the file', () => {
  const store = new Map();
  const html = embedImages('<p><img src="pic.png" alt="x"></p>', os.tmpdir(), store);
  // pic.png does not exist in tmpdir, so it stays untouched.
  assert.match(html, /src="pic\.png"/);
  assert.equal(store.size, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-epub2-'));
  fs.writeFileSync(path.join(dir, 'pic.png'), PNG);
  const store2 = new Map();
  const rewritten = embedImages('<p><img src="pic.png" alt="x"></p>', dir, store2);
  assert.match(rewritten, /src="images\/img1\.png"/);
  assert.equal(store2.size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

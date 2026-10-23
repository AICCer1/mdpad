'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadImage, imageSize } = require('../src/exporters/docx');

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('reads a local png with its dimensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-docx-'));
  const file = path.join(dir, 'pixel.png');
  fs.writeFileSync(file, PNG);
  const image = loadImage('pixel.png', dir);
  assert.equal(image.type, 'png');
  assert.deepEqual({ width: image.width, height: image.height }, { width: 1, height: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accepts a data url', () => {
  const image = loadImage(`data:image/png;base64,${PNG.toString('base64')}`, os.tmpdir());
  assert.ok(image && image.buffer.length > 0);
});

test('remote urls and missing files are not embedded', () => {
  assert.equal(loadImage('https://example.com/x.png', os.tmpdir()), null);
  assert.equal(loadImage('missing.png', os.tmpdir()), null);
  assert.equal(loadImage('', os.tmpdir()), null);
});

test('unknown formats fall back to a placeholder size', () => {
  assert.deepEqual(imageSize(Buffer.from('not an image'), 'png'), { width: 320, height: 200 });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isLargeExport, describeSize, DEFAULT_WARN_BYTES } = require('../src/export-limits');

test('small exports are not flagged', () => {
  assert.equal(isLargeExport(1024), false);
  assert.equal(isLargeExport(DEFAULT_WARN_BYTES), false);
});

test('exports above the threshold are flagged', () => {
  assert.equal(isLargeExport(DEFAULT_WARN_BYTES + 1), true);
  assert.equal(isLargeExport(30 * 1024 * 1024), true);
  assert.equal(isLargeExport(5000, 1000), true);
});

test('invalid sizes are ignored', () => {
  assert.equal(isLargeExport(0), false);
  assert.equal(isLargeExport(-5), false);
  assert.equal(isLargeExport('abc'), false);
  assert.equal(isLargeExport(undefined), false);
});

test('describeSize uses readable units', () => {
  assert.equal(describeSize(512), '512 B');
  assert.equal(describeSize(2048), '2 KB');
  assert.equal(describeSize(3.5 * 1024 * 1024), '3.5 MB');
});

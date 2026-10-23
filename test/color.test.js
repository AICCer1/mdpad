'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseColor, contrastRatio } = require('../src/color');

test('parses rgb and hex colors', () => {
  assert.deepEqual(parseColor('rgb(30, 33, 38)'), [30, 33, 38]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColor('#1E2126'), [30, 33, 38]);
  assert.equal(parseColor('not-a-color'), null);
});

test('black on white is the maximum ratio', () => {
  const ratio = contrastRatio('#000', '#fff');
  assert.ok(Math.abs(ratio - 21) < 0.01);
});

test('identical colors have no contrast', () => {
  assert.equal(contrastRatio('#123456', '#123456'), 1);
});

test('a known pair lands where WCAG expects it', () => {
  // #767676 on white is the classic 4.54:1 boundary case.
  const ratio = contrastRatio('#767676', '#fff');
  assert.ok(ratio > 4.5 && ratio < 4.6, `got ${ratio}`);
});

test('invalid input returns null instead of NaN', () => {
  assert.equal(contrastRatio('nope', '#fff'), null);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeExternalUrl, shouldOpenExternal } = require('../src/link-guard');

test('http and https links are allowed', () => {
  assert.equal(isSafeExternalUrl('https://example.com/a?b=1'), true);
  assert.equal(isSafeExternalUrl('http://localhost:8080'), true);
});

test('mailto is allowed but file and javascript are not', () => {
  assert.equal(isSafeExternalUrl('mailto:someone@example.com'), true);
  assert.equal(isSafeExternalUrl('file:///C:/Windows/system32/calc.exe'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('data:text/html,<script>alert(1)</script>'), false);
});

test('malformed and empty values are rejected', () => {
  assert.equal(isSafeExternalUrl(''), false);
  assert.equal(isSafeExternalUrl('   '), false);
  assert.equal(isSafeExternalUrl('not a url'), false);
  assert.equal(isSafeExternalUrl(null), false);
  assert.equal(isSafeExternalUrl(42), false);
});

test('only a modifier or middle click opens the browser', () => {
  assert.equal(shouldOpenExternal({ ctrlKey: true }), true);
  assert.equal(shouldOpenExternal({ metaKey: true }), true);
  assert.equal(shouldOpenExternal({ button: 1 }), true);
  assert.equal(shouldOpenExternal({}), false);
  assert.equal(shouldOpenExternal(null), false);
});

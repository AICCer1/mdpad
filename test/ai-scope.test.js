'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initialScope, effectiveScope, SCOPES } = require('../src/ai-scope');

test('a stored scope counts as an explicit choice', () => {
  assert.deepEqual(initialScope('paragraph'), { scope: 'paragraph', explicit: true });
  assert.deepEqual(initialScope('doc'), { scope: 'doc', explicit: true });
});

test('missing or unknown stored values fall back to the default', () => {
  assert.deepEqual(initialScope(undefined), { scope: 'doc', explicit: false });
  assert.deepEqual(initialScope('nonsense'), { scope: 'doc', explicit: false });
});

test('only the untouched default narrows on long documents', () => {
  assert.equal(effectiveScope('doc', false, 25000), 'paragraph');
  assert.equal(effectiveScope('doc', false, 20000), 'doc');
});

test('an explicit choice is never narrowed', () => {
  assert.equal(effectiveScope('doc', true, 250000), 'doc');
});

test('other scopes pass through unchanged', () => {
  for (const scope of SCOPES) {
    assert.equal(effectiveScope(scope, true, 999999), scope);
  }
});

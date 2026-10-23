'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeDirty, displayName } = require('../src/dirty');

test('lists file names for the close guard', () => {
  const summary = summarizeDirty([{ file: 'C:\\docs\\a.md' }, { file: 'C:\\docs\\b.md' }]);
  assert.equal(summary.count, 2);
  assert.equal(summary.detail, 'a.md, b.md');
});

test('untitled tabs are named Untitled', () => {
  assert.equal(displayName({ file: null }), 'Untitled');
  assert.equal(displayName(null), 'Untitled');
  assert.equal(summarizeDirty([{ file: null }]).detail, 'Untitled');
});

test('truncates long lists with a remainder count', () => {
  const tabs = Array.from({ length: 8 }, (_, i) => ({ file: `f${i}.md` }));
  const summary = summarizeDirty(tabs, 5);
  assert.equal(summary.count, 8);
  assert.match(summary.detail, /\+3 more$/);
  assert.equal(summary.names.length, 8);
});

test('handles empty input', () => {
  assert.deepEqual(summarizeDirty([]), { count: 0, names: [], detail: '' });
  assert.deepEqual(summarizeDirty(null), { count: 0, names: [], detail: '' });
});

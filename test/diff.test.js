'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffWords, diffStats } = require('../src/diff');

const text = (ops) => ops.map((op) => op.text).join('');

test('identical text is one equal run', () => {
  const ops = diffWords('hello world', 'hello world');
  assert.deepEqual(ops, [{ type: 'equal', text: 'hello world' }]);
  assert.equal(diffStats(ops).changed, false);
});

test('insertions and deletions reconstruct both sides', () => {
  const before = 'the quick brown fox';
  const after = 'the very quick red fox';
  const ops = diffWords(before, after);

  assert.equal(text(ops.filter((op) => op.type !== 'insert')), before);
  assert.equal(text(ops.filter((op) => op.type !== 'delete')), after);
  assert.ok(diffStats(ops).changed);
});

test('pure insertion', () => {
  const ops = diffWords('alpha beta', 'alpha beta gamma');
  assert.deepEqual(ops, [
    { type: 'equal', text: 'alpha beta' },
    { type: 'insert', text: ' gamma' },
  ]);
});

test('pure deletion', () => {
  const ops = diffWords('alpha beta gamma', 'alpha beta');
  assert.deepEqual(ops, [
    { type: 'equal', text: 'alpha beta' },
    { type: 'delete', text: ' gamma' },
  ]);
});

test('oversized inputs degrade to one replace pair', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
  const ops = diffWords(big, `${big} tail`);
  assert.deepEqual(ops.map((op) => op.type), ['delete', 'insert']);
});

test('whitespace is preserved through the diff', () => {
  const ops = diffWords('a  b', 'a b');
  assert.equal(text(ops.filter((op) => op.type !== 'insert')), 'a  b');
  assert.equal(text(ops.filter((op) => op.type !== 'delete')), 'a b');
});

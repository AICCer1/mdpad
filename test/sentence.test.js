'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sentenceBounds } = require('../src/sentence');

const text = 'First sentence here. Second one is longer! Third asks a question?';

test('finds the sentence around an offset', () => {
  assert.deepEqual(sentenceBounds(text, 3), { from: 0, to: 20, text: 'First sentence here.' });
  assert.deepEqual(sentenceBounds(text, 30), { from: 21, to: 42, text: 'Second one is longer!' });
  assert.deepEqual(sentenceBounds(text, text.length - 2), {
    from: 43,
    to: text.length,
    text: 'Third asks a question?',
  });
});

test('an offset inside the whitespace belongs to the sentence that follows', () => {
  const bounds = sentenceBounds(text, 21);
  assert.equal(bounds.text, 'Second one is longer!');
});

test('cjk terminators work', () => {
  const zh = '第一句话。第二句话！第三句话？';
  assert.equal(sentenceBounds(zh, 0).text, '第一句话。');
  assert.equal(sentenceBounds(zh, 5).text, '第二句话！');
  assert.equal(sentenceBounds(zh, 10).text, '第三句话？');
});

test('abbreviations and initials do not split a sentence', () => {
  const prose = 'Dr. Smith went to Washington. He liked it.';
  assert.equal(sentenceBounds(prose, 6).text, 'Dr. Smith went to Washington.');
  const initials = 'J. K. Rowling wrote books.';
  assert.equal(sentenceBounds(initials, 4).text, 'J. K. Rowling wrote books.');
});

test('closing quotes stay inside the sentence', () => {
  const quoted = 'She said "go". Then left.';
  assert.equal(sentenceBounds(quoted, 3).text, 'She said "go".');
});

test('a block without a terminator is one sentence', () => {
  assert.deepEqual(sentenceBounds('just a fragment', 4), { from: 0, to: 15, text: 'just a fragment' });
});

test('empty and out-of-range offsets are handled', () => {
  assert.equal(sentenceBounds('', 0), null);
  assert.equal(sentenceBounds('   ', 1), null);
  assert.equal(sentenceBounds('One.', 99).text, 'One.');
  assert.equal(sentenceBounds('One.', -5).text, 'One.');
});

test('decimal numbers do not split a sentence', () => {
  assert.equal(sentenceBounds('It grew 1.5 times. Then stopped.', 8).text, 'It grew 1.5 times.');
});

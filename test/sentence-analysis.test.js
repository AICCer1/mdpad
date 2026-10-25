'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSentences } = require('../src/sentence');

test('counts sentences across paragraphs', () => {
  const result = analyzeSentences('One two three. Four five!\n\nSix seven eight nine?');
  assert.equal(result.count, 3);
  assert.equal(result.avgWords, 3);
  assert.equal(result.longest.words, 4);
  assert.equal(result.longest.text, 'Six seven eight nine?');
});

test('flags sentences over the limit, longest first', () => {
  const long = 'word '.repeat(45).trim() + '.';
  const result = analyzeSentences('Short one. ' + long + ' Another short.', { limit: 40 });
  assert.equal(result.count, 3);
  assert.equal(result.long.length, 1);
  assert.equal(result.long[0].words, 45);
  assert.equal(result.limit, 40);
});

test('a fragment without punctuation still counts as one sentence', () => {
  const result = analyzeSentences('just a fragment');
  assert.equal(result.count, 1);
  assert.equal(result.avgWords, 3);
});

test('empty input yields zeroes, not NaN', () => {
  const result = analyzeSentences('   \n\n  ');
  assert.equal(result.count, 0);
  assert.equal(result.avgWords, 0);
  assert.equal(result.longest.words, 0);
  assert.deepEqual(result.long, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRepetition } = require('../src/repetition');

test('finds words repeated at least three times and ignores stop words', () => {
  const text = 'The important thing is important. Very important, and the important result.';
  const result = analyzeRepetition(text);
  const important = result.words.find((entry) => entry.word === 'important');
  assert.ok(important, 'important was not counted');
  assert.equal(important.count, 4);
  assert.equal(result.words.some((entry) => entry.word === 'the'), false);
});

test('does not report words below the minimum count', () => {
  const result = analyzeRepetition('unique words appear once here');
  assert.deepEqual(result.words, []);
});

test('detects a word repeated back to back', () => {
  const result = analyzeRepetition('This is very very good and that that works.');
  assert.deepEqual(
    result.doubled.map((entry) => entry.phrase),
    ['very very', 'that that']
  );
});

test('counts repeated three-word phrases', () => {
  const text = 'in spite of everything we tried, in spite of the noise, in spite of it all';
  const result = analyzeRepetition(text);
  const phrase = result.repeated.find((entry) => entry.phrase === 'in spite of');
  assert.ok(phrase, JSON.stringify(result.repeated));
  assert.equal(phrase.count, 3);
});

test('orders by count and caps the list', () => {
  const text = Array.from({ length: 5 }, () => 'alpha beta gamma delta epsilon').join(' ');
  const result = analyzeRepetition(text, { limit: 2 });
  assert.equal(result.words.length, 2);
  assert.equal(result.words[0].count, 5);
});

test('counts repeated Chinese bigrams', () => {
  const result = analyzeRepetition('我们需要认真考虑这个问题，认真考虑每一个细节，认真考虑后果。');
  assert.ok(result.cjkRepeated.some((entry) => entry.word === '认真'));
});

test('empty input returns empty lists', () => {
  const result = analyzeRepetition('');
  assert.deepEqual(result, { words: [], doubled: [], repeated: [], cjkRepeated: [] });
});

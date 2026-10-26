'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeStyle } = require('../src/style');

test('counts hedge words and orders them', () => {
  const result = analyzeStyle('This is very good. It is very very simple, really simple.');
  const very = result.weak.find((entry) => entry.word === 'very');
  assert.equal(very.count, 3);
  assert.equal(result.weak[0].word, 'very');
});

test('finds passive constructions with a regular participle', () => {
  const result = analyzeStyle('The report was written yesterday. The door was opened by her.');
  assert.equal(result.passiveCount, 2);
  assert.match(result.passive[0].text, /was written/);
});

test('finds passive constructions with an irregular participle and an adverb', () => {
  const result = analyzeStyle('The decision was quickly made. The letter is often forgotten.');
  assert.equal(result.passive.length, 2);
  assert.match(result.passive[0].text, /was quickly made/);
});

test('adjectives after "is" are not passive', () => {
  const result = analyzeStyle('The sky is red. She was tired.');
  assert.deepEqual(result.passive, []);
});

test('limits the number of examples', () => {
  const text = Array.from({ length: 8 }, (_, index) => 'The item ' + index + ' was created.').join(' ');
  const result = analyzeStyle(text, { limit: 3 });
  assert.equal(result.passive.length, 3);
});

test('empty text yields empty lists', () => {
  const result = analyzeStyle('');
  assert.deepEqual(result.weak, []);
  assert.deepEqual(result.passive, []);
  assert.equal(result.sentences, 0);
});

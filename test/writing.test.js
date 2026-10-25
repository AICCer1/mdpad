'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildHistory, dayKey } = require('../src/writing.js');

const today = new Date(2026, 9, 25); // 2026-10-25, local time

test('always returns 14 days ending today', () => {
  const history = buildHistory({}, 0, today);
  assert.equal(history.days.length, 14);
  assert.equal(history.days[13].date, '2026-10-25');
  assert.equal(history.days[0].date, '2026-10-12');
  assert.equal(history.streak, 0);
  assert.equal(history.total, 0);
});

test('counts a streak back from today', () => {
  const days = { '2026-10-25': 120, '2026-10-24': 150, '2026-10-23': 100 };
  const history = buildHistory(days, 100, today);
  assert.equal(history.streak, 3);
  assert.equal(history.days[13].words, 120);
  assert.equal(history.days[13].reached, true);
});

test('a missing today does not break the streak if yesterday counted', () => {
  const days = { '2026-10-24': 150, '2026-10-23': 100 };
  const history = buildHistory(days, 100, today);
  assert.equal(history.streak, 2);
});

test('a gap stops the streak', () => {
  const days = { '2026-10-25': 120, '2026-10-23': 100, '2026-10-22': 100 };
  const history = buildHistory(days, 100, today);
  assert.equal(history.streak, 1);
  assert.equal(history.best, 120);
});

test('without a goal any day with words counts', () => {
  const days = { '2026-10-25': 1, '2026-10-24': 5 };
  const history = buildHistory(days, 0, today);
  assert.equal(history.streak, 2);
  assert.equal(history.days[13].reached, true);
});

test('junk values are ignored rather than producing NaN', () => {
  const history = buildHistory({ '2026-10-25': 'nope', '2026-10-24': -5, bad: 100 }, 50, today);
  assert.equal(history.days[13].words, 0);
  assert.equal(history.days[12].words, 0);
  assert.equal(Number.isNaN(history.total), false);
});

test('dayKey uses local calendar days', () => {
  assert.equal(dayKey(new Date(2026, 0, 2, 23, 50)), '2026-01-02');
});

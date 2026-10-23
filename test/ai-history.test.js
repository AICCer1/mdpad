'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pruneTurns, MAX_TURNS } = require('../src/ai-history');

const turn = (at, text = 'x') => ({ instruction: text, result: `${text} result`, at });

test('keeps the newest turns up to the cap', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  // Stored oldest-first, like the log itself.
  const turns = Array.from({ length: 8 }, (_, i) => turn(new Date(now - (8 - i) * 1000).toISOString(), `t${i}`));
  const pruned = pruneTurns(turns, { now });
  assert.equal(pruned.length, MAX_TURNS);
  assert.equal(pruned[pruned.length - 1].instruction, 't7');
});

test('drops entries older than the age limit', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const pruned = pruneTurns(
    [turn('2026-01-01T00:00:00.000Z', 'old'), turn('2026-05-30T00:00:00.000Z', 'recent')],
    { now }
  );
  assert.deepEqual(pruned.map((t) => t.instruction), ['recent']);
});

test('keeps legacy entries without timestamps', () => {
  const pruned = pruneTurns([{ instruction: 'legacy', result: 'ok' }], { now: Date.now() });
  assert.equal(pruned.length, 1);
});

test('rejects malformed entries and non-arrays', () => {
  assert.deepEqual(pruneTurns(null), []);
  assert.deepEqual(pruneTurns([{ instruction: 1 }, null, { instruction: 'a', result: 'b' }]).length, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWithRetry, isRetryable } = require('../src/retry');

const errorWith = (code) => Object.assign(new Error(code), { code });

test('succeeds on the first try', () => {
  let calls = 0;
  const result = writeWithRetry(() => {
    calls += 1;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retries once on EBUSY and then succeeds', () => {
  let calls = 0;
  const result = writeWithRetry(() => {
    calls += 1;
    if (calls === 1) throw errorWith('EBUSY');
    return 'ok';
  }, { delayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('does not retry a non-transient error', () => {
  let calls = 0;
  assert.throws(
    () =>
      writeWithRetry(() => {
        calls += 1;
        throw errorWith('ENOSPC');
      }, { delayMs: 0 }),
    /ENOSPC/
  );
  assert.equal(calls, 1);
});

test('gives up after the retry budget', () => {
  let calls = 0;
  assert.throws(
    () =>
      writeWithRetry(() => {
        calls += 1;
        throw errorWith('EBUSY');
      }, { retries: 1, delayMs: 0 }),
    /EBUSY/
  );
  assert.equal(calls, 2);
});

test('classifies retryable codes', () => {
  assert.equal(isRetryable(errorWith('EBUSY')), true);
  assert.equal(isRetryable(errorWith('EPERM')), true);
  assert.equal(isRetryable(errorWith('ENOSPC')), false);
  assert.equal(isRetryable(null), false);
});

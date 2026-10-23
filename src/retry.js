'use strict';

// Windows antivirus/indexers can hold a file for a few milliseconds, which surfaces as
// EBUSY/EPERM on write. One short retry turns a scary save error into a non-event.

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE']);

function isRetryable(err) {
  return Boolean(err && RETRYABLE.has(err.code));
}

function writeWithRetry(writeFn, { retries = 1, delayMs = 120 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return writeFn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) throw err;
      attempt += 1;
      if (delayMs > 0) {
        const until = Date.now() + delayMs;
        while (Date.now() < until) {
          /* busy wait keeps this synchronous for the atomic path */
        }
      }
    }
  }
}

module.exports = { writeWithRetry, isRetryable, RETRYABLE };

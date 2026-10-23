'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideRestore, MAX_STARTUP_CRASHES } = require('../src/startup-guard');

test('restores normally after a clean start', () => {
  assert.deepEqual(decideRestore({ crashes: 0, hasSession: true }), { action: 'restore', reason: 'ok' });
});

test('a single crash still restores', () => {
  assert.equal(decideRestore({ crashes: 1, hasSession: true }).action, 'restore');
});

test('repeated startup crashes skip the session', () => {
  const decision = decideRestore({ crashes: MAX_STARTUP_CRASHES, hasSession: true });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'crash-loop');
});

test('no session means a fresh window regardless of crashes', () => {
  assert.equal(decideRestore({ crashes: 5, hasSession: false }).action, 'new');
});

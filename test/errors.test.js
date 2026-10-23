'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFsError, fsErrorCode } = require('../src/errors');

const err = (code, message) => Object.assign(new Error(message || code), { code });

test('permission and disk errors get their own keys', () => {
  assert.equal(classifyFsError(err('EACCES')), 'error.permission');
  assert.equal(classifyFsError(err('EPERM')), 'error.permission');
  assert.equal(classifyFsError(err('ENOSPC')), 'error.diskFull');
});

test('path problems collapse into one human message', () => {
  assert.equal(classifyFsError(err('EEXIST')), 'error.pathConflict');
  assert.equal(classifyFsError(err('ENOTDIR')), 'error.pathConflict');
  assert.equal(classifyFsError(err('ENOENT')), 'error.notFound');
  assert.equal(classifyFsError(err('EBUSY')), 'error.busy');
});

test('codes embedded in a message are recognised', () => {
  const wrapped = new Error("EEXIST: file already exists, mkdir 'C:\\tmp\\x'");
  assert.equal(classifyFsError(wrapped), 'error.pathConflict');
  assert.equal(fsErrorCode(wrapped), 'EEXIST');
});

test('unknown failures fall back to a generic key', () => {
  assert.equal(classifyFsError(new Error('something odd')), 'error.unknown');
  assert.equal(classifyFsError(null), 'error.unknown');
  assert.equal(fsErrorCode(null), null);
});

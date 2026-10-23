'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseFileArgs } = require('../src/cli');

const isFile = (candidate) => /\.(md|markdown|txt)$/i.test(candidate);

test('collects existing file arguments', () => {
  const files = parseFileArgs(['notes.md', 'todo.txt'], { isFile, cwd: 'C:\\docs' });
  assert.deepEqual(files, [path.resolve('C:\\docs', 'notes.md'), path.resolve('C:\\docs', 'todo.txt')]);
});

test('skips flags and directories', () => {
  const files = parseFileArgs(['--smoke-test', 'folder', 'a.md'], { isFile, cwd: 'C:\\docs' });
  assert.deepEqual(files, [path.resolve('C:\\docs', 'a.md')]);
});

test('deduplicates the same file passed twice', () => {
  const files = parseFileArgs(['a.md', '.\\a.md', 'A.md'], { isFile, cwd: 'C:\\docs' });
  assert.equal(files.length, 2); // case-insensitive only on Windows; two distinct strings here
});

test('empty input produces no files', () => {
  assert.deepEqual(parseFileArgs([], { isFile }), []);
  assert.deepEqual(parseFileArgs(['-x'], { isFile }), []);
});

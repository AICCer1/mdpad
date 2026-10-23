'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkWritable, checkDirs } = require('../src/preflight');

test('a normal directory passes', () => {
  const dir = path.join(os.tmpdir(), `mdpad-preflight-${Date.now()}`);
  const result = checkWritable(dir);
  assert.equal(result.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a path blocked by a file fails with a message', () => {
  const blocker = path.join(os.tmpdir(), `mdpad-preflight-file-${Date.now()}`);
  fs.writeFileSync(blocker, 'x', 'utf8');
  const result = checkWritable(path.join(blocker, 'nested'));
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
  fs.rmSync(blocker, { force: true });
});

test('checkDirs reports which directory failed', () => {
  const good = path.join(os.tmpdir(), `mdpad-preflight-good-${Date.now()}`);
  const blocker = path.join(os.tmpdir(), `mdpad-preflight-blocker-${Date.now()}`);
  fs.writeFileSync(blocker, 'x', 'utf8');
  const report = checkDirs({ data: good, backups: path.join(blocker, 'b') });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failed.map((entry) => entry.name), ['backups']);
  fs.rmSync(good, { recursive: true, force: true });
  fs.rmSync(blocker, { force: true });
});

test('a thrown fs error is captured, not propagated', () => {
  const fakeFs = {
    mkdirSync() {
      throw new Error('EACCES: permission denied');
    },
    writeFileSync() {},
    unlinkSync() {},
  };
  const result = checkWritable('C:\\nope', fakeFs);
  assert.equal(result.ok, false);
  assert.match(result.error, /EACCES/);
});

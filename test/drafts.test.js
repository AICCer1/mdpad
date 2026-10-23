'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listDrafts, selectStaleDrafts } = require('../src/drafts');

function writeDraft(dir, name, payload) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(payload), 'utf8');
}

test('lists readable drafts newest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-drafts-'));
  writeDraft(dir, 'a.json', { file: 'C:\\docs\\a.md', contents: 'aaa', updatedAt: '2026-01-01T10:00:00.000Z' });
  writeDraft(dir, 'b.json', { file: 'C:\\docs\\b.md', contents: 'bbbb', updatedAt: '2026-02-01T10:00:00.000Z' });
  const drafts = listDrafts(dir);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].name, 'b.md');
  assert.equal(drafts[0].bytes, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skips corrupt files and keeps going', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-drafts-'));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json', 'utf8');
  writeDraft(dir, 'ok.json', { file: null, contents: 'draft', updatedAt: '2026-03-01T00:00:00.000Z' });
  const drafts = listDrafts(dir);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].name, 'Untitled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing directory yields an empty list', () => {
  assert.deepEqual(listDrafts(path.join(os.tmpdir(), 'mdpad-no-such-dir-xyz')), []);
});

test('stale drafts are those older than the cutoff', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const drafts = [
    { updatedAt: '2026-05-31T00:00:00.000Z' },
    { updatedAt: '2026-04-01T00:00:00.000Z' },
    { updatedAt: 'not-a-date' },
    { updatedAt: null },
  ];
  const stale = selectStaleDrafts(drafts, { now, olderThanDays: 30 });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].updatedAt, '2026-04-01T00:00:00.000Z');
});

test('an invalid window selects nothing', () => {
  const drafts = [{ updatedAt: '2020-01-01T00:00:00.000Z' }];
  assert.deepEqual(selectStaleDrafts(drafts, { now: Date.now(), olderThanDays: Number.NaN }), []);
  assert.deepEqual(selectStaleDrafts(null, { now: Date.now(), olderThanDays: 10 }), []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const storage = require('../src/storage');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    doc: path.join(dir, 'note.md'),
    backups: path.join(dir, 'backups'),
    drafts: path.join(dir, 'draftsRecover'),
  };
}

test('atomicWrite creates and replaces a file', (t) => {
  const w = workspace(t);
  storage.atomicWrite(w.doc, 'one');
  assert.equal(fs.readFileSync(w.doc, 'utf8'), 'one');
  storage.atomicWrite(w.doc, 'two');
  assert.equal(fs.readFileSync(w.doc, 'utf8'), 'two');
  const leftovers = fs.readdirSync(w.dir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('first save needs no backup, unchanged save is a no-op', (t) => {
  const w = workspace(t);
  const first = storage.saveDocument(w.doc, 'v1', { backupsDir: w.backups });
  assert.equal(first.changed, true);
  assert.equal(first.backup, null);
  assert.equal(fs.existsSync(w.backups), false);

  const again = storage.saveDocument(w.doc, 'v1', { backupsDir: w.backups });
  assert.equal(again.changed, false);
  assert.equal(again.backup, null);
});

test('a changed save backs up the previous version', (t) => {
  const w = workspace(t);
  storage.saveDocument(w.doc, 'v1', { backupsDir: w.backups });
  const second = storage.saveDocument(w.doc, 'v2', { backupsDir: w.backups });
  assert.equal(second.changed, true);
  assert.ok(second.backup && fs.existsSync(second.backup));
  assert.equal(fs.readFileSync(second.backup, 'utf8'), 'v1');
  assert.equal(fs.readFileSync(w.doc, 'utf8'), 'v2');
});

test('backup rotation keeps only the newest N', (t) => {
  const w = workspace(t);
  storage.saveDocument(w.doc, 'v0', { backupsDir: w.backups });
  for (let i = 1; i <= 6; i += 1) {
    storage.saveDocument(w.doc, `v${i}`, { backupsDir: w.backups, keep: 2 });
  }
  const kept = storage.listBackups(w.doc, w.backups);
  assert.equal(kept.length, 2);
  const bodies = kept.map((b) => fs.readFileSync(b.path, 'utf8')).sort();
  assert.deepEqual(bodies, ['v4', 'v5']);
});

test('backups taken in the same second get distinct names', (t) => {
  const w = workspace(t);
  storage.saveDocument(w.doc, 'a', { backupsDir: w.backups });
  const when = new Date('2026-01-01T00:00:00Z');
  const b1 = storage.backupFile(w.doc, w.backups, { now: when });
  const b2 = storage.backupFile(w.doc, w.backups, { now: when });
  assert.notEqual(b1, b2);
  assert.equal(fs.existsSync(b1) && fs.existsSync(b2), true);
});

test('draft round-trip and recovery decision', (t) => {
  const w = workspace(t);
  const written = storage.writeDraft(w.doc, 'unsaved', w.drafts);
  assert.ok(fs.existsSync(written));

  const draft = storage.readDraft(w.doc, w.drafts);
  assert.equal(draft.contents, 'unsaved');
  assert.equal(draft.file, w.doc);

  assert.equal(storage.hasRecoverableDraft(w.doc, 'on-disk', w.drafts).contents, 'unsaved');
  assert.equal(storage.hasRecoverableDraft(w.doc, 'unsaved', w.drafts), null);

  storage.clearDraft(w.doc, w.drafts);
  assert.equal(storage.readDraft(w.doc, w.drafts), null);
  assert.equal(storage.clearDraft(w.doc, w.drafts), false);
});

test('untitled buffer gets its own draft slot', (t) => {
  const w = workspace(t);
  storage.writeDraft(null, 'scratch', w.drafts);
  const draft = storage.readDraft(null, w.drafts);
  assert.equal(draft.contents, 'scratch');
  assert.equal(draft.file, null);
});

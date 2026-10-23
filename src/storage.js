'use strict';

// Storage layer: atomic writes, backup rotation, crash drafts.
// Pure Node — no Electron imports — so it can be unit-tested directly.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeWithRetry } = require('./retry');

const DEFAULT_BACKUP_KEEP = 20;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function stamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

// Write to a sibling temp file, fsync, then rename over the target. A crash can
// lose the newest bytes but never corrupts the previous version.
function atomicWrite(file, contents) {
  ensureDir(path.dirname(file));
  return writeWithRetry(() => atomicWriteOnce(file, contents));
}

function atomicWriteOnce(file, contents) {
  ensureDir(path.dirname(file));
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not exist */
    }
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows refuses the rename when the target is held open; fall back.
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
  return file;
}

function backupBasename(file) {
  const ext = path.extname(file);
  return `${path.basename(file, ext).replace(/[^\w.-]+/g, '_')}${ext}`;
}

function listBackups(file, backupsDir) {
  if (!fs.existsSync(backupsDir)) return [];
  const prefix = path.basename(backupBasename(file), path.extname(file)) + '.';
  return fs
    .readdirSync(backupsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(path.extname(file)))
    .map((name) => {
      const full = path.join(backupsDir, name);
      const stat = fs.statSync(full);
      return { name, path: full, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
}

function pruneBackups(file, backupsDir, keep = DEFAULT_BACKUP_KEEP) {
  const all = listBackups(file, backupsDir);
  const removed = [];
  for (const entry of all.slice(keep)) {
    fs.unlinkSync(entry.path);
    removed.push(entry.name);
  }
  return removed;
}

function backupFile(file, backupsDir, { keep = DEFAULT_BACKUP_KEEP, now = new Date() } = {}) {
  if (!fs.existsSync(file)) return null;
  ensureDir(backupsDir);
  const ext = path.extname(file);
  const base = path.basename(backupBasename(file), ext);
  let name = `${base}.${stamp(now)}${ext}`;
  let n = 1;
  while (fs.existsSync(path.join(backupsDir, name))) {
    name = `${base}.${stamp(now)}-${n}${ext}`;
    n += 1;
  }
  const target = path.join(backupsDir, name);
  fs.copyFileSync(file, target);
  pruneBackups(file, backupsDir, keep);
  return target;
}

// Save = back up the previous version (only when it differs), then write.
function saveDocument(file, contents, { backupsDir, keep = DEFAULT_BACKUP_KEEP } = {}) {
  const previous = readIfExists(file);
  if (previous === contents) {
    return { changed: false, backup: null };
  }
  const backup = previous !== null && backupsDir ? backupFile(file, backupsDir, { keep }) : null;
  atomicWrite(file, contents);
  return { changed: true, backup };
}

// ---- crash drafts -----------------------------------------------------------

function draftId(file) {
  return crypto.createHash('sha1').update(file || 'untitled').digest('hex').slice(0, 16);
}

function draftPath(file, draftsDir) {
  return path.join(draftsDir, `${draftId(file)}.json`);
}

function writeDraft(file, contents, draftsDir, { now = new Date() } = {}) {
  ensureDir(draftsDir);
  const payload = { file: file || null, contents, updatedAt: now.toISOString() };
  const target = draftPath(file, draftsDir);
  atomicWrite(target, JSON.stringify(payload));
  return target;
}

function readDraft(file, draftsDir) {
  const raw = readIfExists(draftPath(file, draftsDir));
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearDraft(file, draftsDir) {
  try {
    fs.unlinkSync(draftPath(file, draftsDir));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// A draft is worth recovering when it is newer than the file on disk.
function hasRecoverableDraft(file, contents, draftsDir) {
  const draft = readDraft(file, draftsDir);
  if (!draft || typeof draft.contents !== 'string') return null;
  if (draft.contents === contents) return null;
  return draft;
}

module.exports = {
  DEFAULT_BACKUP_KEEP,
  atomicWrite,
  readIfExists,
  listBackups,
  pruneBackups,
  backupFile,
  saveDocument,
  draftId,
  draftPath,
  writeDraft,
  readDraft,
  clearDraft,
  hasRecoverableDraft,
};

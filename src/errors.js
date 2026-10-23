'use strict';

// Maps filesystem errno codes to dictionary keys so the UI can explain a failure
// instead of showing a raw Node error.

const FS_ERROR_KEYS = {
  EACCES: 'error.permission',
  EPERM: 'error.permission',
  ENOSPC: 'error.diskFull',
  EDQUOT: 'error.diskFull',
  ENOENT: 'error.notFound',
  EISDIR: 'error.pathConflict',
  ENOTDIR: 'error.pathConflict',
  EEXIST: 'error.pathConflict',
  EBUSY: 'error.busy',
  ETXTBSY: 'error.busy',
  ENAMETOOLONG: 'error.pathTooLong',
};

function classifyFsError(err) {
  const raw = err && err.message ? String(err.message) : String(err || '');
  const direct = err && err.code && FS_ERROR_KEYS[err.code];
  if (direct) return direct;
  const match = raw.match(/\b(E[A-Z]{2,})\b/);
  if (match && FS_ERROR_KEYS[match[1]]) return FS_ERROR_KEYS[match[1]];
  return 'error.unknown';
}

function fsErrorCode(err) {
  if (err && err.code) return String(err.code);
  const match = String((err && err.message) || '').match(/\b(E[A-Z]{2,})\b/);
  return match ? match[1] : null;
}

module.exports = { classifyFsError, fsErrorCode, FS_ERROR_KEYS };

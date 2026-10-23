'use strict';

// Startup preflight: the app cannot work without a writable data directory, and a
// read-only profile should be reported clearly instead of failing on the first save.

const fs = require('node:fs');
const path = require('node:path');

function checkWritable(dir, fsImpl = fs) {
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.mdpad-probe-${process.pid}`);
    fsImpl.writeFileSync(probe, 'ok', 'utf8');
    fsImpl.unlinkSync(probe);
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, dir, error: err && err.message ? err.message : String(err) };
  }
}

function checkDirs(dirs, fsImpl = fs) {
  const results = Object.entries(dirs).map(([name, dir]) => ({ name, ...checkWritable(dir, fsImpl) }));
  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, results, failed };
}

module.exports = { checkWritable, checkDirs };

'use strict';

// Command-line file arguments: `mdpad notes.md todo.md` opens both as tabs.
// Kept pure so the parsing rules are testable without Electron.

const path = require('node:path');

function parseFileArgs(argv, { isFile = () => false, cwd = process.cwd() } = {}) {
  const seen = new Set();
  const files = [];
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue;
    const resolved = path.resolve(cwd, arg);
    if (seen.has(resolved)) continue;
    if (!isFile(resolved)) continue;
    seen.add(resolved);
    files.push(resolved);
  }
  return files;
}

module.exports = { parseFileArgs };

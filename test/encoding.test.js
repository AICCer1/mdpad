'use strict';

// Guard against the UTF-8 damage that Windows PowerShell writes when it reads a
// UTF-8 file as ANSI and saves it back (em dash, arrows, multiplication sign).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Built from escapes so this file itself never contains the characters it looks for:
// U+9225/U+922B/U+8133/U+951F are what UTF-8 bytes become when read as GBK.
const MOJIBAKE = new RegExp('[\\u9225\\u922B\\u8133\\u951F\\uFFFD]');

for (const file of ['README.md', 'CHANGELOG.md']) {
  test(`${file} has no mojibake`, () => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, MOJIBAKE);
  });
}

test('source files have no mojibake', () => {
  const dirs = ['src', 'scripts', 'test'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'vendor', 'dist'].includes(entry.name)) walk(full);
      } else if (/\.(js|json|md|css|html)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (MOJIBAKE.test(text)) offenders.push(path.relative(root, full));
      }
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  assert.deepEqual(offenders, []);
});

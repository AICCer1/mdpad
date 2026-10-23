'use strict';

// Keeps the shortcut table and the menu accelerators from drifting apart: a duplicate
// accelerator silently shadows one action, and a malformed row teaches the wrong keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

const accelerators = [...main.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1]);

test('no two menu items share an accelerator', () => {
  const seen = new Map();
  for (const accel of accelerators) {
    const key = accel.replace(/CmdOrCtrl/g, 'Ctrl').toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, []);
});

test('every documented shortcut is well formed', () => {
  const rows = [...html.matchAll(/<tr><td>([^<]+)<\/td><td data-i18n="sc\.([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(rows.length >= 9);
  for (const row of rows) {
    for (const part of row.split('/').map((p) => p.trim())) {
      assert.match(part, /^(Ctrl|Alt|Shift|F\d+(?:\+.*)?|↑|↓)/, `bad shortcut "${part}" in "${row}"`);
    }
  }
});

test('the table covers the newer accelerators', () => {
  for (const key of ['Ctrl+Shift+K', 'Ctrl+Shift+V', 'Ctrl+Shift+T', 'Ctrl+W']) {
    assert.ok(html.includes(key), `${key} missing from the shortcut table`);
  }
});

test('documented menu shortcuts exist in the menu', () => {
  const menuKeys = new Set(accelerators.map((a) => a.replace(/CmdOrCtrl/g, 'Ctrl').toLowerCase()));
  for (const key of ['Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+O', 'Ctrl+F']) {
    assert.ok(menuKeys.has(key.toLowerCase()), `${key} not found among menu accelerators`);
  }
});

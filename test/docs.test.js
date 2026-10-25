'use strict';

// Guards against the `String.replace` trap that duplicated the user guide: `$` in a
// replacement string expands ($&, $', $`), which silently copies parts of the document.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const MOJIBAKE = new RegExp('[\\u9225\\u922B\\u8133\\u951F\\uFFFD]');

for (const file of ['docs/USER_GUIDE.md', 'docs/DEVELOPING.md']) {
  test(`${file} has unique section headings`, () => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const headings = text.split('\n').filter((line) => line.startsWith('## '));
    assert.ok(headings.length > 0, 'no section headings found');
    assert.equal(new Set(headings).size, headings.length, `duplicate heading in ${file}`);
  });

  test(`${file} has a single title and no duplicated body`, () => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const title = text.split('\n')[0];
    const occurrences = text.split(title).length - 1;
    assert.equal(occurrences, 1, `title repeated in ${file}`);
    assert.doesNotMatch(text, MOJIBAKE);
  });
}

test('the user guide keeps its math row intact', () => {
  const text = fs.readFileSync(path.join(root, 'docs', 'USER_GUIDE.md'), 'utf8');
  assert.match(text, /\| Math \| toolbar `\$x\$` \/ `\$\$`/);
});

test('no file in docs has an unrendered escape artifact', () => {
  const dir = path.join(root, 'docs');
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(text, /\\n- \*\*/, `${name} contains a literal \\n bullet`);
  }
});

test('README claims the real number of smoke checks', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const steps = (main.match(/^\s+step\(/gm) || []).length;
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const claimed = /(\d+) end-to-end checks/.exec(readme);
  assert.ok(claimed, 'README does not state a smoke-check count');
  assert.equal(Number(claimed[1]), steps, 'README smoke count differs from the runner');
});

test('the changelog has an entry for the current version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes('## ' + pkg.version), 'no changelog entry for ' + pkg.version);
});

test('the 2.0 notes exist and name the 2.0.0 installer', () => {
  const notes = fs.readFileSync(path.join(root, 'docs', 'RELEASE_NOTES-2.0.md'), 'utf8');
  assert.match(notes, /^# mdpad 2\.0/m);
  assert.ok(notes.includes('mdpad Setup 2.0.0.exe'), 'notes do not name the 2.0.0 installer');
});

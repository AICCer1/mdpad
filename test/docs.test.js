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

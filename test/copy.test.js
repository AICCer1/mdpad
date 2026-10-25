'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadDictionaries, audit, placeholders } = require('../scripts/copy-audit.js');

const dict = loadDictionaries();

test('both dictionaries define the same keys', () => {
  const en = Object.keys(dict.en).sort();
  const zh = Object.keys(dict.zh).sort();
  assert.deepEqual(zh, en);
});

test('no copy problems: placeholders, whitespace, ellipsis, casing, mixing', () => {
  const problems = audit(dict);
  assert.deepEqual(
    problems,
    [],
    problems.map((problem) => `${problem.kind} ${problem.key}: ${problem.detail}`).join('\n')
  );
});

test('placeholders are extracted in order', () => {
  assert.deepEqual(placeholders('{count} of {total}'), ['count', 'total']);
  assert.deepEqual(placeholders('no placeholders'), []);
});

test('the audit actually catches broken copy', () => {
  const broken = {
    en: { 'a.key': 'Save...', 'b.key': 'Count {n}' },
    zh: { 'a.key': '保存…', 'b.key': '共 {m} 个' },
  };
  const problems = audit(broken);
  const kinds = problems.map((problem) => problem.kind);
  assert.ok(kinds.includes('ellipsis'));
  assert.ok(kinds.includes('placeholder-mismatch'));
});

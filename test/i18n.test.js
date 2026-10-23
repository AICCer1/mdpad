'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { t, normalizeLang, LANGS, DICT } = require('../src/i18n');

test('normalizeLang maps locales to supported languages', () => {
  assert.equal(normalizeLang('zh-CN'), 'zh');
  assert.equal(normalizeLang('zh-TW'), 'zh');
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang('fr-FR'), 'en');
  assert.equal(normalizeLang(undefined), 'en');
});

test('t translates and falls back to English', () => {
  assert.equal(t('menu.file', 'en'), 'File');
  assert.equal(t('menu.file', 'zh'), '文件');
  assert.equal(t('menu.file', 'fr'), 'File');
  assert.equal(t('missing.key', 'zh'), 'missing.key');
});

test('t interpolates variables', () => {
  assert.equal(t('dialog.unsavedMessage', 'en', { count: 3 }), '3 document(s) with unsaved changes');
  assert.match(t('dialog.unsavedMessage', 'zh', { count: 2 }), /2/);
  assert.match(t('dialog.aboutDetail', 'en', { electron: '1', chromium: '2', node: '3', data: 'x' }), /Electron 1/);
});

test('every language covers the same keys', () => {
  const base = Object.keys(DICT.en).sort();
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(DICT[lang]).sort(), base, `${lang} keys differ`);
  }
});

test('no dictionary value is empty', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(DICT[lang])) {
      assert.ok(String(value).trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

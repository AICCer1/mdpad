'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExportName, sanitizeName, formatDate } = require('../src/filename');

const now = new Date(2026, 9, 22, 14, 5); // 2026-10-22 14:05

test('substitutes title, date and time', () => {
  assert.equal(buildExportName('{title}-{date}', { title: 'notes', now }), 'notes-2026-10-22');
  assert.equal(buildExportName('{title}-{time}', { title: 'notes', now }), 'notes-14-05');
  assert.equal(buildExportName('{title}', { title: 'notes', now }), 'notes');
});

test('an empty or missing template falls back to the title', () => {
  assert.equal(buildExportName('', { title: 'draft', now }), 'draft');
  assert.equal(buildExportName(undefined, { title: 'draft', now }), 'draft');
});

test('invalid filename characters are replaced', () => {
  assert.equal(buildExportName('{title}', { title: 'a/b:c*d?', now }), 'a-b-c-d-');
  assert.equal(sanitizeName('  '), 'Untitled');
  assert.equal(sanitizeName('..hidden'), 'hidden');
});

test('dates are zero padded', () => {
  assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05');
});

test('unknown placeholders are left alone', () => {
  assert.equal(buildExportName('{title}-{unknown}', { title: 'x', now }), 'x-{unknown}');
});

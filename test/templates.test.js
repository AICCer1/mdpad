'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listTemplates, fillTemplate, TEMPLATES } = require('../src/templates');

test('every template has an id, a name in both languages and a body', () => {
  for (const template of TEMPLATES) {
    assert.ok(template.id, 'missing id');
    assert.ok(template.name.en, template.id + ' has no English name');
    assert.ok(template.name.zh, template.id + ' has no Chinese name');
    assert.equal(typeof template.body, 'string');
  }
});

test('ids are unique and blank is first', () => {
  const ids = TEMPLATES.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'blank');
});

test('the list localises names without leaking the body', () => {
  const zh = listTemplates('zh');
  assert.equal(zh.length, TEMPLATES.length);
  assert.ok(zh.every((entry) => !('body' in entry)));
  assert.equal(zh.find((entry) => entry.id === 'weekly').name, '周报');
});

test('filling a template substitutes the date', () => {
  const filled = fillTemplate('weekly', { date: '2026-10-26' });
  assert.match(filled.body, /^# Weekly report — 2026-10-26/m);
  assert.doesNotMatch(filled.body, /\{date\}/);
});

test('an unknown id falls back to blank', () => {
  const filled = fillTemplate('nope');
  assert.equal(filled.id, 'blank');
  assert.equal(filled.body, '');
});

test('structured templates keep their headings', () => {
  assert.match(fillTemplate('meeting').body, /## Actions/);
  assert.match(fillTemplate('longform').body, /## What could go wrong/);
});

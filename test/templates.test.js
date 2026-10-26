'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listTemplates, fillTemplate, applyVariables, TEMPLATES } = require('../src/templates');

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

test('fills the title and time variables', () => {
  const filled = fillTemplate('longform', { title: 'Q4 plan', date: '2026-10-26', time: '09:30' });
  assert.match(filled.body, /^# Q4 plan$/m);
  assert.doesNotMatch(filled.body, /\{title\}/);
});

test('reports where the cursor placeholder was and removes it', () => {
  const template = TEMPLATES.find((entry) => entry.id === 'meeting');
  const body = '# Notes\n\n- {cursor}\n';
  const withCursor = { ...template, id: 'unit-cursor', body };
  TEMPLATES.push(withCursor);
  const filled = fillTemplate('unit-cursor', {});
  assert.equal(filled.body, '# Notes\n\n- \n');
  assert.equal(filled.cursor, '# Notes\n\n- '.length);
  TEMPLATES.pop();
});

test('an unknown placeholder is left alone', () => {
  const template = TEMPLATES.find((entry) => entry.id === 'weekly');
  const original = template.body;
  template.body = original + '\n{project}\n';
  const filled = fillTemplate('weekly', { date: '2026-10-26' });
  assert.match(filled.body, /\{project\}/);
  template.body = original;
});

test('applyVariables serves custom templates too', () => {
  const filled = applyVariables('# {title} {date} {time}\n- {cursor}\n{keep}', {
    title: 'Notes', date: '2026-10-26', time: '09:30',
  });
  assert.equal(filled.body, '# Notes 2026-10-26 09:30\n- \n{keep}');
  assert.equal(filled.cursor, '# Notes 2026-10-26 09:30\n- '.length);
});

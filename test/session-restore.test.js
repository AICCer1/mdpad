'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planRestore, MAX_WINDOWS, MAX_TABS_PER_WINDOW } = require('../src/session-restore');

const snapshot = (windows) => ({ version: 2, windows });

test('restores several windows', () => {
  const plans = planRestore(
    snapshot([
      { tabs: [{ file: 'a.md' }], activeId: 'a.md' },
      { tabs: [{ file: 'b.md' }] },
    ])
  );
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0].tabs, [{ file: 'a.md', contents: null }]);
  assert.equal(plans[0].activeId, 'a.md');
});

test('drops windows whose files are gone', () => {
  const plans = planRestore(snapshot([{ tabs: [{ file: 'gone.md' }] }, { tabs: [{ file: 'here.md' }] }]), {
    exists: (file) => file === 'here.md',
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].tabs[0].file, 'here.md');
});

test('caps tabs and untitled buffers per window', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ file: `f${i}.md` }));
  const untitled = Array.from({ length: 9 }, (_, i) => ({ contents: `draft ${i}` }));
  const plans = planRestore(snapshot([{ tabs: [...many, ...untitled] }]));
  assert.equal(plans[0].tabs.length, MAX_TABS_PER_WINDOW);
  const untitledKept = plans[0].tabs.filter((tab) => !tab.file).length;
  assert.ok(untitledKept <= 5, `kept ${untitledKept} untitled tabs`);
});

test('drops oversized untitled buffers', () => {
  const plans = planRestore(snapshot([{ tabs: [{ contents: 'x'.repeat(300000) }, { contents: 'small' }] }]));
  assert.equal(plans[0].tabs.length, 1);
  assert.equal(plans[0].tabs[0].contents, 'small');
});

test('caps the number of windows', () => {
  const windows = Array.from({ length: 8 }, (_, i) => ({ tabs: [{ file: `w${i}.md` }] }));
  const plans = planRestore(snapshot(windows));
  assert.equal(plans.length, MAX_WINDOWS);
});

test('empty or malformed snapshots produce no plans', () => {
  assert.deepEqual(planRestore(null), []);
  assert.deepEqual(planRestore({}), []);
  assert.deepEqual(planRestore(snapshot([{ tabs: [] }])), []);
  assert.deepEqual(planRestore(snapshot([null, { tabs: [] }])), []);
});

test('reports how many tabs were dropped', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ file: `f${i}.md` }));
  const plans = planRestore(snapshot([{ tabs: many }]));
  assert.equal(plans[0].tabs.length, MAX_TABS_PER_WINDOW);
  assert.equal(plans[0].dropped, 5);
});

test('missing files count as dropped', () => {
  const plans = planRestore(snapshot([{ tabs: [{ file: 'gone.md' }, { file: 'here.md' }] }]), {
    exists: (file) => file === 'here.md',
  });
  assert.equal(plans[0].dropped, 1);
  assert.equal(plans[0].tabs.length, 1);
});

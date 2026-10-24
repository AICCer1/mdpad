'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseReport, csvRow, readHistory, renderTable, appendRow, formatDelta } = require('../scripts/perf-trend.js');

const sample = {
  app: '1.59.0',
  at: '2026-10-25T01:30:00.000Z',
  perKeyMs: 4.8,
  typeMs: 30,
  outlineMs: 6,
  findMs: 12,
  undoMs: 9,
  heapMb: 88,
  nodeCount: 6400,
  pdfMs: 1900,
  pdfBytes: 300000,
  htmlMs: 120,
  htmlBytes: 40000,
};

test('parses the PERF_REPORT line out of noisy output', () => {
  const output = ['warn something', 'PERF_REPORT ' + JSON.stringify(sample), 'done'].join('\n');
  const report = parseReport(output);
  assert.equal(report.perKeyMs, 4.8);
  assert.equal(report.app, '1.59.0');

  assert.throws(() => parseReport('nothing here'), /PERF_REPORT/);
});

test('writes a stable csv row in column order', () => {
  const row = csvRow(sample);
  const cells = row.split(',');
  assert.equal(cells.length, 13);
  assert.equal(cells[1], '1.59.0');
  assert.equal(cells[2], '4.8');
  assert.match(cells[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('quotes values that contain separators', () => {
  const row = csvRow({ ...sample, app: 'beta, build "x"' });
  assert.ok(row.includes('"beta, build ""x"""'));
});

test('reads back what was appended and reports a delta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-trend-'));
  const file = path.join(dir, 'history.csv');
  appendRow(sample, file);
  appendRow({ ...sample, perKeyMs: 5.4 }, file);

  const rows = readHistory(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].perKeyMs, '4.8');
  assert.equal(rows[1].perKeyMs, '5.4');
  assert.equal(formatDelta('5.4', '4.8'), '+0.6');
  assert.equal(formatDelta('4.8', '4.8'), '  =');

  const table = renderTable(rows);
  assert.match(table, /version/);
  assert.match(table, /\+0\.6/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty history says so instead of throwing', () => {
  assert.equal(readHistory(path.join(os.tmpdir(), 'definitely-missing-perf.csv')).length, 0);
  assert.match(renderTable([]), /no measurements yet/);
});

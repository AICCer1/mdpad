'use strict';

// Runs the packaged app in performance-report mode and appends the numbers to a CSV, so regressions
// show up as a trend instead of a single measurement someone has to remember.
//
//   node scripts/perf-trend.js            measure and append
//   node scripts/perf-trend.js --show     print the recorded history only

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const historyFile = path.join(root, 'docs', 'perf-history.csv');

const COLUMNS = [
  'date',
  'version',
  'perKeyMs',
  'typeMs',
  'outlineMs',
  'findMs',
  'undoMs',
  'heapMb',
  'nodeCount',
  'pdfMs',
  'pdfBytes',
  'htmlMs',
  'htmlBytes',
];

function parseReport(output) {
  const line = String(output || '')
    .split(/\r?\n/)
    .reverse()
    .find((row) => row.startsWith('PERF_REPORT '));
  if (!line) throw new Error('no PERF_REPORT line in the output');
  return JSON.parse(line.slice('PERF_REPORT '.length));
}

function localStamp(iso) {
  const date = iso ? new Date(iso) : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) +
    ':' + pad(date.getMinutes()) +
    ':' + pad(date.getSeconds())
  );
}

function csvRow(report) {
  const values = {
    date: localStamp(report.at),
    version: report.app || '',
    perKeyMs: report.perKeyMs ?? '',
    typeMs: report.typeMs ?? '',
    outlineMs: report.outlineMs ?? '',
    findMs: report.findMs ?? '',
    undoMs: report.undoMs ?? '',
    heapMb: report.heapMb ?? '',
    nodeCount: report.nodeCount ?? '',
    pdfMs: report.pdfMs ?? '',
    pdfBytes: report.pdfBytes ?? '',
    htmlMs: report.htmlMs ?? '',
    htmlBytes: report.htmlBytes ?? '',
  };
  return COLUMNS.map((key) => {
    const text = String(values[key]);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',');
}

function readHistory(file = historyFile) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index];
    });
    return row;
  });
}

function formatDelta(current, previous) {
  if (previous === undefined || previous === '' || current === undefined || current === '') return '';
  const diff = Number(current) - Number(previous);
  if (!Number.isFinite(diff) || diff === 0) return '  =';
  const sign = diff > 0 ? '+' : '';
  return `${sign}${Math.round(diff * 100) / 100}`;
}

function renderTable(rows) {
  if (!rows.length) return 'no measurements yet — run node scripts/perf-trend.js';
  const lines = [];
  lines.push(
    ['version', 'date', 'ms/key', 'type', 'outline', 'find', 'undo', 'heap', 'pdf', 'html', 'Δ key'].join('  ')
  );
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = index > 0 ? rows[index - 1] : null;
    lines.push(
      [
        row.version,
        row.date.slice(0, 16),
        row.perKeyMs,
        row.typeMs,
        row.outlineMs,
        row.findMs,
        row.undoMs,
        row.heapMb + ' MB',
        row.pdfMs + ' ms',
        row.htmlMs + ' ms',
        previous ? formatDelta(row.perKeyMs, previous.perKeyMs) : '',
      ].join('  ')
    );
  }
  return lines.join('\n');
}

function electronBinary() {
  const candidates = [
    path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(root, 'node_modules', '.bin', 'electron.cmd'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'electron';
}

function measure() {
  const binary = electronBinary();
  const result = spawnSync(binary, ['.', '--perf-report'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`perf run exited with ${result.status}\n${(result.stderr || '').slice(-800)}`);
  }
  return parseReport(result.stdout);
}

function appendRow(report, file = historyFile) {
  const row = csvRow(report);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, COLUMNS.join(',') + '\n', 'utf8');
  }
  fs.appendFileSync(file, row + '\n', 'utf8');
  return row;
}

if (require.main === module) {
  const showOnly = process.argv.includes('--show');
  let written = null;
  if (!showOnly) {
    const report = measure();
    written = appendRow(report);
    console.log('recorded: ' + written);
  }
  const rows = readHistory();
  console.log('');
  console.log(renderTable(rows.slice(-6)));
  console.log('');
  console.log('history: ' + path.relative(root, historyFile));
}

module.exports = { parseReport, csvRow, readHistory, renderTable, appendRow, formatDelta, COLUMNS };

'use strict';

// Measures how long a large document takes to open, split into read / IPC / renderer phases.
//
//   node scripts/perf-open.js                 generate a ~2 MB document and measure
//   node scripts/perf-open.js --kb 4096       use a 4 MB document
//   node scripts/perf-open.js --file some.md  measure an existing file

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const historyFile = path.join(root, 'docs', 'perf-open.csv');

function generate(targetKb) {
  const file = path.join(os.tmpdir(), `mdpad-perf-open-${targetKb}.md`);
  const chunks = ['# Large document\n\n'];
  let size = chunks[0].length;
  let section = 0;
  while (size < targetKb * 1024) {
    section += 1;
    const words = 'A paragraph with **bold**, *italic* and `code` that keeps going long enough to wrap. '.repeat(3);
    const block = `## Section ${section}\n\n${words}\n\n- one\n- two\n- three\n\n`;
    chunks.push(block);
    size += block.length;
  }
  fs.writeFileSync(file, chunks.join(''), 'utf8');
  return file;
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

function measure(file) {
  const result = spawnSync(electronBinary(), ['.', '--perf-open'], {
    cwd: root,
    env: { ...process.env, MDPAD_PERF_OPEN: file },
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .reverse()
    .find((row) => row.startsWith('PERF_OPEN '));
  if (!line) throw new Error('no PERF_OPEN line\n' + (result.stdout || '').slice(-800) + (result.stderr || '').slice(-800));
  return JSON.parse(line.slice('PERF_OPEN '.length));
}

function appendRow(report) {
  const exists = fs.existsSync(historyFile);
  if (!exists) {
    fs.writeFileSync(
      historyFile,
      'date,version,bytes,lines,readMs,ipcMs,renderMs,totalMs,nodes\n',
      'utf8'
    );
  }
  const date = (() => {
    const d = new Date(report.at || Date.now());
    const pad = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  })();
  const row = [
    date,
    report.app || '',
    report.bytes,
    report.lines,
    report.readMs,
    report.ipcMs,
    report.renderMs ?? '',
    report.totalMs,
    report.nodes ?? '',
  ].join(',');
  fs.appendFileSync(historyFile, row + '\n', 'utf8');
  return row;
}

function main() {
  const fileArg = process.argv.indexOf('--file');
  const kbArg = process.argv.indexOf('--kb');
  const file = fileArg >= 0 ? process.argv[fileArg + 1] : generate(Number(kbArg >= 0 ? process.argv[kbArg + 1] : 2048));
  const report = measure(file);
  appendRow(report);
  const mb = (report.bytes / 1024 / 1024).toFixed(2);
  console.log(
    `${mb} MB · ${report.lines} lines · read ${report.readMs} ms · ipc ${report.ipcMs} ms · render ${report.renderMs} ms · total ${report.totalMs} ms (${report.nodes} nodes)`
  );
  console.log('history: ' + path.relative(root, historyFile));
}

if (require.main === module) main();

module.exports = { generate, appendRow, historyFile };

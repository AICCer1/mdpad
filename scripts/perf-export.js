'use strict';

// Measures export time and output size for a large document.
//
//   node scripts/perf-export.js                generate a ~0.5 MB document
//   node scripts/perf-export.js --kb 2048      bigger document
//   node scripts/perf-export.js --file some.md measure an existing file

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function generate(targetKb) {
  const file = path.join(os.tmpdir(), 'mdpad-export-bench-' + targetKb + '.md');
  const parts = ['# Large export'];
  let size = 0;
  let section = 0;
  while (size < targetKb * 1024) {
    section += 1;
    const block =
      '\n## Section ' + section + '\n\n' +
      'A paragraph with **bold**, *italic* and `code` that keeps going so the document is big. '.repeat(8) + '\n';
    parts.push(block);
    size += block.length;
  }
  fs.writeFileSync(file, parts.join(''), 'utf8');
  return file;
}

function electronBinary() {
  const candidates = [
    path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(root, 'node_modules', '.bin', 'electron.cmd'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return 'electron';
}

function main() {
  const fileArg = process.argv.indexOf('--file');
  const kbArg = process.argv.indexOf('--kb');
  const file = fileArg >= 0 ? process.argv[fileArg + 1] : generate(Number(kbArg >= 0 ? process.argv[kbArg + 1] : 512));
  const result = spawnSync(electronBinary(), ['.', '--bench-export'], {
    cwd: root,
    env: { ...process.env, MDPAD_PERF_OPEN: file },
    encoding: 'utf8',
    timeout: 900000,
    windowsHide: true,
  });
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .find((row) => row.startsWith('BENCH_EXPORT '));
  if (!line) {
    console.error((result.stdout || '').slice(-800));
    console.error((result.stderr || '').slice(-800));
    process.exit(1);
  }
  const report = JSON.parse(line.slice('BENCH_EXPORT '.length));
  console.log('document: ' + (report.bytes / 1024 / 1024).toFixed(2) + ' MB');
  for (const [kind, value] of Object.entries(report.formats)) {
    if (value.error) console.log(kind.padEnd(5) + ' failed: ' + value.error);
    else console.log(kind.padEnd(5) + ' ' + String(value.ms).padStart(6) + ' ms · ' + (value.bytes / 1024).toFixed(0) + ' KB · heap ' + value.heapMb + ' MB');
  }
}

if (require.main === module) main();

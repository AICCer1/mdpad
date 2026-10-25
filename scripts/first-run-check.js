'use strict';

// Starts the app against an empty profile and walks the first-run path: welcome, create, save,
// export. Used by release-check and runnable on its own.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electronPath = require('electron');

const root = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-first-run-'));
const profile = path.join(work, 'profile');

const bin = process.env.MDPAD_FIRST_RUN_BIN;
const child = bin
  ? spawn(bin, ['--walkthrough'], {
      env: { ...process.env, MDPAD_USERDATA: profile },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn(electronPath, ['.', '--walkthrough'], {
      cwd: root,
      env: { ...process.env, MDPAD_USERDATA: profile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

let out = '';
let err = '';
child.stdout.on('data', (chunk) => {
  out += chunk.toString('utf8');
});
child.stderr.on('data', (chunk) => {
  err += chunk.toString('utf8');
});
child.on('exit', (code) => {
  const line = out.split(/\r?\n/).find((row) => row.startsWith('WALKTHROUGH '));
  if (!line) {
    console.error('first run: no WALKTHROUGH line (exit ' + code + ')');
    console.error(out.slice(-800));
    console.error(err.slice(-800));
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }
  const report = JSON.parse(line.slice('WALKTHROUGH '.length));
  console.log('first run: welcome=' + report.firstRun.welcomeShown + ' editor=' + report.firstRun.editorReady + ' saved=' + Boolean(report.saved && report.saved.changed) + ' export=' + report.export.bytes + ' bytes');
  if (!report.ok) {
    console.error(JSON.stringify(report, null, 2));
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(report.ok && code === 0 ? 'first-run: ok' : 'first-run: FAIL');
  process.exit(report.ok && code === 0 ? 0 : 1);
});

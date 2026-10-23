'use strict';

// Captures documentation screenshots from the real UI.
// Usage: node scripts/screenshots.js [output-dir]

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const electronPath = require('electron');

const root = path.join(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs', 'images'));

const child = spawn(electronPath, ['.', `--screenshot-dir=${outDir}`], {
  cwd: root,
  env: { ...process.env, MDPAD_USERDATA: path.join(require('node:os').tmpdir(), `mdpad-shots-${Date.now()}`) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let out = '';
child.stdout.on('data', (chunk) => {
  out += chunk.toString('utf8');
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

function finish() {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* already gone */
  }
  if (!out.includes('SHOTS_OK')) {
    console.error('screenshots: did not finish');
    process.exit(1);
  }
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).sort() : [];
  console.log(`screenshots: ${files.length} file(s) in ${path.relative(root, outDir)}`);
  process.exit(files.length >= 5 ? 0 : 1);
}

const timer = setTimeout(() => {
  console.error('screenshots: timed out');
  finish();
}, 120000);

child.on('exit', () => {
  clearTimeout(timer);
  finish();
});

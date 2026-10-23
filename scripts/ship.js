'use strict';

// Ship pipeline: release gate, installers, install/uninstall check, checksums.
// One command for a releasable artifact set.

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function step(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: command === npm && process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`FAILED: ${label} (exit ${result.status})`);
    process.exit(result.status || 1);
  }
  console.log(`ok: ${label}`);
}

const checksOnly = process.argv.includes('--checksums-only');

if (!checksOnly) {
  step('release check', npm, ['run', 'release-check']);
  step('build installers', npm, ['run', 'dist']);
  step('install / uninstall check', npm, ['run', 'install-check']);
}

const artifacts = fs
  .readdirSync(releaseDir)
  .filter((name) => /\.(exe|yml|md)$/i.test(name))
  .sort();

const lines = [];
for (const name of artifacts) {
  const file = path.join(releaseDir, name);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  lines.push(`${hash}  ${name}`);
}
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');

console.log('\n=== artifacts ===');
for (const line of lines) console.log(line);
console.log('\nship: ok');

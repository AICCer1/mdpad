'use strict';

// Extracts the current version's section from CHANGELOG.md and writes the release
// notes next to the installers.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

const start = changelog.indexOf(`## ${pkg.version}`);
if (start < 0) {
  console.error(`No CHANGELOG section for ${pkg.version}`);
  process.exit(1);
}
const next = changelog.indexOf('\n## ', start + 1);
const body = changelog.slice(start, next === -1 ? undefined : next).trim();
const notes = `# mdpad ${pkg.version}\n\n${body.replace(/^## .*\n+/, '')}\n`;

const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'RELEASE_NOTES.md');
fs.writeFileSync(outFile, notes, 'utf8');

console.log(`release notes: ${path.relative(root, outFile)} (${notes.length} bytes, version ${pkg.version})`);

'use strict';

// Serves release/ as a generic update feed, for checking the update path without hosting
// anything. With --bump the latest.yml version is raised so an installed build sees an update.
//
//   node scripts/feed.js                     serve release/ on http://127.0.0.1:8199
//   node scripts/feed.js --port 8200 --bump   pretend a newer version is available
//
// Then set Settings -> Updates feed URL to the printed URL and use Help -> Check for updates.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');

const TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function bumpPatch(version) {
  const parts = String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.join('.');
}

function createFeedServer({ dir = releaseDir, bump = false, version = null } = {}) {
  return http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const name = path.basename(pathname);
    if (!name || name.startsWith('.')) {
      res.writeHead(404).end('not found');
      return;
    }
    const file = path.join(dir, name);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(name).toLowerCase();
    let body = fs.readFileSync(file);
    if (name === 'latest.yml' && bump) {
      const text = body.toString('utf8').replace(/^version: .*$/m, `version: ${bumpPatch(version || '0.0.0')}`);
      body = Buffer.from(text, 'utf8');
    }
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  });
}

function main() {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 8199;
  const bump = args.includes('--bump');
  const versionArg = args.indexOf('--version');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = versionArg >= 0 ? args[versionArg + 1] : pkg.version;

  if (!fs.existsSync(path.join(releaseDir, 'latest.yml'))) {
    console.error('release/latest.yml is missing; run `npm run ship` first');
    process.exit(1);
  }

  const server = createFeedServer({ bump, version });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`feed: ${url}`);
    console.log(`version in latest.yml: ${bump ? bumpPatch(version) + ' (bumped)' : version}`);
    console.log('settings -> Updates -> feed URL, then Help -> Check for updates');
    console.log('Ctrl+C to stop');
  });
}

if (require.main === module) main();

module.exports = { createFeedServer, bumpPatch };

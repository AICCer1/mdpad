'use strict';

// Bundles the renderer (ESM + Tiptap) into a single IIFE the page can load.
// The renderer has no Node access, so everything must be bundled here.

const esbuild = require('esbuild');
const path = require('node:path');

const watch = process.argv.includes('--watch');
const root = path.join(__dirname, '..');

const options = {
  entryPoints: [path.join(root, 'src', 'renderer', 'app.js')],
  outfile: path.join(root, 'src', 'renderer', 'dist', 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  platform: 'browser',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('watch: rebuilding src/renderer/dist/app.js on change');
    return;
  }
  await esbuild.build(options);
  const fs = require('node:fs');
  const out = options.outfile;
  console.log(`build: ${path.relative(root, out)} ${Math.round(fs.statSync(out).size / 1024)} KB`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

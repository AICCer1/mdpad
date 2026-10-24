'use strict';

// Renders an exported HTML document in a window and captures it, so the exported page can be
// inspected the way a reader would see it. Run with: npx electron scripts/shot-export.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const exporter = require(path.join(root, 'src', 'exporter.js'));

const fence = String.fromCharCode(96, 96, 96);
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const markdown = [
  '# Export preview',
  '',
  'Everything below is what **HTML/PDF export** produces.',
  '',
  '## Tables and images',
  '',
  '| Setting | Value |',
  '| --- | --- |',
  '| Autosave | 5 s idle |',
  '| Backups | 20 versions |',
  '',
  '![pixel](' + image + ' "w=40%")',
  '',
  '## Maths and code',
  '',
  'Inline math $a^2 + b^2 = c^2$ and a display block:',
  '',
  '$$',
  '\\int_0^1 x^2\\,dx = \\tfrac{1}{3}',
  '$$',
  '',
  fence + 'js',
  'const saved = writeDocument(file, contents);',
  fence,
  '',
  '### A note on diagrams',
  '',
  fence + 'mermaid',
  'graph LR;',
  '  write-->backup;',
  '  backup-->restore;',
  fence,
    
].join('\n');

// Mermaid cannot run here (no renderer bundle), so diagrams are documented by their fence in
// these shots; the export test asserts the SVG path with a running app.
async function capture(win, html, name, outDir) {
  const file = path.join(os.tmpdir(), 'mdpad-export-' + name + '.html');
  fs.writeFileSync(file, html, 'utf8');
  await win.loadURL('file://' + file.replace(/\\/g, '/'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log('SHOT ' + name);
}

async function main() {
  const outDir = path.join(root, 'docs', 'images');
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { offscreen: false } });

  const html = exporter.toHtmlDocument(markdown, 'Export preview', {
    template: 'default',
    css: '',
    font: 'Georgia, "Noto Serif", serif',
    margin: 'normal',
  });
  await capture(win, html, '10-export-page.png', outDir);

  const tocHtml = exporter.toHtmlDocument(markdown, 'Export preview', {
    template: 'toc',
    css: '',
    font: 'Georgia, "Noto Serif", serif',
    margin: 'normal',
  });
  await capture(win, tocHtml, '11-export-toc.png', outDir);

  const compactHtml = exporter.toHtmlDocument(markdown, 'Export preview', {
    template: 'compact',
    css: '',
    font: 'Georgia, "Noto Serif", serif',
    margin: 'narrow',
  });
  await capture(win, compactHtml, '12-export-compact.png', outDir);
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.error('shot-export failed:', error);
  app.exit(1);
});

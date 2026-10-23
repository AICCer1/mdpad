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
  'Everything below is what **HTML/PDF export** produces: table, image width, math, code and a diagram.',
  '',
  '| Setting | Value |',
  '| --- | --- |',
  '| Autosave | 5 s idle |',
  '| Backups | 20 versions |',
  '',
  '![pixel](' + image + ' "w=40%")',
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
  fence + 'mermaid',
  'graph LR;',
  '  write-->backup;',
  '  backup-->restore;',
  fence,
].join('\n');

async function main() {
  const outDir = path.join(root, 'docs', 'images');
  fs.mkdirSync(outDir, { recursive: true });

  // Mermaid cannot run here (no renderer bundle), so the diagram is documented by its fence in
  // this shot; the export test asserts the SVG path with a running app.
  const html = exporter.toHtmlDocument(markdown, 'Export preview', {
    template: 'default',
    css: '',
    font: 'Georgia, "Noto Serif", serif',
    margin: 'normal',
  });
  const file = path.join(os.tmpdir(), 'mdpad-export-shot.html');
  fs.writeFileSync(file, html, 'utf8');

  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { offscreen: false } });
  await win.loadURL('file://' + file.replace(/\\/g, '/'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const image2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, '10-export-page.png'), image2.toPNG());
  console.log('SHOT 10-export-page.png');
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.error('shot-export failed:', error);
  app.exit(1);
});

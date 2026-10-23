'use strict';

// Export pipeline: markdown -> standalone HTML -> PDF (via Chromium printToPDF).

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');
const { renderHtml, katexCss, highlightThemeCss, outline } = require('./markdown');

const DOCUMENT_CSS = `
:root { color-scheme: light; }
body {
  font-family: -apple-system, "Segoe UI", "Noto Sans", "Microsoft YaHei", sans-serif;
  font-size: 16px; line-height: 1.7; color: #222; background: #fff;
  margin: 0 auto; max-width: 46rem; padding: 3rem 2rem;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { line-height: 1.3; margin: 2em 0 .6em; }
h1 { font-size: 2em; border-bottom: 1px solid #eee; padding-bottom: .3em; }
h2 { font-size: 1.5em; }
code, pre { font-family: "Cascadia Code", Consolas, monospace; font-size: .92em; }
:not(pre) > code { background: #f4f4f4; padding: .15em .35em; border-radius: 3px; }
pre.hljs-pre { background: #f6f8fa; padding: 1em; border-radius: 6px; overflow: auto; }
pre.hljs-pre code { background: none; padding: 0; }
blockquote { margin: 1em 0; padding: .2em 1em; color: #555; border-left: 4px solid #ddd; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ddd; padding: .45em .7em; text-align: left; }
th { background: #fafafa; }
img { max-width: 100%; }
a { color: #0b67c2; }
.math-display { margin: 1.2em 0; text-align: center; overflow-x: auto; }
@media print {
  body { padding: 0; max-width: none; }
  pre, blockquote, table, .math-display { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
`;

const TEMPLATE_CSS = `
.toc { margin: 0 0 2rem; padding: 1rem 1.2rem; border: 1px solid #e6e6e6; border-radius: 8px; }
.toc-title { font-weight: 650; margin-bottom: .5rem; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc li { margin: .2rem 0; }
.toc-depth-2 { padding-left: 1rem; }
.toc-depth-3 { padding-left: 2rem; }
.toc-depth-4, .toc-depth-5, .toc-depth-6 { padding-left: 3rem; }
.toc a { color: #0b67c2; text-decoration: none; }
body[data-template="compact"] { padding: 1.6rem 1.2rem; font-size: 15px; line-height: 1.55; }
body[data-template="compact"] h1, body[data-template="compact"] h2,
body[data-template="compact"] h3 { margin: 1.2em 0 .4em; }
body[data-template="compact"] pre { padding: .7em; }
@media print {
  .toc { break-after: page; }
}
`;

const PDF_MARGINS = {
  normal: { top: 0.6, bottom: 0.6, left: 0.65, right: 0.65 },
  narrow: { top: 0.45, bottom: 0.45, left: 0.45, right: 0.45 },
  wide: { top: 0.8, bottom: 0.8, left: 0.95, right: 0.95 },
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const renderBody = (markdown, diagrams = null) => renderHtml(markdown, { diagrams });

// Table of contents for the export templates; heading ids come from the renderer.
function tocHtml(markdown) {
  const items = outline(markdown);
  if (!items.length) return '';
  const links = items
    .map(
      (item) =>
        `<li class="toc-depth-${item.depth}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`
    )
    .join('\n');
  return `<nav class="toc"><div class="toc-title">Contents</div><ul>\n${links}\n</ul></nav>`;
}

function sanitizeCss(css) {
  return String(css || '')
    .replace(/<\/?style[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script>|<script/gi, '')
    .replace(/@import[^;]*;/gi, '');
}

function toHtmlDocument(
  markdown,
  title = 'Untitled',
  { template = 'default', css = '', stats = null, diagrams = null, font = '', margin = 'normal' } = {}
) {
  const withToc = template === 'toc' ? tocHtml(markdown) : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${DOCUMENT_CSS}</style>
<style>${font ? `body { font-family: ${font}; }` : ''}</style>
<style>
  body[data-margin="narrow"] { padding: 1.6rem 1.4rem; }
  body[data-margin="wide"] { padding: 4rem 3.4rem; }
  @media print {
    body[data-margin="narrow"] { padding: 0; }
    body[data-margin="wide"] { padding: 0; }
  }
</style>
<style>${TEMPLATE_CSS}</style>
<style>${highlightThemeCss()}</style>
<style>${katexCss()}</style>
${css ? `<style>${sanitizeCss(css)}</style>` : ''}
</head>
<body data-template="${escapeHtml(template)}" data-margin="${escapeHtml(margin)}">
${withToc}
${renderBody(markdown, diagrams)}
${stats ? `<footer class="export-stats">${escapeHtml(stats.line)}</footer>` : ''}
</body>
</html>
`;
}

async function toPdf(
  markdown,
  targetPath,
  { title = 'Untitled', template = 'default', css = '', stats = null, diagrams = null, font = '', margin = 'normal' } = {}
) {
  const html = toHtmlDocument(markdown, title, { template, css, stats, diagrams, font, margin });
  const tmpHtml = path.join(path.dirname(targetPath), `mdpad-print-${process.pid}.html`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
    ]);

  // A hidden, throttled window makes printToPDF hang; keep it unthrottled.
  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, sandbox: false, javascript: false },
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`pdf: load failed ${code} ${desc} ${url}`));
  try {
    await withTimeout(win.loadURL(`file://${tmpHtml.replace(/\\/g, '/')}`), 15000, 'loadURL');
    const footer = `<div style="width:100%;font-size:9px;color:#888;padding:0 12mm;display:flex;justify-content:space-between;">
      <span>${escapeHtml(String(title))}</span>
      <span><span class="pageNumber"></span>/<span class="totalPages"></span></span>
    </div>`;
    const data = await withTimeout(
      win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: footer,
        margins: PDF_MARGINS[margin] || PDF_MARGINS.normal,
      }),
      25000,
      'printToPDF',
    );
    fs.writeFileSync(targetPath, data);
    return { path: targetPath, bytes: data.length };
  } finally {
    win.destroy();
    try { fs.unlinkSync(tmpHtml); } catch { /* already gone */ }
  }
}

module.exports = {
  sanitizeCss, DOCUMENT_CSS, renderBody, toHtmlDocument, toPdf };

'use strict';

// Exports one document to HTML, Word and EPUB in plain Node and reports what each format kept.
// Used for a quick consistency check; the smoke suite asserts the same things inside the app.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const root = path.join(__dirname, '..');
const exporter = require(path.join(root, 'src', 'exporter.js'));
const { toDocx } = require(path.join(root, 'src', 'exporters', 'docx.js'));
const { toEpub } = require(path.join(root, 'src', 'exporters', 'epub.js'));

const nl = '\n';
const fence = String.fromCharCode(96, 96, 96);
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const markdown = [
  '# Export check',
  '',
  'A paragraph with **bold words** and `inline code`.',
  '',
  '| Left | Right |',
  '| --- | --- |',
  '| alpha | beta |',
  '',
  '![pixel](data:image/png;base64,' + png + ')',
  '',
  'Inline math $a^2 + b^2 = c^2$ here.',
  '',
  '$$',
  '\\int_0^1 x^2 dx = \\tfrac{1}{3}',
  '$$',
  '',
  fence + 'js',
  'const answer = 42;',
  fence,
  '',
  fence + 'mermaid',
  'graph LR;',
  '  draft-->export;',
  fence,
].join(nl);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-export-'));

function textOf(xml) {
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  const report = {};

  const diagramSource = 'graph LR;' + nl + '  draft-->export;';
  const diagrams = { [diagramSource]: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' };
  const html = exporter.toHtmlDocument(markdown, 'Export check', {
    font: 'Georgia, serif',
    margin: 'normal',
    diagrams,
  });
  report.html = {
    heading: /<h1[^>]*>Export check<\/h1>/.test(html),
    bold: /<strong>bold words<\/strong>/.test(html),
    table: /<table[\s>]/.test(html),
    image: /<img[^>]+src="data:image\/png/.test(html),
    inlineMath: /class="katex"/.test(html),
    displayMath: /math-display/.test(html),
    code: /hljs|class="language-js"|<code/.test(html),
    diagramSvg: /mermaid-figure[\s\S]*<svg/.test(html),
    order: (() => {
      const body = html.slice(html.indexOf('<body'));
      const idx = ['Export check', 'bold words', 'Left', 'pixel'].map((needle) => body.indexOf(needle));
      return idx.every((value, i) => value >= 0 && (i === 0 || value > idx[i - 1]));
    })(),
  };

  const docxPath = path.join(outDir, 'check.docx');
  const docxOut = await toDocx(markdown, docxPath, { title: 'Export check', baseDir: outDir });
  fs.writeFileSync(docxPath, docxOut.buffer);
  const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
  const documentXml = await zip.file('word/document.xml').async('string');
  const docxText = textOf(documentXml);
  const hasImagePart = Object.keys(zip.files).some((name) => /^word\/media\//.test(name));
  report.docx = {
    heading: /Export check/.test(docxText),
    bold: /bold words/.test(docxText),
    table: /Left/.test(docxText) && /beta/.test(docxText),
    image: hasImagePart,
    inlineMath: /a\^2|a2|c2/.test(docxText),
    displayMath: /int|∫/.test(docxText),
    code: /const answer = 42;/.test(docxText),
    diagram: /graph LR|draft-->export|draft/.test(docxText),
    order: (() => {
      const idx = ['Export check', 'bold words', 'Left'].map((needle) => docxText.indexOf(needle));
      return idx.every((value, i) => value >= 0 && (i === 0 || value > idx[i - 1]));
    })(),
  };

  const epubPath = path.join(outDir, 'check.epub');
  const epubOut = await toEpub(markdown, epubPath, { title: 'Export check', baseDir: outDir, diagrams });
  if (epubOut && epubOut.buffer && !fs.existsSync(epubPath)) fs.writeFileSync(epubPath, epubOut.buffer);
  const epubZip = await JSZip.loadAsync(fs.readFileSync(epubPath));
  const chapterName = Object.keys(epubZip.files).find((name) => /\.xhtml$/.test(name));
  const chapter = chapterName ? await epubZip.file(chapterName).async('string') : '';
  const epubText = textOf(chapter);
  report.epub = {
    chapter: Boolean(chapterName),
    heading: /<h1[^>]*>Export check<\/h1>/.test(chapter),
    bold: /<strong>bold words<\/strong>/.test(chapter),
    table: /<table[\s>]/.test(chapter),
    image: Object.keys(epubZip.files).some((name) => /^OEBPS\/images\//.test(name)) || /<img/.test(chapter),
    inlineMath: /class="katex"/.test(chapter),
    diagramSvg: /mermaid-figure[\s\S]*<svg/.test(chapter),
    code: /const answer = 42;/.test(epubText),
    order: (() => {
      const body = chapter.slice(chapter.indexOf('<body'));
      const idx = ['Export check', 'bold words', 'Left'].map((needle) => body.indexOf(needle));
      return idx.every((value, i) => value >= 0 && (i === 0 || value > idx[i - 1]));
    })(),
  };

  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(outDir, { recursive: true, force: true });
})();

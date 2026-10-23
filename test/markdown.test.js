'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const markdown = require('../src/markdown');

test('fenced code gets highlight.js markup', () => {
  const html = markdown.renderHtml('```js\nconst x = 1;\n```');
  assert.match(html, /class="hljs language-js"/);
  assert.match(html, /hljs-keyword/);
});

test('unknown languages fall back to auto highlighting', () => {
  const html = markdown.renderHtml('```not-a-language\nfunction f() { return 1; }\n```');
  assert.match(html, /class="hljs(?: language-[\w-]+)?"/);
  assert.match(html, /hljs-/);
});

test('inline and display math render through KaTeX', () => {
  const inline = markdown.renderHtml('value $a^2+b^2$ here');
  assert.match(inline, /class="katex"/);
  assert.doesNotMatch(inline, /\$a\^2/);

  const display = markdown.renderHtml('$$\nE = mc^2\n$$');
  assert.match(display, /math-display/);
  assert.match(display, /class="katex"/);
});

test('headings get stable anchors and duplicates are disambiguated', () => {
  const html = markdown.renderHtml('# Hello World\n\n# Hello World');
  assert.match(html, /<h1 id="hello-world">/);
  assert.match(html, /<h1 id="hello-world-1">/);
});

test('outline reports depth, text and 1-based source line, skipping fences', () => {
  const md = ['# Title', '', '```md', '# not a heading', '```', '', '## Sub', '### Deep'].join('\n');
  assert.deepEqual(markdown.outline(md), [
    { depth: 1, text: 'Title', line: 1, id: 'title' },
    { depth: 2, text: 'Sub', line: 7, id: 'sub' },
    { depth: 3, text: 'Deep', line: 8, id: 'deep' },
  ]);
});

test('outline strips inline emphasis from heading text', () => {
  const items = markdown.outline('## **Bold** and `code`');
  assert.equal(items[0].text, 'Bold and code');
});

test('standalone export CSS embeds KaTeX fonts and the highlight theme', () => {
  const css = markdown.katexCss();
  assert.match(css, /data:font\/woff2;base64,/);
  assert.doesNotMatch(css, /url\(fonts\//);
  assert.match(markdown.highlightThemeCss(), /hljs/);
});

test('image size and alignment travel in the link title', () => {
  const html = markdown.renderHtml('![shot](assets/a.png "w=50%;align=center")');
  assert.match(html, /width:50%/);
  assert.match(html, /margin-left:auto/);
  assert.match(html, /title="w=50%;align=center"/);
});

test('numeric image widths get a px unit and junk keys are ignored', () => {
  assert.equal(markdown.imageStyle(markdown.parseImageMeta('w=320')), 'width:320px;max-width:100%');
  assert.deepEqual(markdown.parseImageMeta('w=abc;align=diagonal'), { width: null, align: null });
  assert.equal(markdown.formatImageMeta({ width: '50%', align: 'right' }), 'w=50%;align=right');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderHtml } = require('../src/markdown');

const nl = String.fromCharCode(10);
const fence = String.fromCharCode(96, 96, 96);
const svg = '<svg id="diagram"><g></g></svg>';

const mermaidDoc = [fence + 'mermaid', 'graph TD;', '  A-->B;', fence].join(nl);

test('a mermaid fence becomes the diagram when an SVG is supplied', () => {
  const html = renderHtml(mermaidDoc, { diagrams: { ['graph TD;' + nl + '  A-->B;']: svg } });
  assert.match(html, /<figure class="mermaid-figure">/);
  assert.ok(html.includes(svg));
  assert.doesNotMatch(html, /language-mermaid/);
});

test('without a diagram the fence stays a code block', () => {
  const html = renderHtml(mermaidDoc);
  assert.doesNotMatch(html, /mermaid-figure/);
  assert.match(html, /<pre class="hljs-pre">/);
});

test('an unmatched source falls back to the code block rather than an empty figure', () => {
  const html = renderHtml(mermaidDoc, { diagrams: { 'some other diagram': svg } });
  assert.doesNotMatch(html, /mermaid-figure/);
  assert.ok(!html.includes(svg));
});

test('only mermaid fences are replaced, even if a js block matches the map', () => {
  const jsDoc = [fence + 'js', 'const a = 1;', fence].join(nl);
  const html = renderHtml(jsDoc, { diagrams: { 'const a = 1;': svg } });
  assert.doesNotMatch(html, /mermaid-figure/);
  assert.match(html, /hljs/);
});

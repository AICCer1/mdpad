'use strict';

// Markdown pipeline: GFM + syntax highlighting + KaTeX + heading anchors.
// Pure Node so main, exporter and tests can share it.

const fs = require('node:fs');
const path = require('node:path');
const { Marked } = require('marked');
const hljs = require('highlight.js');
const katex = require('katex');

const ROOT = path.join(__dirname, '..');

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

function highlightCode(code, lang) {
  const language = (lang || '').trim().split(/\s+/)[0];
  if (language && hljs.getLanguage(language)) {
    try {
      return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language };
    } catch {
      /* fall through to auto */
    }
  }
  const auto = hljs.highlightAuto(code);
  return { html: auto.value, language: auto.language || null };
}

const blockMath = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    return src.indexOf('$$');
  },
  tokenizer(src) {
    const match = /^\$\$[ \t]*\n?([\s\S]+?)\n?\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (!match) return undefined;
    return { type: 'blockMath', raw: match[0], text: match[1].trim() };
  },
  renderer(token) {
    const html = katex.renderToString(token.text, { displayMode: true, throwOnError: false });
    return `<div class="math math-display">${html}</div>`;
  },
};

const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const i = src.indexOf('$');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const match = /^\$(?!\$)([^\n$]+?)\$(?!\d)/.exec(src);
    if (!match) return undefined;
    return { type: 'inlineMath', raw: match[0], text: match[1] };
  },
  renderer(token) {
    const html = katex.renderToString(token.text, { displayMode: false, throwOnError: false });
    return `<span class="math math-inline">${html}</span>`;
  },
};

function parseImageMeta(title) {
  const meta = { width: null, align: null };
  if (!title) return meta;
  for (const part of String(title).split(';')) {
    const [key, value] = part.split('=').map((s) => s && s.trim());
    if (!value) continue;
    if (key === 'w' && /^\d{1,4}%?$/.test(value)) meta.width = value;
    if (key === 'align' && ['left', 'center', 'right'].includes(value)) meta.align = value;
  }
  return meta;
}

function formatImageMeta({ width, align }) {
  const parts = [];
  if (width) parts.push(`w=${width}`);
  if (align) parts.push(`align=${align}`);
  return parts.join(';');
}

function imageStyle(meta) {
  const css = [];
  if (meta.width) {
    const unit = String(meta.width).endsWith('%') ? '' : 'px';
    css.push(`width:${meta.width}${unit}`, 'max-width:100%');
  }
  if (meta.align === 'center') css.push('display:block', 'margin-left:auto', 'margin-right:auto');
  if (meta.align === 'right') css.push('display:block', 'margin-left:auto', 'margin-right:0');
  if (meta.align === 'left') css.push('display:block', 'margin-left:0', 'margin-right:auto');
  return css.join(';');
}

function createMarked() {
  const seen = new Map();
  const renderer = {
    heading(token) {
      const text = this.parser.parseInline(token.tokens);
      const base = slugify(token.text);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count}`;
      return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`;
    },
    code(token) {
      const { html, language } = highlightCode(token.text, token.lang);
      const cls = language ? ` class="hljs language-${language}"` : ' class="hljs"';
      return `<pre class="hljs-pre"><code${cls}>${html}</code></pre>\n`;
    },
    image(token) {
      const alt = token.text || '';
      const meta = parseImageMeta(token.title);
      const style = imageStyle(meta);
      const titleAttr = token.title ? ` title="${String(token.title).replace(/"/g, '&quot;')}"` : '';
      const styleAttr = style ? ` style="${style}"` : '';
      return `<img src="${token.href}" alt="${alt}"${titleAttr}${styleAttr}>`;
    },
  };
  return new Marked({ gfm: true, breaks: false, renderer, extensions: [blockMath, inlineMath] });
}

function renderHtml(markdown) {
  if (!markdown) return '';
  return createMarked().parse(String(markdown));
}

// Headings for the outline panel, with the 1-based source line for editor jumps.
function outline(markdown) {
  const items = [];
  const lines = String(markdown || '').split('\n');
  let fence = null;
  const seen = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (line.trim().startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const text = heading[2].replace(/[*_`~]/g, '').trim();
    if (!text) continue;
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    items.push({
      depth: heading[1].length,
      text,
      line: i + 1,
      id: count === 0 ? base : `${base}-${count}`,
    });
  }
  return items;
}

// ---- stylesheet assembly for standalone exports ---------------------------

let cachedFontCss = null;

function fontDataUri(file) {
  const bytes = fs.readFileSync(file);
  return `data:font/woff2;base64,${bytes.toString('base64')}`;
}

function katexCss() {
  if (cachedFontCss !== null) return cachedFontCss;
  const dist = path.join(ROOT, 'node_modules', 'katex', 'dist');
  const cssPath = path.join(dist, 'katex.min.css');
  if (!fs.existsSync(cssPath)) {
    cachedFontCss = '';
    return cachedFontCss;
  }
  cachedFontCss = fs
    .readFileSync(cssPath, 'utf8')
    .replace(/url\(fonts\/([^)]+?)\)/g, (whole, name) => {
      const file = path.join(dist, 'fonts', path.basename(name));
      if (!name.endsWith('.woff2') || !fs.existsSync(file)) return 'url(about:blank)';
      return `url(${fontDataUri(file)})`;
    });
  return cachedFontCss;
}

function highlightThemeCss() {
  const cssPath = path.join(ROOT, 'node_modules', 'highlight.js', 'styles', 'github.css');
  return fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
}

module.exports = {
  renderHtml,
  outline,
  slugify,
  katexCss,
  highlightThemeCss,
  highlightCode,
  parseImageMeta,
  formatImageMeta,
  imageStyle,
};

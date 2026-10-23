'use strict';

// Markdown -> EPUB 3. One chapter per top-level H1; everything else stays in the
// first chapter. Local images are copied into the EPUB; remote URLs are left as-is.

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { renderHtml, katexCss, highlightThemeCss } = require('../markdown');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function resolveImage(src, baseDir) {
  const raw = String(src || '').trim();
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) {
    const match = /^data:image\/([a-z0-9+.-]+);base64,(.*)$/i.exec(raw);
    if (!match) return null;
    const subtype = match[1].toLowerCase();
    const ext = subtype === 'jpeg' ? 'jpg' : subtype.replace('svg+xml', 'svg');
    return { buffer: Buffer.from(match[2], 'base64'), ext, mime: MIME_BY_EXT[`.${ext}`] || `image/${subtype}` };
  }
  if (/^(https?:)?\/\//i.test(raw)) return null; // leave remote URLs alone
  const clean = decodeURI(raw.replace(/^file:\/\/\//i, ''));
  const resolved = path.resolve(baseDir || process.cwd(), clean);
  if (!fs.existsSync(resolved)) return null;
  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;
  return { buffer: fs.readFileSync(resolved), ext: ext.replace('.', ''), mime };
}

// Rewrites <img src> to point at the embedded copies and records them for the manifest.
function embedImages(html, baseDir, store) {
  return html.replace(/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/gi, (match, prefix, src, suffix) => {
    const image = resolveImage(src, baseDir);
    if (!image) return match;
    const name = `images/img${store.size + 1}.${image.ext}`;
    store.set(name, image);
    return `<img${prefix}src="${name}"${suffix}>`;
  });
}

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

const CSS = `
body { font-family: serif; line-height: 1.7; margin: 1.2em; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 .5em; }
pre { background: #f6f8fa; padding: .8em; white-space: pre-wrap; word-wrap: break-word; }
code { font-family: monospace; }
blockquote { border-left: 3px solid #ddd; margin: .8em 0; padding-left: .8em; color: #555; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ddd; padding: .35em .5em; }
img { max-width: 100%; }
`;

function splitChapters(markdown) {
  const lines = String(markdown || '').split('\n');
  const chapters = [];
  let current = { title: 'Chapter 1', lines: [] };
  let fence = null;
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (line.trim().startsWith(fence.repeat(3))) fence = null;
      current.lines.push(line);
      continue;
    }
    const h1 = fence === null && /^#\s+(.*)$/.exec(line);
    if (h1) {
      if (current.lines.some((l) => l.trim())) chapters.push(current);
      current = { title: h1[1].replace(/[*_`~]/g, '').trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some((l) => l.trim()) || chapters.length === 0) chapters.push(current);
  return chapters;
}

function chapterXhtmlHtml(title, htmlBody) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><meta charset="utf-8"><title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${htmlBody}
</body>
</html>
`;
}

async function toEpub(
  markdown,
  targetPath,
  { title = 'Untitled', author = 'mdpad', baseDir = process.cwd(), diagrams = null } = {}
) {
  const chapters = splitChapters(markdown);
  const zip = new JSZip();

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`);

  const oebps = zip.folder('OEBPS');
  oebps.file('style.css', `${CSS}\n${highlightThemeCss()}\n${katexCss()}`);

  const manifest = [];
  const spine = [];
  const images = new Map();
  chapters.forEach((chapter, index) => {
    const name = `chap${index + 1}.xhtml`;
    const html = embedImages(renderHtml(chapter.lines.join('\n'), { diagrams }), baseDir, images);
    oebps.file(name, chapterXhtmlHtml(chapter.title, html));
    manifest.push(`<item id="chap${index + 1}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="chap${index + 1}"/>`);
  });

  for (const [name, image] of images) {
    oebps.file(name, image.buffer);
    manifest.push(`<item id="${name.replace(/[^a-z0-9]/gi, '_')}" href="${name}" media-type="${image.mime}"/>`);
  }

  oebps.file('toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="mdpad-${Date.now()}"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${chapters.map((c, i) => `  <navPoint id="nav${i + 1}" playOrder="${i + 1}">
    <navLabel><text>${escapeXml(c.title)}</text></navLabel>
    <content src="chap${i + 1}.xhtml"/>
  </navPoint>`).join('\n')}
</navMap>
</ncx>
`);

  oebps.file('content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">mdpad-${Date.now()}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spine.join('\n    ')}
  </spine>
</package>
`);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { path: targetPath, bytes: buffer.length, buffer, chapters: chapters.length };
}

function chapterXhtml(title, markdown) {
  return chapterXhtmlHtml(title, renderHtml(markdown));
}

module.exports = { toEpub, splitChapters, resolveImage, embedImages, chapterXhtml };

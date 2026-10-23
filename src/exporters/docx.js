'use strict';

// Markdown -> .docx using the docx package. Covers the block/inline nodes the
// editor round-trips; local images are embedded, remote ones fall back to alt text.

const fs = require('node:fs');
const path = require('node:path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const { marked } = require('marked');

const MAX_IMAGE_WIDTH = 440;

function imageType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.gif') return 'gif';
  if (ext === '.bmp') return 'bmp';
  return 'png';
}

// Minimal size probe: PNG stores width/height big-endian at 16/20, JPEG needs a
// SOF marker walk. Unknown formats fall back to a square.
function imageSize(buffer, type) {
  if (type === 'png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (type === 'jpg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return { width: 320, height: 200 };
}

function loadImage(href, baseDir) {
  try {
    if (/^data:image\//i.test(href)) {
      const match = /^data:image\/([a-z0-9+.-]+);base64,(.*)$/i.exec(href);
      if (!match) return null;
      const type = match[1].toLowerCase().includes('jpeg') ? 'jpg' : match[1].toLowerCase();
      const buffer = Buffer.from(match[2], 'base64');
      return { buffer, type, ...imageSize(buffer, type) };
    }
    if (/^https?:/i.test(href) || !href) return null;
    const resolved = path.resolve(baseDir, decodeURI(href));
    if (!fs.existsSync(resolved)) return null;
    const type = imageType(resolved);
    const buffer = fs.readFileSync(resolved);
    return { buffer, type, ...imageSize(buffer, type) };
  } catch {
    return null;
  }
}

function imageRun(href, ctx, base) {
  const image = ctx && loadImage(href, ctx.baseDir);
  if (!image) {
    return new TextRun({ ...base, text: `[image: ${href}]`, italics: true });
  }
  const scale = Math.min(1, MAX_IMAGE_WIDTH / Math.max(image.width, 1));
  return new ImageRun({
    data: image.buffer,
    type: image.type === 'jpg' ? 'jpg' : image.type,
    transformation: {
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale)),
    },
  });
}

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

// Inline tokens -> TextRun[]
function runs(tokens, base = {}, ctx) {
  const out = [];
  for (const token of tokens || []) {
    switch (token.type) {
      case 'strong':
        out.push(...runs(token.tokens, { ...base, bold: true }, ctx));
        break;
      case 'em':
        out.push(...runs(token.tokens, { ...base, italics: true }, ctx));
        break;
      case 'del':
        out.push(...runs(token.tokens, { ...base, strike: true }, ctx));
        break;
      case 'codespan':
        out.push(new TextRun({ ...base, text: token.text, font: 'Consolas', shading: { fill: 'F2F2F2' } }));
        break;
      case 'text':
        out.push(new TextRun({ ...base, text: token.text }));
        break;
      case 'link':
        out.push(...runs(token.tokens, { ...base, color: '0B67C2', underline: {} }, ctx));
        break;
      case 'image':
        out.push(imageRun(token.href, ctx, base));
        break;
      case 'br':
        out.push(new TextRun({ ...base, break: 1 }));
        break;
      default:
        if (token.tokens) out.push(...runs(token.tokens, base, ctx));
        else if (token.text) out.push(new TextRun({ ...base, text: token.text }));
    }
  }
  return out.length ? out : [new TextRun({ ...base, text: '' })];
}

function listParagraphs(token, depth = 0, ctx) {
  const out = [];
  const bullet = token.type === 'list' && token.ordered === false;
  let index = Number(token.start || 1);
  for (const item of token.items || []) {
    const prefix = bullet ? '• ' : `${index++}. `;
    const first = item.tokens.find((t) => t.type === 'text' || t.type === 'paragraph');
    if (first) {
      out.push(new Paragraph({
        children: [new TextRun({ text: prefix }), ...runs(first.tokens || [first], {}, ctx)],
        indent: { left: 360 * (depth + 1) },
        spacing: { after: 60 },
      }));
    }
    for (const nested of item.tokens.filter((t) => t.type === 'list')) {
      out.push(...listParagraphs(nested, depth + 1, ctx));
    }
  }
  return out;
}

function tableParagraphs(token, ctx) {
  const rows = token.rows || [];
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [token.header, ...rows].filter(Boolean).map((cells) => new TableRow({
      children: (cells || []).map((cell) => new TableCell({
        children: [new Paragraph({ children: runs(cell.tokens, {}, ctx), spacing: { after: 0 } })],
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
      })),
    })),
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
      left: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
      right: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
    },
  })];
}

function blocks(tokens, ctx) {
  const out = [];
  for (const token of tokens || []) {
    switch (token.type) {
      case 'heading':
        out.push(new Paragraph({
          heading: HEADINGS[token.depth] || HeadingLevel.HEADING_1,
          children: runs(token.tokens, {}, ctx),
          spacing: { before: 240, after: 120 },
        }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: runs(token.tokens, {}, ctx), spacing: { after: 120 } }));
        break;
      case 'code':
        out.push(new Paragraph({
          children: [new TextRun({ text: token.text, font: 'Consolas', size: 18 })],
          shading: { fill: 'F6F8FA' },
          spacing: { after: 160 },
        }));
        break;
      case 'blockquote':
        for (const inner of blocks(token.tokens, ctx)) {
          out.push(inner);
        }
        break;
      case 'list':
        out.push(...listParagraphs(token, 0, ctx));
        break;
      case 'table':
        out.push(...tableParagraphs(token, ctx));
        out.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        break;
      case 'hr':
        out.push(new Paragraph({
          children: [new TextRun({ text: '' })],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'DDDDDD' } },
          spacing: { after: 200 },
        }));
        break;
      case 'space':
        break;
      default:
        if (token.tokens && token.tokens.length) out.push(...blocks(token.tokens, ctx));
    }
  }
  return out;
}

async function toDocx(markdown, targetPath, { title = 'Untitled', baseDir = process.cwd() } = {}) {
  const tokens = marked.lexer(String(markdown || ''));
  const ctx = { baseDir };
  const doc = new Document({
    title,
    description: 'Exported from mdpad',
    sections: [{ properties: {}, children: blocks(tokens, ctx) }],
  });
  const buffer = await Packer.toBuffer(doc);
  return { path: targetPath, bytes: buffer.length, buffer };
}

module.exports = { toDocx, loadImage, imageSize };

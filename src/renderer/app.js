'use strict';

// WYSIWYG renderer: Tiptap (ProseMirror) holds the document; markdown is the
// serialization sent to the main process, so saving/backup/draft are unchanged.

import { Editor, Extension, markInputRule } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { wrapIn, lift } from 'prosemirror-commands';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { closeHistory } from 'prosemirror-history';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Mathematics } from '@tiptap/extension-mathematics';
import katex from 'katex';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { all, createLowlight } from 'lowlight';
import { diffWords, diffStats } from '../diff.js';
import { t, normalizeLang } from '../i18n.js';
import { contrastRatio } from '../color.js';
import { initialScope, effectiveScope } from '../ai-scope.js';
import { shouldOpenExternal } from '../link-guard.js';

let lang = 'en';

function applyI18n(language) {
  lang = normalizeLang(language);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n, lang);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle, lang);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder, lang);
  }
  const themeLabels = { light: 'ui.themeLight', dark: 'ui.themeDark', sepia: 'ui.themeSepia' };
  for (const select of document.querySelectorAll('#theme, #set-theme')) {
    for (const option of select.options) {
      if (themeLabels[option.value]) option.textContent = t(themeLabels[option.value], lang);
    }
  }

  labelEditor();

  // i18n rewrites textContent; buttons carrying an icon need it back.
  applyStaticIcons();
}

const $ = (sel) => document.querySelector(sel);

const host = $('#editor');
const docName = $('#doc-name');
const dirtyDot = $('#dirty-dot');
const status = $('#status');
const stats = $('#stats');
const paths = $('#paths');
const banner = $('#banner');
const bannerText = $('#banner-text');
const bannerPrimary = $('#banner-primary');
const bannerSecondary = $('#banner-secondary');
const findbar = $('#findbar');
const findInput = $('#find-input');
const replaceInput = $('#replace-input');
const findCount = $('#find-count');
const outlineList = $('#outline-list');
const outlinePane = $('#outline');
const tabList = $('#tab-list');
const headingSelect = $('#heading-select');
const codeLang = $('#code-lang');
const tableBar = $('#table-bar');
const imageBar = $('#image-bar');
const linkPopover = $('#link-popover');
const linkInput = $('#link-input');
const aiPopover = $('#ai-popover');
const aiInstruction = $('#ai-instruction');
const aiResult = $('#ai-result');
const aiStatus = $('#ai-status');
const settingsModal = $('#settings-modal');

const lowlight = createLowlight(all);

// Image size/alignment travels in the markdown link title: ![alt](src "w=50%;align=center")
function parseImageMeta(title) {
  const meta = {};
  for (const part of String(title || '').split(';')) {
    const [key, value] = part.split('=').map((s) => s && s.trim());
    if (!value) continue;
    if (key === 'w') meta.w = value;
    if (key === 'align') meta.align = value;
  }
  return meta;
}

function formatImageMeta(meta) {
  return ['w', 'align'].filter((k) => meta[k]).map((k) => `${k}=${meta[k]}`).join(';');
}

function imageStyleFromTitle(title) {
  const meta = parseImageMeta(title);
  const css = [];
  if (meta.w) css.push(`width:${meta.w}`, 'max-width:100%');
  if (meta.align === 'center') css.push('display:block', 'margin-left:auto', 'margin-right:auto');
  if (meta.align === 'right') css.push('display:block', 'margin-left:auto', 'margin-right:0');
  if (meta.align === 'left') css.push('display:block', 'margin-left:0', 'margin-right:auto');
  return css.join(';');
}

// ---- mermaid preview -------------------------------------------------------
// Rendering happens into a cache, never into the editor DOM directly: ProseMirror re-creates
// node views on most transactions, so an async render that writes into the (then detached)
// node lands nowhere. The node view paints whatever the cache holds, and a refresh transaction
// repaints once the SVG is ready.
let mermaidReady = false;
const mermaidCache = new Map(); // key: theme + source -> { svg } | { error }
const mermaidPending = new Set();
let mermaidSeq = 0;

function mermaidApi() {
  const api = window.mermaid;
  if (!api) return null;
  if (!mermaidReady) {
    api.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    mermaidReady = true;
  }
  return api;
}

function mermaidKey(source) {
  return (document.documentElement.dataset.theme || 'light') + '\u0000' + source;
}

function renderMermaidIntoCache(source) {
  const text = String(source || '').trim();
  if (!text) return;
  const key = mermaidKey(text);
  if (mermaidCache.has(key) || mermaidPending.has(key)) return;
  const api = mermaidApi();
  if (!api) {
    mermaidCache.set(key, { error: 'Mermaid is not available' });
    return;
  }
  mermaidPending.add(key);
  const id = 'mmd-' + (mermaidSeq += 1);
  api
    .render(id, text)
    .then(({ svg }) => {
      if (svg) mermaidCache.set(key, { svg });
      else mermaidCache.set(key, { error: 'the diagram produced no output' });
    })
    .catch((err) => {
      mermaidCache.set(key, { error: String(err && err.message ? err.message : err).slice(0, 200) });
    })
    .finally(() => {
      mermaidPending.delete(key);
      // A meta-only transaction does not re-run node views, so repaint the live previews
      // directly. They carry the source they were built from in a data attribute.
      for (const el of document.querySelectorAll('.mermaid-preview')) {
        if (el.dataset.source !== text || !el.isConnected) continue;
        if (typeof el._refresh === 'function') el._refresh();
        else paintMermaid(el, text);
      }
    });
}

function paintMermaid(preview, source) {
  const text = String(source || '').trim();
  if (!text) {
    preview.textContent = '';
    preview.classList.remove('is-error');
    return;
  }
  const entry = mermaidCache.get(mermaidKey(text));
  if (!entry) {
    preview.textContent = 'rendering diagram…';
    preview.classList.remove('is-error');
    renderMermaidIntoCache(text);
    return;
  }
  if (entry.error) {
    preview.textContent = entry.error;
    preview.classList.add('is-error');
    return;
  }
  preview.innerHTML = entry.svg;
  preview.classList.remove('is-error');
}

// Exports are built in the main process, which has no Mermaid runtime and no DOM. The
// renderer renders each diagram once (light theme, because exported documents are light) and
// hands the SVG map to main before the export starts.
async function collectExportDiagrams() {
  const sources = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'codeBlock') return;
    if (String(node.attrs.language || '').toLowerCase() !== 'mermaid') return;
    const text = node.textContent.trim();
    if (text && !sources.includes(text)) sources.push(text);
  });
  if (!sources.length) return {};

  const api = mermaidApi();
  if (!api) return {};

  const editorTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
  const map = {};
  if (editorTheme !== 'default') {
    api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', fontFamily: 'inherit' });
    mermaidReady = true;
  }
  try {
    for (const text of sources) {
      try {
        const { svg } = await api.render('exp-' + Date.now().toString(36) + '-' + (mermaidSeq += 1), text);
        if (svg) map[text] = svg;
      } catch {
        // Leave it out: the exporter falls back to the fenced source for that block.
      }
    }
  } finally {
    if (editorTheme !== 'default') {
      mermaidReady = false;
      mermaidApi();
      refreshMermaidPreviews();
    }
  }
  return map;
}

// One place for the export choices. The format decides the file, everything else decides how
// it looks, and the summary on the right says what will come out before anything is written.
let exportFormat = 'pdf';

function exportFormatLabel(format) {
  return { html: 'HTML', pdf: 'PDF', docx: 'Word', epub: 'EPUB' }[format] || format.toUpperCase();
}

function drawExportThumb(template, font, margin) {
  const svg = document.querySelector('#export-thumb');
  if (!svg) return;
  const pad = margin === 'wide' ? 26 : margin === 'narrow' ? 12 : 18;
  const lines = [0, 1, 2, 3, 4, 5, 6].map((row) => {
    const width = row === 0 ? 92 : row === 3 ? 64 : 78 - (row % 3) * 8;
    return `<rect x="${pad}" y="${34 + row * 16}" width="${width}" height="${row === 0 ? 7 : 4}" rx="2" fill="currentColor" opacity="${row === 0 ? 0.55 : 0.22}"/>`;
  });
  const toc = template === 'toc' ? `<rect x="${pad}" y="26" width="${160 - pad * 2}" height="18" rx="3" fill="currentColor" opacity="0.08"/>` : '';
  svg.innerHTML = `
    <rect x="1" y="1" width="158" height="208" rx="6" fill="var(--bg)" stroke="var(--line)"/>
    ${toc}
    ${lines.map((line) => line.replace(/y="(\d+)"/, (m, y) => `y="${Number(y) + (toc ? 20 : 0)}"`)).join('')}
  `;
  svg.style.fontFamily = font;
}

// The sketch is instant and always readable; the real render replaces it once it arrives.
let exportThumbTimer = null;
let exportThumbToken = 0;

function refreshExportThumb() {
  clearTimeout(exportThumbTimer);
  exportThumbTimer = setTimeout(async () => {
    const token = (exportThumbToken += 1);
    const image = document.querySelector('#export-thumb-img');
    const sketch = document.querySelector('#export-thumb');
    if (!image) return;
    const options = {
      template: document.querySelector('#export-template').value,
      font: document.querySelector('#export-font').value,
      margin: document.querySelector('#export-margin').value,
    };
    image.classList.add('is-loading');
    const result = await window.api.exportThumbnail(options).catch(() => ({ ok: false }));
    if (token !== exportThumbToken) return; // a newer request won
    image.classList.remove('is-loading');
    if (result && result.ok && result.dataUrl) {
      image.src = result.dataUrl;
      image.hidden = false;
      if (sketch) sketch.classList.add('is-replaced');
    }
  }, 260);
}

let exportInspectToken = 0;

async function refreshExportInspect() {
  const summary = document.querySelector('#export-summary');
  if (!summary) return;
  const token = ++exportInspectToken;
  const info = await window.api.exportInspect().catch(() => null);
  if (token !== exportInspectToken || !info) return;
  const parts = [];
  parts.push(`${info.words} words · ${info.headings} headings`);
  const blocks = [];
  if (info.images) blocks.push(`${info.images} image${info.images === 1 ? '' : 's'}`);
  if (info.tables) blocks.push(`${info.tables} table row${info.tables === 1 ? '' : 's'}`);
  if (info.diagrams) blocks.push(`${info.diagrams} diagram${info.diagrams === 1 ? '' : 's'}`);
  if (info.math) blocks.push(`${info.math} formula${info.math === 1 ? '' : 's'}`);
  if (info.tasks) blocks.push(`${info.tasks} task${info.tasks === 1 ? '' : 's'}`);
  if (blocks.length) parts.push(blocks.join(' · '));
  const warnings = [];
  if (info.chars > 300000) {
    warnings.push('Large document — export can take several seconds (about 8 s for a 2 MB PDF)');
  }
  if (info.unresolvedImages) warnings.push(`${info.unresolvedImages} image(s) not found`);
  if (info.unresolvedLinks) warnings.push(`${info.unresolvedLinks} link(s) not found`);
  const node = document.createElement('div');
  node.className = 'export-inspect';
  node.id = 'export-inspect';
  node.innerHTML =
    '<div class="export-inspect-line">' + parts.join('<br>') + '</div>' +
    (warnings.length
      ? '<div class="export-inspect-warn">' + warnings.join(' · ') + '</div>'
      : '');
  const existing = document.querySelector('#export-inspect');
  if (existing) existing.replaceWith(node);
  else summary.appendChild(node);
}

function refreshExportSummary() {
  const summary = document.querySelector('#export-summary');
  if (!summary) return;
  const template = document.querySelector('#export-template').value;
  const font = document.querySelector('#export-font').value;
  const margin = document.querySelector('#export-margin').value;
  const fontLabel = document.querySelector(`#export-font option[value="${font}"]`).textContent;
  const templateLabel = document.querySelector(`#export-template option[value="${template}"]`).textContent;
  const marginLabel = document.querySelector(`#export-margin option[value="${margin}"]`).textContent;
  const lines = [
    `<b>${exportFormatLabel(exportFormat)}</b> · ${exportFormat === 'pdf' ? 'A4' : 'flowing layout'}`,
    `${templateLabel}`,
    `${fontLabel}`,
    `${marginLabel} margins`,
  ];
  if (exportFormat === 'docx') lines.push('Word uses its own styles and keeps diagram code blocks');
  if (exportFormat === 'epub') lines.push('EPUB reflows, so page margins do not apply');
  summary.innerHTML = lines.join('<br>');
  refreshExportInspect();
  drawExportThumb(template, font, margin);
}

function setExportFormat(format) {
  exportFormat = ['html', 'pdf', 'docx', 'epub'].includes(format) ? format : 'pdf';
  for (const button of document.querySelectorAll('#export-format [data-format]')) {
    button.classList.toggle('is-active', button.dataset.format === exportFormat);
  }
  // Word writes its own styles and EPUB its own page flow: disable controls that would lie.
  const fontSelect = document.querySelector('#export-font');
  const marginSelect = document.querySelector('#export-margin');
  fontSelect.disabled = exportFormat === 'docx';
  marginSelect.disabled = exportFormat === 'docx' || exportFormat === 'epub';
  refreshExportSummary();
}

async function openExportPanel(format = 'pdf') {
  const settings = await window.api.getSettings();
  document.querySelector('#export-template').value = settings.exportTemplate || 'default';
  document.querySelector('#export-font').value = settings.exportFont || 'serif';
  document.querySelector('#export-margin').value = settings.exportMargin || 'normal';
  document.querySelector('#export-name').value = settings.exportNameTemplate || '{title}';
  document.querySelector('#export-status').textContent = '';
  setExportFormat(format);
  refreshExportSummary();
  refreshExportThumb();
  await refreshExportNameHintFor('#export-name', '#export-name-hint');
  document.querySelector('#export-modal').hidden = false;
}

async function refreshExportNameHintFor(inputSelector, hintSelector) {
  const input = document.querySelector(inputSelector);
  const hint = document.querySelector(hintSelector);
  if (!input || !hint) return;
  const result = await window.api
    .exportNamePreview(input.value || '{title}')
    .catch(() => ({ name: '' }));
  const example = result && result.name ? result.name : '';
  hint.textContent = example ? 'e.g. ' + example : '';
  hint.classList.toggle('is-error', Boolean(result && result.error));
}

async function saveExportPanelSettings() {
  await window.api.setSettings({
    exportTemplate: document.querySelector('#export-template').value,
    exportFont: document.querySelector('#export-font').value,
    exportMargin: document.querySelector('#export-margin').value,
    exportNameTemplate: document.querySelector('#export-name').value,
  });
}

async function runExport(kind) {
  await publishExportDiagrams();
  if (kind === 'html') return window.api.exportHtml();
  if (kind === 'pdf') return window.api.exportPdf();
  if (kind === 'docx') return window.api.exportDocx();
  if (kind === 'epub') return window.api.exportEpub();
  return window.api.exportPreview();
}

async function publishExportDiagrams() {
  const diagrams = await collectExportDiagrams();
  try {
    await window.api.setExportDiagrams(diagrams);
  } catch {
    /* exporting still works, diagrams fall back to code blocks */
  }
  return Object.keys(diagrams).length;
}

function refreshMermaidPreviews() {
  mermaidReady = false; // re-initialise with the theme colour palette
  for (const el of document.querySelectorAll('.mermaid-preview')) {
    if (el.isConnected && typeof el._refresh === 'function') el._refresh();
  }
}

// Per-cell alignment. Markdown tables only describe column alignment, so this is presented as a
// view setting: it is kept in the editor and in HTML/PDF export, and the export note says so.
const cellAlignment = {
  textAlign: {
    default: null,
    parseHTML: (element) => element.style.textAlign || null,
    renderHTML: (attributes) => (attributes.textAlign ? { style: 'text-align: ' + attributes.textAlign } : {}),
  },
};

const AlignedTableCell = TableCell.extend({ addAttributes() { return { ...this.parent(), ...cellAlignment }; } });
const AlignedTableHeader = TableHeader.extend({ addAttributes() { return { ...this.parent(), ...cellAlignment }; } });

// Mermaid, the way Typora does it: the rendered diagram replaces the source, clicking the
// diagram brings the source back, Esc or a click elsewhere returns to the diagram. A failed
// diagram keeps its source visible — hiding code behind an error message would be a trap.
const MermaidCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.appendChild(code);
      wrapper.appendChild(pre);

      const preview = document.createElement('div');
      preview.className = 'mermaid-preview';
      wrapper.appendChild(preview);

      const hint = document.createElement('div');
      hint.className = 'mermaid-hint';
      hint.textContent = 'Click to edit · Esc to preview';
      wrapper.appendChild(hint);

      let current = node;
      let mode = 'preview';

      const isMermaid = () => current.attrs.language === 'mermaid';
      const entry = () => mermaidCache.get(mermaidKey(current.textContent.trim()));

      const apply = () => {
        if (!isMermaid()) {
          wrapper.classList.remove('is-mermaid', 'is-preview');
          pre.hidden = false;
          preview.hidden = true;
          hint.hidden = true;
          return;
        }
        wrapper.classList.add('is-mermaid');
        const text = current.textContent.trim();
        preview.dataset.source = text;
        const cached = mermaidCache.get(mermaidKey(text));
        const failed = Boolean(cached && cached.error);
        const ready = Boolean(cached && cached.svg);
        // Show the source while editing, while the first render is pending, or on error.
        const showSource = mode === 'edit' || failed || !ready;
        pre.hidden = !showSource;
        preview.hidden = false;
        wrapper.classList.toggle('is-preview', !showSource && ready);
        hint.hidden = !ready || mode === 'edit';
        paintMermaid(preview, text);
      };
      preview._refresh = apply;

      preview.addEventListener('click', () => {
        const cached = entry();
        if (!cached || !cached.svg) return;
        mode = 'edit';
        apply();
      });

      code.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isMermaid() && mode === 'edit') {
          event.preventDefault();
          mode = 'preview';
          apply();
        }
      });

      const onOutside = (event) => {
        if (!isMermaid() || mode !== 'edit') return;
        if (wrapper.contains(event.target)) return;
        const cached = entry();
        if (!cached || !cached.svg) return;
        mode = 'preview';
        apply();
      };
      document.addEventListener('mousedown', onOutside, true);

      const sync = () => {
        if (!isMermaid()) mode = 'preview';
        apply();
      };
      sync();

      return {
        dom: wrapper,
        contentDOM: code,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          const textChanged = updated.textContent !== current.textContent;
          const languageChanged = updated.attrs.language !== current.attrs.language;
          current = updated;
          if (textChanged || languageChanged) {
            mode = 'preview';
            apply();
          } else if (isMermaid()) {
            apply();
          }
          return true;
        },
        // Toggling pre.hidden is our own doing; without this ProseMirror treats the
        // structural change as a reason to rebuild the node view, which drops edit mode.
        ignoreMutation: (mutation) =>
          mutation.target === pre ||
          mutation.target === preview ||
          mutation.target === hint ||
          mutation.target === wrapper,
        destroy: () => {
          document.removeEventListener('mousedown', onOutside, true);
        },
      };
    };
  },
});

const SizedImage = Image.extend({
  draggable: true,
  markdownName: 'image',
  renderHTML({ HTMLAttributes }) {
    const style = imageStyleFromTitle(HTMLAttributes.title);
    return ['img', { ...HTMLAttributes, ...(style ? { style } : {}) }];
  },
  parseMarkdown(token) {
    return {
      type: 'image',
      attrs: { src: token.href, alt: token.text || '', title: token.title || null },
    };
  },
  renderMarkdown(node) {
    const { src = '', alt = '', title = null } = node.attrs || {};
    const titlePart = title ? ` "${title}"` : '';
    return `![${alt}](${src}${titlePart})`;
  },
});

// Focus mode marks the block being edited with a ProseMirror decoration. A class added by
// hand is wiped whenever ProseMirror re-renders a block, which is every transaction.
let focusModeEnabled = false;

const focusModeKey = new PluginKey('mdpadFocusMode');

const FocusDecoration = Extension.create({
  name: 'mdpadFocusDecoration',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: focusModeKey,
        props: {
          decorations(state) {
            if (!focusModeEnabled) return null;
            const { $from } = state.selection;
            if ($from.depth < 1) return null;
            // Decorate the top-level block so a caret inside a table lights the whole table.
            const depth = 1;
            try {
              return DecorationSet.create(state.doc, [
                Decoration.node($from.before(depth), $from.after(depth), {
                  class: 'is-active-block',
                }),
              ]);
            } catch {
              return null;
            }
          },
        },
      }),
    ];
  },
});

// A soft highlight for the block the caret is in. It steps aside when focus mode is on: that
// mode already dims everything else, and stacking both would make the text muddy.
let highlightParagraphEnabled = false;
const paragraphHighlightKey = new PluginKey('mdpadParagraphHighlight');

const ParagraphHighlight = Extension.create({
  name: 'mdpadParagraphHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: paragraphHighlightKey,
        props: {
          decorations(state) {
            if (!highlightParagraphEnabled || focusModeEnabled) return null;
            const { $from } = state.selection;
            if ($from.depth < 1) return null;
            try {
              return DecorationSet.create(state.doc, [
                Decoration.node($from.before(1), $from.after(1), {
                  class: 'is-current-block-soft',
                }),
              ]);
            } catch {
              return null;
            }
          },
        },
      }),
    ];
  },
});

const AiTarget = Extension.create({
  name: 'aiTarget',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            if (!aiTargetDecoration || aiPopover.hidden) return null;
            const { from, to } = aiTargetDecoration;
            if (from >= to || to > state.doc.content.size) return null;
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, { class: 'ai-target-range' }),
            ]);
          },
        },
      }),
    ];
  },
});

// Typing **bold** (or *italic*, ~~strike~~, `code`) converts on the closing delimiter, the way
// people who write markdown expect. The node-level rules (#, -, 1., >, fences) come from StarterKit.
// Tab / Shift+Tab inside a quote nest or lift it; lists keep ProseMirror's own sink/lift keymap.
function indentBlockquote(editorRef, direction) {
  const type = editorRef.schema.nodes.blockquote;
  if (!type) return false;
  const command = direction > 0 ? wrapIn(type) : lift;
  return command(editorRef.state, editorRef.view.dispatch, editorRef.view);
}

const inlineMarkdownInputRules = Extension.create({
  name: 'inlineMarkdownInputRules',
  addInputRules() {
    const marks = this.editor.schema.marks;
    const rules = [];
    if (marks.bold) rules.push(markInputRule({ find: /(?:\*\*)([^*]+)(?:\*\*)$/, type: marks.bold }));
    if (marks.italic) rules.push(markInputRule({ find: /(?<!\*)\*([^*\s][^*]*)\*$/, type: marks.italic }));
    if (marks.strike) rules.push(markInputRule({ find: /(?:~~)([^~]+)(?:~~)$/, type: marks.strike }));
    if (marks.code) rules.push(markInputRule({ find: /(?:`)([^`]+)(?:`)$/, type: marks.code }));
    return rules;
  },
});

const editor = new Editor({
  element: host,
  extensions: [
    FocusDecoration,
      ParagraphHighlight,
    StarterKit.configure({ codeBlock: false, link: false, heading: { levels: [1, 2, 3, 4, 5, 6] } }),
    // Pasting a URL over a selection should link that selection instead of replacing it.
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
    AiTarget,
    MermaidCodeBlock.configure({ lowlight }),
    Markdown,
    SizedImage.configure({ inline: false, allowBase64: true }),
    Table.extend({
    addKeyboardShortcuts() {
      const parent = this.parent ? this.parent() : {};
      return {
        ...parent,
        Tab: () => {
          const { state } = this.editor;
          const { $from } = state.selection;
          let inTable = false;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            if ($from.node(depth).type.name === 'table') {
              inTable = true;
              break;
            }
          }
          if (!inTable) return false;
          // No next cell means we are in the last one: append a row, like Notion.
          if (!this.editor.can().goToNextCell()) {
            return this.editor.chain().focus().addRowAfter().goToNextCell().run();
          }
          return this.editor.commands.goToNextCell();
        },
      };
    },
  }).configure({ resizable: true, handleWidth: 6, cellMinWidth: 60, lastColumnResizable: true }),
    TableRow,
    TableHeader,
    AlignedTableCell,
    AlignedTableHeader,
    TaskList,
    TaskItem.configure({ nested: true }),
    Mathematics,
    inlineMarkdownInputRules,
  ],
  content: '',
  autofocus: false,
  editorProps: {
    attributes: { class: 'mdpad-prose', spellcheck: 'false' },
    handleKeyDown(view, event) {
      const mod = event.ctrlKey || event.metaKey;
      const { $from } = view.state.selection;
      const inList = (() => {
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          if ($from.node(depth).type.name === 'listItem') return true;
        }
        return false;
      })();
      const inQuote = (() => {
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          if ($from.node(depth).type.name === 'blockquote') return true;
        }
        return false;
      })();

      if (event.key === 'Tab' && !event.shiftKey) {
        if ($from.parent.type.name === 'codeBlock') {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText('  ', view.state.selection.from));
          return true;
        }
        // Lists are handled by ProseMirror's own keymap below this handler.
        if (!inList && inQuote) {
          event.preventDefault();
          indentBlockquote({ state: view.state, schema: view.state.schema, view }, 1);
          return true;
        }
      }
      if (event.key === 'Tab' && event.shiftKey) {
        if (!inList && inQuote) {
          event.preventDefault();
          indentBlockquote({ state: view.state, schema: view.state.schema, view }, -1);
          return true;
        }
      }
      // Ctrl+] / Ctrl+[ work everywhere: lists sink, quotes nest.
      if (mod && (event.key === ']' || event.key === '}')) {
        event.preventDefault();
        if (inList) {
          return editor.commands.sinkListItem('listItem');
        }
        if (inQuote) return indentBlockquote({ state: view.state, schema: view.state.schema, view }, 1);
      }
      if (mod && (event.key === '[' || event.key === '{')) {
        event.preventDefault();
        if (inList) return editor.commands.liftListItem('listItem');
        if (inQuote) return indentBlockquote({ state: view.state, schema: view.state.schema, view }, -1);
      }
      // Move the current top-level block with Ctrl+Shift+Up/Down.
      if (mod && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        moveBlock(view, event.key === 'ArrowUp' ? -1 : 1);
        return true;
      }
      return false;
    },
  },
  onUpdate: () => { scheduleChange(); syncToolbar(); markLargeDocument(); },
  onSelectionUpdate: () => { updateStats(); syncToolbar(); requestAnimationFrame(typewriterFollow); },
});

// ---- block move ------------------------------------------------------------
// One block at a time, with the caret kept at the same offset inside the block that moved.

function blockStart(doc, index) {
  let start = 0;
  for (let i = 0; i < index && i < doc.childCount; i += 1) start += doc.child(i).nodeSize;
  return start;
}

function replaceBlocks(view, children, caretPos) {
  const { state } = view;
  const doc = state.doc;
  const next = doc.type.create(doc.attrs, children, doc.marks);
  const tr = state.tr.replaceWith(0, doc.content.size, next.content);
  // The selection must be resolved against the transaction's own document: resolving it against
  // the freshly built "next" document fails the identity check in setSelection.
  const clamped = Math.max(1, Math.min(tr.doc.content.size - 1, caretPos));
  tr.setSelection(Selection.near(tr.doc.resolve(clamped)));
  view.dispatch(tr);
  view.focus();
}

function moveBlockAt(view, index, delta) {
  const { state } = view;
  const doc = state.doc;
  const target = index + delta;
  if (index < 0 || target < 0 || target >= doc.childCount) return false;
  const children = [];
  doc.forEach((node) => children.push(node));
  const start = blockStart(doc, index);
  const offset = Math.max(0, Math.min(children[index].nodeSize - 1, state.selection.from - start));
  const moved = children[index];
  children.splice(index, 1);
  children.splice(target, 0, moved);
  const newStart = blockStart(doc, target);
  replaceBlocks(view, children, newStart + offset);
  return true;
}

function moveBlock(view, delta) {
  return moveBlockAt(view, view.state.selection.$from.index(0), delta);
}

function duplicateBlockAt(view, index) {
  const doc = view.state.doc;
  if (index < 0 || index >= doc.childCount) return false;
  const children = [];
  doc.forEach((node) => children.push(node));
  const copy = children[index].copy(children[index].content);
  children.splice(index + 1, 0, copy);
  replaceBlocks(view, children, blockStart(doc, index + 1) + 1);
  return true;
}

function deleteBlockAt(view, index) {
  const doc = view.state.doc;
  if (index < 0 || index >= doc.childCount) return false;
  const children = [];
  doc.forEach((node) => children.push(node));
  if (children.length <= 1) children.splice(index, 1, doc.type.schema.nodes.paragraph.create());
  else children.splice(index, 1);
  replaceBlocks(view, children, blockStart(doc, Math.max(0, index - 1)) + 1);
  return true;
}

// ---- block grip -------------------------------------------------------------
// The handle appears next to the block under the pointer; its menu moves, duplicates or deletes
// that block. Keyboard users have Ctrl+Shift+Up/Down and the same menu is reachable by clicking.

const blockPane = document.querySelector('.editor-pane');
const blockGrip = document.createElement('button');
blockGrip.type = 'button';
blockGrip.id = 'block-grip';
blockGrip.className = 'block-grip';
blockGrip.hidden = true;
blockGrip.title = 'Block actions';
blockGrip.innerHTML =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><circle cx="9" cy="7" r="1.6"/><circle cx="15" cy="7" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="17" r="1.6"/><circle cx="15" cy="17" r="1.6"/></svg>';
blockPane.appendChild(blockGrip);

let blockGripIndex = -1;
const blockMenu = document.querySelector('#block-menu');

function blockIndexAtCoords(clientX, clientY) {
  const coords = editor.view.posAtCoords({ left: clientX, top: clientY });
  if (!coords) return -1;
  const $pos = editor.state.doc.resolve(coords.pos);
  return $pos.index(0);
}

function positionBlockGrip(index) {
  const doc = editor.state.doc;
  if (index < 0 || index >= doc.childCount) {
    blockGrip.hidden = true;
    blockGripIndex = -1;
    return;
  }
  const start = blockStart(doc, index);
  let coords;
  try {
    coords = editor.view.coordsAtPos(Math.min(start + 1, doc.content.size - 1));
  } catch {
    blockGrip.hidden = true;
    return;
  }
  const paneRect = blockPane.getBoundingClientRect();
  blockGripIndex = index;
  blockGrip.hidden = false;
  blockGrip.style.top = Math.max(4, coords.top - paneRect.top + blockPane.scrollTop) + 'px';
  blockGrip.style.left = Math.max(2, coords.left - paneRect.left - 26) + 'px';
}

function hideBlockGrip() {
  if (!blockMenu || blockMenu.hidden) {
    blockGrip.hidden = true;
    blockGripIndex = -1;
  }
}

function openBlockMenu(x, y) {
  if (!blockMenu) return;
  blockMenu.hidden = false;
  const rect = blockMenu.getBoundingClientRect();
  blockMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  blockMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

function closeBlockMenu() {
  if (blockMenu) blockMenu.hidden = true;
}

editor.view.dom.addEventListener('mousemove', (event) => {
  if (!blockMenu.hidden) return;
  const index = blockIndexAtCoords(event.clientX, event.clientY);
  if (index < 0) return;
  positionBlockGrip(index);
});

blockPane.addEventListener('mouseleave', () => {
  if (blockMenu && !blockMenu.hidden) return;
  hideBlockGrip();
});

blockGrip.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (blockGripIndex < 0) return;
  const rect = blockGrip.getBoundingClientRect();
  openBlockMenu(rect.right + 6, rect.top);
});

blockGrip.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (blockGripIndex < 0) return;
  openBlockMenu(event.clientX, event.clientY);
});

blockMenu?.addEventListener('click', (event) => {
  const button = event.target.closest ? event.target.closest('[data-block-action]') : null;
  if (!button) return;
  const action = button.dataset.blockAction;
  const index = blockGripIndex;
  closeBlockMenu();
  if (index < 0) return;
  const view = editor.view;
  if (action === 'up') moveBlockAt(view, index, -1);
  else if (action === 'down') moveBlockAt(view, index, 1);
  else if (action === 'duplicate') duplicateBlockAt(view, index);
  else if (action === 'delete') deleteBlockAt(view, index);
  positionBlockGrip(Math.max(0, index));
});

document.addEventListener('mousedown', (event) => {
  if (blockMenu && !blockMenu.hidden && !blockMenu.contains(event.target) && event.target !== blockGrip) {
    closeBlockMenu();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeBlockMenu();
});

// ---- state plumbing --------------------------------------------------------

let draftBannerShown = false;
let lastLoadTiming = null;
let lastSetMarkdownPhases = null;
let backupBannerShown = false;
let changeTimer = null;
let applying = false;

function setDirty(dirty) {
  dirtyDot.hidden = !dirty;
}

// One Escape closes whatever dialog is on top and hands the keyboard back to the editor.
function closeTopModal() {
  const modals = [...document.querySelectorAll('.modal')].filter((modal) => !modal.hidden);
  if (!modals.length) return false;
  const modal = modals[modals.length - 1];
  const closer =
    modal.querySelector('[data-modal-close]') ||
    modal.querySelector('#set-cancel, #export-cancel, #drafts-close, #stats-close, #shortcuts-close, #name-cancel, #tree-confirm-cancel');
  if (closer) closer.click();
  else modal.hidden = true;
  try {
    editor.commands.focus();
  } catch {
    /* the editor may not exist yet */
  }
  return true;
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (closeTopModal()) event.preventDefault();
});

function flash(message) {
  status.textContent = message;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { status.textContent = ''; }, 2500);
}

let writingStatus = null;
let writingTimer = null;

function renderWritingStatus(summary) {
  if (!summary) return;
  const node = document.querySelector('#writing-status');
  if (!node) return;
  if (!summary.goal) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = 'Today ' + summary.today + ' / ' + summary.goal + ' words';
  node.classList.toggle('is-reached', summary.reached === true);
}

async function recordWriting() {
  const words = (editor.getText().match(/\S+/g) || []).length;
  const key = activeTabId || 'untitled';
  const summary = await window.api.writingRecord(key, words).catch(() => null);
  if (!summary) return;
  writingStatus = summary;
  renderWritingStatus(summary);
  if (summary.firstReach) {
    showToast('Daily goal reached: ' + summary.today + ' words', 6000);
  }
}

async function refreshWritingStatus() {
  writingStatus = await window.api.writingStats().catch(() => null);
  renderWritingStatus(writingStatus);
}

function updateStatsNow() {
  const { from, to, empty } = editor.state.selection;
  const text = editor.getText();
  const words = (text.match(/\S+/g) || []).length;
  const lines = text ? text.split('\n').length : 0;
  const before = editor.state.doc.textBetween(0, from, '\n', '\n');
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  let extra = '';
  if (!empty) {
    const selected = editor.state.doc.textBetween(from, to, ' ');
    extra = ` · ${selected.length} chars selected`;
  }
  stats.textContent = `Ln ${line}, Col ${col} · ${words} words · ${lines} lines · ${text.length} chars${extra}`;
}

let statsTimer = null;
let lastStatsAt = 0;

// Called on every transaction. The document-wide counts are debounced so a long file does not
// rescan itself on each keystroke; the caret position stays immediate.
function updateStats() {
  const now = performance.now();
  if (now - lastStatsAt > 250) {
    lastStatsAt = now;
    updateStatsNow();
    return;
  }
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    lastStatsAt = performance.now();
    updateStatsNow();
  }, 250);
}

function currentMarkdown() {
  try {
    return editor.getMarkdown();
  } catch {
    return editor.getHTML();
  }
}

let lastSyncAt = 0;
let pendingChange = false;

function pushChange() {
  lastSyncAt = Date.now();
  pendingChange = false;
  return window.api.syncChange(currentMarkdown(), activeTabId).then((res) => {
    if (!res.ignored) setDirty(res.dirty);
    return res;
  });
}

function scheduleChange() {
  if (applying) return;
  updateStats();
  clearTimeout(changeTimer);
  // Send the first change in a burst immediately, then coalesce the rest: a crash a few
  // milliseconds after a keystroke should not lose that keystroke.
  pendingChange = true;
  if (Date.now() - lastSyncAt > 300) pushChange();
  changeTimer = setTimeout(pushChange, 300);
}

// Leaving the window (alt-tab, another app) and hidden tabs flush the draft right away.
// Save hit a file that changed underneath us. Never overwrite silently: offer the three
// sensible resolutions and let the user pick.
function showConflictDialog(result, after) {
  const modal = document.querySelector('#tree-confirm');
  const title = document.querySelector('#tree-confirm-title');
  const text = document.querySelector('#tree-confirm-text');
  const ok = document.querySelector('#tree-confirm-ok');
  const cancel = document.querySelector('#tree-confirm-cancel');
  title.textContent = 'This file changed on disk';
  text.textContent =
    'Another window or app wrote this file after you opened it. Saving now would replace that version.';
  ok.textContent = 'Overwrite';
  ok.classList.remove('danger');
  if (cancel.dataset.conflictBound !== '1') {
    cancel.dataset.conflictBound = '1';
  }
  // Three-way choice: the confirm button overwrites, Cancel keeps the editor version unsaved.
  const close = () => {
    modal.hidden = true;
    ok.removeEventListener('click', onOverwrite);
    cancel.removeEventListener('click', onKeep);
  };
  const onOverwrite = async () => {
    close();
    const saved = await window.api.save({ force: true });
    if (saved && saved.saved) {
      showToast('Overwritten on disk', 3000);
      after?.(saved);
    }
  };
  const onKeep = () => {
    close();
    showToast('Kept your version in the editor — save again to overwrite', 5000);
  };
  ok.addEventListener('click', onOverwrite);
  cancel.addEventListener('click', onKeep);
  modal.hidden = false;
  return result;
}

async function saveDocument(options = {}) {
  const result = await window.api.save(options);
  if (result && result.conflict) return showConflictDialog(result);
  return result;
}

window.addEventListener('blur', () => {
  if (applying || !pendingChange) return;
  clearTimeout(changeTimer);
  pushChange().catch(() => {});
  window.api.flushDraft(activeTabId).catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || applying || !pendingChange) return;
  clearTimeout(changeTimer);
  pushChange().catch(() => {});
  window.api.flushDraft().catch(() => {});
});

// Off-screen blocks of a huge document can skip layout; small ones keep exact layout semantics.
function markLargeDocument() {
  if (!editor || !editor.view) return;
  const big = editor.state.doc.content.size > 200000;
  const dom = editor.view.dom;
  if (dom.classList.contains('is-large') !== big) dom.classList.toggle('is-large', big);
}

function setMarkdown(markdown) {
  applying = true;
  const phaseStart = performance.now();
  editor.commands.setContent(markdown || '', { contentType: 'markdown' });
  const contentMs = performance.now() - phaseStart;
  promoteInlineImages();
  const promoteMs = performance.now() - phaseStart - contentMs;
  applying = false;
  const statsStart = performance.now();
  updateStats();
  const statsMs = performance.now() - statsStart;
  syncToolbar();
  lastSetMarkdownPhases = {
    contentMs: Math.round(contentMs),
    promoteMs: Math.round(promoteMs),
    statsMs: Math.round(statsMs),
    toolbarMs: Math.round(performance.now() - phaseStart - contentMs - promoteMs - statsMs),
  };
}

// Tiptap's markdown parser gets quadratic with document size: 2 MB took 15.5 s in one setContent
// call, while the same text in 128 KB chunks takes well under a second each. Split at paragraph
// boundaries so no block is cut in half, and yield between chunks so the window stays alive.
function splitMarkdownChunks(markdown, targetSize) {
  const chunks = [];
  let start = 0;
  while (start < markdown.length) {
    let end = Math.min(markdown.length, start + targetSize);
    if (end < markdown.length) {
      const nextBreak = markdown.indexOf('\n\n', end);
      const previousBreak = markdown.lastIndexOf('\n\n', end);
      if (previousBreak > start + targetSize / 2) end = previousBreak + 2;
      else if (nextBreak !== -1) end = nextBreak + 2;
    }
    chunks.push(markdown.slice(start, end));
    start = end;
  }
  return chunks;
}

async function setMarkdownProgressive(markdown) {
  const text = markdown || '';
  const CHUNK = 128 * 1024;
  if (text.length <= CHUNK) {
    setMarkdown(text);
    return;
  }
  const chunks = splitMarkdownChunks(text, CHUNK);
  applying = true;
  try {
    editor.commands.setContent(chunks[0], { contentType: 'markdown', emitUpdate: false });
    for (let index = 1; index < chunks.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      editor.commands.insertContentAt(editor.state.doc.content.size, chunks[index], {
        contentType: 'markdown',
        emitUpdate: false,
      });
    }
    promoteInlineImages();
  } finally {
    applying = false;
  }
  updateStats();
  syncToolbar();
}


// The markdown parser leaves ![alt](src "title") as literal text; turn those
// matches into real image nodes so they render and serialize back correctly.
function promoteInlineImages() {
  const { state } = editor;
  const found = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
    let match;
    while ((match = re.exec(node.text)) !== null) {
      found.push({
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        alt: match[1] || '',
        src: match[2],
        title: match[3] || null,
      });
    }
  });
  if (!found.length) return;
  let tr = state.tr;
  for (const item of found.reverse()) {
    if (!state.schema.nodes.image) break;
    tr = tr.replaceWith(
      item.from,
      item.to,
      state.schema.nodes.image.create({ src: item.src, alt: item.alt, title: item.title }),
    );
  }
  editor.view.dispatch(tr);
}

// ---- toolbar ---------------------------------------------------------------

const commands = {
  bold: () => editor.chain().focus().toggleBold().run(),
  italic: () => editor.chain().focus().toggleItalic().run(),
  strike: () => editor.chain().focus().toggleStrike().run(),
  code: () => editor.chain().focus().toggleCode().run(),
  bulletList: () => editor.chain().focus().toggleBulletList().run(),
  orderedList: () => editor.chain().focus().toggleOrderedList().run(),
  taskList: () => editor.chain().focus().toggleTaskList().run(),
  blockquote: () => editor.chain().focus().toggleBlockquote().run(),
  codeBlock: () => editor.chain().focus().toggleCodeBlock().run(),
  table: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  image: () => $('#image-input').click(),
  link: () => openPopover('link', editor.getAttributes('link').href || ''),
  mathInline: () => openPopover('mathInline', ''),
  mathBlock: () => openPopover('mathBlock', ''),
  ai: openAI,
};

document.querySelectorAll('[data-cmd]').forEach((button) => {
  button.addEventListener('click', () => commands[button.dataset.cmd]?.());
});

// Moving a row by editing positions inside a table is easy to get wrong; rebuilding the table
// with two rows swapped is not.
// Notion-style row grip: appears at the left edge of the row under the pointer and can drag the
// row to a new position.
let rowDragFrom = -1;
let rowDragHandleEl = null;

function rowElements() {
  const table = document.querySelector('.tiptap table');
  return table ? [...table.querySelectorAll('tbody > tr, thead > tr')] : [];
}

function ensureRowHandle() {
  if (rowDragHandleEl) return rowDragHandleEl;
  const handle = document.createElement('div');
  handle.id = 'row-handle';
  handle.className = 'row-handle';
  handle.hidden = true;
  handle.title = 'Drag to move this row';
  handle.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">' +
    '<circle cx="9" cy="7" r="1.4"/><circle cx="15" cy="7" r="1.4"/>' +
    '<circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/>' +
    '<circle cx="9" cy="17" r="1.4"/><circle cx="15" cy="17" r="1.4"/></svg>';
  document.body.appendChild(handle);
  rowDragHandleEl = handle;
  return handle;
}

function showRowHandle(index) {
  const handle = ensureRowHandle();
  const rows = rowElements();
  const row = rows[index];
  if (!row) {
    handle.hidden = true;
    return;
  }
  const rect = row.getBoundingClientRect();
  handle.style.top = rect.top + rect.height / 2 - 11 + 'px';
  handle.style.left = rect.left - 26 + 'px';
  handle.hidden = false;
  handle.dataset.row = String(index);
}

function hideRowHandle() {
  if (rowDragHandleEl) rowDragHandleEl.hidden = true;
}

function rowIndexAt(y) {
  const rows = rowElements();
  for (let i = 0; i < rows.length; i += 1) {
    const rect = rows[i].getBoundingClientRect();
    if (y < rect.bottom) return i;
  }
  return rows.length - 1;
}

function closeTableMenu() {
  const menu = document.querySelector('#table-menu');
  if (menu) menu.hidden = true;
}

// ---- image drag -------------------------------------------------------------
// Images move by dragging them: the drop position comes from the document coordinates under the
// pointer, so the image lands between blocks rather than at a pixel offset.
const imageDrag = { pos: null, target: null, indicator: null };

function imageDropIndicator() {
  if (imageDrag.indicator) return imageDrag.indicator;
  const line = document.createElement('div');
  line.className = 'image-drop-line';
  line.hidden = true;
  document.body.appendChild(line);
  imageDrag.indicator = line;
  return line;
}

function imageBlockPos(img) {
  // posAtDOM on an atom node is unreliable; match the node whose rendered DOM is this <img>.
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'image' && editor.view.nodeDOM(pos) === img) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

editor.view.dom.addEventListener('dragstart', (event) => {
  const img = event.target.closest ? event.target.closest('img') : null;
  if (!img || !editor.view.dom.contains(img)) return;
  const pos = imageBlockPos(img);
  if (pos === null) return;
  imageDrag.pos = pos;
  imageDrag.target = pos;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', 'mdpad-image');
});

editor.view.dom.addEventListener('dragover', (event) => {
  if (imageDrag.pos === null) return;
  const coords = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const line = imageDropIndicator();
  const domAt = editor.view.domAtPos(coords.pos);
  const element = domAt.node.nodeType === 1 ? domAt.node : domAt.node.parentElement;
  const block = element && element.closest ? element.closest('.tiptap > *') : null;
  const rect = (block || editor.view.dom).getBoundingClientRect();
  imageDrag.target = coords.pos;
  line.hidden = false;
  line.style.left = rect.left + 'px';
  line.style.top = rect.top + 'px';
  line.style.width = rect.width + 'px';
  line.style.height = '2px';
});

editor.view.dom.addEventListener('drop', (event) => {
  if (imageDrag.pos === null) return;
  event.preventDefault();
  const from = imageDrag.pos;
  const target = imageDrag.target === null ? from : imageDrag.target;
  imageDrag.pos = null;
  imageDrag.target = null;
  imageDropIndicator().hidden = true;
  moveImageTo(from, target);
});

editor.view.dom.addEventListener('dragend', () => {
  imageDrag.pos = null;
  imageDrag.target = null;
  imageDropIndicator().hidden = true;
  document.documentElement.classList.remove('image-dragging');
});

window.addEventListener('dragover', (event) => {
  if (imageDrag.pos === null) return;
  if (!editor.view.dom.contains(event.target)) imageDropIndicator().hidden = true;
});

// Move an image block to another document position in one undoable step.
function moveImageTo(from, target) {
  const { state } = editor;
  const node = state.doc.nodeAt(from);
  if (!node || node.type.name !== 'image') return false;
  const nodeSize = node.nodeSize;
  if (target >= from && target <= from + nodeSize) return false;
  const adjusted = target > from ? target - nodeSize : target;
  const tr = state.tr.delete(from, from + nodeSize);
  tr.insert(Math.max(0, Math.min(adjusted, tr.doc.content.size)), node);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

// ---- table drag reordering ---------------------------------------------------
// Dragging from the left edge of a cell moves its row; from the top edge, its column. The drop
// target is read from the cell under the pointer, so no coordinate maths on table geometry.
const tableDragState = { active: false, axis: null, from: 0, target: 0, indicator: null };

function tableCellInfo(cell) {
  const pos = editor.view.posAtDOM(cell, 0);
  const $pos = editor.state.doc.resolve(pos);
  let tableDepth = -1;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'table') {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0) return null;
  return {
    tableDepth,
    row: $pos.index(tableDepth),
    column: $pos.index(tableDepth + 1),
  };
}

function tableIndicator() {
  if (tableDragState.indicator) return tableDragState.indicator;
  const line = document.createElement('div');
  line.className = 'table-drop-line';
  line.hidden = true;
  document.body.appendChild(line);
  tableDragState.indicator = line;
  return line;
}

function edgeHit(event) {
  const cell = event.target.closest ? event.target.closest('td, th') : null;
  if (!cell || !editor.view.dom.contains(cell)) return null;
  const rect = cell.getBoundingClientRect();
  if (event.clientX - rect.left <= 9) return { cell, rect, axis: 'row' };
  if (event.clientY - rect.top <= 9) return { cell, rect, axis: 'column' };
  return null;
}

editor.view.dom.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  const hit = edgeHit(event);
  if (!hit) return;
  const info = tableCellInfo(hit.cell);
  if (!info) return;
  event.preventDefault();
  tableDragState.active = true;
  tableDragState.axis = hit.axis;
  tableDragState.from = hit.axis === 'row' ? info.row : info.column;
  tableDragState.target = tableDragState.from;
  document.documentElement.classList.add('table-dragging-' + hit.axis);
});

window.addEventListener('mousemove', (event) => {
  if (!tableDragState.active) return;
  const cell = document.elementFromPoint(event.clientX, event.clientY);
  const target = cell && cell.closest ? cell.closest('td, th') : null;
  if (!target || !editor.view.dom.contains(target)) return;
  const info = tableCellInfo(target);
  if (!info) return;
  const index = tableDragState.axis === 'row' ? info.row : info.column;
  tableDragState.target = index;
  const rect = target.getBoundingClientRect();
  const line = tableIndicator();
  line.hidden = false;
  if (tableDragState.axis === 'row') {
    line.style.left = rect.left + 'px';
    line.style.top = (index < tableDragState.from ? rect.top : rect.bottom) + 'px';
    line.style.width = rect.width + 'px';
    line.style.height = '2px';
  } else {
    line.style.left = (index < tableDragState.from ? rect.left : rect.right) + 'px';
    line.style.top = rect.top + 'px';
    line.style.width = '2px';
    line.style.height = rect.height + 'px';
  }
});

function endTableDrag(commit) {
  if (!tableDragState.active) return;
  const { axis, from, target } = tableDragState;
  tableDragState.active = false;
  document.documentElement.classList.remove('table-dragging-row', 'table-dragging-column');
  tableIndicator().hidden = true;
  if (commit && target !== from) {
    if (axis === 'row') moveTableRowTo(target);
    else moveTableColumnTo(target);
  }
}

window.addEventListener('mouseup', () => endTableDrag(true));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && tableDragState.active) endTableDrag(false);
});

function openTableMenu(x, y) {
  const menu = document.querySelector('#table-menu');
  if (!menu) return;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
}

editor.view.dom.addEventListener('mousemove', (event) => {
  if (rowDragFrom >= 0) return;
  const cell = event.target.closest ? event.target.closest('td, th') : null;
  if (!cell) {
    hideRowHandle();
    return;
  }
  const row = cell.closest('tr');
  const rows = rowElements();
  const index = rows.indexOf(row);
  if (index >= 0) showRowHandle(index);
});

editor.view.dom.addEventListener('mouseleave', () => {
  if (rowDragFrom < 0) hideRowHandle();
});

document.addEventListener('pointerdown', (event) => {
  if (event.target && event.target.closest && event.target.closest('#row-handle')) {
    rowDragFrom = Number(event.target.closest('#row-handle').dataset.row);
    event.preventDefault();
    return;
  }
  hideRowHandle();
});
document.addEventListener('pointermove', (event) => {
  if (rowDragFrom < 0) return;
  const rows = rowElements();
  rows.forEach((row) => row.classList.remove('row-drop-target'));
  const index = rowIndexAt(event.clientY);
  if (rows[index] && index !== rowDragFrom) rows[index].classList.add('row-drop-target');
});
document.addEventListener('pointerup', (event) => {
  if (rowDragFrom < 0) return;
  const from = rowDragFrom;
  rowDragFrom = -1;
  rowElements().forEach((row) => row.classList.remove('row-drop-target'));
  hideRowHandle();
  const to = rowIndexAt(event.clientY);
  if (to !== from) {
    const coords = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (coords) editor.chain().focus().setTextSelection(coords.pos).run();
    moveRowTo(from, to);
  }
});

editor.view.dom.addEventListener('contextmenu', (event) => {
  const cell = event.target.closest ? event.target.closest('td, th') : null;
  if (!cell) return;
  event.preventDefault();
  const coords = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (coords) editor.chain().focus().setTextSelection(coords.pos).run();
  openTableMenu(event.clientX, event.clientY);
});

document.querySelectorAll('#table-menu [data-tm]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.tm;
    closeTableMenu();
    if (action === 'moveRowUp') return moveTableRow(-1);
    if (action === 'moveRowDown') return moveTableRow(1);
    if (action === 'moveColumnLeft') return moveTableColumn(-1);
    if (action === 'moveColumnRight') return moveTableColumn(1);
    const chain = editor.chain().focus();
    if (action === 'deleteTable') chain.deleteTable().run();
    else if (typeof chain[action] === 'function') chain[action]().run();
    return true;
  });
});

document.addEventListener('mousedown', (event) => {
  const menu = document.querySelector('#table-menu');
  if (menu && !menu.hidden && !menu.contains(event.target)) closeTableMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTableMenu();
});
window.addEventListener('blur', closeTableMenu);

// Reorder by rebuilding the table; never by arithmetic on positions inside it.
function moveRowTo(from, to) {
  if (from === to || from < 0 || to < 0) return false;
  const { state } = editor;
  const { $from } = state.selection;
  let tableDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0) return false;
  const table = $from.node(tableDepth);
  const rows = [];
  table.content.forEach((row) => rows.push(row));
  if (from >= rows.length || to >= rows.length) return false;
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  const tableStart = $from.before(tableDepth);
  const replacement = table.type.create(table.attrs, rows);
  editor.view.dispatch(state.tr.replaceWith(tableStart, tableStart + table.nodeSize, replacement));
  return true;
}

// Columns move by rebuilding every row with its cells reordered. Merged cells make "the same
// column" ambiguous, so the operation is refused instead of guessing.
function moveTableRowTo(targetRow) {
  const { state } = editor;
  const { $from } = state.selection;
  let tableDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0) return false;
  const table = $from.node(tableDepth);
  const rowIndex = $from.index(tableDepth);
  const rows = [];
  table.content.forEach((row) => rows.push(row));
  if (targetRow < 0 || targetRow >= rows.length || targetRow === rowIndex) return false;
  const [moved] = rows.splice(rowIndex, 1);
  rows.splice(targetRow, 0, moved);
  const tableStart = $from.before(tableDepth);
  const replacement = table.type.create(table.attrs, rows);
  editor.view.dispatch(state.tr.replaceWith(tableStart, tableStart + table.nodeSize, replacement));
  try {
    editor.commands.setTextSelection(Math.min(tableStart + 2, editor.state.doc.content.size));
  } catch {
    /* cosmetic */
  }
  return true;
}

function moveTableColumnTo(targetColumn) {
  const { state } = editor;
  const { $from } = state.selection;
  let tableDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0) return false;
  const table = $from.node(tableDepth);
  const column = $from.index(tableDepth + 1);
  const rows = [];
  let merged = false;
  table.content.forEach((row) => {
    const cells = [];
    row.content.forEach((cell) => {
      if ((cell.attrs.colspan || 1) > 1 || (cell.attrs.rowspan || 1) > 1) merged = true;
      cells.push(cell);
    });
    rows.push({ row, cells });
  });
  if (merged) {
    flash('Column moves are not available with merged cells');
    return false;
  }
  if (targetColumn < 0 || rows.some((entry) => targetColumn >= entry.cells.length)) return false;
  if (targetColumn === column) return false;
  const tableStart = $from.before(tableDepth);
  const newRows = rows.map(({ row, cells }) => {
    const next = cells.slice();
    const [moved] = next.splice(column, 1);
    next.splice(targetColumn, 0, moved);
    return row.type.create(row.attrs, next);
  });
  const replacement = table.type.create(table.attrs, newRows);
  editor.view.dispatch(tr0(state, tableStart, table, replacement));
  try {
    editor.commands.setTextSelection(Math.min(tableStart + 2, editor.state.doc.content.size));
  } catch {
    /* cosmetic */
  }
  return true;
}

function tr0(state, tableStart, table, replacement) {
  return state.tr.replaceWith(tableStart, tableStart + table.nodeSize, replacement);
}

function moveTableColumn(direction) {
  const { state } = editor;
  const { $from } = state.selection;
  let tableDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0) return false;
  const table = $from.node(tableDepth);
  const column = $from.index(tableDepth + 1);
  const rows = [];
  let merged = false;
  table.content.forEach((row) => {
    const cells = [];
    row.content.forEach((cell) => {
      if ((cell.attrs.colspan || 1) > 1 || (cell.attrs.rowspan || 1) > 1) merged = true;
      cells.push(cell);
    });
    rows.push({ row, cells });
  });
  if (merged) {
    flash('Column moves are not available with merged cells');
    return false;
  }
  const target = column + direction;
  if (target < 0 || rows.some((entry) => target >= entry.cells.length)) return false;
  const tableStart = $from.before(tableDepth);
  const newRows = rows.map(({ row, cells }) => {
    const next = cells.slice();
    [next[column], next[target]] = [next[target], next[column]];
    return row.type.create(row.attrs, next);
  });
  const replacement = table.type.create(table.attrs, newRows);
  const tr = state.tr.replaceWith(tableStart, tableStart + table.nodeSize, replacement);
  editor.view.dispatch(tr);
  try {
    editor.commands.setTextSelection(Math.min(tableStart + 2, editor.state.doc.content.size));
  } catch {
    /* cosmetic */
  }
  return true;
}

function moveTableRow(direction) {
  if (!Number.isFinite(direction)) return false;
  const { state } = editor;
  const { $from } = state.selection;
  let tableDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0) return false;
  const table = $from.node(tableDepth);
  const rowIndex = $from.index(tableDepth);
  const target = rowIndex + direction;
  const rows = [];
  table.content.forEach((row) => rows.push(row));
  if (target < 0 || target >= rows.length) return false;
  [rows[rowIndex], rows[target]] = [rows[target], rows[rowIndex]];
  const tableStart = $from.before(tableDepth);
  const replacement = table.type.create(table.attrs, rows);
  const tr = state.tr.replaceWith(tableStart, tableStart + table.nodeSize, replacement);
  editor.view.dispatch(tr);
  // ResolvedPos has no .near(); let the editor coerce a valid text selection for us.
  try {
    editor.commands.setTextSelection(Math.min(tableStart + 2, editor.state.doc.content.size));
  } catch {
    /* the caret position is cosmetic */
  }
  return true;
}

document.querySelectorAll('[data-table]').forEach((button) => {
  button.addEventListener('click', () => {
    const op = button.dataset.table;
    const chain = editor.chain().focus();
    if (op === 'deleteTable') chain.deleteTable().run();
    else chain[op]().run();
  });
});

headingSelect.addEventListener('change', () => {
  const level = Number(headingSelect.value);
  if (level === 0) editor.chain().focus().setParagraph().run();
  else editor.chain().focus().toggleHeading({ level }).run();
});

codeLang.addEventListener('change', () => {
  editor.chain().focus().updateAttributes('codeBlock', { language: codeLang.value || null }).run();
});

// ---- slash menu -----------------------------------------------------------
// Typing "/" at the start of an empty block opens a small insert menu. The slash and the typed
// filter live in the document until an action is chosen, which keeps it simple and makes Esc
// harmless: nothing was ever swallowed.

const slashCommands = [
  { id: 'h1', label: 'Heading 1', hint: 'H1', run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', hint: 'H2', run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', hint: 'H3', run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet', label: 'Bullet list', hint: '•', run: () => editor.chain().focus().toggleBulletList().run() },
  { id: 'number', label: 'Numbered list', hint: '1.', run: () => editor.chain().focus().toggleOrderedList().run() },
  { id: 'task', label: 'Task list', hint: '☑', run: () => editor.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: 'Quote', hint: '❝', run: () => editor.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'Code block', hint: '{ }', run: () => editor.chain().focus().toggleCodeBlock().run() },
  { id: 'table', label: 'Table', hint: '▦', run: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'image', label: 'Image', hint: '🖼', run: () => document.querySelector('#image-input').click() },
  { id: 'math', label: 'Math block', hint: '$', run: () => openPopover('mathBlock', '') },
  { id: 'divider', label: 'Divider', hint: '—', run: () => editor.chain().focus().setHorizontalRule().run() },
  {
    id: 'diagram',
    label: 'Diagram',
    hint: 'Mermaid',
    run: () =>
      editor
        .chain()
        .focus()
        .insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'graph TD;' }] })
        .run(),
  },
];

const slashMenu = document.querySelector('#slash-menu');
const slashList = document.querySelector('#slash-list');
let slashFilter = '';
let slashIndex = 0;
let slashRange = null;
let slashSuppressed = false;

function closeSlashMenu({ suppress = false } = {}) {
  if (slashMenu) slashMenu.hidden = true;
  slashRange = null;
  slashFilter = '';
  slashSuppressed = suppress;
}

function slashMatches() {
  const needle = slashFilter.toLowerCase();
  return slashCommands.filter((command) => !needle || command.label.toLowerCase().includes(needle));
}

function renderSlashMenu() {
  if (!slashList) return;
  const matches = slashMatches();
  slashIndex = Math.min(slashIndex, Math.max(0, matches.length - 1));
  slashList.textContent = '';
  matches.forEach((command, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'slash-item' + (index === slashIndex ? ' is-active' : '');
    row.setAttribute('role', 'option');
    row.dataset.id = command.id;
    const label = document.createElement('span');
    label.textContent = command.label;
    const hint = document.createElement('span');
    hint.className = 'slash-hint';
    hint.textContent = command.hint;
    row.append(label, hint);
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applySlashCommand(command);
    });
    slashList.appendChild(row);
  });
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'slash-empty';
    empty.textContent = 'No matching block';
    slashList.appendChild(empty);
  }
}

function positionSlashMenu() {
  if (!slashMenu) return;
  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    const rect = slashMenu.getBoundingClientRect();
    const top = Math.min(coords.bottom + 6, window.innerHeight - rect.height - 8);
    const left = Math.min(coords.left, window.innerWidth - rect.width - 8);
    slashMenu.style.top = Math.max(8, top) + 'px';
    slashMenu.style.left = Math.max(8, left) + 'px';
  } catch {
    /* the caret may be gone */
  }
}

function applySlashCommand(command) {
  const range = slashRange;
  closeSlashMenu();
  if (!range) return;
  editor
    .chain()
    .focus()
    .deleteRange({ from: range.from, to: range.to })
    .run();
  command.run();
}

function openSlashMenu(range, filter) {
  slashRange = range;
  slashFilter = filter;
  slashIndex = 0;
  renderSlashMenu();
  positionSlashMenu();
  slashMenu.hidden = false;
}

// The document is the single source of truth for the trigger: "/" as the first character of a
// textblock, optionally followed by a filter word.
function maybeOpenSlashMenu() {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph') {
    if (slashMenu && !slashMenu.hidden) closeSlashMenu({ suppress: true });
    return;
  }
  const text = $from.parent.textContent;
  const match = /^\/([\w\u4e00-\u9fff]*)$/.exec(text);
  if (!match || $from.parentOffset !== text.length) {
    if (slashMenu && !slashMenu.hidden) closeSlashMenu({ suppress: true });
    else slashSuppressed = false;
    return;
  }
  if (slashSuppressed) return;
  const start = $from.start();
  openSlashMenu({ from: start, to: start + text.length }, match[1] || '');
}

editor.on('update', maybeOpenSlashMenu);

document.addEventListener('keydown', (event) => {
  if (!slashMenu || slashMenu.hidden) return;
  const matches = slashMatches();
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    slashIndex = (slashIndex + 1) % Math.max(1, matches.length);
    renderSlashMenu();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    slashIndex = (slashIndex - 1 + Math.max(1, matches.length)) % Math.max(1, matches.length);
    renderSlashMenu();
  } else if (event.key === 'Enter') {
    if (!matches.length) return;
    event.preventDefault();
    applySlashCommand(matches[slashIndex]);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSlashMenu({ suppress: true });
  }
});

document.addEventListener('mousedown', (event) => {
  if (slashMenu && !slashMenu.hidden && !slashMenu.contains(event.target)) closeSlashMenu({ suppress: true });
});
window.addEventListener('blur', () => closeSlashMenu({ suppress: true }));

// The editable area is a multiline textbox; name it so it is not announced as just "edit".
function labelEditor() {
  const dom = editor && editor.view ? editor.view.dom : null;
  if (!dom) return;
  if (!dom.getAttribute('role')) dom.setAttribute('role', 'textbox');
  dom.setAttribute('aria-multiline', 'true');
  dom.setAttribute('aria-label', t('editor.label', lang));
}

function syncToolbar() {
  const markState = {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code'),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    taskList: editor.isActive('taskList'),
    blockquote: editor.isActive('blockquote'),
    codeBlock: editor.isActive('codeBlock'),
    link: editor.isActive('link'),
  };
  for (const [cmd, active] of Object.entries(markState)) {
    const button = document.querySelector(`[data-cmd="${cmd}"]`);
    if (!button) continue;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (!button.getAttribute('aria-label') && button.title) {
      button.setAttribute('aria-label', button.title);
    }
  }

  let level = 0;
  for (let i = 1; i <= 4; i += 1) {
    if (editor.isActive('heading', { level: i })) { level = i; break; }
  }
  headingSelect.value = String(level);

  const inCode = editor.isActive('codeBlock');
  codeLang.hidden = !inCode;
  if (inCode) codeLang.value = editor.getAttributes('codeBlock').language || '';

  tableBar.hidden = !editor.isActive('table');
  imageBar.hidden = !editor.isActive('image');
}

// ---- image size / alignment ------------------------------------------------

function setImageMeta(patch) {
  if (!editor.isActive('image')) return;
  const current = parseImageMeta(editor.getAttributes('image').title);
  for (const [key, value] of Object.entries(patch)) {
    if (value) current[key] = value;
    else delete current[key];
  }
  const title = formatImageMeta(current);
  editor.chain().focus().updateAttributes('image', { title: title || null }).run();
  syncToolbar();
}

// Typora-style image resizing: a handle at the bottom-right corner writes the same
// w=NN% metadata the toolbar buttons use, so both paths stay in sync.
let imgResize = null;

function ensureImgHandle() {
  let handle = document.querySelector('#img-resize-handle');
  if (handle) return handle;
  handle = document.createElement('div');
  handle.id = 'img-resize-handle';
  handle.className = 'img-resize-handle';
  handle.hidden = true;
  handle.title = 'Drag to resize';
  document.body.appendChild(handle);
  return handle;
}

function hideImgHandle() {
  const handle = document.querySelector('#img-resize-handle');
  if (handle) handle.hidden = true;
}

function placeImgHandle(image) {
  const handle = ensureImgHandle();
  const rect = image.getBoundingClientRect();
  handle.style.top = rect.bottom - 11 + 'px';
  handle.style.left = rect.right - 11 + 'px';
  handle.hidden = false;
  handle.dataset.for = String([...document.querySelectorAll('.tiptap img')].indexOf(image));
}

function imageAtPoint(event) {
  const target = event.target;
  return target && target.tagName === 'IMG' && target.closest('.tiptap') ? target : null;
}

editor.view.dom.addEventListener('mousemove', (event) => {
  if (imgResize) return;
  const image = imageAtPoint(event);
  if (image) placeImgHandle(image);
  else hideImgHandle();
});
editor.view.dom.addEventListener('mouseleave', () => {
  if (!imgResize) hideImgHandle();
});

document.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest ? event.target.closest('#img-resize-handle') : null;
  if (!handle) {
    if (!event.target.closest || !event.target.closest('#img-resize-handle')) hideImgHandle();
    return;
  }
  const images = [...document.querySelectorAll('.tiptap img')];
  const image = images[Number(handle.dataset.for)];
  if (!image) return;
  event.preventDefault();
  const block = image.parentElement || editor.view.dom;
  const blockRect = block.getBoundingClientRect();
  const startWidth = image.getBoundingClientRect().width;
  imgResize = { image, blockRect, startWidth, startX: event.clientX };
  image.classList.add('is-resizing');
});

document.addEventListener('pointermove', (event) => {
  if (!imgResize) return;
  const { blockRect, startWidth, image, startX } = imgResize;
  const next = Math.max(60, Math.min(blockRect.width, startWidth + (event.clientX - startX)));
  const percent = Math.max(10, Math.min(100, Math.round((next / blockRect.width) * 100 / 5) * 5));
  image.style.width = percent + '%';
  image.dataset.pendingWidth = String(percent);
});

document.addEventListener('pointerup', () => {
  if (!imgResize) return;
  const { image } = imgResize;
  const percent = image.dataset.pendingWidth;
  imgResize = null;
  image.classList.remove('is-resizing');
  delete image.dataset.pendingWidth;
  hideImgHandle();
  if (!percent) return;
  // Select the image so updateAttributes targets it, then write the metadata.
  try {
    const pos = editor.view.posAtDOM(image, 0);
    editor.chain().focus().setNodeSelection(Math.max(0, pos - 1)).run();
  } catch {
    /* selecting is best effort */
  }
  if (!editor.isActive('image')) return;
  setImageMeta({ w: percent + '%' });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideImgHandle();
});
window.addEventListener('scroll', hideImgHandle, true);

document.querySelectorAll('[data-img]').forEach((button) => {
  button.addEventListener('click', () => {
    const [key, value] = button.dataset.img.split(':');
    setImageMeta({ [key]: value || null });
  });
});

// A single stroke-based icon set keeps the toolbar visually consistent across themes;
// the text glyphs it replaces looked different on every platform.
const TOOLBAR_ICONS = {
  bold: "<path d=\"M7 5h6a4 4 0 0 1 0 8H7zM7 13h7a4 4 0 0 1 0 8H7z\"/>",
  italic: "<path d=\"M10 5h8M6 21h8M14 5l-4 16\"/>",
  strike: "<path d=\"M5 12h14M8 7a4 4 0 0 1 4-2c2 0 4 1 4 3M8 17a4 4 0 0 0 4 2c2 0 4-1 4-3\"/>",
  code: "<path d=\"m9 8-5 4 5 4M15 8l5 4-5 4\"/>",
  bulletList: "<path d=\"M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01\"/>",
  orderedList: "<path d=\"M10 6h11M10 12h11M10 18h11M4 5h1v4M4 15h1.5a1 1 0 0 1 0 2H4v2h2\"/>",
  taskList: "<path d=\"M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9\"/>",
  blockquote: "<path d=\"M7 7h4v4H7zM7 11c0 3-1 5-3 6M15 7h4v4h-4zM15 11c0 3-1 5-3 6\"/>",
  codeBlock: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"m9 10-2 2 2 2M15 10l2 2-2 2\"/>",
  link: "<path d=\"M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1\"/>",
  table: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 10h18M9 10v10M15 10v10\"/>",
  image: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><circle cx=\"8.5\" cy=\"9.5\" r=\"1.5\"/><path d=\"m21 16-5-5L5 20\"/>",
  mathInline: "<path d=\"M4 8c0-2 1-3 3-3M7 5l10 14M17 19c2 0 3-1 3-3\" /><path d=\"M14 5h4M6 19h4\"/>",
  mathBlock: "<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"M8 9l-2 3 2 3M16 9l2 3-2 3M12 9v6\"/>",
  ai: "<path d=\"M12 4v4M12 16v4M4 12h4M16 12h4M7.5 7.5l2 2M14.5 14.5l2 2M16.5 7.5l-2 2M9.5 14.5l-2 2\"/><circle cx=\"12\" cy=\"12\" r=\"2.5\"/>",
};

// The same stroke language as the toolbar, for the chrome around it: emoji and stray Unicode
// glyphs made the top bar look like a different application on every platform.
const UI_ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 20.7 7l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  folder:
    '<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  chevronLeft: '<path d="m14 6-6 6 6 6"/>',
  chevronRight: '<path d="m10 6 6 6-6 6"/>',
  chevronUp: '<path d="m6 14 6-6 6 6"/>',
  chevronDown: '<path d="m6 10 6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  alignLeft: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  alignCenter: '<path d="M4 6h16M7 12h10M6 18h12"/>',
  alignRight: '<path d="M4 6h16M10 12h10M7 18h13"/>',
  sparkle:
    '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M7.5 7.5l2 2M14.5 14.5l2 2M16.5 7.5l-2 2M9.5 14.5l-2 2"/><circle cx="12" cy="12" r="2.5"/>',
};

function uiIcon(name, size = 16) {
  const body = UI_ICONS[name] || '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function applyStaticIcons(scope = document) {
  for (const button of scope.querySelectorAll('[data-icon]')) {
    const name = button.dataset.icon;
    if (!UI_ICONS[name]) continue;
    button.innerHTML = uiIcon(name, Number(button.dataset.iconSize) || 16);
    button.classList.add('icon-button');
    if (!button.getAttribute('aria-label')) {
      button.setAttribute('aria-label', button.title || name);
    }
  }
}

applyStaticIcons();

function toolbarIcon(name) {
  const body = TOOLBAR_ICONS[name] || '';
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

for (const button of document.querySelectorAll('.toolbar [data-cmd]')) {
  const name = button.dataset.cmd;
  if (!TOOLBAR_ICONS[name]) continue;
  button.innerHTML = toolbarIcon(name);
  button.classList.add('icon-button');
  if (button.title) button.setAttribute('aria-label', button.title);
  else if (button.dataset.i18n) button.setAttribute('aria-label', button.textContent.trim());
}

// ---- link / math popover ---------------------------------------------------

let popoverMode = null;
let editingMathPos = null;

function renderMathPreview() {
  const preview = document.querySelector('#link-preview');
  if (!preview) return;
  if (popoverMode !== 'mathInline' && popoverMode !== 'mathBlock') {
    preview.hidden = true;
    preview.textContent = '';
    return;
  }
  const latex = linkInput.value.trim();
  if (!latex) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;
  try {
    preview.innerHTML = katex.renderToString(latex, {
      throwOnError: true,
      displayMode: popoverMode === 'mathBlock',
    });
    preview.classList.remove('is-error');
  } catch (err) {
    preview.textContent = String(err.message || err).slice(0, 120);
    preview.classList.add('is-error');
  }
}

function openPopover(mode, value) {
  editingMathPos = null;
  popoverMode = mode;
  linkInput.value = value;
  linkInput.placeholder = mode === 'link' ? 'https://example.com' : 'LaTeX, e.g. a^2 + b^2 = c^2';
  $('#link-apply').textContent = mode === 'link' ? 'Apply' : 'Insert';
  $('#link-remove').hidden = mode !== 'link';
  linkPopover.hidden = false;
  renderMathPreview();
  linkInput.focus();
  linkInput.select();
}

function closePopover() {
  linkPopover.hidden = true;
  popoverMode = null;
  editingMathPos = null;
  const preview = document.querySelector('#link-preview');
  if (preview) {
    preview.hidden = true;
    preview.textContent = '';
  }
}

function applyPopover() {
  const value = linkInput.value.trim();
  if (popoverMode === 'link') {
    if (value) editor.chain().focus().extendMarkRange('link').setLink({ href: value }).run();
    else editor.chain().focus().unsetLink().run();
  } else if (popoverMode === 'mathInline' || popoverMode === 'mathBlock') {
    if (editingMathPos !== null) {
      // Rewrite the formula that was clicked instead of appending a second one.
      const pos = editingMathPos;
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          const node = tr.doc.nodeAt(pos);
          if (!node) return false;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: value });
          return true;
        })
        .run();
    } else if (value) {
      if (popoverMode === 'mathInline') editor.chain().focus().insertInlineMath({ latex: value }).run();
      else editor.chain().focus().insertBlockMath({ latex: value }).run();
    }
  }
  closePopover();
}

linkInput.addEventListener('input', renderMathPreview);

$('#link-apply').addEventListener('click', applyPopover);
$('#link-remove').addEventListener('click', () => {
  editor.chain().focus().unsetLink().run();
  closePopover();
});
linkInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); applyPopover(); }
  if (event.key === 'Escape') { event.preventDefault(); closePopover(); }
});

// ---- images ----------------------------------------------------------------

// Screenshots and phone photos arrive far larger than a document needs. Shrink them before they
// are written: a 3 MB PNG becomes a few hundred KB, which keeps the markdown, the exports and any
// sync folder reasonable.
const IMAGE_MAX_DIM = 2200;
const IMAGE_MAX_BYTES = 1_200_000;

function formatBytes(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function imageHasAlpha(bitmap) {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size, size);
  try {
    const data = ctx.getImageData(0, 0, size, size).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
  } catch {
    /* a tainted canvas cannot be sampled; assume no transparency */
  }
  return false;
}

async function optimizeImage(file) {
  const originalBytes = file.size;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    return { file, originalBytes, bytes: originalBytes, changed: false, error: String(err && err.message ? err.message : err) };
  }
  const oversized =
    Math.max(bitmap.width, bitmap.height) > IMAGE_MAX_DIM || originalBytes > IMAGE_MAX_BYTES;
  if (!oversized) {
    const natural = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return { file, originalBytes, bytes: originalBytes, changed: false, ...natural };
  }
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const alpha = await imageHasAlpha(bitmap);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  // Encode both and keep the smaller one: JPEG wins on photos, PNG wins on screenshots of text.
  const encode = (type, quality) =>
    new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  const candidates = [];
  if (!alpha) candidates.push(await encode('image/jpeg', 0.85));
  candidates.push(await encode('image/png'));
  const best = candidates.filter(Boolean).sort((a, b) => a.size - b.size)[0];
  if (!best || best.size >= originalBytes) {
    return {
      file,
      originalBytes,
      bytes: originalBytes,
      changed: false,
      debug: { width, height, alpha, best: best ? best.size : null, type: best ? best.type : null },
    };
  }
  const ext = best.type === 'image/png' ? '.png' : '.jpg';
  const name = (file.name || 'image').replace(/.[a-z0-9]+$/i, '') + ext;
  return {
    file: new File([best], name, { type: best.type }),
    originalBytes,
    bytes: best.size,
    changed: true,
    width,
    height,
  };
}

async function insertImageFile(file) {
  const optimized = await optimizeImage(file);
  if (optimized.changed) {
    showToast('Image ' + formatBytes(optimized.originalBytes) + ' → ' + formatBytes(optimized.bytes), 4000);
  }
  const source = optimized.file;
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(source);
  });
  const saved = await window.api.saveImage({ dataUrl, ext: source.type.split('/')[1] });
  editor.chain().focus().setImage({ src: saved.fileUrl }).run();
}

$('#image-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) await insertImageFile(file);
  event.target.value = '';
});

document.addEventListener('paste', async (event) => {
  const item = [...(event.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  const file = item && item.getAsFile();
  if (!file) return;
  event.preventDefault();
  await insertImageFile(file);
});

// A pasted block that is clearly markdown (fences, a heading with a blank line, a table rule or
// several list items) is parsed, not inserted as literal text. A single "#tag" stays text.
function looksLikeMarkdown(text) {
  if (!text || text.length < 8) return false;
  const value = String(text);
  if (/^(?:\s*)(?:\`\`\`|~~~)/m.test(value)) return true;
  if (/\|/.test(value) && /^\s*\|?\s*:?-{3,}/m.test(value)) return true;
  if (/^#{1,6}\s+\S/m.test(value) && /^#{1,6}\s+\S[^\n]*\n\s*\n/m.test(value)) return true;
  const listItems = value.match(/^\s*(?:[-*+]|\d+\.)\s+\S/gm) || [];
  return listItems.length >= 2;
}

document.addEventListener('paste', (event) => {
  const html = event.clipboardData?.getData('text/html');
  if (html) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!looksLikeMarkdown(text)) return;
  event.preventDefault();
  editor.chain().focus().insertContent(text, { contentType: 'markdown' }).run();
  flash('Pasted as Markdown');
});

// Tell the user when pasted HTML carried structure the editor cannot model.
const SUPPORTED_PASTE_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
  'STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'U', 'A', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TFOOT',
  'TR', 'TD', 'TH', 'HR', 'BR', 'DIV', 'SPAN', 'INPUT', 'FIGURE', 'FIGCAPTION', 'SUB', 'SUP',
]);

document.addEventListener('paste', (event) => {
  const html = event.clipboardData?.getData('text/html');
  if (!html) return;
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    let dropped = 0;
    for (const element of parsed.body.querySelectorAll('*')) {
      if (!SUPPORTED_PASTE_TAGS.has(element.tagName)) dropped += 1;
    }
    if (dropped > 0) {
      setTimeout(() => {
        flash(`Pasted content simplified — ${dropped} unsupported element${dropped === 1 ? '' : 's'}`);
      }, 0);
    }
  } catch {
    /* never let diagnostics break a paste */
  }
});

document.addEventListener('drop', async (event) => {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();

  const image = files.find((f) => f.type.startsWith('image/'));
  if (image) {
    await insertImageFile(image);
    return;
  }

  // Anything else that looks like a document opens in a tab.
  const documents = files
    .filter((f) => /\.(md|markdown|txt)$/i.test(f.name))
    .map((f) => window.api.pathForFile(f))
    .filter(Boolean);
  for (const path of documents) {
    await flushChange();
    await window.api.openPath(path);
  }
});

// ---- outline ---------------------------------------------------------------

function outlineItems() {
  const items = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    const text = node.textContent.trim();
    if (text) items.push({ depth: node.attrs.level, text, pos });
  });
  return items;
}

let lastOutlineMs = 0;

// The heading that owns the caret is the one worth marking; it also tells the user where they
// are in a long document without reading the text.
function markCurrentOutline(at = editor.state.selection.from) {
  const items = outlineItems();
  if (!items.length) return;
  const caret = at;
  let index = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].pos <= caret) index = i;
    else break;
  }
  const nodes = [...outlineList.querySelectorAll('.outline-item')];
  nodes.forEach((node, i) => {
    const isCurrent = i === index;
    node.classList.toggle('is-current', isCurrent);
    // Screen readers otherwise never learn which section the caret is in.
    if (isCurrent) node.setAttribute('aria-current', 'location');
    else node.removeAttribute('aria-current');
  });
  const current = nodes[index];
  if (current && typeof current.scrollIntoView === 'function') {
    const box = outlineList.getBoundingClientRect();
    const rect = current.getBoundingClientRect();
    if (rect.top < box.top || rect.bottom > box.bottom) {
      current.scrollIntoView({ block: 'nearest' });
    }
  }
}

const collapsedHeadings = new Set();

function renderOutline() {
  const startedAt = performance.now();
  const items = outlineItems();
  outlineList.textContent = '';
  // Sections fold: a heading with children gets a twisty; folding hides everything until the next
  // heading of the same or a shallower level.
  let skipDeeperThan = Infinity;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.depth > skipDeeperThan) continue;
    skipDeeperThan = Infinity;

    const next = items[index + 1];
    const hasChildren = Boolean(next && next.depth > item.depth);
    const key = item.depth + ':' + item.text;
    const folded = collapsedHeadings.has(key);
    if (folded && hasChildren) skipDeeperThan = item.depth;

    const row = document.createElement('div');
    row.className = 'outline-row';
    row.dataset.pos = String(item.pos);
    const twisty = document.createElement('button');
    twisty.type = 'button';
    twisty.className = 'outline-twisty' + (folded ? ' is-folded' : '') + (hasChildren ? '' : ' is-empty');
    twisty.setAttribute('aria-expanded', folded ? 'false' : 'true');
    twisty.title = folded ? 'Expand section' : 'Collapse section';
    twisty.textContent = '▾';
    if (hasChildren) {
      twisty.addEventListener('click', (event) => {
        event.stopPropagation();
        if (folded) collapsedHeadings.delete(key);
        else collapsedHeadings.add(key);
        renderOutline();
      });
    } else {
      twisty.tabIndex = -1;
    }
    row.appendChild(twisty);

    const link = document.createElement('a');
    link.className = 'outline-item depth-' + item.depth;
    link.textContent = item.text;
    link.addEventListener('click', () => {
      recordJump();
      editor.commands.focus(item.pos + 1);
      const dom = editor.view.nodeDOM(item.pos);
      if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    row.appendChild(link);
    outlineList.appendChild(row);
  }
  outlineList.hidden = items.length === 0;
  const outlineEmpty = document.querySelector('#outline-empty');
  if (outlineEmpty) outlineEmpty.hidden = items.length > 0;
  const count = document.querySelector('#outline-count');
  if (count) count.textContent = items.length ? String(items.length) : '';
  markCurrentOutline();
  lastOutlineMs = performance.now() - startedAt;
}

// Clicking a rendered formula reopens it in the popover with a live preview.
function openMathAtClick(event) {
  const target = event.target.closest ? event.target.closest('.katex, .katex-display') : null;
  if (!target) return false;
  const coords = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return false;
  const node = editor.state.doc.nodeAt(coords.pos);
  if (!node || (node.type.name !== 'inlineMath' && node.type.name !== 'blockMath')) return false;
  event.preventDefault();
  const value = (node.attrs && node.attrs.latex) || '';
  openPopover(node.type.name === 'blockMath' ? 'mathBlock' : 'mathInline', value);
  // openPopover clears the edit target, so remember it afterwards.
  editingMathPos = coords.pos;
  return true;
}

function headingSlug(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

// [text](#heading) scrolls inside the document; it never leaves the app.
function scrollToAnchor(raw) {
  const needle = decodeURIComponent(String(raw || '')).toLowerCase().replace(/^#/, '');
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== 'heading') return true;
    const slug = headingSlug(node.textContent);
    if (slug === needle || node.textContent.trim().toLowerCase() === needle) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  if (found === null) {
    flash('No heading matches #' + needle);
    return false;
  }
  editor.commands.focus(found);
  const dom = editor.view.nodeDOM(found - 1);
  if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

function handleLinkClick(event) {
  const anchor = event.target.closest ? event.target.closest('a[href]') : null;
  if (!anchor) return false;
  // Never let the click navigate the app window.
  event.preventDefault();
  const href = (anchor.getAttribute('href') || '').trim();
  if (!href) return true;

  if (href.startsWith('#')) {
    scrollToAnchor(href);
    return true;
  }

  const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
  if (external) {
    if (shouldOpenExternal(event)) window.api.openExternal(href).catch(() => {});
    return true;
  }

  // A relative link belongs to the document's folder: open it in a tab.
  window.api
    .openRelativeLink(href)
    .then((result) => {
      if (result && result.opened === false) {
        if (result.reason === 'missing') flash('Link target not found: ' + (result.name || href));
        else if (result.reason === 'unsaved') flash('Save this document first, then its relative links work');
      }
    })
    .catch(() => {});
  return true;
}

let outlineScrollFrame = 0;
function syncOutlineToScroll() {
  if (outlineScrollFrame) return;
  outlineScrollFrame = requestAnimationFrame(() => {
    outlineScrollFrame = 0;
    const rect = blockPane ? blockPane.getBoundingClientRect() : null;
    if (!rect) return;
    const coords = editor.view.posAtCoords({ left: rect.left + 40, top: rect.top + 16 });
    if (coords) markCurrentOutline(coords.pos);
  });
}
const outlineScrollPane = document.querySelector('.editor-pane');
if (outlineScrollPane) outlineScrollPane.addEventListener('scroll', syncOutlineToScroll, { passive: true });

editor.view.dom.addEventListener('click', handleLinkClick);
editor.view.dom.addEventListener('auxclick', handleLinkClick);
editor.view.dom.addEventListener('click', openMathAtClick);

// ---- jump history ----------------------------------------------------------
// Alt+Left / Alt+Right walk the places you jumped from, so a jump into a long document is always
// reversible. History is per tab and a new jump truncates the forward stack.

const navHistory = new Map();

function navKey() {
  return activeTabId || 'untitled';
}

function navStacks() {
  const key = navKey();
  if (!navHistory.has(key)) navHistory.set(key, { back: [], forward: [] });
  return navHistory.get(key);
}

function pushNav(pos) {
  if (!Number.isFinite(pos)) return;
  const stacks = navStacks();
  if (stacks.back[stacks.back.length - 1] !== pos) stacks.back.push(pos);
  if (stacks.back.length > 100) stacks.back.shift();
  stacks.forward.length = 0;
}

function recordJump() {
  pushNav(editor.state.selection.from);
}

function scrollToPos(pos) {
  try {
    const coords = editor.view.coordsAtPos(pos);
    const pane = document.querySelector('.editor-pane');
    if (!pane || !coords) return;
    const paneRect = pane.getBoundingClientRect();
    if (coords.top < paneRect.top + 20 || coords.top > paneRect.bottom - 60) {
      pane.scrollTop += coords.top - paneRect.top - paneRect.height / 3;
    }
  } catch {
    /* the position may be gone */
  }
}

function navTo(pos) {
  if (!Number.isFinite(pos)) return false;
  editor.commands.setTextSelection(Math.max(1, Math.min(pos, editor.state.doc.content.size - 1)));
  scrollToPos(pos);
  editor.commands.focus();
  return true;
}

function navBack() {
  const stacks = navStacks();
  if (!stacks.back.length) return false;
  const pos = stacks.back.pop();
  stacks.forward.push(editor.state.selection.from);
  return navTo(pos);
}

function navForward() {
  const stacks = navStacks();
  if (!stacks.forward.length) return false;
  const pos = stacks.forward.pop();
  stacks.back.push(editor.state.selection.from);
  return navTo(pos);
}

document.addEventListener('keydown', (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    navBack();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    navForward();
  }
});

let outlineTimer = null;

editor.on('update', () => {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => renderOutline(), 120);
});
editor.on('selectionUpdate', () => {
  if (!aiPopover.hidden) {
    updateContextNote();
    refreshAiTargetChip();
    refreshAiTargetPreview();
    const { from, to, empty } = editor.state.selection;
    aiSelection = empty ? aiSelection : { from, to, text: editor.state.doc.textBetween(from, to, ' ') };
    const tr = editor.state.tr.setMeta('aiTargetRefresh', Date.now());
    editor.view.dispatch(tr);
  }
  updateActiveBlock();
  markCurrentOutline();
});
editor.on('update', updateActiveBlock);
// ---- focus mode -------------------------------------------------------------

// Dark themes need a higher floor: 0.32 over a near-black page leaves the dimmed text almost
// invisible, which reads as a rendering bug rather than a deliberate fade.
function focusDimFactor() {
  const theme = document.documentElement.dataset.theme || 'light';
  if (theme === 'dark') return 0.45;
  if (theme === 'sepia') return 0.38;
  return 0.32;
}

function updateActiveBlock() {
  const dom = editor.view.dom;
  dom.classList.toggle('focus-mode', focusModeEnabled);
  const active = focusModeEnabled ? dom.querySelector('.is-active-block') : null;
  const dim = focusDimFactor();
  for (const child of dom.children) {
    if (!focusModeEnabled) child.style.opacity = '';
    else child.style.opacity = child === active ? '1' : String(dim);
  }
}

function setFocusMode(on) {
  focusModeEnabled = Boolean(on);
  // Recompute the decoration once. Dispatching from inside updateActiveBlock would loop,
  // because the meta transaction itself fires the editor's update event.
  try {
    editor.view.dispatch(editor.state.tr.setMeta('focusModeRefresh', Date.now()));
  } catch {
    /* the view may not be ready */
  }
  document.documentElement.classList.toggle('focus-mode-on', focusModeEnabled);
  updateActiveBlock();
  window.api.setSettings({ focusMode: focusModeEnabled }).catch(() => {});
  return focusModeEnabled;
}

function toggleFocusMode() {
  return setFocusMode(!focusModeEnabled);
}

editor.on('selectionUpdate', () => {
  if (!aiPopover.hidden) updateContextNote();
  updateActiveBlock();
});
editor.on('update', updateActiveBlock);


// ---- writing history ---------------------------------------------------------

async function openWritingHistory() {
  const modal = document.querySelector('#writing-history');
  const bars = document.querySelector('#writing-history-bars');
  const summary = document.querySelector('#writing-history-summary');
  const history = await window.api.writingHistory();
  const peak = Math.max(1, ...history.days.map((day) => day.words));
  summary.textContent =
    history.total + ' words in 14 days · ' + history.streak + ' day streak · best ' + history.best +
    (history.goal ? ' · goal ' + history.goal : '');
  bars.textContent = '';
  for (const day of history.days) {
    const column = document.createElement('div');
    column.className = 'writing-history-day' + (day.reached ? ' is-reached' : '');
    const bar = document.createElement('div');
    bar.className = 'writing-history-bar';
    const height = day.words ? Math.max(4, Math.round((day.words / peak) * 100)) : 2;
    bar.style.height = height + '%';
    bar.title = day.date + ': ' + day.words + ' words';
    const label = document.createElement('span');
    label.className = 'writing-history-label';
    label.textContent = day.date.slice(5);
    column.append(bar, label);
    bars.append(column);
  }
  modal.hidden = false;
}

document.querySelector('#writing-history-close')?.addEventListener('click', () => {
  document.querySelector('#writing-history').hidden = true;
});

// clicking the goal indicator opens the history
document.querySelector('#writing-status')?.addEventListener('click', () => {
  openWritingHistory();
});

// ---- structure report --------------------------------------------------------

// Set a heading's level by index, keeping its text and any marks on it.
// Split the paragraph that starts with this text into several paragraphs at sentence boundaries.
// Only plain text is split: an inline atom or a mark spanning a cut would need fragment surgery that
// is not worth guessing at, so those paragraphs are left alone with a message.
function splitParagraphBySnippet(snippet) {
  const needle = String(snippet || '').trim().slice(0, 40);
  if (!needle) return 0;
  const paragraphType = editor.schema.nodes.paragraph;
  let target = null;
  editor.state.doc.descendants((node, pos) => {
    if (target !== null) return false;
    if (node.type.name === 'paragraph' && node.textContent.trim().startsWith(needle)) {
      target = { node, pos };
      return false;
    }
    return true;
  });
  if (!target) return 0;
  const { node, pos } = target;
  if (node.content.size !== node.textContent.length) {
    flash('This paragraph mixes images or inline atoms; split it by hand');
    return 0;
  }
  const text = node.textContent;
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+["'”’)]?\s*/g) || [text];
  if (sentences.length < 2) return 0;
  // group sentences until the chunk is close to 600 characters
  const groups = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer && (buffer + sentence).length > 600) {
      groups.push(buffer);
      buffer = '';
    }
    buffer += sentence;
  }
  if (buffer) groups.push(buffer);
  if (groups.length < 2) return 0;
  let offset = 0;
  const nodes = groups.map((group) => {
    const fragment = node.cut(offset, offset + group.length);
    offset += group.length;
    return paragraphType.create(node.attrs, fragment);
  });
  const tr = editor.state.tr.replaceWith(pos, pos + node.nodeSize, nodes);
  editor.view.dispatch(tr.scrollIntoView());
  flash('Split into ' + nodes.length + ' paragraphs');
  return nodes.length;
}

function setHeadingLevel(index, level) {
  const headingType = editor.schema.nodes.heading;
  if (!headingType) return false;
  let target = null;
  let count = 0;
  editor.state.doc.descendants((node, pos) => {
    if (target !== null) return false;
    if (node.type.name === 'heading') {
      if (count === index) {
        target = { pos, node };
        return false;
      }
      count += 1;
    }
    return true;
  });
  if (!target) return false;
  const attrs = { ...target.node.attrs, level: Math.max(1, Math.min(6, level)) };
  editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos, headingType, attrs));
  return true;
}

// Rename a heading by index; the text is replaced as a whole, so old marks do not leak into the new title.
function renameHeading(index, text) {
  let target = null;
  let count = 0;
  editor.state.doc.descendants((node, pos) => {
    if (target !== null) return false;
    if (node.type.name === 'heading') {
      if (count === index) {
        target = { pos, node };
        return false;
      }
      count += 1;
    }
    return true;
  });
  if (!target) return false;
  const content = text
    ? editor.schema.text(text)
    : editor.schema.text('');
  const heading = target.node.type.create({ ...target.node.attrs }, content ? [content] : []);
  editor.view.dispatch(editor.state.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, heading));
  return true;
}

function focusNthHeading(index) {
  let count = 0;
  let target = null;
  editor.state.doc.descendants((node, pos) => {
    if (target !== null) return false;
    if (node.type.name === 'heading') {
      if (count === index) {
        target = pos + 1;
        return false;
      }
      count += 1;
    }
    return true;
  });
  if (target === null) return false;
  editor.commands.focus(target);
  return true;
}

// The report as a markdown checklist, so it can be archived or handed to someone else.
function buildStructureMarkdown(report, filePath) {
  const name = filePath ? filePath.split(/[\\/]/).pop() : 'Untitled';
  const lines = [];
  lines.push('# Structure report — ' + name, '');
  lines.push(
    'Generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') +
      ' · ' + report.words + ' words · ' + report.headings.length + ' headings · ~' + report.readingMinutes + ' min read'
  );
  lines.push('');
  lines.push('## Counts', '');
  lines.push('- Headings: ' + report.counts.headings);
  lines.push('- Paragraphs: ' + report.counts.paragraphs);
  lines.push('- Code blocks: ' + report.counts.codeBlocks);
  lines.push('- Tables: ' + report.counts.tables);
  lines.push('- Images: ' + report.counts.images);
  lines.push('- Links: ' + report.counts.links);
  lines.push('- Task items: ' + report.counts.tasks);
  lines.push('');
  lines.push('## Checklist', '');
  let issues = 0;
  for (const skip of report.skips) {
    issues += 1;
    lines.push('- [ ] Heading "' + skip.text + '" jumps from H' + skip.from + ' to H' + skip.to + ' (line ' + skip.line + ')');
  }
  for (const duplicate of report.duplicates) {
    issues += 1;
    lines.push('- [ ] Duplicate heading "' + duplicate.text + '" (line ' + duplicate.line + ')');
  }
  if (report.longestParagraph && report.longestParagraph.chars > 1200) {
    issues += 1;
    lines.push('- [ ] Paragraph of ' + report.longestParagraph.chars + ' characters (line ' + report.longestParagraph.line + ')');
  }
  if (report.previous) {
    const change = report.previous.issues === issues
      ? 'unchanged'
      : (report.previous.issues > issues ? '−' : '+') + Math.abs(report.previous.issues - issues);
    lines.push(
      'Previous report (' + String(report.previous.at || '').slice(0, 10) + '): ' + report.previous.issues +
        ' issue(s), now ' + issues + ' (' + change + ')', ''
    );
  }
  if (!issues) lines.push('- [x] No structural problems found');
  lines.push('');
  return { text: lines.join('\n'), issues };
}

function structureSummary(report) {
  return {
    issues: report.skips.length + report.duplicates.length + (report.longestParagraph && report.longestParagraph.chars > 1200 ? 1 : 0),
    words: report.words,
    headings: report.headings.length,
  };
}

async function saveStructureReport(report) {
  const audit = report || (await window.api.docStructure());
  const built = buildStructureMarkdown(audit, audit.file);
  const summary = structureSummary(audit);
  const base = audit.file ? audit.file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : 'document';
  const result = await window.api.saveReport(built.text, base + '-structure.md', summary);
  if (result && result.ok) {
    flash('Report saved: ' + (result.path || '').split(/[\\/]/).pop());
    showToast('Structure report saved', 4000, [
      { label: 'Show in folder', run: () => window.api.revealExportedFile(result.path) },
    ]);
  } else if (result && result.error) {
    flash('Could not save the report: ' + result.error);
  }
  return result;
}

async function openStructureReport() {
  const modal = document.querySelector('#structure-report');
  const list = document.querySelector('#structure-issues');
  const summary = document.querySelector('#structure-summary');
  const report = await window.api.docStructure();
  summary.textContent =
    report.words + ' words · ' + report.headings.length + ' headings · ' +
    report.counts.paragraphs + ' paragraphs · ~' + report.readingMinutes + ' min read' +
    (report.previous
      ? ' · previous report: ' + report.previous.issues + ' issue(s)'
      : '');
  list.textContent = '';

  const issues = [];
  for (const skip of report.skips) {
    issues.push({
      kind: 'level',
      text: 'Heading "' + skip.text + '" jumps from H' + skip.from + ' to H' + skip.to,
      line: skip.line,
      heading: report.headings.find((heading) => heading.line === skip.line),
      from: skip.from,
      to: skip.to,
      fixable: true,
    });
  }
  for (const duplicate of report.duplicates) {
    issues.push({
      kind: 'duplicate',
      text: 'Duplicate heading "' + duplicate.text + '"',
      line: duplicate.line,
      heading: report.headings.find((heading) => heading.line === duplicate.line),
      fixable: true,
    });
  }
  if (report.longestParagraph && report.longestParagraph.chars > 1200) {
    issues.push({
      kind: 'paragraph',
      text: 'A paragraph of ' + report.longestParagraph.chars + ' characters (line ' + report.longestParagraph.line + ')',
      line: report.longestParagraph.line,
      snippet: report.longestParagraph.snippet,
      fixable: true,
    });
  }
  if (!issues.length) {
    const empty = document.createElement('div');
    empty.className = 'drafts-empty';
    empty.textContent = 'No structural problems found.';
    list.append(empty);
  }
  for (const issue of issues) {
    const row = document.createElement('div');
    row.className = 'image-audit-row';
    row.dataset.kind = issue.kind;
    row.dataset.line = String(issue.line);
    const name = document.createElement('span');
    name.className = 'image-audit-name';
    name.textContent = issue.text;
    const kind = document.createElement('span');
    kind.className = 'image-audit-kind';
    kind.textContent = issue.kind;
    row.append(name, kind);
    if (issue.kind === 'paragraph' && issue.snippet) {
      const split = document.createElement('button');
      split.type = 'button';
      split.className = 'image-audit-fix';
      split.textContent = 'Split';
      split.title = 'Break this paragraph at sentence boundaries';
      split.addEventListener('click', async () => {
        modal.hidden = true;
        splitParagraphBySnippet(issue.snippet);
      });
      row.append(split);
    }
    if (issue.heading && issue.kind === 'level') {
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'image-audit-fix';
      fix.textContent = 'Fix';
      fix.title = 'Set this heading one level below the previous one';
      fix.addEventListener('click', async () => {
        setHeadingLevel(issue.heading.index, Math.max(1, Math.min(6, issue.from + 1)));
        await openStructureReport();
      });
      row.append(fix);
    }
    if (issue.heading && issue.kind === 'duplicate') {
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'image-audit-fix';
      rename.textContent = 'Rename…';
      rename.title = 'Give this heading a unique title';
      rename.addEventListener('click', async () => {
        const next = await askName({
          title: 'Heading text',
          value: issue.heading.text,
          hint: 'Duplicate headings make export anchors collide.',
          confirmLabel: 'Rename',
        });
        if (!next || next === issue.heading.text) return;
        renameHeading(issue.heading.index, next);
        await openStructureReport();
      });
      row.append(rename);
    }
    if (issue.heading) {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'image-audit-remove';
      jump.textContent = 'Go';
      jump.addEventListener('click', async () => {
        modal.hidden = true;
        focusNthHeading(issue.heading.index);
      });
      row.append(jump);
    }
    list.append(row);
  }
  modal.hidden = false;
}

document.querySelector('#structure-save')?.addEventListener('click', async () => {
  await saveStructureReport();
});

document.querySelector('#structure-close')?.addEventListener('click', () => {
  document.querySelector('#structure-report').hidden = true;
});

// ---- link audit --------------------------------------------------------------

// Replace a link target everywhere it appears, keeping the text and its other marks.
function relinkHref(from, to) {
  const linkType = editor.schema.marks.link;
  if (!linkType) return 0;
  const ranges = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type === linkType && mark.attrs.href === from)) {
      ranges.push([pos, pos + node.nodeSize]);
    }
    return true;
  });
  if (!ranges.length) return 0;
  let tr = editor.state.tr;
  for (const [start, end] of ranges) {
    tr = tr.removeMark(start, end, linkType);
    tr = tr.addMark(start, end, linkType.create({ href: to }));
  }
  editor.view.dispatch(tr);
  return ranges.length;
}

function unlinkHref(href) {
  const linkType = editor.schema.marks.link;
  if (!linkType) return 0;
  const ranges = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type === linkType && mark.attrs.href === href)) {
      ranges.push([pos, pos + node.nodeSize]);
    }
    return true;
  });
  if (!ranges.length) return 0;
  let tr = editor.state.tr;
  for (const [from, to] of ranges) tr = tr.removeMark(from, to, linkType);
  editor.view.dispatch(tr);
  return ranges.length;
}

async function openLinkAudit() {
  const modal = document.querySelector('#link-audit');
  const list = document.querySelector('#link-audit-list');
  const summary = document.querySelector('#link-audit-summary');
  const audit = await window.api.linksAudit();
  list.textContent = '';
  const parts = [`${audit.total} link${audit.total === 1 ? '' : 's'}`];
  if (audit.missing) parts.push(`${audit.missing} missing`);
  if (audit.external) parts.push(`${audit.external} external`);
  if (audit.anchors) parts.push(`${audit.anchors} anchor`);
  summary.textContent = parts.join(' · ');
  if (!audit.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'drafts-empty';
    empty.textContent = 'This document has no links.';
    list.append(empty);
  }
  for (const entry of audit.entries) {
    const row = document.createElement('div');
    row.className = 'image-audit-row' + (entry.exists === false ? ' is-missing' : '');
    row.dataset.href = entry.href;
    const name = document.createElement('span');
    name.className = 'image-audit-name';
    name.textContent = entry.label || entry.href;
    name.title = entry.href;
    const kind = document.createElement('span');
    kind.className = 'image-audit-kind';
    kind.textContent = entry.kind;
    const status = document.createElement('span');
    status.className = 'image-audit-status';
    status.textContent = entry.exists === false ? 'missing' : entry.kind === 'external' ? 'not checked' : 'ok';
    row.append(name, kind, status);
    if (entry.kind === 'local' && entry.exists) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'image-audit-remove';
      open.textContent = 'Open';
      open.addEventListener('click', async () => {
        const result = await window.api.openRelativeLink(entry.href);
        if (result && result.opened === false) flash('Could not open ' + entry.href);
      });
      row.append(open);
    }
    if (entry.kind === 'local') {
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'image-audit-fix';
      fix.textContent = 'Fix…';
      fix.title = 'Point this link at another file';
      fix.addEventListener('click', async () => {
        const next = await askName({
          title: 'Link target',
          value: entry.href,
          hint: 'Path relative to this document (or an absolute path).',
          confirmLabel: 'Update',
        });
        if (!next || next === entry.href) return;
        relinkHref(entry.href, next);
        await openLinkAudit();
        const audit = await window.api.linksAudit();
        if (audit.missing) flash('Still ' + audit.missing + ' missing link(s)');
      });
      row.append(fix);
    }
    const unlink = document.createElement('button');
    unlink.type = 'button';
    unlink.className = 'image-audit-remove';
    unlink.textContent = 'Unlink';
    unlink.title = 'Keep the text, drop the link';
    unlink.addEventListener('click', async () => {
      unlinkHref(entry.href);
      await openLinkAudit();
    });
    row.append(unlink);
    list.append(row);
  }
  modal.hidden = false;
}

document.querySelector('#link-audit-close')?.addEventListener('click', () => {
  document.querySelector('#link-audit').hidden = true;
});

document.querySelector('#link-audit-remove')?.addEventListener('click', async () => {
  const audit = await window.api.linksAudit();
  const missing = audit.entries.filter((entry) => entry.exists === false);
  if (!missing.length) {
    flash('No missing links');
    return;
  }
  let count = 0;
  for (const entry of missing) count += unlinkHref(entry.href);
  await openLinkAudit();
  flash(`Unlinked ${missing.length} missing link${missing.length === 1 ? '' : 's'}`);
});

// ---- image audit -------------------------------------------------------------

function imageNodesBySrc(src) {
  const found = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === src) found.push({ pos, node });
    return true;
  });
  return found;
}

function rewriteImageSrc(from, to) {
  const targets = imageNodesBySrc(from);
  if (!targets.length) return 0;
  let tr = editor.state.tr;
  for (const target of targets) {
    tr = tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, src: to });
  }
  editor.view.dispatch(tr);
  return targets.length;
}

async function downloadRemoteImage(src) {
  const result = await window.api.downloadImage(src);
  if (!result || !result.ok) {
    flash(result && result.error ? result.error : 'Download failed');
    return false;
  }
  rewriteImageSrc(src, result.relative);
  flash('Saved ' + result.relative);
  return true;
}

function removeImagesWithSrc(src) {
  const targets = imageNodesBySrc(src);
  if (!targets.length) return 0;
  let tr = editor.state.tr;
  for (const target of targets.reverse()) {
    tr = tr.delete(target.pos, target.pos + target.node.nodeSize);
  }
  editor.view.dispatch(tr);
  return targets.length;
}

async function openImageAudit() {
  const modal = document.querySelector('#image-audit');
  const list = document.querySelector('#image-audit-list');
  const summary = document.querySelector('#image-audit-summary');
  const audit = await window.api.imagesAudit();
  list.textContent = '';
  const parts = [`${audit.total} image${audit.total === 1 ? '' : 's'}`];
  if (audit.missing) parts.push(`${audit.missing} missing`);
  if (audit.remote) parts.push(`${audit.remote} remote`);
  if (audit.embedded) parts.push(`${audit.embedded} embedded`);
  summary.textContent = parts.join(' · ');
  if (!audit.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'drafts-empty';
    empty.textContent = 'This document has no images.';
    list.append(empty);
  }
  for (const entry of audit.entries) {
    const row = document.createElement('div');
    row.className = 'image-audit-row' + (entry.exists === false ? ' is-missing' : '');
    row.dataset.src = entry.src;
    const name = document.createElement('span');
    name.className = 'image-audit-name';
    name.textContent = entry.alt || entry.src.split(/[\\/]/).pop() || entry.src;
    name.title = entry.src;
    const kind = document.createElement('span');
    kind.className = 'image-audit-kind';
    kind.textContent = entry.kind === 'remote' ? 'remote' : entry.kind === 'embedded' ? 'embedded' : 'local';
    const status = document.createElement('span');
    status.className = 'image-audit-status';
    if (entry.exists === false) status.textContent = 'missing';
    else if (entry.kind === 'local' && entry.size != null) status.textContent = Math.max(1, Math.round(entry.size / 1024)) + ' KB';
    else if (entry.kind === 'embedded' && entry.size != null) status.textContent = Math.max(1, Math.round(entry.size / 1024)) + ' KB';
    else status.textContent = 'remote';
    if (entry.kind === 'remote') {
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'image-audit-download';
      download.textContent = 'Download';
      download.title = 'Save this image next to the document and link to the local copy';
      download.addEventListener('click', async (event) => {
        event.stopPropagation();
        download.disabled = true;
        download.textContent = '…';
        const ok = await downloadRemoteImage(entry.src);
        if (ok) await openImageAudit();
        else {
          download.disabled = false;
          download.textContent = 'Download';
        }
      });
      row.append(download);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'image-audit-remove';
    remove.textContent = 'Remove';
    remove.title = 'Remove this image from the document';
    remove.addEventListener('click', async () => {
      removeImagesWithSrc(entry.src);
      await openImageAudit();
    });
    row.append(name, kind, status, remove);
    list.append(row);
  }
  modal.hidden = false;
}

document.querySelector('#image-audit-close')?.addEventListener('click', () => {
  document.querySelector('#image-audit').hidden = true;
});

document.querySelector('#image-audit-download-all')?.addEventListener('click', async () => {
  const audit = await window.api.imagesAudit();
  const remote = audit.entries.filter((entry) => entry.kind === 'remote');
  if (!remote.length) {
    flash('No remote images');
    return;
  }
  let saved = 0;
  for (const entry of remote) {
    const result = await window.api.downloadImage(entry.src);
    if (result && result.ok) {
      rewriteImageSrc(entry.src, result.relative);
      saved += 1;
    }
  }
  await openImageAudit();
  flash(`Downloaded ${saved} of ${remote.length} image${remote.length === 1 ? '' : 's'}`);
});

document.querySelector('#image-audit-remove')?.addEventListener('click', async () => {
  const audit = await window.api.imagesAudit();
  const missing = audit.entries.filter((entry) => entry.exists === false);
  if (!missing.length) {
    flash('No missing images');
    return;
  }
  for (const entry of missing) removeImagesWithSrc(entry.src);
  await openImageAudit();
  flash(`Removed ${missing.length} missing image${missing.length === 1 ? '' : 's'}`);
});

// ---- recent files -----------------------------------------------------------

async function openRecentPanel() {
  const modal = document.querySelector('#recent-modal');
  const list = document.querySelector('#recent-list');
  const entries = await window.api.recentEntries();
  list.textContent = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'drafts-empty';
    empty.textContent = t('recent.empty', lang);
    list.append(empty);
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'recent-row' + (entry.exists ? '' : ' is-missing');
    row.dataset.path = entry.path;

    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'recent-body';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = entry.name;
    const dir = document.createElement('span');
    dir.className = 'recent-dir';
    dir.textContent = entry.dir;
    dir.title = entry.path;
    body.append(name, dir);
    if (!entry.exists) {
      const badge = document.createElement('span');
      badge.className = 'recent-badge';
      badge.textContent = t('recent.missing', lang);
      body.append(badge);
    } else if (entry.mtime) {
      const age = document.createElement('span');
      age.className = 'recent-age';
      age.textContent = relativeAge(entry.mtime, lang);
      body.append(age);
    }
    body.addEventListener('click', async () => {
      if (!entry.exists) {
        showToast(t('recent.gone', lang), 6000, [
          { label: t('recent.remove', lang), run: async () => {
            await window.api.recentRemove(entry.path);
            await openRecentPanel();
          } },
        ]);
        return;
      }
      const result = await window.api.recentOpen(entry.path);
      if (result && result.opened === false) {
        showToast(t('recent.gone', lang));
        return;
      }
      modal.hidden = true;
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recent-remove';
    remove.title = t('recent.remove', lang);
    remove.setAttribute('aria-label', t('recent.remove', lang) + ': ' + entry.name);
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      await window.api.recentRemove(entry.path);
      await openRecentPanel();
    });

    row.append(body, remove);
    list.append(row);
  }
  modal.hidden = false;
}

document.querySelector('#recent-close')?.addEventListener('click', () => {
  document.querySelector('#recent-modal').hidden = true;
});

document.querySelector('#recent-clear')?.addEventListener('click', async () => {
  const confirmed = await askConfirm(t('recent.clear', lang), t('recent.clearConfirm', lang), t('recent.clear', lang));
  if (!confirmed) return;
  await window.api.recentClear();
  await openRecentPanel();
});

// ---- dialog accessibility ----------------------------------------------------
// Dialogs are modal in behaviour but were not in the accessibility tree: no role, no focus trap,
// and Tab could walk into the editor behind them. This wires the tree and keeps the keyboard inside.

function modalCards() {
  return [...document.querySelectorAll('.modal')].map((modal) => ({
    modal,
    card: modal.querySelector('.modal-card') || modal.firstElementChild,
  }));
}

function prepareDialogs() {
  let counter = 0;
  for (const { modal, card } of modalCards()) {
    if (!card) continue;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const title = card.querySelector('.modal-title');
    if (title) {
      counter += 1;
      if (!title.id) title.id = 'dialog-title-' + counter;
      card.setAttribute('aria-labelledby', title.id);
    }
  }
}

function focusablesIn(modal) {
  return [
    ...modal.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function trapModalFocus(event) {
  if (event.key !== 'Tab') return;
  const open = [...document.querySelectorAll('.modal')].filter((modal) => !modal.hidden);
  if (!open.length) return;
  const modal = open[open.length - 1];
  const focusables = focusablesIn(modal);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!modal.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', trapModalFocus, true);

// When a dialog becomes visible, move the keyboard into it unless it is already there.
const dialogObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    const modal = mutation.target;
    if (modal.hidden) continue;
    if (modal.contains(document.activeElement)) continue;
    const focusables = focusablesIn(modal);
    if (focusables.length) focusables[0].focus();
  }
});
for (const { modal } of modalCards()) {
  dialogObserver.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
}
prepareDialogs();

// Icon buttons carry their meaning in a title; mirror it into aria-label for screen readers.
function labelButtons() {
  for (const button of document.querySelectorAll('button[title], [role="button"][title]')) {
    if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', button.title);
  }
}
labelButtons();

// ---- find & replace --------------------------------------------------------

const MAX_FIND_MATCHES = 2000;
let matches = [];
let matchIndex = -1;
let findTruncated = false;
let lastFindMs = 0;
// Case, whole-word and regex change what "the same text" means; defaults match the plain search.
let findOptions = { caseSensitive: false, wholeWord: false, regex: false };
let findPattern = null;
let findError = '';

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function buildFindPattern() {
  findError = '';
  findPattern = null;
  if (!findOptions.regex) return;
  try {
    findPattern = new RegExp(findInput.value, findOptions.caseSensitive ? 'g' : 'gi');
  } catch (err) {
    findError = 'bad regex';
    findPattern = null;
  }
}

function collectMatches() {
  const started = performance.now();
  const query = findInput.value;
  matches = [];
  findTruncated = false;
  findError = '';
  if (!query) {
    findPattern = null;
    return;
  }
  buildFindPattern();
  if (findOptions.regex && findError) {
    lastFindMs = performance.now() - started;
    return;
  }
  const needle = findOptions.caseSensitive ? query : query.toLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (matches.length >= MAX_FIND_MATCHES) return false;
    if (!node.isText) return true;
    const text = node.text;

    if (findPattern) {
      findPattern.lastIndex = 0;
      let hit;
      while ((hit = findPattern.exec(text)) !== null) {
        if (!hit[0].length) {
          findPattern.lastIndex += 1;
          continue;
        }
        matches.push({ from: pos + hit.index, to: pos + hit.index + hit[0].length, text: hit[0] });
        if (matches.length >= MAX_FIND_MATCHES) {
          findTruncated = true;
          break;
        }
      }
      return matches.length < MAX_FIND_MATCHES;
    }

    const haystack = findOptions.caseSensitive ? text : text.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      const after = at + needle.length;
      const wholeWordOk =
        !findOptions.wholeWord ||
        ((at === 0 || !WORD_CHAR.test(text[at - 1])) &&
          (after >= text.length || !WORD_CHAR.test(text[after])));
      if (wholeWordOk) {
        matches.push({ from: pos + at, to: pos + after, text: text.slice(at, after) });
        if (matches.length >= MAX_FIND_MATCHES) {
          findTruncated = true;
          break;
        }
      }
      at = haystack.indexOf(needle, at + 1);
    }
    return matches.length < MAX_FIND_MATCHES;
  });
  lastFindMs = performance.now() - started;
}

function focusMatch() {
  findCount.textContent = findError
    ? '!'
    : findInput.value
      ? `${matches.length ? matchIndex + 1 : 0}/${matches.length}${findTruncated ? '+' : ''}`
      : '';
  findCount.title = findError ? findError : findCount.title;
  findCount.classList.toggle('is-empty', Boolean(findInput.value) && matches.length === 0);
  findCount.title = findInput.value
    ? matches.length
      ? `${matches.length} match(es)${findTruncated ? ', list truncated' : ''}`
      : 'No results'
    : '';
  if (matchIndex < 0 || !matches.length) return;
  const { from, to } = matches[matchIndex];
  editor.chain().focus().setTextSelection({ from, to }).run();
  const node = editor.view.domAtPos(from).node;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function openFind() {
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
  collectMatches();
  matchIndex = matches.length ? 0 : -1;
  focusMatch();
}

function closeFind() {
  findbar.hidden = true;
  editor.commands.focus();
}

function stepFind(dir) {
  if (!matches.length) return;
  const from = editor.state.selection.from;
  matchIndex = (matchIndex + dir + matches.length) % matches.length;
  const target = matches[matchIndex];
  if (target && target.from !== from) pushNav(from);
  focusMatch();
}

// Make the next transaction its own undo step. Without this, a replacement done right after
// typing is merged into the typing batch and one undo throws away both.
function isolateHistoryStep() {
  editor.commands.command(({ state, dispatch }) => {
    dispatch(closeHistory(state.tr));
    return true;
  });
}

// In regex mode the replacement string may use $& and $1...$9, the way other editors do.
function replacementFor(match) {
  const replacement = replaceInput.value;
  if (!findOptions.regex || !match) return replacement;
  const source = findInput.value;
  try {
    const flags = findOptions.caseSensitive ? '' : 'i';
    return String(match.text).replace(new RegExp(source, flags), replacement);
  } catch {
    return replacement;
  }
}

function replaceOne() {
  if (matchIndex < 0 || !matches.length) return;
  const { from, to } = matches[matchIndex];
  isolateHistoryStep();
  editor.chain().focus().insertContentAt({ from, to }, replacementFor(matches[matchIndex])).run();
  collectMatches();
  matchIndex = Math.min(matchIndex, matches.length - 1);
  focusMatch();
}

function replaceAll() {
  if (!findInput.value) return;
  collectMatches();
  if (!matches.length) return;
  const total = matches.length;
  const capped = findTruncated;
  // Reverse order keeps the earlier positions valid inside the single transaction, which
  // also makes the whole replacement one undo step.
  isolateHistoryStep();
  const chain = editor.chain().focus();
  for (const m of [...matches].reverse()) {
    chain.insertContentAt({ from: m.from, to: m.to }, replacementFor(m));
  }
  chain.run();
  collectMatches();
  matchIndex = matches.length ? 0 : -1;
  focusMatch();
  flash(
    capped
      ? `replaced ${total} matches (search stops at ${MAX_FIND_MATCHES}; run it again for the rest)`
      : `replaced ${total} matches`
  );
}

function applyFindOptions() {
  for (const [id, key] of [
    ['#find-case', 'caseSensitive'],
    ['#find-word', 'wholeWord'],
    ['#find-regex', 'regex'],
  ]) {
    const button = document.querySelector(id);
    if (!button) continue;
    button.classList.toggle('is-on', Boolean(findOptions[key]));
    button.setAttribute('aria-pressed', findOptions[key] ? 'true' : 'false');
  }
}

function setFindOptions(patch) {
  findOptions = { ...findOptions, ...patch };
  applyFindOptions();
  window.api.setSettings({ findOptions }).catch(() => {});
  collectMatches();
  matchIndex = matches.length ? 0 : -1;
  focusMatch();
}

for (const [id, key] of [
  ['#find-case', 'caseSensitive'],
  ['#find-word', 'wholeWord'],
  ['#find-regex', 'regex'],
]) {
  document.querySelector(id)?.addEventListener('click', () => {
    setFindOptions({ [key]: !findOptions[key] });
    findInput.focus();
  });
}

window.api.getSettings().then((settings) => {
  if (settings && settings.findOptions) {
    findOptions = {
      caseSensitive: settings.findOptions.caseSensitive === true,
      wholeWord: settings.findOptions.wholeWord === true,
      regex: settings.findOptions.regex === true,
    };
    applyFindOptions();
  }
}).catch(() => {});

let findTimer = null;
findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => {
    const from = editor.state.selection.from;
    collectMatches();
    matchIndex = matches.length ? 0 : -1;
    if (matches.length && matches[0].from !== from) pushNav(from);
    focusMatch();
  }, 120);
});
const findOptionKeys = (e) => {
  if (!e.altKey) return false;
  const key = String(e.key).toLowerCase();
  if (key === 'c') {
    e.preventDefault();
    setFindOptions({ caseSensitive: !findOptions.caseSensitive });
    return true;
  }
  if (key === 'w') {
    e.preventDefault();
    setFindOptions({ wholeWord: !findOptions.wholeWord });
    return true;
  }
  if (key === 'r') {
    e.preventDefault();
    setFindOptions({ regex: !findOptions.regex });
    return true;
  }
  return false;
};

findInput.addEventListener('keydown', (e) => {
  if (findOptionKeys(e)) return;
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
replaceInput.addEventListener('keydown', (e) => {
  if (findOptionKeys(e)) return;
  if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});

// Ctrl+H opens the bar straight in its replace field.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (String(e.key).toLowerCase() !== 'h') return;
  e.preventDefault();
  openFind();
  replaceInput.focus();
});
$('#find-next').addEventListener('click', () => stepFind(1));
$('#find-prev').addEventListener('click', () => stepFind(-1));
$('#replace-one').addEventListener('click', replaceOne);
$('#replace-all').addEventListener('click', replaceAll);
$('#find-close').addEventListener('click', closeFind);

// ---- AI writing ------------------------------------------------------------

let aiSelection = null;
// A highlight on exactly the range the next replace will touch. Without it the panel says
// "selection" while the user has to remember what that was.
let aiTargetDecoration = null;
let aiRequestId = null;
let aiLastRequest = null;
let aiConfirmThreshold = 20000;
let pendingAI = null;
const aiHistory = [];

function renderHistoryChips() {
  const container = document.querySelector('#ai-history');
  if (!container) return;
  container.textContent = '';
  if (!aiHistory.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  // Arrow keys move between chips, so a keyboard user does not have to Tab through each
  // load/insert pair to reach the one they want.
  if (!container.dataset.aiHistoryKeys) {
    container.dataset.aiHistoryKeys = '1';
    container.addEventListener('keydown', (event) => {
      const loads = [...container.querySelectorAll('.ai-history-load')];
      if (!loads.length) return;
      const current = loads.indexOf(document.activeElement);
      if (current < 0) return;
      let next = current;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(loads.length - 1, current + 1);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, current - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = loads.length - 1;
      else return;
      event.preventDefault();
      loads[next].focus();
    });
  }
  for (const turn of aiHistory.slice(-4)) {
    const chip = document.createElement('span');
    chip.className = 'ai-history-chip';

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'ai-history-load';
    load.textContent = turn.instruction.slice(0, 34);
    load.title = turn.instruction;
    load.setAttribute(
      'aria-label',
      (lang === 'zh' ? '载入这项提示词：' : 'Load this prompt: ') + turn.instruction
    );
    load.addEventListener('click', () => {
      aiResult.value = turn.result;
      aiInstruction.value = turn.instruction;
      aiStatus.textContent = 'loaded from history';
    });

    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'ai-history-insert';
    insert.textContent = '⤓';
    insert.setAttribute(
      'aria-label',
      lang === 'zh' ? '把这条结果插入文档' : 'Insert this result into the document'
    );
    insert.title = 'Insert this result into the document';
    insert.addEventListener('click', () => {
      insertAI(turn.result, false);
      aiStatus.textContent = 'inserted from history';
    });

    chip.append(load, insert);
    container.append(chip);
  }
}

let aiContextScope = 'doc';
let aiScopeExplicit = false;
let aiScopeAuto = false;

function effectiveContextScope() {
  return effectiveScope(aiContextScope, aiScopeExplicit, editor.getText().length);
}

function contextText() {
  const scope = effectiveContextScope();
  if (scope === 'none') return '';
  if (scope === 'paragraph') {
    const { $from } = editor.state.selection;
    // ResolvedPos exposes start/end per depth; nodes themselves have no from/to.
    const depth = $from.depth;
    if (depth === 0) return '';
    try {
      const block = $from.node(depth);
      const target = block && block.isTextblock ? depth : Math.max(0, depth - 1);
      if (target === 0) return '';
      return editor.state.doc.textBetween($from.start(target), $from.end(target), '\n');
    } catch {
      return '';
    }
  }
  return editor.getText();
}

function updateContextNote() {
  const note = document.querySelector('#ai-context-note');
  if (!note) return;
  const full = contextText();
  const used = full.slice(0, 4000);
  const parts = [];
  if (!full.length) parts.push(t('ai.contextNone', lang));
  else if (full.length > used.length) parts.push(t('ai.contextTrimmed', lang, { used: used.length, total: full.length }));
  else parts.push(t('ai.contextFull', lang, { total: full.length }));
  if (aiSelection) parts.push(t('ai.selectionNote', lang, { count: aiSelection.text.length }));
  if (aiContextScope === 'doc' && full.length > 8000) parts.push(t('ai.contextSuggest', lang));
  if (effectiveContextScope() !== aiContextScope) parts.push('auto: current paragraph');
  note.textContent = parts.join(' · ');
}

// Without an endpoint or key every request fails, so say so before the user tries.
// Closing the panel should hand the keyboard back: otherwise Esc leaves focus in a hidden
// element and typing appears to do nothing.
function closeAI() {
  aiPopover.hidden = true;
  // Blur explicitly: a focused field inside a hidden panel keeps the keyboard, and
  // editor.commands.focus() alone does not always move it back.
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  try {
    editor.commands.focus();
  } catch {
    /* the editor may not be ready */
  }
  syncEmptyHint();
}

async function refreshAiSetup() {
  const hint = document.querySelector('#ai-setup-hint');
  if (!hint) return;
  let config = { baseUrl: '', hasKey: false };
  try {
    config = await window.api.aiConfig();
  } catch {
    /* treat as unconfigured */
  }
  const missing = [];
  if (!config.baseUrl) missing.push('endpoint');
  if (!config.hasKey) missing.push('API key');
  const configured = missing.length === 0;
  hint.hidden = configured;
  document.querySelector('#ai-setup-text').textContent = configured
    ? ''
    : 'AI needs an ' + missing.join(' and ') + ' before it can run.';
  const runButton = document.querySelector('#ai-run');
  if (runButton) runButton.disabled = !configured;
  return { configured, missing };
}

document.querySelector('#ai-setup-open').addEventListener('click', () => openSettings());

// One place answers "what will this act on?", so the panel does not make people read a select.
function refreshAiTargetPreview() {
  const preview = document.querySelector('#ai-target-preview');
  if (!preview) return;
  const text = aiSelection ? aiSelection.text.trim() : '';
  if (!text) {
    preview.hidden = true;
    preview.textContent = '';
    refreshAiTargetHighlight();
    return;
  }
  preview.hidden = false;
  preview.textContent = text.length > 140 ? text.slice(0, 140) + '…' : text;
  preview.title = text;
  refreshAiTargetHighlight();
}

function refreshAiTargetChip() {
  const chip = document.querySelector('#ai-target-chip');
  const select = document.querySelector('#ai-scope');
  if (!chip || !select) return;
  const option = select.options[select.selectedIndex];
  const label = option ? option.textContent : '';
  const hasSelection = !editor.state.selection.empty;
  chip.textContent = select.value === 'none' && !hasSelection ? 'Selection (none)' : label;
  chip.classList.toggle('is-empty', select.value === 'none' && !hasSelection);
}

function refreshAiTargetHighlight() {
  const dom = editor.view.dom;
  if (aiPopover.hidden || !aiSelection) {
    if (aiTargetDecoration) {
      aiTargetDecoration = null;
      dom.classList.remove('ai-target');
      try {
        editor.view.dispatch(editor.state.tr.setMeta('aiTargetRefresh', 0));
      } catch {
        /* the view may be gone */
      }
    }
    return;
  }
  aiTargetDecoration = aiSelection;
  dom.classList.add('ai-target');
  // Decorations are recomputed on transactions, so opening the panel needs one.
  try {
    editor.view.dispatch(editor.state.tr.setMeta('aiTargetRefresh', Date.now()));
  } catch {
    /* the view may be mid-update */
  }
}

function clearAiTargetHighlight() {
  aiSelection = null;
  refreshAiTargetHighlight();
}

function openAI() {
  requestAnimationFrame(refreshAiTargetChip);
  const { from, to, empty } = editor.state.selection;
  aiSelection = empty ? null : { from, to, text: editor.state.doc.textBetween(from, to, ' ') };
  updateContextNote();
  refreshAiTargetPreview();
  renderHistoryChips();
  aiPopover.hidden = false;
  refreshAiSetup();
  syncEmptyHint();
  // The highlight is gated on the panel being visible; refresh it after showing.
  refreshAiTargetPreview();
  aiInstruction.focus();
  aiInstruction.select();
}

aiInstruction.addEventListener('paste', (event) => {
  const text = event.clipboardData ? event.clipboardData.getData('text') : '';
  if (text && text.length > 4000) {
    aiStatus.textContent = `pasted ${text.length} chars — consider selecting a smaller range`;
  }
});

aiInstruction.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    runAI();
  }
});

let aiCooldownUntil = 0;
let aiCooldownTimer = null;

function startFailureCooldown(seconds = 3) {
  aiCooldownUntil = Date.now() + seconds * 1000;
  const button = $('#ai-run');
  button.disabled = true;
  clearInterval(aiCooldownTimer);
  aiCooldownTimer = setInterval(() => {
    const left = Math.ceil((aiCooldownUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(aiCooldownTimer);
      aiCooldownTimer = null;
      button.disabled = false;
      aiStatus.textContent = 'ready to retry';
      return;
    }
    aiStatus.textContent = `request failed — retry in ${left}s`;
  }, 250);
}

async function runAI() {
  const instruction = aiInstruction.value.trim();
  if (!instruction) {
    aiStatus.textContent = 'Type an instruction first';
    return;
  }
  if (aiRequestId) return; // already running

  const selection = aiSelection ? aiSelection.text : '';
  const context = contextText().slice(0, 4000);
  const promptTokens = Math.round((instruction.length + selection.length + context.length) / 4);

  if (aiConfirmThreshold > 0 && promptTokens > aiConfirmThreshold) {
    pendingAI = { instruction, selection, context, promptTokens };
    $('#ai-confirm-text').textContent = t('ai.confirm', lang, { tokens: promptTokens });
    $('#ai-confirm').hidden = false;
    aiStatus.textContent = 'waiting for confirmation';
    return;
  }

  await sendAI({ instruction, selection, context, promptTokens });
}

async function sendAI({ instruction, selection, context, promptTokens }) {
  const runButton = $('#ai-run');
  const stopButton = $('#ai-stop');

  aiRequestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aiResult.value = '';
  aiStatus.textContent = `Streaming… (~${promptTokens} prompt tokens)`;
  // A long silent request looks like a hang; tick the elapsed seconds.
  const startedAt = Date.now();
  clearInterval(sendAI.timer);
  sendAI.timer = setInterval(() => {
    if (!aiRequestId) return;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    aiStatus.textContent = `Streaming… ${seconds}s (~${promptTokens} prompt tokens)`;
  }, 1000);
  runButton.disabled = true;
  stopButton.hidden = false;

  const requestId = aiRequestId;
  aiLastRequest = { instruction, selection, context };
  try {
    const res = await window.api.aiStream({
      requestId,
      instruction,
      selection,
      context,
      history: aiHistory.slice(-4),
    });
    if (!res.ok) {
      if (!aiCancelling) {
        aiStatus.textContent = res.error;
        startFailureCooldown(3);
      }
      return;
    }
    aiResult.value = res.text;
    aiHistory.push({ instruction, result: res.text, at: new Date().toISOString() });
    while (aiHistory.length > 4) aiHistory.shift();
    window.api.aiHistorySet(aiHistory).catch(() => {});
    const outTokens = Math.round(res.text.length / 4);
    aiStatus.textContent = `~${outTokens} tok out · context ${aiHistory.length}`;
    renderHistoryChips();
  } catch (err) {
    if (!aiCancelling) {
      aiStatus.textContent = String((err && err.message) || err);
      startFailureCooldown(3);
    }
  } finally {
    aiCancelling = false;
    aiRequestId = null;
    clearInterval(sendAI.timer);
    if (Date.now() >= aiCooldownUntil) runButton.disabled = false;
    stopButton.hidden = true;
    $('#ai-retry').hidden = !aiLastRequest;
  }
}

window.api.onAiRetry(({ requestId, attempt }) => {
  if (requestId !== aiRequestId) return;
  aiStatus.textContent = `network hiccup — retrying (${attempt})…`;
});

window.api.onAiChunk(({ requestId, delta }) => {
  if (requestId !== aiRequestId) return;
  aiResult.value += delta;
  aiStatus.textContent = `Streaming… ${aiResult.value.length} chars`;
});

let aiCancelling = false;

function stopAI() {
  if (!aiRequestId) return;
  const requestId = aiRequestId;
  aiCancelling = true;
  window.api.aiCancel(requestId);
  // Release the UI immediately; the network teardown can finish in the background.
  // Whatever already streamed stays in the result box.
  aiRequestId = null;
  clearInterval(sendAI.timer);
  $('#ai-run').disabled = false;
  $('#ai-stop').hidden = true;
  aiStatus.textContent = 'stopped';
}

// Re-run the last instruction against the current selection (paragraph-level retry).
function retryAI() {
  if (!aiLastRequest) return;
  aiInstruction.value = aiLastRequest.instruction;
  const { from, to, empty } = editor.state.selection;
  aiSelection = empty ? null : { from, to, text: editor.state.doc.textBetween(from, to, ' ') };
  runAI();
}

// The block under the cursor, used when "Replace" is pressed without a selection so the
// current paragraph can be rewritten in one step.
function paragraphRange() {
  const { $from } = editor.state.selection;
  if ($from.depth === 0) return null;
  try {
    const block = $from.node($from.depth);
    const depth = block && block.isTextblock ? $from.depth : Math.max(1, $from.depth - 1);
    return { from: $from.start(depth), to: $from.end(depth) };
  } catch {
    return null;
  }
}

function insertAI(text, replace, asParagraph = false) {
  if (!text) return;
  const range = replace ? aiSelection || paragraphRange() : null;
  // Undo must treat an AI edit as one action, not merge it with the typing that preceded it:
  // closeHistory on a first transaction opens a fresh group for everything that follows.
  const group = () =>
    editor.chain().command(({ tr }) => {
      closeHistory(tr);
      return true;
    });
  if (range) {
    group().focus().insertContentAt({ from: range.from, to: range.to }, text).run();
  } else if (asParagraph) {
    // Start a fresh block first so the result does not merge into the current paragraph.
    group().focus().splitBlock().insertContent(text).run();
  } else {
    group().focus().insertContent(text).run();
  }
  // Bring the inserted text into view; in a long document it may land off-screen.
  try {
    const pos = editor.state.selection.from;
    const node = editor.view.domAtPos(pos).node;
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  } catch {
    /* scrolling is cosmetic */
  }
  aiPopover.hidden = true;
  clearAiTargetHighlight();
  // One visible way out: the AI edit opened its own undo group, so a single undo is safe.
  showToast(replace ? 'Replaced the selection' : asParagraph ? 'Inserted a paragraph' : 'Inserted the result', 8000, [
    { label: 'Undo', run: () => editor.commands.undo() },
  ]);
}

// Review a suggestion against the selection before applying it.
function diffBaseText() {
  if (aiSelection) return aiSelection.text;
  // No selection: compare against the paragraph the cursor is in, matching what
  // "Replace selection" would rewrite.
  const range = paragraphRange();
  if (!range) return '';
  try {
    return editor.state.doc.textBetween(range.from, range.to, ' ');
  } catch {
    return '';
  }
}

function previewAIDiff() {
  const before = diffBaseText();
  const after = aiResult.value;
  if (!before) {
    aiStatus.textContent = 'Put the cursor in a paragraph (or select text) to compare first';
    return;
  }
  if (!after) {
    aiStatus.textContent = 'Run the assistant first';
    return;
  }
  const ops = diffWords(before, after);
  const stats = diffStats(ops);
  const host = $('#ai-diff');
  host.textContent = '';
  for (const op of ops) {
    const span = document.createElement('span');
    if (op.type === 'insert') span.className = 'diff-ins';
    else if (op.type === 'delete') span.className = 'diff-del';
    span.textContent = op.text;
    host.appendChild(span);
  }
  host.hidden = false;
  const against = aiSelection ? (lang === 'zh' ? '相对选区' : 'vs selection') : lang === 'zh' ? '相对段落' : 'vs paragraph';
  aiStatus.textContent = `+${stats.added} / −${stats.removed} chars ${against}`;
}

const AI_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
};

function presetFor(baseUrl) {
  const url = String(baseUrl || '');
  for (const [key, preset] of Object.entries(AI_PRESETS)) {
    if (url.startsWith(preset.baseUrl)) return key;
  }
  return 'custom';
}

const STYLE_PRESETS = {
  concise: 'Keep sentences short and concrete. Remove filler. Prefer active voice.',
  academic: 'Use a formal, precise academic register. Avoid contractions and hype. Define terms on first use.',
  marketing: 'Write with a confident, benefit-led voice. Short paragraphs, concrete verbs, no clichés.',
  friendly: 'Write in a warm, conversational tone. Address the reader directly. Avoid jargon.',
};

function setSectionCollapsed(sub, collapsed) {
  sub.classList.toggle('collapsed', collapsed);
  let node = sub.nextElementSibling;
  while (node && !node.classList.contains('modal-sub')) {
    const isContent =
      node.classList.contains('field') ||
      node.classList.contains('style-presets') ||
      node.classList.contains('field-hint') ||
      node.id === 'ai-usage-list' ||
      node.id === 'usage-export' ||
      node.id === 'set-export-preview' ||
      node.id === 'set-ai-note';
    if (isContent) node.classList.toggle('section-collapsed', collapsed);
    node = node.nextElementSibling;
  }
}

// Remember which sections are folded: reopening settings should look like the user left it.
function sectionState() {
  const state = {};
  for (const sub of document.querySelectorAll('#settings-modal .modal-sub[data-section]')) {
    state[sub.dataset.section] = sub.classList.contains('collapsed');
  }
  return state;
}

function applySectionState(state) {
  if (!state || typeof state !== 'object') return;
  for (const sub of document.querySelectorAll('#settings-modal .modal-sub[data-section]')) {
    setSectionCollapsed(sub, state[sub.dataset.section] === true);
  }
}

for (const sub of document.querySelectorAll('#settings-modal .modal-sub')) {
  sub.addEventListener('click', () => {
    setSectionCollapsed(sub, !sub.classList.contains('collapsed'));
    window.api.setSettings({ collapsedSections: sectionState() }).catch(() => {});
  });
}

let searchCollapseSnapshot = null;

// Search matches labels and help text; several words all have to be present, so "ai key" narrows
// rather than widens. Hits are highlighted inside the label without touching the controls.
function highlightLabel(label, words) {
  if (!label.dataset.originalText) label.dataset.originalText = label.textContent;
  const text = label.dataset.originalText;
  if (!words.length) {
    // textContent cannot tell a <mark> from plain text, so rebuild unconditionally.
    if (label.innerHTML !== text) label.textContent = text;
    return;
  }
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  if (!escaped.length) return;
  const pattern = new RegExp(escaped.join("|"), "gi");
  const parts = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (!match[0]) {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > last) parts.push(document.createTextNode(text.slice(last, match.index)));
    const mark = document.createElement("mark");
    mark.className = "settings-hit";
    mark.textContent = match[0];
    parts.push(mark);
    last = match.index + match[0].length;
  }
  if (!parts.length) {
    if (label.textContent !== text) label.textContent = text;
    return;
  }
  if (last < text.length) parts.push(document.createTextNode(text.slice(last)));
  label.textContent = '';
  label.append(...parts);
}

let settingsActiveIndex = -1;

function settingsVisibleFields() {
  return [...document.querySelectorAll('#settings-modal .field:not([hidden])')];
}

function moveSettingsActive(delta) {
  const fields = settingsVisibleFields();
  if (!fields.length) return -1;
  const current = settingsActiveIndex;
  settingsActiveIndex = current < 0 ? (delta > 0 ? 0 : fields.length - 1) : (current + delta + fields.length) % fields.length;
  fields.forEach((field, index) => field.classList.toggle('is-search-active', index === settingsActiveIndex));
  const active = fields[settingsActiveIndex];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  return settingsActiveIndex;
}

function focusSettingsActive() {
  const fields = settingsVisibleFields();
  const field = fields[settingsActiveIndex];
  if (!field) return false;
  const control = field.querySelector('input, select, textarea, button');
  if (!control) return false;
  control.focus();
  return true;
}

function resetSettingsActive() {
  settingsActiveIndex = -1;
  for (const field of document.querySelectorAll('#settings-modal .field')) field.classList.remove('is-search-active');
}

function filterSettings(query) {
  resetSettingsActive();
  const words = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const q = words.join(' ');
  const allWords = (text) => {
    const haystack = String(text || '').toLowerCase();
    return words.length > 0 && words.every((word) => haystack.includes(word));
  };
  const anyWord = (text) => {
    const haystack = String(text || '').toLowerCase();
    return words.some((word) => haystack.includes(word));
  };
  // All words first (narrowing); a phrase like "writing goal" still finds "Daily word goal" through
  // the fallback instead of showing an empty panel.
  const fields = [...document.querySelectorAll('#settings-modal .field')];
  // Take one snapshot of the user's folding before search expands anything, and put it back when the
  // query is cleared: searching must not cost the layout the user chose.
  if (q && !searchCollapseSnapshot) searchCollapseSnapshot = sectionState();
  const useAny = Boolean(q) && !fields.some((field) => allWords(field.textContent));
  const matches = useAny ? anyWord : allWords;
  let visible = 0;
  for (const field of fields) {
    const hit = !q || matches(field.textContent);
    field.hidden = !hit;
    if (hit) visible += 1;
    const label = field.querySelector('label');
    if (label) highlightLabel(label, q ? words : []);
  }
  for (const sub of document.querySelectorAll('#settings-modal .modal-sub')) {
    const headingMatches = Boolean(q) && matches(sub.textContent);
    if (headingMatches) {
      setSectionCollapsed(sub, false);
      let node = sub.nextElementSibling;
      while (node && !node.classList.contains('modal-sub')) {
        if (node.classList.contains('field')) {
          node.hidden = false;
          visible += 1;
        }
        node = node.nextElementSibling;
      }
    }
    let anyVisible = false;
    let node = sub.nextElementSibling;
    while (node && !node.classList.contains('modal-sub')) {
      if (node.classList.contains('field') && !node.hidden) anyVisible = true;
      node = node.nextElementSibling;
    }
    // A matching field inside a folded section has to be visible, or the search lies.
    if (q && anyVisible) setSectionCollapsed(sub, false);
    sub.hidden = Boolean(q) && !anyVisible && !headingMatches;
  }
  const empty = document.querySelector('#settings-empty');
  if (empty) empty.hidden = !q || visible > 0;
  if (!q && searchCollapseSnapshot) {
    applySectionState(searchCollapseSnapshot);
    searchCollapseSnapshot = null;
  }
  return visible;
}

// Every setting must be findable by typing its own label. The smoke test asks for every label and
// fails if a field hides itself.
function settingsSearchAudit() {
  const failures = [];
  const fields = [...document.querySelectorAll('#settings-modal .field')];
  for (const field of fields) {
    const label = field.querySelector('label');
    if (!label) continue;
    const text = (label.dataset.originalText || label.textContent).trim();
    if (!text) continue;
    filterSettings(text);
    if (field.hidden) failures.push(text);
  }
  filterSettings('');
  return { fields: fields.length, failures };
}


for (const button of document.querySelectorAll('.style-preset')) {
  button.addEventListener('click', () => {
    const preset = STYLE_PRESETS[button.dataset.style];
    if (preset) $('#set-ai-system').value = preset;
  });
}

$('#set-diagnostics').addEventListener('click', async () => {
  const result = await window.api.copyDiagnostics();
  flash(t('settings.diagnosticsCopied', lang, { size: result.copied || 0 }));
});

$('#set-open-log').addEventListener('click', () => {
  window.api.openLogFolder();
});

$('#usage-export').addEventListener('click', async () => {
  const result = await window.api.aiUsageExport();
  if (result && result.exported) flash(`usage exported: ${result.path.split(/[\\/]/).pop()}`);
});

async function refreshDraftsBadge() {
  const badge = document.querySelector('#drafts-badge');
  if (!badge) return 0;
  try {
    const drafts = await window.api.listDrafts();
    if (!drafts.length) {
      badge.hidden = true;
      badge.textContent = '';
      return 0;
    }
    badge.hidden = false;
    badge.textContent = t('drafts.badge', lang, { count: drafts.length });
    return drafts.length;
  } catch {
    badge.hidden = true;
    return 0;
  }
}

document.querySelector('#drafts-badge').addEventListener('click', () => openDraftsPanel());

// A timestamp alone makes the reader do arithmetic; show how long ago it was too.
function relativeAge(when, language) {
  // Backups arrive as epoch milliseconds, drafts as ISO strings; accept both.
  const stamp = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(stamp)) return '';
  const minutes = Math.round((Date.now() - stamp) / 60000);
  const zh = language === 'zh';
  if (minutes < 1) return zh ? '刚刚' : 'just now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return zh ? `${days} 天前` : `${days} d ago`;
}

async function openDraftsPanel() {
  const modal = document.querySelector('#drafts-modal');
  const list = document.querySelector('#drafts-list');
  const drafts = await window.api.listDrafts();
  list.textContent = '';
  if (!drafts.length) {
    const empty = document.createElement('div');
    empty.className = 'drafts-empty';
    empty.textContent = t('drafts.empty', lang);
    list.append(empty);
  }
  const count = document.querySelector('#drafts-count');
  if (count) count.textContent = drafts.length ? String(drafts.length) : '';
  for (const draft of drafts) {
    // A button inside a button is invalid HTML and swallows the inner click; the row is a div.
    const row = document.createElement('div');
    row.className = 'draft-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const label = document.createElement('span');
    label.className = 'draft-name';
    label.textContent = draft.name;
    const meta = document.createElement('span');
    meta.className = 'draft-meta';
    const age = draft.updatedAt ? relativeAge(draft.updatedAt, lang) : '';
    meta.textContent = [age, draft.bytes + ' B'].filter(Boolean).join(' · ');
    if (draft.updatedAt) row.title = new Date(draft.updatedAt).toLocaleString();
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'draft-delete';
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    remove.title = lang === 'zh' ? '删除这份草稿' : 'Delete this draft';
    remove.setAttribute('aria-label', remove.title + ': ' + draft.name);
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      const result = await window.api.deleteDraft(draft.path);
      if (result && result.removed) {
        flash(t('drafts.deleted', lang));
        await openDraftsPanel();
        refreshDraftsBadge();
      }
    });
    row.append(label, meta, remove);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        row.click();
      }
    });
    row.addEventListener('click', async () => {
      const result = await window.api.restoreDraft(draft.path);
      if (result && result.restored) {
        setMarkdown(result.contents);
        scheduleChange();
        flash(t('backup.restored', lang));
      }
      modal.hidden = true;
    });
    list.append(row);
  }
  modal.hidden = false;
}

document.querySelector('#drafts-close').addEventListener('click', () => {
  document.querySelector('#drafts-modal').hidden = true;
});

document.querySelector('#drafts-purge').addEventListener('click', async () => {
  const result = await window.api.purgeDrafts(30);
  if (result && result.removed) {
    flash(t('drafts.purged', lang, { count: result.removed }));
    await openDraftsPanel();
    refreshDraftsBadge();
  }
});

const TEMPLATE_HINTS = {
  default: 'default: regular margins and line height',
  compact: 'compact: tighter margins, more text per page',
  toc: 'with contents: adds a linked table of contents page',
};

function renderTemplateThumb(template) {
  const thumb = document.querySelector('#template-thumb');
  if (!thumb) return;
  const inset = template === 'compact' ? 7 : 14;
  const lines = [];
  for (let i = 0; i < 5; i += 1) {
    const width = 96 - inset * 2 - 8 - (i % 2 ? 18 : 0);
    lines.push(
      '<rect x="' + (inset + 4) + '" y="' + (inset + 6 + i * 9) + '" width="' + width + '" height="3" rx="1.5" />'
    );
  }
  const toc =
    template === 'toc'
      ? '<rect class="thumb-toc" x="' + (inset + 2) + '" y="' + (inset + 2) + '" width="' + (116 - inset * 2 - 4) + '" height="14" rx="2" />'
      : '';
  thumb.innerHTML =
    '<rect class="thumb-page" x="1" y="1" width="118" height="78" rx="3" />' +
    toc +
    '<g class="thumb-text">' + lines.join('') + '</g>';
}

function updateTemplateHint() {
  const hint = document.querySelector('#template-hint');
  if (!hint) return;
  const template = $('#set-export-template').value;
  hint.textContent = TEMPLATE_HINTS[template] || TEMPLATE_HINTS.default;
  renderTemplateThumb(template);
}

$('#set-export-template').addEventListener('change', updateTemplateHint);

// Samples the real computed colors of the shell for each theme; used by the smoke audit.
// Elements often have a transparent background; walk up until a painted color is found.
function effectiveBackground(el) {
  let node = el;
  while (node && node !== document.documentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && !/^rgba?\(0,\s*0,\s*0,\s*0\)$/.test(bg) && bg !== 'transparent') return bg;
    node = node.parentElement;
  }
  return getComputedStyle(document.body).backgroundColor;
}

function sampleContrast(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  return contrastRatio(getComputedStyle(el).color, effectiveBackground(el));
}

function toolbarSample() {
  const el = document.querySelector('.toolbar button');
  if (!el) return null;
  const style = getComputedStyle(el);
  return {
    cmd: el.dataset.cmd || '',
    className: String(el.className || ''),
    color: style.color,
    background: style.backgroundColor,
    resolvedBg: effectiveBackground(el),
    theme: document.documentElement.dataset.theme || '',
    textVar: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
  };
}

function themeContrastReport() {
  const previous = document.documentElement.dataset.theme || 'light';
  const report = {};
  for (const theme of ['light', 'dark', 'sepia']) {
    applyTheme(theme);
    report[theme] = {
      editor: sampleContrast('.tiptap'),
      status: sampleContrast('#status'),
      toolbar: sampleContrast('.toolbar button'),
      toolbarSample: toolbarSample(),
    };
  }
  applyTheme(previous);
  return report;
}

async function renderUsage() {
  const list = $('#ai-usage-list');
  const usage = await window.api.aiUsageList();
  list.textContent = '';
  if (!usage.length) {
    list.textContent = t('usage.empty', lang);
    return;
  }
  for (const entry of usage) {
    const row = document.createElement('div');
    row.className = 'usage-row';
    row.textContent = t('usage.row', lang, {
      prompt: entry.promptTokens ?? 0,
      out: entry.outTokens ?? 0,
      ms: entry.ms ?? 0,
      model: entry.model || 'default',
    });
    list.append(row);
  }

  // A tiny duration trend; numbers only, so building markup here is safe.
  if (usage.length >= 2) {
    const durationSvg = usageSparkline(usage.map((entry) => entry.ms || 0));
    list.insertAdjacentHTML('afterbegin', durationSvg);
  }
}

function usageSparkline(valuesNewestFirst) {
  const values = valuesNewestFirst.slice().reverse();
  const max = Math.max(...values, 1);
  const width = 220;
  const height = 34;
  const step = width / Math.max(values.length - 1, 1);
  const points = values
    .map((value, index) => {
      const x = Math.round(index * step * 10) / 10;
      const y = Math.round((height - 3 - (value / max) * (height - 8)) * 10) / 10;
      return `${x},${y}`;
    })
    .join(' ');
  return `<svg class="usage-spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="request duration trend"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
}

// Which fields still need Save? Comparing against a snapshot taken when the panel opened
// keeps the hint honest, including after Cancel.
let settingsSnapshot = null;

const SETTINGS_FIELDS = [
  '#set-theme',
  '#set-language',
  '#set-export-template',
  '#set-export-css',
  '#set-export-name',
  '#set-autosave',
  '#set-ai-base',
  '#set-ai-model',
  '#set-ai-confirm',
  '#set-ai-system',
  '#set-ai-key',
];

function settingsValues() {
  const values = {};
  for (const id of SETTINGS_FIELDS) {
    const el = document.querySelector(id);
    values[id] = el ? String(el.value) : '';
  }
  return values;
}

function refreshSettingsDirty() {
  const hint = document.querySelector('#set-dirty');
  if (!hint || !settingsSnapshot) return;
  const current = settingsValues();
  const changed = SETTINGS_FIELDS.some((id) => current[id] !== settingsSnapshot[id]);
  hint.hidden = !changed;
}

async function refreshExportNameHint() {
  const hint = document.querySelector('#set-export-name-hint');
  const input = document.querySelector('#set-export-name');
  if (!hint || !input) return;
  const result = await window.api
    .exportNamePreview(input.value || '{title}')
    .catch(() => ({ name: '' }));
  const example = result && result.name ? result.name : '';
  hint.textContent = example ? 'e.g. ' + example + '.html' : '';
  hint.classList.toggle('is-error', Boolean(result && result.error));
}

// Settings is a long panel; the usage log is at the bottom and often folded away, so both the
// palette and the AI panel need a way to land there directly.
async function openUsagePanel() {
  await openSettings();
  const section = document.querySelector('#settings-modal .modal-sub[data-section="usage"]');
  if (section) {
    setSectionCollapsed(section, false);
    section.scrollIntoView({ block: 'start' });
    section.focus({ preventScroll: true });
  }
  await renderUsage();
}

async function openSettings(section = 'appearance') {
  const settings = await window.api.getSettings();
  const aiCfg = await window.api.aiConfig();
  $('#set-theme').value = settings.theme || 'light';
  $('#set-spellcheck').checked = settings.spellcheck !== false;
  $('#set-typewriter').checked = settings.typewriter === true;
  $('#set-highlight-paragraph').checked = settings.highlightParagraph === true;
  $('#set-writing-goal').value = String(Number(settings.writingGoal) || 0);
  $('#set-external-policy').value = ['ask', 'auto', 'ignore'].includes(settings.externalPolicy) ? settings.externalPolicy : 'ask';
  setParagraphHighlight(settings.highlightParagraph === true);
  typewriterEnabled = settings.typewriter === true;
  setParagraphHighlight(settings.highlightParagraph === true);
  editor.view.dom.classList.toggle('typewriter', typewriterEnabled);
  $('#set-language').value = normalizeLang(settings.language || 'en');
  $('#set-font').value = FONTS.includes(settings.editorFont) ? settings.editorFont : 'serif';
  $('#set-width').value = WIDTHS.includes(settings.lineWidth) ? settings.lineWidth : 'normal';
  $('#set-accent').value = ACCENTS.includes(settings.accent) ? settings.accent : 'blue';
  $('#set-export-template').value = settings.exportTemplate || 'default';
  updateTemplateHint();
  $('#set-export-css').value = settings.exportCss || '';
  $('#set-export-name').value = settings.exportNameTemplate || '{title}';
  $('#set-autosave').value = String(Math.max(1, Math.round((settings.autosaveMs || 5000) / 1000)));
  $('#set-ai-base').value = aiCfg.baseUrl || '';
  $('#set-ai-model').value = aiCfg.model || '';
  $('#set-ai-preset').value = presetFor(aiCfg.baseUrl);
  $('#set-ai-confirm').value = String(settings.aiConfirmOverTokens ?? 20000);
  $('#set-ai-system').value = settings.aiSystemPrompt || '';
  $('#set-ai-key').value = '';
  settingsSnapshot = settingsValues();
  refreshSettingsDirty();
  refreshExportNameHint();
  renderUsage();

  $('#set-ai-key').dataset.clear = 'false';
  $('#set-ai-note').classList.remove('is-warning');
  $('#set-ai-note').textContent = aiCfg.hasKey
    ? aiCfg.keyStoredSecurely
      ? 'A key is saved in the OS credential store.'
      : 'A key is saved, but only obfuscated — the OS credential store was unavailable.'
    : 'No key saved yet.';
  $('#set-status').textContent = '';
  const info = await window.api.info();
  $('#set-version').textContent = `mdpad ${info.version}`;
  settingsModal.hidden = false;

  // Land where the caller asked: the appearance controls are at the top, so the default is a
  // scroll to the top rather than a jump to the endpoint field.
  const scroll = document.querySelector('#settings-modal .settings-scroll');
  const target = document.querySelector(`#settings-modal .modal-sub[data-section="${section}"]`);
  if (scroll) {
    if (section === 'ai' && target) {
      scroll.scrollTop = Math.max(0, target.offsetTop - 8);
      $('#set-ai-base').focus({ preventScroll: true });
    } else if (section === 'export' && target) {
      scroll.scrollTop = Math.max(0, target.offsetTop - 8);
    } else {
      scroll.scrollTop = 0;
    }
  }
}

async function saveSettings() {
  const theme = $('#set-theme').value;
  const spellcheck = $('#set-spellcheck').checked;
  const editorFont = $('#set-font').value;
  const lineWidth = $('#set-width').value;
  const accent = $('#set-accent').value;
  const language = normalizeLang($('#set-language').value);
  const seconds = Number($('#set-autosave').value);
  const baseUrl = $('#set-ai-base').value.trim();
  const confirmTokens = Number($('#set-ai-confirm').value);
  const status = $('#set-status');

  // Validate before writing: a bad endpoint silently saved becomes a confusing
  // "request failed" later, and the settings panel is where it is fixable.
  if (baseUrl && !/^https?:\/\/\S+$/i.test(baseUrl)) {
    status.textContent = t('settings.errorUrl', lang);
    status.classList.add('error');
    return;
  }
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
    status.textContent = t('settings.errorAutosave', lang);
    status.classList.add('error');
    return;
  }
  if (!Number.isFinite(confirmTokens) || confirmTokens < 0 || confirmTokens > 500000) {
    status.textContent = t('settings.errorTokens', lang);
    status.classList.add('error');
    return;
  }
  status.classList.remove('error');

  const clearKeyFlag = $('#set-ai-key').dataset.clear === 'true';
  $('#set-ai-key').dataset.clear = 'false';

  await window.api.setSettings({
    theme,
    autosaveMs: Math.round(seconds * 1000),
    language,
    exportTemplate: $('#set-export-template').value,
    exportCss: $('#set-export-css').value,
    exportNameTemplate: $('#set-export-name').value,
    aiSystemPrompt: $('#set-ai-system').value,
    aiConfirmOverTokens: Number($('#set-ai-confirm').value),
    editorFont,
    lineWidth,
    accent,
    spellcheck: $('#set-spellcheck').checked,
    typewriter: $('#set-typewriter').checked,
    highlightParagraph: $('#set-highlight-paragraph').checked,
    writingGoal: Number($('#set-writing-goal').value) || 0,
    externalPolicy: $('#set-external-policy').value,
  });
  aiConfirmThreshold = Number($('#set-ai-confirm').value);
  applyAppearance({ editorFont, lineWidth, accent });
  applyTheme(theme);
  applyI18n(language);

  const aiResultConfig = await window.api.aiConfigure({
    baseUrl: $('#set-ai-base').value,
    model: $('#set-ai-model').value,
    apiKey: clearKeyFlag ? '' : $('#set-ai-key').value,
    clearKey: clearKeyFlag,
  });
  $('#set-status').textContent = aiResultConfig.hasKey ? 'saved' : 'saved without a key';
  setTimeout(() => {
    settingsModal.hidden = true;
  }, 500);
}

$('#ai-settings').addEventListener('click', openSettings);
$('#ai-usage-open').addEventListener('click', () => openUsagePanel());
$('#open-settings').addEventListener('click', openSettings);
$('#set-export-name').addEventListener('input', () => refreshExportNameHint());
$('#set-export-preview').addEventListener('click', () => {
  // Save first so the preview reflects the template and CSS currently on screen.
  saveSettings().then(() => runExport('preview'));
});
$('#set-save').addEventListener('click', saveSettings);
$('#settings-modal').addEventListener('input', refreshSettingsDirty);
$('#settings-modal').addEventListener('change', refreshSettingsDirty);
$('#set-ai-models').addEventListener('click', async () => {
  const status = $('#set-status');
  status.classList.remove('error');
  status.textContent = 'fetching models…';
  const result = await window.api.aiModels({
    baseUrl: $('#set-ai-base').value.trim(),
    apiKey: $('#set-ai-key').value.trim(),
  });
  const list = $('#ai-model-list');
  list.textContent = '';
  if (!result.ok) {
    status.textContent = [result.error, result.hint].filter(Boolean).join(' — ');
    status.classList.add('error');
    return;
  }
  for (const id of result.models) {
    const option = document.createElement('option');
    option.value = id;
    list.appendChild(option);
  }
  status.textContent = result.models.length
    ? `${result.models.length} model(s) available — pick one from the field`
    : 'the endpoint listed no models; type the name manually';
});

$('#ai-test').addEventListener('click', async () => {
  const status = $('#set-status');
  status.classList.remove('error');
  status.textContent = t('ai.testing', lang);
  const result = await window.api.aiTest({
    baseUrl: $('#set-ai-base').value.trim(),
    model: $('#set-ai-model').value.trim(),
    apiKey: $('#set-ai-key').value.trim(),
  });
  if (result.ok) {
    const model = result.model || $('#set-ai-model').value.trim() || 'model';
    const reply = result.reply ? ` · replied "${result.reply}"` : '';
    status.textContent = `${model} · ${result.ms} ms${reply}`;
  } else {
    status.textContent = [t('ai.testFail', lang, { error: result.error }), result.hint]
      .filter(Boolean)
      .join(' — ');
    status.classList.add('error');
  }
});

// Escape belongs to the search box while it has text, even when the focus has moved to a control —
// otherwise pressing Escape after Enter would close the panel and lose the query.
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape') return;
    const modal = document.querySelector('#settings-modal');
    const input = document.querySelector('#set-filter');
    if (!modal || modal.hidden || !input || !input.value) return;
    event.preventDefault();
    event.stopPropagation();
    input.value = '';
    filterSettings('');
    input.focus();
  },
  { capture: true }
);

// Arrow keys walk the visible settings, Enter jumps to the control, Escape first clears the query
// (a second Escape closes the panel through the global handler).
$('#set-filter').addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSettingsActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      if (focusSettingsActive()) event.preventDefault();
      return;
    }
  },
  { capture: true }
);

$('#set-filter').addEventListener('input', (event) => filterSettings(event.target.value));
$('#ai-scope').addEventListener('change', (event) => {
  aiContextScope = event.target.value;
  refreshAiTargetChip();
  aiScopeExplicit = true;
  aiScopeAuto = false;
  updateContextNote();
  window.api.setSettings({ aiContextScope }).catch(() => {});
});
$('#set-ai-preset').addEventListener('change', (event) => {
  const preset = AI_PRESETS[event.target.value];
  if (!preset) return; // "custom" keeps whatever is typed
  $('#set-ai-base').value = preset.baseUrl;
  $('#set-ai-model').value = preset.model;
});
$('#set-cancel').addEventListener('click', () => {
  settingsModal.hidden = true;
});
settingsModal.addEventListener('click', (event) => {
  if (event.target === settingsModal) settingsModal.hidden = true;
});

$('#ai-paragraph').addEventListener('click', () => {
  const text = aiResult.value;
  if (text) insertAI(text, false, true);
});

$('#ai-copy').addEventListener('click', async () => {
  const text = aiResult.value;
  if (!text) return;
  await window.api.clipboardWrite(text);
  // The toast is easy to miss when the panel has focus; the button itself confirms it.
  const button = $('#ai-copy');
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = t('ai.copied', lang);
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => {
    button.textContent = original;
  }, 1400);
  flash(t('ai.copied', lang));
});

$('#ai-run').addEventListener('click', runAI);
$('#ai-retry').addEventListener('click', retryAI);
$('#ai-stop').addEventListener('click', stopAI);
$('#ai-confirm-yes').addEventListener('click', async () => {
  if (!pendingAI) return;
  const request = pendingAI;
  pendingAI = null;
  $('#ai-confirm').hidden = true;
  await sendAI(request);
});
$('#ai-confirm-no').addEventListener('click', () => {
  pendingAI = null;
  $('#ai-confirm').hidden = true;
  aiStatus.textContent = '';
});
$('#ai-preview').addEventListener('click', previewAIDiff);
$('#ai-clear').addEventListener('click', () => {
  aiHistory.length = 0;
  window.api.aiHistorySet([]).catch(() => {});
  aiStatus.textContent = 'context cleared';
});
document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    aiInstruction.value = button.dataset.preset;
    runAI();
  });
});
$('#ai-insert').addEventListener('click', () => insertAI(aiResult.value, false));
$('#ai-replace').addEventListener('click', () => insertAI(aiResult.value, true));
aiInstruction.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runAI();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeAI();
  }
});

// ---- tabs ------------------------------------------------------------------

async function flushChange() {
  clearTimeout(changeTimer);
  await window.api.syncChange(currentMarkdown());
}

let tabsState = [];
let dragTabId = null;

// Right-click a tab: close the others, close to the right, copy its path, reveal it.
let tabMenuTarget = null;

function closeTabMenu() {
  const menu = document.querySelector('#tab-menu');
  if (menu) menu.hidden = true;
}

function openTabMenu(x, y, tab) {
  tabMenuTarget = tab;
  const menu = document.querySelector('#tab-menu');
  if (!menu) return;
  const hasFile = Boolean(tab.file);
  for (const action of ['copyPath', 'reveal']) {
    const button = menu.querySelector('[data-tab-action="' + action + '"]');
    if (button) button.hidden = !hasFile;
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

async function runTabAction(action) {
  const tab = tabMenuTarget;
  if (!tab) return;
  if (action === 'close') return window.api.closeTab(tab.id);
  if (action === 'closeOthers') {
    for (const other of tabsState) {
      if (other.id !== tab.id) await window.api.closeTab(other.id);
    }
    return window.api.activateTab(tab.id);
  }
  if (action === 'closeRight') {
    const index = tabsState.findIndex((entry) => entry.id === tab.id);
    for (const other of tabsState.slice(index + 1)) {
      await window.api.closeTab(other.id);
    }
    return window.api.activateTab(tab.id);
  }
  if (action === 'copyPath' && tab.file) {
    await window.api.clipboardWrite(tab.file);
    showToast('Path copied', 2200);
    return undefined;
  }
  if (action === 'reveal' && tab.file) {
    return window.api.revealEntry(tab.file);
  }
  return undefined;
}

function cycleTab(offset) {
  if (tabsState.length < 2) return;
  const index = tabsState.findIndex((entry) => entry.active);
  const next = (index + offset + tabsState.length) % tabsState.length;
  window.api.activateTab(tabsState[next].id);
}

document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.key !== 'Tab') return;
  event.preventDefault();
  cycleTab(event.shiftKey ? -1 : 1);
});

document.querySelectorAll('#tab-menu [data-tab-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.tabAction;
    closeTabMenu();
    await runTabAction(action);
  });
});

document.addEventListener('mousedown', (event) => {
  const menu = document.querySelector('#tab-menu');
  if (menu && !menu.hidden && !menu.contains(event.target)) closeTabMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTabMenu();
});

function renderTabs(list) {
  tabsState = Array.isArray(list) ? list : [];
  for (const key of [...editorStateCache.keys()]) {
    if (!tabsState.some((tab) => tab.id === key)) editorStateCache.delete(key);
  }
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', t('tabs.label', lang));
  // Remember the focused tab: re-rendering must not drop the keyboard somewhere else.
  const focusedTabId = document.activeElement && document.activeElement.closest('#tabs')
    ? document.activeElement.dataset.id
    : null;
  tabList.textContent = '';
  for (const tab of list) {
    const el = document.createElement('div');
    el.className = `tab${tab.active ? ' active' : ''}`;
    el.dataset.id = tab.id;
    el.draggable = true;
    // A tab strip is a tablist: the active tab is selected, the rest are reachable with arrows.
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', tab.active ? 'true' : 'false');
    el.tabIndex = tab.active ? 0 : -1;
    el.addEventListener('dragstart', (event) => {
      dragTabId = tab.id;
      event.dataTransfer.effectAllowed = 'move';
      // Some Chromium builds require data to be set for the drag to start.
      event.dataTransfer.setData('text/plain', tab.id);
    });
    el.addEventListener('dragover', (event) => {
      if (!dragTabId || dragTabId === tab.id) return;
      event.preventDefault();
      el.classList.add('tab-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('tab-drop'));
    el.addEventListener('drop', async (event) => {
      event.preventDefault();
      el.classList.remove('tab-drop');
      const from = dragTabId;
      dragTabId = null;
      if (!from || from === tab.id) return;
      const ids = tabsState.map((entry) => entry.id);
      const fromIndex = ids.indexOf(from);
      const toIndex = ids.indexOf(tab.id);
      if (fromIndex < 0 || toIndex < 0) return;
      ids.splice(toIndex, 0, ids.splice(fromIndex, 1)[0]);
      await window.api.reorderTabs(ids);
    });

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tab.name;
    if (tab.file) name.title = tab.file;
    el.appendChild(name);

    if (tab.dirty) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      el.appendChild(dot);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
      close.setAttribute('aria-label', 'Close tab: ' + tab.name);
    close.addEventListener('click', async (event) => {
      event.stopPropagation();
      await flushChange();
      const result = await window.api.closeTab(tab.id);
      if (result && result.closedWithDraft) {
        showToast(
          (result.draftSaved ? 'Closed with unsaved changes — a recovery draft is kept' : 'Closed with unsaved changes') +
            ' · ' + result.name,
          6000,
          [{ label: 'Reopen', run: () => window.api.reopenTab() }]
        );
      }
    });
    el.appendChild(close);

    el.addEventListener('click', async () => {
      if (tab.active) return;
      await flushChange();
      await window.api.activateTab(tab.id);
    });

    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openTabMenu(event.clientX, event.clientY, tab);
    });

    tabList.appendChild(el);
  }
  if (focusedTabId) {
    const again = [...tabList.querySelectorAll('.tab')].find((tab) => tab.dataset.id === focusedTabId);
    if (again) again.focus();
  }
  updateTabScroll();
  const active = tabList.querySelector('.tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Arrow keys move between tabs, Home/End jump, Delete closes the focused tab — the usual tablist
// keyboard model, which a <div> strip otherwise does not provide.
async function moveTabFocus(offset) {
  const tabs = [...tabList.querySelectorAll('.tab')];
  if (!tabs.length) return;
  let index = tabs.indexOf(document.activeElement);
  if (index < 0) index = tabs.findIndex((tab) => tab.classList.contains('active'));
  const next = tabs[(index + offset + tabs.length) % tabs.length];
  next.focus();
  if (!next.classList.contains('active')) {
    await flushChange();
    await window.api.activateTab(next.dataset.id);
  }
}

tabList.addEventListener('keydown', async (event) => {
  const tabs = [...tabList.querySelectorAll('.tab')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    await moveTabFocus(1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    await moveTabFocus(-1);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const next = event.key === 'Home' ? tabs[0] : tabs[tabs.length - 1];
    next.focus();
    if (!next.classList.contains('active')) {
      await flushChange();
      await window.api.activateTab(next.dataset.id);
    }
  } else if (event.key === 'Delete') {
    event.preventDefault();
    const id = tabs[index].dataset.id;
    tabs[index].focus();
    await flushChange();
    const result = await window.api.closeTab(id);
    if (result && result.closedWithDraft) {
      showToast(
        (result.draftSaved ? 'Closed with unsaved changes — a recovery draft is kept' : 'Closed with unsaved changes') +
          ' · ' + result.name,
        6000,
        [{ label: 'Reopen', run: () => window.api.reopenTab() }]
      );
    }
  }
});

// Show the scroll arrows only when the tab strip actually overflows.
const tabLeft = $('#tab-left');
const tabRight = $('#tab-right');

function updateTabScroll() {
  const overflows = tabList.scrollWidth > tabList.clientWidth + 2;
  tabLeft.hidden = !overflows;
  tabRight.hidden = !overflows;
  if (!overflows) return;
  tabLeft.disabled = tabList.scrollLeft <= 1;
  tabRight.disabled = tabList.scrollLeft + tabList.clientWidth >= tabList.scrollWidth - 1;
}

tabLeft.addEventListener('click', () => {
  tabList.scrollBy({ left: -180, behavior: 'smooth' });
});
tabRight.addEventListener('click', () => {
  tabList.scrollBy({ left: 180, behavior: 'smooth' });
});
tabList.addEventListener('scroll', updateTabScroll);
window.addEventListener('resize', updateTabScroll);

window.api.onTabs(renderTabs);

$('#tab-new').addEventListener('click', async () => {
  await flushChange();
  await window.api.newDoc();
});

window.addEventListener('keydown', async (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.shiftKey && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    openPalette();
    return;
  }
  if (event.key === 'F1') {
    event.preventDefault();
    openShortcuts();
    return;
  }
  if (mod && event.shiftKey && event.key.toLowerCase() === 't') {
    event.preventDefault();
    await flushChange();
    await window.api.reopenTab();
    return;
  }
  if (mod && !event.shiftKey && event.key.toLowerCase() === 't') {
    event.preventDefault();
    await flushChange();
    await window.api.newDoc();
  }
  if (mod && !event.shiftKey && event.key.toLowerCase() === 'j') {
    event.preventDefault();
    openAI();
  }
  if (mod && !event.shiftKey && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    const activeTab = tabsState.find((tab) => tab.active);
    if (activeTab) {
      await flushChange();
      await window.api.closeTab(activeTab.id);
    }
  }
  if (mod && event.key === ',') {
    event.preventDefault();
    openSettings();
  }
  if (event.key === 'Escape') {
    if (!palette.hidden) palette.hidden = true;
    else if (!shortcutsModal.hidden) shortcutsModal.hidden = true;
    else if (!settingsModal.hidden) settingsModal.hidden = true;
    else if (!aiPopover.hidden) aiPopover.hidden = true;
  }
});

// ---- file tree -------------------------------------------------------------

let treeRoot = null;
const treeExpanded = new Set();
const treeCache = new Map();

async function childrenOf(dir) {
  if (!treeCache.has(dir)) {
    const res = await window.api.listDir(dir);
    treeCache.set(dir, res.entries || []);
  }
  return treeCache.get(dir);
}

function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return Math.round(diff / 60_000) + 'm';
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + 'h';
  if (diff < 7 * 86_400_000) return Math.round(diff / 86_400_000) + 'd';
  const date = new Date(ms);
  return date.getMonth() + 1 + '/' + date.getDate();
}

// Right-click on the file tree: create, rename, delete. The tree is the only place users see
// their folder, so it has to be where these live.
let treeMenuTarget = null;

function closeTreeMenu() {
  const menu = document.querySelector('#tree-menu');
  if (menu) menu.hidden = true;
}

function openTreeMenu(x, y, target) {
  treeMenuTarget = target;
  const menu = document.querySelector('#tree-menu');
  if (!menu) return;
  menu.querySelector('[data-tree-action="newFile"]').hidden = !target.dir;
  menu.querySelector('[data-tree-action="newFolder"]').hidden = !target.dir;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

function refreshTree() {
  treeCache.clear();
  return renderTree();
}

function askName({ title, value = '', hint = '', confirmLabel = 'Create' }) {
  return new Promise((resolve) => {
    const modal = document.querySelector('#name-modal');
    document.querySelector('#name-title').textContent = title;
    const input = document.querySelector('#name-input');
    const hintEl = document.querySelector('#name-hint');
    input.value = value;
    hintEl.textContent = hint;
    hintEl.classList.remove('is-error');
    document.querySelector('#name-ok').textContent = confirmLabel;
    modal.hidden = false;
    input.focus();
    input.select();

    const done = (result) => {
      modal.hidden = true;
      document.querySelector('#name-ok').removeEventListener('click', ok);
      document.querySelector('#name-cancel').removeEventListener('click', cancel);
      input.removeEventListener('keydown', onKey);
      modal.removeEventListener('mousedown', onBackdrop);
      resolve(result);
    };
    const ok = () => {
      const name = input.value.trim();
      if (!name) {
        hintEl.textContent = 'A name is required';
        hintEl.classList.add('is-error');
        return;
      }
      done(name);
    };
    const cancel = () => done(null);
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        ok();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    };
    const onBackdrop = (event) => {
      if (event.target === modal) cancel();
    };
    document.querySelector('#name-ok').addEventListener('click', ok);
    document.querySelector('#name-cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', onKey);
    modal.addEventListener('mousedown', onBackdrop);
  });
}

function askConfirm(title, text, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const modal = document.querySelector('#tree-confirm');
    document.querySelector('#tree-confirm-title').textContent = title;
    document.querySelector('#tree-confirm-text').textContent = text;
    document.querySelector('#tree-confirm-ok').textContent = confirmLabel;
    modal.hidden = false;
    const done = (value) => {
      modal.hidden = true;
      document.querySelector('#tree-confirm-ok').removeEventListener('click', ok);
      document.querySelector('#tree-confirm-cancel').removeEventListener('click', cancel);
      modal.removeEventListener('mousedown', onBackdrop);
      resolve(value);
    };
    const ok = () => done(true);
    const cancel = () => done(false);
    const onBackdrop = (event) => {
      if (event.target === modal) cancel();
    };
    document.querySelector('#tree-confirm-ok').addEventListener('click', ok);
    document.querySelector('#tree-confirm-cancel').addEventListener('click', cancel);
    modal.addEventListener('mousedown', onBackdrop);
  });
}

async function newEntry(folder) {
  const target = treeMenuTarget || { dir: true, path: treeRoot ? treeRoot.root : '' };
  const name = await askName({
    title: folder ? 'New folder' : 'New file',
    value: folder ? 'New folder' : 'untitled.md',
    hint: 'Inside ' + (target.path || ''),
  });
  if (!name) return;
  const result = await window.api.createEntry(target.path, name, folder);
  if (!result.ok) {
    await askConfirm('Could not create', result.error || 'unknown error', 'OK');
    return;
  }
  if (folder) {
    treeExpanded.add(target.path);
  }
  await refreshTree();
  if (!folder) {
    await flushChange();
    await window.api.openPath(result.path);
  }
}

async function renameEntryNow() {
  const target = treeMenuTarget;
  if (!target || !target.path) return;
  const name = await askName({ title: 'Rename', value: target.name, confirmLabel: 'Rename' });
  if (!name || name === target.name) return;
  const ext = path_extension(name);
  const finalName = ext ? name : name + (target.name.includes('.') ? '.' + target.name.split('.').pop() : '');
  const result = await window.api.renameEntry(target.path, finalName);
  if (!result.ok) {
    await askConfirm('Could not rename', result.error || 'unknown error', 'OK');
    return;
  }
  await refreshTree();
}

function path_extension(name) {
  return /.[a-z0-9]+$/i.test(name);
}

async function deleteEntryNow() {
  const target = treeMenuTarget;
  if (!target || !target.path) return;
  const confirmed = await askConfirm('Delete', 'Delete "' + target.name + '"? This cannot be undone.');
  if (!confirmed) return;
  let result = await window.api.deleteEntry(target.path, false);
  if (!result.ok && result.error === 'not empty') {
    const recursive = await askConfirm(
      'Folder is not empty',
      '"' + target.name + '" contains files. Delete it and everything inside?',
      'Delete all'
    );
    if (!recursive) return;
    result = await window.api.deleteEntry(target.path, true);
  }
  if (!result.ok) {
    await askConfirm('Could not delete', result.error || 'unknown error', 'OK');
    return;
  }
  await refreshTree();
}

document.querySelector('#tree').addEventListener('contextmenu', (event) => {
  const row = event.target.closest ? event.target.closest('.tree-row') : null;
  if (!row) {
    // Empty space means the folder itself: that is how a new file is created.
    if (!treeRoot) return;
    event.preventDefault();
    openTreeMenu(event.clientX, event.clientY, { path: treeRoot.root, name: treeRoot.name, dir: true });
    return;
  }
  event.preventDefault();
  openTreeMenu(event.clientX, event.clientY, {
    path: row.dataset.path,
    name: row.dataset.name,
    dir: row.dataset.dir === '1',
  });
});

document.querySelectorAll('#tree-menu [data-tree-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.treeAction;
    closeTreeMenu();
    if (action === 'newFile') return newEntry(false);
    if (action === 'newFolder') return newEntry(true);
    if (action === 'rename') return renameEntryNow();
    if (action === 'delete') return deleteEntryNow();
    if (action === 'reveal' && treeMenuTarget) {
      await window.api.revealEntry(treeMenuTarget.path);
    }
    return true;
  });
});

document.addEventListener('mousedown', (event) => {
  const menu = document.querySelector('#tree-menu');
  if (menu && !menu.hidden && !menu.contains(event.target)) closeTreeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTreeMenu();
});

async function renderTree() {
  const host = $('#tree');
  host.textContent = '';
  if (!treeRoot) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty tree-empty-action';
    const hint = document.createElement('div');
    hint.textContent = 'No folder open';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Open a folder';
    button.addEventListener('click', () => document.querySelector('#files-choose').click());
    empty.append(hint, button);
    host.appendChild(empty);
    return;
  }
  $('#files-root').textContent = treeRoot.name || treeRoot.root;
  $('#files-root').title = treeRoot.root;
  host.appendChild(await renderDir(treeRoot.root, 0));
}

async function renderDir(dir, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-children';
  const entries = await childrenOf(dir);

  if (depth > 0 && entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.style.paddingLeft = `${10 + depth * 12}px`;
    empty.textContent = 'empty';
    wrap.appendChild(empty);
    return wrap;
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `tree-row${entry.dir ? ' is-dir' : ''}`;
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.title = entry.path;
    row.dataset.path = entry.path;
    row.dataset.dir = entry.dir ? '1' : '0';
    row.dataset.name = entry.name;

    const twisty = document.createElement('span');
    twisty.className = 'tree-twisty';
    twisty.textContent = entry.dir ? (treeExpanded.has(entry.path) ? '▾' : '▸') : '·';
    row.appendChild(twisty);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = entry.name;
    row.appendChild(label);

    if (!entry.dir && entry.mtime) {
      const meta = document.createElement('span');
      meta.className = 'tree-meta';
      meta.textContent = relativeTime(entry.mtime);
      meta.title = new Date(entry.mtime).toLocaleString();
      row.appendChild(meta);
    }

    if (entry.dir) {
      row.addEventListener('click', async () => {
        if (treeExpanded.has(entry.path)) treeExpanded.delete(entry.path);
        else treeExpanded.add(entry.path);
        await renderTree();
      });
    } else {
      row.addEventListener('click', async () => {
        await flushChange();
        await window.api.openPath(entry.path);
      });
    }

    wrap.appendChild(row);

    if (entry.dir && treeExpanded.has(entry.path)) {
      wrap.appendChild(await renderDir(entry.path, depth + 1));
    }
  }
  return wrap;
}

$('#files-choose').addEventListener('click', async () => {
  const result = await window.api.chooseFolder();
  if (result && !result.canceled) {
    treeRoot = { root: result.root, name: result.name };
    treeExpanded.clear();
    treeCache.clear();
    treeCache.set(result.root, result.entries || []);
    await renderTree();
  }
});

window.api.onTreeChanged(async () => {
  treeCache.clear();
  await renderTree();
});

window.api.onTreeRoot(async (info) => {
  if (!info || !info.root) return;
  treeRoot = { root: info.root, name: info.name };
  treeExpanded.clear();
  treeCache.clear();
  treeCache.set(info.root, info.entries || []);
  await renderTree();
});

// ---- command palette -------------------------------------------------------

const palette = $('#palette');
const paletteInput = $('#palette-input');
const paletteList = $('#palette-list');
let paletteCommands = [];
let paletteIndex = 0;

let recentFilesCache = [];

function recentCommands() {
  const p = (key) => t(key, lang);
  return recentFilesCache.slice(0, 5).map((file) => ({
    label: `${p('palette.recentPrefix')} ${file.split(/[\\/]/).pop()}`,
    run: () => window.api.openPath(file),
  }));
}

function commandList() {
  const p = (key) => t(key, lang);
  // id + hint let the palette show the shortcut and rank the commands the user actually runs.
  return [
    { id: 'save', hint: 'Ctrl+S', label: p('palette.save'), run: () => saveDocument() },
    { id: 'saveAs', hint: 'Ctrl+Shift+S', label: p('palette.saveAs'), run: () => window.api.saveAs() },
    { id: 'extractImages', label: 'Extract embedded images', run: () => actions.extractImages() },
    { id: 'open', hint: 'Ctrl+O', label: p('palette.open'), run: () => actions.open() },
    { id: 'openFolder', hint: 'Ctrl+Shift+O', label: p('palette.openFolder'), run: () => actions.openFolder() },
    { id: 'newTab', hint: 'Ctrl+T', label: p('palette.newTab'), run: () => actions.new() },
    { id: 'closeTab', hint: 'Ctrl+W', label: p('palette.closeTab'), run: async () => {
        const activeTab = tabsState.find((tab) => tab.active);
        if (activeTab) await window.api.closeTab(activeTab.id);
      },
    },
    { id: 'reopenTab', hint: 'Ctrl+Shift+T', label: p('palette.reopenTab'), run: () => window.api.reopenTab() },
    { id: 'find', hint: 'Ctrl+F', label: p('palette.find'), run: openFind },
    { id: 'outline', hint: '', label: p('palette.outline'), run: actions.toggleOutline },
    { id: 'ai', hint: 'Ctrl+J', label: p('palette.ai'), run: openAI },
    { id: 'appearance', hint: 'Aa', label: p('cmd.appearance'), run: () => openSettings('appearance') },
    { id: 'split', hint: 'Ctrl+Alt+2', label: p('palette.split'), run: () => splitWindowRequest() },
    { id: 'unsplit', hint: 'Ctrl+Alt+1', label: p('palette.unsplit'), run: () => unsplitWindowRequest() },
    { id: 'settings', hint: 'Ctrl+,', label: p('palette.settings'), run: openSettings },
    { id: 'shortcuts', hint: 'F1', label: p('palette.shortcuts'), run: openShortcuts },
    { id: 'stats', hint: '', label: p('palette.stats'), run: openStats },
    { id: 'exportHtml', hint: '', label: p('palette.exportHtml'), run: () => openExportPanel('html') },
    { id: 'exportPdf', hint: '', label: p('palette.exportPdf'), run: () => openExportPanel('pdf') },
    { id: 'exportWord', hint: '', label: p('palette.exportWord'), run: () => openExportPanel('docx') },
    { id: 'exportEpub', hint: '', label: p('palette.exportEpub'), run: () => openExportPanel('epub') },
    { id: 'previewExport', hint: '', label: p('palette.previewExport'), run: () => runExport('preview') },
    { id: 'themeLight', hint: '', label: p('palette.themeLight'), run: () => setTheme('light') },
    { id: 'themeDark', hint: '', label: p('palette.themeDark'), run: () => setTheme('dark') },
    { id: 'themeSepia', hint: '', label: p('palette.themeSepia'), run: () => setTheme('sepia') },
    { id: 'focusMode', hint: 'Ctrl+Shift+K', label: p('palette.focusMode'), run: () => toggleFocusMode() },
    { id: 'aiUsage', hint: '', label: p('palette.aiUsage'), run: () => openUsagePanel() },
    ...recentCommands(),
  ];
}

async function setTheme(theme) {
  applyTheme(theme);
  await window.api.setSettings({ theme });
}

// Swap the highlight theme with the app theme instead of filtering colors.
// "system" resolves to dark or light from the OS; the resolved value is what the CSS sees.
let systemThemeDark = false;
let readThemeSetting = 'light';

function resolveTheme(theme) {
  if (theme !== 'system') return theme;
  return systemThemeDark ? 'dark' : 'light';
}

function applyTheme(theme) {
  // Transitions would make every colour interpolate during a theme swap: it flashes, and any
  // measurement taken right after the switch sees the old palette. Disable them for one frame.
  readThemeSetting = theme;
  const root = document.documentElement;
  const applied = resolveTheme(theme);
  root.classList.add('theme-swap');
  root.dataset.theme = applied;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-swap')));
  refreshMermaidPreviews();
  const light = document.querySelector('#hljs-light');
  const dark = document.querySelector('#hljs-dark');
  if (light && dark) {
    light.disabled = applied === 'dark';
    dark.disabled = applied !== 'dark';
  }
  const select = $('#theme');
  if (select) select.value = theme === 'system' ? 'system' : theme;
}

let paletteUsage = {};

function recordPaletteUse(id) {
  if (!id) return;
  paletteUsage[id] = (paletteUsage[id] || 0) + 1;
  window.api.setSettings({ paletteUsage }).catch(() => {});
}

// Mark the part of a command name that matched, so a fuzzy-looking list explains itself.
function highlightMatch(text, query) {
  if (!query) return [document.createTextNode(text)];
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return [document.createTextNode(text)];
  return [
    document.createTextNode(text.slice(0, at)),
    Object.assign(document.createElement('mark'), { textContent: text.slice(at, at + query.length) }),
    document.createTextNode(text.slice(at + query.length)),
  ];
}

function renderPalette() {
  const query = paletteInput.value.trim().toLowerCase();
  const all = commandList();
  const matches = all.filter((cmd) => cmd.label.toLowerCase().includes(query));
  if (!query) {
    // With nothing typed, the commands this user actually runs come first.
    matches.sort((a, b) => (paletteUsage[b.id] || 0) - (paletteUsage[a.id] || 0));
  }
  paletteCommands = matches;
  if (paletteIndex >= paletteCommands.length) paletteIndex = Math.max(0, paletteCommands.length - 1);
  paletteList.textContent = '';
  paletteCommands.forEach((cmd, index) => {
    const row = document.createElement('div');
    row.className = `palette-row${index === paletteIndex ? ' active' : ''}`;
    const label = document.createElement('span');
    label.className = 'palette-label';
    for (const part of highlightMatch(cmd.label, query)) label.appendChild(part);
    row.appendChild(label);
    if (cmd.hint) {
      const hint = document.createElement('span');
      hint.className = 'palette-hint';
      hint.textContent = cmd.hint;
      row.appendChild(hint);
    }
    row.addEventListener('click', () => {
      closePalette();
      recordPaletteUse(cmd.id);
      cmd.run();
    });
    paletteList.appendChild(row);
  });
}

function openPalette() {
  palette.hidden = false;
  window.api
    .recentList()
    .then((list) => {
      recentFilesCache = Array.isArray(list) ? list : [];
      renderPalette();
    })
    .catch(() => {});
  paletteInput.value = '';
  paletteIndex = 0;
  renderPalette();
  paletteInput.focus();
}

function closePalette() {
  palette.hidden = true;
}

function runPaletteSelection() {
  const cmd = paletteCommands[paletteIndex];
  if (!cmd) return;
  closePalette();
  cmd.run();
}

paletteInput.addEventListener('input', () => {
  paletteIndex = 0;
  renderPalette();
});
paletteInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    paletteIndex = Math.min(paletteIndex + 1, paletteCommands.length - 1);
    renderPalette();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    paletteIndex = Math.max(paletteIndex - 1, 0);
    renderPalette();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runPaletteSelection();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closePalette();
  }
});

// ---- shortcuts help --------------------------------------------------------

const shortcutsModal = $('#shortcuts');

function openShortcuts() {
  shortcutsModal.hidden = false;
}

$('#shortcuts-close').addEventListener('click', () => {
  shortcutsModal.hidden = true;
});
shortcutsModal.addEventListener('click', (event) => {
  if (event.target === shortcutsModal) shortcutsModal.hidden = true;
});

// ---- empty state -----------------------------------------------------------

const emptyHint = $('#empty-hint');

// The card is an overlay; it can be dismissed for good instead of reappearing on every
// empty tab. Dismissal is remembered in settings.
let guideDismissed = false;

// The guide belongs to a blank untitled document: an empty file the user opened on purpose
// should not be covered by it.
let activeIsUntitled = true;

function syncEmptyHint() {
  emptyHint.hidden =
    guideDismissed || !editor.isEmpty || !activeIsUntitled || !aiPopover.hidden || !palette.hidden;
}

function showWelcomeGuide() {
  guideDismissed = false;
  window.api.setSettings({ guideDismissed: false }).catch(() => {});
  syncEmptyHint();
}

$('#empty-dismiss').addEventListener('click', () => {
  guideDismissed = true;
  syncEmptyHint();
  window.api.setSettings({ guideDismissed: true }).catch(() => {});
});

$('#empty-new').addEventListener('click', () => window.api.newDoc());
$('#empty-folder').addEventListener('click', () => actions.openFolder());
$('#empty-ai').addEventListener('click', () => openAI());
$('#empty-skip').addEventListener('click', () => {
  guideDismissed = true;
  syncEmptyHint();
  window.api.setSettings({ guideDismissed: true }).catch(() => {});
});
// Demonstrate the slash menu instead of describing it: focus the empty paragraph and type "/".
$('#empty-block').addEventListener('click', () => {
  editor.chain().focus('end').insertContent('/').run();
});
$('#empty-export').addEventListener('click', () => openExportPanel('pdf'));

window.api.onWelcomeGuide(() => {
  showWelcomeGuide();
  if (!activeIsUntitled || !editor.isEmpty) window.api.newDoc();
});

editor.on('update', syncEmptyHint);
editor.on('selectionUpdate', syncEmptyHint);


// ---- appearance ------------------------------------------------------------

const FONTS = ['serif', 'sans', 'yahei', 'simsun', 'kaiti', 'fangsong', 'times', 'arial', 'cambria', 'mono'];

// A preset is the combination most people would never assemble by hand. Picking one is the
// difference between "four settings that happen to look fine" and a document that looks designed.
const TYPOGRAPHY_PRESETS = {
  book: { editorFont: 'serif', lineWidth: 'normal', accent: 'amber' },
  report: { editorFont: 'cambria', lineWidth: 'normal', accent: 'blue' },
  minimal: { editorFont: 'sans', lineWidth: 'wide', accent: 'violet' },
  technical: { editorFont: 'arial', lineWidth: 'wide', accent: 'teal' },
  chinese: { editorFont: 'yahei', lineWidth: 'normal', accent: 'blue' },
};

function applyPreset(key) {
  const preset = TYPOGRAPHY_PRESETS[key];
  if (!preset) return null;
  document.querySelector('#set-font').value = preset.editorFont;
  document.querySelector('#set-width').value = preset.lineWidth;
  document.querySelector('#set-accent').value = preset.accent;
  return preset;
}
const WIDTHS = ['narrow', 'normal', 'wide'];
const ACCENTS = ['blue', 'teal', 'violet', 'amber'];

function applyAppearance(settings = {}) {
  const font = FONTS.includes(settings.editorFont) ? settings.editorFont : 'serif';
  const width = WIDTHS.includes(settings.lineWidth) ? settings.lineWidth : 'normal';
  const accent = ACCENTS.includes(settings.accent) ? settings.accent : 'blue';
  document.documentElement.dataset.font = font;
  document.documentElement.dataset.width = width;
  document.documentElement.dataset.accent = accent;
}

function applyFilesCollapsed(collapsed) {
  const pane = document.querySelector('#files');
  if (!pane) return;
  pane.classList.toggle('collapsed', Boolean(collapsed));
  const toggle = document.querySelector('#files-toggle');
  if (toggle) {
    toggle.dataset.icon = collapsed ? 'chevronRight' : 'chevronLeft';
    toggle.title = collapsed ? 'Show the file tree' : 'Hide the file tree';
    applyStaticIcons(toggle.parentElement || document);
  }
}

function toggleFilesPane() {
  const pane = document.querySelector('#files');
  if (!pane) return false;
  const collapsed = !pane.classList.contains('collapsed');
  applyFilesCollapsed(collapsed);
  window.api.setSettings({ filesCollapsed: collapsed }).catch(() => {});
  return collapsed;
}

document.querySelector('#files-toggle').addEventListener('click', () => toggleFilesPane());

document.querySelector('#open-appearance').addEventListener('click', () => openSettings('appearance'));

// Side-by-side editing uses two real windows placed on the two halves of the display; an unsaved
// document has no path to open in the second one, so say that instead of doing nothing.
async function unsplitWindowRequest() {
  const result = await window.api.unsplitWindow().catch(() => ({ ok: false }));
  if (result && result.ok) return true;
  showToast(t('menu.unsplitFailed', lang), 3600);
  return false;
}

async function splitWindowRequest() {
  const result = await window.api.splitWindow().catch(() => ({ ok: false, reason: 'error' }));
  if (result && result.ok) return true;
  showToast(t(result && result.reason === 'unsaved' ? 'menu.splitNeedsFile' : 'menu.splitFailed', lang), 4200);
  return false;
}

document.querySelectorAll('#export-format [data-format]').forEach((button) => {
  button.addEventListener('click', () => setExportFormat(button.dataset.format));
});
document.querySelector('#export-template').addEventListener('change', () => {
  refreshExportSummary();
  refreshExportThumb();
});
document.querySelector('#export-font').addEventListener('change', () => {
  refreshExportSummary();
  refreshExportThumb();
});
document.querySelector('#export-margin').addEventListener('change', () => {
  refreshExportSummary();
  refreshExportThumb();
});
document
  .querySelector('#export-name')
  .addEventListener('input', () => refreshExportNameHintFor('#export-name', '#export-name-hint'));
document.querySelector('#export-cancel').addEventListener('click', () => {
  document.querySelector('#export-modal').hidden = true;
});
document.querySelector('#export-preview-open').addEventListener('click', async () => {
  await saveExportPanelSettings();
  await runExport('preview');
});
document.querySelector('#export-run').addEventListener('click', async () => {
  await saveExportPanelSettings();
  document.querySelector('#export-modal').hidden = true;
  const result = await runExport(exportFormat).catch((err) => ({ exported: false, error: err.message }));
  if (result && result.exported === false && result.error) {
    showBanner(
      'Export failed',
      'The file could not be written: ' + result.error,
      'Retry',
      () => runExport(exportFormat),
      'Dismiss',
      () => {}
    );
  }
});
document.querySelector('#export-modal').addEventListener('click', (event) => {
  if (event.target.id === 'export-modal') document.querySelector('#export-modal').hidden = true;
});

// Settings navigation: jump to a section inside the scrolling body.
for (const button of document.querySelectorAll('.settings-nav [data-goto]')) {
  button.addEventListener('click', () => {
    const section = document.querySelector(`#settings-modal .modal-sub[data-section="${button.dataset.goto}"]`);
    if (!section) return;
    section.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

document.querySelector('#set-ai-key-clear').addEventListener('click', async () => {
  const input = document.querySelector('#set-ai-key');
  input.value = '';
  input.dataset.clear = 'true';
  const note = document.querySelector('#set-ai-note');
  note.textContent = 'The saved key will be removed when you save.';
  note.classList.add('is-warning');
});

document.querySelector('#set-preset').addEventListener('change', (event) => {
  const preset = applyPreset(event.target.value);
  if (!preset) return;
  applyAppearance(preset);
});

// ---- table: alignment buttons and a hover toolbar ---------------------------

function setCellAlignment(align) {
  try {
    editor.chain().focus().setCellAttribute('textAlign', align).run();
  } catch {
    /* not in a table */
  }
}

for (const button of document.querySelectorAll('[data-align]')) {
  button.addEventListener('click', () => setCellAlignment(button.dataset.align));
}

function ensureTableHover() {
  let bar = document.querySelector('#table-hover');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'table-hover';
  bar.className = 'table-hover';
  bar.hidden = true;
  const actions = [
    { label: '＋ row', title: 'Add a row below', run: () => editor.chain().focus().addRowAfter().run() },
    { label: '＋ col', title: 'Add a column right', run: () => editor.chain().focus().addColumnAfter().run() },
    { label: '− row', title: 'Delete this row', run: () => editor.chain().focus().deleteRow().run(), danger: true },
    { label: '− col', title: 'Delete this column', run: () => editor.chain().focus().deleteColumn().run(), danger: true },
    { label: '✕ table', title: 'Delete the table', run: () => editor.chain().focus().deleteTable().run(), danger: true },
  ];
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.title = action.title;
    button.setAttribute('aria-label', action.title);
    if (action.danger) button.classList.add('danger');
    // Keep the editor selection while pressing, but act on click so keyboard activation works.
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      action.run();
      hideTableHover();
    });
    bar.appendChild(button);
  }
  document.body.appendChild(bar);
  return bar;
}

function hideTableHover() {
  const bar = document.querySelector('#table-hover');
  if (bar) bar.hidden = true;
}

function showTableHover(table) {
  const bar = ensureTableHover();
  const rect = table.getBoundingClientRect();
  bar.hidden = false;
  const top = Math.max(8, rect.top - 34);
  const left = Math.min(window.innerWidth - bar.offsetWidth - 12, Math.max(8, rect.right - bar.offsetWidth));
  bar.style.top = top + 'px';
  bar.style.left = left + 'px';
}

// The bar sits outside the editor DOM, so leaving the table must not hide it instantly:
// a short grace period lets the pointer travel onto the bar, and hovering the bar cancels it.
let tableHoverTimer = null;
function scheduleHideTableHover() {
  clearTimeout(tableHoverTimer);
  tableHoverTimer = setTimeout(hideTableHover, 220);
}

editor.view.dom.addEventListener('mousemove', (event) => {
  const table = event.target.closest ? event.target.closest('table') : null;
  if (table) {
    clearTimeout(tableHoverTimer);
    showTableHover(table);
  } else {
    scheduleHideTableHover();
  }
});
editor.view.dom.addEventListener('mouseleave', scheduleHideTableHover);
document.querySelector('.editor-pane').addEventListener('scroll', hideTableHover, { passive: true });

document.addEventListener('mousemove', (event) => {
  const bar = document.querySelector('#table-hover');
  if (!bar || bar.hidden) return;
  if (bar.contains(event.target)) {
    clearTimeout(tableHoverTimer);
    return;
  }
  if (event.target.closest && event.target.closest('table')) return;
  scheduleHideTableHover();
});

// ---- zoom ------------------------------------------------------------------

const zoomIndicator = document.querySelector('#zoom-indicator');

function renderZoom({ level, percent }) {
  if (!zoomIndicator) return;
  const changed = Math.abs(level) > 0.01;
  zoomIndicator.hidden = !changed;
  zoomIndicator.textContent = percent + '%';
  zoomIndicator.title = 'Zoom ' + percent + '% (Ctrl+0 resets)';
}

async function zoomAction(direction) {
  const state = await window.api.zoomAction(direction).catch(() => null);
  if (state) renderZoom(state);
  return state;
}

zoomIndicator?.addEventListener('click', () => zoomAction('reset'));

window.api.onSystemTheme(({ dark }) => {
  systemThemeDark = Boolean(dark);
  if ((readThemeSetting || 'light') === 'system') applyTheme('system');
});
window.api
  .systemTheme()
  .then(({ dark }) => {
    systemThemeDark = Boolean(dark);
    if ((readThemeSetting || 'light') === 'system') applyTheme('system');
  })
  .catch(() => {});
window.api.zoomState().then(renderZoom).catch(() => {});

document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === '=' || event.key === '+') {
    event.preventDefault();
    zoomAction('in');
  } else if (event.key === '-') {
    event.preventDefault();
    zoomAction('out');
  } else if (event.key === '0') {
    event.preventDefault();
    zoomAction('reset');
  }
});

// ---- save indicator --------------------------------------------------------

const saveStateEl = $('#save-state');

function renderSaveState(payload) {
  if (!saveStateEl || !payload) return;
  const state = payload.state;
  saveStateEl.hidden = false;
  saveStateEl.classList.toggle('is-saving', state === 'saving');
  saveStateEl.classList.toggle('is-dirty', state === 'dirty');
  if (state === 'saving') saveStateEl.textContent = 'Saving…';
  else if (state === 'dirty') saveStateEl.textContent = 'Unsaved';
  else if (payload.savedAt) {
    saveStateEl.textContent = 'Saved ' + new Date(payload.savedAt).toLocaleTimeString();
  }
}

window.api.onSaveState(renderSaveState);
window.api.info().then((info) => {
  if (info && info.savedAt) renderSaveState({ state: 'saved', savedAt: info.savedAt });
}).catch(() => {});

// ---- document statistics ---------------------------------------------------

const statsModal = $('#stats-modal');

function documentStats() {
  const text = editor.getText();
  const words = (text.match(/\S+/g) || []).length;
  const chars = text.length;
  const noSpaces = text.replace(/\s+/g, '').length;
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim()).length;
  let headings = 0;
  let images = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'heading') headings += 1;
    if (node.type.name === 'image') images += 1;
  });
  return {
    words,
    chars,
    noSpaces,
    paragraphs,
    headings,
    images,
    reading: Math.max(1, Math.round(words / 200)),
  };
}

async function openStats() {
  const s = documentStats();
  const info = await window.api.info().catch(() => ({}));
  const { from, to, empty } = editor.state.selection;
  const selectedChars = empty ? 0 : editor.state.doc.textBetween(from, to, ' ').length;
  const rows = [
    [
      t('stats.selection', lang),
      empty ? t('stats.noSelection', lang) : t('stats.charsSelected', lang, { count: selectedChars }),
    ],
    [t('stats.words', lang), s.words],
    [t('stats.characters', lang), s.chars],
    [t('stats.noSpaces', lang), s.noSpaces],
    [t('stats.paragraphs', lang), s.paragraphs],
    [t('stats.headings', lang), s.headings],
    [t('stats.images', lang), s.images],
    [t('stats.reading', lang), t('stats.minutes', lang, { count: s.reading })],
    [
      t('stats.savedAt', lang),
      info.savedAt ? new Date(info.savedAt).toLocaleTimeString() : t('stats.neverSaved', lang),
    ],
  ];
  const table = $('#stats-table');
  table.textContent = '';
  for (const [label, value] of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('td');
    th.textContent = label;
    const td = document.createElement('td');
    td.textContent = String(value);
    tr.append(th, td);
    table.appendChild(tr);
  }
  statsModal.hidden = false;
}

$('#stats-close').addEventListener('click', () => {
  statsModal.hidden = true;
});
statsModal.addEventListener('click', (event) => {
  if (event.target === statsModal) statsModal.hidden = true;
});

// ---- top bar / menu --------------------------------------------------------

const actions = {
  new: async () => { await flushChange(); return window.api.newDoc(); },
  open: async () => { await flushChange(); return window.api.open(); },
  save: () => saveDocument(),
  saveAs: () => window.api.saveAs(),
  extractImages: async () => {
    const result = await window.api.extractImages();
    if (result && result.extracted) {
      flash(t('dialog.extracted', lang, { count: result.count }));
    } else if (result && result.reason === 'dirty') {
      flash('Save the document first, then extract its images');
    }
  },
  exportHtml: () => openExportPanel('html'),
  exportPdf: () => openExportPanel('pdf'),
  exportDocx: () => openExportPanel('docx'),
  exportEpub: () => openExportPanel('epub'),
  find: openFind,
  exportSettings: async () => {
    const result = await window.api.settingsExport();
    if (result && result.exported) flash('settings exported');
  },
  previewExport: async () => {
    await window.api.exportPreview();
  },
  recoverDrafts: async () => {
    await openDraftsPanel();
  },
  importSettings: async () => {
    const result = await window.api.settingsImport();
    if (result && result.imported) {
      applyTheme(result.settings.theme);
      applyI18n(result.settings.language);
      flash('settings imported');
    }
  },
  openFolder: async () => {
    const result = await window.api.chooseFolder();
    if (result && !result.canceled) {
      treeRoot = { root: result.root, name: result.name };
      treeExpanded.clear();
      treeCache.clear();
      treeCache.set(result.root, result.entries || []);
      await renderTree();
    }
  },
  toggleOutline: () => outlinePane.classList.toggle('collapsed'),
  toggleFocusMode: () => toggleFocusMode(),
};

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => actions[button.dataset.action]?.());
});

window.api.onMenuAction((action) => actions[action]?.());
$('#toggle-outline').addEventListener('click', actions.toggleOutline);

$('#theme').addEventListener('change', async (event) => {
  readThemeSetting = event.target.value;
  const theme = event.target.value;
  applyTheme(theme);
  await window.api.setSettings({ theme });
});

// ---- events from main ------------------------------------------------------

function showBanner(text, primaryLabel, primaryFn, secondaryLabel, secondaryFn) {
  bannerText.textContent = text;
  bannerPrimary.textContent = primaryLabel;
  bannerPrimary.onclick = () => { banner.hidden = true; primaryFn(); };
  bannerSecondary.hidden = !secondaryLabel;
  if (secondaryLabel) {
    bannerSecondary.textContent = secondaryLabel;
    bannerSecondary.onclick = () => { banner.hidden = true; secondaryFn(); };
  }
  banner.hidden = false;
}

// Typewriter scrolling: keep the caret around the middle of the viewport while typing.
let typewriterEnabled = false;

function setParagraphHighlight(on) {
  highlightParagraphEnabled = on === true;
  if (editor && editor.view) {
    editor.view.dispatch(editor.state.tr.setMeta('mdpadHighlight', on));
  }
}

function typewriterFollow() {
  if (!typewriterEnabled || !editorPane) return;
  if (!editor.view.hasFocus || !editor.view.hasFocus()) return;
  const { from } = editor.state.selection;
  const coords = editor.view.coordsAtPos(from);
  const pane = editorPane.getBoundingClientRect();
  const target = pane.top + pane.height * 0.45;
  const delta = coords.top - target;
  if (Math.abs(delta) < 4) return;
  editorPane.scrollTop += delta;
}

// A change made in another window arrives here; apply everything the shell renders from settings.
function applyRemoteSettings(settings) {
  if (!settings) return;
  readThemeSetting = settings.theme || 'light';
  applyTheme(settings.theme || 'light');
  if (settings.language) {
    applyI18n(settings.language);
    applyStaticIcons();
  }
  applyAppearance(settings);
  applyFilesCollapsed(Boolean(settings.filesCollapsed));
  applyFindOptions?.();
  typewriterEnabled = settings.typewriter === true;
  editor.view.dom.classList.toggle('typewriter', typewriterEnabled);
}

window.api.onSettingsApplied(applyRemoteSettings);

window.api.onLoadDraft(({ contents }) => {
    setMarkdown(contents);
  scheduleChange();
});

// Per-tab editor state keeps the undo history alive across tab switches. The cached
// markdown is compared with what main sends: if the file changed on disk (or another
// window saved it), the cache is stale and we fall back to reloading the content.
const editorStateCache = new Map();
// The editor keeps its selection per tab; the scroll position is DOM state, so remember it too.
// Losing your place when switching tabs is especially painful in a long document.
const tabScroll = new Map();
const editorPane = document.querySelector('.editor-pane');
let activeTabId = null;

function cacheActiveEditorState() {
  if (!activeTabId) return;
  try {
    editorStateCache.set(activeTabId, { state: editor.view.state, markdown: currentMarkdown() });
    tabScroll.set(activeTabId, editorPane ? editorPane.scrollTop : 0);
  } catch {
    /* a broken state is not worth caching */
  }
}

window.api.onLoaded(async ({ id, file, contents, draft }) => {
  const nextId = id || null;
  activeIsUntitled = !file;
  if (activeTabId && activeTabId !== nextId) cacheActiveEditorState();
  const cached = nextId ? editorStateCache.get(nextId) : null;
  if (cached && cached.markdown === contents) {
    applying = true;
    editor.view.updateState(cached.state);
    applying = false;
    updateStats();
    syncToolbar();
    renderOutline();
  } else {
    const loadStartedAt = performance.now();
    await setMarkdownProgressive(contents);
    markLargeDocument();
    lastLoadTiming = {
      renderMs: Math.round(performance.now() - loadStartedAt),
      chars: contents.length,
      nodes: editor.state.doc.nodeCount || editor.state.doc.childCount,
      phases: lastSetMarkdownPhases,
    };
    lastLoadTiming = {
      renderMs: Math.round(performance.now() - loadStartedAt),
      chars: contents.length,
      nodes: editor.state.doc.nodeCount || editor.state.doc.childCount,
      textLen: editor.getText().length,
      phases: lastSetMarkdownPhases,
    };
  }
  activeTabId = nextId;
  syncEmptyHint();
  // Restore after the new content has been laid out; clamp in case the document got shorter.
  const wantedScroll = (nextId && tabScroll.get(nextId)) || 0;
  if (editorPane) {
    requestAnimationFrame(() => {
      const max = Math.max(0, editorPane.scrollHeight - editorPane.clientHeight);
      editorPane.scrollTop = Math.min(wantedScroll, max);
    });
  }
  docName.textContent = file ? file.split(/[\\/]/).pop() : 'Untitled';
  setDirty(false);
  // Tell main what the editor's own serialization looks like, so the file is not
  // considered dirty just because the round-trip normalized whitespace.
  window.api.normalizeDoc(currentMarkdown()).catch(() => {});
  if (draft && draft.contents && draft.contents !== contents) {
    showBanner(
      `Unsaved changes from ${new Date(draft.updatedAt).toLocaleString()} were found.`,
      'Restore', () => { setMarkdown(draft.contents); scheduleChange(); },
      'Discard', () => { window.api.discardDraft(); }
    );
  }
  window.api
    .backupInfo()
    .then(({ count, lastAt }) => updateBackupInfo(count, lastAt))
    .catch(() => {});
});

window.api.onDocReloaded(({ contents }) => {
  setMarkdown(contents);
  updateStats();
});

window.api.onDocReloaded(({ contents }) => {
  setMarkdown(contents);
  updateStats();
});

window.api.onFileExternal(() => {
  showBanner('This file changed on disk.', 'Reload', () => window.api.reloadFile(), 'Keep editing', () => {});
});

function showToast(text, ms = 3800, actions = []) {
  const toast = document.querySelector('#toast');
  toast.textContent = '';
  const label = document.createElement('span');
  label.className = 'toast-text';
  label.textContent = text;
  toast.appendChild(label);
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.setAttribute('aria-label', action.label);
    button.addEventListener('click', () => {
      toast.hidden = true;
      action.run();
    });
    toast.appendChild(button);
  }
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, ms);
}

// After an export, offer to open the file or reveal it, the way Typora does.
window.api.onExported((payload) => {
  if (!payload || !payload.path) return;
  const name = String(payload.path).split(/[\\/]/).pop();
  showToast(t('export.done', lang, { name }), 9000, [
    { label: t('export.open', lang), run: () => window.api.openExportedFile(payload.path) },
    { label: t('export.reveal', lang), run: () => window.api.revealExportedFile(payload.path) },
  ]);
});

window.api.onFirstRun(() => {
  showBanner(
    t('firstRun.text', lang),
    t('firstRun.setup', lang),
    () => {
      openSettings();
      window.api.setSettings({ onboarded: true }).catch(() => {});
    },
    t('firstRun.gotIt', lang),
    () => {
      window.api.setSettings({ onboarded: true }).catch(() => {});
    }
  );
});

window.api.onPreflight(({ failed }) => {
  const detail = (failed || []).map((entry) => `${entry.name}: ${entry.error}`).join('\n');
  const banner = document.querySelector('#preflight-banner');
  document.querySelector('#preflight-text').textContent = t('preflight.failed', lang, { detail });
  banner.hidden = false;
});

window.api.onSessionTruncated(({ dropped }) => {
  showToast(t('session.truncated', lang, { count: dropped }), 6000);
});

window.api.onSessionRestored(({ tabs }) => {
  showToast(t('session.restored', lang, { count: tabs }));
});

window.api.onCrashed(({ drafts }) => {
  const text =
    drafts > 0
      ? t('crash.withDrafts', lang, { count: drafts })
      : t('crash.noDrafts', lang);
  document.querySelector('#crash-text').textContent = text;
  const banner = document.querySelector('#crash-banner');
  banner.hidden = false;
  document.querySelector('#crash-open').onclick = () => window.api.openDraftsFolder();
  document.querySelector('#crash-dismiss').onclick = () => {
    banner.hidden = true;
  };
});

function updateBackupInfo(count, lastAt) {
  const info = document.querySelector('#backup-info');
  if (!info) return;
  if (!count) {
    info.textContent = '';
    return;
  }
  const time = lastAt ? new Date(lastAt).toLocaleTimeString() : '';
  info.textContent = time
    ? `${t('status.backups', lang, { count })} · ${time}`
    : t('status.backups', lang, { count });
}

async function openBackupPopover() {
  const popover = document.querySelector('#backup-popover');
  const list = document.querySelector('#backup-list');
  const backups = await window.api.backupsList();
  list.textContent = '';
  const count = document.querySelector('#backup-count');
  if (count) count.textContent = backups.length ? String(backups.length) : '';
  if (!backups.length) {
    const empty = document.createElement('div');
    empty.className = 'backup-empty';
    empty.textContent = t('backup.empty', lang);
    list.append(empty);
  }
  for (const entry of backups.slice(0, 12)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'backup-item';
    const when = document.createElement('span');
    when.className = 'backup-when';
    when.textContent = relativeAge(entry.mtime, lang);
    const size = document.createElement('span');
    size.className = 'backup-size';
    size.textContent = Math.max(1, Math.round(entry.size / 1024)) + ' KB';
    button.title = new Date(entry.mtime).toLocaleString();
    button.append(when, size);
    button.addEventListener('click', async () => {
      const result = await window.api.restoreBackup(entry.path);
      if (result && result.restored) {
        setMarkdown(result.contents);
        scheduleChange();
        flash(t('backup.restored', lang));
      }
      popover.hidden = true;
    });
    list.append(button);
  }
  popover.hidden = false;
}

document.querySelector('#backup-open-folder').addEventListener('click', async (event) => {
  event.stopPropagation();
  await window.api.openBackupsFolder();
});

document.querySelector('#backup-info').addEventListener('click', (event) => {
  event.stopPropagation();
  const popover = document.querySelector('#backup-popover');
  if (popover.hidden) openBackupPopover();
  else popover.hidden = true;
});

document.addEventListener('click', (event) => {
  const popover = document.querySelector('#backup-popover');
  if (popover.hidden) return;
  if (popover.contains(event.target) || event.target.id === 'backup-info') return;
  popover.hidden = true;
});

const statusLog = [];

window.api.onStatus((payload) => {
  statusLog.push(payload);
  if (statusLog.length > 50) statusLog.shift();
  if (payload.exporting) flash(t('status.exporting', lang, { kind: payload.exporting.toUpperCase() }));
  if (payload.file) docName.textContent = payload.file.split(/[\\/]/).pop();
  if (payload.saved) {
    flash(payload.backup ? 'saved · backup created' : 'saved');
    banner.hidden = true;
  }
  if (typeof payload.backups === 'number') {
    updateBackupInfo(payload.backups, payload.lastBackupAt);
  }
  if (payload.exported) flash(`exported ${payload.exported.path.split(/[\\/]/).pop()}`);
  if (payload.sizeWarning) {
    showBanner(t('export.largeWarning', lang, { size: payload.sizeWarning }), 'OK', () => {}, '', () => {});
  }
  if (payload.draftError) {
    draftBannerShown = true;
    showBanner(
      'Recovery drafts are off: ' + payload.draftError + '. Your text is not protected against a crash.',
      'Open folder',
      () => window.api.openDataFolder(),
      'Dismiss',
      () => {}
    );
  } else if (payload.draftOk) {
    if (draftBannerShown) {
      draftBannerShown = false;
      banner.hidden = true;
    }
  }
  if (payload.backupError) {
    backupBannerShown = true;
    showBanner(
      'Backups are off: ' + payload.backupError + '. Saving still works, but there is no previous version to go back to.',
      'Open folder',
      () => window.api.openDataFolder(),
      'Dismiss',
      () => {}
    );
  } else if (payload.backupOk) {
    if (backupBannerShown) {
      backupBannerShown = false;
      banner.hidden = true;
    }
  }
  if (payload.saveFailed) {
    showBanner(
      payload.readOnly
        ? 'This file cannot be written. Your text is kept; editing continues without autosave.'
        : `Save failed — ${payload.error || 'unknown error'}. Your text is still here.`,
      'Retry',
      () => saveDocument(),
      'Dismiss',
      () => {}
    );
  } else if (payload.error) {
    flash(payload.error);
  }
  // The status bar used to print the whole backups path, which is noise in a writing app;
  // keep it as a tooltip on the backup indicator instead.
  if (payload.backupsDir) {
    const info = document.querySelector('#backup-info');
    if (info) info.title = payload.backupsDir;
  }
  if (typeof payload.dirty === 'boolean') setDirty(payload.dirty);
});

window.api.onPreview(() => {});
window.api.onOutline(() => {});

(async () => {
  const settings = await window.api.getSettings();
  const theme = settings.theme || 'light';
  readThemeSetting = theme;
  applyTheme(theme);
  applyI18n(settings.language || 'en');
  aiConfirmThreshold = settings.aiConfirmOverTokens ?? 20000;
  {
    const initial = initialScope(settings.aiContextScope);
    aiContextScope = initial.scope;
    aiScopeExplicit = initial.explicit;
  }
  focusModeEnabled = settings.focusMode === true;
  applyAppearance(settings);
  applyFilesCollapsed(settings.filesCollapsed === true);
  updateActiveBlock();
  applySectionState(settings.collapsedSections);
  paletteUsage = settings.paletteUsage && typeof settings.paletteUsage === 'object' ? settings.paletteUsage : {};
  guideDismissed = settings.guideDismissed === true;
  syncEmptyHint();
  aiScopeExplicit = Boolean(settings.aiContextScope);
  const scopeSelect = document.querySelector('#ai-scope');
  if (scopeSelect) scopeSelect.value = aiContextScope;
  try {
    const stored = await window.api.aiHistoryGet();
    if (Array.isArray(stored) && stored.length) {
      aiHistory.push(...stored.slice(-4));
    }
  } catch {
    /* history is best effort */
  }
  updateStats();
  syncToolbar();
  refreshDraftsBadge();
})();

// ---- diagnostics -----------------------------------------------------------

function reportError(kind, payload) {
  try {
    window.api.reportError({
      kind,
      message: String((payload && payload.message) || payload || 'unknown').slice(0, 2000),
      stack: payload && payload.stack ? String(payload.stack).slice(0, 3000) : null,
      at: new Date().toISOString(),
    });
  } catch {
    /* never let reporting throw inside an error handler */
  }
}

window.addEventListener('error', (event) => reportError('error', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => reportError('unhandledrejection', event.reason));

// Test surface used by the smoke run.
window.__mdpad = {
  editor,
  setMarkdown,
  getMarkdown: currentMarkdown,
  iconAudit: () =>
    [...document.querySelectorAll('button[data-icon], .toolbar button, .bar-actions button')]
      .filter((b) => !b.querySelector('svg') && /[\u2190-\u21FF\u2300-\u27BF\u{1F300}-\u{1FAFF}]/u.test(b.textContent.trim()))
      .map((b) => ({ id: b.id || b.dataset.cmd || '', text: b.textContent.trim().slice(0, 12) })),
  outline: outlineItems,
  syncToolbar,
  openPalette,
  openShortcuts,
  openStats,
  stats: documentStats,
  applyI18n,
  currentLang: () => lang,
  applyTheme,
  themeState: () => ({
    theme: document.documentElement.dataset.theme,
    darkLink: !document.querySelector('#hljs-dark').disabled,
    lightLink: !document.querySelector('#hljs-light').disabled,
  }),
  tabs: () => tabsState.slice(),
  statusLog: () => statusLog.slice(),
  commandCount: () => commandList().length,
  paletteLabels: () => [...document.querySelectorAll('#palette-list .palette-row')].map((el) => el.textContent),
  paletteActive: () => !palette.hidden,
  openFolder: async (root) => {
    const res = await window.api.setTreeRoot(root);
    treeExpanded.clear();
    treeCache.clear();
    // Closing the folder must clear the root, otherwise the tree renders a null directory.
    treeRoot = res && res.root ? { root: res.root, name: res.name } : null;
    if (treeRoot) treeCache.set(treeRoot.root, res.entries || []);
    await renderTree();
  },
  applyMarkdown(markdown) {
    setMarkdown(markdown);
    scheduleChange();
  },
  aiInsert: (text) => insertAI(text, false),
  aiReplace: (text) => insertAI(text, true),
  aiInsertParagraph: (text) => insertAI(text, false, true),
  aiOpen: openAI,
  aiTurns: () => aiHistory.slice(),
  aiTargetState: () => ({
    preview: document.querySelector('#ai-target-preview').hidden
      ? ''
      : document.querySelector('#ai-target-preview').textContent,
    decorations: editor.view.dom.querySelectorAll('.ai-target-range').length,
  }),
  aiPanelOrder: () => {
    const panel = document.querySelector('#ai-popover');
    const order = [...panel.querySelectorAll('[data-order]')].map((el) => el.dataset.order);
    const positions = ['ai-titlebar', 'ai-scope', 'ai-head', 'ai-presets', 'ai-foot'].map((key) => {
      const el = panel.querySelector('.' + key) || document.querySelector('#' + key);
      return el ? { key, top: el.getBoundingClientRect().top } : { key, top: null };
    });
    return { order, positions, chip: document.querySelector('#ai-target-chip').textContent };
  },
  openDrafts: () => openDraftsPanel(),
  backupPopoverState: () => {
    const popover = document.querySelector('#backup-popover');
    const items = [...popover.querySelectorAll('.backup-item')];
    return {
      hidden: popover.hidden,
      count: document.querySelector('#backup-count').textContent,
      rows: items.length,
      firstHasParts: items[0]
        ? Boolean(items[0].querySelector('.backup-when') && items[0].querySelector('.backup-size'))
        : false,
      footerPath: document.querySelector('#paths').textContent,
      folderButton: Boolean(document.querySelector('#backup-open-folder svg')),
    };
  },
  draftsPanelState: () => ({
    nestedButtons: document.querySelectorAll('#drafts-list button button').length,
    rows: document.querySelectorAll('#drafts-list .draft-row').length,
    count: document.querySelector('#drafts-count').textContent,
    role: document.querySelector('#drafts-list .draft-row')?.getAttribute('role') || '',
    hasHint: Boolean(document.querySelector('.drafts-hint')),
  }),
  refreshDraftsBadge: () => refreshDraftsBadge(),
  mermaidAvailable: () => Boolean(window.mermaid),
  exportDiagramCount: async () => publishExportDiagrams(),
  openExportPanel,
  exportThumbState: () => {
    const image = document.querySelector('#export-thumb-img');
    return {
      hidden: image.hidden,
      src: image.getAttribute('src') ? image.getAttribute('src').slice(0, 30) : '',
      complete: image.complete,
      width: image.naturalWidth,
      bytes: image.getAttribute('src') ? image.getAttribute('src').length : 0,
    };
  },
  exportPanelState: () => ({
    open: !document.querySelector('#export-modal').hidden,
    format: exportFormat,
    activeFormat: document.querySelector('#export-format .is-active')?.dataset.format || '',
    summary: document.querySelector('#export-summary').textContent,
    font: document.querySelector('#export-font').value,
    margin: document.querySelector('#export-margin').value,
    fontDisabled: document.querySelector('#export-font').disabled,
    marginDisabled: document.querySelector('#export-margin').disabled,
  }),
  imageHandleState: () => {
    const handle = document.querySelector('#img-resize-handle');
    return { exists: Boolean(handle), hidden: handle ? handle.hidden : true };
  },
  imageWidthStyle: () => {
    const image = document.querySelector('.tiptap img');
    return image ? { style: image.getAttribute('style') || '', stickyWidth: image.style.width } : null;
  },
  imageMeta: () => {
    let title = '';
    editor.state.doc.descendants((node) => {
      if (!title && node.type.name === 'image') title = node.attrs.title || '';
      return true;
    });
    return { title };
  },
  mermaidState: () =>
    [...document.querySelectorAll('.code-block.is-mermaid')].map((block) => ({
      preview: block.classList.contains('is-preview'),
      sourceHidden: Boolean(block.querySelector('pre').hidden),
      svg: Boolean(block.querySelector('.mermaid-preview svg')),
      error: block.querySelector('.mermaid-preview').classList.contains('is-error'),
    })),
  mermaidCacheSize: () => mermaidCache.size,
  mermaidCacheEntries: () => mermaidCache.size,
  toastInfo: () => {
    const toast = document.querySelector('#toast');
    return {
      hidden: toast.hidden,
      text: toast.textContent,
      actions: [...toast.querySelectorAll('.toast-action')].map((b) => b.textContent),
    };
  },
  showExportToast: (file) =>
    showToast(t('export.done', lang, { name: String(file).split(/[\\\\/]/).pop() }), 9000, [
      { label: t('export.open', lang), run: () => window.api.openExportedFile(file) },
      { label: t('export.reveal', lang), run: () => window.api.revealExportedFile(file) },
    ]),
  mermaidPreviews: () => [...document.querySelectorAll('.mermaid-preview')].map((el) => ({
    hidden: el.hidden,
    svg: Boolean(el.querySelector('svg')),
    error: el.classList.contains('is-error'),
    text: el.textContent.slice(0, 80),
  })),
  exportNameHint: () => (document.querySelector('#set-export-name-hint') || {}).textContent || '',
  settingsDirtyVisible: () => {
    const hint = document.querySelector('#set-dirty');
    return hint ? !hint.hidden : false;
  },
  exportPreviewFromSettings: () => runExport('preview'),
  toggleFocusMode,
  openSettings,
  toggleFilesPane,
  splitWindow: () => splitWindowRequest(),
  unsplitWindow: () => unsplitWindowRequest(),
  setTheme: (theme) => setTheme(theme),
  applyPreset: (key) => {
    const preset = applyPreset(key);
    if (preset) applyAppearance(preset);
    return preset;
  },
  tableHoverVisible: () => {
    const bar = document.querySelector('#table-hover');
    return Boolean(bar && !bar.hidden);
  },
  cellAlign: () => {
    const cell = document.querySelector('.tiptap table td, .tiptap table th');
    return cell ? cell.style.textAlign || 'default' : '';
  },
  appearance: () => ({
    font: document.documentElement.dataset.font,
    width: document.documentElement.dataset.width,
    accent: document.documentElement.dataset.accent,
    editorWidth: Math.round(editor.view.dom.getBoundingClientRect().width),
    filesCollapsed: document.querySelector('#files').classList.contains('collapsed'),
  }),
  openUsagePanel,
  aiScopeInfo: () => ({
    scope: aiContextScope,
    explicit: aiScopeExplicit,
    effective: effectiveContextScope(),
  }),
  closeAI,
  focusDimFactor,
  applyTheme: (name) => applyTheme(name),
  focusModeState: () => ({
    enabled: focusModeEnabled,
    mode: editor.view.dom.classList.contains('focus-mode'),
    activeBlocks: document.querySelectorAll('.tiptap .is-active-block').length,
    dimmed: document.querySelectorAll('.tiptap.focus-mode > *:not(.is-active-block)').length,
  }),
  relativeAge: (iso) => relativeAge(iso, lang),
  saveState: () => (saveStateEl ? saveStateEl.textContent : ''),
  looksLikeMarkdown: (text) => looksLikeMarkdown(text),
  focusFirst: (typeName) => {
    let target = null;
    editor.state.doc.descendants((node, pos) => {
      if (target !== null) return false;
      if (!node.isText) return true;
      const $pos = editor.state.doc.resolve(pos);
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        if ($pos.node(depth).type.name === typeName) {
          target = pos + 1;
          return false;
        }
      }
      return true;
    });
    if (target === null) return false;
    editor.commands.setTextSelection(target);
    return true;
  },
  focusLast: (typeName) => {
    let target = null;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return true;
      const $pos = editor.state.doc.resolve(pos);
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        if ($pos.node(depth).type.name === typeName) {
          target = pos + 1;
          break;
        }
      }
      return true;
    });
    if (target === null) return false;
    editor.commands.setTextSelection(target);
    return true;
  },
  blockState: () => ({
    grip: !blockGrip.hidden,
    index: blockGripIndex,
    menu: blockMenu ? !blockMenu.hidden : false,
    items: blockMenu
      ? [...blockMenu.querySelectorAll('[data-block-action]')].map((button) => button.dataset.blockAction)
      : [],
  }),
  hoverBlock: (index) => {
    positionBlockGrip(index);
    return window.__mdpad.blockState();
  },
  blockMenuClick: (action) => {
    const button = blockMenu && blockMenu.querySelector('[data-block-action="' + action + '"]');
    if (!button) return false;
    button.click();
    return true;
  },
  moveBlockAt: (index, delta) => moveBlockAt(editor.view, index, delta),
  caretText: () => editor.state.selection.$from.parent.textContent,
  openRecentPanel: () => openRecentPanel().then(() => window.__mdpad.recentState()),
  recentState: () => ({
    open: !document.querySelector('#recent-modal').hidden,
    rows: [...document.querySelectorAll('#recent-list .recent-row')].map((row) => ({
      name: row.querySelector('.recent-name').textContent,
      missing: row.classList.contains('is-missing'),
    })),
    empty: Boolean(document.querySelector('#recent-list .drafts-empty')),
  }),
  recentRemoveAt: async (name) => {
    const row = [...document.querySelectorAll('#recent-list .recent-row')].find(
      (item) => item.querySelector('.recent-name').textContent === name
    );
    if (!row) return false;
    row.querySelector('.recent-remove').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return window.__mdpad.recentState();
  },
  clickLink: (href) => {
    const anchors = [...document.querySelectorAll('.tiptap a[href]')];
    const target = anchors.find((a) => a.getAttribute('href') === href);
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  },
  focusState: () => ({ caret: editor.state.selection.$from.parent.textContent.slice(0, 40) }),
  exportInspect: () => window.api.exportInspect(),
  exportInspectText: () => (document.querySelector('#export-inspect') || {}).textContent || '',
  a11yState: () => ({
    dialogRoles: [...document.querySelectorAll('.modal .modal-card')].map((card) => ({
      role: card.getAttribute('role'),
      modal: card.getAttribute('aria-modal'),
      labelled: Boolean(card.getAttribute('aria-labelledby')),
    })),
    toolbar: [...document.querySelectorAll('[data-cmd]')].map((button) => ({
      cmd: button.dataset.cmd,
      pressed: button.getAttribute('aria-pressed'),
      label: button.getAttribute('aria-label') || button.title || '',
    })),
    focusInside: (() => {
      const open = [...document.querySelectorAll('.modal')].filter((modal) => !modal.hidden);
      if (!open.length) return null;
      return open[open.length - 1].contains(document.activeElement);
    })(),
    activeId: document.activeElement ? document.activeElement.id || document.activeElement.tagName : '',
  }),
  a11yEditor: () => {
    const dom = editor.view.dom;
    return {
      role: dom.getAttribute('role'),
      multiline: dom.getAttribute('aria-multiline'),
      label: dom.getAttribute('aria-label'),
      tag: dom.tagName,
    };
  },
  focusHeading: (text) => {
    let target = null;
    editor.state.doc.descendants((node, pos) => {
      if (target !== null) return false;
      if (node.type.name === 'heading' && node.textContent.trim() === text) {
        target = pos + 1;
        return false;
      }
      return true;
    });
    if (target === null) return false;
    editor.commands.focus(target);
    return true;
  },
  a11yOutline: () => {
    const rows = [...document.querySelectorAll('#outline-list .outline-item')];
    const current = rows.filter((node) => node.getAttribute('aria-current') === 'location');
    const twisties = [...document.querySelectorAll('#outline-list .outline-twisty')];
    return {
      count: rows.length,
      current: current.map((node) => node.textContent),
      expanded: twisties.map((node) => node.getAttribute('aria-expanded')),
    };
  },
  benchTypingParts: () => {
    const t0 = performance.now();
    editor.commands.insertContent('a', { emitUpdate: false });
    const insertMs = performance.now() - t0;
    const n0 = performance.now();
    editor.view.dispatch(editor.state.tr);
    const noopMs = performance.now() - n0;
    const e0 = performance.now();
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'b', { emitUpdate: false });
    const insertEndMs = performance.now() - e0;
    const t1 = performance.now();
    syncToolbar();
    const toolbarMs = performance.now() - t1;
    const t2 = performance.now();
    updateStatsNow();
    const statsMs = performance.now() - t2;
    const t3 = performance.now();
    const md = editor.getMarkdown();
    const markdownMs = performance.now() - t3;
    return {
      insertMs: Math.round(insertMs * 100) / 100,
      noopMs: Math.round(noopMs * 100) / 100,
      insertEndMs: Math.round(insertEndMs * 100) / 100,
      toolbarMs: Math.round(toolbarMs * 100) / 100,
      statsMs: Math.round(statsMs * 100) / 100,
      markdownMs: Math.round(markdownMs * 100) / 100,
      markdownChars: md.length,
    };
  },
  tableMove: (direction) => moveTableColumn(direction),
  imageDragState: () => ({ pos: imageDrag.pos, target: imageDrag.target }),
  imageMove: (from, to) => moveImageTo(from, to),
  imagePositions: () => {
    const out = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') out.push({ pos, alt: node.attrs.alt || '' });
      return true;
    });
    return out;
  },
  tableDragState: () => ({ active: tableDragState.active, axis: tableDragState.axis, from: tableDragState.from, target: tableDragState.target }),
  tableMoveRow: (direction) => moveTableRow(direction),
  measureTyping: (count = 20) => {
    const times = [];
    for (let index = 0; index < count; index += 1) {
      const startedAt = performance.now();
      editor.commands.insertContent('a');
      times.push(performance.now() - startedAt);
    }
    const total = times.reduce((sum, value) => sum + value, 0);
    return {
      count,
      avg: Math.round((total / count) * 100) / 100,
      max: Math.round(Math.max(...times) * 100) / 100,
      chars: editor.getText().length,
    };
  },
  downloadRemoteImage: (src) => downloadRemoteImage(src),
  imageSrcs: () => {
    const out = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') out.push(node.attrs.src);
      return true;
    });
    return out;
  },
  settingsSearch: (query) => {
    const visible = filterSettings(query);
    return {
      visible,
      empty: !document.querySelector('#settings-empty').hidden,
      hits: document.querySelectorAll('#settings-modal .settings-hit').length,
      labels: [...document.querySelectorAll('#settings-modal .field:not([hidden]) label')].map((label) => label.textContent),
    };
  },
  settingsSearchAudit: () => settingsSearchAudit(),
  settingsActive: () => ({
    index: settingsActiveIndex,
    marked: document.querySelectorAll('#settings-modal .field.is-search-active').length,
    activeId: document.activeElement ? document.activeElement.id || document.activeElement.tagName : '',
  }),
  settingsSection: (name) => {
    const sub = document.querySelector('#settings-modal .modal-sub[data-section="' + name + '"]');
    return sub ? { collapsed: sub.classList.contains('collapsed'), hidden: sub.hidden } : null;
  },
  collapseSection: (name) => {
    const sub = document.querySelector('#settings-modal .modal-sub[data-section="' + name + '"]');
    if (!sub) return false;
    setSectionCollapsed(sub, true);
    return true;
  },
  sectionOfField: (labelText) => {
    const field = [...document.querySelectorAll('#settings-modal .field')].find(
      (candidate) => candidate.textContent.includes(labelText)
    );
    if (!field) return null;
    let node = field.previousElementSibling;
    while (node && !node.classList.contains('modal-sub')) node = node.previousElementSibling;
    return node ? node.dataset.section : null;
  },
  externalState: () => ({
    banner: !document.querySelector('#banner').hidden,
    text: document.querySelector('#banner-text').textContent,
    markdown: window.__mdpad.getMarkdown(),
  }),
  clickBannerPrimary: () => document.querySelector('#banner-primary').click(),
  writingState: () => window.api.writingStats(),
  openWritingHistory: () => openWritingHistory().then(() => window.__mdpad.writingHistoryState()),
  writingHistoryState: () => ({
    open: !document.querySelector('#writing-history').hidden,
    summary: document.querySelector('#writing-history-summary').textContent,
    days: [...document.querySelectorAll('#writing-history-bars .writing-history-day')].map((node) => ({
      reached: node.classList.contains('is-reached'),
      height: node.querySelector('.writing-history-bar').style.height,
      title: node.querySelector('.writing-history-bar').title,
    })),
  }),
  recordWritingNow: () => recordWriting(),
  refreshWriting: () => refreshWritingStatus(),
  setParagraphHighlight: (on) => {
    setParagraphHighlight(on);
    return highlightParagraphEnabled;
  },
  paragraphHighlightState: () => {
    const soft = [...document.querySelectorAll('.tiptap .is-current-block-soft')];
    const active = [...document.querySelectorAll('.tiptap .is-active-block')];
    return {
      enabled: highlightParagraphEnabled,
      softCount: soft.length,
      softText: soft.map((node) => node.textContent.slice(0, 24)),
      activeCount: active.length,
    };
  },
  typewriterState: () => ({
    enabled: typewriterEnabled,
    scrollTop: editorPane ? Math.round(editorPane.scrollTop) : 0,
    caretY: (() => {
      try {
        const coords = editor.view.coordsAtPos(editor.state.selection.from);
        return Math.round(coords.top);
      } catch {
        return null;
      }
    })(),
    paneTop: editorPane ? Math.round(editorPane.getBoundingClientRect().top) : 0,
    paneHeight: editorPane ? Math.round(editorPane.getBoundingClientRect().height) : 0,
  }),
  setTypewriter: (on) => {
    typewriterEnabled = on === true;
    editor.view.dom.classList.toggle('typewriter', typewriterEnabled);
    if (typewriterEnabled) typewriterFollow();
    return typewriterEnabled;
  },
  focusText: (text) => {
    let target = null;
    editor.state.doc.descendants((node, pos) => {
      if (target !== null) return false;
      if (node.isText && node.text.includes(text)) {
        target = pos + Math.max(0, node.text.indexOf(text));
        return false;
      }
      return true;
    });
    if (target === null) return false;
    editor.commands.focus(target);
    return true;
  },
  splitParagraph: (snippet) => splitParagraphBySnippet(snippet),
  structureSummaryFor: () => window.api.docStructure().then((report) => structureSummary(report)),
  structureMarkdown: () => window.api.docStructure().then((report) => buildStructureMarkdown(report, report.file).text),
  saveStructureReportTo: (target) =>
    window.api.docStructure().then((report) => {
      const built = buildStructureMarkdown(report, report.file);
      return window.api.writeReportTo(target, built.text, structureSummary(report));
    }),
  clickStructureFix: (line) => {
    const row = [...document.querySelectorAll('#structure-issues .image-audit-row')].find(
      (item) => Number(item.dataset.line) === Number(line)
    );
    if (!row) return false;
    const action = row.querySelector('.image-audit-fix');
    if (!action) return false;
    action.click();
    return true;
  },
  openStructureReport: () => openStructureReport().then(() => window.__mdpad.structureState()),
  structureState: () => ({
    open: !document.querySelector('#structure-report').hidden,
    summary: document.querySelector('#structure-summary').textContent,
    rows: [...document.querySelectorAll('#structure-issues .image-audit-row')].map((row) => ({
      text: row.querySelector('.image-audit-name').textContent,
      kind: row.dataset.kind,
      line: Number(row.dataset.line),
    })),
  }),
  openLinkAudit: () => openLinkAudit().then(() => window.__mdpad.linkAuditState()),
  linkAuditState: () => ({
    open: !document.querySelector('#link-audit').hidden,
    summary: document.querySelector('#link-audit-summary').textContent,
    rows: [...document.querySelectorAll('#link-audit-list .image-audit-row')].map((row) => ({
      name: row.querySelector('.image-audit-name').textContent,
      kind: row.querySelector('.image-audit-kind').textContent,
      status: row.querySelector('.image-audit-status').textContent,
      missing: row.classList.contains('is-missing'),
    })),
  }),
  removeMissingLinks: () => document.querySelector('#link-audit-remove').click(),
  clickFixLink: (href) => {
    const row = [...document.querySelectorAll('#link-audit-list .image-audit-row')].find(
      (item) => item.dataset.href === href
    );
    if (!row) return false;
    const fix = row.querySelector('.image-audit-fix');
    if (!fix) return false;
    fix.click();
    return true;
  },
  nameState: () => ({
    open: !document.querySelector('#name-modal').hidden,
    title: document.querySelector('#name-title').textContent,
    value: document.querySelector('#name-input').value,
  }),
  fillName: (value) => {
    const input = document.querySelector('#name-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  },
  confirmName: () => document.querySelector('#name-ok').click(),
  openImageAudit: () => openImageAudit().then(() => window.__mdpad.imageAuditState()),
  imageAuditState: () => ({
    open: !document.querySelector('#image-audit').hidden,
    summary: document.querySelector('#image-audit-summary').textContent,
    rows: [...document.querySelectorAll('#image-audit-list .image-audit-row')].map((row) => ({
      name: row.querySelector('.image-audit-name').textContent,
      kind: row.querySelector('.image-audit-kind').textContent,
      status: row.querySelector('.image-audit-status').textContent,
      missing: row.classList.contains('is-missing'),
    })),
  }),
  removeMissingImages: () => document.querySelector('#image-audit-remove').click(),
  loadTiming: () => lastLoadTiming,
  loadLarge: async (markdown) => {
    const startedAt = performance.now();
    await setMarkdownProgressive(markdown);
    return {
      ms: Math.round(performance.now() - startedAt),
      chars: editor.getText().length,
      headings: window.__mdpad.outlineCount ? window.__mdpad.outlineCount() : null,
    };
  },
  benchLoad: (text, kind) => {
    const startedAt = performance.now();
    editor.commands.setContent(text, { contentType: kind, emitUpdate: false });
    return Math.round(performance.now() - startedAt);
  },
  resetLoadTiming: () => { lastLoadTiming = null; },
  a11yTabs: () => {
    const tabs = [...document.querySelectorAll('#tabs .tab')];
    return {
      role: document.querySelector('#tab-list').getAttribute('role'),
      label: document.querySelector('#tab-list').getAttribute('aria-label'),
      count: tabs.length,
      selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.textContent.trim()),
      focused: tabs.indexOf(document.activeElement),
      tabindex: tabs.map((tab) => tab.tabIndex),
    };
  },
  navJump: (pos) => {
    recordJump();
    return navTo(pos);
  },
  navBack: () => navBack(),
  navForward: () => navForward(),
  navState: () => {
    const stacks = navStacks();
    return {
      back: stacks.back.length,
      forward: stacks.forward.length,
      pos: editor.state.selection.from,
      caret: editor.state.selection.$from.parent.textContent.slice(0, 40),
    };
  },
  outlineState: () => ({
    rows: [...document.querySelectorAll('#outline-list .outline-row')].length,
    items: [...document.querySelectorAll('#outline-list .outline-item')].map((a) => a.textContent),
    folded: [...document.querySelectorAll('#outline-list .outline-twisty.is-folded')].length,
    current: (document.querySelector('#outline-list .outline-item.is-current') || {}).textContent || '',
  }),
  toggleOutlineFold: (text) => {
    const rows = [...document.querySelectorAll('#outline-list .outline-row')];
    for (const row of rows) {
      const link = row.querySelector('.outline-item');
      if (link && link.textContent === text) {
        const twisty = row.querySelector('.outline-twisty:not(.is-empty)');
        if (twisty) {
          twisty.click();
          return true;
        }
      }
    }
    return false;
  },
  scrollEditor: (top) => {
    const pane = document.querySelector('.editor-pane');
    pane.scrollTop = top;
    return pane.scrollTop;
  },
  quoteDepth: () => {
    const { $from } = editor.state.selection;
    let depth = 0;
    for (let d = $from.depth; d > 0; d -= 1) {
      if ($from.node(d).type.name === 'blockquote') depth += 1;
    }
    return depth;
  },
  selectAll: () => {
    editor.commands.selectAll();
    return editor.state.selection.to;
  },
  toggleQuote: () => {
    editor.chain().focus().toggleBlockquote().run();
    return true;
  },
  docShape: () =>
    editor.state.doc.content.content.map((node) => ({
      type: node.type.name,
      level: node.attrs && node.attrs.level ? node.attrs.level : null,
      text: node.textContent.slice(0, 40),
      marks: node.firstChild && node.firstChild.marks ? node.firstChild.marks.map((mark) => mark.type.name) : [],
    })),
  clearDoc: () => {
    editor.commands.clearContent(true);
    return true;
  },
  optimizeImageForTest: async (dataUrl, name) => {
    // Decode the data URL by hand: fetching a data: URL is blocked by the page's connect-src.
    const [meta, base64] = String(dataUrl).split(',');
    const mime = (/data:([^;]+)/.exec(meta) || [null, 'image/png'])[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], name || 'test.png', { type: mime });
    const result = await optimizeImage(file);
    return {
      changed: result.changed,
      originalBytes: result.originalBytes,
      bytes: result.bytes,
      type: result.file.type,
      width: result.width || null,
      height: result.height || null,
      error: result.error || null,
      debug: result.debug || null,
    };
  },
  refreshOutlineForPerf: () => renderOutline(),
  findForPerf: (query) => {
    // Drive the real search path (input + collectMatches) so the number reflects what the find
    // bar does, not a hand-written scan.
    findInput.value = query;
    collectMatches();
    return matches.length;
  },
  nodeCountForPerf: () => editor.state.doc.nodeSize,
  advancedState: () => ({
    nav: Boolean(document.querySelector('#settings-modal [data-goto="advanced"]')),
    exportButton: Boolean(document.querySelector('#set-export-settings')),
    importButton: Boolean(document.querySelector('#set-import-settings')),
    resetButton: Boolean(document.querySelector('#set-reset')),
    clearButton: Boolean(document.querySelector('#set-clear-drafts')),
  }),
  saveNow: () => saveDocument(),
  conflictState: () => {
    const modal = document.querySelector('#tree-confirm');
    return { open: !modal.hidden, title: document.querySelector('#tree-confirm-title').textContent };
  },
  welcomeState: () => ({
    hidden: document.querySelector('#empty-hint').hidden,
    steps: [...document.querySelectorAll('#empty-hint .empty-step')].map((button) => button.id),
    dismissed: guideDismissed,
  }),
  showWelcomeGuide: () => showWelcomeGuide(),
  diagnostics: () => window.api.diagnostics(),
  closeTopModal,
  themeState2: () => ({
    stored: readThemeSetting,
    applied: document.documentElement.dataset.theme,
    systemDark: systemThemeDark,
  }),
  slashState: () => {
    const menu = document.querySelector('#slash-menu');
    return {
      hidden: menu.hidden,
      items: [...menu.querySelectorAll('.slash-item')].map((row) => row.dataset.id),
      active: document.querySelector('#slash-menu .slash-item.is-active')?.dataset.id || '',
    };
  },
  slashChoose: (id) => {
    const command = slashCommands.find((entry) => entry.id === id);
    if (!command) return false;
    applySlashCommand(command);
    return true;
  },
  tabMenuState: () => {
    const menu = document.querySelector('#tab-menu');
    return {
      hidden: menu.hidden,
      items: [...menu.querySelectorAll('[data-tab-action]')].filter((b) => !b.hidden).map((b) => b.dataset.tabAction),
    };
  },
  openTabContextMenu: (clientX = 300, clientY = 60) => {
    const tab = document.querySelector('.tab.active');
    if (!tab) return false;
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
    return true;
  },
  tabMenuClick: (action) => {
    const button = document.querySelector('#tab-menu [data-tab-action="' + action + '"]');
    if (!button) return false;
    button.click();
    return true;
  },
  cycleTab,
  scrollTo: (top) => {
    editorPane.scrollTop = top;
  },
  scrollTop: () => (editorPane ? Math.round(editorPane.scrollTop) : -1),
  zoom: (direction) => zoomAction(direction),
  zoomIndicator: () => {
    const el = document.querySelector('#zoom-indicator');
    return { hidden: el.hidden, text: el.textContent };
  },
  selectText: (from, to) => editor.chain().focus().setTextSelection({ from, to }).run(),
  sectionState: () => sectionState(),
  refreshAiSetup: () => refreshAiSetup(),
  themeContrast: () => themeContrastReport(),
  findState: () => ({ count: matches.length, index: matchIndex, error: findError, options: { ...findOptions } }),
  setFindOptions: (patch) => {
    setFindOptions(patch);
    return { ...findOptions };
  },
  runFind: (query) => {
    findInput.value = query;
    collectMatches();
    matchIndex = matches.length ? 0 : -1;
    return { count: matches.length, error: findError, text: window.__mdpad.getMarkdown() };
  },
  replaceAllNow: (replacement) => {
    replaceInput.value = replacement;
    replaceAll();
    return window.__mdpad.getMarkdown();
  },
  findStats: () => ({ count: matches.length, truncated: findTruncated, ms: lastFindMs }),
  resetScopePreference: () => {
    aiScopeExplicit = false;
    aiScopeAuto = false;
  },
  outlineMs: () => lastOutlineMs,
  outlineDebug: () => {
    const items = outlineItems();
    const caret = editor.state.selection.from;
    let index = -1;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].pos <= caret) index = i;
      else break;
    }
    return {
      caret,
      index,
      items: items.map((i) => ({ text: i.text, pos: i.pos })),
      classes: [...outlineList.querySelectorAll('.outline-item')].map((n) => n.className),
    };
  },
  tableDebug: () => ({
    handles: document.querySelectorAll('.column-resize-handle').length,
    wrappers: document.querySelectorAll('.tableWrapper').length,
    classes: editor.view.dom.className,
    html: editor.view.dom.innerHTML.slice(0, 400),
  }),
  rowHandleState: () => {
    const handle = document.querySelector('#row-handle');
    return {
      exists: Boolean(handle),
      hidden: handle ? handle.hidden : true,
      row: handle ? Number(handle.dataset.row) : -1,
      dropTargets: document.querySelectorAll('.row-drop-target').length,
    };
  },
  moveRowTo,
  tableMenuState: () => {
    const menu = document.querySelector('#table-menu');
    return { hidden: menu.hidden, items: menu.querySelectorAll('[data-tm]').length };
  },
  tableRowCount: () => {
    let rows = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableRow') rows += 1;
      return true;
    });
    return rows;
  },
  tableFirstColumn: () => {
    const rows = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableRow') {
        const first = node.firstChild;
        rows.push(first ? first.textContent.trim() : '');
        return false;
      }
      return true;
    });
    return rows;
  },
  tableColumnWidths: () => {
    const widths = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        (node.attrs.colwidth || []).forEach((w) => widths.push(w));
        return false;
      }
      return true;
    });
    return widths;
  },
  moveTableRow,
  outlineCurrent: () => {
    const current = document.querySelector('#outline-list .outline-item.is-current');
    return current ? current.textContent : '';
  },
  treeMenuState: () => {
    const menu = document.querySelector('#tree-menu');
    return {
      hidden: menu.hidden,
      items: [...menu.querySelectorAll('[data-tree-action]')]
        .filter((b) => !b.hidden)
        .map((b) => b.dataset.treeAction),
    };
  },
  openTreeContextMenu: (index = 0, clientX = 200, clientY = 200) => {
    if (index < 0) {
      if (!treeRoot) return false;
      openTreeMenu(clientX, clientY, { path: treeRoot.root, name: treeRoot.name, dir: true });
      return true;
    }
    const row = document.querySelectorAll('#tree .tree-row')[index];
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    }));
    return true;
  },
  treeMenuClick: (action) => {
    const button = document.querySelector('#tree-menu [data-tree-action="' + action + '"]');
    if (!button) return false;
    button.click();
    return true;
  },
  namePromptState: () => ({
    open: !document.querySelector('#name-modal').hidden,
    title: document.querySelector('#name-title').textContent,
    value: document.querySelector('#name-input').value,
  }),
  namePromptFill: (value) => {
    const input = document.querySelector('#name-input');
    input.value = value;
    document.querySelector('#name-ok').click();
  },
  confirmState: () => ({
    open: !document.querySelector('#tree-confirm').hidden,
    title: document.querySelector('#tree-confirm-title').textContent,
    text: document.querySelector('#tree-confirm-text').textContent,
  }),
  confirmClick: () => document.querySelector('#tree-confirm-ok').click(),
  treeMeta: () => [...document.querySelectorAll('#tree .tree-meta')].map((el) => el.textContent),
};

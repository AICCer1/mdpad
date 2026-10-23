'use strict';

// WYSIWYG renderer: Tiptap (ProseMirror) holds the document; markdown is the
// serialization sent to the main process, so saving/backup/draft are unchanged.

import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
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

const editor = new Editor({
  element: host,
  extensions: [
    FocusDecoration,
    StarterKit.configure({ codeBlock: false, link: false, heading: { levels: [1, 2, 3, 4, 5, 6] } }),
    // Pasting a URL over a selection should link that selection instead of replacing it.
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
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
  }).configure({ resizable: false }),
    TableRow,
    TableHeader,
    AlignedTableCell,
    AlignedTableHeader,
    TaskList,
    TaskItem.configure({ nested: true }),
    Mathematics,
  ],
  content: '',
  autofocus: false,
  editorProps: {
    attributes: { class: 'mdpad-prose', spellcheck: 'false' },
    handleKeyDown(view, event) {
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'Tab' && !event.shiftKey) {
        const { $from } = view.state.selection;
        if ($from.parent.type.name === 'codeBlock') {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText('  ', view.state.selection.from));
          return true;
        }
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
  onUpdate: () => { scheduleChange(); syncToolbar(); },
  onSelectionUpdate: () => { updateStats(); syncToolbar(); },
});

// ---- block move ------------------------------------------------------------

function moveBlock(view, delta) {
  const { state } = view;
  const doc = state.doc;
  const index = state.selection.$from.index(0);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= doc.childCount) return;

  const children = [];
  doc.forEach((node) => children.push(node));
  const moved = children[index];
  children.splice(index, 1);
  children.splice(target, 0, moved);

  const next = doc.type.create(doc.attrs, children, doc.marks);
  let pos = 0;
  for (let i = 0; i < target; i += 1) pos += children[i].nodeSize;
  const tr = state.tr.replaceWith(0, doc.content.size, next.content);
  tr.setSelection(view.state.selection.constructor.near(next.resolve(pos + 1)));
  view.dispatch(tr);
  view.focus();
}

// ---- state plumbing --------------------------------------------------------

let changeTimer = null;
let applying = false;

function setDirty(dirty) {
  dirtyDot.hidden = !dirty;
}

function flash(message) {
  status.textContent = message;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { status.textContent = ''; }, 2500);
}

function updateStats() {
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

function currentMarkdown() {
  try {
    return editor.getMarkdown();
  } catch {
    return editor.getHTML();
  }
}

function scheduleChange() {
  if (applying) return;
  updateStats();
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    window.api.syncChange(currentMarkdown()).then((res) => setDirty(res.dirty));
  }, 300);
}

function setMarkdown(markdown) {
  applying = true;
  editor.commands.setContent(markdown || '', { contentType: 'markdown' });
  promoteInlineImages();
  applying = false;
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
    if (button) button.classList.toggle('active', active);
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

async function insertImageFile(file) {
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  const saved = await window.api.saveImage({ dataUrl, ext: file.type.split('/')[1] });
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
function markCurrentOutline() {
  const items = outlineItems();
  if (!items.length) return;
  const caret = editor.state.selection.from;
  let index = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].pos <= caret) index = i;
    else break;
  }
  const nodes = [...outlineList.querySelectorAll('.outline-item')];
  nodes.forEach((node, i) => node.classList.toggle('is-current', i === index));
  const current = nodes[index];
  if (current && typeof current.scrollIntoView === 'function') {
    const box = outlineList.getBoundingClientRect();
    const rect = current.getBoundingClientRect();
    if (rect.top < box.top || rect.bottom > box.bottom) {
      current.scrollIntoView({ block: 'nearest' });
    }
  }
}

function renderOutline() {
  const startedAt = performance.now();
  const items = outlineItems();
  outlineList.textContent = '';
  for (const item of items) {
    const link = document.createElement('a');
    link.className = `outline-item depth-${item.depth}`;
    link.textContent = item.text;
    link.addEventListener('click', () => {
      editor.commands.focus(item.pos);
      const dom = editor.view.nodeDOM(item.pos);
      if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    outlineList.appendChild(link);
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

function handleLinkClick(event) {
  const anchor = event.target.closest ? event.target.closest('a[href]') : null;
  if (!anchor) return false;
  // Never let the click navigate the app window; a plain click should just place the caret.
  event.preventDefault();
  if (!shouldOpenExternal(event)) return true;
  window.api.openExternal(anchor.getAttribute('href')).catch(() => {});
  return true;
}

editor.view.dom.addEventListener('click', handleLinkClick);
editor.view.dom.addEventListener('auxclick', handleLinkClick);
editor.view.dom.addEventListener('click', openMathAtClick);

editor.on('update', renderOutline);
editor.on('selectionUpdate', () => {
  if (!aiPopover.hidden) updateContextNote();
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


// ---- find & replace --------------------------------------------------------

const MAX_FIND_MATCHES = 2000;
let matches = [];
let matchIndex = -1;
let findTruncated = false;
let lastFindMs = 0;

function collectMatches() {
  const started = performance.now();
  const needle = findInput.value.toLowerCase();
  matches = [];
  findTruncated = false;
  if (!needle) return;
  editor.state.doc.descendants((node, pos) => {
    if (matches.length >= MAX_FIND_MATCHES) return false;
    if (!node.isText) return true;
    const text = node.text.toLowerCase();
    let at = text.indexOf(needle);
    while (at !== -1) {
      matches.push({ from: pos + at, to: pos + at + needle.length });
      if (matches.length >= MAX_FIND_MATCHES) {
        findTruncated = true;
        break;
      }
      at = text.indexOf(needle, at + needle.length);
    }
    return matches.length < MAX_FIND_MATCHES;
  });
  lastFindMs = performance.now() - started;
}

function focusMatch() {
  findCount.textContent = findInput.value
    ? `${matches.length ? matchIndex + 1 : 0}/${matches.length}${findTruncated ? '+' : ''}`
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
  matchIndex = (matchIndex + dir + matches.length) % matches.length;
  focusMatch();
}

function replaceOne() {
  if (matchIndex < 0 || !matches.length) return;
  const { from, to } = matches[matchIndex];
  editor.chain().focus().insertContentAt({ from, to }, replaceInput.value).run();
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
  const chain = editor.chain().focus();
  for (const m of [...matches].reverse()) {
    chain.insertContentAt({ from: m.from, to: m.to }, replaceInput.value);
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

let findTimer = null;
findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => {
    collectMatches();
    matchIndex = matches.length ? 0 : -1;
    focusMatch();
  }, 120);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('#find-next').addEventListener('click', () => stepFind(1));
$('#find-prev').addEventListener('click', () => stepFind(-1));
$('#replace-one').addEventListener('click', replaceOne);
$('#replace-all').addEventListener('click', replaceAll);
$('#find-close').addEventListener('click', closeFind);

// ---- AI writing ------------------------------------------------------------

let aiSelection = null;
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

function openAI() {
  const { from, to, empty } = editor.state.selection;
  aiSelection = empty ? null : { from, to, text: editor.state.doc.textBetween(from, to, ' ') };
  updateContextNote();
  renderHistoryChips();
  aiPopover.hidden = false;
  refreshAiSetup();
  syncEmptyHint();
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

function filterSettings(query) {
  const q = String(query || '').trim().toLowerCase();
  // First hide fields that do not match their own text…
  for (const field of document.querySelectorAll('#settings-modal .field')) {
    field.hidden = Boolean(q) && !field.textContent.toLowerCase().includes(q);
  }
  // …then let a section heading ("Usage", "Export") reveal its whole section, because a user
  // searching for a group name means the group, not the fields whose text happens to match.
  for (const sub of document.querySelectorAll('#settings-modal .modal-sub')) {
    const headingMatches = Boolean(q) && sub.textContent.toLowerCase().includes(q);
    if (headingMatches) {
      setSectionCollapsed(sub, false);
      let node = sub.nextElementSibling;
      while (node && !node.classList.contains('modal-sub')) {
        if (node.classList.contains('field')) node.hidden = false;
        node = node.nextElementSibling;
      }
    }
    let anyVisible = false;
    let node = sub.nextElementSibling;
    while (node && !node.classList.contains('modal-sub')) {
      if (node.classList.contains('field') && !node.hidden) anyVisible = true;
      node = node.nextElementSibling;
    }
    sub.hidden = Boolean(q) && !anyVisible && !headingMatches;
  }
}

for (const button of document.querySelectorAll('.style-preset')) {
  button.addEventListener('click', () => {
    const preset = STYLE_PRESETS[button.dataset.style];
    if (preset) $('#set-ai-system').value = preset;
  });
}

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
function relativeAge(iso, language) {
  const stamp = Date.parse(iso);
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
  for (const draft of drafts) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'draft-row';
    const time = draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : '—';
    const label = document.createElement('span');
    label.className = 'draft-name';
    label.textContent = draft.name;
    const meta = document.createElement('span');
    meta.className = 'draft-meta';
    const age = draft.updatedAt ? relativeAge(draft.updatedAt, lang) : '';
    meta.textContent = [t('drafts.item', lang, { time, size: draft.bytes }), age].filter(Boolean).join(' · ');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'draft-delete';
    remove.textContent = '×';
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

$('#set-filter').addEventListener('input', (event) => filterSettings(event.target.value));
$('#ai-scope').addEventListener('change', (event) => {
  aiContextScope = event.target.value;
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

function renderTabs(list) {
  tabsState = Array.isArray(list) ? list : [];
  for (const key of [...editorStateCache.keys()]) {
    if (!tabsState.some((tab) => tab.id === key)) editorStateCache.delete(key);
  }
  tabList.textContent = '';
  for (const tab of list) {
    const el = document.createElement('div');
    el.className = `tab${tab.active ? ' active' : ''}`;
    el.dataset.id = tab.id;
    el.draggable = true;
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
    close.addEventListener('click', async (event) => {
      event.stopPropagation();
      await flushChange();
      await window.api.closeTab(tab.id);
    });
    el.appendChild(close);

    el.addEventListener('click', async () => {
      if (tab.active) return;
      await flushChange();
      await window.api.activateTab(tab.id);
    });

    tabList.appendChild(el);
  }
  updateTabScroll();
  const active = tabList.querySelector('.tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

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
    { id: 'save', hint: 'Ctrl+S', label: p('palette.save'), run: () => window.api.save() },
    { id: 'saveAs', hint: 'Ctrl+Shift+S', label: p('palette.saveAs'), run: () => window.api.saveAs() },
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
function applyTheme(theme) {
  // Transitions would make every colour interpolate during a theme swap: it flashes, and any
  // measurement taken right after the switch sees the old palette. Disable them for one frame.
  const root = document.documentElement;
  root.classList.add('theme-swap');
  root.dataset.theme = theme;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-swap')));
  refreshMermaidPreviews();
  const light = document.querySelector('#hljs-light');
  const dark = document.querySelector('#hljs-dark');
  if (light && dark) {
    light.disabled = theme === 'dark';
    dark.disabled = theme !== 'dark';
  }
  const select = $('#theme');
  if (select) select.value = theme;
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

function syncEmptyHint() {
  emptyHint.hidden =
    guideDismissed || !editor.isEmpty || !aiPopover.hidden || !palette.hidden;
}

$('#empty-dismiss').addEventListener('click', () => {
  guideDismissed = true;
  syncEmptyHint();
  window.api.setSettings({ guideDismissed: true }).catch(() => {});
});

$('#empty-new').addEventListener('click', () => window.api.newDoc());
$('#empty-folder').addEventListener('click', () => actions.openFolder());
$('#empty-ai').addEventListener('click', () => openAI());

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

document.querySelectorAll('#export-format [data-format]').forEach((button) => {
  button.addEventListener('click', () => setExportFormat(button.dataset.format));
});
document.querySelector('#export-template').addEventListener('change', refreshExportSummary);
document.querySelector('#export-font').addEventListener('change', refreshExportSummary);
document.querySelector('#export-margin').addEventListener('change', refreshExportSummary);
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
  await runExport(exportFormat);
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
  save: () => window.api.save(),
  saveAs: () => window.api.saveAs(),
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

window.api.onLoadDraft(({ contents }) => {
  setMarkdown(contents);
  scheduleChange();
});

// Per-tab editor state keeps the undo history alive across tab switches. The cached
// markdown is compared with what main sends: if the file changed on disk (or another
// window saved it), the cache is stale and we fall back to reloading the content.
const editorStateCache = new Map();
let activeTabId = null;

function cacheActiveEditorState() {
  if (!activeTabId) return;
  try {
    editorStateCache.set(activeTabId, { state: editor.view.state, markdown: currentMarkdown() });
  } catch {
    /* a broken state is not worth caching */
  }
}

window.api.onLoaded(({ id, file, contents, draft }) => {
  const nextId = id || null;
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
    setMarkdown(contents);
  }
  activeTabId = nextId;
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
    button.textContent = t('backup.item', lang, {
      time: new Date(entry.mtime).toLocaleString(),
      size: Math.max(1, Math.round(entry.size / 1024)),
    });
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
  if (payload.saveFailed) {
    showBanner(
      payload.readOnly
        ? 'This file cannot be written. Your text is kept; editing continues without autosave.'
        : `Save failed — ${payload.error || 'unknown error'}. Your text is still here.`,
      'Retry',
      () => window.api.save(),
      'Dismiss',
      () => {}
    );
  } else if (payload.error) {
    flash(payload.error);
  }
  if (payload.backupsDir) paths.textContent = `backups: ${payload.backupsDir}`;
  if (typeof payload.dirty === 'boolean') setDirty(payload.dirty);
});

window.api.onPreview(() => {});
window.api.onOutline(() => {});

(async () => {
  const settings = await window.api.getSettings();
  const theme = settings.theme || 'light';
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
  openDrafts: () => openDraftsPanel(),
  refreshDraftsBadge: () => refreshDraftsBadge(),
  mermaidAvailable: () => Boolean(window.mermaid),
  exportDiagramCount: async () => publishExportDiagrams(),
  openExportPanel,
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
  selectText: (from, to) => editor.chain().focus().setTextSelection({ from, to }).run(),
  sectionState: () => sectionState(),
  refreshAiSetup: () => refreshAiSetup(),
  themeContrast: () => themeContrastReport(),
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
  outlineCurrent: () => {
    const current = document.querySelector('#outline-list .outline-item.is-current');
    return current ? current.textContent : '';
  },
  treeMeta: () => [...document.querySelectorAll('#tree .tree-meta')].map((el) => el.textContent),
};

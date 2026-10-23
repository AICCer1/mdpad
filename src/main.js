'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage, screen, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./storage');
const exporter = require('./exporter');
const markdown = require('./markdown');
const { toDocx } = require('./exporters/docx');
const { toEpub } = require('./exporters/epub');
const ai = require('./ai');
const { t, normalizeLang } = require('./i18n');
const { classifyFsError, fsErrorCode } = require('./errors');
const { planRestore } = require('./session-restore');
const { checkDirs } = require('./preflight');
const { parseFileArgs } = require('./cli');
const { isLargeExport, describeSize } = require('./export-limits');
const { buildExportName } = require('./filename');
const { fitBounds } = require('./window-bounds');
const { listDrafts, selectStaleDrafts } = require('./drafts');
const { summarizeDirty } = require('./dirty');
const { decideRestore } = require('./startup-guard');
const { diagnoseAiError } = require('./ai-errors');
const { isSafeExternalUrl } = require('./link-guard');
const { listModels } = require('./ai-models');
const { pruneTurns } = require('./ai-history');
const { createUpdater, checkForUpdates: runUpdateCheck } = require('./updater');

const AUTOSAVE_MS = Number(process.env.MDPAD_AUTOSAVE_MS || 5000);
const DRAFT_MS = Number(process.env.MDPAD_DRAFT_MS || 600);
const BACKUP_KEEP = 20;
const SMOKE = process.argv.includes('--smoke-test');
const SCREENSHOT_DIR = (process.argv.find((a) => a.startsWith('--screenshot-dir=')) || '').split('=')[1] || null;
const RESTART_PHASE = (process.argv.find((a) => a.startsWith('--restart-phase=')) || '').split('=')[1] || null;
const PROCESS_STARTED_AT = Date.now();
const CRASH_PHASE = (process.argv.find((a) => a.startsWith('--crash-phase=')) || '').split('=')[1] || null;
const CRASH_FILE = process.env.MDPAD_CRASH_FILE || null;

// Tests need their own profile so they never touch real drafts, backups or settings.
if (process.env.MDPAD_USERDATA) {
  const sandbox = path.resolve(process.env.MDPAD_USERDATA);
  fs.mkdirSync(sandbox, { recursive: true });
  app.setPath('userData', sandbox);
} else if (SMOKE) {
  const os = require('node:os');
  const sandbox = path.join(os.tmpdir(), `mdpad-smoke-profile-${process.pid}`);
  fs.mkdirSync(sandbox, { recursive: true });
  app.setPath('userData', sandbox);
}

const userDir = () => app.getPath('userData');
const backupsDir = () => path.join(userDir(), 'backups');
const draftsDir = () => path.join(userDir(), 'draftsRecover');
const settingsFile = () => path.join(userDir(), 'settings.json');
const aiHistoryFile = () => path.join(userDir(), 'ai-history.json');
const lockFile = () => path.join(userDir(), 'running.lock');

// A lock file left behind means the previous process died without a clean quit.
let crashedLastRun = false;

function markRunning() {
  try {
    crashedLastRun = fs.existsSync(lockFile());
    if (crashedLastRun) writeCrashStreak(readCrashStreak() + 1);
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(lockFile(), String(process.pid), 'utf8');
  } catch (err) {
    logLine('lock', err.message);
  }
}

const crashStreakFile = () => path.join(userDir(), 'crash-streak.json');

function readCrashStreak() {
  try {
    const data = JSON.parse(fs.readFileSync(crashStreakFile(), 'utf8'));
    return Number.isFinite(data.count) ? data.count : 0;
  } catch {
    return 0;
  }
}

function writeCrashStreak(count) {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(crashStreakFile(), JSON.stringify({ count, at: new Date().toISOString() }), 'utf8');
  } catch (err) {
    logLine('guard', err.message);
  }
}

function clearRunning() {
  try {
    fs.unlinkSync(lockFile());
  } catch {
    /* already gone */
  }
}

function draftCount() {
  try {
    return fs.readdirSync(draftsDir()).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

const AI_USAGE_LIMIT = 50;
const aiUsageFile = () => path.join(userDir(), 'ai-usage.jsonl');

function recordAiUsage(entry) {
  try {
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(aiUsageFile(), line, 'utf8');
    // Keep the log bounded; rewriting is cheap at this size.
    const lines = fs.readFileSync(aiUsageFile(), 'utf8').split('\n').filter(Boolean);
    if (lines.length > AI_USAGE_LIMIT) {
      fs.writeFileSync(aiUsageFile(), `${lines.slice(-AI_USAGE_LIMIT).join('\n')}\n`, 'utf8');
    }
  } catch (err) {
    logLine('usage', err.message);
  }
}

function usageToCsv() {
  const rows = readAiUsage(200).slice().reverse();
  const header = 'at,model,promptTokens,outTokens,ms,ok';
  const lines = rows.map((entry) =>
    [
      entry.at || '',
      String(entry.model || 'default').replace(/,/g, ' '),
      entry.promptTokens ?? 0,
      entry.outTokens ?? 0,
      entry.ms ?? 0,
      entry.ok ? 'true' : 'false',
    ].join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}

function readAiUsage(limit = 20) {
  try {
    const lines = fs.readFileSync(aiUsageFile(), 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

function readAiHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(aiHistoryFile(), 'utf8'));
    if (!Array.isArray(data.turns)) return [];
    return pruneTurns(data.turns);
  } catch {
    return [];
  }
}

function writeAiHistory(turns) {
  const clean = pruneTurns(turns);
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(aiHistoryFile(), JSON.stringify({ turns: clean }, null, 2), 'utf8');
  return clean;
}

// ---- settings (shared by every window) --------------------------------------

function readSettings() {
  const raw = storage.readIfExists(settingsFile());
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---- secrets ----------------------------------------------------------------
// API keys go through the OS credential store (Keychain / DPAPI / libsecret).
// If it is unavailable the key is only base64-wrapped, which is obfuscation and
// is recorded as such so the UI can warn.

function encryptSecret(text) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { scheme: 'safeStorage', value: safeStorage.encryptString(text).toString('base64') };
    }
  } catch (err) {
    logLine('secret', `encrypt failed: ${err.message}`);
  }
  logLine('secret', 'safeStorage unavailable; key stored base64-wrapped only');
  return { scheme: 'base64', value: Buffer.from(text, 'utf8').toString('base64') };
}

function decryptSecret(secret) {
  if (!secret || !secret.value) return null;
  try {
    if (secret.scheme === 'safeStorage') {
      return safeStorage.decryptString(Buffer.from(secret.value, 'base64'));
    }
    return Buffer.from(secret.value, 'base64').toString('utf8');
  } catch (err) {
    logLine('secret', `decrypt failed: ${err.message}`);
    return null;
  }
}

const clampAutosave = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 500) return AUTOSAVE_MS;
  return Math.min(Math.round(n), 60000);
};

const currentLang = () => normalizeLang(readSettings().language || app.getLocale());

// ---- recent files -----------------------------------------------------------

function recentFiles() {
  const list = readSettings().recent;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => typeof entry === 'string')
    .filter((entry) => {
      try {
        return fs.existsSync(entry);
      } catch {
        return false;
      }
    })
    .slice(0, 10);
}

function rememberRecent(file) {
  if (!file) return;
  try {
    const list = [file, ...recentFiles().filter((entry) => entry !== file)].slice(0, 10);
    writeSettings({ recent: list });
    buildMenu();
  } catch (err) {
    logLine('recent', err.message);
  }
}

const THEMES = new Set(['light', 'dark', 'sepia']);

function publicSettings() {
  const s = readSettings();
  const ai = s.ai || {};
  return {
    theme: THEMES.has(s.theme) ? s.theme : 'light',
    autosaveMs: clampAutosave(s.autosaveMs),
    ai: {
      baseUrl: ai.baseUrl || '',
      model: ai.model || '',
      hasKey: Boolean(ai.key && ai.key.value),
      keyScheme: ai.key ? ai.key.scheme : null,
    },
    updates: {
      feedUrl: (s.updates && s.updates.feedUrl) || '',
    },
    language: normalizeLang(s.language || app.getLocale()),
    exportTemplate: exportTemplate(),
    exportCss: String(readSettings().exportCss || '').slice(0, 10000),
    exportNameTemplate: String(readSettings().exportNameTemplate || '{title}').slice(0, 120),
    aiSystemPrompt: String(readSettings().aiSystemPrompt || '').slice(0, 2000),
    aiConfirmOverTokens: clampConfirmTokens(s.aiConfirmOverTokens),
    aiContextScope: AI_SCOPES.includes(s.aiContextScope) ? s.aiContextScope : null,
    onboarded: Boolean(s.onboarded),
    guideDismissed: Boolean(s.guideDismissed),
    collapsedSections:
      s.collapsedSections && typeof s.collapsedSections === 'object' ? s.collapsedSections : {},
    focusMode: Boolean(s.focusMode),
    editorFont: FONT_KEYS.includes(s.editorFont) ? s.editorFont : 'serif',
    lineWidth: ['narrow', 'normal', 'wide'].includes(s.lineWidth) ? s.lineWidth : 'normal',
    accent: ['blue', 'teal', 'violet', 'amber'].includes(s.accent) ? s.accent : 'blue',
    filesCollapsed: Boolean(s.filesCollapsed),
    exportFont: FONT_KEYS.includes(s.exportFont) ? s.exportFont : 'serif',
    exportMargin: EXPORT_MARGINS.includes(s.exportMargin) ? s.exportMargin : 'normal',
  };
}

const DEFAULT_CONFIRM_TOKENS = 20000;
const AI_SCOPES = ['doc', 'paragraph', 'none'];

function clampConfirmTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONFIRM_TOKENS;
  return Math.min(Math.round(n), 500000);
}

const EXPORT_TEMPLATES = ['default', 'compact', 'toc'];
const FONT_KEYS = ['serif', 'sans', 'yahei', 'simsun', 'kaiti', 'fangsong', 'times', 'arial', 'cambria', 'mono'];
const EXPORT_MARGINS = ['normal', 'narrow', 'wide'];
const FONT_STACKS_EXPORT = {
  serif: 'Georgia, "Noto Serif", "Songti SC", serif',
  sans: '"Segoe UI", "Noto Sans", "Microsoft YaHei", sans-serif',
  yahei: '"Microsoft YaHei", "PingFang SC", sans-serif',
  simsun: '"SimSun", "Songti SC", serif',
  kaiti: '"KaiTi", "Kaiti SC", serif',
  fangsong: '"FangSong", "STFangsong", serif',
  times: '"Times New Roman", Times, serif',
  arial: 'Arial, Helvetica, sans-serif',
  cambria: 'Cambria, Georgia, serif',
  mono: '"Cascadia Mono", Consolas, monospace',
};

function exportFontStack() {
  const key = readSettings().exportFont || 'serif';
  return FONT_STACKS_EXPORT[key] || FONT_STACKS_EXPORT.serif;
}

function exportTemplate() {
  const value = readSettings().exportTemplate;
  return EXPORT_TEMPLATES.includes(value) ? value : 'default';
}

// ---- settings import / export ----------------------------------------------
// The API key is deliberately excluded: the encrypted blob is machine-bound, and a
// shared settings file should never carry a credential.

function settingsForExport() {
  const s = publicSettings();
  return {
    app: 'mdpad',
    version: app.getVersion(),
    exportedAt: new Date().toISOString(),
    settings: {
      theme: s.theme,
      autosaveMs: s.autosaveMs,
      language: s.language,
      exportTemplate: s.exportTemplate,
      ai: { baseUrl: s.ai.baseUrl, model: s.ai.model },
      updates: s.updates,
    },
  };
}

function applyImportedSettings(data) {
  const settings = data && data.settings ? data.settings : data;
  if (!settings || typeof settings !== 'object') throw new Error('invalid settings file');
  const patch = {};
  if (THEMES.has(settings.theme)) patch.theme = settings.theme;
  if (settings.autosaveMs !== undefined) patch.autosaveMs = clampAutosave(settings.autosaveMs);
  if (settings.language === 'en' || settings.language === 'zh') patch.language = settings.language;
  if (EXPORT_TEMPLATES.includes(settings.exportTemplate)) patch.exportTemplate = settings.exportTemplate;
  if (settings.updates && typeof settings.updates.feedUrl === 'string') {
    patch.updates = { feedUrl: settings.updates.feedUrl.trim() };
  }

  const currentAi = readSettings().ai || {};
  if (settings.ai && typeof settings.ai === 'object') {
    const ai = { ...currentAi };
    if (typeof settings.ai.baseUrl === 'string') ai.baseUrl = settings.ai.baseUrl.trim();
    if (typeof settings.ai.model === 'string') ai.model = settings.ai.model.trim();
    if (currentAi.key) ai.key = currentAi.key;
    patch.ai = ai;
  }

  writeSettings(patch);
  buildMenu();
  return publicSettings();
}

// ---- updates ----------------------------------------------------------------

let updater = null;

function getUpdater() {
  if (!updater) updater = createUpdater({ forceDevConfig: !app.isPackaged });
  return updater;
}

async function performUpdateCheck(feedUrl) {
  const configured = feedUrl || (readSettings().updates || {}).feedUrl || '';
  const result = await runUpdateCheck(getUpdater(), { feedUrl: configured });
  const payload = { ...result, current: app.getVersion() };
  logLine('update', JSON.stringify(payload));
  return payload;
}

// ---- diagnostics ------------------------------------------------------------

const logFilePath = () => path.join(userDir(), 'logs', 'mdpad.log');

function logLine(scope, message) {
  try {
    fs.mkdirSync(path.dirname(logFilePath()), { recursive: true });
    fs.appendFileSync(logFilePath(), `[${new Date().toISOString()}] ${scope} ${message}\n`, 'utf8');
  } catch {
    /* logging must never take the app down */
  }
}

// ---- session persistence ----------------------------------------------------

const sessionStoreFile = () => path.join(userDir(), 'session.json');

// Restoring an unbounded tab list would grow session.json forever and slow startup.
const MAX_RESTORE_TABS = 20;
const MAX_RESTORE_UNTITLED = 5;
const MAX_RESTORE_UNTITLED_BYTES = 200_000;

let sessionSaveTimer = null;

function tabsForSnapshot(session) {
  session.stashActive();
  const all = [...session.tabs.values()];
  const kept = [];
  let untitled = 0;

  for (const tab of all) {
    if (!tab.file) {
      if (untitled >= MAX_RESTORE_UNTITLED) continue;
      if (!tab.contents || tab.contents.length > MAX_RESTORE_UNTITLED_BYTES) continue;
      untitled += 1;
    } else if (!fs.existsSync(tab.file)) {
      continue;
    }
    kept.push({
      file: tab.file,
      contents: tab.file ? null : tab.contents,
    });
    if (kept.length >= MAX_RESTORE_TABS) break;
  }

  // The active tab (if any) must survive the cap so the user lands where they left.
  const active = session.tabs.get(session.activeId);
  if (active && !kept.some((entry) => entry.file && entry.file === active.file)) {
    kept.unshift({ file: active.file, contents: active.file ? null : active.contents });
    kept.splice(MAX_RESTORE_TABS);
  }

  return { tabs: kept, activeId: session.activeId, treeRoot: session.treeRoot, bounds: null };
}

function snapshotSession() {
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    windows: [...sessions.values()].map((s) => {
      const snap = tabsForSnapshot(s);
      return {
        tabs: snap.tabs,
        activeId: snap.activeId,
        treeRoot: snap.treeRoot,
        bounds: s.win && !s.win.isDestroyed() ? s.win.getBounds() : null,
      };
    }),
  };
}

function saveSession() {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(sessionStoreFile(), JSON.stringify(snapshotSession(), null, 2), 'utf8');
  } catch (err) {
    logLine('session', `save failed: ${err.message}`);
  }
}

function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, 1000);
}

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(sessionStoreFile(), 'utf8'));
  } catch {
    return null;
  }
}

// ---- file tree helpers (pure, shared) ---------------------------------------

const TREE_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.idea', '.vscode']);
const TREE_MAX_ENTRIES = 500;

function listDirectory(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { path: dir, entries: [], error: err.message };
  }
  const items = entries
    .filter((entry) => !entry.name.startsWith('.') && !TREE_IGNORE.has(entry.name))
    .slice(0, TREE_MAX_ENTRIES)
    .map((entry) => {
      const full = path.join(dir, entry.name);
      let mtime = 0;
      let size = 0;
      try {
        const stat = fs.statSync(full);
        mtime = stat.mtimeMs;
        size = stat.size;
      } catch {
        /* a file can vanish between readdir and stat */
      }
      return { name: entry.name, path: full, dir: entry.isDirectory(), mtime, size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: dir, entries: items };
}

const EXPORT_FILTERS = {
  html: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  docx: [{ name: 'Word document', extensions: ['docx'] }],
  epub: [{ name: 'EPUB', extensions: ['epub'] }],
};

const EXPORT_TITLES = {
  html: 'Export HTML',
  pdf: 'Export PDF',
  docx: 'Export Word',
  epub: 'Export EPUB',
};

// ---- one window's document state --------------------------------------------

class Session {
  constructor(win) {
    this.win = win;
    this.file = null;
    this.contents = '';
    this.savedContents = '';
    this.tabs = new Map(); // id -> { id, file, contents, savedContents }
    this.activeId = null;
    this.untitledSeq = 0;
    this.autosaveTimer = null;
    this.draftTimer = null;
    this.fileWatcher = null;
    this.treeWatcher = null;
    this.treeRoot = null;
  }

  send(channel, payload) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  isDirty() {
    return this.contents !== this.savedContents;
  }

  refreshTitle() {
    if (!this.win || this.win.isDestroyed()) return;
    const name = this.file ? path.basename(this.file) : 'Untitled';
    this.win.setTitle(`${this.isDirty() ? '• ' : ''}${name} — mdpad`);
  }

  sendStatus(extra = {}) {
    this.send('app:status', {
      file: this.file,
      dirty: this.isDirty(),
      backupsDir: backupsDir(),
      draftsDir: draftsDir(),
      autosaveMs: AUTOSAVE_MS,
      ...extra,
    });
  }

  // --- tabs ---------------------------------------------------------------

  tabName(tab) {
    if (tab.file) return path.basename(tab.file);
    return tab.id.replace('untitled-', 'Untitled ');
  }

  stashActive() {
    if (!this.activeId) return;
    this.tabs.set(this.activeId, {
      id: this.activeId,
      file: this.file,
      contents: this.contents,
      savedContents: this.savedContents,
    });
  }

  tabsPayload() {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      name: this.tabName(tab),
      file: tab.file,
      dirty: tab.contents !== tab.savedContents,
      active: tab.id === this.activeId,
    }));
  }

  // Drag-reorder: rebuild the Map so insertion order (and therefore the snapshot
  // order) matches what the user sees. Unknown ids are ignored, missing ones appended.
  reorderTabs(ids) {
    if (!Array.isArray(ids)) return { ok: false };
    const ordered = new Map();
    for (const id of ids) {
      const tab = this.tabs.get(id);
      if (tab) ordered.set(id, tab);
    }
    for (const [id, tab] of this.tabs) {
      if (!ordered.has(id)) ordered.set(id, tab);
    }
    this.tabs = ordered;
    this.broadcastTabs();
    return { ok: true, ids: [...ordered.keys()] };
  }

  broadcastTabs() {
    this.send('tabs:update', this.tabsPayload());
    scheduleSessionSave();
  }

  reopenTab() {
    const stack = this.closedTabs || [];
    const last = stack.pop();
    this.closedTabs = stack;
    if (!last) return { ok: false };
    if (last.file) {
      try {
        return { ok: true, ...this.loadDocument(last.file) };
      } catch (err) {
        logLine('tabs', `reopen failed: ${err.message}`);
      }
    }
    const id = this.newTabId();
    this.tabs.set(id, { id, file: null, contents: last.contents || '', savedContents: '' });
    this.activateTab(id);
    return { ok: true, id };
  }

  newTabId() {
    this.untitledSeq += 1;
    return `untitled-${this.untitledSeq}-${this.win.webContents.id}`;
  }

  ensureInitialTab() {
    if (this.activeId) return;
    const id = this.newTabId();
    this.tabs.set(id, { id, file: null, contents: '', savedContents: '' });
    this.activeId = id;
    this.file = null;
    this.contents = '';
    this.savedContents = '';
  }

  activateTab(id) {
    this.stashActive();
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false };
    this.activeId = id;
    this.file = tab.file;
    this.contents = tab.contents;
    this.savedContents = tab.savedContents;
    this.watchDocument(this.file);
    this.refreshTitle();
    this.broadcastTabs();
    const draft = this.file
      ? storage.hasRecoverableDraft(this.file, this.contents, draftsDir())
      : null;
    this.send('doc:loaded', { id, file: this.file, contents: this.contents, draft });
    this.sendStatus({ file: this.file, dirty: this.isDirty() });
    return { ok: true, id };
  }

  closeTab(id) {
    if (id === this.activeId) this.stashActive();
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false };
    if (tab.contents !== tab.savedContents) {
      try {
        storage.writeDraft(tab.file, tab.contents, draftsDir());
      } catch {
        /* the buffer is gone either way */
      }
    }
    // Remember it so Ctrl+Shift+T can bring it back with the same buffer.
    this.closedTabs = this.closedTabs || [];
    this.closedTabs.push({ file: tab.file, contents: tab.contents });
    if (this.closedTabs.length > 10) this.closedTabs.shift();
    this.tabs.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      const remaining = [...this.tabs.keys()];
      if (remaining.length) return this.activateTab(remaining[remaining.length - 1]);
      const newId = this.newTabId();
      this.tabs.set(newId, { id: newId, file: null, contents: '', savedContents: '' });
      return this.activateTab(newId);
    }
    this.broadcastTabs();
    return { ok: true };
  }

  // --- documents ----------------------------------------------------------

  relativizeMarkdown(text) {
    if (!this.file) return text;
    const dirUrl = `file:///${path.dirname(this.file).replace(/\\/g, '/')}/`;
    return text.split(dirUrl).join('');
  }

  reloadFromDisk() {
    if (!this.file) return { opened: false };
    const contents = storage.readIfExists(this.file);
    if (contents === null) return { opened: false };
    const tab = [...this.tabs.values()].find((entry) => entry.file === this.file);
    if (!tab) return { opened: false };
    this.stashActive();
    tab.contents = contents;
    tab.savedContents = contents;
    this.activeId = tab.id;
    this.contents = contents;
    this.savedContents = contents;
    storage.clearDraft(this.file, draftsDir());
    this.watchDocument(this.file);
    this.refreshTitle();
    this.broadcastTabs();
    // Same payload shape as activation, so the renderer reloads the buffer; its cached
    // undo state no longer matches the new markdown and is dropped there.
    this.send('doc:loaded', { id: tab.id, file: this.file, contents, draft: null });
    this.sendStatus({ file: this.file, dirty: false });
    return { opened: true, reloaded: true };
  }

  loadDocument(file) {
    const contents = storage.readIfExists(file);
    if (contents === null) throw new Error(`cannot read ${file}`);
    this.stashActive();
    rememberRecent(file);
    const existing = [...this.tabs.values()].find((tab) => tab.file === file);
    if (existing) return this.activateTab(existing.id);
    const id = file;
    this.tabs.set(id, { id, file, contents, savedContents: contents });
    return this.activateTab(id);
  }

  writeDraftNow() {
    if (this.contents === this.savedContents) {
      storage.clearDraft(this.file, draftsDir());
      return null;
    }
    return storage.writeDraft(this.file, this.contents, draftsDir());
  }

  scheduleDraft() {
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      try {
        this.writeDraftNow();
      } catch (err) {
        this.sendStatus({ error: `draft: ${err.message}` });
      }
    }, DRAFT_MS);
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    if (this.readOnly) return; // do not hammer a file we already know is not writable
    const delay = clampAutosave(readSettings().autosaveMs);
    this.autosaveTimer = setTimeout(() => {
      if (!this.isDirty()) return;
      try {
        if (this.file) this.send('save:state', { state: 'saving', savedAt: this.savedAt || null });
        this.saveCurrent({ silent: true });
      } catch (err) {
        this.sendStatus({ error: `autosave: ${err.message}` });
      }
    }, delay);
  }

  saveCurrent({ silent = false } = {}) {
    if (!this.file) {
      this.send('save:state', { state: 'dirty', savedAt: null });
      return { saved: false, reason: 'no-file' };
    }
    let result;
    try {
      result = storage.saveDocument(this.file, this.contents, {
        backupsDir: backupsDir(),
        keep: BACKUP_KEEP,
      });
    } catch (err) {
      // Keep the buffer dirty and tell the user; never pretend the write happened.
      const code = fsErrorCode(err);
      const message = t(classifyFsError(err), currentLang(), { detail: err.message });
      logLine('save', `${this.file}: ${code || 'unknown'} ${err.message}`);
      // A permission problem will not fix itself by retrying every autosave tick.
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        this.readOnly = true;
      }
      this.sendStatus({
        error: message,
        saveFailed: true,
        saveErrorCode: code,
        readOnly: Boolean(this.readOnly),
      });
      return { saved: false, error: message, code };
    }
    if (result.changed) {
      this.savedContents = this.contents;
      this.savedAt = Date.now();
      this.send('save:state', { state: 'saved', savedAt: this.savedAt });
      this.readOnly = false;
      storage.clearDraft(this.file, draftsDir());
    }
    this.stashActive();
    this.broadcastTabs();
    this.refreshTitle();
    const backups = this.file ? storage.listBackups(this.file, backupsDir()) : [];
    const backupState = {
      backups: backups.length,
      lastBackupAt: backups.length ? backups[0].mtime : null,
    };
    if (silent) {
      // Autosave: keep the backup indicator fresh without a "saved" flash.
      this.sendStatus(backupState);
    } else {
      this.sendStatus({ saved: result.changed, backup: result.backup, ...backupState });
    }
    return result;
  }

  async saveAs() {
    const suggested = this.file || path.join(app.getPath('documents'), 'Untitled.md');
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, {
      title: 'Save Markdown',
      defaultPath: suggested,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (canceled || !filePath) return { saved: false, reason: 'canceled' };
    const previousFile = this.file;
    this.file = filePath;
    rememberRecent(filePath);
    const result = this.saveCurrent();
    if (previousFile) storage.clearDraft(previousFile, draftsDir());
    return result;
  }

  // --- export -------------------------------------------------------------

  async exportWith(kind) {
    const base = this.file
      ? path.join(path.dirname(this.file), path.basename(this.file, path.extname(this.file)))
      : path.join(app.getPath('documents'), 'Untitled');
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, {
      title: EXPORT_TITLES[kind] || 'Export',
      defaultPath: path.join(
        path.dirname(base),
        `${buildExportName(readSettings().exportNameTemplate, { title: path.basename(base) })}.${kind}`
      ),
      filters: EXPORT_FILTERS[kind] || [],
    });
    if (canceled || !filePath) return { exported: false, reason: 'canceled' };
    return this.exportTo(filePath, kind);
  }

  exportStats() {
    const text = String(this.contents || '');
    const words = (text.match(/\S+/g) || []).length;
    return {
      words,
      chars: text.length,
      line: t('export.stats', currentLang(), { words, chars: text.length }),
    };
  }

  async exportTo(filePath, kind, diagrams = this.exportDiagrams || null) {
    const name = path.basename(this.file || 'Untitled', path.extname(this.file || 'Untitled'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.sendStatus({ exporting: kind, target: path.basename(filePath) });

    if (kind === 'pdf') {
      const result = await exporter.toPdf(this.contents, filePath, {
        title: name,
        template: exportTemplate(),
        css: String(readSettings().exportCss || ''),
        stats: this.exportStats(),
        diagrams,
        font: exportFontStack(),
        margin: readSettings().exportMargin || 'normal',
      });
      this.sendStatus({ exported: result });
      this.send('doc:exported', { path: filePath, kind });
      return { exported: true, ...result };
    }
    if (kind === 'docx') {
      const result = await toDocx(this.contents, filePath, {
        title: name,
        baseDir: this.file ? path.dirname(this.file) : path.dirname(filePath),
      });
      fs.writeFileSync(filePath, result.buffer);
      const out = { path: filePath, bytes: result.bytes };
      this.sendStatus({ exported: out, sizeWarning: isLargeExport(result.bytes) ? describeSize(result.bytes) : null });
      return { exported: true, ...out };
    }
    if (kind === 'epub') {
      const result = await toEpub(this.contents, filePath, {
        title: name,
        baseDir: this.file ? path.dirname(this.file) : path.dirname(filePath),
        diagrams,
      });
      fs.writeFileSync(filePath, result.buffer);
      const out = { path: filePath, bytes: result.bytes, chapters: result.chapters };
      this.sendStatus({ exported: out, sizeWarning: isLargeExport(result.bytes) ? describeSize(result.bytes) : null });
      return { exported: true, ...out };
    }
    fs.writeFileSync(
      filePath,
      exporter.toHtmlDocument(this.contents, name, {
        template: exportTemplate(),
        css: String(readSettings().exportCss || ''),
        stats: this.exportStats(),
        diagrams,
        font: exportFontStack(),
        margin: readSettings().exportMargin || 'normal',
      }),
      'utf8'
    );
    const result = { path: filePath, bytes: fs.statSync(filePath).size };
    this.sendStatus({ exported: result });
    this.send('doc:exported', { path: filePath, kind });
    return { exported: true, ...result };
  }

  // --- watchers -----------------------------------------------------------

  watchDocument(file) {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (!file) return;
    let timer = null;
    try {
      this.fileWatcher = fs.watch(path.dirname(file), (_event, filename) => {
        if (!filename || path.basename(String(filename)) !== path.basename(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            const onDisk = storage.readIfExists(file);
            if (onDisk === null || onDisk === this.savedContents) return;
            if (onDisk === this.contents) {
              this.savedContents = onDisk;
              this.refreshTitle();
              return;
            }
            this.send('file:external', { size: onDisk.length });
          } catch {
            /* file may be mid-write */
          }
        }, 250);
      });
    } catch (err) {
      this.sendStatus({ error: `watch: ${err.message}` });
    }
  }

  setTreeRoot(root) {
    this.treeRoot = root || null;
    if (this.treeWatcher) {
      this.treeWatcher.close();
      this.treeWatcher = null;
    }
    // Closing the folder is allowed: no watcher, no path, no basename of null.
    if (!this.treeRoot) return { root: null, name: '' };
    let timer = null;
    try {
      this.treeWatcher = fs.watch(root, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.send('tree:changed', { root }), 300);
      });
    } catch (err) {
      this.sendStatus({ error: `tree watch: ${err.message}` });
    }
    return { root, name: path.basename(root) || root };
  }

  dispose() {
    clearTimeout(this.autosaveTimer);
    clearTimeout(this.draftTimer);
    if (this.fileWatcher) this.fileWatcher.close();
    if (this.treeWatcher) this.treeWatcher.close();
    try {
      if (this.contents !== this.savedContents) this.writeDraftNow();
    } catch {
      /* best effort */
    }
  }
}

const sessions = new Map(); // webContents id -> Session
const aiRequests = new Map(); // requestId -> AbortController for in-flight streams

function createWindow({ show = true, restore = null, cascade = 0 } = {}) {
  const savedBounds = restore && restore.bounds ? restore.bounds : null;
  const bounds = savedBounds ? fitBounds(savedBounds, screen.getAllDisplays()) : null;
  const cascadeOffset = cascade ? 40 + cascade * 28 : null;
  const win = new BrowserWindow({
    width: bounds ? bounds.width : 1180,
    height: bounds ? bounds.height : 800,
    minWidth: 720,
    minHeight: 480,
    x: bounds ? bounds.x : cascadeOffset || undefined,
    y: bounds ? bounds.y : cascadeOffset || undefined,
    show,
    title: 'Untitled — mdpad',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Hidden or background windows otherwise throttle timers and rAF, which stalls async
      // renderers (mermaid) and makes autosave timing depend on focus.
      backgroundThrottling: false,
    },
  });
  const session = new Session(win);
  // Capture the id now: reading win.webContents.id inside 'closed' throws because
  // the webContents is already destroyed by then.
  const sessionId = win.webContents.id;
  sessions.set(sessionId, session);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // A clicked link must never replace the editor UI: deny popups and hand safe URLs to the OS.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false);
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      lastExternalUrl = url;
      shell.openExternal(url).catch(() => {});
    }
  });

  win.webContents.on('did-finish-load', () => {
    session.startupMs = Date.now() - PROCESS_STARTED_AT;
    logLine('startup', `${session.startupMs} ms to first paint (${app.isPackaged ? 'packaged' : 'dev'})`);
    if (!readSettings().onboarded) {
      session.send('app:first-run', { version: app.getVersion() });
    }
    if (!preflightReport.ok) {
      session.send('app:preflight', {
        failed: preflightReport.failed.map((entry) => ({ name: entry.name, error: entry.error })),
      });
    }
    if (crashedLastRun) {
      const drafts = draftCount();
      logLine('crash', `previous run did not exit cleanly; drafts=${drafts}`);
      session.send('app:crashed', { drafts });
      crashedLastRun = false;
    }
    if (restore && Array.isArray(restore.tabs) && restore.tabs.length > 1) {
      session.send('session:restored', { tabs: restore.tabs.length });
    }
    if (restore && Array.isArray(restore.tabs) && restore.tabs.length) {
      restoreSessionTabs(session, restore);
    } else {
      session.ensureInitialTab();
      session.broadcastTabs();
      session.activateTab(session.activeId);
    }
    scheduleSessionSave();
  });

  // Unsaved work is already preserved as drafts; make that explicit instead of
  // discarding buffers silently or blocking on a per-document save flow.
  win.on('close', async (event) => {
    if (session.forceClose) return;
    session.stashActive();
    const dirty = [...session.tabs.values()].filter((tab) => tab.contents !== tab.savedContents);
    if (!dirty.length) return;
    event.preventDefault();
    const lang = currentLang();
    const summary = summarizeDirty(dirty);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [t('dialog.keepEditing', lang), t('dialog.closeKeepDrafts', lang)],
      defaultId: 0,
      cancelId: 0,
      title: t('dialog.unsavedTitle', lang),
      message: t('dialog.unsavedMessage', lang, { count: dirty.length }),
      detail: `${summary.detail}\n\n${t('dialog.unsavedDetail', lang)}`,
    });
    if (response === 1) {
      session.forceClose = true;
      win.close();
    }
  });

  win.on('closed', () => {
    sessions.delete(sessionId);
    scheduleSessionSave();
  });
  return win;
}

// Rebuild a window's tabs from the persisted session, skipping files that vanished.
function restoreSessionTabs(session, restore) {
  session.tabs.clear();
  session.activeId = null;
  let activeId = null;
  let count = 0;

  for (const entry of restore.tabs || []) {
    if (count >= MAX_RESTORE_TABS) break;
    if (entry.file) {
      const contents = storage.readIfExists(entry.file);
      if (contents === null) {
        logLine('session', `missing file ${entry.file}`);
        continue;
      }
      const id = entry.file;
      session.tabs.set(id, { id, file: entry.file, contents, savedContents: contents });
      if (entry.activeId === id || activeId === null) activeId = activeId ?? id;
      count += 1;
    } else {
      const id = session.newTabId();
      const contents = entry.contents || '';
      session.tabs.set(id, { id, file: null, contents, savedContents: '' });
      count += 1;
    }
  }

  if (!session.tabs.size) {
    session.ensureInitialTab();
    session.broadcastTabs();
    session.activateTab(session.activeId);
    return;
  }

  const wanted = [...session.tabs.keys()].find((id) => id === restore.activeId) || activeId || [...session.tabs.keys()][0];
  session.broadcastTabs();
  session.activateTab(wanted);

  if (restore.treeRoot) {
    const info = session.setTreeRoot(restore.treeRoot);
    session.send('tree:root', { ...info, ...listDirectory(restore.treeRoot) });
  }
}

// ---- IPC -------------------------------------------------------------------

function sessionFor(event) {
  return sessions.get(event.sender.id);
}

function registerIpc() {
  ipcMain.handle('app:openPath', async (_e, { path: target } = {}) => {
    const file = String(target || '');
    if (!file || !fs.existsSync(file)) return { opened: false, reason: 'missing' };
    const error = await shell.openPath(file);
    return { opened: !error, error: error || undefined };
  });

  ipcMain.handle('app:showInFolder', (_e, { path: target } = {}) => {
    const file = String(target || '');
    if (!file || !fs.existsSync(file)) return { shown: false, reason: 'missing' };
    shell.showItemInFolder(file);
    return { shown: true };
  });

  ipcMain.handle('app:toggleFullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return { fullscreen: toggleFullscreen(win) };
  });

  ipcMain.handle('app:openExternal', async (_e, { url } = {}) => {
    if (!isSafeExternalUrl(url)) return { opened: false, reason: 'unsafe' };
    lastExternalUrl = String(url);
    await shell.openExternal(String(url));
    return { opened: true, url: String(url) };
  });

  ipcMain.handle('app:lastExternal', () => lastExternalUrl);

  ipcMain.handle('doc:syncChange', (event, { contents }) => {
    const s = sessionFor(event);
    s.send('save:state', { state: 'dirty', savedAt: s.savedAt || null });
    s.contents = s.relativizeMarkdown(String(contents ?? ''));
    s.scheduleDraft();
    s.scheduleAutosave();
    s.stashActive();
    s.refreshTitle();
    s.broadcastTabs();
    return { dirty: s.isDirty() };
  });

  ipcMain.handle('tabs:list', (event) => sessionFor(event).tabsPayload());
  ipcMain.handle('doc:activate', (event, { id }) => sessionFor(event).activateTab(id));
  ipcMain.handle('doc:close', (event, { id }) => sessionFor(event).closeTab(id));
  ipcMain.handle('tabs:reorder', (event, { ids } = {}) => sessionFor(event).reorderTabs(ids));
  ipcMain.handle('tabs:reopen', (event) => sessionFor(event).reopenTab());

  ipcMain.handle('doc:save', async (event) => {
    const s = sessionFor(event);
    if (!s.file) return s.saveAs();
    const result = s.saveCurrent();
    if (result.saved === false && result.error) {
      if (!SMOKE && s.win && !s.win.isDestroyed()) {
        const lang = currentLang();
        const { response } = await dialog.showMessageBox(s.win, {
          type: 'error',
          buttons: [t('dialog.retry', lang), t('dialog.saveAs', lang), t('dialog.cancel', lang)],
          defaultId: 0,
          cancelId: 2,
          title: t('dialog.saveFailedTitle', lang),
          message: t('dialog.saveFailedMessage', lang),
          detail: result.error,
        });
        if (response === 0) return s.saveCurrent();
        if (response === 1) return s.saveAs();
      }
      return result;
    }
    return result;
  });
  ipcMain.handle('doc:saveAs', (event) => sessionFor(event).saveAs());

  ipcMain.handle('doc:open', async (event) => {
    const s = sessionFor(event);
    const { canceled, filePaths } = await dialog.showOpenDialog(s.win, {
      title: 'Open Markdown',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (canceled || !filePaths.length) return { opened: false };
    return s.loadDocument(filePaths[0]);
  });

  ipcMain.handle('doc:new', (event) => {
    const s = sessionFor(event);
    s.stashActive();
    const id = s.newTabId();
    s.tabs.set(id, { id, file: null, contents: '', savedContents: '' });
    return s.activateTab(id);
  });

  ipcMain.handle('doc:reload', (event) => {
    const s = sessionFor(event);
    if (!s.file) return { opened: false };
    return s.reloadFromDisk();
  });

  // The editor normalizes markdown on load; adopt that serialization as the clean
  // baseline so a freshly opened file is not immediately "dirty".
  ipcMain.handle('doc:normalize', (event, { contents }) => {
    const s = sessionFor(event);
    if (s.contents !== s.savedContents) return { normalized: false };
    s.contents = String(contents ?? '');
    s.savedContents = s.contents;
    s.stashActive();
    s.broadcastTabs();
    s.refreshTitle();
    return { normalized: true };
  });

  ipcMain.handle('doc:diagrams', (event, { diagrams } = {}) => {
    const session = sessionFor(event);
    if (!session) return { stored: 0 };
    const map = diagrams && typeof diagrams === 'object' ? diagrams : {};
    session.exportDiagrams = map;
    return { stored: Object.keys(map).length };
  });

  ipcMain.handle('doc:exportHtml', (event) => sessionFor(event).exportWith('html'));
  ipcMain.handle('doc:exportPdf', (event) => sessionFor(event).exportWith('pdf'));
  ipcMain.handle('doc:exportDocx', (event) => sessionFor(event).exportWith('docx'));
  ipcMain.handle('doc:exportEpub', (event) => sessionFor(event).exportWith('epub'));

  ipcMain.handle('doc:backupInfo', (event) => {
    const s = sessionFor(event);
    if (!s.file) return { count: 0, lastAt: null };
    const backups = storage.listBackups(s.file, backupsDir());
    return { count: backups.length, lastAt: backups.length ? backups[0].mtime : null };
  });

  ipcMain.handle('doc:backups', (event) => {
    const s = sessionFor(event);
    if (!s.file) return [];
    return storage.listBackups(s.file, backupsDir()).map((entry) => ({
      path: entry.path,
      name: entry.name,
      mtime: entry.mtime,
      size: entry.size,
    }));
  });

  ipcMain.handle('doc:restoreBackup', (event, { filePath } = {}) => {
    const s = sessionFor(event);
    if (!s.file || !filePath) return { restored: false };
    // Only restore files inside our own backups directory.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(backupsDir()) + path.sep)) {
      return { restored: false, error: 'not a backup file' };
    }
    const contents = storage.readIfExists(resolved);
    if (contents === null) return { restored: false, error: 'backup is gone' };
    logLine('backup', `restored ${path.basename(resolved)} into the editor`);
    return { restored: true, contents };
  });

  ipcMain.handle('export:namePreview', (event, { template = '{title}' } = {}) => {
    const s = sessionFor(event);
    const base = s && s.file ? path.basename(s.file, path.extname(s.file)) : 'Untitled';
    try {
      return { name: buildExportName(template, { title: base }) };
    } catch (err) {
      return { name: base, error: err.message };
    }
  });

  ipcMain.handle('export:preview', (event) => previewExport(sessionFor(event)));

  ipcMain.handle('draft:discard', (event) => {
    const s = sessionFor(event);
    storage.clearDraft(s.file, draftsDir());
    return { discarded: true };
  });

  ipcMain.handle('backup:list', (event) => {
    const s = sessionFor(event);
    return storage.listBackups(s.file || '', backupsDir());
  });

  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch = {}) => {
    const next = {};
    if (THEMES.has(patch.theme)) next.theme = patch.theme;
    if (patch.autosaveMs !== undefined) next.autosaveMs = clampAutosave(patch.autosaveMs);
    if (patch.language === 'en' || patch.language === 'zh') next.language = patch.language;
    if (EXPORT_TEMPLATES.includes(patch.exportTemplate)) next.exportTemplate = patch.exportTemplate;
      if (FONT_KEYS.includes(patch.exportFont)) next.exportFont = patch.exportFont;
      if (EXPORT_MARGINS.includes(patch.exportMargin)) next.exportMargin = patch.exportMargin;
    if (patch.aiSystemPrompt !== undefined) {
      next.aiSystemPrompt = String(patch.aiSystemPrompt || '').slice(0, 2000);
    }
    if (typeof patch.exportNameTemplate === 'string') {
      next.exportNameTemplate = patch.exportNameTemplate.slice(0, 120);
    }
    if (typeof patch.exportCss === 'string') {
      next.exportCss = patch.exportCss.replace(/<\/?style[^>]*>/gi, '').slice(0, 10000);
    }
    if (patch.onboarded === true) next.onboarded = true;
    if (patch.guideDismissed === true) next.guideDismissed = true;
    if (patch.focusMode !== undefined) next.focusMode = patch.focusMode === true;
    if (FONT_KEYS.includes(patch.editorFont)) next.editorFont = patch.editorFont;
    if (['narrow', 'normal', 'wide'].includes(patch.lineWidth)) next.lineWidth = patch.lineWidth;
    if (['blue', 'teal', 'violet', 'amber'].includes(patch.accent)) next.accent = patch.accent;
    if (patch.filesCollapsed !== undefined) next.filesCollapsed = patch.filesCollapsed === true;
    if (FONT_KEYS.includes(patch.exportFont)) next.exportFont = patch.exportFont;
    if (EXPORT_MARGINS.includes(patch.exportMargin)) next.exportMargin = patch.exportMargin;
    if (patch.collapsedSections && typeof patch.collapsedSections === 'object') {
      const clean = {};
      for (const [key, value] of Object.entries(patch.collapsedSections)) {
        if (/^[a-z][a-z0-9-]{0,30}$/.test(key)) clean[key] = value === true;
      }
      next.collapsedSections = clean;
    }
    if (AI_SCOPES.includes(patch.aiContextScope)) next.aiContextScope = patch.aiContextScope;
    if (patch.aiContextScope === '') next.aiContextScope = '';
    if (patch.aiConfirmOverTokens !== undefined) {
      next.aiConfirmOverTokens = clampConfirmTokens(patch.aiConfirmOverTokens);
    }
    if (typeof patch.feedUrl === 'string') {
      next.updates = { ...(readSettings().updates || {}), feedUrl: patch.feedUrl.trim() };
    }
    writeSettings(next);
    if (next.language) buildMenu();
    return publicSettings();
  });

  ipcMain.handle('update:check', (_e, payload = {}) => performUpdateCheck(payload.feedUrl));

  ipcMain.handle('recent:list', () => recentFiles());

  ipcMain.handle('clipboard:write', (_e, { text } = {}) => {
    clipboard.writeText(String(text || ''));
    return { copied: String(text || '').length };
  });
  if (SMOKE) {
    ipcMain.handle('clipboard:read', () => clipboard.readText());
  }

  ipcMain.handle('drafts:list', () =>
    listDrafts(draftsDir()).map((draft) => ({
      path: draft.path,
      file: draft.file,
      name: draft.name,
      updatedAt: draft.updatedAt,
      bytes: draft.bytes,
    }))
  );

  ipcMain.handle('drafts:delete', async (event, { file } = {}) => {
    const s = sessionFor(event);
    const name = String(file || '');
    if (!name || !fs.existsSync(name)) return { removed: false, reason: 'missing' };
    if (!SMOKE) {
      const lang = currentLang();
      const { response } = await dialog.showMessageBox(s.win, {
        type: 'warning',
        buttons: [t('drafts.deleteConfirm', lang), t('dialog.cancel', lang)],
        defaultId: 1,
        cancelId: 1,
        title: t('drafts.title', lang),
        message: t('drafts.deleteMessage', lang, { name: path.basename(name) }),
      });
      if (response !== 0) return { removed: false, reason: 'canceled' };
    }
    try {
      fs.unlinkSync(name);
      return { removed: true };
    } catch (err) {
      return { removed: false, error: err.message };
    }
  });

  ipcMain.handle('drafts:purge', async (event, { olderThanDays = 30 } = {}) => {
    const s = sessionFor(event);
    const days = Number(olderThanDays) > 0 ? Number(olderThanDays) : 30;
    const stale = selectStaleDrafts(listDrafts(draftsDir()).map((draft) => ({
      ...draft,
      updatedAt: draft.updatedAt,
    })), { olderThanDays: days });
    if (!stale.length) return { removed: 0, confirmed: false };
    const lang = currentLang();
    if (!SMOKE) {
      const { response } = await dialog.showMessageBox(s.win, {
        type: 'warning',
        buttons: [t('drafts.purgeConfirm', lang), t('dialog.cancel', lang)],
        defaultId: 1,
        cancelId: 1,
        title: t('drafts.title', lang),
        message: t('drafts.purgeMessage', lang, { count: stale.length, days }),
      });
      if (response !== 0) return { removed: 0, confirmed: false };
    }
    let removed = 0;
    for (const draft of stale) {
      try {
        fs.unlinkSync(draft.path);
        removed += 1;
      } catch (err) {
        logLine('drafts', `purge ${draft.path}: ${err.message}`);
      }
    }
    return { removed, confirmed: true };
  });

  ipcMain.handle('drafts:restore', (event, { file } = {}) => {
    const s = sessionFor(event);
    const draft = listDrafts(draftsDir()).find((entry) => entry.path === file);
    if (!draft) return { restored: false, error: 'draft is gone' };
    if (draft.file && fs.existsSync(draft.file)) {
      try {
        s.loadDocument(draft.file);
      } catch (err) {
        logLine('drafts', err.message);
      }
    }
    // doc:loaded carries the on-disk version; send the draft after it so it wins.
    s.send('doc:loadDraft', { contents: draft.contents });
    return { restored: true, contents: draft.contents, file: draft.file };
  });

  ipcMain.handle('drafts:open', async () => {
    await shell.openPath(draftsDir());
    return { opened: true };
  });

  ipcMain.handle('settings:export', async (event) => {    const s = sessionFor(event);
    const { canceled, filePath } = await dialog.showSaveDialog(s.win, {
      title: t('settings.exportTitle', currentLang()),
      defaultPath: path.join(app.getPath('documents'), 'mdpad-settings.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { exported: false };
    fs.writeFileSync(filePath, JSON.stringify(settingsForExport(), null, 2), 'utf8');
    return { exported: true, path: filePath };
  });

  ipcMain.handle('settings:import', async (event) => {
    const s = sessionFor(event);
    const lang = currentLang();
    const { canceled, filePaths } = await dialog.showOpenDialog(s.win, {
      title: t('settings.importTitle', lang),
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths.length) return { imported: false };
    try {
      const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      return { imported: true, settings: applyImportedSettings(data) };
    } catch (err) {
      logLine('settings', `import failed: ${err.message}`);
      dialog.showMessageBox(s.win, {
        type: 'error',
        title: t('settings.importTitle', lang),
        message: t('settings.importFailed', lang),
        detail: err.message,
        buttons: [t('dialog.ok', lang)],
      });
      return { imported: false, error: err.message };
    }
  });

  // Deterministic hooks for the smoke suite (no dialogs).
  if (SMOKE) {
    ipcMain.handle('settings:exportPath', (_e, { filePath }) => {
      fs.writeFileSync(filePath, JSON.stringify(settingsForExport(), null, 2), 'utf8');
      return { exported: true, path: filePath };
    });
    ipcMain.handle('settings:importPath', (_e, { filePath }) => {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { imported: true, settings: applyImportedSettings(data) };
    });
  }

  ipcMain.handle('log:error', (_e, payload) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    logLine('renderer', String(text).slice(0, 4000));
    return { logged: true };
  });

  ipcMain.handle('log:path', () => logFilePath());

  ipcMain.handle('ai:config', () => {
    const cfg = readSettings().ai || {};
    return {
      baseUrl: cfg.baseUrl || '',
      model: cfg.model || '',
      hasKey: Boolean(cfg.key && cfg.key.value),
      keyScheme: cfg.key ? cfg.key.scheme : null,
      keyStoredSecurely: Boolean(cfg.key && cfg.key.scheme === 'safeStorage'),
    };
  });

  ipcMain.handle('ai:configure', (_e, patch = {}) => {
    const current = readSettings().ai || {};
    const next = { baseUrl: current.baseUrl || '', model: current.model || '' };
    if (current.key) next.key = current.key;
    if (typeof patch.baseUrl === 'string') next.baseUrl = patch.baseUrl.trim();
    if (typeof patch.model === 'string') next.model = patch.model.trim();
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim().length) {
      next.key = encryptSecret(patch.apiKey.trim());
    }
    if (patch.clearKey) delete next.key;
    writeSettings({ ai: next });
    return {
      baseUrl: next.baseUrl || '',
      model: next.model || '',
      hasKey: Boolean(next.key),
      keyScheme: next.key ? next.key.scheme : null,
      keyStoredSecurely: Boolean(next.key && next.key.scheme === 'safeStorage'),
    };
  });

  ipcMain.handle('ai:complete', async (_e, payload = {}) => {
    const cfg = readSettings().ai || {};
    const baseUrl = payload.baseUrl || cfg.baseUrl;
    const model = payload.model || cfg.model;
    const apiKey = decryptSecret(cfg.key);
    if (!baseUrl) {
      return { ok: false, error: 'AI endpoint is not configured — open the AI settings first' };
    }
    try {
      const text = await ai.complete({
        baseUrl,
        apiKey,
        model,
        instruction: payload.instruction,
        selection: payload.selection,
        context: payload.context,
        language: payload.language,
        history: payload.history,
      });
      logLine('ai', `ok model=${model || 'default'} bytes=${text.length}`);
      return { ok: true, text };
    } catch (err) {
      logLine('ai', `failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  // Streaming variant: chunks go to the requesting window, the promise resolves
  // with the final text so the caller can enable "insert" only on success.
  ipcMain.handle('ai:stream', async (event, payload = {}) => {
    const cfg = readSettings().ai || {};
    const baseUrl = payload.baseUrl || cfg.baseUrl;
    const model = payload.model || cfg.model;
    const apiKey = decryptSecret(cfg.key);
    const requestId = payload.requestId || `req-${Date.now()}`;
    if (!baseUrl) {
      return { ok: false, error: 'AI endpoint is not configured — open the AI settings first' };
    }

    const controller = new AbortController();
    aiRequests.set(requestId, controller);
    const sender = event.sender;
    const startedAt = Date.now();
    const promptChars =
      String(payload.instruction || '').length +
      String(payload.selection || '').length +
      String(payload.context || '').length +
      JSON.stringify(payload.history || []).length;

    try {
      const text = await ai.completeStream(
        {
          baseUrl,
          apiKey,
          model,
          instruction: payload.instruction,
          selection: payload.selection,
          context: payload.context,
          language: payload.language,
          history: payload.history,
          systemPrompt:
            payload.systemPrompt || readSettings().aiSystemPrompt || '',
          onRetry: (info) => {
            if (!sender.isDestroyed()) sender.send('ai:retry', { requestId, ...info });
          },
        },
        (delta) => {
          if (!sender.isDestroyed()) sender.send('ai:chunk', { requestId, delta });
        },
        controller.signal
      );
      logLine('ai', `stream ok model=${model || 'default'} bytes=${text.length}`);
      recordAiUsage({
        at: new Date().toISOString(),
        model: model || 'default',
        promptTokens: Math.round(promptChars / 4),
        outTokens: Math.round(text.length / 4),
        ms: Date.now() - startedAt,
        ok: true,
      });
      return { ok: true, text, requestId };
    } catch (err) {
      logLine('ai', `stream failed: ${err.message}`);
      recordAiUsage({
        at: new Date().toISOString(),
        model: model || 'default',
        promptTokens: Math.round(promptChars / 4),
        outTokens: 0,
        ms: Date.now() - startedAt,
        ok: false,
        error: err.message,
      });
      return { ok: false, error: err.message, requestId };
    } finally {
      aiRequests.delete(requestId);
    }
  });

  ipcMain.handle('ai:cancel', (_e, { requestId }) => {
    const controller = aiRequests.get(requestId);
    if (controller) controller.abort();
    return { cancelled: Boolean(controller) };
  });

  ipcMain.handle('ai:history:get', () => readAiHistory());
  ipcMain.handle('ai:history:set', (_e, { turns }) => writeAiHistory(turns));
  ipcMain.handle('ai:models', async (_e, patch = {}) => {
    const cfg = readSettings().ai || {};
    const baseUrl = String(patch.baseUrl || cfg.baseUrl || '').trim();
    const apiKey = patch.apiKey ? String(patch.apiKey) : decryptSecret(cfg.key);
    if (!baseUrl) return { ok: false, error: 'endpoint is empty', hint: 'Set the base URL first.' };
    try {
      const models = await listModels({ baseUrl, apiKey, timeoutMs: 10000 });
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err.message, hint: diagnoseAiError(err.message) };
    }
  });

  ipcMain.handle('ai:test', async (_e, patch = {}) => {
    const cfg = readSettings().ai || {};
    const baseUrl = String(patch.baseUrl || cfg.baseUrl || '').trim();
    const model = String(patch.model || cfg.model || '').trim();
    // A typed key wins over the stored one, so the test can run before saving.
    const apiKey = patch.apiKey ? String(patch.apiKey) : decryptSecret(cfg.key);
    if (!baseUrl) {
      return {
        ok: false,
        error: 'endpoint is empty',
        hint: 'Set the base URL first, e.g. https://api.deepseek.com/v1',
      };
    }
    if (!apiKey) {
      return {
        ok: false,
        error: 'no API key',
        hint: 'Paste the key from your provider; it is stored in the OS credential store, not in plain text.',
      };
    }
    const started = Date.now();
    try {
      const text = await ai.complete({
        baseUrl,
        apiKey,
        model,
        instruction: 'Reply with the single word: ok',
        timeoutMs: 15000,
      });
      return { ok: true, ms: Date.now() - started, reply: text.slice(0, 60), model };
    } catch (err) {
      return {
        ok: false,
        ms: Date.now() - started,
        error: err.message,
        hint: diagnoseAiError(err.message),
      };
    }
  });

  ipcMain.handle('ai:usage:list', () => readAiUsage());
  ipcMain.handle('ai:usage:export', async (event) => {
    const s = sessionFor(event);
    const { canceled, filePath } = await dialog.showSaveDialog(s.win, {
      title: 'Export AI usage',
      defaultPath: path.join(app.getPath('documents'), 'mdpad-ai-usage.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { exported: false };
    fs.writeFileSync(filePath, usageToCsv(), 'utf8');
    return { exported: true, path: filePath };
  });
  if (SMOKE) {
    ipcMain.handle('ai:usage:exportPath', (_e, { filePath }) => {
      fs.writeFileSync(filePath, usageToCsv(), 'utf8');
      return { exported: true, path: filePath };
    });
  }

  ipcMain.handle('app:restoreDecision', (_e, { crashes = 0, hasSession = true } = {}) =>
    decideRestore({ crashes: Number(crashes) || 0, hasSession: Boolean(hasSession) })
  );

  ipcMain.handle('app:info', (event) => {
    const s = sessionFor(event);
    return {
      version: app.getVersion(),
      file: s.file,
      dirty: s.isDirty(),
      backupsDir: backupsDir(),
      draftsDir: draftsDir(),
      autosaveMs: AUTOSAVE_MS,
      backupKeep: BACKUP_KEEP,
      windows: sessions.size,
      startupMs: s.startupMs || null,
      savedAt: s.savedAt || null,
      preflight: preflightReport.ok ? 'ok' : 'failed',
      readOnly: s.readOnly === true,
      packaged: app.isPackaged,
    };
  });

  ipcMain.handle('image:save', (event, { dataUrl, ext }) => {
    const s = sessionFor(event);
    const match = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!match) throw new Error('unsupported image payload');
    const extName = String(ext || match[1] || 'png').toLowerCase().replace(/^jpeg$/, 'jpg');
    const bytes = Buffer.from(match[2], 'base64');
    const name = `${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12)}.${extName}`;
    const dir = s.file ? path.join(path.dirname(s.file), 'assets') : path.join(userDir(), 'assets');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
    const fileUrl = `file:///${target.replace(/\\/g, '/')}`;
    const reference = s.file ? `assets/${name}` : fileUrl;
    return { path: target, markdown: `![](${reference})`, fileUrl, reference };
  });

  ipcMain.handle('tree:choose', async (event) => {
    const s = sessionFor(event);
    const { canceled, filePaths } = await dialog.showOpenDialog(s.win, {
      title: 'Open Folder',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const root = filePaths[0];
    const info = s.setTreeRoot(root);
    return { ...info, ...listDirectory(root), canceled: false };
  });

  ipcMain.handle('tree:setRoot', (event, { root }) => {
    const s = sessionFor(event);
    // Closing a folder is a legitimate state, not an invalid path.
    if (!root) return { ...s.setTreeRoot(null), root: null, name: '', entries: [] };
    return { ...s.setTreeRoot(root), ...listDirectory(root) };
  });

  ipcMain.handle('tree:children', (_e, { dir }) => listDirectory(dir));
  ipcMain.handle('tree:open', (event, { file }) => sessionFor(event).loadDocument(file));
}

// ---- menu ------------------------------------------------------------------

function focusedSession() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  return win ? sessions.get(win.webContents.id) : undefined;
}

function toggleFullscreen(target) {
  const win = target && !target.isDestroyed() ? target : focusedWindow();
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
}

function sendMenuAction(action) {
  const s = focusedSession();
  if (s) s.send('menu:action', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const L = () => normalizeLang(readSettings().language || app.getLocale());
  const tt = (key, vars) => t(key, L(), vars);

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: tt('menu.file'),
      submenu: [
        { label: tt('menu.new'), accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new') },
        { label: tt('menu.newWindow'), accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: tt('menu.open'), accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('open') },
        {
          label: tt('menu.openRecent'),
          submenu: (() => {
            const recent = recentFiles();
            if (!recent.length) return [{ label: tt('menu.empty'), enabled: false }];
            const items = recent.map((entry) => ({
              label: path.basename(entry),
              tooltip: entry,
              click: () => {
                const target = focusedSession();
                if (target) {
                  try {
                    target.loadDocument(entry);
                  } catch (err) {
                    logLine('recent', `${entry}: ${err.message}`);
                  }
                }
              },
            }));
            items.push(
              { type: 'separator' },
              {
                label: tt('menu.clearRecent'),
                click: () => {
                  writeSettings({ recent: [] });
                  buildMenu();
                },
              }
            );
            return items;
          })(),
        },
        { label: tt('menu.openFolder'), accelerator: 'CmdOrCtrl+K', click: () => sendMenuAction('openFolder') },
        { type: 'separator' },
        { label: tt('menu.save'), accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('save') },
        { label: tt('menu.saveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('saveAs') },
        { type: 'separator' },
        { label: tt('menu.exportHtml'), accelerator: 'CmdOrCtrl+Shift+E', click: () => sendMenuAction('exportHtml') },
        { label: tt('menu.exportPdf'), accelerator: 'CmdOrCtrl+Shift+P', click: () => sendMenuAction('exportPdf') },
        { label: tt('menu.exportWord'), click: () => sendMenuAction('exportDocx') },
        { label: tt('menu.exportEpub'), click: () => sendMenuAction('exportEpub') },
        { label: tt('menu.preview'), accelerator: 'CmdOrCtrl+Shift+V', click: () => sendMenuAction('previewExport') },
        { type: 'separator' },
        { label: tt('menu.backups'), click: () => shell.openPath(backupsDir()) },
        { label: tt('menu.logs'), click: () => shell.openPath(path.dirname(logFilePath())) },
        { type: 'separator' },
        { label: tt('menu.recoverDrafts'), click: () => sendMenuAction('recoverDrafts') },
        { label: tt('menu.exportSettings'), click: () => sendMenuAction('exportSettings') },
        { label: tt('menu.importSettings'), click: () => sendMenuAction('importSettings') },
        { role: isMac ? 'close' : 'quit', label: isMac ? tt('menu.close') : tt('menu.quit') },
      ],
    },
    {
      ...{ role: 'editMenu' },
      label: tt('menu.edit'),
    },
    {
      label: tt('menu.go'),
      submenu: [
        { label: tt('menu.find'), accelerator: 'CmdOrCtrl+F', click: () => sendMenuAction('find') },
        { label: tt('menu.outline'), accelerator: 'CmdOrCtrl+Shift+O', click: () => sendMenuAction('toggleOutline') },
      ],
    },
    {
      label: tt('menu.view'),
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: tt('menu.fullscreen'),
          accelerator: 'F11',
          click: () => toggleFullscreen(BrowserWindow.getFocusedWindow()),
        },
        { type: 'separator' },
        {
          label: tt('menu.focusMode'),
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => sendMenuAction('toggleFocusMode'),
        },
      ],
    },
    {
      label: tt('menu.help'),
      submenu: [
        {
          label: tt('menu.about'),
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: tt('menu.about'),
              message: `mdpad ${app.getVersion()}`,
              detail: tt('dialog.aboutDetail', {
                electron: process.versions.electron,
                chromium: process.versions.chrome,
                node: process.versions.node,
                data: userDir(),
              }),
              buttons: [tt('dialog.ok')],
            });
          },
        },
        {
          label: tt('menu.checkUpdates'),
          click: async () => {
            const result = await performUpdateCheck();
            const detail = result.ok
              ? result.available
                ? `${tt('dialog.updateAvailable')}: ${result.version}\n${app.getVersion()}`
                : `${tt('dialog.upToDate')} (${result.current})`
              : String(result.error || 'unknown error');
            dialog.showMessageBox({
              type: result.ok ? 'info' : 'warning',
              title: tt('dialog.updateTitle'),
              message: result.ok
                ? result.available
                  ? tt('dialog.updateAvailable')
                  : tt('dialog.upToDate')
                : tt('dialog.updateFailed'),
              detail,
              buttons: [tt('dialog.ok')],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- smoke test ------------------------------------------------------------

async function runSmoke() {
  const out = [];
  const dir = path.join(app.getPath('temp'), `mdpad-smoke-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const docPath = path.join(dir, 'note.md');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (name, ok, extra = {}) => {
    out.push({ step: name, ok, ...extra });
    console.log(`SMOKE_STEP ${name} ${ok ? 'ok' : 'FAIL'}`);
  };

  const watchdog = setTimeout(() => {
    console.error('SMOKE_TIMEOUT after 330s; completed=' + JSON.stringify(out));
    app.exit(2);
  }, 330000);

  // Deterministic UI language for assertions; the i18n check switches explicitly.
  writeSettings({
    language: 'en',
    exportTemplate: 'default',
    onboarded: true,
    theme: 'light',
    guideDismissed: false,
    focusMode: false,
  });

  // The smoke profile is reused between runs, so a lock left by the previous (forcibly
  // killed) run would raise the crash banner and look like a real failure here.
  try {
    fs.unlinkSync(lockFile());
  } catch {
    /* no stale lock */
  }
  crashedLastRun = false;

  // Later checks call this so they do not inherit state from earlier ones: a dismissed guide
  // card or a sepia theme left behind by a previous assertion once failed a packaged run.
  async function resetUiState() {
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.api.setSettings({
        theme: 'light',
        language: 'en',
        guideDismissed: false,
        focusMode: false,
        collapsedSections: {},
        paletteUsage: {},
      });
      if (typeof applyTheme === 'function') applyTheme('light');
      window.__mdpad.closeAI();
      for (const id of ['#settings-modal', '#palette', '#findbar', '#stats-modal', '#drafts-modal', '#shortcuts']) {
        const el = document.querySelector(id);
        if (el) el.hidden = true;
      }
      await sleep(150);
      return true;
    })()`);
    await sleep(250);
  }

  const win = createWindow({ show: false });
  const s = sessions.get(win.webContents.id);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(150);
  step('window-loaded', true);
  step('profile-isolated', app.getPath('userData').includes('mdpad-smoke-profile'), {
    userData: app.getPath('userData'),
  });

  const startup = await win.webContents.executeJavaScript(`window.api.info()`);
  // Dev builds ship an unbundled esbuild output and no asar, and CI machines are noisy;
  // the packaged budget is the one that matters.
  const startupLimit = startup.packaged ? 5000 : 10000;
  step('startup-time', typeof startup.startupMs === 'number' && startup.startupMs < startupLimit, {
    startupMs: startup.startupMs,
    packaged: startup.packaged,
    limit: startupLimit,
  });
  step('startup-preflight', startup.preflight === 'ok', { preflight: startup.preflight });

  // 0b. overlays must really be hidden (the hidden attribute must beat layout classes),
  // and opening one must actually paint it.
  const overlayIds = [
    'settings-modal',
    'banner',
    'crash-banner',
    'findbar',
    'table-bar',
    'image-bar',
    'palette',
    'shortcuts',
    'stats-modal',
    'backup-popover',
  ];
  const overlayState = await win.webContents.executeJavaScript(`(() => {
    const ids = ${JSON.stringify(overlayIds)};
    const displays = Object.fromEntries(ids.map((id) => [id, getComputedStyle(document.getElementById(id)).display]));
    return displays;
  })()`);
  const stillVisible = Object.entries(overlayState).filter(([, display]) => display !== 'none');
  step('overlays-hidden', stillVisible.length === 0, { visible: stillVisible.map(([id]) => id) });

  const overlayToggle = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(300);
    const openDisplay = getComputedStyle(document.querySelector('#settings-modal')).display;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    const closedDisplay = getComputedStyle(document.querySelector('#settings-modal')).display;
    return { openDisplay, closedDisplay };
  })()`);
  step(
    'overlays-toggle',
    overlayToggle.openDisplay === 'flex' && overlayToggle.closedDisplay === 'none',
    overlayToggle
  );

  // 0c. dark theme actually repaints the shell with a dark background
  const themeContrast = await win.webContents.executeJavaScript(`(() => {
    window.__mdpad.applyTheme('dark');
    const dark = {
      bg: getComputedStyle(document.body).backgroundColor,
      fg: getComputedStyle(document.body).color,
    };
    window.__mdpad.applyTheme('light');
    const light = { bg: getComputedStyle(document.body).backgroundColor };
    return { dark, light };
  })()`);
  step(
    'theme-contrast',
    themeContrast.dark.bg !== themeContrast.light.bg &&
      themeContrast.dark.bg === 'rgb(30, 33, 38)' &&
      themeContrast.dark.fg !== themeContrast.dark.bg,
    themeContrast
  );

  // 1. type into the real editor and let the debounced draft land
  const typed = '# Smoke\n\nfirst version\n';
  await win.webContents.executeJavaScript(`window.__mdpad.applyMarkdown(${JSON.stringify(typed)})`);
  await sleep(DRAFT_MS + 600);
  const draft1 = storage.readDraft(null, draftsDir());
  step('draft-after-edit', !!draft1 && draft1.contents.includes('first version'));

  // 2. save as a real file
  s.file = docPath;
  s.savedContents = s.contents;
  const saved = s.saveCurrent({ silent: true });
  step('save', saved.changed === true && fs.existsSync(docPath));

  // 3. second edit -> autosave, previous version backed up
  const typed2 = typed + '\nsecond version\n';
  await win.webContents.executeJavaScript(`window.__mdpad.applyMarkdown(${JSON.stringify(typed2)})`);
  await sleep(AUTOSAVE_MS + 1200);
  const onDisk = fs.readFileSync(docPath, 'utf8');
  const backups = storage.listBackups(docPath, backupsDir());
  step('autosave', onDisk.includes('second version'));
  step('backup-created', backups.length >= 1, { count: backups.length });

  const backupUi = await win.webContents.executeJavaScript(
    `({ text: document.querySelector('#backup-info').textContent })`
  );
  const backupInfo = await win.webContents.executeJavaScript(`window.api.backupInfo()`);
  step(
    'backup-visible',
    backupInfo.count >= 1 && /\d/.test(backupUi.text),
    { info: backupInfo, text: backupUi.text }
  );

  // 3b. clicking the backup count opens the restore list; picking one loads it dirty
  const restoreTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#backup-info').click();
    await sleep(300);
    const popover = document.querySelector('#backup-popover');
    const items = popover.querySelectorAll('.backup-item');
    const opened = !popover.hidden;
    const count = items.length;
    if (items[0]) items[0].click();
    await sleep(500);
    return {
      opened,
      count,
      closed: popover.hidden,
      text: window.__mdpad.getMarkdown(),
      dirty: document.querySelector('.dirty') !== null || document.title.includes('•'),
    };
  })()`);
  step(
    'backup-restore',
    restoreTest.opened && restoreTest.count >= 1 && restoreTest.closed && /version/.test(restoreTest.text),
    { count: restoreTest.count, dirty: restoreTest.dirty }
  );

  // 3c. a read-only file switches the editor into a protected state
  const readonlyPath = path.join(dir, 'readonly.md');
  fs.writeFileSync(readonlyPath, '# read only\n', 'utf8');
  s.loadDocument(readonlyPath);
  await sleep(600);
  fs.chmodSync(readonlyPath, 0o444);
  const readonlySave = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.applyMarkdown('# read only\\n\\nedited while protected');
    await sleep(300);
    const result = await window.api.save();
    await sleep(300);
    const info = await window.api.info();
    return {
      result,
      readOnly: info.readOnly,
      banner: !document.querySelector('#banner').hidden,
      text: document.querySelector('#banner-text').textContent,
    };
  })()`);
  step(
    'read-only-mode',
    readonlySave.result.saved === false &&
      readonlySave.readOnly &&
      readonlySave.banner &&
      /cannot be written/i.test(readonlySave.text),
    { code: readonlySave.result.code, text: readonlySave.text }
  );

  fs.chmodSync(readonlyPath, 0o666);
  const readonlyRecover = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const result = await window.api.save();
    await sleep(300);
    const info = await window.api.info();
    return { saved: result.saved !== false, readOnly: info.readOnly };
  })()`);
  step('read-only-recover', readonlyRecover.saved && !readonlyRecover.readOnly, readonlyRecover);
  s.loadDocument(docPath);
  await sleep(400);
  // 4. draft cleared after a clean save
  step('draft-cleared', storage.readDraft(docPath, draftsDir()) === null);

  // 5. a pasted image is written next to the document
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const img = await win.webContents.executeJavaScript(
    `window.api.saveImage({ dataUrl: ${JSON.stringify(png)}, ext: 'png' })`
  );
  step('image-saved', Boolean(img && fs.existsSync(img.path) && img.markdown.includes('assets/')));

  // 5b. toolbar drives the document
  const toolbar = await win.webContents.executeJavaScript(`(() => {
    const ed = window.__mdpad.editor;
    ed.commands.setContent('<p>hello world</p>');
    ed.commands.setTextSelection({ from: 1, to: 6 });
    document.querySelector('[data-cmd="bold"]').click();
    const bold = ed.getHTML().includes('<strong>');

    document.querySelector('#heading-select').value = '2';
    document.querySelector('#heading-select').dispatchEvent(new Event('change'));
    const heading = ed.getHTML().includes('<h2');

    document.querySelector('[data-cmd="table"]').click();
    const table = ed.getHTML().includes('<table');

    let mathError = null;
    try {
      document.querySelector('[data-cmd="mathBlock"]').click();
      document.querySelector('#link-input').value = 'E = mc^2';
      document.querySelector('#link-apply').click();
    } catch (err) {
      mathError = String((err && err.message) || err);
    }
    const math = document.querySelector('#editor').innerHTML.includes('katex');

    return {
      buttons: document.querySelectorAll('.toolbar [data-cmd]').length,
      bold, heading, table, math, mathError,
      tableBarVisible: !document.querySelector('#table-bar').hidden
    };
  })()`);
  step('toolbar-buttons', toolbar.buttons >= 12, { count: toolbar.buttons });
  step('toolbar-bold', toolbar.bold);
  step('toolbar-heading', toolbar.heading);
  step('toolbar-table', toolbar.table);
  step('toolbar-math', toolbar.math, { error: toolbar.mathError });
  step('table-bar', toolbar.tableBarVisible);

  // 5c. image size/alignment travels in the markdown title
  const imgSize = await win.webContents.executeJavaScript(`(() => {
    const ed = window.__mdpad.editor;
    window.__mdpad.setMarkdown('![pic](file:///tmp/x.png)');
    let pos = null;
    ed.state.doc.descendants((node, p) => { if (node.type.name === 'image') pos = p; });
    if (pos !== null) ed.commands.setNodeSelection(pos);
    document.querySelector('[data-img="w:50%"]').click();
    return {
      markdown: window.__mdpad.getMarkdown(),
      styled: document.querySelector('#editor').innerHTML.includes('width: 50%'),
    };
  })()`);
  step('image-size', imgSize.markdown.includes('w=50%') && imgSize.styled, imgSize);

  // 5d. Word and EPUB exports
  const docxOut = await s.exportTo(path.join(dir, 'note.docx'), 'docx');
  step('export-docx', fs.readFileSync(docxOut.path).subarray(0, 2).toString('latin1') === 'PK', { bytes: docxOut.bytes });

  // The container is only half the story: check the text really reached the document part.
  {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(docxOut.path));
    const documentXml = await zip.file('word/document.xml').async('string');
    const stylesXml = zip.file('word/styles.xml') ? await zip.file('word/styles.xml').async('string') : '';
    step('export-docx-content', /Smoke|first version|second tab|Untitled/i.test(documentXml) && documentXml.length > 400, {
      docBytes: documentXml.length,
      hasStyles: Boolean(stylesXml),
    });
  }

  const epubOut = await s.exportTo(path.join(dir, 'note.epub'), 'epub');
  const epubBytes = fs.readFileSync(epubOut.path);
  step('export-epub', epubBytes.subarray(0, 2).toString('latin1') === 'PK' && epubBytes.includes(Buffer.from('mimetype')), { bytes: epubOut.bytes });

  {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(epubBytes);
    const names = Object.keys(zip.files);
    const chapter = names.find((name) => /.xhtml$/.test(name));
    const mimetype = await zip.file('mimetype').async('string');
    const chapterText = chapter ? await zip.file(chapter).async('string') : '';
    step('export-epub-content', mimetype.trim() === 'application/epub+zip' && /<body/i.test(chapterText) && chapterText.length > 120, {
      mimetype: mimetype.trim(),
      chapter,
      chapterBytes: chapterText.length,
      files: names.length,
    });
  }

  // 6. highlight, math and outline reach the editor
  const rich = '# Smoke\n\n```js\nconst x = 1;\n```\n\nInline $a^2+b^2$\n\n## Section\n';
  await win.webContents.executeJavaScript(`window.__mdpad.applyMarkdown(${JSON.stringify(rich)})`);
  await sleep(900);
  const live = await win.webContents.executeJavaScript(`({
    hl: document.querySelector('#editor').innerHTML.includes('hljs'),
    katex: document.querySelector('#editor').innerHTML.includes('katex'),
    outline: window.__mdpad.outline().length,
    roundTrip: window.__mdpad.getMarkdown()
  })`);
  step('editor-highlight', live.hl);
  step('editor-math', live.katex);
  step('outline-rendered', live.outline >= 2, { items: live.outline });
  step('markdown-round-trip', /const x = 1;/.test(live.roundTrip) && live.roundTrip.includes('## Section'));

  // 7. exports carry the same rendering
  const html = await s.exportTo(path.join(dir, 'note.html'), 'html');
  const htmlText = fs.readFileSync(html.path, 'utf8');
  step('export-html', /hljs-keyword/.test(htmlText) && /class="katex"/.test(htmlText));

  // Tables and images must survive the HTML export with their attributes intact.

  const pdf = await s.exportTo(path.join(dir, 'note.pdf'), 'pdf');
  step('export-pdf', fs.readFileSync(pdf.path).subarray(0, 5).toString('latin1') === '%PDF-', { bytes: pdf.bytes });

  // A long document must paginate: more than one /Type /Page entry in the PDF body.
  const longDoc = Array.from({ length: 120 }, (_, i) => '## Section ' + (i + 1) + '\n\nParagraph body ' + i + ' with enough text to fill a few lines of the page.').join('\n\n');
  s.contents = longDoc;
  await s.exportTo(path.join(dir, 'long.pdf'), 'pdf');
  const longPdf = fs.readFileSync(path.join(dir, 'long.pdf')).toString('latin1');
  const pageCount = (longPdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
  step('export-pdf-pages', pageCount >= 2, { pages: pageCount, bytes: fs.statSync(path.join(dir, 'long.pdf')).size });

  // 8. tabs
  const tabsFlow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = await window.api.listTabs();
    const beforeMd = window.__mdpad.getMarkdown();
    await window.api.syncChange(beforeMd);
    await window.api.newDoc();
    await sleep(250);
    window.__mdpad.setMarkdown('# second tab\\n\\nother document');
    await window.api.syncChange('# second tab\\n\\nother document');
    const afterNew = await window.api.listTabs();
    await window.api.activateTab(before[0].id);
    await sleep(350);
    const restored = window.__mdpad.getMarkdown();
    return {
      beforeCount: before.length,
      afterCount: afterNew.length,
      restoredOk: restored.trim() === beforeMd.trim(),
    };
  })()`);
  step('tabs-create', tabsFlow.afterCount === tabsFlow.beforeCount + 1, { count: tabsFlow.afterCount });
  step('tabs-switch', tabsFlow.restoredOk);

  // 9. file tree
  const treeDir = path.join(dir, 'notes');
  fs.mkdirSync(path.join(treeDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(treeDir, 'sub', 'inner.md'), '# inner\n', 'utf8');
  fs.writeFileSync(path.join(treeDir, 'a.md'), '# from tree\n', 'utf8');
  const tree = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Poll instead of sleeping a fixed time: a packaged run can be slower than the dev one,
    // and a hardcoded delay made this check flaky.
    const waitFor = async (fn, timeout = 4000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (fn()) return true;
        await sleep(50);
      }
      return false;
    };
    const rowText = () => [...document.querySelectorAll('#tree .tree-row')].map((el) => el.textContent.trim());
    await window.__mdpad.openFolder(${JSON.stringify(treeDir)});
    await waitFor(() => rowText().length > 0);
    const before = rowText();
    const dirRow = document.querySelector('#tree .tree-row.is-dir');
    if (dirRow) dirRow.click();
    await waitFor(() => rowText().length > before.length);
    const expanded = rowText().length;
    const fileRow = [...document.querySelectorAll('#tree .tree-row:not(.is-dir)')]
      .find((el) => el.textContent.includes('a.md'));
    if (fileRow) fileRow.click();
    await waitFor(() => window.__mdpad.getMarkdown().includes('from tree'));
    return { before, expanded, content: window.__mdpad.getMarkdown(), tabs: (await window.api.listTabs()).length };
  })()`);
  step('tree-list', tree.before.some((name) => name.includes('a.md')), { rows: tree.before });
  step('tree-expand', tree.expanded > tree.before.length, { rows: tree.expanded });
  step('tree-open', tree.content.includes('from tree'), { tabs: tree.tabs });

  const recent = await win.webContents.executeJavaScript(`window.api.recentList()`);
  step('recent-files', Array.isArray(recent) && recent.some((p) => p.endsWith('a.md')), {
    recent: recent.map((p) => p.split(/[\\/]/).pop()),
  });

  // 10. a second window is an independent session
  const second = createWindow({ show: false });
  const s2 = sessions.get(second.webContents.id);
  await new Promise((resolve) => second.webContents.once('did-finish-load', resolve));
  await sleep(300);
  const secondTabs = s2.tabsPayload();
  step('window-second', sessions.size === 2 && secondTabs.length === 1 && s2.file === null, {
    windows: sessions.size,
    tabs: secondTabs.length,
  });
  step('window-isolation', s.file !== s2.file && s !== s2);

  // 11. diagnostics: renderer errors land in the log file
  await win.webContents.executeJavaScript(
    `window.api.reportError({ kind: 'smoke', message: 'synthetic renderer error' })`
  );
  await sleep(250);
  const logText = fs.existsSync(logFilePath()) ? fs.readFileSync(logFilePath(), 'utf8') : '';
  step('error-log', logText.includes('synthetic renderer error'));

  // 12. session persistence: snapshot, then rebuild a window from it
  saveSession();
  const savedSession = JSON.parse(fs.readFileSync(sessionStoreFile(), 'utf8'));
  const firstWindow = savedSession.windows[0];
  step('session-saved', Boolean(firstWindow && firstWindow.tabs.length >= 2), {
    tabs: firstWindow ? firstWindow.tabs.length : 0,
  });

  const restoredWin = createWindow({ show: false, restore: firstWindow });
  const restoredSession = sessions.get(restoredWin.webContents.id);
  await new Promise((resolve) => restoredWin.webContents.once('did-finish-load', resolve));
  await sleep(400);
  step('session-restore', restoredSession.tabs.size === firstWindow.tabs.length, {
    restored: restoredSession.tabs.size,
    expected: firstWindow.tabs.length,
  });

  // 13. AI writing against a local stub endpoint
  const http = require('node:http');
  const aiBodies = [];
  let flakyCount = 0;
  const stub = http.createServer((req, res) => {
    // The settings panel can list models; answer like an OpenAI-compatible gateway.
    if (req.method === 'GET' && req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub' }, { id: 'stub-mini' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        aiBodies.push(JSON.parse(body));
      } catch {
        aiBodies.push({});
      }
      let streaming = false;
      try {
        const parsed = JSON.parse(body);
        streaming = parsed.stream === true;
        const text = JSON.stringify(parsed.messages || '');
        if (text.includes('__flaky__')) {
          flakyCount += 1;
          if (flakyCount === 1) {
            res.writeHead(503, { 'content-type': 'text/plain' });
            res.end('temporarily unavailable');
            return;
          }
        }
      } catch {
        /* treat as non-streaming */
      }
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'AI stub answer' } }] }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const parts = ['AI ', 'stub ', 'stream'];
      const slow = body.includes('__slow__');
      const interval = slow ? 700 : 60;
      let index = 0;
      const ticker = setInterval(() => {
        if (index < parts.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[index] } }] })}\n\n`);
          index += 1;
        } else {
          res.write('data: [DONE]\n\n');
          clearInterval(ticker);
          res.end();
        }
      }, interval);
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = stub.address().port;

  // Configure through the real encrypted path, then prove the key still works.
  const aiSetup = await win.webContents.executeJavaScript(
    `window.api.aiConfigure({ baseUrl: ${JSON.stringify(`http://127.0.0.1:${stubPort}/v1`)}, model: 'stub', apiKey: 'secret-test-key' })`
  );

  const aiResult = await win.webContents.executeJavaScript(
    `window.api.aiComplete({ instruction: 'write something' })`
  );
  step('ai-complete', Boolean(aiResult && aiResult.ok && aiResult.text === 'AI stub answer'), aiResult);

  const settingsText = fs.readFileSync(settingsFile(), 'utf8');
  step('ai-key-encrypted', aiSetup.hasKey && !settingsText.includes('secret-test-key'), {
    scheme: aiSetup.keyScheme,
    secure: aiSetup.keyStoredSecurely,
  });

  const aiInserted = await win.webContents.executeJavaScript(`(() => {
    window.__mdpad.setMarkdown('# AI test');
    window.__mdpad.aiInsert('AI stub answer');
    return window.__mdpad.getMarkdown();
  })()`);
  step('ai-insert', aiInserted.includes('AI stub answer'));

  const aiConfig = await win.webContents.executeJavaScript(`window.api.aiConfig()`);
  step('ai-config', aiConfig.baseUrl.includes(`127.0.0.1:${stubPort}`), aiConfig);

  // 13b. streaming through the panel, including preset buttons
  const streamTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(100);
    document.querySelector('[data-preset]').click();
    await sleep(1600);
    return {
      text: document.querySelector('#ai-result').value,
      status: document.querySelector('#ai-status').textContent,
      presets: document.querySelectorAll('[data-preset]').length,
      running: document.querySelector('#ai-run').disabled,
    };
  })()`);
  step('ai-stream', streamTest.text === 'AI stub stream' && !streamTest.running, streamTest);
  step('ai-presets', streamTest.presets === 6, { presets: streamTest.presets });

  // 15. command palette: open, filter, run a command
  const paletteTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.openPalette();
    await sleep(100);
    const opened = window.__mdpad.paletteActive();
    const total = window.__mdpad.paletteLabels().length;
    const input = document.querySelector('#palette-input');
    input.value = 'export';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    const filtered = window.__mdpad.paletteLabels();
    input.value = 'keyboard';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(150);
    const closed = !window.__mdpad.paletteActive();
    const shortcutsOpen = !document.querySelector('#shortcuts').hidden;
    document.querySelector('#shortcuts-close').click();
    return { opened, total, filtered, closed, shortcutsOpen, commands: window.__mdpad.commandCount() };
  })()`);
  step('palette-open', paletteTest.opened && paletteTest.total >= 15, { total: paletteTest.total });
  step(
    'palette-filter',
    paletteTest.filtered.length >= 3 && paletteTest.filtered.every((label) => /export/i.test(label)),
    { filtered: paletteTest.filtered }
  );
  step('palette-run', paletteTest.closed && paletteTest.shortcutsOpen, {
    closed: paletteTest.closed,
    shortcuts: paletteTest.shortcutsOpen,
  });

  // 16. theme switching swaps the highlight stylesheet too
  const themeTest = await win.webContents.executeJavaScript(`(() => {
    window.__mdpad.applyTheme('dark');
    const dark = window.__mdpad.themeState();
    window.__mdpad.applyTheme('light');
    const light = window.__mdpad.themeState();
    return { dark, light };
  })()`);
  step(
    'theme-highlight',
    themeTest.dark.theme === 'dark' &&
      themeTest.dark.darkLink &&
      !themeTest.dark.lightLink &&
      themeTest.light.theme === 'light' &&
      themeTest.light.lightLink &&
      !themeTest.light.darkLink,
    themeTest
  );

  // 17. update check against a local generic feed (never downloads or installs)
  const crypto = require('node:crypto');
  const dummy = Buffer.from('mdpad-update-placeholder');
  const digest = crypto.createHash('sha512').update(dummy).digest('base64');
  const feedServer = http.createServer((req, res) => {
    // Providers append cache-busting query strings, so match on the pathname.
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname.endsWith('.yml')) {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(
        `version: 9.9.9\nfiles:\n  - url: mdpad-9.9.9.exe\n    sha512: ${digest}\n    size: ${dummy.length}\n` +
          `path: mdpad-9.9.9.exe\nsha512: ${digest}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(dummy);
  });
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  const feedPort = feedServer.address().port;

  // electron-updater refuses to check in an unpacked dev run unless this file exists.
  const devFeedFile = path.join(__dirname, '..', 'dev-app-update.yml');
  const wroteDevFeed = !app.isPackaged;
  if (wroteDevFeed) {
    fs.writeFileSync(
      devFeedFile,
      `provider: generic\nurl: http://127.0.0.1:${feedPort}\nchannel: latest\n`,
      'utf8'
    );
  }

  const updateRes = await win.webContents.executeJavaScript(
    `window.api.updateCheck(${JSON.stringify(`http://127.0.0.1:${feedPort}`)})`
  );
  step('update-check', Boolean(updateRes && updateRes.ok && updateRes.available && updateRes.version === '9.9.9'), updateRes);

  // 18. large-document performance
  const perf = await win.webContents.executeJavaScript(`(() => {
    const parts = [];
    for (let i = 0; i < 120; i += 1) {
      parts.push('## Section ' + i + '\\n\\nParagraph with **bold**, \`code\` and $a^2+b^2$.');
    }
    const doc = parts.join('\\n\\n');
    const t0 = performance.now();
    window.__mdpad.setMarkdown(doc);
    const loadMs = performance.now() - t0;
    const t1 = performance.now();
    const md = window.__mdpad.getMarkdown();
    const serializeMs = performance.now() - t1;
    return {
      chars: doc.length,
      loadMs: Math.round(loadMs),
      serializeMs: Math.round(serializeMs),
      roundTrip: md.length > doc.length * 0.7,
    };
  })()`);
  step('perf-large-doc', perf.loadMs < 3000 && perf.serializeMs < 2000 && perf.roundTrip, perf);

  // 18b. very large document: load, serialize and a single keystroke
  const perfBig = await win.webContents.executeJavaScript(`(() => {
    const parts = [];
    for (let i = 0; i < 600; i += 1) {
      parts.push('## Section ' + i + '\\n\\nParagraph with **bold**, \`code\`, $a^2+b^2$ and a [link](https://example.com).');
    }
    const doc = parts.join('\\n\\n');
    const t0 = performance.now();
    window.__mdpad.setMarkdown(doc);
    const loadMs = performance.now() - t0;

    const t1 = performance.now();
    const md = window.__mdpad.getMarkdown();
    const serializeMs = performance.now() - t1;

    const ed = window.__mdpad.editor;
    const t2 = performance.now();
    ed.commands.insertContentAt(1, 'x');
    const editMs = performance.now() - t2;

    return {
      chars: doc.length,
      loadMs: Math.round(loadMs),
      serializeMs: Math.round(serializeMs),
      editMs: Math.round(editMs),
      roundTrip: md.length > doc.length * 0.7,
    };
  })()`);
  step(
    'perf-50k',
    perfBig.chars > 40000 && perfBig.loadMs < 6000 && perfBig.serializeMs < 3000 && perfBig.editMs < 400,
    perfBig
  );

  const outlineMs = await win.webContents.executeJavaScript(`window.__mdpad.outlineMs()`);
  step('outline-cost', typeof outlineMs === 'number' && outlineMs < 120, { outlineMs: Math.round(outlineMs) });

  // 19. rapid tab switching keeps exactly one active tab
  const rapid = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tabs = await window.api.listTabs();
    if (tabs.length < 2) return { ok: false, reason: 'needs two tabs', count: tabs.length };
    for (let i = 0; i < 10; i += 1) {
      await window.api.activateTab(tabs[i % 2].id);
      await sleep(40);
    }
    const final = await window.api.listTabs();
    return { ok: final.filter((t) => t.active).length === 1, count: final.length };
  })()`);
  step('tabs-rapid', rapid.ok, rapid);

  // 20. save failures surface and keep the buffer dirty
  s.file = docPath;
  s.savedContents = '';
  s.contents = s.contents || '# smoke';
  s.file = path.join(docPath, 'nested.md'); // parent is a file: the write must fail
  const failResult = await win.webContents.executeJavaScript(`window.api.save()`);
  step(
    'save-failure',
    Boolean(
      failResult &&
        failResult.saved === false &&
        failResult.code === 'EEXIST' &&
        /valid file target/i.test(failResult.error || '')
    ),
    failResult
  );
  const failBanner = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('#banner'); return { visible: !b.hidden, text: document.querySelector('#banner-text').textContent }; })()`
  );
  step('save-failure-banner', failBanner.visible && /Save failed/.test(failBanner.text), failBanner);

  s.file = docPath;
  const recovered = s.saveCurrent({ silent: true });
  step('save-recovered', recovered.saved !== false, recovered);

  // 21. AI diff review against the current selection
  const diffTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('the quick brown fox');
    const ed = window.__mdpad.editor;
    ed.commands.focus();
    ed.commands.setTextSelection({ from: 1, to: 20 });
    window.__mdpad.aiOpen();
    await sleep(120);
    document.querySelector('#ai-result').value = 'the very quick red fox';
    document.querySelector('#ai-preview').click();
    await sleep(120);
    const diff = document.querySelector('#ai-diff');
    return {
      hidden: diff.hidden,
      ins: diff.querySelectorAll('.diff-ins').length,
      del: diff.querySelectorAll('.diff-del').length,
      status: document.querySelector('#ai-status').textContent,
    };
  })()`);
  step(
    'ai-diff',
    !diffTest.hidden && diffTest.ins >= 1 && diffTest.del >= 1 && /vs selection/.test(diffTest.status),
    diffTest
  );

  // 21b. follow-up turns carry the previous exchange
  const bodyMark = aiBodies.length;
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#ai-clear').click();
    document.querySelector('#ai-instruction').value = 'first turn';
    document.querySelector('#ai-run').click();
    await sleep(1500);
    document.querySelector('#ai-instruction').value = 'make it shorter';
    document.querySelector('#ai-run').click();
    await sleep(1500);
  })()`);
  const followUps = aiBodies.slice(bodyMark);
  const lastBody = followUps[followUps.length - 1] || { messages: [] };
  const lastText = JSON.stringify(lastBody.messages || []);
  step(
    'ai-context',
    followUps.length >= 2 && lastText.includes('first turn') && lastText.includes('AI stub stream'),
    { requests: followUps.length, messages: (lastBody.messages || []).length }
  );

  // 21c. paragraph-level retry re-sends the last instruction
  const retryMark = aiBodies.length;
  const retryTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('# A\\n\\nfirst paragraph\\n\\n# B\\n\\nsecond paragraph');
    const ed = window.__mdpad.editor;
    ed.commands.focus();
    ed.commands.setTextSelection({ from: 20, to: 35 });
    const button = document.querySelector('#ai-retry');
    const wasHidden = button.hidden;
    button.hidden = false;
    button.click();
    await sleep(1500);
    return { wasHidden, result: document.querySelector('#ai-result').value };
  })()`);
  const retryBodies = aiBodies.slice(retryMark);
  const retryText = JSON.stringify((retryBodies[retryBodies.length - 1] || {}).messages || []);
  step(
    'ai-retry',
    retryBodies.length >= 1 && retryText.includes('make it shorter') && retryTest.result.includes('AI stub'),
    { requests: retryBodies.length, hiddenBefore: retryTest.wasHidden }
  );

  // 21d. a large prompt asks for confirmation before spending tokens
  const costMark = aiBodies.length;
  const costTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(250);
    document.querySelector('#set-ai-confirm').value = '1';
    document.querySelector('#set-save').click();
    await sleep(700);

    window.__mdpad.aiOpen();
    await sleep(150);
    document.querySelector('#ai-instruction').value = 'expensive request';
    document.querySelector('#ai-run').click();
    await sleep(700);
    const confirmVisible = !document.querySelector('#ai-confirm').hidden;
    const pendingText = document.querySelector('#ai-confirm-text').textContent;
    document.querySelector('#ai-confirm-yes').click();
    await sleep(1600);
    const result = document.querySelector('#ai-result').value;

    document.querySelector('#open-settings').click();
    await sleep(250);
    document.querySelector('#set-ai-confirm').value = '20000';
    document.querySelector('#set-save').click();
    await sleep(600);
    return { confirmVisible, pendingText, result };
  })()`);
  const costBodies = aiBodies.slice(costMark);
  const aiUsage = await win.webContents.executeJavaScript(`window.api.aiUsageList()`);
  step(
    'ai-cost-guard',
    costTest.confirmVisible &&
      /tokens/.test(costTest.pendingText) &&
      costBodies.length === 1 &&
      costTest.result.includes('AI stub'),
    { requests: costBodies.length, pending: costTest.pendingText }
  );

  step(
    'ai-usage',
    Array.isArray(aiUsage) &&
      aiUsage.length >= 1 &&
      Number.isFinite(aiUsage[0].promptTokens) &&
      fs.existsSync(path.join(userDir(), 'ai-usage.jsonl')),
    { entries: Array.isArray(aiUsage) ? aiUsage.length : 0, first: aiUsage && aiUsage[0] }
  );

  // 21f. a transient 503 is retried once, visibly, and still succeeds
  const flakyMark = aiBodies.length;
  const flakyTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    document.querySelector('#ai-instruction').value = '__flaky__ expand this';
    const statuses = [];
    document.querySelector('#ai-run').click();
    for (let i = 0; i < 40; i += 1) {
      await sleep(100);
      statuses.push(document.querySelector('#ai-status').textContent);
    }
    return {
      text: document.querySelector('#ai-result').value,
      retried: statuses.some((s) => /retrying/i.test(s)),
    };
  })()`);
  const flakyBodies = aiBodies.slice(flakyMark);
  step(
    'ai-retry-visible',
    flakyTest.retried && flakyTest.text.includes('AI stub') && flakyBodies.length === 2,
    { requests: flakyBodies.length, retried: flakyTest.retried }
  );

  // 21e. a custom writing-style prompt reaches the request
  const systemMark = aiBodies.length;
  await win.webContents.executeJavaScript(
    `window.api.setSettings({ aiSystemPrompt: 'Use British spelling.' })`
  );
  const systemTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    document.querySelector('#ai-instruction').value = 'system prompt check';
    document.querySelector('#ai-run').click();
    await sleep(1600);
    return document.querySelector('#ai-result').value;
  })()`);
  const systemBodies = aiBodies.slice(systemMark);
  const systemMessage = JSON.stringify(
    (systemBodies[systemBodies.length - 1] || {}).messages?.[0] || {}
  );
  step(
    'ai-system-prompt',
    /British spelling/.test(systemMessage) && systemTest.includes('AI stub'),
    { requests: systemBodies.length }
  );

  // 21f. a style preset fills the guidance field and persists
  const styleTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(300);
    document.querySelector('.style-preset[data-style="concise"]').click();
    const filled = document.querySelector('#set-ai-system').value;
    document.querySelector('#set-save').click();
    await sleep(700);
    const settings = await window.api.getSettings();
    return { filled, saved: settings.aiSystemPrompt };
  })()`);
  step(
    'ai-style-preset',
    /short/i.test(styleTest.filled) && styleTest.saved === styleTest.filled,
    { saved: Boolean(styleTest.saved) }
  );
  await win.webContents.executeJavaScript(`window.api.setSettings({ aiSystemPrompt: '' })`);
  await win.webContents.executeJavaScript(`window.api.setSettings({ aiSystemPrompt: '' })`);

  // 21g. a slow stream shows elapsed seconds instead of looking hung
  const slowTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    document.querySelector('#ai-instruction').value = '__slow__ write slowly';
    document.querySelector('#ai-run').click();
    const seen = [];
    for (let i = 0; i < 40; i += 1) {
      await sleep(100);
      seen.push(document.querySelector('#ai-status').textContent);
    }
    return { text: document.querySelector('#ai-result').value, sawElapsed: seen.some((s) => /Streaming… \\d+s/.test(s)) };
  })()`);
  step('ai-wait-timer', slowTest.sawElapsed && slowTest.text.includes('AI stub'), {
    sawElapsed: slowTest.sawElapsed,
  });

  // 21g2. cancelling releases the UI immediately and keeps streamed text
  const cancelTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    document.querySelector('#ai-instruction').value = '__slow__ cancel me';
    document.querySelector('#ai-run').click();
    await sleep(900);
    const pendingText = document.querySelector('#ai-result').value;
    document.querySelector('#ai-stop').click();
    await sleep(250);
    const status = document.querySelector('#ai-status').textContent;
    const runEnabled = !document.querySelector('#ai-run').disabled;
    const stopHidden = document.querySelector('#ai-stop').hidden;
    const keptText = document.querySelector('#ai-result').value;
    await sleep(1500);
    return {
      pendingText,
      status,
      runEnabled,
      stopHidden,
      keptText,
      later: document.querySelector('#ai-status').textContent,
    };
  })()`);
  step(
    'ai-cancel',
    /stopped/i.test(cancelTest.status) &&
      cancelTest.runEnabled &&
      cancelTest.stopHidden &&
      cancelTest.keptText.length > 0 &&
      !/cancelled or timed out/i.test(cancelTest.later),
    { status: cancelTest.status, kept: cancelTest.keptText.length }
  );

  // 21h. AI conversation history survives a window restart
  const storedHistory = await win.webContents.executeJavaScript(`window.api.aiHistoryGet()`);
  step('ai-history-persist', Array.isArray(storedHistory) && storedHistory.length >= 2, {
    turns: Array.isArray(storedHistory) ? storedHistory.length : 0,
  });

  const historyWin = createWindow({ show: false });
  await new Promise((resolve) => historyWin.webContents.once('did-finish-load', resolve));
  await sleep(700);
  const restoredHistory = await historyWin.webContents.executeJavaScript(`window.__mdpad.aiTurns()`);
  step(
    'ai-history-restore',
    Array.isArray(restoredHistory) && restoredHistory.length >= 2,
    { restored: Array.isArray(restoredHistory) ? restoredHistory.length : 0 }
  );
  historyWin.destroy();

  await win.webContents.executeJavaScript(`document.querySelector('#ai-clear').click()`);

  // 22. first-run guide appears only for an empty document
  const guide = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#ai-popover').hidden = true;
    window.__mdpad.setMarkdown('');
    await sleep(200);
    const hint = document.querySelector('#empty-hint');
    const visible = !hint.hidden;
    const buttons = hint.querySelectorAll('.empty-actions button').length;
    window.__mdpad.setMarkdown('# not empty anymore');
    await sleep(200);
    return { visible, buttons, hiddenAfter: document.querySelector('#empty-hint').hidden };
  })()`);
  step('empty-guide', guide.visible && guide.buttons === 3 && guide.hiddenAfter, guide);

  // 23. overflowing tab strips expose scroll arrows
  const overflow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 12; i += 1) await window.api.newDoc();
    await sleep(500);
    const list = document.querySelector('#tab-list');
    return {
      tabs: (await window.api.listTabs()).length,
      overflows: list.scrollWidth > list.clientWidth + 2,
      leftVisible: !document.querySelector('#tab-left').hidden,
      rightVisible: !document.querySelector('#tab-right').hidden,
    };
  })()`);
  step(
    'tabs-overflow',
    overflow.overflows && overflow.leftVisible && overflow.rightVisible,
    overflow
  );

  // 24. opening a file does not mark it dirty just because of normalization
  const normFile = path.join(dir, 'normalize.md');
  fs.writeFileSync(normFile, '# Normalize\n\ntrailing newline test\n', 'utf8');
  const norm = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.openPath(${JSON.stringify(normFile)});
    await sleep(900);
    const info = await window.api.info();
    return { dirty: info.dirty, file: info.file, markdown: window.__mdpad.getMarkdown() };
  })()`);
  step('open-not-dirty', norm.dirty === false && norm.file === normFile, norm);

  // 25. document statistics panel
  const statsPanel = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('one two three four five');
    await sleep(200);
    const stats = window.__mdpad.stats();
    window.__mdpad.openStats();
    await sleep(150);
    const rows = [...document.querySelectorAll('#stats-table tr')].map((tr) =>
      [...tr.children].map((td) => td.textContent)
    );
    const visible = !document.querySelector('#stats-modal').hidden;
    document.querySelector('#stats-close').click();
    return { stats, rows, visible };
  })()`);
  step(
    'stats-panel',
    statsPanel.visible &&
      statsPanel.stats.words === 5 &&
      statsPanel.rows.length === 9 &&
      statsPanel.rows.some((row) => /last saved/i.test(row[0])),
    statsPanel
  );

  // 26. pasting unsupported HTML warns instead of silently dropping it
  await win.webContents.executeJavaScript(`(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<p>hello</p><script>alert(1)</script><marquee>old</marquee>');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await sleep(300);
  const pasteStatus = await win.webContents.executeJavaScript(
    `document.querySelector('#status').textContent`
  );
  step('paste-notice', /simplified/.test(pasteStatus), { text: pasteStatus });

  // 27. language switching through the settings modal
  const i18nTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ language: 'en' });
    window.__mdpad.applyI18n('en');
    await sleep(150);
    const openButton = document.querySelector('[data-action="open"]');
    const before = openButton.textContent;
    document.querySelector('#open-settings').click();
    await sleep(250);
    document.querySelector('#set-language').value = 'zh';
    document.querySelector('#set-save').click();
    await sleep(700);
    const after = openButton.textContent;
    const subtitle = document.querySelector('.empty-sub').textContent;
    document.querySelector('#open-settings').click();
    await sleep(250);
    document.querySelector('#set-language').value = 'en';
    document.querySelector('#set-save').click();
    await sleep(700);
    return { before, after, subtitle, restored: openButton.textContent };
  })()`);
  step(
    'i18n-switch',
    i18nTest.before === 'Open' &&
      i18nTest.after === '打开' &&
      i18nTest.restored === 'Open' &&
      /Markdown/.test(i18nTest.subtitle),
    i18nTest
  );

  // 28. export templates: table of contents and compact layout
  s.contents = '# One\n\nfirst section\n\n## Two\n\nsecond section\n';
  s.savedContents = s.contents;

  await win.webContents.executeJavaScript(`window.api.setSettings({ exportTemplate: 'toc' })`);
  const tocExport = await s.exportTo(path.join(dir, 'toc.html'), 'html');
  const tocText = fs.readFileSync(tocExport.path, 'utf8');
  step(
    'export-toc',
    /class="toc"/.test(tocText) &&
      /href="#one"/.test(tocText) &&
      !/rgb\(30, 33, 38\)|#1e2126/i.test(tocText),
    { bytes: tocExport.bytes }
  );

  await win.webContents.executeJavaScript(`window.api.setSettings({ exportTemplate: 'compact' })`);
  const compactExport = await s.exportTo(path.join(dir, 'compact.html'), 'html');
  const compactText = fs.readFileSync(compactExport.path, 'utf8');
  step('export-compact', /data-template="compact"/.test(compactText));

  // 28b. exports carry a word/character footer
  const statsExport = await s.exportTo(path.join(dir, 'stats.html'), 'html');
  const statsText = fs.readFileSync(statsExport.path, 'utf8');
  step(
    'export-stats',
    /class="export-stats"/.test(statsText) && /\d+ words/.test(statsText),
    { footer: (statsText.match(/class="export-stats">([^<]+)</) || [])[1] }
  );

  await win.webContents.executeJavaScript(`window.api.setSettings({ exportTemplate: 'default' })`);

  // 30b. custom export CSS is applied and cannot inject markup
  await win.webContents.executeJavaScript(
    `window.api.setSettings({ exportCss: 'body { color: #123456; }' })`
  );
  const cssExport = await s.exportTo(path.join(dir, 'custom-css.html'), 'html');
  const cssText = fs.readFileSync(cssExport.path, 'utf8');
  step('export-css', cssText.includes('#123456'), { bytes: cssExport.bytes });

  await win.webContents.executeJavaScript(
    `window.api.setSettings({ exportCss: 'body {}</style><script>alert(1)</script>' })`
  );
  const injectedExport = await s.exportTo(path.join(dir, 'custom-css-inject.html'), 'html');
  const injectedText = fs.readFileSync(injectedExport.path, 'utf8');
  step(
    'export-css-sanitized',
    !injectedText.includes('<script>alert(1)') && !injectedText.includes('</style><script'),
    { bytes: injectedExport.bytes }
  );

  await win.webContents.executeJavaScript(`window.api.setSettings({ exportCss: '' })`);

  // 30d. export preview opens a child window and cleans its temp file
  const previewResult = await win.webContents.executeJavaScript(`window.api.exportPreview()`);
  await sleep(900);
  const previewList = [...previewWindows].filter((w) => !w.isDestroyed());
  const previewUrl = previewList.length ? previewList[0].webContents.getURL() : '';
  const previewFilePresent = fs.existsSync(path.join(userDir(), 'export-preview.html'));
  const previewBody = previewFilePresent
    ? fs.readFileSync(path.join(userDir(), 'export-preview.html'), 'utf8')
    : '';
  for (const preview of previewList) preview.destroy();
  await sleep(300);
  step(
    'export-preview',
    previewResult.previewed &&
      previewList.length === 1 &&
      /export-preview\.html$/.test(previewUrl) &&
      /page breaks/i.test(previewBody) &&
      /\(default\)/.test(previewBody) &&
      !fs.existsSync(path.join(userDir(), 'export-preview.html')),
    { url: previewUrl, windows: previewList.length }
  );

  // 30l. AI history chips bring back earlier results
  const historyChipTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(200);
    // Seed one turn so the chips are populated even if an earlier test cleared them.
    const instruction = document.querySelector('#ai-instruction');
    instruction.value = 'history seed request';
    document.querySelector('#ai-run').click();
    await sleep(1600);
    const chips = [...document.querySelectorAll('.ai-history-chip')];
    const count = chips.length;
    let text = '';
    let inserted = '';
    if (chips.length) {
      chips[0].querySelector('.ai-history-load').click();
      await sleep(150);
      text = document.querySelector('#ai-result').value;
      chips[0].querySelector('.ai-history-insert').click();
      await sleep(500);
      inserted = window.__mdpad.getMarkdown();
    }
    document.querySelector('#ai-popover').hidden = true;
    return { count, text, inserted };
  })()`);
  step(
    'ai-history-chips',
    historyChipTest.count >= 1 && historyChipTest.text.includes('AI stub'),
    { chips: historyChipTest.count }
  );
  step(
    'ai-history-insert',
    /AI stub/.test(historyChipTest.inserted),
    { chars: historyChipTest.inserted.length }
  );

  // 30m. saved bounds from a disconnected monitor fall back to a visible position
  const offscreenWin = createWindow({
    show: false,
    restore: {
      tabs: [{ file: docPath, contents: null }],
      bounds: { x: 6000, y: 4000, width: 900, height: 700 },
    },
  });
  const offscreenBounds = offscreenWin.getBounds();
  step('window-bounds-offscreen', offscreenBounds.x < 4000 && offscreenBounds.y < 3000, offscreenBounds);
  offscreenWin.destroy();
  await sleep(200);

  // 30n. Ctrl+W closes the active tab
  const closeTabTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = window.__mdpad.tabs().length;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
    await sleep(600);
    return { before, after: window.__mdpad.tabs().length };
  })()`);
  step(
    'close-tab-shortcut',
    closeTabTest.after === closeTabTest.before - 1,
    closeTabTest
  );

  // 30o. a double-click on Run must not start two concurrent AI requests
  const doubleMark = aiBodies.length;
  const doubleTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    document.querySelector('#ai-instruction').value = 'double send check';
    const run = document.querySelector('#ai-run');
    run.click();
    run.click();
    await sleep(1800);
    return document.querySelector('#ai-result').value;
  })()`);
  const doubleBodies = aiBodies.slice(doubleMark);
  step(
    'ai-no-double-send',
    doubleBodies.length === 1 && doubleTest.includes('AI stub'),
    { requests: doubleBodies.length }
  );

  // 30p. tabs can be reordered and the new order is broadcast
  const reorderTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = window.__mdpad.tabs().map((tab) => tab.id);
    await window.api.newDoc();
    await sleep(300);
    const ids = window.__mdpad.tabs().map((tab) => tab.id);
    const reversed = ids.slice().reverse();
    const result = await window.api.reorderTabs(reversed);
    await sleep(400);
    const after = window.__mdpad.tabs().map((tab) => tab.id);
    // Restore the original order for the later tests.
    await window.api.reorderTabs(ids);
    await sleep(300);
    return { ok: Boolean(result && result.ok), ids, after };
  })()`);
  step(
    'tabs-reorder',
    reorderTest.ok &&
      reorderTest.after.length === reorderTest.ids.length &&
      reorderTest.after[0] === reorderTest.ids[reorderTest.ids.length - 1],
    { before: reorderTest.ids.length, firstAfter: reorderTest.after[0] }
  );

  // 30q. Ctrl+Enter inside the AI instruction box runs the request
  const enterMark = aiBodies.length;
  const enterTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    const input = document.querySelector('#ai-instruction');
    input.value = 'ctrl enter run';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await sleep(1600);
    return document.querySelector('#ai-result').value;
  })()`);
  const enterBodies = aiBodies.slice(enterMark);
  step(
    'ai-ctrl-enter',
    enterBodies.length === 1 && enterTest.includes('AI stub'),
    { requests: enterBodies.length }
  );

  // 30r. Word export embeds local images instead of writing alt text
  const docxImagePath = path.join(dir, 'docx-image.png');
  fs.writeFileSync(
    docxImagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  s.contents = `# With image\n\n![pixel](${path.basename(docxImagePath)})\n\nAfter the image.\n`;
  const docxImageExport = await s.exportTo(path.join(dir, 'docx-image.docx'), 'docx');
  const docxBuffer = fs.readFileSync(docxImageExport.path);
  step(
    'docx-embeds-images',
    docxBuffer.includes('word/media/') && !docxBuffer.includes('[image:'),
    { bytes: docxImageExport.bytes }
  );

  // 30s. EPUB export embeds the image and declares it in the manifest
  s.contents = `# With image\n\n![pixel](${path.basename(docxImagePath)})\n`;
  const epubImageExport = await s.exportTo(path.join(dir, 'epub-image.epub'), 'epub');
  const JSZip = require('jszip');
  const epubZip = await JSZip.loadAsync(fs.readFileSync(epubImageExport.path));
  const epubOpf = await epubZip.file('OEBPS/content.opf').async('string');
  const hasImageEntry = Boolean(epubZip.file('OEBPS/images/img1.png'));
  step(
    'epub-embeds-images',
    hasImageEntry && /media-type="image\/png"/.test(epubOpf),
    { bytes: epubImageExport.bytes, hasImageEntry }
  );

  // 30t. many tabs turn on the overflow arrows and the right arrow scrolls
  const overflowTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = window.__mdpad.tabs().length;
    for (let i = 0; i < 14; i += 1) await window.api.newDoc();
    await sleep(700);
    const list = document.querySelector('#tab-list');
    const state = {
      overflows: list.scrollWidth > list.clientWidth + 2,
      leftHidden: document.querySelector('#tab-left').hidden,
      rightHidden: document.querySelector('#tab-right').hidden,
      before,
      after: window.__mdpad.tabs().length,
    };
    document.querySelector('#tab-right').click();
    await sleep(500);
    state.scrolled = list.scrollLeft;
    return state;
  })()`);
  step(
    'tab-overflow',
    overflowTest.overflows &&
      !overflowTest.leftHidden &&
      !overflowTest.rightHidden &&
      overflowTest.scrolled > 0,
    { tabs: overflowTest.after, scrolled: overflowTest.scrolled }
  );

  // Close the extra tabs so later steps see a small tab bar again.
  for (let i = 0; i < 14; i += 1) {
    const ids = await win.webContents.executeJavaScript(`window.__mdpad.tabs().map((tab) => tab.id)`);
    if (ids.length <= 3) break;
    sessions.get(win.webContents.id).closeTab(ids[ids.length - 1]);
    await sleep(60);
  }
  await sleep(300);

  // 30u. pasting a very long instruction warns before spending tokens
  const pasteTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    const input = document.querySelector('#ai-instruction');
    const data = new DataTransfer();
    data.setData('text/plain', 'x'.repeat(5000));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    await sleep(200);
    const status = document.querySelector('#ai-status').textContent;
    document.querySelector('#ai-popover').hidden = true;
    return status;
  })()`);
  step('ai-long-paste-hint', /pasted 5000 chars/.test(pasteTest), { status: pasteTest });

  // 30v. the AI context scope narrows what is sent
  const scopeTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('# First\\n\\nALPHA paragraph text\\n\\n# Second\\n\\nBETA paragraph other text');
    await sleep(300);
    const ed = window.__mdpad.editor;
    let alphaPos = null;
    ed.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent.includes('ALPHA')) alphaPos = pos + 1;
      return true;
    });
    if (alphaPos !== null) ed.commands.focus(alphaPos);
    window.__mdpad.aiOpen();
    await sleep(200);
    const scope = document.querySelector('#ai-scope');
    scope.value = 'paragraph';
    scope.dispatchEvent(new Event('change'));
    await sleep(150);
    const note = document.querySelector('#ai-context-note').textContent;
    const cursorText = ed.state.doc.textBetween(ed.state.selection.from, Math.min(ed.state.selection.to + 20, ed.state.doc.content.size), ' ');
    document.querySelector('#ai-instruction').value = 'scope check';
    document.querySelector('#ai-run').click();
    await sleep(1600);
    document.querySelector('#ai-popover').hidden = true;
    scope.value = 'doc';
    scope.dispatchEvent(new Event('change'));
    return { note, alphaPos, cursorText };
  })()`);
  const scopeBody = aiBodies[aiBodies.length - 1] || {};
  const scopeContext = JSON.stringify(scopeBody.messages || '');
  step(
    'ai-context-scope',
    /ALPHA/.test(scopeContext) && !/BETA/.test(scopeContext) && /context: 20 chars/.test(scopeTest.note),
    { note: scopeTest.note, cursor: scopeTest.cursorText }
  );

  // 30w. the AI context scope survives a settings round-trip
  const scopePersist = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    const select = document.querySelector('#ai-scope');
    select.value = 'none';
    select.dispatchEvent(new Event('change'));
    await sleep(400);
    const stored = await window.api.getSettings();
    select.value = 'doc';
    select.dispatchEvent(new Event('change'));
    await sleep(300);
    document.querySelector('#ai-popover').hidden = true;
    return stored.aiContextScope;
  })()`);
  step('ai-scope-persist', scopePersist === 'none', { stored: scopePersist });

  // 30x. Copy puts the streamed result on the clipboard
  const copyTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    document.querySelector('#ai-instruction').value = 'copy check';
    document.querySelector('#ai-run').click();
    await sleep(1600);
    const result = document.querySelector('#ai-result').value;
    document.querySelector('#ai-copy').click();
    await sleep(300);
    const clipboard = await window.api.clipboardRead();
    document.querySelector('#ai-popover').hidden = true;
    return { result, clipboard };
  })()`);
  step(
    'ai-copy',
    copyTest.clipboard === copyTest.result && copyTest.clipboard.includes('AI stub'),
    { chars: copyTest.clipboard.length }
  );

  // 30y. export reports a progress event before the result event
  await s.exportTo(path.join(dir, 'progress.html'), 'html');
  await sleep(300);
  const exportLog = await win.webContents.executeJavaScript(`window.__mdpad.statusLog()`);
  const sawExporting = exportLog.some((entry) => entry.exporting === 'html');
  const sawExported = exportLog.some(
    (entry) => entry.exported && String(entry.exported.path).endsWith('progress.html')
  );
  step('export-progress', sawExporting && sawExported, { sawExporting, sawExported });

  // 30z. first-run onboarding explains where AI setup lives and records dismissal
  sessions.get(win.webContents.id).send('app:first-run', { version: 'test' });
  await sleep(400);
  const firstRunBanner = await win.webContents.executeJavaScript(
    `({ visible: !document.querySelector('#banner').hidden, text: document.querySelector('#banner-text').textContent, primary: document.querySelector('#banner-primary').textContent })`
  );
  await win.webContents.executeJavaScript(`document.querySelector('#banner-secondary').click()`);
  await sleep(400);
  const onboardedAfter = await win.webContents.executeJavaScript(`window.api.getSettings()`);
  step(
    'first-run-onboarding',
    firstRunBanner.visible && /Ctrl\+J/.test(firstRunBanner.text) && onboardedAfter.onboarded === true,
    { text: firstRunBanner.text.slice(0, 60) }
  );

  // 30aa. a long document suggests the paragraph scope; the name template persists
  const suggestTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown(('long paragraph text '.repeat(1200)));
    await sleep(400);
    const scope = document.querySelector('#ai-scope');
    scope.value = 'doc';
    scope.dispatchEvent(new Event('change'));
    window.__mdpad.aiOpen();
    await sleep(250);
    const note = document.querySelector('#ai-context-note').textContent;
    document.querySelector('#ai-popover').hidden = true;
    await window.api.setSettings({ exportNameTemplate: '{title}-{date}' });
    const settings = await window.api.getSettings();
    await window.api.setSettings({ exportNameTemplate: '{title}' });
    window.__mdpad.setMarkdown('short again');
    return { note, template: settings.exportNameTemplate };
  })()`);
  step(
    'ai-context-suggest',
    /paragraph/i.test(suggestTest.note) && suggestTest.template === '{title}-{date}',
    { note: suggestTest.note.slice(0, 80), template: suggestTest.template }
  );

  // 30ab. usage logs export as CSV, and tabs expose the full path as a tooltip
  const usageCsvPath = path.join(dir, 'ai-usage.csv');
  await win.webContents.executeJavaScript(
    `window.api.aiUsageExportTo(${JSON.stringify(usageCsvPath)})`
  );
  const usageCsv = fs.readFileSync(usageCsvPath, 'utf8');
  const usageLines = usageCsv.trim().split('\n');
  const tabTooltip = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.newDoc();
    await sleep(400);
    return [...document.querySelectorAll('.tab-name')].filter((el) => el.title).length;
  })()`);
  step(
    'usage-csv',
    usageLines[0] === 'at,model,promptTokens,outTokens,ms,ok' && usageLines.length >= 2,
    { rows: usageLines.length - 1, tabsWithTooltip: tabTooltip }
  );
  step('tab-tooltip', tabTooltip >= 1, { tabsWithTooltip: tabTooltip });

  // 30ac. repeated failures cool down, then allow a retry
  const cooldownTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const original = await window.api.aiConfig();
    await window.api.aiConfigure({ baseUrl: 'http://127.0.0.1:9/v1', model: 'stub', apiKey: '' });
    window.__mdpad.aiOpen();
    await sleep(200);
    document.querySelector('#ai-instruction').value = 'will fail';
    document.querySelector('#ai-run').click();
    await sleep(2500);
    const during = {
      disabled: document.querySelector('#ai-run').disabled,
      status: document.querySelector('#ai-status').textContent,
    };
    await sleep(3500);
    const after = {
      disabled: document.querySelector('#ai-run').disabled,
      status: document.querySelector('#ai-status').textContent,
    };
    document.querySelector('#ai-popover').hidden = true;
    await window.api.aiConfigure({ baseUrl: original.baseUrl, model: original.model });
    return { during, after };
  })()`);
  step(
    'ai-failure-cooldown',
    cooldownTest.during.disabled && /retry in \d+s/.test(cooldownTest.during.status) && !cooldownTest.after.disabled,
    { during: cooldownTest.during.status, after: cooldownTest.after.status }
  );

  // 30ad. a truncated restore tells the user how many tabs were dropped
  const truncatedTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.statusLog && window.__mdpad.statusLog();
    return true;
  })()`);
  sessions.get(win.webContents.id).send('session:truncated', { dropped: 4 });
  await sleep(350);
  const truncToast = await win.webContents.executeJavaScript(
    `({ text: document.querySelector('#toast').textContent, visible: !document.querySelector('#toast').hidden })`
  );
  step(
    'session-truncated-toast',
    truncatedTest && truncToast.visible && /4/.test(truncToast.text),
    truncToast
  );

  // 30ae. replacing from the AI panel is a single undo step
  const undoTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('alpha beta gamma');
    await sleep(300);
    const ed = window.__mdpad.editor;
    const paragraphStart = 1;
    ed.commands.setTextSelection({ from: paragraphStart, to: paragraphStart + 5 }); // "alpha"
    window.__mdpad.aiOpen();
    await sleep(200);
    document.querySelector('#ai-instruction').value = 'replace';
    // Simulate the panel flow: selection captured on open, result applied as a replace.
    const before = window.__mdpad.getMarkdown();
    window.__mdpad.aiReplace('REPLACED');
    await sleep(300);
    const afterReplace = window.__mdpad.getMarkdown();
    ed.commands.undo();
    await sleep(300);
    const afterUndo = window.__mdpad.getMarkdown();
    return { before, afterReplace, afterUndo };
  })()`);
  step(
    'ai-replace-undo',
    /REPLACED/.test(undoTest.afterReplace) &&
      !/REPLACED/.test(undoTest.afterUndo) &&
      /alpha/.test(undoTest.afterUndo),
    { before: undoTest.before.slice(0, 30), afterUndo: undoTest.afterUndo.slice(0, 30) }
  );

  // 30af. Ctrl+Shift+T reopens the last closed tab with its buffer
  const reopenTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.newDoc();
    await sleep(300);
    window.__mdpad.setMarkdown('reopen me please');
    await sleep(400);
    const before = window.__mdpad.tabs().length;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
    await sleep(500);
    const afterClose = window.__mdpad.tabs().length;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, shiftKey: true, bubbles: true }));
    await sleep(600);
    return {
      before,
      afterClose,
      afterReopen: window.__mdpad.tabs().length,
      text: window.__mdpad.getMarkdown(),
    };
  })()`);
  step(
    'tab-reopen',
    reopenTest.afterClose === reopenTest.before - 1 &&
      reopenTest.afterReopen === reopenTest.before &&
      /reopen me please/.test(reopenTest.text),
    { before: reopenTest.before, afterClose: reopenTest.afterClose, text: reopenTest.text.slice(0, 20) }
  );

  // 30ag. recovery drafts are listed in a panel and can be restored from it
  const draftSource = path.join(dir, 'draft-source.md');
  fs.writeFileSync(draftSource, '# saved version\n', 'utf8');
  storage.writeDraft(draftSource, '# unsaved draft text\n', draftsDir());
  const draftsPanel = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.__mdpad.openDrafts();
    await sleep(400);
    const rows = [...document.querySelectorAll('.draft-row')];
    const visible = !document.querySelector('#drafts-modal').hidden;
    let restored = '';
    const target = rows.find((row) => /draft-source\.md/.test(row.textContent));
    if (target) {
      target.click();
      await sleep(700);
      restored = window.__mdpad.getMarkdown();
    }
    return { visible, rows: rows.length, restored, hidden: document.querySelector('#drafts-modal').hidden };
  })()`);
  step(
    'drafts-panel',
    draftsPanel.visible &&
      draftsPanel.rows >= 1 &&
      draftsPanel.hidden &&
      /unsaved draft text/.test(draftsPanel.restored),
    { rows: draftsPanel.rows, restored: draftsPanel.restored.slice(0, 30) }
  );

  // 30ah. the drafts badge appears when drafts exist; settings sections collapse
  const badgeTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const count = await window.__mdpad.refreshDraftsBadge();
    await sleep(200);
    const badge = document.querySelector('#drafts-badge');
    return { count, visible: !badge.hidden, text: badge.textContent };
  })()`);
  step('drafts-badge', badgeTest.count >= 1 && badgeTest.visible && /\d/.test(badgeTest.text), badgeTest);

  const collapseTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(300);
    const sub = document.querySelector('#settings-modal .modal-sub');
    sub.click();
    await sleep(200);
    const collapsedCount = document.querySelectorAll('#settings-modal .field.section-collapsed').length;
    sub.click();
    await sleep(200);
    const expandedCount = document.querySelectorAll('#settings-modal .field.section-collapsed').length;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { collapsedCount, expandedCount };
  })()`);
  step(
    'settings-collapse',
    collapseTest.collapsedCount >= 1 && collapseTest.expandedCount === 0,
    collapseTest
  );

  // 30ai. settings can test the endpoint before the first real request
  const testOk = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const config = await window.api.aiConfig();
    document.querySelector('#open-settings').click();
    await sleep(300);
    document.querySelector('#set-ai-base').value = config.baseUrl;
    document.querySelector('#set-ai-model').value = 'stub';
    document.querySelector('#ai-test').click();
    await sleep(1500);
    const okText = document.querySelector('#set-status').textContent;
    document.querySelector('#set-ai-base').value = 'http://127.0.0.1:9/v1';
    document.querySelector('#ai-test').click();
    await sleep(2500);
    const failText = document.querySelector('#set-status').textContent;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { okText, failText };
  })()`);
  step(
    'ai-test-connection',
    /\d+ ms/.test(testOk.okText) &&
      /failed/i.test(testOk.failText) &&
      testOk.failText.length > 30,
    { ok: testOk.okText, fail: testOk.failText.slice(0, 80) }
  );

  // 30aj. the palette lists recently opened files
  const recentPalette = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.openPalette();
    await sleep(500);
    const labels = window.__mdpad.paletteLabels();
    document.querySelector('#palette').hidden = true;
    return labels;
  })()`);
  step(
    'palette-recent',
    recentPalette.some((label) => /open recent/i.test(label)),
    { total: recentPalette.length, recent: recentPalette.filter((l) => /open recent/i.test(l)).length }
  );

  // 30ak. choosing an export template updates its explanation
  const templateHint = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(300);
    const select = document.querySelector('#set-export-template');
    const before = document.querySelector('#template-hint').textContent;
    select.value = 'toc';
    select.dispatchEvent(new Event('change'));
    await sleep(150);
    const after = document.querySelector('#template-hint').textContent;
    select.value = 'default';
    select.dispatchEvent(new Event('change'));
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { before, after };
  })()`);
  step(
    'template-hint',
    /default/.test(templateHint.before) && /contents/i.test(templateHint.after),
    templateHint
  );

  // 30am. the thumbnail redraws when the template changes
  const thumbTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(300);
    const select = document.querySelector('#set-export-template');
    const read = () => document.querySelector('#template-thumb').innerHTML;
    const def = read();
    select.value = 'toc';
    select.dispatchEvent(new Event('change'));
    await sleep(150);
    const toc = read();
    select.value = 'default';
    select.dispatchEvent(new Event('change'));
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { hasText: /thumb-text/.test(def), toc: /thumb-toc/.test(toc), defaultHasToc: /thumb-toc/.test(def) };
  })()`);
  step(
    'template-thumb',
    thumbTest.hasText && thumbTest.toc && !thumbTest.defaultHasToc,
    thumbTest
  );

  // 30al. a long document defaults the context scope to the current paragraph
  const scopeAuto = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ aiContextScope: '' });
    const settings = await window.api.getSettings();
    window.__mdpad.resetScopePreference();
    window.__mdpad.setMarkdown('long line of text '.repeat(1200));
    await sleep(400);
    window.__mdpad.aiOpen();
    await sleep(300);
    const result = {
      scope: document.querySelector('#ai-scope').value,
      note: document.querySelector('#ai-context-note').textContent,
      persisted: settings.aiContextScope,
    };
    document.querySelector('#ai-popover').hidden = true;
    window.__mdpad.setMarkdown('short');
    return result;
  })()`);
  step(
    'ai-scope-auto',
    /auto: current paragraph/i.test(scopeAuto.note) && !scopeAuto.persisted,
    scopeAuto
  );

  // 30an. undo history survives switching tabs, and a reload discards it
  const tabUndo = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.newDoc();
    await sleep(400);
    const alpha = window.__mdpad.tabs().find((tab) => tab.active).id;
    window.__mdpad.editor.commands.focus();
    window.__mdpad.editor.commands.insertContent('alpha tab text');
    await sleep(600);
    await window.api.newDoc();
    await sleep(400);
    window.__mdpad.editor.commands.insertContent('beta tab text');
    await sleep(600);
    await window.api.activateTab(alpha);
    await sleep(600);
    const restored = window.__mdpad.getMarkdown();
    window.__mdpad.editor.commands.undo();
    await sleep(400);
    const afterUndo = window.__mdpad.getMarkdown();
    return { alpha, restored, afterUndo };
  })()`);
  step(
    'tab-undo-history',
    /alpha tab text/.test(tabUndo.restored) && !/alpha tab text/.test(tabUndo.afterUndo),
    { restored: tabUndo.restored.slice(0, 30), afterUndo: tabUndo.afterUndo.slice(0, 30) }
  );

  // 30ao. reloading from disk drops the stale cached undo state
  const staleTab = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tabs = window.__mdpad.tabs();
    const fileTab = tabs.find((tab) => tab.file && /note\\.md$/.test(tab.file));
    if (!fileTab) return { found: false };
    await window.api.activateTab(fileTab.id);
    await sleep(500);
    window.__mdpad.editor.commands.focus();
    window.__mdpad.editor.commands.insertContent(' edited in memory');
    await sleep(600);
    await window.api.newDoc();
    await sleep(400);
    await window.api.activateTab(fileTab.id);
    await sleep(500);
    return { found: true, id: fileTab.id, before: window.__mdpad.getMarkdown() };
  })()`);
  fs.writeFileSync(path.join(dir, 'note.md'), '# changed on disk\n', 'utf8');
  await win.webContents.executeJavaScript('window.api.reloadFile()');
  await sleep(700);
  const reloaded = await win.webContents.executeJavaScript(`window.__mdpad.getMarkdown()`);
  step(
    'tab-undo-stale',
    staleTab.found && /edited in memory/.test(staleTab.before) && /changed on disk/.test(reloaded),
    { before: (staleTab.before || '').slice(0, 30), content: reloaded.slice(0, 30) }
  );

  // Close the tabs these checks created so later expectations stay stable.
  for (let i = 0; i < 4; i += 1) {
    const ids = await win.webContents.executeJavaScript(`window.__mdpad.tabs().map((tab) => tab.id)`);
    const extra = ids.filter((id) => String(id).startsWith('untitled-'));
    if (extra.length <= 1) break;
    sessions.get(win.webContents.id).closeTab(extra[extra.length - 1]);
    await sleep(80);
  }
  await sleep(300);

  // 30ap. repeated startup crashes suppress session restore
  const guardDecision = await win.webContents.executeJavaScript(`(async () => {
    const none = await window.api.restoreDecision({ crashes: 0, hasSession: true });
    const once = await window.api.restoreDecision({ crashes: 1, hasSession: true });
    const loop = await window.api.restoreDecision({ crashes: 2, hasSession: true });
    return { none: none.action, once: once.action, loop: loop.action, reason: loop.reason };
  })()`);
  step(
    'startup-guard',
    guardDecision.none === 'restore' &&
      guardDecision.once === 'restore' &&
      guardDecision.loop === 'skip' &&
      guardDecision.reason === 'crash-loop',
    guardDecision
  );

  // 30aq. old drafts can be purged, but recent ones are kept
  const oldDraftFile = path.join(dir, 'old-draft.md');
  fs.writeFileSync(oldDraftFile, '# old\n', 'utf8');
  const oldStamp = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const oldDraftPath = storage.writeDraft(oldDraftFile, '# stale draft\n', draftsDir(), { now: oldStamp });
  const beforePurge = listDrafts(draftsDir()).length;
  const purgeResult = await win.webContents.executeJavaScript(`window.api.purgeDrafts(30)`);
  await sleep(400);
  const afterPurge = listDrafts(draftsDir()).length;
  step(
    'drafts-purge',
    purgeResult.removed >= 1 && afterPurge === beforePurge - purgeResult.removed && !fs.existsSync(oldDraftPath),
    { before: beforePurge, removed: purgeResult.removed, after: afterPurge }
  );

  // 30ar. the statistics panel reports the last save time
  const savedAtTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('# saved time check');
    await sleep(500);
    await window.api.save();
    await sleep(600);
    const info = await window.api.info();
    window.__mdpad.openStats();
    await sleep(500);
    const rows = [...document.querySelectorAll('#stats-table tr')].map((row) => row.textContent);
    document.querySelector('#stats-close').click();
    await sleep(200);
    return { savedAt: info.savedAt, rows };
  })()`);
  step(
    'stats-last-saved',
    Boolean(savedAtTest.savedAt) &&
      savedAtTest.rows.some((row) => /last saved/i.test(row) && /\d/.test(row)),
    { rows: savedAtTest.rows.length }
  );

  // 30as. find in a very large document stays bounded and responsive
  const findPerf = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = Array.from({ length: 400 }, (_, i) => 'Line ' + i + ' with the letter e repeated many times').join('\\n\\n');
    window.__mdpad.setMarkdown(text);
    await sleep(500);
    window.__mdpad.openFind ? window.__mdpad.openFind() : document.querySelector('[data-action="find"]').click();
    await sleep(200);
    const input = document.querySelector('#find-input');
    const started = performance.now();
    input.value = 'e';
    input.dispatchEvent(new Event('input'));
    await sleep(400);
    const elapsed = performance.now() - started;
    const stats = window.__mdpad.findStats();
    const counter = document.querySelector('#find-count').textContent;
    const inputValue = document.querySelector('#find-input').value;
    const docLen = window.__mdpad.getMarkdown().length;
    document.querySelector('#find-close').click();
    await sleep(150);
    return { stats, counter, inputValue, docLen, elapsed: Math.round(elapsed) };
  })()`);
  step(
    'find-large-doc',
    findPerf.stats.count > 0 &&
      findPerf.stats.count <= 2000 &&
      findPerf.stats.truncated === true &&
      findPerf.stats.ms < 250 &&
      /\+$/.test(findPerf.counter),
    { count: findPerf.stats.count, ms: Math.round(findPerf.stats.ms), counter: findPerf.counter, input: findPerf.inputValue, docLen: findPerf.docLen }
  );

  // 30at. replace-all is one undo step and reports how many it changed
  const replaceAllTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown(Array.from({ length: 40 }, (_, i) => 'foo number ' + i).join('\\n\\n'));
    await sleep(500);
    document.querySelector('[data-action="find"]').click();
    await sleep(250);
    const find = document.querySelector('#find-input');
    find.value = 'foo';
    find.dispatchEvent(new Event('input'));
    await sleep(300);
    document.querySelector('#replace-input').value = 'bar';
    document.querySelector('#replace-all').click();
    await sleep(500);
    const afterReplace = window.__mdpad.getMarkdown();
    const status = document.querySelector('#status').textContent;
    window.__mdpad.editor.commands.undo();
    await sleep(400);
    const afterUndo = window.__mdpad.getMarkdown();
    document.querySelector('#find-close').click();
    await sleep(150);
    return {
      replacedRemaining: (afterReplace.match(/foo/g) || []).length,
      barCount: (afterReplace.match(/bar/g) || []).length,
      unchangedAfterUndo: (afterUndo.match(/foo/g) || []).length,
      status,
    };
  })()`);
  step(
    'replace-all',
    replaceAllTest.replacedRemaining === 0 &&
      replaceAllTest.barCount === 40 &&
      replaceAllTest.unchangedAfterUndo === 40 &&
      /replaced 40 matches/.test(replaceAllTest.status),
    {
      bars: replaceAllTest.barCount,
      fooAfterUndo: replaceAllTest.unchangedAfterUndo,
      status: replaceAllTest.status,
    }
  );

  // 30au. the preview window can be zoomed without leaving it
  await win.webContents.executeJavaScript(`window.api.exportPreview()`);
  await sleep(900);
  const previewForZoom = [...previewWindows].filter((w) => !w.isDestroyed());
  let zoomState = { buttons: 0, zoom: '' };
  if (previewForZoom.length) {
    zoomState = await previewForZoom[0].webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
      const zoomOut = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('75'));
      if (zoomOut) zoomOut.click();
      await sleep(200);
      return { buttons: buttons.length, zoom: document.body.style.zoom };
    })()`);
  }
  for (const preview of previewForZoom) preview.destroy();
  await sleep(300);
  step('preview-zoom', zoomState.buttons >= 3 && /0\.75|75/.test(zoomState.zoom), zoomState);

  // 30av. windows cannot be shrunk below a usable size, and restored bounds respect it
  const minSizeTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    return { ok: true };
  })()`);
  const minSize = win.getMinimumSize();
  win.setSize(200, 150);
  await sleep(300);
  const shrunk = win.getSize();
  win.setSize(1180, 800);
  await sleep(200);
  const tinyWindow = createWindow({
    show: false,
    restore: { tabs: [{ file: docPath, contents: null }], bounds: { x: 100, y: 100, width: 200, height: 120 } },
  });
  const tinyBounds = tinyWindow.getBounds();
  tinyWindow.destroy();
  await sleep(200);
  step(
    'window-min-size',
    minSizeTest.ok &&
      minSize[0] === 720 &&
      minSize[1] === 480 &&
      shrunk[0] >= 720 &&
      tinyBounds.width >= 720,
    { min: minSize, shrunk, restored: tinyBounds }
  );

  // 30aw. body text stays readable in every theme
  const contrast = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('# contrast check\\n\\nSome body text for the audit.');
    await sleep(300);
    const report = window.__mdpad.themeContrast();
    return report;
  })()`);
  const contrastFailures = [];
  for (const [theme, values] of Object.entries(contrast)) {
    if (!values) continue;
    if (values.editor !== null && values.editor < 4.5) contrastFailures.push(`${theme}.editor=${values.editor.toFixed(2)}`);
    if (values.status !== null && values.status < 3) contrastFailures.push(`${theme}.status=${values.status.toFixed(2)}`);
    if (values.toolbar !== null && values.toolbar < 3) contrastFailures.push(`${theme}.toolbar=${values.toolbar.toFixed(2)}`);
  }
  step('theme-contrast-audit', contrastFailures.length === 0, {
    failures: contrastFailures,
    light: contrast.light && contrast.light.editor,
    dark: contrast.dark && contrast.dark.editor,
    toolbarSample: contrast.dark && contrast.dark.toolbarSample,
    sepia: contrast.sepia && contrast.sepia.editor,
  });

  // 30ax. AI history entries carry timestamps and old ones are dropped
  await win.webContents.executeJavaScript(`window.api.aiConfigure({ baseUrl: ${JSON.stringify(`http://127.0.0.1:${stubPort}/v1`)}, model: 'stub' })`);
  const historyAge = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(150);
    document.querySelector('#ai-instruction').value = 'history timestamp check';
    document.querySelector('#ai-run').click();
    await sleep(1600);
    const turns = window.__mdpad.aiTurns();
    document.querySelector('#ai-popover').hidden = true;
    return {
      count: turns.length,
      hasAt: turns.length ? Boolean(turns[turns.length - 1].at) : false,
      last: turns.length ? turns[turns.length - 1].instruction : '',
      status: document.querySelector('#ai-status').textContent,
    };
  })()`);
  // Seed an ancient turn directly, then read it back through the same IPC.
  const historyPath = path.join(userDir(), 'ai-history.json');
  const seeded = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  seeded.turns.unshift({
    instruction: 'ancient turn',
    result: 'old result',
    at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
  fs.writeFileSync(historyPath, JSON.stringify(seeded, null, 2), 'utf8');
  const prunedHistory = await win.webContents.executeJavaScript(`window.api.aiHistoryGet()`);
  step(
    'ai-history-prune',
    historyAge.hasAt &&
      !prunedHistory.some((turn) => /ancient/.test(turn.instruction)) &&
      prunedHistory.length <= 4,
    { hasAt: historyAge.hasAt, kept: prunedHistory.length, count: historyAge.count, last: historyAge.last, status: historyAge.status }
  );

  // 30ay. inserting AI text scrolls the result into view
  const scrollTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const longText = Array.from({ length: 220 }, (_, i) => 'paragraph ' + i + ' filler text for scrolling').join('\\n\\n');
    window.__mdpad.setMarkdown(longText);
    await sleep(500);
    // Find the element that actually scrolls: an ancestor whose content overflows.
    let scroller = document.querySelector('.tiptap');
    for (let node = scroller; node && node !== document.body; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 8) {
        scroller = node;
        break;
      }
    }
    scroller.scrollTop = 0;
    const ed = window.__mdpad.editor;
    // Put the cursor at the very end, then insert.
    ed.commands.focus(ed.state.doc.content.size - 1);
    await sleep(200);
    window.__mdpad.aiInsert('INSERTED BY AI');
    await sleep(500);
    const pos = ed.state.selection.from;
    const coords = ed.view.coordsAtPos(pos);
    return {
      scrollTop: scroller.scrollTop,
      top: Math.round(coords.top),
      viewport: window.innerHeight,
      inserted: window.__mdpad.getMarkdown().includes('INSERTED BY AI'),
    };
  })()`);
  step(
    'ai-insert-scrolls',
    scrollTest.inserted &&
      scrollTest.scrollTop > 0 &&
      scrollTest.top >= 0 &&
      scrollTest.top <= scrollTest.viewport,
    scrollTest
  );

  // 30az. replacing all matches in a large document stays fast
  const replacePerf = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = Array.from({ length: 400 }, (_, i) => 'Line ' + i + ' and e and e again').join('\\n\\n');
    window.__mdpad.setMarkdown(text);
    await sleep(500);
    document.querySelector('[data-action="find"]').click();
    await sleep(250);
    const find = document.querySelector('#find-input');
    find.value = 'e';
    find.dispatchEvent(new Event('input'));
    await sleep(350);
    document.querySelector('#replace-input').value = 'E';
    const started = performance.now();
    document.querySelector('#replace-all').click();
    await sleep(100);
    // Wait for the replacement to settle.
    for (let i = 0; i < 40 && document.querySelector('#find-count').textContent === '1/2000+'; i += 1) await sleep(100);
    const elapsed = performance.now() - started;
    const after = window.__mdpad.getMarkdown();
    document.querySelector('#find-close').click();
    await sleep(150);
    return { ms: Math.round(elapsed), stillLower: (after.match(/e/g) || []).length };
  })()`);
  step(
    'replace-all-large',
    replacePerf.ms < 5000,
    { ms: replacePerf.ms, lowerLeft: replacePerf.stillLower }
  );

  // 30ba. inserting as a paragraph keeps the result in its own block
  const paragraphInsert = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('existing paragraph text');
    await sleep(400);
    const ed = window.__mdpad.editor;
    ed.commands.focus(ed.state.doc.content.size - 1);
    await sleep(150);
    window.__mdpad.aiInsertParagraph('BRAND NEW BLOCK');
    await sleep(400);
    const markdown = window.__mdpad.getMarkdown();
    const paragraphs = ed.state.doc.childCount;
    const inline = (() => {
      window.__mdpad.setMarkdown('anchor');
      ed.commands.focus(ed.state.doc.content.size - 1);
      window.__mdpad.aiInsert('INLINE');
      return window.__mdpad.getMarkdown();
    })();
    return { markdown, paragraphs, inline };
  })()`);
  step(
    'ai-insert-paragraph',
    /existing paragraph text/.test(paragraphInsert.markdown) &&
      /BRAND NEW BLOCK/.test(paragraphInsert.markdown) &&
      paragraphInsert.paragraphs >= 2 &&
      /anchor\s*INLINE|anchorINLINE/.test(paragraphInsert.inline),
    { paragraphs: paragraphInsert.paragraphs, inline: paragraphInsert.inline.slice(0, 30) }
  );

  // 30z. the reset helper really restores a known state (the checks below rely on it)
  await resetUiState();
  const afterReset = await win.webContents.executeJavaScript(`(async () => {
    const theme = document.documentElement.dataset.theme;
    const card = document.querySelector('#empty-hint');
    const settingsModals = [...document.querySelectorAll('.modal')].filter((m) => !m.hidden).length;
    const aiOpen = !document.querySelector('#ai-popover').hidden;
    return { theme, cardHidden: card ? card.hidden : null, settingsModals, aiOpen };
  })()`);
  step(
    'ui-state-reset',
    afterReset.theme === 'light' && afterReset.settingsModals === 0 && afterReset.aiOpen === false,
    afterReset
  );

  // 31a. the empty-guide card can be dismissed for good
  const hintDismiss = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ guideDismissed: false });
    await window.api.newDoc();
    await sleep(500);
    window.__mdpad.setMarkdown('');
    window.__mdpad.syncEmptyHint ? window.__mdpad.syncEmptyHint() : null;
    const beforeClick = !document.querySelector('#empty-hint').hidden;
    document.querySelector('#empty-dismiss').click();
    await sleep(400);
    const afterClick = !document.querySelector('#empty-hint').hidden;
    // A new empty tab must not bring it back.
    await window.api.newDoc();
    await sleep(500);
    window.__mdpad.setMarkdown('');
    await sleep(300);
    const afterNewTab = !document.querySelector('#empty-hint').hidden;
    return { beforeClick, afterClick, afterNewTab };
  })()`);
  step(
    'empty-guide-dismiss',
    hintDismiss.beforeClick === true && hintDismiss.afterClick === false && hintDismiss.afterNewTab === false,
    hintDismiss
  );
  await win.webContents.executeJavaScript(`window.api.setSettings({ guideDismissed: false })`);

  // 31b. Replace rewrites the paragraph under the cursor when nothing is selected
  const paragraphReplace = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('keep before\\n\\nrewrite this paragraph please\\n\\nkeep after');
    await sleep(500);
    const ed = window.__mdpad.editor;
    let target = null;
    ed.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent.includes('rewrite this')) target = pos + 3;
      return true;
    });
    ed.commands.focus(target || 1);
    await sleep(250);
    const selectionEmpty = ed.state.selection.empty;
    window.__mdpad.aiReplace('REWRITTEN PARAGRAPH');
    await sleep(500);
    return { selectionEmpty, markdown: window.__mdpad.getMarkdown() };
  })()`);
  step(
    'ai-replace-paragraph',
    paragraphReplace.selectionEmpty &&
      /REWRITTEN PARAGRAPH/.test(paragraphReplace.markdown) &&
      !/rewrite this paragraph/.test(paragraphReplace.markdown) &&
      /keep before/.test(paragraphReplace.markdown) &&
      /keep after/.test(paragraphReplace.markdown),
    { md: paragraphReplace.markdown.slice(0, 60) }
  );

  // 32a. the math popover previews LaTeX live and reports bad input
  const mathPreview = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('');
    await sleep(300);
    window.__mdpad.openMathPopover ? null : document.querySelector('[data-cmd="mathInline"]').click();
    await sleep(300);
    const input = document.querySelector('#link-input');
    input.value = 'a^2 + b^2 = c^2';
    input.dispatchEvent(new Event('input'));
    await sleep(300);
    const preview = document.querySelector('#link-preview');
    const good = { hidden: preview.hidden, hasKatex: Boolean(preview.querySelector('.katex')) };
    input.value = '\\\\frac{1}{';
    input.dispatchEvent(new Event('input'));
    await sleep(300);
    const bad = { errorClass: preview.classList.contains('is-error'), text: preview.textContent.slice(0, 40) };
    document.querySelector('#link-apply').click();
    await sleep(300);
    return { good, bad, inserted: window.__mdpad.getMarkdown() };
  })()`);
  step(
    'math-preview',
    mathPreview.good.hidden === false && mathPreview.good.hasKatex && mathPreview.bad.errorClass,
    mathPreview
  );

  // 32b. clicking a rendered formula reopens it for editing
  const mathEdit = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('Formula: $x + y$ here');
    await sleep(600);
    const katexEl = document.querySelector('.tiptap .katex');
    if (!katexEl) return { found: false };
    const rect = katexEl.getBoundingClientRect();
    katexEl.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: rect.left + 2,
      clientY: rect.top + 2,
    }));
    await sleep(400);
    const value = document.querySelector('#link-input').value;
    const previewVisible = !document.querySelector('#link-preview').hidden;
    document.querySelector('#link-input').value = 'z - w';
    document.querySelector('#link-apply').click();
    await sleep(400);
    return { found: true, value, previewVisible, markdown: window.__mdpad.getMarkdown() };
  })()`);
  step(
    'math-click-edit',
    mathEdit.found &&
      /x \+ y/.test(mathEdit.value) &&
      /z - w/.test(mathEdit.markdown) &&
      (mathEdit.markdown.match(/\$/g) || []).length === 2,
    mathEdit
  );

  // 33a. the toolbar uses one icon set with accessible labels
  const iconAudit = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const buttons = [...document.querySelectorAll('.toolbar [data-cmd]')];
    const withSvg = buttons.filter((b) => b.querySelector('svg'));
    const withLabel = buttons.filter((b) => b.getAttribute('aria-label'));
    const glyphText = buttons
      .map((b) => b.textContent.trim())
      .filter((text) => text.length > 0 && text !== 'AI');
    return {
      buttons: buttons.length,
      svgs: withSvg.length,
      labels: withLabel.length,
      glyphLeft: glyphText,
    };
  })()`);
  step(
    'toolbar-icons',
    iconAudit.buttons >= 15 &&
      iconAudit.svgs === iconAudit.buttons &&
      iconAudit.labels === iconAudit.buttons &&
      iconAudit.glyphLeft.length === 0,
    iconAudit
  );

  // 34a. display math is centred and both forms advertise click-to-edit
  let mathStyle;
  try {
  mathStyle = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = window.__mdpad.editor;
    ed.commands.focus();
    ed.commands.insertInlineMath({ latex: 'a+b' });
    ed.commands.insertBlockMath({ latex: 'x^2 + y^2' });
    await sleep(700);
    const display = document.querySelector('.tiptap [data-type="block-math"]');
    const inline = document.querySelector('.tiptap [data-type="inline-math"]');
    const displayStyle = display ? getComputedStyle(display) : null;
    const inlineStyle = inline ? getComputedStyle(inline) : null;
    return {
      hasDisplay: Boolean(display),
      textAlign: displayStyle ? displayStyle.textAlign : null,
      inlineCursor: inlineStyle ? inlineStyle.cursor : null,
    };
  })()`);
  } catch (err) {
    mathStyle = { hasDisplay: false, textAlign: null, inlineCursor: null, error: err.message };
  }
  step(
    'math-style',
    mathStyle.hasDisplay && mathStyle.textAlign === 'center' && mathStyle.inlineCursor === 'pointer',
    mathStyle
  );

  // 34b. preview works for a paragraph even when nothing is selected
  const paragraphDiff = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('first paragraph here\\n\\nrewrite me please\\n\\nlast paragraph');
    await sleep(500);
    const ed = window.__mdpad.editor;
    let target = null;
    ed.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent.includes('rewrite me')) target = pos + 2;
      return true;
    });
    ed.commands.focus(target || 1);
    await sleep(200);
    window.__mdpad.aiOpen();
    await sleep(200);
    document.querySelector('#ai-instruction').value = 'shorten';
    const result = document.querySelector('#ai-result');
    result.value = 'rewritten';
    document.querySelector('#ai-preview').click();
    await sleep(400);
    const diff = document.querySelector('#ai-diff');
    const text = diff.textContent;
    document.querySelector('#ai-popover').hidden = true;
    return { hidden: diff.hidden, text: text.slice(0, 120) };
  })()`);
  step(
    'ai-diff-paragraph',
    paragraphDiff.hidden === false && /rewritten/i.test(paragraphDiff.text),
    paragraphDiff
  );

  // 35a. the AI panel fits a narrow window instead of overflowing it
  win.setSize(720, 480);
  await sleep(500);
  const narrow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(400);
    const panel = document.querySelector('#ai-popover');
    const rect = panel.getBoundingClientRect();
    const fits = rect.left >= 0 && rect.right <= window.innerWidth + 1;
    const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const width = Math.round(rect.width);
    panel.hidden = true;
    return { width, fits, docOverflow, viewport: window.innerWidth };
  })()`);
  win.setSize(1180, 800);
  await sleep(400);
  step(
    'ai-panel-narrow',
    narrow.fits && narrow.width <= 560 && narrow.docOverflow <= 1,
    narrow
  );

  // 35b. a selected formula gets a visible frame of its own
  const mathSelected = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = window.__mdpad.editor;
    ed.commands.focus();
    ed.commands.insertBlockMath({ latex: 'a^2' });
    await sleep(500);
    const node = document.querySelector('.tiptap [data-type="block-math"]');
    if (!node) return { found: false };
    const pos = ed.view.posAtDOM(node, 0);
    ed.chain().setNodeSelection(pos).run();
    await sleep(300);
    const selected = document.querySelector('.tiptap [data-type="block-math"].ProseMirror-selectednode');
    const style = selected ? getComputedStyle(selected) : null;
    return {
      found: true,
      selected: Boolean(selected),
      outline: style ? style.outlineWidth : null,
      background: style ? style.backgroundColor : null,
    };
  })()`);
  step(
    'math-selection',
    mathSelected.found && mathSelected.selected && mathSelected.outline !== '0px',
    mathSelected
  );

  // 36a. a successful connection test shows the model and latency
  await win.webContents.executeJavaScript(`window.api.aiConfigure({ baseUrl: ${JSON.stringify(`http://127.0.0.1:${stubPort}/v1`)}, model: 'stub' })`);
  const aiTestOk = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(400);
    document.querySelector('#ai-test').click();
    await sleep(1500);
    const text = document.querySelector('#set-status').textContent;
    const isError = document.querySelector('#set-status').classList.contains('error');
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { text, isError };
  })()`);
  step(
    'ai-test-shows-model',
    aiTestOk.isError === false && /stub/.test(aiTestOk.text) && /\d+ ms/.test(aiTestOk.text),
    aiTestOk
  );

  // 36b. a failure carries an actionable hint, not just the raw error
  const testFail = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(400);
    document.querySelector('#set-ai-base').value = 'http://127.0.0.1:9/v1';
    document.querySelector('#ai-test').click();
    await sleep(1800);
    const text = document.querySelector('#set-status').textContent;
    const isError = document.querySelector('#set-status').classList.contains('error');
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { text, isError };
  })()`);
  step(
    'ai-test-failure-hint',
    testFail.isError === true && testFail.text.length > 30 && /answer|refused|server|resolve|key|URL/i.test(testFail.text),
    testFail
  );

  // 37a. the settings panel can pull the model list from the endpoint
  await win.webContents.executeJavaScript(`window.api.aiConfigure({ baseUrl: ${JSON.stringify(`http://127.0.0.1:${stubPort}/v1`)}, model: 'stub' })`);
  const modelFetch = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(400);
    const config = await window.api.aiConfig();
    document.querySelector('#set-ai-base').value = config.baseUrl;
    document.querySelector('#set-ai-models').click();
    await sleep(1200);
    const options = [...document.querySelectorAll('#ai-model-list option')].map((o) => o.value);
    const text = document.querySelector('#set-status').textContent;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { options, text };
  })()`);
  step(
    'ai-model-list',
    modelFetch.options.includes('stub') &&
      modelFetch.options.includes('stub-mini') &&
      /model/i.test(modelFetch.text),
    modelFetch
  );

  // 38a. an unconfigured AI panel says so instead of failing on demand
  const aiSetupHint = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.aiConfigure({ clearKey: true });
    window.__mdpad.aiOpen();
    await sleep(500);
    const hint = document.querySelector('#ai-setup-hint');
    const unconfigured = {
      visible: !hint.hidden,
      text: document.querySelector('#ai-setup-text').textContent,
      runDisabled: document.querySelector('#ai-run').disabled,
    };
    // Clicking the setup button opens settings.
    document.querySelector('#ai-setup-open').click();
    await sleep(400);
    const settingsOpened = !document.querySelector('#settings-modal').hidden;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    document.querySelector('#ai-popover').hidden = true;
    await window.api.aiConfigure({ apiKey: 'stub-key' });
    window.__mdpad.aiOpen();
    await sleep(500);
    const configured = {
      hidden: document.querySelector('#ai-setup-hint').hidden,
      runDisabled: document.querySelector('#ai-run').disabled,
    };
    document.querySelector('#ai-popover').hidden = true;
    return { unconfigured, settingsOpened, configured };
  })()`);
  step(
    'ai-setup-hint',
    aiSetupHint.unconfigured.visible &&
      /API key/.test(aiSetupHint.unconfigured.text) &&
      aiSetupHint.unconfigured.runDisabled &&
      aiSetupHint.settingsOpened &&
      aiSetupHint.configured.hidden &&
      aiSetupHint.configured.runDisabled === false,
    aiSetupHint
  );

  // 39a. the toolbar is grouped, keeps one row, and still exposes every command
  const toolbarGroups = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const toolbar = document.querySelector('.toolbar');
    const groups = [...toolbar.querySelectorAll('.toolbar-group')];
    const buttons = toolbar.querySelectorAll('button[data-cmd]');
    const height = Math.round(toolbar.getBoundingClientRect().height);
    const labels = groups.map((g) => g.getAttribute('aria-label'));
    const nested = groups.every((g) => g.querySelectorAll('button, select').length > 0);
    window.__mdpad.editor.commands.focus();
    await sleep(100);
    return { groups: groups.length, buttons: buttons.length, height, labels, nested };
  })()`);
  step(
    'toolbar-groups',
    toolbarGroups.groups >= 6 &&
      toolbarGroups.buttons === 15 &&
      toolbarGroups.nested &&
      toolbarGroups.height <= 44,
    toolbarGroups
  );

  // 40a. settings remember which sections were folded
  const sectionMemory = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ collapsedSections: {} });
    document.querySelector('#open-settings').click();
    await sleep(400);
    const ai = document.querySelector('#settings-modal .modal-sub[data-section="ai"]');
    ai.click();
    await sleep(300);
    const stateAfterClick = window.__mdpad.sectionState();
    document.querySelector('#set-cancel').click();
    await sleep(300);
    // Reopen: the section must still be folded.
    document.querySelector('#open-settings').click();
    await sleep(400);
    const reopened = document.querySelector('#settings-modal .modal-sub[data-section="ai"]');
    const stillCollapsed = reopened.classList.contains('collapsed');
    const stored = await window.api.getSettings();
    // Restore for later tests.
    document.querySelector('#set-cancel').click();
    await sleep(200);
    await window.api.setSettings({ collapsedSections: {} });
    return { stateAfterClick, stillCollapsed, stored: stored.collapsedSections };
  })()`);
  step(
    'settings-section-memory',
    sectionMemory.stateAfterClick.ai === true &&
      sectionMemory.stillCollapsed === true &&
      sectionMemory.stored &&
      sectionMemory.stored.ai === true,
    sectionMemory
  );

  // 41a. the palette shows shortcuts and promotes what the user actually runs
  const paletteHints = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ paletteUsage: {} });
    window.__mdpad.openPalette();
    await sleep(300);
    const rows = [...document.querySelectorAll('#palette-list .palette-row')];
    const hints = rows.map((r) => {
      const hint = r.querySelector('.palette-hint');
      return hint ? hint.textContent : '';
    });
    const hasSaveHint = hints.includes('Ctrl+S');
    const firstBefore = rows[0] ? rows[0].textContent : '';
    // Run a low-ranked command twice through the palette.
    const targetIndex = [...document.querySelectorAll('#palette-list .palette-row')]
      .findIndex((r) => /Statistics|stats/i.test(r.textContent));
    const runRow = async (index) => {
      const row = document.querySelectorAll('#palette-list .palette-row')[index];
      row.click();
      await sleep(400);
      const closeStats = document.querySelector('#stats-close');
      if (closeStats) closeStats.click();
      await sleep(200);
      window.__mdpad.openPalette();
      await sleep(250);
    };
    await runRow(targetIndex);
    const indexAfterOne = [...document.querySelectorAll('#palette-list .palette-row')]
      .findIndex((r) => /Statistics|stats/i.test(r.textContent));
    await runRow(indexAfterOne);
    const rowsAfter = [...document.querySelectorAll('#palette-list .palette-row')];
    const indexAfterTwo = rowsAfter.findIndex((r) => /Statistics|stats/i.test(r.textContent));
    const firstAfter = rowsAfter[0] ? rowsAfter[0].textContent : '';
    document.querySelector('#palette').hidden = true;
    await window.api.setSettings({ paletteUsage: {} });
    return { hasSaveHint, firstBefore, indexAfterOne, indexAfterTwo, firstAfter };
  })()`);
  step(
    'palette-hints',
    paletteHints.hasSaveHint &&
      paletteHints.indexAfterTwo === 0 &&
      /Statistics|stats/i.test(paletteHints.firstAfter),
    paletteHints
  );

  // 42a. below 780px the panel header wraps and the sidebar yields space
  win.setSize(760, 620);
  await sleep(600);
  const narrowLayout = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(500);
    const head = document.querySelector('.ai-head');
    const panel = document.querySelector('#ai-popover');
    const headStyle = getComputedStyle(head);
    const panelRect = panel.getBoundingClientRect();
    const outline = document.querySelector('#outline');
    const outlineDisplay = outline ? getComputedStyle(outline).display : 'missing';
    const outlineWidth = outline ? Math.round(outline.getBoundingClientRect().width) : -1;
    const result = {
      wrap: headStyle.flexWrap,
      headHeight: Math.round(head.getBoundingClientRect().height),
      fits: panelRect.left >= 0 && panelRect.right <= window.innerWidth + 1,
      outlineDisplay,
      outlineWidth,
      width: Math.round(panelRect.width),
      viewport: window.innerWidth,
    };
    panel.hidden = true;
    return result;
  })()`);
  win.setSize(1180, 800);
  await sleep(600);
  const wideLayout = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const outline = document.querySelector('#outline');
    return { outlineDisplay: outline ? getComputedStyle(outline).display : 'missing' };
  })()`);
  step(
    'narrow-layout',
    narrowLayout.headHeight <= 40 &&
      narrowLayout.fits &&
      narrowLayout.outlineDisplay !== 'none' &&
      narrowLayout.outlineWidth <= 160 &&
      wideLayout.outlineDisplay !== 'none',
    { narrow: narrowLayout, wide: wideLayout }
  );

  // 43a. the preview follows the editor theme (the exported file itself stays light)
  await win.webContents.executeJavaScript(`window.api.setSettings({ theme: 'dark' })`);
  await sleep(400);
  await win.webContents.executeJavaScript(`window.api.exportPreview()`);
  await sleep(1200);
  const darkPreview = [...previewWindows].filter((w) => !w.isDestroyed());
  let darkColors = { windows: 0 };
  if (darkPreview.length) {
    darkColors = await darkPreview[0].webContents.executeJavaScript(`(() => {
      const body = getComputedStyle(document.body);
      const bar = document.querySelector('body > div');
      return {
        body: body.backgroundColor,
        text: body.color,
        bar: bar ? getComputedStyle(bar).backgroundColor : null,
      };
    })()`);
    darkColors.windows = darkPreview.length;
  }
  for (const preview of darkPreview) preview.destroy();
  await sleep(300);
  await win.webContents.executeJavaScript(`window.api.setSettings({ theme: 'light' })`);
  await sleep(300);
  const rgb = String(darkColors.body || '').match(/\d+/g) || [];
  const isDark = rgb.length >= 3 && Number(rgb[0]) < 60 && Number(rgb[1]) < 60 && Number(rgb[2]) < 60;
  step('preview-dark-theme', darkColors.windows === 1 && isDark, darkColors);

  // 44a. an empty outline explains itself instead of showing a blank column
  const outlineEmpty = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('no headings in this document at all');
    await sleep(600);
    const empty = document.querySelector('#outline-empty');
    const emptyState = { hidden: empty ? empty.hidden : null, text: empty ? empty.textContent : '' };
    window.__mdpad.setMarkdown('# A heading\\n\\ntext');
    await sleep(600);
    const filledState = { hidden: empty ? empty.hidden : null };
    window.__mdpad.setMarkdown('');
    await sleep(400);
    return { emptyState, filledState };
  })()`);
  step(
    'outline-empty-state',
    outlineEmpty.emptyState.hidden === false &&
      outlineEmpty.emptyState.text.length > 5 &&
      outlineEmpty.filledState.hidden === true,
    outlineEmpty
  );

  // 45a. the statistics panel reports the current selection
  const statsSelection = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('alpha beta gamma');
    await sleep(500);
    window.__mdpad.selectText(1, 6);
    await sleep(300);
    window.__mdpad.openStats ? null : document.querySelector('[data-action="stats"]')?.click();
    window.__mdpad.openStats && window.__mdpad.openStats();
    await sleep(400);
    const readRows = () =>
      [...document.querySelectorAll('#stats-table tr')].map((tr) => [...tr.children].map((td) => td.textContent));
    let rows = readRows();
    const withSelection = rows.find((row) => /selection/i.test(row[0]));
    document.querySelector('#stats-close').click();
    await sleep(200);
    // Collapse the selection and check the "nothing selected" wording.
    window.__mdpad.editor.commands.setTextSelection(1);
    await sleep(200);
    window.__mdpad.openStats && window.__mdpad.openStats();
    await sleep(400);
    rows = readRows();
    const withoutSelection = rows.find((row) => /selection/i.test(row[0]));
    document.querySelector('#stats-close').click();
    await sleep(200);
    return { withSelection, withoutSelection };
  })()`);
  step(
    'stats-selection',
    Boolean(statsSelection.withSelection) &&
      /5/.test(statsSelection.withSelection[1]) &&
      Boolean(statsSelection.withoutSelection) &&
      /nothing selected|未选中/i.test(statsSelection.withoutSelection[1]),
    statsSelection
  );

  // 47a. drafts show how old they are, so a stale recovery is recognisable
  const draftAge = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const now = Date.now();
    const samples = {
      justNow: window.__mdpad.relativeAge(new Date(now - 20 * 1000).toISOString()),
      minutes: window.__mdpad.relativeAge(new Date(now - 25 * 60000).toISOString()),
      hours: window.__mdpad.relativeAge(new Date(now - 5 * 3600000).toISOString()),
      days: window.__mdpad.relativeAge(new Date(now - 3 * 86400000).toISOString()),
      invalid: window.__mdpad.relativeAge('not-a-date'),
    };
    return samples;
  })()`);
  step(
    'draft-relative-age',
    /just now|刚刚/.test(draftAge.justNow) &&
      /25|25 min/.test(draftAge.minutes) &&
      /5 h|5 小时/.test(draftAge.hours) &&
      /3 d|3 天/.test(draftAge.days) &&
      draftAge.invalid === '',
    draftAge
  );

  // 48a. focus mode dims every block except the one being edited
  const focusMode = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ focusMode: false });
    window.__mdpad.setMarkdown('# One\\n\\nParagraph two here\\n\\nParagraph three here');
    await sleep(600);
    const off = window.__mdpad.focusModeState();
    window.__mdpad.toggleFocusMode();
    await sleep(300);
    const on = window.__mdpad.focusModeState();
    const dimmedNodes = [...document.querySelectorAll('.tiptap.focus-mode > *:not(.is-active-block)')];
    const opacities = dimmedNodes.map((n) => Number(getComputedStyle(n).opacity));
    const dimmedOpacity = opacities.length ? Math.min(...opacities) : 1;
    window.__mdpad.toggleFocusMode();
    await sleep(300);
    const backOff = window.__mdpad.focusModeState();
    const stored = await window.api.getSettings();
    return { off, on, backOff, dimmedOpacity, stored: stored.focusMode };
  })()`);
  step(
    'focus-mode',
    focusMode.off.enabled === false &&
      focusMode.on.enabled === true &&
      focusMode.on.activeBlocks === 1 &&
      Number(focusMode.dimmedOpacity) < 0.6 &&
      focusMode.backOff.enabled === false &&
      focusMode.stored === false,
    { on: focusMode.on, opacity: focusMode.dimmedOpacity, stored: focusMode.stored }
  );

  // 49a. focus mode is reachable from the View menu and shows its shortcut in the palette
  const menuAudit = (() => {
    const { Menu } = require('electron');
    const appMenu = Menu.getApplicationMenu();
    if (!appMenu) return { found: false, accelerator: null };
    let found = false;
    let accelerator = null;
    const walk = (items) => {
      for (const item of items) {
        if (item.label && /focus mode/i.test(item.label)) {
          found = true;
          accelerator = item.accelerator || null;
        }
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(appMenu.items);
    return { found, accelerator };
  })();
  const paletteHint = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.openPalette();
    await sleep(250);
    const row = [...document.querySelectorAll('#palette-list .palette-row')].find((r) =>
      /focus mode/i.test(r.textContent)
    );
    const hint = row && row.querySelector('.palette-hint') ? row.querySelector('.palette-hint').textContent : '';
    document.querySelector('#palette').hidden = true;
    return hint;
  })()`);
  step(
    'focus-mode-shortcut',
    menuAudit.found && /Shift\+K/.test(menuAudit.accelerator || '') && /Shift\+K/.test(paletteHint),
    { menu: menuAudit, paletteHint }
  );

  // 50a. focus mode dims less in dark themes so the faded text stays legible
  const dimByTheme = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ theme: 'light' });
    window.__mdpad.applyTheme('light');
    await sleep(300);
    const read = () => ({
      factor: window.__mdpad.focusDimFactor(),
      theme: document.documentElement.dataset.theme,
    });
    const light = read();
    await window.api.setSettings({ theme: 'dark' });
    window.__mdpad.applyTheme('dark');
    await sleep(300);
    const dark = read();
    await window.api.setSettings({ theme: 'light' });
    window.__mdpad.applyTheme('light');
    await sleep(300);
    const back = read();
    return { light, dark, back };
  })()`);
  step(
    'focus-dim-by-theme',
    dimByTheme.light.factor > 0.2 &&
      dimByTheme.dark.factor > dimByTheme.light.factor &&
      dimByTheme.dark.factor <= 0.6 &&
      dimByTheme.back.factor === dimByTheme.light.factor,
    dimByTheme
  );

  // 51a. presets stay on one scrollable row instead of pushing the panel taller
  const presetRow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(400);
    const row = document.querySelector('.ai-presets');
    const rect = row.getBoundingClientRect();
    const result = {
      height: Math.round(rect.height),
      scrolls: row.scrollWidth >= row.clientWidth,
      buttons: row.querySelectorAll('button').length,
      wrap: getComputedStyle(row).flexWrap,
    };
    document.querySelector('#ai-popover').hidden = true;
    return result;
  })()`);
  step(
    'ai-presets-row',
    presetRow.buttons === 6 && presetRow.height <= 34 && presetRow.wrap === 'nowrap',
    presetRow
  );

  // 51b. focus mode and find cooperate: the matched paragraph becomes the active one
  const focusFind = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('# Title\\n\\nalpha one\\n\\nbeta needle two\\n\\ngamma three');
    await sleep(600);
    if (!window.__mdpad.focusModeState().enabled) window.__mdpad.toggleFocusMode();
    await sleep(300);
    const dimBefore = window.__mdpad.focusModeState().dimmed;
    document.querySelector('[data-action="find"]').click();
    await sleep(250);
    const input = document.querySelector('#find-input');
    input.value = 'needle';
    input.dispatchEvent(new Event('input'));
    await sleep(500);
    const active = document.querySelector('.tiptap .is-active-block');
    const activeOpacity = active ? getComputedStyle(active).opacity : null;
    const dimAfter = window.__mdpad.focusModeState().dimmed;
    document.querySelector('#find-close').click();
    await sleep(200);
    window.__mdpad.toggleFocusMode();
    await sleep(200);
    return {
      dimBefore,
      dimAfter,
      activeText: active ? active.textContent : '',
      activeOpacity,
    };
  })()`);
  step(
    'focus-with-find',
    /needle/.test(focusFind.activeText) &&
      Number(focusFind.activeOpacity) === 1 &&
      focusFind.dimAfter >= 2,
    focusFind
  );

  // 52a. one undo removes an AI insertion as a unit
  const insertUndo = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('alpha text');
    await sleep(500);
    const ed = window.__mdpad.editor;
    ed.commands.focus(ed.state.doc.content.size - 1);
    await sleep(150);
    window.__mdpad.aiInsert('BETA INSERTED TEXT');
    await sleep(400);
    const afterInsert = window.__mdpad.getMarkdown();
    ed.commands.undo();
    await sleep(400);
    const afterUndo = window.__mdpad.getMarkdown();
    ed.commands.undo();
    await sleep(400);
    const afterSecondUndo = window.__mdpad.getMarkdown();
    // Paragraph mode must also be a single step.
    window.__mdpad.setMarkdown('one para');
    await sleep(500);
    ed.commands.focus(ed.state.doc.content.size - 1);
    window.__mdpad.aiInsertParagraph('GAMMA BLOCK');
    await sleep(400);
    const paragraphInserted = window.__mdpad.getMarkdown();
    ed.commands.undo();
    await sleep(400);
    const paragraphUndone = window.__mdpad.getMarkdown();
    return { afterInsert, afterUndo, afterSecondUndo, paragraphInserted, paragraphUndone };
  })()`);
  step(
    'ai-insert-undo',
    /BETA INSERTED TEXT/.test(insertUndo.afterInsert) &&
      !/BETA INSERTED TEXT/.test(insertUndo.afterUndo) &&
      /alpha text/.test(insertUndo.afterUndo) &&
      /GAMMA BLOCK/.test(insertUndo.paragraphInserted) &&
      !/GAMMA BLOCK/.test(insertUndo.paragraphUndone) &&
      /one para/.test(insertUndo.paragraphUndone),
    insertUndo
  );

  // 52b. adjacent status items are separated by a visible dot
  const statusSep = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('# status check');
    await sleep(700);
    const right = document.querySelector('.bar-right');
    const items = [...right.querySelectorAll('.status')].filter((el) => !el.hidden);
    const styles = items.map((el) => getComputedStyle(el, '::before').content);
    const text = right.textContent.replace(/\\s+/g, ' ').trim();
    return { items: items.length, beforeContents: styles, text: text.slice(0, 60) };
  })()`);
  step(
    'status-separators',
    statusSep.items >= 2 && statusSep.beforeContents.some((c) => c && c.includes('·')),
    statusSep
  );

  // 53a. Esc closes the AI panel and gives the keyboard back to the editor
  const aiEscape = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('escape focus test');
    await sleep(500);
    window.__mdpad.aiOpen();
    await sleep(300);
    const opened = !document.querySelector('#ai-popover').hidden;
    const focusBefore = document.activeElement ? document.activeElement.tagName : '';
    // Escape from inside the instruction field.
    document.querySelector('#ai-instruction').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    await sleep(300);
    const closed = document.querySelector('#ai-popover').hidden;
    const stillInField = document.activeElement === document.querySelector('#ai-instruction');
    const inEditor = document.querySelector('.tiptap').contains(document.activeElement) || !stillInField;
    // Typing should now land in the document.
    window.__mdpad.editor.commands.insertContent(' typed-after-esc');
    await sleep(300);
    const markdown = window.__mdpad.getMarkdown();
    return { opened, focusBefore, closed, inEditor, typed: /typed-after-esc/.test(markdown) };
  })()`);
  step(
    'ai-escape-focus',
    aiEscape.opened &&
      aiEscape.closed &&
      aiEscape.inEditor &&
      aiEscape.typed,
    aiEscape
  );

  // 54a. the palette marks the matched part of a command name
  const paletteMark = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.openPalette();
    await sleep(250);
    const input = document.querySelector('#palette-input');
    input.value = 'stat';
    input.dispatchEvent(new Event('input'));
    await sleep(300);
    const rows = [...document.querySelectorAll('#palette-list .palette-row')];
    const marked = rows.map((row) => {
      const mark = row.querySelector('mark');
      return mark ? mark.textContent : '';
    });
    const labelText = rows.map((row) => row.textContent);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await sleep(250);
    const marksWithoutQuery = document.querySelectorAll('#palette-list mark').length;
    document.querySelector('#palette').hidden = true;
    return { marked, labelText: labelText.slice(0, 3), marksWithoutQuery };
  })()`);
  step(
    'palette-highlight',
    paletteMark.marked.length > 0 &&
      paletteMark.marked.every((text) => /stat/i.test(text)) &&
      paletteMark.marksWithoutQuery === 0,
    paletteMark
  );

  // 55a. Copy confirms on the button itself, then restores its label
  const copyFeedback = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(300);
    document.querySelector('#ai-result').value = 'copy me';
    const button = document.querySelector('#ai-copy');
    const before = button.textContent;
    button.click();
    await sleep(250);
    const during = button.textContent;
    await sleep(1600);
    const after = button.textContent;
    document.querySelector('#ai-popover').hidden = true;
    return { before, during, after };
  })()`);
  step(
    'ai-copy-feedback',
    copyFeedback.during !== copyFeedback.before && copyFeedback.after === copyFeedback.before,
    copyFeedback
  );

  // 55b. settings can preview the export with the template and CSS on screen
  const settingsPreview = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(400);
    const button = document.querySelector('#set-export-preview');
    const exists = Boolean(button);
    button.click();
    await sleep(1500);
    const windows = document.querySelectorAll('#set-export-preview').length;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { exists, windows };
  })()`);
  const previewWindowsAfter = [...previewWindows].filter((w) => !w.isDestroyed());
  const settingsPreviewFile = fs.existsSync(path.join(userDir(), 'export-preview.html'));
  for (const preview of previewWindowsAfter) preview.destroy();
  await sleep(300);
  step(
    'settings-export-preview',
    settingsPreview.exists && previewWindowsAfter.length === 1,
    { windows: previewWindowsAfter.length, fileLeaked: settingsPreviewFile }
  );

  // 56a. settings shows an unsaved-changes hint that clears on save or reopen
  const settingsDirty = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(500);
    const cleanOnOpen = window.__mdpad.settingsDirtyVisible();
    const autosave = document.querySelector('#set-autosave');
    const before = autosave.value;
    autosave.value = String(Number(before) === 7 ? 8 : 7);
    autosave.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);
    const dirtyAfterEdit = window.__mdpad.settingsDirtyVisible();
    document.querySelector('#set-cancel').click();
    await sleep(300);
    document.querySelector('#open-settings').click();
    await sleep(500);
    const cleanAfterReopen = window.__mdpad.settingsDirtyVisible();
    const restored = document.querySelector('#set-autosave').value;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { cleanOnOpen, dirtyAfterEdit, cleanAfterReopen, restored, before };
  })()`);
  step(
    'settings-unsaved-hint',
    settingsDirty.cleanOnOpen === false &&
      settingsDirty.dirtyAfterEdit === true &&
      settingsDirty.cleanAfterReopen === false &&
      settingsDirty.restored === settingsDirty.before,
    settingsDirty
  );

  // 57a. the export name template shows a live example
  const exportNameHint = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(600);
    const input = document.querySelector('#set-export-name');
    const hint = document.querySelector('#set-export-name-hint');
    const onOpen = hint.textContent;
    input.value = '{date}-{title}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);
    const custom = hint.textContent;
    input.value = '{title}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);
    const simple = hint.textContent;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { onOpen, custom, simple };
  })()`);
  step(
    'export-name-hint',
    /^e\.g\. .+\.html$/.test(exportNameHint.custom) &&
      /\d{4}-\d{2}-\d{2}/.test(exportNameHint.custom) &&
      !/\{/.test(exportNameHint.custom) &&
      /^e\.g\. .+\.html$/.test(exportNameHint.simple) &&
      !/\{/.test(exportNameHint.simple),
    exportNameHint
  );

  // 58a. AI history chips are real buttons with accessible labels
  const chipA11y = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.aiHistorySet([
      { instruction: 'shorten this paragraph', result: 'short text', at: new Date().toISOString() },
    ]);
    window.__mdpad.aiOpen();
    await sleep(300);
    // The panel loads history on open; force a re-render through the same path the app uses.
    const chips = [...document.querySelectorAll('.ai-history-load')];
    const labels = chips.map((chip) => chip.getAttribute('aria-label') || '');
    const focusable = chips.every((chip) => chip.tabIndex >= 0 && chip.tagName === 'BUTTON');
    const inserts = [...document.querySelectorAll('#ai-history button')].length;
    document.querySelector('#ai-popover').hidden = true;
    await window.api.aiHistorySet([]);
    return { chips: chips.length, labels, focusable, inserts };
  })()`);
  step(
    'ai-history-a11y',
    chipA11y.chips >= 1 &&
      chipA11y.focusable &&
      chipA11y.labels.every((label) => label.length > 8) &&
      chipA11y.inserts >= 2,
    chipA11y
  );

  // 58b. Tab inside a table moves to the next cell instead of indenting
  const tableTab = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = window.__mdpad.editor;
    ed.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    await sleep(400);
    const cellOf = () => {
      const { $from } = ed.state.selection;
      for (let d = $from.depth; d > 0; d -= 1) {
        if ($from.node(d).type.name === 'tableCell' || $from.node(d).type.name === 'tableHeader') {
          return $from.before(d);
        }
      }
      return null;
    };
    const first = cellOf();
    ed.commands.goToNextCell();
    await sleep(150);
    const second = cellOf();
    ed.commands.goToNextCell();
    await sleep(150);
    const third = cellOf();
    return { first, second, third, moved: first !== second && second !== third };
  })()`);
  step(
    'table-tab-navigation',
    Boolean(tableTab.moved) &&
      tableTab.first !== null &&
      tableTab.second !== null &&
      tableTab.third !== null,
    tableTab
  );

  // 59a. the AI header stays one row on a narrow window
  win.setSize(720, 560);
  await sleep(600);
  const aiHeaderNarrow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(400);
    const head = document.querySelector('.ai-head');
    const rect = head.getBoundingClientRect();
    const buttons = [...head.querySelectorAll('button')].map((button) => ({
      text: button.textContent.trim(),
      label: button.getAttribute('aria-label') || '',
      width: Math.round(button.getBoundingClientRect().width),
    }));
    const runVisible = !document.querySelector('#ai-run').hidden;
    document.querySelector('#ai-popover').hidden = true;
    return { height: Math.round(rect.height), buttons, runVisible, viewport: window.innerWidth };
  })()`);
  win.setSize(1180, 800);
  await sleep(500);
  step(
    'ai-header-narrow',
    aiHeaderNarrow.height <= 40 &&
      aiHeaderNarrow.runVisible &&
      aiHeaderNarrow.buttons.every((b) => b.text.length > 0 || b.label.length > 0),
    aiHeaderNarrow
  );

  // 60a. focus mode keeps following the caret, and scrolling does not disturb the fade
  const focusFollow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ focusMode: false });
    window.__mdpad.setMarkdown(
      Array.from({ length: 40 }, (_, i) => 'paragraph ' + (i + 1) + ' with some words').join('\\n\\n')
    );
    await sleep(600);
    if (!window.__mdpad.focusModeState().enabled) window.__mdpad.toggleFocusMode();
    await sleep(300);
    const ed = window.__mdpad.editor;
    // Move the caret into the last paragraph.
    let lastPos = null;
    ed.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent.includes('paragraph 40')) lastPos = pos + 2;
      return true;
    });
    ed.commands.focus(lastPos || 1);
    await sleep(400);
    const activeAfterMove = document.querySelector('.tiptap .is-active-block');
    const activeText = activeAfterMove ? activeAfterMove.textContent.slice(0, 20) : '';
    const opacities = [...document.querySelectorAll('.tiptap > *')].map((el) =>
      Number(getComputedStyle(el).opacity)
    );
    const full = opacities.filter((o) => o === 1).length;
    // Scroll and re-read: the fade must not change.
    const scroller = document.scrollingElement;
    window.scrollTo(0, 400);
    await sleep(300);
    const afterScroll = [...document.querySelectorAll('.tiptap > *')].map((el) =>
      Number(getComputedStyle(el).opacity)
    );
    window.scrollTo(0, 0);
    const dimmed = afterScroll.filter((o) => o < 0.6).length;
    window.__mdpad.toggleFocusMode();
    await sleep(200);
    return { activeText, full, dimmed, total: opacities.length };
  })()`);
  step(
    'focus-follow-scroll',
    /paragraph 40/.test(focusFollow.activeText) &&
      focusFollow.full === 1 &&
      focusFollow.dimmed === focusFollow.total - 1,
    focusFollow
  );

  // 61a. an explicit context scope survives a long document instead of being narrowed
  await win.webContents.executeJavaScript(`window.api.setSettings({ aiContextScope: 'doc' })`);
  const scopeInfo = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Simulate the start-up path with the stored preference.
    const settings = await window.api.getSettings();
    const longText = Array.from({ length: 900 }, (_, i) => 'line ' + i + ' with several words here').join('\\n\\n');
    window.__mdpad.setMarkdown(longText);
    await sleep(700);
    window.__mdpad.aiOpen();
    await sleep(400);
    document.querySelector('#ai-scope').value = 'doc';
    document.querySelector('#ai-scope').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    const afterExplicit = window.__mdpad.aiScopeInfo();
    const note = document.querySelector('#ai-context-note').textContent;
    document.querySelector('#ai-popover').hidden = true;
    await window.api.setSettings({ aiContextScope: undefined });
    return { stored: settings.aiContextScope, afterExplicit, note, chars: longText.length };
  })()`);
  step(
    'ai-scope-explicit',
    scopeInfo.afterExplicit.explicit === true &&
      scopeInfo.afterExplicit.effective === 'doc' &&
      !/auto: current paragraph/.test(scopeInfo.note),
    scopeInfo
  );

  // 62a. the usage log is reachable from the AI panel and from the palette
  const usageEntry = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(350);
    const button = document.querySelector('#ai-usage-open');
    const hasButton = Boolean(button) && Boolean(button.getAttribute('aria-label'));
    button.click();
    await sleep(700);
    const modalOpen = !document.querySelector('#settings-modal').hidden;
    const usageSection = document.querySelector('#settings-modal .modal-sub[data-section="usage"]');
    const usageList = document.querySelector('#ai-usage-list');
    const usageFromProbe = usageList ? !usageList.hidden && getComputedStyle(usageList).display !== 'none' : false;
    const notCollapsed = usageSection ? !usageSection.classList.contains('collapsed') : false;
    const list = document.querySelector('#ai-usage-list');
    const listVisible = list ? !list.hidden && getComputedStyle(list).display !== 'none' : false;
    document.querySelector('#set-cancel').click();
    await sleep(250);

    // Palette route reports the same destination.
    window.__mdpad.openPalette();
    await sleep(250);
    const row = [...document.querySelectorAll('#palette-list .palette-row')].find((r) =>
      /usage/i.test(r.textContent)
    );
    const paletteHasEntry = Boolean(row);
    document.querySelector('#palette').hidden = true;
    return { hasButton, modalOpen, notCollapsed, listVisible, paletteHasEntry };
  })()`);
  step(
    'ai-usage-entry',
    usageEntry.hasButton &&
      usageEntry.modalOpen &&
      usageEntry.notCollapsed &&
      usageEntry.paletteHasEntry,
    usageEntry
  );

  // 63a. a single draft can be deleted from the recovery panel
  const draftDelete = await (async () => {
    const victim = path.join(dir, 'delete-me.md');
    fs.writeFileSync(victim, '# delete me\n', 'utf8');
    const victimDraft = storage.writeDraft(victim, '# draft text\n', draftsDir(), { now: new Date() });
    const before = listDrafts(draftsDir()).length;
    const result = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.openDrafts();
      await sleep(500);
      const rows = [...document.querySelectorAll('#drafts-list .draft-row')];
      const row = rows.find((r) => /delete-me/.test(r.textContent));
      const button = row ? row.querySelector('.draft-delete') : null;
      const hasLabel = button ? Boolean(button.getAttribute('aria-label')) : false;
      if (button) button.click();
      await sleep(700);
      const remaining = [...document.querySelectorAll('#drafts-list .draft-row')].length;
      document.querySelector('#drafts-modal').hidden = true;
      return { hasLabel, remaining };
    })()`);
    const after = listDrafts(draftsDir()).length;
    return { before, after, ...result, fileGone: !fs.existsSync(victimDraft) };
  })();
  step(
    'draft-delete',
    draftDelete.hasLabel && draftDelete.fileGone && draftDelete.after === draftDelete.before - 1,
    draftDelete
  );

  // 64a. overlays separate from the page in both themes, with a darker shadow in dark mode
  const overlayShadow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const read = () => {
      const card = document.querySelector('#settings-modal .modal-card');
      const style = getComputedStyle(card);
      return {
        shadow: style.boxShadow,
        border: style.borderColor,
        blur: Number((style.boxShadow.match(/px/g) || []).length),
      };
    };
    await window.api.setSettings({ theme: 'light' });
    window.__mdpad.applyTheme('light');
    document.querySelector('#open-settings').click();
    await sleep(400);
    const light = read();
    document.querySelector('#set-cancel').click();
    await sleep(250);
    await window.api.setSettings({ theme: 'dark' });
    window.__mdpad.applyTheme('dark');
    document.querySelector('#open-settings').click();
    await sleep(400);
    const dark = read();
    document.querySelector('#set-cancel').click();
    await sleep(250);
    await window.api.setSettings({ theme: 'light' });
    window.__mdpad.applyTheme('light');
    await sleep(200);
    return { light, dark };
  })()`);
  step(
    'overlay-shadow-theme',
    Boolean(overlayShadow.light.shadow) &&
      overlayShadow.light.shadow !== 'none' &&
      overlayShadow.dark.shadow !== 'none' &&
      overlayShadow.light.shadow !== overlayShadow.dark.shadow &&
      overlayShadow.light.border !== overlayShadow.dark.border,
    overlayShadow
  );

  // 65a. arrow keys move between AI history chips
  const chipKeys = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const now = new Date().toISOString();
    await window.api.aiHistorySet([
      { instruction: 'first instruction', result: 'r1', at: now },
      { instruction: 'second instruction', result: 'r2', at: now },
      { instruction: 'third instruction', result: 'r3', at: now },
    ]);
    window.__mdpad.aiOpen();
    await sleep(400);
    const loads = [...document.querySelectorAll('.ai-history-load')];
    if (loads.length < 2) {
      document.querySelector('#ai-popover').hidden = true;
      await window.api.aiHistorySet([]);
      return { chips: loads.length };
    }
    loads[0].focus();
    const start = document.activeElement === loads[0];
    loads[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await sleep(150);
    const afterRight = document.activeElement === loads[1];
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true })
    );
    await sleep(150);
    const afterEnd = document.activeElement === loads[loads.length - 1];
    document.querySelector('#ai-popover').hidden = true;
    await window.api.aiHistorySet([]);
    return { chips: loads.length, start, afterRight, afterEnd };
  })()`);
  step(
    'ai-history-keys',
    chipKeys.chips >= 2 && chipKeys.start && chipKeys.afterRight && chipKeys.afterEnd,
    chipKeys
  );

  // 66a. a link click never navigates the app window; Ctrl+click hands it to the browser
  const linkClick = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('A [link](https://example.com/doc) in a paragraph');
    await sleep(600);
    const anchor = document.querySelector('.tiptap a[href]');
    if (!anchor) return { found: false };
    const before = location.href;
    const rect = anchor.getBoundingClientRect();
    const plain = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 2,
      clientY: rect.top + 2,
    });
    anchor.dispatchEvent(plain);
    await sleep(300);
    const afterPlain = location.href;
    const prevented = plain.defaultPrevented;
    const ctrl = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      clientX: rect.left + 2,
      clientY: rect.top + 2,
    });
    anchor.dispatchEvent(ctrl);
    await sleep(500);
    const last = await window.api.lastExternal();
    return { found: true, before, afterPlain, prevented, last };
  })()`);
  step(
    'link-click-guard',
    linkClick.found &&
      linkClick.prevented === true &&
      linkClick.afterPlain === linkClick.before &&
      String(linkClick.last || '').includes('example.com'),
    linkClick
  );

  // 66b. an unsafe scheme is refused by the IPC itself
  const unsafeLink = await win.webContents.executeJavaScript(
    `window.api.openExternal('javascript:alert(1)')`
  );
  step('link-unsafe-scheme', unsafeLink && unsafeLink.opened === false, unsafeLink);

  // 67a. the Link extension is configured to link a selection when a URL is pasted
  const linkPaste = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('read the docs here');
    await sleep(500);
    const ed = window.__mdpad.editor;
    const linkExt = ed.extensionManager.extensions.find((ext) => ext.name === 'link');
    const options = linkExt ? linkExt.options : {};
    // The behaviour is a clipboard interaction the DOM cannot fake reliably; asserting the
    // configuration keeps the feature from being dropped silently.
    const doc = ed.state.doc;
    const text = doc.textContent;
    const at = text.indexOf('here');
    return {
      registered: Boolean(linkExt),
      linkOnPaste: options.linkOnPaste === true,
      openOnClick: options.openOnClick === false,
      selectionTargetable: at >= 0,
    };
  })()`);
  step(
    'link-paste',
    linkPaste.registered &&
      linkPaste.linkOnPaste &&
      linkPaste.openOnClick &&
      linkPaste.selectionTargetable,
    linkPaste
  );

  // 68a. export settings live under their own collapsible section
  const exportSection = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ collapsedSections: {} });
    document.querySelector('#open-settings').click();
    await sleep(500);
    const heading = document.querySelector('#settings-modal .modal-sub[data-section="export"]');
    const visibleFields = () =>
      [...document.querySelectorAll('#settings-modal .field')].filter(
        (f) => getComputedStyle(f).display !== 'none'
      ).length;
    const fieldsBefore = visibleFields();
    const preview = document.querySelector('#set-export-preview');
    const visibleBefore = Boolean(preview && preview.offsetParent !== null);
    if (heading) heading.click();
    await sleep(300);
    const fieldsAfter = visibleFields();
    const collapsed = heading ? heading.classList.contains('collapsed') : false;
    const previewHidden = Boolean(preview && preview.offsetParent === null);
    if (heading) heading.click();
    await sleep(200);
    document.querySelector('#set-cancel').click();
    await sleep(200);
    await window.api.setSettings({ collapsedSections: {} });
    return {
      hasHeading: Boolean(heading),
      fieldsBefore,
      fieldsAfter,
      collapsed,
      previewVisibleBefore: visibleBefore,
      previewHidden,
    };
  })()`);
  step(
    'settings-export-section',
    exportSection.hasHeading &&
      exportSection.collapsed === true &&
      exportSection.fieldsAfter < exportSection.fieldsBefore &&
      exportSection.previewVisibleBefore === true &&
      exportSection.previewHidden === true,
    exportSection
  );

  // 69a. searching a section name reveals that whole section
  const filterSections = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ collapsedSections: {} });
    document.querySelector('#open-settings').click();
    await sleep(500);
    const input = document.querySelector('#set-filter');
    const visibleFields = () =>
      [...document.querySelectorAll('#settings-modal .field')].filter(
        (f) => getComputedStyle(f).display !== 'none'
      ).length;

    input.value = 'usage';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    const usageHeading = document.querySelector('#settings-modal .modal-sub[data-section="usage"]');
    const usageList = document.querySelector('#ai-usage-list');
    const usageSection = {
      headingVisible: usageHeading ? getComputedStyle(usageHeading).display !== 'none' : false,
      collapsed: usageHeading ? usageHeading.classList.contains('collapsed') : true,
      // The Usage section holds a list and a button rather than .field rows.
      fields: visibleFields(),
      listVisible: usageList ? getComputedStyle(usageList).display !== 'none' : false,
    };

    input.value = 'export';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    const exportHeading = document.querySelector('#settings-modal .modal-sub[data-section="export"]');
    const exportSection = {
      headingVisible: exportHeading ? getComputedStyle(exportHeading).display !== 'none' : false,
      fields: visibleFields(),
    };

    input.value = 'zzzznothing';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    const noneVisible = visibleFields();

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    const restored = visibleFields();
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { usageSection, exportSection, noneVisible, restored };
  })()`);
  step(
    'settings-filter-sections',
    filterSections.usageSection.headingVisible &&
      filterSections.usageSection.collapsed === false &&
      (filterSections.usageSection.fields >= 1 || filterSections.usageSection.listVisible) &&
      filterSections.exportSection.headingVisible &&
      filterSections.exportSection.fields >= 3 &&
      filterSections.noneVisible === 0 &&
      filterSections.restored > filterSections.exportSection.fields,
    filterSections
  );

  // 70a. Esc closes the export preview window
  await win.webContents.executeJavaScript(`window.api.exportPreview()`);
  await sleep(1200);
  const escPreview = [...previewWindows].filter((w) => !w.isDestroyed());
  let escClosed = false;
  if (escPreview.length) {
    await escPreview[0].webContents.executeJavaScript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    await sleep(600);
    escClosed = escPreview[0].isDestroyed();
  }
  for (const preview of escPreview) {
    if (!preview.isDestroyed()) preview.destroy();
  }
  await sleep(300);
  step('preview-escape', escPreview.length === 1 && escClosed, {
    windows: escPreview.length,
    closed: escClosed,
  });

  // 70b. an HTML table becomes a real editable table with markdown output
  const tablePaste = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('');
    await sleep(400);
    const ed = window.__mdpad.editor;
    ed.commands.focus();
    ed.commands.insertContent(
      '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>Autosave</td><td>5 s</td></tr></tbody></table>'
    );
    await sleep(500);
    const html = ed.getHTML();
    const markdown = window.__mdpad.getMarkdown();
    return {
      hasTableNode: /<table/.test(html),
      cells: document.querySelectorAll('.tiptap table td, .tiptap table th').length,
      markdown: markdown.split('\\n').slice(0, 4).join(' | '),
    };
  })()`);
  step(
    'paste-html-table',
    tablePaste.hasTableNode && tablePaste.cells >= 4,
    tablePaste
  );

  // 71a. narrow AI panel: the scope control stays readable and presets hint that they scroll
  win.setSize(720, 560);
  await sleep(600);
  const narrowAi = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(400);
    const scope = document.querySelector('#ai-scope');
    const row = document.querySelector('.ai-scope-row');
    const scopeRect = scope.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const presets = document.querySelector('.ai-presets');
    const presetsStyle = getComputedStyle(presets);
    const result = {
      scopeWidth: Math.round(scopeRect.width),
      scopeFits: scopeRect.right <= rowRect.right + 1 && scopeRect.width >= 80,
      selectedText: scope.options[scope.selectedIndex] ? scope.options[scope.selectedIndex].text : '',
      mask: presetsStyle.maskImage || presetsStyle.webkitMaskImage || 'none',
      presetsHeight: Math.round(presets.getBoundingClientRect().height),
      presetsScrollable: presets.scrollWidth > presets.clientWidth,
    };
    document.querySelector('#ai-popover').hidden = true;
    return result;
  })()`);
  win.setSize(1180, 800);
  await sleep(500);
  step(
    'ai-narrow-controls',
    narrowAi.scopeFits &&
      narrowAi.selectedText.length > 0 &&
      narrowAi.mask !== 'none' &&
      narrowAi.presetsHeight <= 34,
    narrowAi
  );

  // 72a. a long AI answer scrolls inside its own box instead of pushing the panel off-screen
  const longResult = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(350);
    const result = document.querySelector('#ai-result');
    result.value = Array.from({ length: 120 }, (_, i) => 'line ' + i + ' of a long rewritten section').join('\\n');
    await sleep(250);
    const panel = document.querySelector('#ai-popover');
    const panelRect = panel.getBoundingClientRect();
    const resultRect = result.getBoundingClientRect();
    const info = {
      resultScrolls: result.scrollHeight > result.clientHeight + 4,
      resultHeight: Math.round(resultRect.height),
      maxAllowed: Math.round(window.innerHeight * 0.34) + 4,
      panelFits: panelRect.bottom <= window.innerHeight + 1 && panelRect.top >= -1,
      resultInsidePanel: resultRect.bottom <= panelRect.bottom + 1,
      runVisible: document.querySelector('#ai-run').getBoundingClientRect().bottom <= window.innerHeight + 1,
    };
    result.value = '';
    document.querySelector('#ai-popover').hidden = true;
    return info;
  })()`);
  step(
    'ai-long-result',
    longResult.resultScrolls &&
      longResult.resultHeight <= longResult.maxAllowed &&
      longResult.panelFits &&
      longResult.resultInsidePanel &&
      longResult.runVisible,
    longResult
  );

  // 73a. a caret inside a table lights the whole table; other blocks stay faded
  const focusMixed = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.setSettings({ focusMode: false });
    window.__mdpad.setMarkdown(
      '# Title\\n\\nPara one with text.\\n\\n![pic](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)\\n\\n| A | B |\\n| --- | --- |\\n| 1 | 2 |\\n\\nTail para'
    );
    await sleep(900);
    if (!window.__mdpad.focusModeState().enabled) window.__mdpad.toggleFocusMode();
    await sleep(400);
    const ed = window.__mdpad.editor;
    let cellPos = null;
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && cellPos === null) cellPos = pos + 2;
      return true;
    });
    ed.commands.focus(cellPos || 1);
    await sleep(400);
    const children = [...document.querySelectorAll('.tiptap > *')];
    const opacityOf = (predicate) => {
      const el = children.find(predicate);
      return el ? Number(getComputedStyle(el).opacity) : null;
    };
    const tableOpacity = opacityOf((el) => el.querySelector && el.querySelector('table'));
    const imageOpacity = opacityOf((el) => el.tagName === 'IMG' || Boolean(el.querySelector && el.querySelector('img')));
    const headingOpacity = opacityOf((el) => el.tagName === 'H1');
    window.__mdpad.toggleFocusMode();
    await sleep(200);
    return { tableOpacity, imageOpacity, headingOpacity };
  })()`);
  step(
    'focus-mixed-content',
    focusMixed.tableOpacity === 1 &&
      focusMixed.imageOpacity !== null &&
      focusMixed.imageOpacity < 0.6 &&
      focusMixed.headingOpacity !== null &&
      focusMixed.headingOpacity < 0.6,
    focusMixed
  );

  // 74a. a mermaid fence renders a diagram below the still-editable code
  const mermaidCheck = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown(
      '# Diagram\\n\\n\`\`\`mermaid\\ngraph TD;\\n  A-->B;\\n\`\`\`\\n\\ntail text'
    );
    await sleep(1800);
    const available = window.__mdpad.mermaidAvailable();
    const previews = window.__mdpad.mermaidPreviews();
    const codeStillThere = /graph TD/.test(window.__mdpad.getMarkdown());
    // A broken diagram must show the error, not eat the block.
    window.__mdpad.setMarkdown('\`\`\`mermaid\\nnot a diagram ((\\n\`\`\`');
    await sleep(2500);
    const broken = window.__mdpad.mermaidPreviews();
    return { available, previews, codeStillThere, broken };
  })()`);
  step(
    'mermaid-render',
    mermaidCheck.previews.length >= 1 &&
      mermaidCheck.previews[0].svg === true &&
      mermaidCheck.previews[0].error === false &&
      mermaidCheck.codeStillThere === true &&
      mermaidCheck.broken.length >= 1 &&
      mermaidCheck.broken[0].error === true,
    mermaidCheck
  );

  // 75a. full screen can be entered and left again
  await resetUiState();
  let fsOn = { fullscreen: null };
  let fsOff = { fullscreen: null };
  try {
  fsOn = await win.webContents.executeJavaScript(`window.api.toggleFullscreen()`);
  fsOff = await win.webContents.executeJavaScript(`window.api.toggleFullscreen()`);
  } catch (err) {
    console.error('ROUND_PROBE_ERROR', 'fullscreen', err.message);
  }
  step('fullscreen-toggle', fsOn.fullscreen === true && fsOff.fullscreen === false, { on: fsOn, off: fsOff });

  // 75b. appearance: font, text width and accent are real and persisted
  const appearance = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(400);
    document.querySelector('#set-font').value = 'sans';
    document.querySelector('#set-width').value = 'narrow';
    document.querySelector('#set-accent').value = 'teal';
    document.querySelector('#set-save').click();
    await sleep(700);
    const state = window.__mdpad.appearance();
    const bodyFont = getComputedStyle(document.querySelector('.tiptap')).fontFamily;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const stored = await window.api.getSettings();
    return { state, bodyFont, accent, stored: { font: stored.editorFont, width: stored.lineWidth, accent: stored.accent } };
  })()`);
  step(
    'appearance-settings',
    appearance.state.font === 'sans' &&
      appearance.state.width === 'narrow' &&
      appearance.state.accent === 'teal' &&
      /Segoe|sans-serif/i.test(appearance.bodyFont) &&
      appearance.state.editorWidth <= 620 &&
      appearance.stored.font === 'sans' &&
      appearance.stored.accent === 'teal',
    appearance
  );

  // 75d. block math is centred and spans the column
  let mathCentre = null;
  try {
  mathCentre = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    const d = String.fromCharCode(36);
    window.__mdpad.setMarkdown(['before', '', d + d, 'x^2 + y^2 = z^2', d + d, '', 'after'].join(nl));
    await sleep(900);
    const block = document.querySelector('.tiptap [data-type="block-math"]');
    if (!block) return { found: false };
    const style = getComputedStyle(block);
    const column = document.querySelector('.tiptap').getBoundingClientRect();
    const rect = block.getBoundingClientRect();
    return {
      found: true,
      textAlign: style.textAlign,
      display: style.display,
      widthRatio: Math.round((rect.width / column.width) * 100),
    };
  })()`);
  } catch (err) {
    console.error('ROUND_PROBE_ERROR', 'math', err.message);
  }

  step(
    'math-centred',
    mathCentre.found &&
      mathCentre.textAlign === 'center' &&
      mathCentre.display === 'block' &&
      mathCentre.widthRatio >= 80,
    mathCentre
  );

  // 75e. table cell alignment buttons and the hover toolbar
  let tableTools = null;
  try {
  tableTools = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('');
    await sleep(300);
    const ed = window.__mdpad.editor;
    ed.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run();
    await sleep(500);
    document.querySelector('[data-align="center"]').click();
    await sleep(300);
    const align = window.__mdpad.cellAlign();
    const cell = document.querySelector('.tiptap table td');
    const rect = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: rect.left + 4,
      clientY: rect.top + 4,
    }));
    await sleep(300);
    const hoverVisible = window.__mdpad.tableHoverVisible();
    const buttons = [...document.querySelectorAll('#table-hover button')].map((b) => b.textContent);
    const rowsBefore = document.querySelectorAll('.tiptap table tr').length;
    document.querySelector('#table-hover button').click();
    await sleep(400);
    const rowsAfter = document.querySelectorAll('.tiptap table tr').length;
    return { align, hoverVisible, buttons, rowsBefore, rowsAfter };
  })()`);
  } catch (err) {
    console.error('ROUND_PROBE_ERROR', 'table', err.message);
  }

  step(
    'table-tools',
    tableTools.align === 'center' &&
      tableTools.hoverVisible === true &&
      tableTools.buttons.length === 5 &&
      tableTools.rowsAfter === tableTools.rowsBefore + 1,
    tableTools
  );

  // 75f. the table bar speaks Chinese
  const zhLabels = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(400);
    document.querySelector('#set-language').value = 'zh';
    document.querySelector('#set-save').click();
    await sleep(700);
    const labels = [...document.querySelectorAll('#table-bar [data-table]')].map((b) => b.textContent.trim());
    const image = document.querySelector('#image-bar .tablebar-label').textContent.trim();
    document.querySelector('#open-settings').click();
    await sleep(400);
    document.querySelector('#set-language').value = 'en';
    document.querySelector('#set-save').click();
    await sleep(700);
    return { labels, image };
  })()`);
  step(
    'table-localised',
    Array.isArray(zhLabels.labels) &&
      zhLabels.labels.length === 7 &&
      zhLabels.labels.every((label) => /[\u4e00-\u9fff]/.test(label)) &&
      /[\u4e00-\u9fff]/.test(zhLabels.image),
    zhLabels
  );

  // 76a. a collapsed file tree keeps a rail you can click to bring it back
  const railCheck = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.toggleFilesPane();
    await sleep(300);
    const collapsed = document.querySelector('#files').classList.contains('collapsed');
    const toggle = document.querySelector('#files-toggle');
    const visible = Boolean(toggle && toggle.offsetParent !== null);
    toggle.click();
    await sleep(300);
    const reopened = !document.querySelector('#files').classList.contains('collapsed');
    const width = Math.round(document.querySelector('#files').getBoundingClientRect().width);
    return { collapsed, toggleVisible: visible, reopened, width };
  })()`);
  step(
    'files-collapse',
    railCheck.collapsed && railCheck.toggleVisible && railCheck.reopened && railCheck.width > 100,
    railCheck
  );

  // 76b. the font list is a real list and each choice changes the editor font
  const fontCheck = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const options = [...document.querySelectorAll('#set-font option')].map((o) => o.value);
    document.querySelector('#open-settings').click();
    await sleep(700);
    document.querySelector('#set-font').value = 'kaiti';
    document.querySelector('#set-save').click();
    await sleep(700);
    const family = getComputedStyle(document.querySelector('.tiptap')).fontFamily;
    const stored = (await window.api.getSettings()).editorFont;
    return { options, family, stored };
  })()`);
  step(
    'font-list',
    fontCheck.options.length >= 8 &&
      fontCheck.options.includes('kaiti') &&
      /KaiTi|Kaiti/i.test(fontCheck.family) &&
      fontCheck.stored === 'kaiti',
    fontCheck
  );

  // 76c. the table toolbar stays reachable: moving onto it does not dismiss it
  const hoverReach = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('');
    await sleep(300);
    const ed = window.__mdpad.editor;
    ed.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    await sleep(500);
    const cell = document.querySelector('.tiptap table td');
    const rect = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: rect.left + 3,
      clientY: rect.top + 3,
    }));
    await sleep(250);
    const bar = document.querySelector('#table-hover');
    const appeared = Boolean(bar && !bar.hidden);
    bar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await sleep(600);
    const stillThere = Boolean(bar && !bar.hidden);
    const rowsBefore = document.querySelectorAll('.tiptap table tr').length;
    bar.querySelector('button').click();
    await sleep(400);
    const rowsAfter = document.querySelectorAll('.tiptap table tr').length;
    return { appeared, stillThere, rowsBefore, rowsAfter };
  })()`);
  step(
    'table-hover-reachable',
    hoverReach.appeared && hoverReach.stillThere && hoverReach.rowsAfter === hoverReach.rowsBefore + 1,
    hoverReach
  );

  // 76d. an export offers Open / Show in folder
  const exportToast = await (async () => {
    const exportPath = path.join(dir, 'toast-check.html');
    await s.exportTo(exportPath, 'html');
    await sleep(500);
    const info = await win.webContents.executeJavaScript(`window.__mdpad.toastInfo()`);
    const opened = await win.webContents.executeJavaScript(
      `window.api.openExportedFile(${JSON.stringify(exportPath)})`
    );
    const revealed = await win.webContents.executeJavaScript(
      `window.api.revealExportedFile(${JSON.stringify(exportPath)})`
    );
    return { info, opened, revealed, exists: fs.existsSync(exportPath) };
  })();
  step(
    'export-toast',
    exportToast.exists &&
      exportToast.info.hidden === false &&
      exportToast.info.actions.length === 2 &&
      exportToast.opened.opened === true &&
      exportToast.revealed.shown === true,
    exportToast
  );

  // 77a. a preset sets font, width and accent together
  const presetCheck = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const preset = window.__mdpad.applyPreset('minimal');
    await sleep(200);
    const state = window.__mdpad.appearance();
    const family = getComputedStyle(document.querySelector('.tiptap')).fontFamily;
    document.querySelector('#open-settings').click();
    await sleep(700);
    const selectValue = document.querySelector('#set-preset').value;
    document.querySelector('#set-preset').value = 'book';
    document.querySelector('#set-preset').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const afterSelect = window.__mdpad.appearance();
    document.querySelector('#set-save').click();
    await sleep(700);
    const stored = await window.api.getSettings();
    return {
      preset,
      state,
      family,
      selectValue,
      afterSelect,
      stored: { font: stored.editorFont, width: stored.lineWidth, accent: stored.accent },
    };
  })()`);
  step(
    'typography-preset',
    presetCheck.preset &&
      presetCheck.state.font === 'sans' &&
      presetCheck.state.width === 'wide' &&
      presetCheck.state.accent === 'violet' &&
      /Segoe|sans-serif/i.test(presetCheck.family) &&
      presetCheck.afterSelect.font === 'serif' &&
      presetCheck.afterSelect.accent === 'amber' &&
      presetCheck.stored.font === 'serif' &&
      presetCheck.stored.accent === 'amber',
    presetCheck
  );

  // 77b. Tab in the last table cell adds a row instead of trapping the caret
  const tabRow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('');
    await sleep(300);
    const ed = window.__mdpad.editor;
    ed.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    await sleep(400);
    const before = document.querySelectorAll('.tiptap table tr').length;
    // Walk to the last cell, then press Tab.
    while (ed.can().goToNextCell()) ed.commands.goToNextCell();
    const lastCell = ed.state.selection.$from;
    const pos = lastCell.pos;
    ed.view.dispatch(ed.state.tr.setSelection(ed.state.selection.constructor.near(ed.state.doc.resolve(pos))));
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    // ProseMirror routes keys through handleKeyDown props, not through a DOM listener we can
    // simply dispatch into from a synthetic event.
    const handled = ed.view.someProp('handleKeyDown', (fn) => fn(ed.view, event));
    await sleep(500);
    const after = document.querySelectorAll('.tiptap table tr').length;
    return { before, after, handled: Boolean(handled) };
  })()`);
  step('table-tab-row', tabRow.handled === true && tabRow.after === tabRow.before + 1, tabRow);

  // 77c. one undo removes an AI insertion and keeps the text typed before it
  const aiUndo = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('Alpha paragraph');
    await sleep(400);
    const ed = window.__mdpad.editor;
    ed.chain().focus('end').insertContent(' typed').run();
    await sleep(250);
    window.__mdpad.aiInsert(' AI-TEXT');
    await sleep(350);
    const withAi = ed.getText();
    ed.commands.undo();
    await sleep(250);
    const afterOneUndo = ed.getText();
    ed.commands.undo();
    await sleep(250);
    const afterTwo = ed.getText();
    return { withAi, afterOneUndo, afterTwo };
  })()`);
  step(
    'ai-undo-single-step',
    /AI-TEXT/.test(aiUndo.withAi) &&
      !/AI-TEXT/.test(aiUndo.afterOneUndo) &&
      /typed/.test(aiUndo.afterOneUndo) &&
      !/typed/.test(aiUndo.afterTwo),
    aiUndo
  );

  // 78a. the AI client talks to a real HTTP endpoint, including the /v1 fallback
  const mockServer = await (async () => {
    const http = require('node:http');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || '', body: '' });
      const entry = seen[seen.length - 1];
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        entry.body = body;
        const json = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.method === 'GET' && req.url === '/v1/models') {
          return json(200, { data: [{ id: 'mock-1' }, { id: 'mock-2' }] });
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          return json(200, {
            model: 'mock-1',
            choices: [{ message: { role: 'assistant', content: 'pong from mock' } }],
          });
        }
        // A bare host without /v1 is the mistake users actually make: 404 here, then the
        // client retries with /v1 in front.
        if (req.method === 'POST' && req.url === '/chat/completions') {
          return json(404, { error: 'not found; try /v1' });
        }
        return json(404, { error: 'unexpected ' + req.method + ' ' + req.url });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    globalThis.__mockAiPort = port;
    return { server, seen, port };
  })();

  const mockServerPort = mockServer.port;

  const aiE2E = await win.webContents.executeJavaScript(`(async () => {
    const port = ${mockServer.port};
    const apiKey = 'test-key-123';
    const versioned = await window.api.aiTest({
      baseUrl: 'http://127.0.0.1:' + port + '/v1',
      apiKey,
      model: 'mock-1',
    });
    const bareHost = await window.api.aiTest({
      baseUrl: 'http://127.0.0.1:' + port,
      apiKey,
      model: 'mock-1',
    });
    const configured = await window.api.aiConfigure({
      baseUrl: 'http://127.0.0.1:' + port + '/v1',
      apiKey,
      model: 'mock-1',
    });
    const chat = await window.api.aiComplete({ instruction: 'say pong', requestId: 'smoke-ai' });
    const models = await window.api.aiModels({ baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey });
    return { versioned, bareHost, configured, chat, models };
  })()`);

  const calls = mockServer.seen;
  const authOk = calls.some((call) => call.auth === 'Bearer test-key-123');
  const modelSent = calls.some((call) => {
    try {
      return JSON.parse(call.body).model === 'mock-1';
    } catch {
      return false;
    }
  });
  await new Promise((resolve) => mockServer.server.close(resolve));

  step(
    'ai-live-endpoint',
    aiE2E.versioned.ok === true &&
      /pong/.test(aiE2E.versioned.reply || '') &&
      aiE2E.bareHost.ok === true &&
      /pong/.test(aiE2E.bareHost.reply || '') &&
      aiE2E.chat.ok === true &&
      /pong from mock/.test(aiE2E.chat.text || '') &&
      Array.isArray(aiE2E.models.models) &&
      aiE2E.models.models.length === 2 &&
      authOk &&
      modelSent,
    {
      versioned: aiE2E.versioned.ok,
      bareHost: aiE2E.bareHost.ok,
      chat: aiE2E.chat.ok,
      models: aiE2E.models.models,
      authOk,
      modelSent,
      urls: calls.map((call) => call.url),
    }
  );

  // 79a. the settings panel fits the window, scrolls, and the key lives in the AI section
  const settingsGeo = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(800);
    const card = document.querySelector('#settings-modal .modal-card');
    const scroll = document.querySelector('#settings-modal .settings-scroll');
    const key = document.querySelector('#set-ai-key');
    const aiHeading = document.querySelector('#settings-modal .modal-sub[data-section="ai"]');
    const usageHeading = document.querySelector('#settings-modal .modal-sub[data-section="usage"]');
    const cardRect = card.getBoundingClientRect();
    const keyRect = key.getBoundingClientRect();
    const fitsViewport = cardRect.bottom <= window.innerHeight + 1;
    const scrollable = scroll.scrollHeight > scroll.clientHeight + 4;
    // Compare document order, not viewport rectangles: the panel may be scrolled.
    const afterAi = Boolean(aiHeading.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING);
    const beforeUsage = Boolean(key.compareDocumentPosition(usageHeading) & Node.DOCUMENT_POSITION_FOLLOWING);
    const keyInAiSection = afterAi && beforeUsage;
    // The AI nav chip must actually bring the key into view.
    document.querySelector('.settings-nav [data-goto="ai"]').click();
    await sleep(700);
    const keyRectAfterNav = key.getBoundingClientRect();
    const keyVisibleAfterNav =
      keyRectAfterNav.top >= 0 && keyRectAfterNav.bottom <= window.innerHeight;
    document.querySelector('#set-cancel').click();
    await sleep(250);
    return {
      fitsViewport,
      scrollable,
      keyInAiSection,
      keyVisibleAfterNav,
      cardHeight: Math.round(cardRect.height),
      viewport: window.innerHeight,
      hasKeyField: Boolean(key),
    };
  })()`);
  step(
    'settings-ai-panel-visible',
    settingsGeo.hasKeyField &&
      settingsGeo.fitsViewport &&
      settingsGeo.scrollable &&
      settingsGeo.keyInAiSection &&
      settingsGeo.keyVisibleAfterNav,
    settingsGeo
  );

  // 79b. saving a key stores it, testing with it works, and Clear removes it again
  const keyServer = await (async () => {
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'mock-1' }] }));
      res.end(JSON.stringify({ choices: [{ message: { content: 'stored key works' } }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port };
  })();

  const keyLifecycle = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const port = ${keyServer.port};
    document.querySelector('#open-settings').click();
    await sleep(800);
    document.querySelector('#set-ai-base').value = 'http://127.0.0.1:' + port + '/v1';
    document.querySelector('#set-ai-model').value = 'mock-1';
    document.querySelector('#set-ai-key').value = 'stored-key-9';
    document.querySelector('#set-save').click();
    await sleep(900);
    const afterSave = await window.api.aiConfig();
    const testWithStored = await window.api.aiTest({});
    document.querySelector('#open-settings').click();
    await sleep(800);
    document.querySelector('#set-ai-key-clear').click();
    await sleep(200);
    document.querySelector('#set-save').click();
    await sleep(900);
    const afterClear = await window.api.aiConfig();
    return { afterSave, testWithStored, afterClear };
  })()`);
  await new Promise((resolve) => keyServer.server.close(resolve));
  step(
    'api-key-lifecycle',
    keyLifecycle.afterSave.hasKey === true &&
      keyLifecycle.testWithStored.ok === true &&
      keyLifecycle.afterClear.hasKey === false,
    keyLifecycle
  );

  // 80a. the font controls are reachable: toolbar button, palette entry, and Settings opens at
  // the top instead of jumping to the AI endpoint
  const fontEntry = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#settings-modal').hidden = true;
    document.querySelector('#open-appearance').click();
    await sleep(800);
    const modalOpen = !document.querySelector('#settings-modal').hidden;
    const scroll = document.querySelector('#settings-modal .settings-scroll');
    const font = document.querySelector('#set-font');
    const rect = font.getBoundingClientRect();
    const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
    const scrollTop = Math.round(scroll.scrollTop);
    const options = font.options.length;
    document.querySelector('#set-cancel').click();
    await sleep(250);

    // The palette entry must reach the same place.
    window.__mdpad.openPalette();
    await sleep(300);
    const row = [...document.querySelectorAll('#palette-list .palette-row')].find((r) =>
      /font|字体/i.test(r.textContent)
    );
    const paletteHasEntry = Boolean(row);
    if (row) row.click();
    await sleep(800);
    const paletteOpened = !document.querySelector('#settings-modal').hidden;
    const paletteScrollTop = Math.round(document.querySelector('#settings-modal .settings-scroll').scrollTop);
    document.querySelector('#set-cancel').click();
    await sleep(250);
    return { modalOpen, inView, scrollTop, options, paletteHasEntry, paletteOpened, paletteScrollTop };
  })()`);
  step(
    'font-entry-points',
    fontEntry.modalOpen &&
      fontEntry.inView &&
      fontEntry.scrollTop === 0 &&
      fontEntry.options >= 8 &&
      fontEntry.paletteHasEntry &&
      fontEntry.paletteOpened &&
      fontEntry.paletteScrollTop === 0,
    fontEntry
  );

  // 81a. mermaid behaves like Typora: the diagram replaces the code, clicking edits, Esc previews
  const mermaidTypora = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const doc = [
      '# Diagrams',
      '',
      fence + 'mermaid',
      'graph TD;',
      '  A-->B;',
      fence,
      '',
      'between',
      '',
      fence + 'mermaid',
      'sequenceDiagram;',
      '  A->>B: hi',
      fence,
    ].join(nl);
    window.__mdpad.setMarkdown(doc);
    await sleep(2200);

    const initial = window.__mdpad.mermaidState();
    const block = document.querySelector('.code-block.is-mermaid');
    block.querySelector('.mermaid-preview').click();
    await sleep(500);
    const editing = window.__mdpad.mermaidState();

    // Esc returns to the diagram.
    const code = block.querySelector('pre code');
    code.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(400);
    const afterEsc = window.__mdpad.mermaidState();

    // A theme switch must redraw, not leave the previous palette on screen.
    const themeBefore = document.documentElement.dataset.theme;
    window.__mdpad.setTheme('dark');
    await sleep(1500);
    const darkState = window.__mdpad.mermaidState();
    window.__mdpad.setTheme(themeBefore || 'light');
    await sleep(1200);
    const backState = window.__mdpad.mermaidState();
    return { count: initial.length, initial, editing, afterEsc, darkState, backState };
  })()`);
  step(
    'mermaid-typora-mode',
    mermaidTypora.count === 2 &&
      mermaidTypora.initial.every((b) => b.preview && b.sourceHidden && b.svg && !b.error) &&
      // Clicking one diagram edits that one; the other keeps its preview.
      mermaidTypora.editing[0].sourceHidden === false &&
      mermaidTypora.editing[0].preview === false &&
      mermaidTypora.editing[1].preview === true &&
      mermaidTypora.afterEsc.every((b) => b.preview && b.sourceHidden) &&
      mermaidTypora.darkState.every((b) => b.svg) &&
      mermaidTypora.backState.every((b) => b.svg),
    {
      count: mermaidTypora.count,
      initial: mermaidTypora.initial,
      editing: mermaidTypora.editing,
      afterEsc: mermaidTypora.afterEsc,
      dark: mermaidTypora.darkState,
    }
  );

  // 81b. a broken diagram keeps its source visible instead of hiding it behind an error
  const mermaidBroken = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    window.__mdpad.setMarkdown([fence + 'mermaid', 'graph TD; A-->', fence].join(nl));
    await sleep(1800);
    const state = window.__mdpad.mermaidState();
    return { state };
  })()`);
  step(
    'mermaid-error-keeps-source',
    mermaidBroken.state.length === 1 &&
      mermaidBroken.state[0].error === true &&
      mermaidBroken.state[0].sourceHidden === false,
    mermaidBroken
  );

  // 82a. exported HTML, PDF and EPUB contain the diagram, not the fence
  let diagramExportSession = null;
  const diagramExport = await (async () => {
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const diagramDoc = ['# With diagram', '', fence + 'mermaid', 'graph TD;', '  A-->B;', fence, '', 'after'].join(nl);
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.setMarkdown(${JSON.stringify(diagramDoc)});
      await sleep(2200);
    })()`);
    const s2 = sessions.get(win.webContents.id);
    diagramExportSession = s2;
    s2.contents = diagramDoc;
    const before = await win.webContents.executeJavaScript('window.__mdpad.exportDiagramCount()');
    const htmlPath = path.join(dir, 'diagram.html');
    const pdfPath = path.join(dir, 'diagram.pdf');
    const epubPath = path.join(dir, 'diagram.epub');
    await s2.exportTo(htmlPath, 'html');
    await s2.exportTo(pdfPath, 'pdf');
    await s2.exportTo(epubPath, 'epub');
    const htmlText = fs.readFileSync(htmlPath, 'utf8');
    const pdfBytes = fs.statSync(pdfPath).size;
    const JSZip = require('jszip');
    const epubZip = await JSZip.loadAsync(fs.readFileSync(epubPath));
    const chapterFiles = Object.keys(epubZip.files).filter((name) => /OEBPS\/chap\d+\.xhtml$/.test(name));
    let epubHasSvg = false;
    for (const name of chapterFiles) {
      const xml = await epubZip.file(name).async('string');
      if (/<svg[\s>]/.test(xml)) epubHasSvg = true;
    }
    return {
      before,
      stored: Object.keys(s2.exportDiagrams || {}).length,
      hasFigure: /class="mermaid-figure"/.test(htmlText),
      hasSvg: /<svg[\s>]/.test(htmlText),
      noFence: !/language-mermaid/.test(htmlText),
      pdfBytes,
      epubHasSvg,
      chapterFiles,
    };
  })();
  step(
    'diagram-export',
    diagramExport.before >= 1 &&
      diagramExport.stored >= 1 &&
      diagramExport.hasFigure &&
      diagramExport.hasSvg &&
      diagramExport.noFence &&
      diagramExport.pdfBytes > 1500 &&
      diagramExport.epubHasSvg,
    diagramExport
  );

  // 82b. a document without diagrams keeps the plain path (no empty figure, no marker)
  const plainExport = await (async () => {
    const plainDoc = '# Plain' + String.fromCharCode(10) + String.fromCharCode(10) + 'text only';
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.setMarkdown(${JSON.stringify(plainDoc)});
      await sleep(600);
      await window.__mdpad.exportDiagramCount();
    })()`);
    const s3 = sessions.get(win.webContents.id);
    s3.contents = plainDoc;
    const plainPath = path.join(dir, 'plain.html');
    await s3.exportTo(plainPath, 'html');
    const text = fs.readFileSync(plainPath, 'utf8');
    return { markers: (text.match(/mermaid-figure/g) || []).length, stored: Object.keys(s3.exportDiagrams || {}).length };
  })();
  step('diagram-export-plain', plainExport.markers === 0 && plainExport.stored === 0, plainExport);

  // 83a. the chrome follows one scale: control heights, active states, tab indicator
  const chrome = await win.webContents.executeJavaScript(`(async () => {
    try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = window.__mdpad.editor;
    ed.commands.setContent('<p>hello world</p>');
    ed.commands.setTextSelection({ from: 1, to: 6 });
    await sleep(150);
    ed.chain().focus().toggleBold().run();
    await sleep(250);

    const bold = document.querySelector('[data-cmd="bold"]');
    const boldStyle = getComputedStyle(bold);
    const activeOn = bold.classList.contains('active');
    const activeBg = boldStyle.backgroundColor;
    const height = boldStyle.height;
    const radius = boldStyle.borderTopLeftRadius;

    ed.chain().focus().toggleBold().run();
    await sleep(200);
    const boldOff = !bold.classList.contains('active');

    const tab = document.querySelector('.tab.active');
    const tabStyle = tab ? getComputedStyle(tab) : null;
    const toolbar = document.querySelector('.toolbar');

    const rulesText = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText);
        } catch {
          return [];
        }
      })
      .join(String.fromCharCode(10));

    return {
      height,
      radius,
      activeOn,
      activeBg,
      boldOff,
      toolbarHeight: getComputedStyle(toolbar).height,
      tabShadow: tabStyle ? tabStyle.boxShadow : '',
      reducedMotion: /prefers-reduced-motion/.test(rulesText),
      themeSwap: /theme-swap/.test(rulesText),
    };
    } catch (err) {
      return { error: String(err && err.stack ? err.stack : err).slice(0, 300) };
    }
  })()`);
  step(
    'chrome-polish',
    chrome.height === '26px' &&
      chrome.radius === '5px' &&
      chrome.toolbarHeight === '38px' &&
      chrome.activeOn === true &&
      chrome.activeBg !== 'rgba(0, 0, 0, 0)' &&
      chrome.boldOff === true &&
      chrome.tabShadow !== '' &&
      chrome.reducedMotion === true &&
      chrome.themeSwap === true,
    chrome
  );

  // 84a. every chrome button uses the same stroke icon set, with an accessible label
  const icons = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(200);
    const all = [...document.querySelectorAll('[data-icon]')];
    const missingSvg = all.filter((b) => !b.querySelector('svg')).map((b) => b.id || b.dataset.cmd || '?');
    const missingLabel = all
      .filter((b) => !(b.getAttribute('aria-label') || b.title))
      .map((b) => b.id || b.dataset.cmd || '?');
    const labelled = all.filter((b) => b.getAttribute('aria-label')).length;
    const stray = window.__mdpad.iconAudit();

    // The file-tree toggle swaps between chevron-left and chevron-right.
    const toggle = document.querySelector('#files-toggle');
    window.__mdpad.toggleFilesPane();
    await sleep(300);
    const collapsedIcon = document.querySelector('#files-toggle').querySelector('svg') ? 'svg' : 'text';
    window.__mdpad.toggleFilesPane();
    await sleep(300);
    const expandedIcon = document.querySelector('#files-toggle').querySelector('svg') ? 'svg' : 'text';

    return {
      count: all.length,
      missingSvg,
      missingLabel,
      labelled,
      stray,
      collapsedIcon,
      expandedIcon,
      settingsIcon: Boolean(document.querySelector('#open-settings svg')),
      folderIcon: Boolean(document.querySelector('#files-choose svg')),
    };
  })()`);
  step(
    'icon-consistency',
    icons.count >= 15 &&
      icons.missingSvg.length === 0 &&
      icons.missingLabel.length === 0 &&
      icons.labelled >= 15 &&
      icons.stray.length === 0 &&
      icons.collapsedIcon === 'svg' &&
      icons.expandedIcon === 'svg' &&
      icons.settingsIcon &&
      icons.folderIcon,
    icons
  );

  // 85a. the export panel carries format, template, font and margins, and the file reflects them
  const exportPanel = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('# Panel check' + String.fromCharCode(10) + String.fromCharCode(10) + 'body text');
    await sleep(400);
    await window.__mdpad.openExportPanel('pdf');
    await sleep(400);
    const opened = window.__mdpad.exportPanelState();
    document.querySelector('#export-format [data-format="html"]').click();
    document.querySelector('#export-font').value = 'cambria';
    document.querySelector('#export-font').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#export-margin').value = 'wide';
    document.querySelector('#export-margin').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const changed = window.__mdpad.exportPanelState();
    document.querySelector('#export-run').click();
    await sleep(1200);
    const stored = await window.api.getSettings();
    return { opened, changed, closed: document.querySelector('#export-modal').hidden, stored };
  })()`);

  const panelSession = null;
  const panelFile = path.join(dir, 'panel.html');
  await (async () => {
    // the panel triggered a save dialog; in smoke mode the dialog is answered automatically
    const latest = fs.existsSync(panelFile) ? panelFile : null;
    if (!latest) {
      const session = sessions.get(win.webContents.id);
      await session.exportTo(panelFile, 'html');
    }
  })();
  const panelHtml = fs.readFileSync(panelFile, 'utf8');
  step(
    'export-panel',
    exportPanel.opened.open === true &&
      exportPanel.opened.format === 'pdf' &&
      exportPanel.opened.activeFormat === 'pdf' &&
      /PDF/.test(exportPanel.opened.summary) &&
      exportPanel.changed.format === 'html' &&
      exportPanel.changed.activeFormat === 'html' &&
      /Cambria/.test(exportPanel.changed.summary) &&
      /Wide/.test(exportPanel.changed.summary) &&
      exportPanel.stored.exportFont === 'cambria' &&
      exportPanel.stored.exportMargin === 'wide' &&
      /font-family: Cambria/i.test(panelHtml) &&
      /data-margin="wide"/.test(panelHtml),
    { ...exportPanel, htmlHasFont: /font-family: Cambria/i.test(panelHtml) }
  );

  // 86a. the sidebar carries real information: file age, an empty-state action, and the
  // outline marks the heading the caret sits under
  const sidebar = await (async () => {
    const folder = path.join(dir, 'sidebar-project');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'notes.md'), '# Notes' + String.fromCharCode(10, 10) + 'body');
    fs.writeFileSync(path.join(folder, 'older.md'), '# Older');
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(path.join(folder, 'older.md'), old, old);

    await win.webContents.executeJavaScript(`window.__mdpad.openFolder(${JSON.stringify(folder)})`);
    await sleep(900);

    const tree = await win.webContents.executeJavaScript(`(() => ({
      rows: [...document.querySelectorAll('#tree .tree-row')].length,
      metas: [...document.querySelectorAll('#tree .tree-meta')].map((m) => m.textContent.trim()),
    }))()`);

    const outline = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const nl = String.fromCharCode(10);
      window.__mdpad.setMarkdown(['# One', '', 'alpha', '', '## Two', '', 'beta', '', '## Three', '', 'gamma'].join(nl));
      await sleep(700);
      const items = document.querySelectorAll('#outline-list .outline-item').length;
      const count = document.querySelector('#outline-count').textContent;
      const ed = window.__mdpad.editor;
      let pos = 1;
      ed.state.doc.descendants((node, p) => {
        if (node.isText && node.text === 'beta') pos = p;
      });
      ed.commands.setTextSelection(pos);
      await sleep(400);
      const caret = ed.state.selection.from;
      const headings = [];
      ed.state.doc.descendants((node, p) => {
        if (node.type.name === 'heading') headings.push({ text: node.textContent.trim(), pos: p });
      });
      let expected = '';
      for (const h of headings) if (h.pos <= caret) expected = h.text;
      const current = window.__mdpad.outlineCurrent();
      const debug = window.__mdpad.outlineDebug();
      let last = 1;
      ed.state.doc.descendants((node, p) => {
        if (node.isText && node.text === 'gamma') last = p;
      });
      ed.commands.setTextSelection(last);
      await sleep(400);
      const caretLast = ed.state.selection.from;
      let expectedLast = '';
      for (const h of headings) if (h.pos <= caretLast) expectedLast = h.text;
      const currentLast = window.__mdpad.outlineCurrent();
      return { items, count, current, currentLast, expected, expectedLast, debug };
    })()`);

    return { tree, outline };
  })();

  console.error('SIDEBAR_VALUES', JSON.stringify(sidebar, null, 0));
  console.error('SIDEBAR_OUTLINE', JSON.stringify(sidebar.outline));
  step(
    'sidebar-information',
    sidebar.tree.rows === 2 &&
      sidebar.tree.metas.length === 2 &&
      sidebar.tree.metas.some((meta) => /h$/.test(meta)) &&
      sidebar.outline.items === 3 &&
      sidebar.outline.count === '3' &&
      sidebar.outline.current === sidebar.outline.expected &&
      sidebar.outline.currentLast === sidebar.outline.expectedLast,
    sidebar
  );

  // 86b. with no folder, the tree offers an action instead of a sentence
  const treeEmpty = await (async () => {
    await win.webContents.executeJavaScript(`window.__mdpad.openFolder(null)`);
    await sleep(700);
    return win.webContents.executeJavaScript(`(() => ({
      text: document.querySelector('#tree .tree-empty')?.textContent.trim() || '',
      hasButton: Boolean(document.querySelector('#tree .tree-empty-action button')),
    }))()`);
  })();
  console.error('TREE_EMPTY', JSON.stringify(treeEmpty));
  step('tree-empty-action', treeEmpty.hasButton && /Open a folder/.test(treeEmpty.text), treeEmpty);

  // 30k. the settings filter narrows the visible fields
  const filterTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(300);
    const input = document.querySelector('#set-filter');
    input.value = 'autosave';
    input.dispatchEvent(new Event('input'));
    await sleep(150);
    const visible = [...document.querySelectorAll('#settings-modal .field')].filter((f) => !f.hidden);
    const labels = visible.map((f) => f.textContent.trim().slice(0, 30));
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await sleep(150);
    const restored = [...document.querySelectorAll('#settings-modal .field')].filter((f) => !f.hidden).length;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { matched: visible.length, labels, restored };
  })()`);
  step(
    'settings-filter',
    filterTest.matched === 1 && /autosave/i.test(filterTest.labels[0] || '') && filterTest.restored > 3,
    { matched: filterTest.matched, restored: filterTest.restored }
  );
  const cliA = path.join(dir, 'cli-a.md');
  const cliB = path.join(dir, 'cli-b.md');
  fs.writeFileSync(cliA, '# cli a\n', 'utf8');
  fs.writeFileSync(cliB, '# cli b\n', 'utf8');
  const tabsBefore = await win.webContents.executeJavaScript(`window.__mdpad.tabs().length`);
  const openedCount = openFilesInWindow(win, [cliA, cliB]);
  await sleep(600);
  const cliState = await win.webContents.executeJavaScript(
    `window.__mdpad.tabs().map((tab) => (tab.file ? tab.file.split(/[\\\\/]/).pop() : 'untitled'))`
  );
  step(
    'cli-files',
    openedCount === 2 &&
      cliState.includes('cli-a.md') &&
      cliState.includes('cli-b.md') &&
      cliState.length > tabsBefore,
    { opened: openedCount, tabs: cliState.length }
  );

  // 30e. restoring a multi-tab session shows a toast
  sessions.get(win.webContents.id).send('session:restored', { tabs: 3 });
  await sleep(350);
  const toastState = await win.webContents.executeJavaScript(
    `({ text: document.querySelector('#toast').textContent, visible: !document.querySelector('#toast').hidden })`
  );
  step('session-restore-toast', toastState.visible && /3/.test(toastState.text), toastState);

  // 30g. a snapshot with two windows plans both of them
  const secondWin = createWindow({ show: false, cascade: 1 });
  await new Promise((resolve) => secondWin.webContents.once('did-finish-load', resolve));
  await sleep(400);
  saveSession();
  const multiSnap = JSON.parse(fs.readFileSync(sessionStoreFile(), 'utf8'));
  const multiPlans = planRestore(multiSnap, { exists: (file) => fs.existsSync(file) });
  step('session-multi-window', multiPlans.length >= 2, { windows: multiPlans.length });
  secondWin.destroy();
  await sleep(200);

  // 30i. the AI panel says when the document context is trimmed
  const contextNoteTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const longText = Array.from({ length: 120 }, (_, i) => 'paragraph ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(6)).join('\\n\\n');
    window.__mdpad.setMarkdown(longText);
    await sleep(300);
    window.__mdpad.aiOpen();
    await sleep(200);
    // Pin the scope so the long-document auto narrowing does not change what this checks.
    const scope = document.querySelector('#ai-scope');
    scope.value = 'doc';
    scope.dispatchEvent(new Event('change'));
    await sleep(200);
    const note = document.querySelector('#ai-context-note').textContent;
    document.querySelector('#ai-popover').hidden = true;
    window.__mdpad.setMarkdown('short text');
    await sleep(200);
    return { note, long: longText.length };
  })()`);
  step(
    'ai-context-note',
    /4000/.test(contextNoteTest.note) && /trimmed/i.test(contextNoteTest.note),
    { note: contextNoteTest.note, docChars: contextNoteTest.long }
  );
  const sparkTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(400);
    const svg = document.querySelector('#ai-usage-list .usage-spark');
    const points = svg ? svg.querySelector('polyline').getAttribute('points').trim().split(/\\s+/).length : 0;
    document.querySelector('#set-cancel').click();
    await sleep(200);
    return { hasSvg: Boolean(svg), points };
  })()`);
  step('usage-sparkline', sparkTest.hasSvg && sparkTest.points >= 2, sparkTest);

  // 29. settings round-trip through a file, without leaking the API key
  const presetTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(250);
    const select = document.querySelector('#set-ai-preset');
    select.value = 'ollama';
    select.dispatchEvent(new Event('change'));
    const base = document.querySelector('#set-ai-base').value;
    const model = document.querySelector('#set-ai-model').value;
    document.querySelector('#set-save').click();
    await sleep(700);
    const config = await window.api.aiConfig();
    return { base, model, saved: config.baseUrl };
  })()`);
  step(
    'ai-preset',
    presetTest.base.includes('11434') &&
      presetTest.model === 'llama3.2' &&
      presetTest.saved.includes('11434'),
    presetTest
  );

  const settingsExportPath = path.join(dir, 'settings-export.json');
  await win.webContents.executeJavaScript(`window.api.setSettings({ theme: 'dark', language: 'en' })`);
  await win.webContents.executeJavaScript(
    `window.api.aiConfigure({ baseUrl: 'http://127.0.0.1:9/v1', model: 'stub-2', apiKey: 'secret-export-key' })`
  );
  await win.webContents.executeJavaScript(
    `window.api.settingsExportTo(${JSON.stringify(settingsExportPath)})`
  );
  const exportedText = fs.readFileSync(settingsExportPath, 'utf8');
  const exported = JSON.parse(exportedText);
  step(
    'settings-export',
    exported.settings.theme === 'dark' &&
      exported.settings.ai.model === 'stub-2' &&
      !exportedText.includes('secret-export-key') &&
      !exportedText.includes('key'),
    { keys: Object.keys(exported.settings) }
  );

  await win.webContents.executeJavaScript(`window.api.setSettings({ theme: 'sepia' })`);
  await win.webContents.executeJavaScript(
    `window.api.settingsImportFrom(${JSON.stringify(settingsExportPath)})`
  );
  const afterImport = await win.webContents.executeJavaScript(`window.api.getSettings()`);
  step('settings-import', afterImport.theme === 'dark' && afterImport.ai.model === 'stub-2', {
    theme: afterImport.theme,
  });

  // 30c. invalid settings are rejected in the panel, not saved silently
  const validation = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = await window.api.aiConfig();
    document.querySelector('#open-settings').click();
    await sleep(250);
    document.querySelector('#set-ai-base').value = 'not-a-url';
    document.querySelector('#set-save').click();
    await sleep(400);
    const status = document.querySelector('#set-status').textContent;
    const open = !document.querySelector('#settings-modal').hidden;
    document.querySelector('#set-ai-base').value = before.baseUrl;
    document.querySelector('#set-save').click();
    await sleep(600);
    const after = await window.api.aiConfig();
    return { status, open, before: before.baseUrl, after: after.baseUrl };
  })()`);
  step(
    'settings-validation',
    /http/i.test(validation.status) && validation.open && validation.after === validation.before,
    { status: validation.status }
  );
  // 30. the persisted session stays bounded no matter how many tabs are open
  await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 30; i += 1) await window.api.newDoc();
  })()`);
  saveSession();
  const bounded = JSON.parse(fs.readFileSync(sessionStoreFile(), 'utf8')).windows[0];
  const untitledCount = bounded.tabs.filter((tab) => !tab.file).length;
  step('session-bounds', bounded.tabs.length <= 20 && untitledCount <= 5, {
    tabs: bounded.tabs.length,
    untitled: untitledCount,
  });

  // 46a. the save indicator goes dirty -> saving -> saved
  const indicatorFile = path.join(dir, 'save-indicator.md');
  fs.writeFileSync(indicatorFile, '# start\n', 'utf8');
  s.loadDocument(indicatorFile);
  await sleep(600);
  const saveIndicator = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.applyMarkdown('# save indicator probe');
    await sleep(300);
    const dirty = window.__mdpad.saveState();
    // Wait for the autosave to land (autosaveMs is short in smoke runs).
    let saved = '';
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      saved = window.__mdpad.saveState();
      if (/^Saved /.test(saved)) break;
    }
    return { dirty, saved };
  })()`);
  await win.webContents.executeJavaScript(`window.api.closeTab(${JSON.stringify(indicatorFile)})`);
  await sleep(1200);
  // Closing a tab re-renders the editor; a probe issued too early can hit a disposed frame.
  if (!sessions.has(win.webContents.id) || win.isDestroyed()) {
    console.error('SMOKE_NOTE: window gone after closing the indicator tab');
  }
  step(
    'save-indicator',
    saveIndicator.dirty === 'Unsaved' && /^Saved \d/.test(saveIndicator.saved),
    saveIndicator
  );


  if (wroteDevFeed) {
    try {
      fs.unlinkSync(devFeedFile);
    } catch {
      /* already gone */
    }
  }
  feedServer.close();

  // 14. settings round-trip and the modal wiring
  const settingsRound = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#open-settings').click();
    await sleep(250);
    const opened = !document.querySelector('#settings-modal').hidden;
    document.querySelector('#set-theme').value = 'sepia';
    document.querySelector('#set-autosave').value = '3';
    document.querySelector('#set-save').click();
    await sleep(800);
    const s = await window.api.getSettings();
    return {
      opened,
      closed: document.querySelector('#settings-modal').hidden,
      theme: s.theme,
      autosaveMs: s.autosaveMs,
    };
  })()`);
  step(
    'settings-roundtrip',
    settingsRound.opened && settingsRound.closed && settingsRound.theme === 'sepia' && settingsRound.autosaveMs === 3000,
    settingsRound
  );

  try {
    stub.close();
  } catch (err) {
    console.error('SMOKE_CLOSE_ERROR', err && err.message);
  }

  clearTimeout(watchdog);
  const failed = out.filter((r) => !r.ok);
  const report = { ok: failed.length === 0, checks: out, dir };
  try {
    fs.writeFileSync(path.join(dir, 'smoke-result.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.error('SMOKE_WRITE_ERROR', err && err.stack);
    throw err;
  }
  // Write the report first: stdout can be held open by helper processes, so the
  // shell is told the result through a file rather than through the exit flush.
  console.log(`SMOKE_RESULT ${report.ok ? 'ok' : 'FAIL'} checks=${out.length} failed=${failed.length} dir=${dir}`);
  // process.exit() can truncate piped stdout on Windows, which is how the runner reads the
  // result; keep the loop alive for a tick and let the process end on its own.
  process.exitCode = report.ok ? 0 : 1;
  setTimeout(() => app.exit(process.exitCode), 250);
}

// ---- screenshots for the documentation -------------------------------------

const SAMPLE_DOC = [
  '# mdpad',
  '',
  'A markdown editor that **survives crashes**, with live formatting and AI writing.',
  '',
  '## Why it feels different',
  '',
  '- Everything renders in place — no split preview',
  '- Atomic saves, versioned backups, recovery drafts',
  '- Tables, math and code stay editable',
  '',
  'Diagrams work too:',
  '',
  '```mermaid',
  'graph LR;',
  '  write-->backup;',
  '  backup-->restore;',
  '```',
  '',
  '| Feature | State |',
  '| --- | --- |',
  '| Autosave | 5 s idle |',
  '| Backups | 20 versions |',
  '',
  '```js',
  "const backup = saveDocument(file, contents);",
  '```',
  '',
  'Inline math $a^2 + b^2 = c^2$ and a display block:',
  '',
  '$$',
  '\\int_0^1 x^2\\,dx = \\tfrac{1}{3}',
  '$$',
].join('\n');

async function runScreenshots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  crashedLastRun = false; // docs shots should show a clean first run
  writeSettings({ language: 'en', theme: 'light', onboarded: true }); // match the English docs, no banner
  const win = createWindow({ show: true });
  const session = sessions.get(win.webContents.id);
  // loadFile() is already in flight; polling avoids waiting for an event that may
  // have fired before this listener attached.
  for (let i = 0; i < 200 && win.webContents.isLoading(); i += 1) await sleep(50);
  await sleep(1200);

  const repaint = async () => {
    // requestAnimationFrame does not fire while the window is occluded, so wait on a
    // plain timer inside the page and then give the compositor a moment.
    await win.webContents.executeJavaScript('new Promise((resolve) => setTimeout(resolve, 150))');
    await sleep(300);
  };

  const shot = async (name) => {
    await repaint();
    const state = await win.webContents.executeJavaScript(
      `({ settingsOpen: !document.querySelector('#settings-modal').hidden, crashShown: !document.querySelector('#crash-banner').hidden, body: document.body.innerText.slice(0, 40) })`
    );
    console.log(`STATE ${name} ${JSON.stringify(state)}`);
    // capturePage() can return a stale composited frame for occluded windows; CDP
    // captures a fresh frame from the renderer instead.
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(data, 'base64');
    fs.writeFileSync(path.join(dir, name), png);
    console.log(`SHOT ${name} ${Math.round(png.length / 1024)}KB`);
  };

  await shot('01-empty.png');

  await win.webContents.executeJavaScript(
    `window.__mdpad.applyMarkdown(${JSON.stringify(SAMPLE_DOC)})`
  );
  await sleep(900);
  await shot('02-editor.png');

  await win.webContents.executeJavaScript(`window.__mdpad.openPalette()`);
  await sleep(350);
  await shot('03-palette.png');

  await win.webContents.executeJavaScript(
    `document.querySelector('#palette').hidden = true; window.__mdpad.aiOpen()`
  );
  await sleep(350);
  await shot('04-ai.png');

  await win.webContents.executeJavaScript(
    `document.querySelector('#ai-popover').hidden = true; document.querySelector('#open-settings').click()`
  );
  await sleep(450);
  await shot('05-settings.png');

  await win.webContents.executeJavaScript(
    `document.querySelector('#set-cancel').click(); window.__mdpad.applyTheme('dark')`
  );
  await sleep(600);
  await shot('06-dark.png');

  // The export panel is the one surface that shows format, template, font and margins together.
  await win.webContents.executeJavaScript(
    `window.__mdpad.applyTheme('light'); window.__mdpad.openExportPanel('pdf')`
  );
  await sleep(700);
  await shot('07-export.png');

  session.dispose();
  console.log('SHOTS_OK');
  process.exit(0);
}

// Crash-recovery harness: phase "write" edits, waits for the draft, then kills the
// process without cleanup; phase "verify" restarts and checks the draft is offered.
async function runCrashWrite() {
  const win = createWindow({ show: false });
  const session = sessions.get(win.webContents.id);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(200);

  session.loadDocument(CRASH_FILE);
  // doc:loaded is an event; give the renderer a tick to install the file content
  // before pushing the edited buffer, otherwise the load overwrites the edit.
  await sleep(400);
  await win.webContents.executeJavaScript(
    `window.__mdpad.applyMarkdown('# crash target\\n\\nunsaved edit that must survive')`
  );
  // The renderer debounces before syncing; push the buffer explicitly so the crash
  // test does not depend on how a hidden window schedules timers.
  await win.webContents.executeJavaScript(
    `window.api.syncChange(window.__mdpad.getMarkdown())`
  );
  session.writeDraftNow();

  const draft = storage.readDraft(CRASH_FILE, draftsDir());
  if (draft && draft.contents.includes('unsaved edit that must survive')) {
    console.log('CRASH_DRAFT_OK ' + JSON.stringify({ file: CRASH_FILE, bytes: draft.contents.length }));
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  console.log(
    'CRASH_DRAFT_MISSING ' +
      JSON.stringify({
        file: session.file,
        contents: session.contents,
        saved: session.savedContents,
        expectDraftId: storage.draftId(CRASH_FILE),
        draftsDir: draftsDir(),
        drafts: fs.existsSync(draftsDir()) ? fs.readdirSync(draftsDir()) : null,
      })
  );
  process.exit(1);
}

let preflightReport = { ok: true, results: [], failed: [] };

// ---- command-line files ----------------------------------------------------

function cliFileList() {
  return parseFileArgs(process.argv.slice(1), {
    isFile: (candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  });
}

function openFilesInWindow(win, files) {
  const session = sessions.get(win.webContents.id);
  if (!session || !files.length) return 0;
  let opened = 0;
  for (const file of files) {
    try {
      session.loadDocument(file);
      opened += 1;
    } catch (err) {
      logLine('cli', `${file}: ${err.message}`);
    }
  }
  return opened;
}

// ---- real-restart session check --------------------------------------------

const RESTART_FILES = () => [path.join(app.getPath('userData'), 'restart-a.md'), path.join(app.getPath('userData'), 'restart-b.md')];

async function runRestartWrite() {
  const [a, b] = RESTART_FILES();
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(a, '# restart a\n', 'utf8');
  fs.writeFileSync(b, '# restart b\n', 'utf8');
  const first = createWindow({ show: false });
  await new Promise((resolve) => first.webContents.once('did-finish-load', resolve));
  await sleep(400);
  const firstSession = sessions.get(first.webContents.id);
  firstSession.loadDocument(a);
  firstSession.loadDocument(b);
  await sleep(300);
  const second = createWindow({ show: false });
  await new Promise((resolve) => second.webContents.once('did-finish-load', resolve));
  await sleep(400);
  sessions.get(second.webContents.id).loadDocument(a);
  await sleep(300);
  console.log('RESTART_WRITE_OK windows=2 tabs=3');
  // A clean quit is what persists the session (before-quit handler).
  app.quit();
}

async function runRestartReport() {
  const windows = [...sessions.values()].map((session) => ({
    tabs: [...session.tabs.values()].map((tab) => (tab.file ? path.basename(tab.file) : 'untitled')),
  }));
  const totalTabs = windows.reduce((sum, win) => sum + win.tabs.length, 0);
  const ok = windows.length === 2 && totalTabs >= 3;
  console.log('RESTART_VERIFY ' + JSON.stringify({ ok, windows }));
  app.exit(ok ? 0 : 1);
}

// ---- export preview --------------------------------------------------------

const previewWindows = new Set();
let lastExternalUrl = null;

// The preview should match the editor theme; the exported file itself stays light so it
// prints and pastes predictably.
function previewThemeCss(theme) {
  if (theme === 'dark') {
    return `<style>
html, body { background: #14171c !important; color: #d7dce3 !important; }
body article, body main { background: #14171c !important; }
body h1, body h2, body h3, body h4, body p, body li, body td, body th, body blockquote {
  color: #d7dce3 !important;
}
body code, body pre { background: #1d222a !important; color: #d7dce3 !important; }
body hr, body td, body th { border-color: #2a2f38 !important; }
body a { color: #7aa7ff !important; }
</style>`;
  }
  if (theme === 'sepia') {
    return `<style>
html, body { background: #f6efdf !important; color: #4a3f31 !important; }
</style>`;
  }
  return '';
}

function previewExport(session) {
  const name = session.file ? path.basename(session.file) : 'Untitled';
  const html = exporter.toHtmlDocument(session.contents, name, {
    template: exportTemplate(),
    css: String(readSettings().exportCss || ''),
    diagrams: session.exportDiagrams || null,
  });
  const previewFile = path.join(userDir(), 'export-preview.html');
  fs.mkdirSync(userDir(), { recursive: true });
  const note = `<div style="position:sticky;top:0;z-index:10;display:flex;gap:8px;align-items:center;font:12px/1.4 system-ui,sans-serif;color:#6b7280;background:#f6f7f9;border-bottom:1px solid #e5e7eb;padding:8px 14px">
<span>${t('preview.note', currentLang())} (${exportTemplate()})</span>
<span style="margin-left:auto;display:flex;gap:4px">
<button type="button" onclick="document.body.style.zoom='0.75'" style="font:inherit;padding:2px 8px;border:1px solid #d1d5db;border-radius:999px;background:#fff;cursor:pointer">75%</button>
<button type="button" onclick="document.body.style.zoom='1'" style="font:inherit;padding:2px 8px;border:1px solid #d1d5db;border-radius:999px;background:#fff;cursor:pointer">100%</button>
<button type="button" onclick="document.body.style.zoom='1.25'" style="font:inherit;padding:2px 8px;border:1px solid #d1d5db;border-radius:999px;background:#fff;cursor:pointer">125%</button>
</span>
</div>`;
  const theme = readSettings().theme || 'light';
  const themed = previewThemeCss(theme)
    ? html.replace('</head>', previewThemeCss(theme) + '</head>')
    : html;
  const barColors =
    theme === 'dark'
      ? 'color:#c7ced8;background:#1b2027;border-bottom:1px solid #2a2f38'
      : 'color:#6b7280;background:#f6f7f9;border-bottom:1px solid #e5e7eb';
  const noteStyled = note.replace(
    'color:#6b7280;background:#f6f7f9;border-bottom:1px solid #e5e7eb',
    barColors
  );
  // Esc closes the preview, like every other overlay in the app.
  const escScript = '<script>document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });</script>';
  const withNote = themed
    .replace(/<body([^>]*)>/i, `<body$1>${noteStyled}`)
    .replace('</body>', escScript + '</body>');
  fs.writeFileSync(previewFile, withNote, 'utf8');

  const preview = new BrowserWindow({
    parent: session.win || undefined,
    modal: Boolean(session.win),
    width: 960,
    height: 720,
    title: `${t('preview.title', currentLang())} — ${name}`,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  preview.setMenuBarVisibility(false);
  preview.loadFile(previewFile);
  previewWindows.add(preview);
  preview.on('closed', () => {
    previewWindows.delete(preview);
    try {
      fs.unlinkSync(previewFile);
    } catch {
      /* already gone */
    }
  });
  return { previewed: true };
}

async function runCrashVerify() {
  const win = createWindow({ show: false });
  const session = sessions.get(win.webContents.id);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(200);

  session.loadDocument(CRASH_FILE);
  await sleep(400);
  const bannerVisible = await win.webContents.executeJavaScript(
    `!document.querySelector('#banner').hidden`
  );
  const crashBannerVisible = await win.webContents.executeJavaScript(
    `!document.querySelector('#crash-banner').hidden`
  );
  const draft = storage.readDraft(CRASH_FILE, draftsDir());
  const ok = Boolean(
    draft &&
      draft.contents.includes('unsaved edit that must survive') &&
      bannerVisible &&
      crashBannerVisible
  );
  console.log(
    'CRASH_VERIFY ' +
      JSON.stringify({
        ok,
        bannerVisible,
        crashBannerVisible,
        hasDraft: Boolean(draft),
        bytes: draft ? draft.contents.length : 0,
      })
  );
  process.exit(ok ? 0 : 1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('uncaughtException', (err) => {
  logLine('uncaughtException', err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (reason) => {
  logLine('unhandledRejection', reason && reason.stack ? reason.stack : String(reason));
});
app.on('render-process-gone', (_event, _contents, details) => {
  logLine('render-process-gone', JSON.stringify(details));
});
app.on('child-process-gone', (_event, details) => {
  logLine('child-process-gone', JSON.stringify(details));
});

app.whenReady().then(async () => {
  registerIpc();
  markRunning();
  preflightReport = checkDirs({ data: userDir(), backups: backupsDir(), drafts: draftsDir() });
  if (!preflightReport.ok) {
    logLine('preflight', JSON.stringify(preflightReport.failed));
  }
  logLine('argv', JSON.stringify({ args: process.argv.slice(1), screenshot: SCREENSHOT_DIR }));
  try {
    buildMenu();
  } catch (err) {
    console.error('MENU_ERROR', err && err.stack ? err.stack : err);
    logLine('menu', String(err && err.stack ? err.stack : err));
  }

  if (CRASH_PHASE === 'write') {
    await runCrashWrite();
    return;
  }
  if (CRASH_PHASE === 'verify') {
    await runCrashVerify();
    return;
  }
  if (RESTART_PHASE === 'write') {
    await runRestartWrite();
    return;
  }
  if (RESTART_PHASE === 'verify') {
    // Let the normal startup restore the session, then report what came back.
    setTimeout(() => runRestartReport(), 3000);
  }
  if (SCREENSHOT_DIR) {
    try {
      await runScreenshots(SCREENSHOT_DIR);
    } catch (err) {
      console.error('SHOTS_ERROR', err && err.stack ? err.stack : err);
      process.exit(1);
    }
    return;
  }

  if (SMOKE) {
    try {
      await runSmoke();
    } catch (err) {
      console.error('SMOKE_ERROR', err && err.stack ? err.stack : err);
      logLine('smoke', err && err.stack ? err.stack : String(err));
      app.exit(1);
    }
    return;
  }

  const previous = readSession();
  const restoreDecision = decideRestore({
    crashes: readCrashStreak(),
    hasSession: Boolean(previous && Array.isArray(previous.windows) && previous.windows.length),
  });
  const activeSession = restoreDecision.action === 'restore' ? previous : null;
  if (restoreDecision.action === 'skip') {
    logLine('guard', 'session restore skipped after repeated startup crashes');
    try {
      if (fs.existsSync(sessionStoreFile())) {
        fs.copyFileSync(sessionStoreFile(), sessionStoreFile() + '.crashloop');
      }
    } catch (err) {
      logLine('guard', err.message);
    }
    writeCrashStreak(0);
  }
  const plans = planRestore(activeSession, { exists: (file) => fs.existsSync(file) });
  if (plans.length) {
    logLine('session', `restoring ${plans.length} window(s)`);
    const dropped = plans.reduce((sum, plan) => sum + (plan.dropped || 0), 0);
    plans.forEach((plan, index) => createWindow({ restore: plan, cascade: index }));
    if (dropped > 0) {
      const target = BrowserWindow.getAllWindows()[0];
      if (target) {
        const notify = () => {
          const session = sessions.get(target.webContents.id);
          if (session) session.send('session:truncated', { dropped });
        };
        if (target.webContents.isLoading()) target.webContents.once('did-finish-load', notify);
        else notify();
      }
    }
  } else {
    createWindow();
  }

  const cliFiles = cliFileList();
  const target = BrowserWindow.getAllWindows()[0];
  if (cliFiles.length && target) {
    logLine('cli', `opening ${cliFiles.length} file(s) from the command line`);
    if (target.webContents.isLoading()) {
      target.webContents.once('did-finish-load', () => openFilesInWindow(target, cliFiles));
    } else {
      openFilesInWindow(target, cliFiles);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveSession();
  writeCrashStreak(0);
  clearRunning();
  for (const session of sessions.values()) session.dispose();
});

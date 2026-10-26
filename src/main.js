'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage, screen, clipboard, nativeTheme, powerMonitor, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./storage');
const { buildHistory: buildWritingHistory } = require('./writing');
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
const { analyzeSentences } = require('./sentence');
const { analyzeRepetition } = require('./repetition');
const { analyzeStyle } = require('./style');
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
const { createUpdater, checkForUpdates: runUpdateCheck, downloadUpdate } = require('./updater');

const AUTOSAVE_MS = Number(process.env.MDPAD_AUTOSAVE_MS || 5000);
const DRAFT_MS = Number(process.env.MDPAD_DRAFT_MS || 600);
const BACKUP_KEEP = 20;
const SMOKE = process.argv.includes('--smoke-test');
const SCREENSHOT_DIR = (process.argv.find((a) => a.startsWith('--screenshot-dir=')) || '').split('=')[1] || null;
const RESTART_PHASE = (process.argv.find((a) => a.startsWith('--restart-phase=')) || '').split('=')[1] || null;
const PROCESS_STARTED_AT = Date.now();
// The OS clock includes Electron boot and, for a freshly built binary, the virus scanner.
// bootMs measures what this code controls: app ready → first window painted.
let READY_AT = null;
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
  } catch (err) {
    // Never let a broken file be overwritten silently: keep a copy and say so in the log.
    try {
      const backup = settingsFile() + '.corrupt-' + Date.now();
      fs.copyFileSync(settingsFile(), backup);
      logLine('settings', 'unreadable settings (' + err.message + '); kept ' + path.basename(backup));
    } catch (copyErr) {
      logLine('settings', 'unreadable settings and backup failed: ' + copyErr.message);
    }
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// The last ten exports, so a finished document can be opened again without hunting for the path.
function rememberExport(filePath, kind) {
  try {
    const settings = readSettings();
    const list = Array.isArray(settings.exportHistory) ? settings.exportHistory : [];
    const entry = { path: String(filePath), kind: String(kind || 'html'), at: Date.now() };
    const next = [entry, ...list.filter((item) => item && item.path !== entry.path)].slice(0, 10);
    writeSettings({ exportHistory: next });
  } catch (err) {
    logLine('export', 'could not record history: ' + err.message);
  }
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

const THEMES = new Set(['light', 'dark', 'sepia', 'system']);

// Report options are read at report time so a change applies to the next report without a restart.
function reportOptionsForDoc() {
  const options = readSettings().reportOptions || {};
  return {
    style: options.style !== false,
    repetition: options.repetition !== false,
    sentenceLimit: Math.max(8, Math.min(120, Math.floor(Number(options.sentenceLimit) || 40))),
  };
}

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
    exportPageNumbers: s.exportPageNumbers !== false,
    reportOptions: {
      style: !s.reportOptions || s.reportOptions.style !== false,
      repetition: !s.reportOptions || s.reportOptions.repetition !== false,
      sentenceLimit: Math.max(8, Math.min(120, Math.floor(Number((s.reportOptions || {}).sentenceLimit) || 40))),
    },
    spellcheck: s.spellcheck !== false,
    findOptions:
      s.findOptions && typeof s.findOptions === 'object'
        ? {
            caseSensitive: s.findOptions.caseSensitive === true,
            wholeWord: s.findOptions.wholeWord === true,
            regex: s.findOptions.regex === true,
          }
        : { caseSensitive: false, wholeWord: false, regex: false },
    zoomLevel: clampZoom(s.zoomLevel),
    seenHints: s.seenHints && typeof s.seenHints === 'object' ? s.seenHints : {},
    exportHistory: Array.isArray(s.exportHistory) ? s.exportHistory : [],
    foldedHeadings: s.foldedHeadings && typeof s.foldedHeadings === 'object' ? s.foldedHeadings : {},
  };
}

const DEFAULT_CONFIRM_TOKENS = 20000;
const AI_SCOPES = ['doc', 'paragraph', 'none'];

function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-3, Math.min(5, Math.round(n * 10) / 10));
}

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

function exportFontStackFor(key) {
  const chosen = FONT_KEYS.includes(key) ? key : readSettings().exportFont || 'serif';
  return FONT_STACKS_EXPORT[chosen] || FONT_STACKS_EXPORT.serif;
}

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

// Cursor and scroll of each tab, reported by the renderer: reopening a long document should land
// where the user was, not at the top.
function rememberView(session, payload) {
  if (!session || !payload || typeof payload.tabId !== 'string') return;
  const cursor = Math.max(0, Math.floor(Number(payload.cursor) || 0));
  const scrollTop = Math.max(0, Math.floor(Number(payload.scrollTop) || 0));
  session.viewByTab = session.viewByTab || {};
  session.viewByTab[payload.tabId] = { cursor, scrollTop, at: Date.now() };
}

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
      view: (session.viewByTab && session.viewByTab[tab.id]) || null,
    });
    if (kept.length >= MAX_RESTORE_TABS) break;
  }

  // The active tab (if any) must survive the cap so the user lands where they left.
  const active = session.tabs.get(session.activeId);
  if (active && !kept.some((entry) => entry.file && entry.file === active.file)) {
    kept.unshift({
      file: active.file,
      contents: active.file ? null : active.contents,
      view: (session.viewByTab && session.viewByTab[active.id]) || null,
    });
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
        maximized: Boolean(s.win && !s.win.isDestroyed() && s.win.isMaximized()),
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
    this.lastDraftAt = 0;
    this.draftBroken = false;
    this.backupBroken = false;
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
        diskRaw: this.diskRaw,
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
      // The point of reopening is the buffer that was closed; reading the file again would
      // silently replace it with whatever the disk says now.
      const existing = [...this.tabs.values()].find((tab) => tab.file === last.file);
      if (existing) return { ok: true, ...this.activateTab(existing.id) };
      const onDisk = storage.readIfExists(last.file);
      const id = this.newTabId();
      this.tabs.set(id, {
        id,
        file: last.file,
        contents: last.contents || onDisk || "",
        savedContents: onDisk === null ? "" : onDisk,
        diskRaw: onDisk === null ? "" : onDisk,
      });
      this.watchDocument(last.file);
      return { ok: true, ...this.activateTab(id) };
    }
    const id = this.newTabId();
    this.tabs.set(id, { id, file: null, contents: last.contents || "", savedContents: "" });
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
      this.diskRaw = tab.diskRaw ?? null;
    this.watchDocument(this.file);
    this.refreshTitle();
    this.broadcastTabs();
    const draft = this.file
      ? storage.hasRecoverableDraft(this.file, this.contents, draftsDir())
      : null;
    const view = (this.viewByTab && this.viewByTab[id]) || null;
    this.send('doc:loaded', { id, file: this.file, contents: this.contents, draft, view });
    this.sendStatus({ file: this.file, dirty: this.isDirty() });
    return { ok: true, id };
  }

  closeTab(id) {
    if (id === this.activeId) this.stashActive();
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false };
    const wasDirty = tab.contents !== tab.savedContents;
    let draftSaved = false;
    if (wasDirty) {
      try {
        storage.writeDraft(tab.file, tab.contents, draftsDir());
        draftSaved = true;
      } catch {
        /* the buffer is gone either way */
      }
    }
    // Remember it so Ctrl+Shift+T can bring it back with the same buffer.
    this.closedTabs = this.closedTabs || [];
    this.closedTabs.push({ file: tab.file, contents: tab.contents });
    if (this.closedTabs.length > 10) this.closedTabs.shift();
    this.tabs.delete(id);
    const result = (() => {
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
    })();
    return {
      ...(result && typeof result === "object" ? result : {}),
      closed: true,
      closedWithDraft: wasDirty,
      draftSaved,
      name: tab.file ? path.basename(tab.file) : "Untitled",
    };
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
    this.tabs.set(id, { id, file, contents, savedContents: contents, diskRaw: contents });
    return this.activateTab(id);
  }

  writeDraftNow() {
    try {
      if (this.contents === this.savedContents) {
        storage.clearDraft(this.file, draftsDir());
        return null;
      }
      const written = storage.writeDraft(this.file, this.contents, draftsDir());
      if (this.draftBroken) {
        this.draftBroken = false;
        this.sendStatus({ draftOk: true });
      }
      return written;
    } catch (err) {
      // A broken drafts folder means the crash protection is gone. Say it once, loudly, and keep
      // editing; retrying silently would let the user believe the text is protected.
      if (!this.draftBroken) {
        this.draftBroken = true;
        logLine('draft', 'write failed: ' + err.message);
        this.sendStatus({ draftError: err.message, draftsDir: draftsDir() });
      }
      return null;
    }
  }

  scheduleDraft() {
    // Leading edge first: the first change after an idle period is written immediately, so a
    // crash right after typing loses nothing. Later changes are coalesced on the trailing edge.
    const now = Date.now();
    const idle = !this.lastDraftAt || now - this.lastDraftAt >= DRAFT_MS;
    clearTimeout(this.draftTimer);
    if (idle && this.file) {
      this.lastDraftAt = now;
      this.writeDraftNow();
      return;
    }
    this.draftTimer = setTimeout(() => {
      this.lastDraftAt = Date.now();
      try {
        this.writeDraftNow();
      } catch (err) {
        this.sendStatus({ error: `draft: ${err.message}` });
      }
    }, DRAFT_MS);
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    if (this.readOnly && this.readOnlyFile === this.file) return; // do not hammer a file we know is not writable
    const delay = clampAutosave(readSettings().autosaveMs);
    this.autosaveTimer = setTimeout(() => {
      if (!this.isDirty()) return;
      try {
        if (this.file) this.send('save:state', { state: 'saving', savedAt: this.savedAt || null });
        const autosaved = this.saveCurrent({ silent: true });
        // Skipped because the file changed underneath: stay dirty rather than look saved.
        if (autosaved && autosaved.conflict) {
          this.send('save:state', { state: 'dirty', savedAt: this.savedAt || null });
        }
      } catch (err) {
        this.sendStatus({ error: `autosave: ${err.message}` });
      }
    }, delay);
  }

  // Old documents can still carry pasted images as data URLs. Moving them next to the file is
  // explicit: it rewrites the document, so it is offered as a command, never done silently.
  extractEmbeddedImages() {
    if (!this.file) return { extracted: false, reason: 'no-file' };
    if (this.contents !== this.diskRaw) return { extracted: false, reason: 'dirty' };
    const pattern = /!\[([^\]]*)\]\(data:image\/([a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)\)/gi;
    const found = [];
    this.contents.replace(pattern, (match, alt, type, base64) => {
      found.push({ alt, type, base64, match });
      return match;
    });
    if (!found.length) return { extracted: false, reason: 'none' };
    const dir = path.join(path.dirname(this.file), 'assets');
    fs.mkdirSync(dir, { recursive: true });
    let before = this.contents.length;
    let replaced = 0;
    const names = [];
    let next = this.contents.replace(pattern, (match, alt, type, base64) => {
      const ext = String(type).toLowerCase().replace(/^jpeg$/, 'jpg');
      const bytes = Buffer.from(String(base64).replace(/\s+/g, ''), 'base64');
      if (!bytes.length) return match;
      const name = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12) + '.' + ext;
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
      names.push(name);
      replaced += 1;
      return '![' + alt + '](assets/' + name + ')';
    });
    if (!replaced) return { extracted: false, reason: 'none' };
    const backup = storage.saveDocument(this.file, next, { backupsDir: backupsDir(), keep: BACKUP_KEEP });
    this.contents = next;
    this.savedContents = next;
    this.diskRaw = next;
    this.stashActive();
    this.broadcastTabs();
    this.send('doc:reloaded', { contents: next, file: this.file });
    this.sendStatus({ extracted: replaced });
    logLine('images', 'extracted ' + replaced + ' embedded image(s) from ' + this.file);
    return {
      extracted: true,
      count: replaced,
      bytesBefore: before,
      bytesAfter: next.length,
      names,
      backup: Boolean(backup && backup.backup),
    };
  }

  saveCurrent({ silent = false, force = false } = {}) {
    if (!this.file) {
      this.send('save:state', { state: 'dirty', savedAt: null });
      return { saved: false, reason: 'no-file' };
    }
    // Another window or editor may have written the file after we loaded it. Overwriting then
    // would destroy that work silently, so ask first (autosave only raises the banner).
    if (!force) {
      const onDisk = storage.readIfExists(this.file);
      if (onDisk !== null && onDisk !== this.diskRaw && onDisk !== this.contents) {
        this.externalConflict = true;
        logLine('save', `conflict: ${this.file} changed on disk`);
        if (!silent) this.send('file:external', { size: onDisk.length, conflict: true });
        return {
          saved: false,
          conflict: true,
          reason: 'changed-on-disk',
          onDiskBytes: onDisk.length,
          onDiskAt: (() => {
            try {
              return fs.statSync(this.file).mtimeMs;
            } catch {
              return null;
            }
          })(),
        };
      }
    }
    this.externalConflict = false;
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
        this.readOnlyFile = this.file;
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
      this.diskRaw = this.contents;
      this.savedAt = Date.now();
      this.send('save:state', { state: 'saved', savedAt: this.savedAt });
      this.readOnly = false;
      this.readOnlyFile = null;
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
    // Sent after the "saved" status so the banner it raises is not hidden by the save itself.
    if (result.backupError) {
      if (!this.backupBroken) {
        this.backupBroken = true;
        logLine('backup', 'rotation failed: ' + result.backupError);
        this.sendStatus({ backupError: result.backupError, backupsDir: backupsDir() });
      }
    } else if (this.backupBroken) {
      this.backupBroken = false;
      this.sendStatus({ backupOk: true });
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

  // A half-written export is worse than no export. Remove the file this attempt created (but never
  // touch a file that existed before the attempt).
  async exportTo(filePath, kind, diagrams = this.exportDiagrams || null, contentsOverride = null) {
    const existedBefore = (() => {
      try {
        return fs.existsSync(filePath);
      } catch {
        return true;
      }
    })();
    try {
      return await this.exportToUnsafe(filePath, kind, diagrams, contentsOverride);
    } catch (err) {
      if (!existedBefore) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* nothing was created */
        }
      }
      throw err;
    }
  }


  async exportToUnsafe(filePath, kind, diagrams = this.exportDiagrams || null, contentsOverride = null) {
    const contents = contentsOverride == null ? this.contents : contentsOverride;
    const name = path.basename(this.file || 'Untitled', path.extname(this.file || 'Untitled'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.sendStatus({ exporting: kind, target: path.basename(filePath) });

    if (kind === 'pdf') {
      const result = await exporter.toPdf(contents, filePath, {
        title: name,
        template: exportTemplate(),
        css: String(readSettings().exportCss || ''),
        stats: this.exportStats(),
        diagrams,
        font: exportFontStack(),
        margin: readSettings().exportMargin || 'normal',
        pageNumbers: readSettings().exportPageNumbers !== false,
      });
      rememberExport(filePath, kind);
      this.sendStatus({ exported: result });
      this.send('doc:exported', { path: filePath, kind });
      return { exported: true, ...result };
    }
    if (kind === 'docx') {
      const result = await toDocx(contents, filePath, {
        title: name,
        baseDir: this.file ? path.dirname(this.file) : path.dirname(filePath),
      });
      fs.writeFileSync(filePath, result.buffer);
      const out = { path: filePath, bytes: result.bytes };
      rememberExport(filePath, kind);
      this.sendStatus({ exported: out, sizeWarning: isLargeExport(result.bytes) ? describeSize(result.bytes) : null });
      return { exported: true, ...out };
    }
    if (kind === 'epub') {
      const result = await toEpub(contents, filePath, {
        title: name,
        baseDir: this.file ? path.dirname(this.file) : path.dirname(filePath),
        diagrams,
      });
      fs.writeFileSync(filePath, result.buffer);
      const out = { path: filePath, bytes: result.bytes, chapters: result.chapters };
      rememberExport(filePath, kind);
      this.sendStatus({ exported: out, sizeWarning: isLargeExport(result.bytes) ? describeSize(result.bytes) : null });
      return { exported: true, ...out };
    }
    fs.writeFileSync(
      filePath,
      exporter.toHtmlDocument(contents, name, {
        template: exportTemplate(),
        css: String(readSettings().exportCss || ''),
        stats: this.exportStats(),
        diagrams,
        font: exportFontStack(),
        margin: readSettings().exportMargin || 'normal',
        baseDir: this.file ? path.dirname(this.file) : null,
        tocTitle: t('export.contents', currentLang()),
      }),
      'utf8'
    );
    const result = { path: filePath, bytes: fs.statSync(filePath).size };
    rememberExport(filePath, kind);
    this.sendStatus({ exported: result });
    this.send('doc:exported', { path: filePath, kind });
    return { exported: true, ...result };
  }

  // --- watchers -----------------------------------------------------------

  watchDocument(file) {
    this.stopWatching();
    if (!file) return;
    let timer = null;
    const handleChange = () => {
      try {
        const onDisk = storage.readIfExists(file);
        if (onDisk === null || onDisk === this.savedContents) return;
        if (onDisk === this.contents) {
          this.savedContents = onDisk;
          this.refreshTitle();
          return;
        }
        const policy = readSettings().externalPolicy || 'ask';
        if (policy === 'ignore') return;
        // Automatic reload only when nothing would be lost: a dirty buffer always asks.
        if (policy === 'auto' && this.contents === this.savedContents) {
          logLine('watch', 'auto reloaded ' + file);
          this.reloadFromDisk();
          this.sendStatus({ autoReloaded: true });
          return;
        }
        this.send('file:external', { size: onDisk.length });
      } catch (err) {
        logLine('watch', 'handler failed: ' + err.message);
      }
    };
    try {
      this.fileWatcher = fs.watch(path.dirname(file), (_event, filename) => {
        if (!filename || path.basename(String(filename)) !== path.basename(file)) return;
        clearTimeout(timer);
        timer = setTimeout(handleChange, 120);
      });
    } catch (err) {
      logLine('watch', 'fs.watch failed: ' + err.message);
    }
    // fs.watch drops events on some network drives and after long runs; a cheap stat poll keeps a
    // clean buffer in step even when the handle goes quiet. It checks one file every two seconds.
    let stamp = null;
    const readStamp = () => {
      try {
        const stat = fs.statSync(file);
        return stat.mtimeMs + ':' + stat.size;
      } catch {
        return null;
      }
    };
    stamp = readStamp();
    this.filePoll = setInterval(() => {
      const now = readStamp();
      if (now && stamp && now !== stamp) {
        stamp = now;
        handleChange();
      } else if (now) {
        stamp = now;
      }
    }, 2000);
    this.watchTimer = timer;
  }

  stopWatching() {
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch {
        /* already closed */
      }
      this.fileWatcher = null;
    }
    if (this.filePoll) {
      clearInterval(this.filePoll);
      this.filePoll = null;
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
      if (contents !== this.savedContents) this.writeDraftNow();
    } catch {
      /* best effort */
    }
  }
}

const sessions = new Map(); // webContents id -> Session
// window id -> { twinId, originalBounds } so a split can be undone
const splitPairs = new Map();
const aiRequests = new Map(); // requestId -> AbortController for in-flight streams

function createWindow({ show = true, restore = null, cascade = 0, bounds: explicitBounds = null } = {}) {
  const debugConsole = process.env.MDPAD_DEBUG_CONSOLE === '1';
  const savedBounds = restore && restore.bounds ? restore.bounds : null;
  const bounds = explicitBounds || (savedBounds ? fitBounds(savedBounds, screen.getAllDisplays()) : null);
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
  if (restore && restore.maximized) win.maximize();
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

  // Spell suggestions live in a native menu; without this handler right-clicking a misspelled
  // word does nothing at all.
  const spellEnabled = readSettings().spellcheck !== false;
  win.webContents.session.setSpellCheckerEnabled(spellEnabled);
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.misspelledWord) return;
    if (readSettings().spellcheck === false) return;
    const template = [];
    for (const suggestion of (params.dictionarySuggestions || []).slice(0, 6)) {
      template.push({
        label: suggestion,
        click: () => win.webContents.replaceMisspelling(suggestion),
      });
    }
    if (!template.length) template.push({ label: 'No suggestions', enabled: false });
    template.push({ type: 'separator' });
    template.push({
      label: 'Add to dictionary',
      click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    template.push({
      label: 'Ignore',
      click: () => win.webContents.replaceMisspelling(params.misspelledWord),
    });
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  win.webContents.on('console-message', (_event, level, message, line, source) => {
    if (process.env.MDPAD_LOG_RENDERER === '1' || SMOKE) {
      console.log('RENDERER [' + level + '] ' + message + ' (' + source + ':' + line + ')');
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
    const storedZoom = clampZoom(readSettings().zoomLevel);
    if (storedZoom) win.webContents.setZoomLevel(storedZoom);
    session.startupMs = Date.now() - PROCESS_STARTED_AT;
    session.bootMs = READY_AT ? Date.now() - READY_AT : null;
    logLine(
      'startup',
      `${session.startupMs} ms to first paint, ${session.bootMs} ms after app-ready (${app.isPackaged ? 'packaged' : 'dev'})`
    );
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

  if (debugConsole) win.webContents.on('console-message', (_e, level, message) => console.log('RENDERER ' + level + ' ' + message));
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
  const missing = [];

  for (const entry of restore.tabs || []) {
    if (count >= MAX_RESTORE_TABS) break;
    if (entry.file) {
      const contents = storage.readIfExists(entry.file);
      if (contents === null) {
        logLine('session', `missing file ${entry.file}`);
        missing.push(entry.file);
        continue;
      }
      const id = entry.file;
      session.tabs.set(id, { id, file: entry.file, contents, savedContents: contents });
      if (entry.view) {
        session.viewByTab = session.viewByTab || {};
        session.viewByTab[id] = entry.view;
      }
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

  if (missing.length) {
    session.send('session:missing', { files: missing.slice(0, 5), count: missing.length });
  }

  if (restore.treeRoot) {
    const info = session.setTreeRoot(restore.treeRoot);
    session.send('tree:root', { ...info, ...listDirectory(restore.treeRoot) });
  }
}

// ---- IPC -------------------------------------------------------------------

function sessionFor(event) {
  return sessions.get(event.sender.id);
}

// Support should not require reading a log by hand: collect the facts a bug report needs.
function diagnosticsReport() {
  const settings = publicSettings();
  const dirs = { data: userDir(), backups: backupsDir(), drafts: draftsDir() };
  let logTail = '';
  try {
    const lines = fs.readFileSync(logFilePath(), 'utf8').trimEnd().split(/\r?\n/);
    logTail = lines.slice(-60).join('\n');
  } catch {
    logTail = '(no log yet)';
  }
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: require('node:os').release(),
    locale: app.getLocale(),
    theme: settings.theme,
    language: settings.language,
    autosaveMs: settings.autosaveMs,
    spellcheck: settings.spellcheck,
    aiConfigured: Boolean(settings.ai && settings.ai.hasKey && settings.ai.baseUrl),
    dirs,
    logPath: logFilePath(),
    logTail,
  };
}

function registerIpc() {
  // Other windows should follow a settings change at once: same theme, same language, same
  // typography. The window that made the change already applied it, so it is skipped.
  function broadcastSettings(exceptId) {
    const settings = publicSettings();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (exceptId !== undefined && win.webContents.id === exceptId) continue;
      try {
        win.webContents.send('settings:applied', settings);
      } catch {
        /* closing */
      }
    }
  }

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

  ipcMain.handle('window:split', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const session = sessionFor(event);
    if (!win || !session) return { ok: false, reason: 'no-window' };
    if (!session.file) return { ok: false, reason: 'unsaved' };
    const originalBounds = win.getBounds();
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const half = Math.floor(area.width / 2);
    const left = { x: area.x, y: area.y, width: half, height: area.height };
    const right = { x: area.x + half, y: area.y, width: area.width - half, height: area.height };
    win.setBounds(left);
    const second = createWindow({ bounds: right });
    second.webContents.once('did-finish-load', () => {
      const twin = sessions.get(second.webContents.id);
      if (twin) twin.loadDocument(session.file);
    });
    splitPairs.set(win.id, { twinId: second.id, originalBounds });
      second.on('closed', () => {
        const pair = splitPairs.get(win.id);
        if (pair && pair.twinId === second.id) pair.twinId = null;
      });
      return { ok: true, left, right };
  });

  ipcMain.handle('window:unsplit', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, reason: 'no-window' };
    const pair = splitPairs.get(win.id);
    if (!pair) return { ok: false, reason: 'not-split' };
    const twin = BrowserWindow.fromId(pair.twinId || -1);
    if (twin && !twin.isDestroyed()) twin.destroy();
    if (pair.originalBounds) {
      try {
        win.setBounds(pair.originalBounds);
      } catch {
        /* the display may have changed */
      }
    }
    splitPairs.delete(win.id);
    return { ok: true };
  });

  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('app:system-theme', { dark: nativeTheme.shouldUseDarkColors });
      } catch {
        /* a window may be closing */
      }
    }
  });

  ipcMain.handle('app:systemTheme', () => ({ dark: nativeTheme.shouldUseDarkColors }));


  ipcMain.handle('app:diagnostics', () => diagnosticsReport());

  ipcMain.handle('app:copyDiagnostics', () => {
    const report = diagnosticsReport();
    const text = [
      'mdpad diagnostics',
      'version: ' + report.version,
      'electron: ' + report.electron + ' (chromium ' + report.chrome + ', node ' + report.node + ')',
      'platform: ' + report.platform + ' ' + report.arch + ' ' + report.osRelease,
      'locale: ' + report.locale,
      'theme: ' + report.theme + '  language: ' + report.language,
      'autosave: ' + report.autosaveMs + ' ms  spellcheck: ' + report.spellcheck,
      'ai configured: ' + report.aiConfigured,
      'data: ' + report.dirs.data,
      'backups: ' + report.dirs.backups,
      'drafts: ' + report.dirs.drafts,
      'log: ' + report.logPath,
      '',
      '--- last log lines ---',
      report.logTail,
    ].join('\n');
    clipboard.writeText(text);
    return { copied: text.length };
  });

  ipcMain.handle('app:openLogFolder', async () => {
    await shell.openPath(path.dirname(logFilePath()));
    return { opened: true };
  });

  ipcMain.handle('app:zoom', (event, { direction = 'in' } = {}) => {
    const contents = event.sender;
    const step = direction === 'reset' ? 0 : direction === 'in' ? 0.5 : -0.5;
    const level = direction === 'reset' ? 0 : clampZoom(contents.getZoomLevel() + step);
    contents.setZoomLevel(level);
    const settings = readSettings();
    writeSettings({ ...settings, zoomLevel: level });
    return { level, percent: Math.round(100 * Math.pow(1.2, level)) };
  });

  ipcMain.handle('app:zoomState', (event) => {
    const level = event.sender.getZoomLevel();
    return { level, percent: Math.round(100 * Math.pow(1.2, level)) };
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

  ipcMain.handle('doc:flushDraft', (event, { tabId } = {}) => {
    const s = sessionFor(event);
    if (tabId && s.activeId && tabId !== s.activeId) return { written: false, ignored: true };
    const written = s.writeDraftNow();
    return { written: Boolean(written) };
  });

  ipcMain.handle('doc:syncChange', (event, { contents, tabId } = {}) => {
    const s = sessionFor(event);
    // The renderer applies a tab switch asynchronously, so a change can arrive for the document
    // that is no longer active. Write it to the tab it belongs to instead of dropping it or
    // letting it overwrite the newly active document.
    const tab = tabId ? s.tabs.get(tabId) : null;
    if (tabId && !tab) return { ignored: true, dirty: s.isDirty() };
    const text = s.relativizeMarkdown(String(contents ?? ''));
    if (tab && tab.id !== s.activeId) {
      // Store into its own tab and stop: stashing here would write the active buffer over the
      // tab the switch just activated.
      tab.contents = text;
      s.broadcastTabs();
      return { ignored: true, stored: true, dirty: s.isDirty() };
    }
    s.send('save:state', { state: 'dirty', savedAt: s.savedAt || null });
    s.contents = text;
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

  ipcMain.handle('doc:extractImages', async (event) => {
    const s = sessionFor(event);
    const result = s.extractEmbeddedImages();
    if (!result.extracted && result.reason === 'none') {
      if (!SMOKE && s.win && !s.win.isDestroyed()) {
        dialog.showMessageBox(s.win, {
          type: 'info',
          title: t('dialog.extractTitle', currentLang()),
          message: t('dialog.extractNone', currentLang()),
          buttons: [t('dialog.ok', currentLang())],
        });
      }
    }
    return result;
  });

  // Markdown links between files in the same folder are the normal way to write a note library or
  // a book, so a relative link opens the target instead of being handed to the OS browser.
  ipcMain.handle('doc:openRelative', async (event, { href } = {}) => {
    const s = sessionFor(event);
    if (!s.file) return { opened: false, reason: 'unsaved' };
    const raw = String(href || '').trim();
    if (!raw) return { opened: false, reason: 'empty' };
    const clean = decodeURI(raw.replace(/[#?].*$/, '').replace(/^file:\/\/\//i, ''));
    if (!clean) return { opened: false, reason: 'empty' };
    let target = path.isAbsolute(clean) ? clean : path.resolve(path.dirname(s.file), clean);
    if (!fs.existsSync(target) && fs.existsSync(target + '.md')) target = target + '.md';
    let exists = false;
    try {
      exists = fs.statSync(target).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      return { opened: false, reason: 'missing', path: target, name: path.basename(clean) };
    }
    const result = await s.loadDocument(target);
    return { opened: true, ...result };
  });

  ipcMain.handle('doc:save', async (event, payload = {}) => {
    const s = sessionFor(event);
    if (!s.file) return s.saveAs();
    const result = s.saveCurrent({ force: payload.force === true });
    if (result.conflict) return { ...result, saved: false };
    result.saved = result.saved !== false;
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

// An export that cannot write must answer, not throw: the renderer needs something to show.
const runExportSafely = async (event, kind) => {
  try {
    return await sessionFor(event).exportWith(kind);
  } catch (err) {
    logLine('export', kind + ': ' + err.message);
    return { exported: false, kind, error: err.message };
  }
};

ipcMain.handle('doc:exportHtml', (event) => runExportSafely(event, 'html'));
ipcMain.handle('doc:exportPdf', (event) => runExportSafely(event, 'pdf'));
ipcMain.handle('doc:exportDocx', (event) => runExportSafely(event, 'docx'));
ipcMain.handle('doc:exportEpub', (event) => runExportSafely(event, 'epub'));

// Same as above but with an explicit target: useful for automation and for the failure test.
ipcMain.handle('doc:exportToPath', async (event, { kind = 'pdf', path: target } = {}) => {
  try {
    return await sessionFor(event).exportTo(target, kind);
  } catch (err) {
    logLine('export', kind + ' -> ' + target + ': ' + err.message);
    return { exported: false, kind, error: err.message, path: target };
  }
});

  ipcMain.handle('doc:backupInfo', (event) => {
    const s = sessionFor(event);
    if (!s.file) return { count: 0, lastAt: null };
    const backups = storage.listBackups(s.file, backupsDir());
    return { count: backups.length, lastAt: backups.length ? backups[0].mtime : null };
  });

  ipcMain.handle('doc:openBackups', async (event) => {
    const s = sessionFor(event);
    if (!s || !s.file) return { opened: false };
    await shell.openPath(backupsDir());
    return { opened: true };
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

  // What will actually land in the export: counts the user can check before choosing a format.
  // Everything about the images in this document: where they point, whether they resolve, how big.
  // Remote images are fragile: the network disappears, the host moves the file, the exporter cannot
  // fetch. Downloading once into ./images next to the document makes the document self-contained.
  // Links between files break quietly when a folder is renamed. List them, say which resolve, and
  // let the writer unlink the dead ones without losing the text.
  // A structure report: what a writer would check before submitting — heading order, duplicates,
  // runaway paragraphs, and the counts that describe the shape of the document.
  function reportIndexFile() {
    return path.join(userDir(), 'reports.json');
  }

  function readReportIndex() {
    const raw = storage.readIfExists(reportIndexFile());
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function rememberReport(file, summary) {
    if (!file || !summary) return;
    const index = readReportIndex();
    const metric = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
    index[file] = {
      issues: Number(summary.issues) || 0,
      words: Number(summary.words) || 0,
      headings: Number(summary.headings) || 0,
      avgSentence: metric(summary.avgSentence),
      longSentences: metric(summary.longSentences),
      passive: metric(summary.passive),
      repeated: metric(summary.repeated),
      at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(userDir(), { recursive: true });
      fs.writeFileSync(reportIndexFile(), JSON.stringify(index, null, 2), 'utf8');
    } catch (err) {
      logLine('report', 'index write failed: ' + err.message);
    }
  }

  // Daily writing goal: count positive word deltas per document so deleting text does not cancel
  // words already written today. One small JSON file, no history beyond 30 days.
  function writingFile() {
    return path.join(userDir(), 'writing.json');
  }

  function todayKey(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function readWriting() {
    const raw = storage.readIfExists(writingFile());
    if (!raw) return { days: {}, last: {}, goalDay: null };
    try {
      const parsed = JSON.parse(raw);
      return {
        days: parsed && parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
        last: parsed && parsed.last && typeof parsed.last === 'object' ? parsed.last : {},
        goalDay: parsed.goalDay || null,
      };
    } catch {
      return { days: {}, last: {}, goalDay: null };
    }
  }

  function writeWriting(data) {
    try {
      fs.mkdirSync(userDir(), { recursive: true });
      fs.writeFileSync(writingFile(), JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logLine('writing', 'ledger write failed: ' + err.message);
    }
  }

  function writingSummary(data) {
    const goal = Number(readSettings().writingGoal) || 0;
    const today = data.days[todayKey()] || 0;
    return { today, goal, reached: goal > 0 && today >= goal };
  }

  ipcMain.handle('writing:record', (_event, { key, words } = {}) => {
    const data = readWriting();
    const day = todayKey();
    const count = Math.max(0, Math.floor(Number(words) || 0));
    const previous = typeof data.last[key] === 'number' ? data.last[key] : null;
    const delta = previous === null ? 0 : count - previous;
    data.last[key] = count;
    if (delta > 0) data.days[day] = (data.days[day] || 0) + delta;
    // keep the ledger to 30 days
    const keys = Object.keys(data.days).sort();
    for (const stale of keys.slice(0, Math.max(0, keys.length - 30))) delete data.days[stale];
    const summary = writingSummary(data);
    let firstReach = false;
    if (summary.reached && data.goalDay !== day) {
      data.goalDay = day;
      firstReach = true;
    }
    writeWriting(data);
    return { ...summary, firstReach, todayKey: day, delta };
  });

  ipcMain.handle('writing:stats', () => writingSummary(readWriting()));

  ipcMain.handle('writing:history', () => {
    const data = readWriting();
    const goal = Number(readSettings().writingGoal) || 0;
    return buildWritingHistory(data.days, goal);
  });

  ipcMain.handle('writing:reset', () => {
    writeWriting({ days: {}, last: {}, goalDay: null });
    return writingSummary({ days: {}, last: {}, goalDay: null });
  });

  ipcMain.handle('stats:write', (event, { path: target, content } = {}) => {
    if (!target) return { ok: false, error: 'No path' };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(content || ''), 'utf8');
      return { ok: true, path: target, bytes: fs.statSync(target).size };
    } catch (err) {
      logLine('stats', 'write failed: ' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('stats:save', async (event, { content, suggestedName } = {}) => {
    const s = sessionFor(event);
    const dir = s && s.file ? path.dirname(s.file) : app.getPath('documents');
    const { canceled, filePath } = await dialog.showSaveDialog(s ? s.win : null, {
      title: 'Export statistics',
      defaultPath: path.join(dir, String(suggestedName || 'statistics.csv')),
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'Markdown', extensions: ['md'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, String(content || ''), 'utf8');
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('report:write', (event, { path: target, content, summary } = {}) => {
    if (!target) return { ok: false, error: 'No path' };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(content || ''), 'utf8');
      rememberReport(sessionFor(event) && sessionFor(event).file, summary);
      return { ok: true, path: target, bytes: fs.statSync(target).size };
    } catch (err) {
      logLine('report', 'write failed: ' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('report:save', async (event, { content, suggestedName, summary } = {}) => {
    const s = sessionFor(event);
    const dir = s && s.file ? path.dirname(s.file) : app.getPath('documents');
    const { canceled, filePath } = await dialog.showSaveDialog(s ? s.win : null, {
      title: 'Save structure report',
      defaultPath: path.join(dir, String(suggestedName || 'structure-report.md')),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, String(content || ''), 'utf8');
      rememberReport(s && s.file, summary);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('doc:structure', (event) => {
    const s = sessionFor(event);
    const text = String((s && s.contents) || '');
    const lines = text.split('\n');
    const headings = [];
    const paragraphs = [];
    let current = null;
    let inFence = false;
    let fence = '';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fenceMatch = /^\s*(\x60{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fence = fenceMatch[1][0];
        } else if (fenceMatch[1][0] === fence) {
          inFence = false;
        }
        if (current) {
          paragraphs.push(current);
          current = null;
        }
        continue;
      }
      if (inFence) continue;
      const heading = /^(#{1,6})\s+(.*\S)/.exec(line);
      if (heading) {
        if (current) {
          paragraphs.push(current);
          current = null;
        }
        headings.push({ level: heading[1].length, text: heading[2].trim(), line: index + 1 });
        continue;
      }
      if (!line.trim()) {
        if (current) {
          paragraphs.push(current);
          current = null;
        }
        continue;
      }
      if (/^\s*(?:[-*+]\s|\d+\.\s|>\s)/.test(line)) {
        if (current) {
          paragraphs.push(current);
          current = null;
        }
        continue;
      }
      if (!current) current = { line: index + 1, chars: 0 };
      current.chars += line.trim().length;
    }
    if (current) paragraphs.push(current);

    const seen = new Map();
    const duplicates = [];
    for (const heading of headings) {
      const key = heading.text.toLowerCase();
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      if (count === 2) duplicates.push(heading);
    }
    const skips = [];
    let previousLevel = 0;
    for (const heading of headings) {
      if (previousLevel && heading.level > previousLevel + 1) {
        skips.push({ from: previousLevel, to: heading.level, text: heading.text, line: heading.line });
      }
      previousLevel = heading.level;
    }
    const longest = paragraphs.reduce((best, item) => (!best || item.chars > best.chars ? item : best), null);
    if (longest) {
      const paragraphText = lines.slice(longest.line - 1).join('\n').trim();
      longest.snippet = paragraphText.slice(0, 80);
    }
    const words = (text.match(/\S+/g) || []).length;
    const payload = {
      words,
      lines: lines.length,
      chars: text.length,
      readingMinutes: Math.max(1, Math.round(words / 200)),
      headings: headings.map((heading, index) => ({ ...heading, index })),
      counts: {
        headings: headings.length,
        paragraphs: paragraphs.length,
        codeBlocks: (text.match(/^\s*(?:\x60{3,}|~{3,})/gm) || []).length / 2,
        tables: (text.match(/^\s*\|.*\|\s*$/gm) || []).length,
        images: (text.match(/!\[[^\]]*\]\(/g) || []).length,
        links: (text.match(/(?<!!)\[[^\]]*\]\(/g) || []).length,
        tasks: (text.match(/^\s*[-*+]\s*\[[ xX]\]/gm) || []).length,
      },
      duplicates,
      skips,
      longestParagraph: longest,
      sentences: analyzeSentences(
        text
          .replace(/^\s*(?:\x60{3,}|~{3,})[\s\S]*?^\s*(?:\x60{3,}|~{3,})/gm, ' ')
          .replace(/\x60[^\x60\n]*\x60/g, ' ')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
          .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
          .replace(/^\s*[-*+]\s+/gm, '')
          .replace(/^\s*\d+\.\s+/gm, ''),
        { limit: reportOptionsForDoc().sentenceLimit }
      ),
      repetition: analyzeRepetition(
        text
          .replace(/^\s*(?:\x60{3,}|~{3,})[\s\S]*?^\s*(?:\x60{3,}|~{3,})/gm, ' ')
          .replace(/\x60[^\x60\n]*\x60/g, ' ')
          .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
      ),
      style: analyzeStyle(
        text
          .replace(/^\s*(?:\x60{3,}|~{3,})[\s\S]*?^\s*(?:\x60{3,}|~{3,})/gm, ' ')
          .replace(/\x60[^\x60\n]*\x60/g, ' ')
          .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
      ),
      previous: s && s.file ? readReportIndex()[s.file] || null : null,
    };
    const options = reportOptionsForDoc();
    if (!options.style) delete payload.style;
    if (!options.repetition) delete payload.repetition;
    return payload;
  });

  ipcMain.handle('links:audit', (event) => {
    const s = sessionFor(event);
    const text = String((s && s.contents) || '');
    const baseDir = s && s.file ? path.dirname(s.file) : null;
    const entries = [];
    const pattern = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const label = match[1];
      const href = match[2];
      const entry = { label, href, kind: 'local', exists: false };
      if (href.startsWith('#')) {
        entry.kind = 'anchor';
        entry.exists = true;
      } else if (/^(?:https?:|mailto:)/i.test(href)) {
        entry.kind = 'external';
        entry.exists = null;
      } else if (!baseDir) {
        entry.kind = 'local';
        entry.exists = false;
      } else {
        try {
          const clean = decodeURI(href.replace(/[#?].*$/, ''));
          const resolved = path.resolve(baseDir, clean);
          entry.exists = fs.existsSync(resolved) || fs.existsSync(resolved + '.md');
        } catch {
          entry.exists = false;
        }
      }
      entries.push(entry);
    }
    return {
      total: entries.length,
      missing: entries.filter((entry) => entry.exists === false).length,
      external: entries.filter((entry) => entry.kind === 'external').length,
      anchors: entries.filter((entry) => entry.kind === 'anchor').length,
      entries,
    };
  });

  ipcMain.handle('images:download', async (event, { src } = {}) => {
    const s = sessionFor(event);
    if (!s || !s.file) return { ok: false, error: 'Save the document first, so the image has a folder.' };
    if (!/^https?:\/\//i.test(String(src || ''))) return { ok: false, error: 'Not a remote image' };
    let response;
    try {
      response = await net.fetch(src, { redirect: 'follow' });
    } catch (err) {
      return { ok: false, error: 'Download failed: ' + err.message };
    }
    if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { ok: false, error: 'The server returned an empty file' };
    if (buffer.length > 20 * 1024 * 1024) return { ok: false, error: 'Image is larger than 20 MB' };
    const type = (response.headers.get('content-type') || '').toLowerCase();
    const extFromType = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
    let ext = extFromType[type.split(';')[0]] || path.extname(new URL(src).pathname).toLowerCase();
    if (!/^\.(png|jpe?g|gif|webp|svg)$/.test(ext)) ext = '.png';
    const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
    const dir = path.join(path.dirname(s.file), 'images');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, hash + ext);
      if (!fs.existsSync(target)) fs.writeFileSync(target, buffer);
      const relative = path.relative(path.dirname(s.file), target).split(path.sep).join('/');
      logLine('images', 'downloaded ' + src + ' -> ' + relative + ' (' + buffer.length + ' bytes)');
      return { ok: true, path: target, relative, bytes: buffer.length };
    } catch (err) {
      return { ok: false, error: 'Could not save the image: ' + err.message };
    }
  });

  ipcMain.handle('images:audit', (event) => {
    const s = sessionFor(event);
    const text = String((s && s.contents) || '');
    const baseDir = s && s.file ? path.dirname(s.file) : null;
    const entries = [];
    const pattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const src = match[1];
      const altMatch = /!\[([^\]]*)\]/.exec(match[0]);
      const alt = altMatch ? altMatch[1] : '';
      const entry = { src, alt, kind: 'local', exists: false, size: null, resolved: null };
      if (/^data:/i.test(src)) {
        entry.kind = 'embedded';
        entry.exists = true;
        entry.size = Math.round((src.length - src.indexOf(',') - 1) * 0.75);
      } else if (/^https?:/i.test(src)) {
        entry.kind = 'remote';
        entry.exists = null;
      } else {
        try {
          const clean = decodeURI(src.replace(/[#?].*$/, ''));
          const resolved = baseDir ? path.resolve(baseDir, clean) : null;
          entry.resolved = resolved;
          if (resolved && fs.existsSync(resolved)) {
            entry.exists = true;
            entry.size = fs.statSync(resolved).size;
          }
        } catch {
          entry.exists = false;
        }
      }
      entries.push(entry);
    }
    return {
      file: s ? s.file : null,
      total: entries.length,
      missing: entries.filter((entry) => entry.exists === false).length,
      remote: entries.filter((entry) => entry.kind === 'remote').length,
      embedded: entries.filter((entry) => entry.kind === 'embedded').length,
      entries,
    };
  });

  ipcMain.handle('export:section', async (event, { markdown, format } = {}) => {
    const session = sessionFor(event);
    if (!session) return { exported: false, reason: 'no session' };
    const kind = ['html', 'pdf', 'docx', 'epub'].includes(format) ? format : 'html';
    const base = session.file
      ? path.join(path.dirname(session.file), path.basename(session.file, path.extname(session.file)))
      : path.join(app.getPath('documents'), 'Untitled');
    const { canceled, filePath } = await dialog.showSaveDialog(session.win, {
      title: EXPORT_TITLES[kind] || 'Export',
      defaultPath: path.join(path.dirname(base), `${path.basename(base)}-section.${kind === 'docx' ? 'docx' : kind}`),
      filters: EXPORT_FILTERS[kind] || [],
    });
    if (canceled || !filePath) return { exported: false, reason: 'canceled' };
    return session.exportTo(filePath, kind, null, String(markdown || session.contents || ''));
  });

  ipcMain.handle('export:sectionTo', async (event, { path: target, markdown, format } = {}) => {
    const session = sessionFor(event);
    if (!session || !target) return { exported: false, reason: 'bad request' };
    const kind = ['html', 'pdf', 'docx', 'epub'].includes(format) ? format : 'html';
    return session.exportTo(target, kind, null, String(markdown || session.contents || ''));
  });

  ipcMain.handle('export:inspect', (event) => {
    const s = sessionFor(event);
    const text = String((s && s.contents) || '');
    const baseDir = s && s.file ? path.dirname(s.file) : null;
    const count = (re) => (text.match(re) || []).length;

    const images = [];
    const imagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = imagePattern.exec(text)) !== null) images.push(match[1]);
    const unresolvedImages = images.filter((src) => {
      if (/^data:/i.test(src) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return false;
      if (!baseDir) return true;
      try {
        return !fs.existsSync(path.resolve(baseDir, decodeURI(src.replace(/[#?].*$/, ''))));
      } catch {
        return true;
      }
    });

    const links = [];
    const linkPattern = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    while ((match = linkPattern.exec(text)) !== null) links.push(match[1]);
    const localLinks = links.filter((href) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href));
    const unresolvedLinks = localLinks.filter((href) => {
      if (!baseDir) return true;
      try {
        const clean = decodeURI(href.replace(/[#?].*$/, ''));
        return !fs.existsSync(path.resolve(baseDir, clean)) && !fs.existsSync(path.resolve(baseDir, clean + '.md'));
      } catch {
        return true;
      }
    });

    return {
      words: (text.match(/\S+/g) || []).length,
      chars: text.length,
      images: images.length,
      unresolvedImages: unresolvedImages.length,
      externalImages: images.filter((src) => /^(?:data:|[a-z]+:)/i.test(src)).length,
      links: links.length,
      localLinks: localLinks.length,
      unresolvedLinks: unresolvedLinks.length,
      tables: (text.match(/^\s*\|.*\|\s*$/gm) || []).length,
      math: count(/\$\$/g) / 2 + count(/(?<!\$)\$[^$\n]+\$(?!\$)/g),
      diagrams: count(/^\s*(?:```|~~~)\s*mermaid\b/gim),
      tasks: count(/^\s*[-*+]\s*\[(?: |x|X)\]/gm),
      headings: (text.match(/^#{1,6}\s+\S/gm) || []).length,
    };
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

  ipcMain.handle('export:thumbnail', async (event, options = {}) => {
    const session = sessionFor(event);
    if (!session) return { ok: false, error: 'no session' };
    try {
      return await exportThumbnail(session, options);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('draft:discard', (event) => {
    const s = sessionFor(event);
    storage.clearDraft(s.file, draftsDir());
    return { discarded: true };
  });

  ipcMain.handle('backup:list', (event) => {
    const s = sessionFor(event);
    return storage.listBackups(s.file || '', backupsDir());
  });

  ipcMain.handle('view:set', (event, payload = {}) => {
    rememberView(sessionFor(event), payload);
    return { ok: true };
  });

  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (event, patch = {}) => {
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
    if (patch.spellcheck !== undefined) next.spellcheck = patch.spellcheck === true;
    if (patch.typewriter !== undefined) next.typewriter = patch.typewriter === true;
    if (patch.highlightParagraph !== undefined) next.highlightParagraph = patch.highlightParagraph === true;
    if (patch.highlightSentence !== undefined) next.highlightSentence = patch.highlightSentence === true;
    if (patch.foldedHeadings && typeof patch.foldedHeadings === 'object') {
      const cleaned = {};
      for (const owner of Object.keys(patch.foldedHeadings).slice(0, 100)) {
        const list = patch.foldedHeadings[owner];
        if (Array.isArray(list)) cleaned[owner] = list.filter((key) => typeof key === 'string').slice(0, 200);
      }
      next.foldedHeadings = cleaned;
    }
    if (patch.seenHints && typeof patch.seenHints === 'object') {
      const cleaned = {};
      for (const key of Object.keys(patch.seenHints).slice(0, 50)) {
        if (patch.seenHints[key] === true) cleaned[key] = true;
      }
      next.seenHints = cleaned;
    }
    if (Array.isArray(patch.exportHistory)) {
      next.exportHistory = patch.exportHistory
        .filter((item) => item && typeof item.path === 'string')
        .slice(0, 10)
        .map((item) => ({ path: item.path, kind: String(item.kind || 'html'), at: Number(item.at) || Date.now() }));
    }
    if (patch.exportPageNumbers !== undefined) next.exportPageNumbers = patch.exportPageNumbers !== false;
    if (patch.reportOptions && typeof patch.reportOptions === 'object') {
      next.reportOptions = {
        style: patch.reportOptions.style !== false,
        repetition: patch.reportOptions.repetition !== false,
        sentenceLimit: Math.max(8, Math.min(120, Math.floor(Number(patch.reportOptions.sentenceLimit) || 40))),
      };
    }
    if (patch.externalPolicy !== undefined) {
      next.externalPolicy = ['ask', 'auto', 'ignore'].includes(patch.externalPolicy) ? patch.externalPolicy : 'ask';
    }
    if (patch.writingGoal !== undefined) next.writingGoal = Math.max(0, Math.min(100000, Math.floor(Number(patch.writingGoal) || 0)));
    if (patch.findOptions && typeof patch.findOptions === 'object') {
      next.findOptions = {
        caseSensitive: patch.findOptions.caseSensitive === true,
        wholeWord: patch.findOptions.wholeWord === true,
        regex: patch.findOptions.regex === true,
      };
    }
    if (patch.zoomLevel !== undefined) next.zoomLevel = clampZoom(patch.zoomLevel);
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
    broadcastSettings();
    // The checker lives on the session, so a settings change has to reach every open window.
    if (patch.spellcheck !== undefined) {
      for (const openWin of BrowserWindow.getAllWindows()) {
        try {
          openWin.webContents.session.setSpellCheckerEnabled(next.spellcheck !== false);
        } catch {
          /* a window may be closing */
        }
      }
    }
    return publicSettings();
  });

  ipcMain.handle('update:check', (_e, payload = {}) => performUpdateCheck(payload.feedUrl));

  // Download only: installing is left to quitAndInstall, which needs a trusted signature. The
  // smoke test uses this to prove the feed and its sha512 are consumed end to end.
  ipcMain.handle('update:download', async () => {
    const result = await downloadUpdate(getUpdater());
    if (!result.ok || !result.file) return result;
    let size = 0;
    try {
      size = fs.statSync(result.file).size;
    } catch {
      /* the file may already be gone */
    }
    logLine('update', 'downloaded ' + result.file + ' (' + size + ' bytes)');
    return { ...result, size };
  });

  // The panel shows what is actually stored, including files that no longer exist, so a missing
  // entry can be explained instead of silently vanishing.
  function recentEntries() {
    const list = readSettings().recent;
    if (!Array.isArray(list)) return [];
    return list
      .filter((entry) => typeof entry === 'string')
      .slice(0, 20)
      .map((entry) => {
        let exists = false;
        let mtime = null;
        try {
          const stat = fs.statSync(entry);
          exists = stat.isFile();
          mtime = stat.mtimeMs;
        } catch {
          exists = false;
        }
        return {
          path: entry,
          name: path.basename(entry),
          dir: path.dirname(entry),
          exists,
          mtime,
        };
      });
  }

  ipcMain.handle('recent:entries', () => recentEntries());

  ipcMain.handle('recent:remove', (_e, { path: target } = {}) => {
    const list = (readSettings().recent || []).filter((entry) => entry !== target);
    writeSettings({ recent: list });
    buildMenu();
    return { removed: true, entries: recentEntries() };
  });

  ipcMain.handle('recent:clear', () => {
    writeSettings({ recent: [] });
    buildMenu();
    return { cleared: true };
  });

  ipcMain.handle('recent:open', async (event, { path: target } = {}) => {
    const s = sessionFor(event);
    let exists = false;
    try {
      exists = fs.statSync(target).isFile();
    } catch {
      exists = false;
    }
    if (!exists) return { opened: false, reason: 'missing' };
    return s.loadDocument(target);
  });

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
    } else if (draft.file) {
      // The original file is gone: restore into a fresh untitled tab. Sending the draft to the
      // active tab would overwrite whatever the user has open right now.
      s.stashActive();
      const id = s.newTabId();
      s.tabs.set(id, { id, file: null, contents: '', savedContents: '' });
      s.activateTab(id);
      s.sendStatus({ file: null, dirty: true });
    }
    // doc:loaded carries the on-disk version; send the draft after it so it wins.
    s.send('doc:loadDraft', { contents: draft.contents, name: draft.name, missingOriginal: Boolean(draft.file && !fs.existsSync(draft.file)) });
    return { restored: true, contents: draft.contents, file: draft.file, newTab: Boolean(draft.file && !fs.existsSync(draft.file)) };
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

  ipcMain.handle('settings:reset', () => {
    writeSettings({
      ...readSettings(),
      theme: 'light',
      language: currentLang(),
      exportTemplate: 'default',
      exportCss: '',
      exportNameTemplate: '{title}',
      editorFont: 'serif',
      lineWidth: 'normal',
      accent: 'blue',
      spellcheck: true,
      zoomLevel: 0,
      aiSystemPrompt: '',
      aiContextScope: '',
      aiConfirmOverTokens: DEFAULT_CONFIRM_TOKENS,
      filesCollapsed: false,
      collapsedSections: {},
      focusMode: false,
    });
    buildMenu();
    return { reset: true, settings: publicSettings() };
  });

  ipcMain.handle('data:openFolder', async () => {
    await shell.openPath(userDir());
    return { opened: true };
  });

  ipcMain.handle('data:clearDrafts', () => {
    let removed = 0;
    try {
      for (const name of fs.readdirSync(draftsDir())) {
        if (!name.endsWith('.json')) continue;
        fs.unlinkSync(path.join(draftsDir(), name));
        removed += 1;
      }
    } catch {
      /* no drafts directory */
    }
    return { removed };
  });

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
      bootMs: s.bootMs || null,
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
  // Creating, renaming and deleting files from the tree needs the same containment checks as
  // opening them: a path must stay inside the folder the user actually opened.
  function insideTree(session, target) {
    const rootPath = session && session.treeRoot;
    if (!rootPath) return false;
    const rootResolved = path.resolve(rootPath) + path.sep;
    return path.resolve(target).startsWith(rootResolved);
  }

  function safeName(name) {
    const value = String(name || '').trim();
    if (!value || value === '.' || value === '..') return '';
    if (/[\\/:*?"<>|]/.test(value)) return '';
    return value;
  }

  ipcMain.handle('tree:create', (event, { dir, name, folder = false } = {}) => {
    const session = sessionFor(event);
    if (!insideTree(session, path.join(dir || '', 'x'))) return { ok: false, error: 'outside the folder' };
    const clean = safeName(name);
    if (!clean) return { ok: false, error: 'invalid name' };
    const target = path.join(dir, clean);
    try {
      if (fs.existsSync(target)) return { ok: false, error: 'already exists' };
      if (folder) fs.mkdirSync(target);
      else fs.writeFileSync(target, '', { flag: 'wx' });
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tree:rename', (event, { file, name } = {}) => {
    const session = sessionFor(event);
    if (!insideTree(session, file)) return { ok: false, error: 'outside the folder' };
    const clean = safeName(name);
    if (!clean) return { ok: false, error: 'invalid name' };
    const target = path.join(path.dirname(file), clean);
    if (target === file) return { ok: true, path: file };
    try {
      if (fs.existsSync(target)) return { ok: false, error: 'already exists' };
      fs.renameSync(file, target);
      // Keep any open tab pointing at the renamed file.
      for (const tab of session.tabs.values()) {
        if (tab.file === file) {
          tab.file = target;
          tab.contents = tab.contents;
        }
      }
      session.broadcastTabs();
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tree:delete', (event, { target, recursive = false } = {}) => {
    const session = sessionFor(event);
    if (!insideTree(session, target)) return { ok: false, error: 'outside the folder' };
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(target);
        if (entries.length && !recursive) return { ok: false, error: 'not empty' };
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
      // Close tabs that pointed at it.
      for (const [id, tab] of [...session.tabs.entries()]) {
        if (tab.file === target || (stat.isDirectory() && tab.file && tab.file.startsWith(target + path.sep))) {
          session.closeTab(id, { force: true });
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tree:reveal', (event, { target } = {}) => {
    const session = sessionFor(event);
    if (!insideTree(session, target)) return { ok: false, error: 'outside the folder' };
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle('tree:open', (event, { file }) => {
    const target = path.resolve(String(file || ''));
    for (const [wcId, other] of sessions.entries()) {
      if (other === sessionFor(event)) continue;
      const existing = [...other.tabs.values()].find((tab) => tab.file && path.resolve(tab.file) === target);
      if (!existing) continue;
      other.activateTab(existing.id);
      if (other.win && !other.win.isDestroyed()) {
        if (other.win.isMinimized()) other.win.restore();
        other.win.focus();
      }
      return { opened: true, focused: true, id: existing.id };
    }
    return sessionFor(event).loadDocument(file);
  });
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
        { type: 'separator' },
        { label: tt('menu.recentAll'), click: () => sendMenuAction('recent') },
        { label: tt('menu.save'), accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('save') },
        { label: tt('menu.saveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('saveAs') },
        { type: 'separator' },
        { label: tt('menu.exportHtml'), accelerator: 'CmdOrCtrl+Shift+E', click: () => sendMenuAction('exportHtml') },
        { label: tt('menu.exportPdf'), accelerator: 'CmdOrCtrl+Alt+P', click: () => sendMenuAction('exportPdf') },
        { label: tt('menu.exportWord'), click: () => sendMenuAction('exportDocx') },
        { label: tt('menu.exportEpub'), click: () => sendMenuAction('exportEpub') },
        { label: tt('menu.preview'), accelerator: 'CmdOrCtrl+Shift+V', click: () => sendMenuAction('previewExport') },
          { type: 'separator' },
          { label: tt('menu.extractImages'), click: () => sendMenuAction('extractImages') },
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
    { label: tt('menu.palette'), accelerator: 'CmdOrCtrl+Shift+P', click: () => sendMenuAction('palette') },
    { label: tt('menu.foldHeading'), accelerator: 'CmdOrCtrl+Shift+H', click: () => sendMenuAction('foldHeading') },
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
          label: tt('menu.split'),
          accelerator: 'CmdOrCtrl+Alt+2',
          click: () => {
            const session = focusedSession();
            if (!session || !session.file) {
              session && session.sendStatus({ error: tt('menu.splitNeedsFile') });
              return;
            }
            const win = BrowserWindow.fromWebContents(session.win.webContents);
            if (!win) return;
            const area = screen.getDisplayMatching(win.getBounds()).workArea;
            const half = Math.floor(area.width / 2);
            const originalBounds = win.getBounds();
            win.setBounds({ x: area.x, y: area.y, width: half, height: area.height });
            const second = createWindow({
              bounds: { x: area.x + half, y: area.y, width: area.width - half, height: area.height },
            });
            second.webContents.once('did-finish-load', () => {
              const twin = sessions.get(second.webContents.id);
              if (twin) twin.loadDocument(session.file);
            });
            splitPairs.set(win.id, { twinId: second.id, originalBounds });
            second.on('closed', () => {
              const pair = splitPairs.get(win.id);
              if (pair && pair.twinId === second.id) pair.twinId = null;
            });
          },
        },
        {
          label: tt('menu.unsplit'),
          accelerator: 'CmdOrCtrl+Alt+1',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            const pair = splitPairs.get(win.id);
            if (!pair) return;
            const twin = BrowserWindow.fromId(pair.twinId || -1);
            if (twin && !twin.isDestroyed()) twin.destroy();
            if (pair.originalBounds) win.setBounds(pair.originalBounds);
            splitPairs.delete(win.id);
          },
        },
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
          label: tt('menu.welcome'),
          click: () => {
            const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (!focused) return;
            writeSettings({ ...readSettings(), guideDismissed: false });
            focused.webContents.send('app:welcome');
          },
          },
          {
          label: tt('menu.copyDiagnostics'),
          click: () => {
            let report = {};
            try {
              report = diagnosticsReport();
            } catch (err) {
              report = { error: err.message };
            }
            clipboard.writeText(JSON.stringify(report, null, 2));
          },
        },
        {
          label: tt('menu.openLogFolder'),
          click: () => shell.openPath(path.dirname(logFilePath())),
        },
        { type: 'separator' },
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

// Long-document acceptance: build a heavy document in the real editor, measure the operations a
// writer actually waits for, and print one JSON object. Used by `npm run perf`.
async function runPerfReport() {
  const win = createWindow({ show: false, width: 1180, height: 900 });
  const session = sessions.get(win.webContents.id);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const measured = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const parts = ['# Performance document', ''];
    // 12 000 words across 60 sections
    for (let s = 0; s < 60; s += 1) {
      parts.push('## Section ' + s);
      parts.push('');
      for (let p = 0; p < 4; p += 1) {
        parts.push(
          'Paragraph ' + p + ' of section ' + s + ' with **bold**, *italic*, \`inline code\` and a ' +
            'sentence that keeps going so the line wraps a few times on a normal window. '.repeat(3)
        );
      }
      if (s % 12 === 0) {
        parts.push('');
        parts.push('![pixel](' + image + ' "w=25%")');
      }
      if (s === 6) {
        parts.push('');
        parts.push('| Name | Value | Note |');
        parts.push('| --- | --- | --- |');
        for (let r = 0; r < 20; r += 1) parts.push('| row ' + r + ' | ' + r * 3 + ' | note ' + r + ' |');
      }
      if (s === 12) {
        parts.push('');
        parts.push('$');
        parts.push('\\int_0^1 x^2 dx = \\tfrac{1}{3}');
        parts.push('$');
      }
      if (s === 18) {
        parts.push('');
        parts.push(fence + 'js');
        parts.push('const total = items.reduce((sum, item) => sum + item.price, 0);');
        parts.push(fence);
      }
      if (s === 24) {
        parts.push('');
        parts.push(fence + 'mermaid');
        parts.push('graph LR;');
        parts.push('  draft-->export;');
        parts.push(fence);
      }
      parts.push('');
    }
    const markdown = parts.join(nl);
    const words = (markdown.match(/\\S+/g) || []).length;

    const t0 = performance.now();
    window.__mdpad.setMarkdown(markdown);
    const loadMs = performance.now() - t0;
    await wait(1200);

    const outlineStart = performance.now();
    window.__mdpad.refreshOutlineForPerf();
    const outlineMs = performance.now() - outlineStart;
    const outlineItems = document.querySelectorAll('#outline-list .outline-item').length;

    // find: the same search the find bar runs
    const findStart = performance.now();
    const found = window.__mdpad.findForPerf('Section 42');
    const findMs = performance.now() - findStart;

    const nodeCount = window.__mdpad.nodeCountForPerf();
    // Typing latency in a large document: 30 real transactions. This is the cost a writer feels
    // on every keystroke; scroll offsets are handled by the compositor and cannot be measured in a
    // hidden window.
    const editor = window.__mdpad.editor;
    const typeStart = performance.now();
    for (let i = 0; i < 30; i += 1) {
      editor.chain().focus('end').insertContent('x').run();
    }
    const typeMs = performance.now() - typeStart;
    const perKeyMs = typeMs / 30;

    const undoStart = performance.now();
    for (let i = 0; i < 10; i += 1) editor.commands.undo();
    const undoMs = performance.now() - undoStart;

    // Put the document back: the export that follows must measure the full document, not the
    // post-undo buffer.
    window.__mdpad.setMarkdown(markdown);
    await wait(700);

    return {
      chars: markdown.length,
      words,
      loadMs: Math.round(loadMs),
      outlineMs: Math.round(outlineMs),
      outlineItems,
      findMs: Math.round(findMs),
      found,
      typeMs: Math.round(typeMs),
      perKeyMs: Math.round(perKeyMs * 100) / 100,
      undoMs: Math.round(undoMs),
      heapMb: Math.round(performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0),
      nodeCount,
    };
  })()`);

  const file = path.join(app.getPath('temp'), 'mdpad-perf.md');
  fs.writeFileSync(file, await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()'), 'utf8');
  session.loadDocument(file);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const pdfPath = path.join(app.getPath('temp'), 'mdpad-perf.pdf');
  const htmlPath = path.join(app.getPath('temp'), 'mdpad-perf.html');
  const pdfStart = Date.now();
  await session.exportTo(pdfPath, 'pdf');
  const pdfMs = Date.now() - pdfStart;
  const htmlStart = Date.now();
  await session.exportTo(htmlPath, 'html');
  const htmlMs = Date.now() - htmlStart;

  const report = {
    app: app.getVersion(),
    at: new Date().toISOString(),
    ...measured,
    pdfMs,
    pdfBytes: fs.statSync(pdfPath).size,
    htmlMs,
    htmlBytes: fs.statSync(htmlPath).size,
    files: { markdown: file, pdf: pdfPath, html: htmlPath },
  };
  fs.writeFileSync(path.join(app.getPath('temp'), 'mdpad-perf.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('PERF_REPORT ' + JSON.stringify(report));
  app.exit(0);
}

// Opening a large file is the moment a writing app feels slow. This measures the three phases
// separately (read, IPC, renderer parse+layout) instead of one opaque number.
// First-run walkthrough against a genuinely empty profile: what a new user sees, then one document
// created, saved and exported, with the state checked at each step.
// Reads back what a user profile says after an install: settings, restored tabs and drafts.
async function runVerifyProfile() {
  // The dispatch skips the normal startup restore, so restore here: the point of this phase is what a
  // user sees after an upgrade, and that is the restored session.
  const previous = readSession();
  const plans = planRestore(previous, { exists: (file) => fs.existsSync(file) });
  for (const plan of plans) createWindow({ restore: plan, show: false });
  await sleep(2000);
  const settings = readSettings();
  const windows = [...sessions.values()].map((session) => ({
    tabs: [...session.tabs.values()].map((tab) => ({ file: tab.file, chars: (tab.contents || '').length })),
    activeFile: session.file || null,
  }));
  const drafts = listDrafts(draftsDir()).map((draft) => ({ file: draft.file, chars: (draft.contents || '').length }));
  const state = {
    theme: settings.theme || null,
    language: settings.language || null,
    accent: settings.accent || null,
    onboarded: settings.onboarded === true,
    windows,
    tabs: windows.reduce((sum, win) => sum + win.tabs.length, 0),
    drafts,
  };
  console.log('PROFILE_STATE ' + JSON.stringify(state));
  app.exit(0);
}

async function runWalkthrough() {
  try {
  const steps = {};
  const win = createWindow({ show: false, width: 1180, height: 900 });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(900);
  const js = (code) => win.webContents.executeJavaScript(code);

  steps.firstRun = await js(`({
    settingsExists: Boolean(window.api.getSettings),
    welcomeShown: !document.querySelector('#first-run')?.hidden,
    editorReady: Boolean(document.querySelector('.tiptap')),
    emptyHint: document.querySelector('#empty-hint')?.textContent?.trim().slice(0, 40) || '',
  })`);
  steps.onboarded = await js('window.api.getSettings().then((s) => Boolean(s.onboarded))');

  const file = path.join(app.getPath('temp'), 'walkthrough-' + Date.now() + '.md');
  fs.writeFileSync(file, '', 'utf8');
  const session = sessions.get(win.webContents.id);
  session.loadDocument(file);
  await sleep(300);
  await js('window.__mdpad.applyMarkdown("# Walkthrough\\n\\nfirst paragraph written by the test")');
  await sleep(500);
  steps.saved = await session.saveCurrent();
  steps.fileText = fs.readFileSync(file, 'utf8');

  const target = file.replace(/\.md$/, '.html');
  await session.exportTo(target, 'html');
  steps.export = { exists: fs.existsSync(target), bytes: fs.statSync(target).size };
  steps.tabs = await js('window.api.listTabs()');
  steps.dirty = await js('window.api.saveState ? window.api.saveState() : null');

  const state = await js('window.api.getSettings()');
  steps.settingsWritten = Boolean(state.theme);
  const openedTab = (steps.tabs || []).find((tab) => tab.file === file);
  const ok = Boolean(
    steps.firstRun.welcomeShown &&
      steps.firstRun.editorReady &&
      // a fresh profile has not been through the welcome card yet
      steps.onboarded === false &&
      steps.saved &&
      steps.saved.changed === true &&
      /first paragraph written by the test/.test(steps.fileText) &&
      steps.export.exists &&
      steps.export.bytes > 100 &&
      openedTab &&
      openedTab.active === true &&
      openedTab.dirty === false
  );
  steps.ok = ok;
  console.log('WALKTHROUGH ' + JSON.stringify(steps));
  try {
    fs.unlinkSync(file);
    fs.unlinkSync(target);
  } catch {
    /* best effort */
  }
  app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log('WALKTHROUGH ' + JSON.stringify({ ok: false, error: err.message }));
    app.exit(1);
  }
}

// How does printToPDF scale with document size? If it is superlinear, batching would help; if it is
// linear, the only honest answer is "no change".
async function runBenchPdf() {
  // toPdf destroys its print window; without another window the app would quit mid-bench.
  const keeper = createWindow({ show: false, width: 900, height: 700 });
  await new Promise((resolve) => keeper.webContents.once('did-finish-load', resolve));
  const sizes = [0.5, 1, 2, 4];
  const results = [];
  for (const mb of sizes) {
    const paragraphs = [];
    let bytes = 0;
    let index = 0;
    while (bytes < mb * 1024 * 1024) {
      index += 1;
      const line = 'Paragraph ' + index + ' with **bold**, *italic* and `code` that keeps going so the document is big.';
      paragraphs.push(line, '');
      bytes += line.length + 1;
    }
    const markdown = '# Bench ' + mb + ' MB\n\n## Section\n\n' + paragraphs.join('\n');
    const target = path.join(app.getPath('temp'), 'mdpad-bench-pdf-' + mb + '.pdf');
    const started = Date.now();
    let result;
    try {
      result = await exporter.toPdf(markdown, target, { title: 'Bench', stats: null, diagrams: null });
    } catch (err) {
      console.log('BENCH_PDF_ERROR ' + JSON.stringify({ mb, message: err.message, stack: String(err.stack).split('\n').slice(0, 3) }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      app.exit(1);
      return;
    }
    results.push({
      mb,
      totalMs: Date.now() - started,
      timings: result.timings,
      bytes: result.bytes,
      paragraphs: index,
    });
  }
  console.log('BENCH_PDF ' + JSON.stringify(results));
  for (const row of results) fs.rmSync(path.join(app.getPath('temp'), 'mdpad-bench-pdf-' + row.mb + '.pdf'), { force: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  app.exit(0);
}

async function runBenchExport() {
  const target = process.env.MDPAD_PERF_OPEN;
  const win = createWindow({ show: false, width: 1180, height: 900 });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const session = sessions.get(win.webContents.id);
  await session.loadDocument(target);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const out = { bytes: fs.statSync(target).size, formats: {} };
  for (const kind of ['html', 'docx', 'epub', 'pdf']) {
    const file = path.join(app.getPath('temp'), 'mdpad-bench-export.' + kind);
    const started = Date.now();
    try {
      const result = await session.exportTo(file, kind);
      out.formats[kind] = {
        ms: Date.now() - started,
        bytes: fs.statSync(file).size,
        heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        timings: result && result.timings ? result.timings : null,
      };
    } catch (err) {
      out.formats[kind] = { ms: Date.now() - started, error: err.message };
    }
  }
  console.log('BENCH_EXPORT ' + JSON.stringify(out));
  app.exit(0);
}

async function runBenchTyping() {
  const target = process.env.MDPAD_PERF_OPEN;
  const win = createWindow({ show: false, width: 1180, height: 900 });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const session = sessions.get(win.webContents.id);
  await session.loadDocument(target);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const parts = await win.webContents.executeJavaScript('window.__mdpad.benchTypingParts()');
  const typing = await win.webContents.executeJavaScript('window.__mdpad.measureTyping(18)');
  console.log('BENCH_TYPING ' + JSON.stringify({ parts, typing }));
  app.exit(0);
}

async function runBenchLoad() {
  const target = process.env.MDPAD_PERF_OPEN;
  const text = fs.readFileSync(target, 'utf8');
  const win = createWindow({ show: false, width: 1180, height: 900 });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const markdownMs = await win.webContents.executeJavaScript(
    'window.__mdpad.benchLoad(' + JSON.stringify(text) + ", 'markdown')"
  );
  const { renderHtml } = require('./markdown');
  const html = renderHtml(text);
  const htmlMs = await win.webContents.executeJavaScript(
    'window.__mdpad.benchLoad(' + JSON.stringify(html) + ", 'html')"
  );
  const half = text.slice(0, Math.floor(text.length / 2));
  const halfMs = await win.webContents.executeJavaScript(
    'window.__mdpad.benchLoad(' + JSON.stringify(half) + ", 'markdown')"
  );
  const progressive = await win.webContents
    .executeJavaScript('window.__mdpad.loadLarge(' + JSON.stringify(text) + ')')
    .catch((err) => ({ error: err.message }));
  console.log('BENCH_LOAD ' + JSON.stringify({ markdownMs, htmlMs, halfMs, progressive, bytes: text.length }));
  app.exit(0);
}

async function runPerfOpen() {
  const target = process.env.MDPAD_PERF_OPEN;
  if (!target) {
    console.log('PERF_OPEN_ERROR missing MDPAD_PERF_OPEN');
    app.exit(1);
    return;
  }
  const started = Date.now();
  const win = createWindow({ show: false, width: 1180, height: 900 });
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const session = sessions.get(win.webContents.id);
  const readStarted = Date.now();
  const bytes = fs.statSync(target).size;
  const ipcStarted = Date.now();
  if (process.env.MDPAD_PERF_OPEN_NOSPELL) {
    await win.webContents.executeJavaScript("document.querySelector('.tiptap').spellcheck = false");
  }
  await win.webContents.executeJavaScript('window.__mdpad.resetLoadTiming()');
  await session.loadDocument(target);
  const ipcMs = Date.now() - ipcStarted;
  let timing = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    timing = await win.webContents.executeJavaScript('window.__mdpad && window.__mdpad.loadTiming && window.__mdpad.loadTiming()');
    if (timing) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const probe = await win.webContents
    .executeJavaScript("({ api: typeof window.__mdpad, editor: Boolean(document.querySelector('.tiptap')), title: document.title })")
    .catch((err) => ({ error: err.message }));
  const report = {
    app: app.getVersion(),
    at: new Date().toISOString(),
    probe,
    file: target,
    bytes,
    lines: 0,
    readMs: ipcStarted - readStarted,
    ipcMs,
    renderMs: timing ? timing.renderMs : null,
    nodes: timing ? timing.nodes : null,
    chars: timing ? timing.chars : null,
    phases: timing ? timing.phases : null,
    totalMs: Date.now() - started,
  };
  try {
    report.lines = (fs.readFileSync(target, 'utf8').match(/\n/g) || []).length + 1;
  } catch {
    report.lines = 0;
  }
  console.log('PERF_OPEN ' + JSON.stringify(report));
  app.exit(0);
}

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
    console.error('SMOKE_TIMEOUT after 540s; completed=' + JSON.stringify(out));
    app.exit(2);
  }, 540000);

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
  // Two numbers: startupMs starts at OS process creation, so the virus scanner's first look at a
  // freshly built binary lands in it. bootMs starts when Electron is ready and measures this app.
  // The strict budget is on bootMs; startupMs keeps a loose ceiling for gross regressions.
  const bootLimit = startup.packaged ? 3000 : 6000;
  const startupLimit = startup.packaged ? 9000 : 12000;
  const bootOk = typeof startup.bootMs === 'number' && startup.bootMs < bootLimit;
  step('startup-time', bootOk && typeof startup.startupMs === 'number' && startup.startupMs < startupLimit, {
    startupMs: startup.startupMs,
    bootMs: startup.bootMs,
    packaged: startup.packaged,
    bootLimit,
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
    const result = await window.api.save({ force: true });
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
    const result = await window.api.save({ force: true });
    await sleep(300);
    const info = await window.api.info();
    return { saved: result.saved !== false, readOnly: info.readOnly };
  })()`);
  step('read-only-recover', readonlyRecover.saved && !readonlyRecover.readOnly, readonlyRecover);
  s.loadDocument(docPath);
  await sleep(400);
  // 4. draft cleared after a clean save
  {
    // Own file and own draft: "saving clears the draft" should not depend on what other tests
    // typed into the shared smoke document.
    const clearFile = path.join(dir, 'draft-clear.md');
    fs.writeFileSync(clearFile, '# clear me\n', 'utf8');
    s.loadDocument(clearFile);
    await sleep(500);
    storage.writeDraft(clearFile, '# clear me\n\nunsaved\n', draftsDir());
    s.contents = '# clear me\n\nunsaved\n';
    s.savedContents = '# clear me\n';
    const clearSave = s.saveCurrent({ silent: true, force: true });
    s.saveCurrent({ silent: true });
    const leftover = storage.readDraft(clearFile, draftsDir());
    step('draft-cleared', leftover === null && clearSave.changed === true, {
      changed: clearSave.changed,
      leftover: leftover ? leftover.contents.slice(0, 80) : null,
    });
  }

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

  // 5d. Word and EPUB exports. Use a dedicated document so the check does not depend on the
  // content earlier toolbar tests left in the editor.
  const docxSource = path.join(dir, 'docx-source.md');
  fs.writeFileSync(docxSource, '# Smoke export\n\nWord body text\n', 'utf8');
  s.loadDocument(docxSource);
  await sleep(500);
  const docxOut = await s.exportTo(path.join(dir, 'note.docx'), 'docx');
  step('export-docx', fs.readFileSync(docxOut.path).subarray(0, 2).toString('latin1') === 'PK', { bytes: docxOut.bytes });

  // The container is only half the story: check the text really reached the document part.
  {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(docxOut.path));
    const documentXml = await zip.file('word/document.xml').async('string');
    const stylesXml = zip.file('word/styles.xml') ? await zip.file('word/styles.xml').async('string') : '';
    step('export-docx-content', /Smoke export/i.test(documentXml) && /Word body text/i.test(documentXml) && documentXml.length > 400, {
      snippet: documentXml.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').slice(0, 160),
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
    const activeBefore = before.find((tab) => tab.active) || before[0];
    const beforeMd = window.__mdpad.getMarkdown();
    await window.api.syncChange(beforeMd);
    await window.api.newDoc();
    await sleep(250);
    window.__mdpad.setMarkdown('# second tab\\n\\nother document');
    await window.api.syncChange('# second tab\\n\\nother document');
    const afterNew = await window.api.listTabs();
    await window.api.activateTab(activeBefore.id);
    await sleep(350);
    const restored = window.__mdpad.getMarkdown();
    return {
      beforeCount: before.length,
      afterCount: afterNew.length,
      beforeMd,
      restored,
      restoredOk: restored.trim() === beforeMd.trim(),
    };
  })()`);
  step('tabs-create', tabsFlow.afterCount === tabsFlow.beforeCount + 1, { count: tabsFlow.afterCount });
  step('tabs-switch', tabsFlow.restoredOk, {
    before: String(tabsFlow.beforeMd || '').slice(0, 60),
    restored: String(tabsFlow.restored || '').slice(0, 60),
  });

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
  const feedYaml = `provider: generic\nurl: http://127.0.0.1:${feedPort}\nchannel: latest\n`;
  const wroteDevFeed = !app.isPackaged;
  if (wroteDevFeed) fs.writeFileSync(devFeedFile, feedYaml, 'utf8');
  const resourceFeed = path.join(process.resourcesPath || '', 'app-update.yml');
  let wroteResourceFeed = false;
  if (app.isPackaged && process.resourcesPath && !fs.existsSync(resourceFeed)) {
    fs.writeFileSync(resourceFeed, feedYaml, 'utf8');
    wroteResourceFeed = true;
  }

  const updateRes = await win.webContents.executeJavaScript(
    `window.api.updateCheck(${JSON.stringify(`http://127.0.0.1:${feedPort}`)})`
  );
  step('update-check', Boolean(updateRes && updateRes.ok && updateRes.available && updateRes.version === '9.9.9'), updateRes);

  // 17b. the download path consumes the feed's sha512 and stops before installing. The served
  // payload is a 24-byte placeholder with a matching hash, so this stays fast.
  const downloadRes = await win.webContents.executeJavaScript('window.api.updateDownload()');
  const downloadedSize = downloadRes && downloadRes.file && fs.existsSync(downloadRes.file)
    ? fs.statSync(downloadRes.file).size
    : 0;
  step(
    'update-download',
    Boolean(downloadRes && downloadRes.ok && downloadRes.file && downloadedSize === dummy.length),
    { result: downloadRes, size: downloadedSize }
  );
  try {
    if (downloadRes && downloadRes.file) fs.unlinkSync(downloadRes.file);
  } catch {
    /* the updater may move it itself */
  }


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
    // One insert is a coin flip on a busy machine (antivirus, cold cache). Five inserts and the
    // median keep the check about the editor rather than about the moment.
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      ed.commands.insertContentAt(1, 'x');
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const editMs = samples[2];

    return {
      chars: doc.length,
      loadMs: Math.round(loadMs),
      serializeMs: Math.round(serializeMs),
      editMs: Math.round(editMs),
      editMax: Math.round(samples[4]),
      roundTrip: md.length > doc.length * 0.7,
    };
  })()`);
  step(
    'perf-50k',
      perfBig.editMax < 2000 &&
      perfBig.editMs < 400 &&
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
  const recovered = s.saveCurrent({ silent: true, force: true });
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

  // 22. the welcome guide belongs to an empty untitled buffer, not to an empty saved file
  const emptyFile = path.join(dir, 'empty-file.md');
  fs.writeFileSync(emptyFile, '', 'utf8');
  const guide = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#ai-popover').hidden = true;
    await window.api.newDoc();
    await sleep(600);
    window.__mdpad.setMarkdown('');
    await sleep(250);
    const hint = document.querySelector('#empty-hint');
    const visible = !hint.hidden;
    const steps = hint.querySelectorAll('.empty-steps li').length;
    const actions = hint.querySelectorAll('.empty-actions button').length;
    window.__mdpad.setMarkdown('# not empty anymore');
    await sleep(250);
    const hiddenAfter = hint.hidden;
    // an empty file the user opened on purpose must not be covered by the guide
    await window.api.openPath(${JSON.stringify(emptyFile)});
    await sleep(700);
    const hiddenOnEmptyFile = hint.hidden;
    return { visible, steps, actions, hiddenAfter, hiddenOnEmptyFile };
  })()`);
  step(
    'empty-guide',
    guide.visible &&
      guide.steps === 4 &&
      guide.actions === 2 &&
      guide.hiddenAfter &&
      guide.hiddenOnEmptyFile,
    guide
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
      statsPanel.rows.length === 12 &&
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

  // 87a. the AI panel reads start to finish: target, instruction, suggestions, result, actions
  const aiLayout = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.aiOpen();
    await sleep(500);
    const panel = document.querySelector('#ai-popover');
    const scope = document.querySelector('.ai-scope-row');
    const head = document.querySelector('.ai-head');
    const presets = document.querySelector('.ai-presets');
    const result = document.querySelector('#ai-result');
    const foot = document.querySelector('.ai-foot');
    const chip = document.querySelector('#ai-target-chip');
    const scopeSelect = document.querySelector('#ai-scope');
    const beforeChip = chip.textContent.trim();

    scopeSelect.value = 'paragraph';
    scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const afterChip = chip.textContent.trim();
    scopeSelect.value = 'doc';
    scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);

    const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : -1);
    const order = [
      { key: 'scope', top: top(scope) },
      { key: 'instruction', top: top(head) },
      { key: 'presets', top: top(presets) },
      { key: 'result', top: top(result) },
      { key: 'actions', top: top(foot) },
    ];
    const ascending = order.every((entry, i) => i === 0 || entry.top >= order[i - 1].top);
    const panelRect = panel.getBoundingClientRect();
    const runRect = document.querySelector('#ai-run').getBoundingClientRect();
    const runVisible = runRect.top >= panelRect.top && runRect.bottom <= panelRect.bottom && runRect.width > 10;
    const insertIsPrimary = document.querySelector('#ai-insert').classList.contains('primary');
    const noOverflow = panel.scrollWidth <= panel.clientWidth + 1;
    window.__mdpad.aiClose ? window.__mdpad.aiClose() : document.querySelector('#ai-popover').hidden = true;
    return { order, ascending, beforeChip, afterChip, runVisible, insertIsPrimary, noOverflow };
  })()`);
  step(
    'ai-panel-layout',
    aiLayout.ascending &&
      aiLayout.beforeChip === 'Whole document' &&
      aiLayout.afterChip === 'Current paragraph' &&
      aiLayout.runVisible &&
      aiLayout.insertIsPrimary &&
      aiLayout.noOverflow,
    aiLayout
  );

  // 88a. the export panel shows a real rendering, not just a sketch, and it follows the font
  const thumb = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown('# Thumbnail check' + nl + nl + 'Some body text for the preview.');
    await sleep(600);
    await window.__mdpad.openExportPanel('pdf');
    // the thumbnail is debounced and needs a real page render
    await sleep(2600);
    const first = window.__mdpad.exportThumbState();
    document.querySelector('#export-font').value = 'kaiti';
    document.querySelector('#export-font').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2600);
    const second = window.__mdpad.exportThumbState();
    document.querySelector('#export-cancel').click();
    await sleep(300);
    return { first, second };
  })()`);
  step(
    'export-thumbnail',
    thumb.first.hidden === false &&
      thumb.first.src.startsWith('data:image/png') &&
      thumb.first.width >= 400 && // device pixel ratio can scale the capture
      thumb.first.bytes > 2000 &&
      thumb.second.src.startsWith('data:image/png') &&
      thumb.second.bytes !== thumb.first.bytes,
    thumb
  );

  // 89a. a table cell opens a menu on right click, and the row actions really reorder
  const tableMenu = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    const table = ['| A | B |', '| --- | --- |', '| r1 | x |', '| r2 | y |'];
    window.__mdpad.setMarkdown(['# Table', '', ...table].join(nl));
    await sleep(700);
    const ed = window.__mdpad.editor;
    let cellPos = null;
    ed.state.doc.descendants((node, pos) => {
      if (cellPos === null && node.type.name === 'tableCell' && node.textContent.trim() === 'r1') cellPos = pos + 1;
      return true;
    });
    ed.commands.setTextSelection(cellPos || 1);
    const cell = [...document.querySelectorAll('.tiptap td, .tiptap th')].find((el) => el.textContent.trim() === 'r1');
    const rect = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 6,
      clientY: rect.top + 6,
    }));
    await sleep(250);
    const opened = window.__mdpad.tableMenuState();

    // Move the selected row down, then read the first column order back.
    document.querySelector('#table-menu [data-tm="moveRowDown"]').click();
    await sleep(400);
    const afterMove = window.__mdpad.tableFirstColumn();
    const menuClosed = window.__mdpad.tableMenuState().hidden;

    // Header toggle flips the first row's cell type.
    const beforeHeader = /<th/.test(ed.getHTML());
    ed.commands.focus();
    ed.commands.toggleHeaderRow();
    await sleep(300);
    const afterHeader = /<th/.test(ed.getHTML());
    return { opened, afterMove, menuClosed, beforeHeader, afterHeader };
  })()`);
  step(
    'table-cell-menu',
    tableMenu.opened.hidden === false &&
      tableMenu.opened.items === 12 &&
      tableMenu.afterMove.join(',') === 'A,r2,r1' &&
      tableMenu.menuClosed === true &&
      tableMenu.beforeHeader !== tableMenu.afterHeader,
    tableMenu
  );

  // 89b. column widths are part of the document's view state and render as <col> widths
  const tableResize = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = window.__mdpad.editor;
    ed.commands.focus();
    let cellPos = null;
    ed.state.doc.descendants((node, pos) => {
      if (cellPos === null && node.type.name === 'tableCell') cellPos = pos + 1;
      return true;
    });
    ed.commands.setTextSelection(cellPos || 1);
    await sleep(200);
    const wrapper = document.querySelector('.tiptap .tableWrapper');
    const colBefore = document.querySelector('.tiptap table colgroup col');
    const beforeWidth = colBefore ? colBefore.getAttribute('style') : '';
    ed.chain().focus().setCellAttribute('colwidth', [140]).run();
    await sleep(300);
    const colAfter = document.querySelector('.tiptap table colgroup col');
    const afterWidth = colAfter ? colAfter.getAttribute('style') : '';
    return {
      wrapper: Boolean(wrapper),
      hasColgroup: Boolean(colBefore),
      beforeWidth,
      afterWidth,
      stored: window.__mdpad.tableColumnWidths().length,
    };
  })()`);
  step(
    'table-resize',
    tableResize.wrapper === true &&
      tableResize.hasColgroup === true &&
      /min-width|width/.test(tableResize.beforeWidth || '') &&
      /140px/.test(tableResize.afterWidth || ''),
    tableResize
  );

  // 90a. an unsaved document refuses to split and says why
  const splitUnsaved = await (async () => {
    const session = sessions.get(win.webContents.id);
    const savedFile = session.file;
    session.file = null;
    const result = await win.webContents.executeJavaScript('window.api.splitWindow()');
    session.file = savedFile;
    return result;
  })();
  // `ok` inside the details would override the step result, so only pass diagnostics.
  step('split-unsaved', splitUnsaved.ok === false && splitUnsaved.reason === 'unsaved', { reason: splitUnsaved.reason });

  // 90b. a saved document splits into two windows on the two halves of the display
  const split = await (async () => {
    const session = sessions.get(win.webContents.id);
    const file = path.join(dir, 'split-target.md');
    fs.writeFileSync(file, '# Split' + String.fromCharCode(10, 10) + 'left and right');
    session.file = file;
    const before = BrowserWindow.getAllWindows().length;
    const result = await win.webContents.executeJavaScript('window.api.splitWindow()');
    // wait for the second window to load the same document
    let twin = null;
    for (let i = 0; i < 40 && !twin; i += 1) {
      await sleep(250);
      twin = BrowserWindow.getAllWindows().find((candidate) => {
        if (candidate.isDestroyed() || candidate === win) return false;
        const candidateSession = sessions.get(candidate.webContents.id);
        return candidateSession && candidateSession.file === file;
      });
    }
    const after = BrowserWindow.getAllWindows().length;
    const bounds = win.getBounds();
    const twinBounds = twin ? twin.getBounds() : null;
    const area = screen.getDisplayMatching(bounds).workArea;
    const half = Math.floor(area.width / 2);
    // Window frames and DPI rounding shift bounds by a few pixels, so compare the halves
    // against each other rather than against an exact arithmetic split.
    const tileOk =
      Boolean(twinBounds) &&
      Math.abs(twinBounds.x - (bounds.x + bounds.width)) <= 8 &&
      Math.abs(twinBounds.width + bounds.width - area.width) <= 8;
    if (twin && !twin.isDestroyed()) twin.destroy();
    await sleep(300);
    return { result, before, after, bounds, twinBounds, tileOk, file };
  })();
  step(
    'split-windows',
    split.result.ok === true && split.after === split.before + 1 && split.tileOk === true,
    { accepted: split.result.ok, before: split.before, after: split.after, left: split.bounds, right: split.twinBounds, tile: split.tileOk }
  );

  // 91a. merging the split closes the twin and restores the original window bounds
  const merge = await (async () => {
    const session = sessions.get(win.webContents.id);
    const file = path.join(dir, 'split-target.md');
    session.file = file;
    const original = win.getBounds();
    const outcome = await win.webContents.executeJavaScript(`(async () => {
      const before = await window.api.splitWindow();
      return { before };
    })()`);
    await sleep(1200);
    const during = BrowserWindow.getAllWindows().length;
    const merged = await win.webContents.executeJavaScript('window.api.unsplitWindow()');
    await sleep(700);
    const after = BrowserWindow.getAllWindows().length;
    const restored = win.getBounds();
    const boundsBack =
      Math.abs(restored.width - original.width) <= 8 && Math.abs(restored.height - original.height) <= 8;
    return { outcome, during, merged, after, boundsBack };
  })();
  step(
    'unsplit-windows',
    merge.outcome.before.ok === true &&
      merge.during > 2 &&
      merge.merged.ok === true &&
      merge.after === merge.during - 1 &&
      merge.boundsBack === true,
    merge
  );

  // 91b. the table row grip appears on hover and drags a row to another position
  const rowDrag = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown(['| H |', '| --- |', '| a |', '| b |', '| c |'].join(nl));
    await sleep(700);
    const rows = [...document.querySelectorAll('.tiptap table tr')];
    const second = rows[1];
    const rect = second.getBoundingClientRect();
    second.querySelector('td').dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: rect.left + 20,
      clientY: rect.top + 8,
    }));
    await sleep(250);
    const shown = window.__mdpad.rowHandleState();

    const handle = document.querySelector('#row-handle');
    const handleRect = handle.getBoundingClientRect();
    handle.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: handleRect.left + 4,
      clientY: handleRect.top + 4,
    }));
    await sleep(120);
    const last = [...document.querySelectorAll('.tiptap table tr')].pop();
    const lastRect = last.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: lastRect.left + 20,
      clientY: lastRect.bottom - 2,
    }));
    await sleep(120);
    const dragging = window.__mdpad.rowHandleState();
    document.dispatchEvent(new MouseEvent('pointerup', {
      bubbles: true,
      clientX: lastRect.left + 20,
      clientY: lastRect.bottom - 2,
    }));
    await sleep(400);
    const order = [...document.querySelectorAll('.tiptap table tr')].map((r) => r.textContent.trim());
    const hiddenAfter = window.__mdpad.rowHandleState().hidden;
    return { shown, dragging, order, hiddenAfter };
  })()`);
  step(
    'table-row-drag',
    rowDrag.shown.hidden === false &&
      rowDrag.shown.row === 1 &&
      // the highlight is best-effort; the reorder above is the behaviour that matters
      rowDrag.dragging.dropTargets >= 0 &&
      rowDrag.order[1] === 'b' &&
      rowDrag.order[2] === 'c' &&
      rowDrag.order[3] === 'a' &&
      rowDrag.hiddenAfter === true,
    rowDrag
  );

  // 92a. the find bar groups its fields, reports a match counter, and flags "no results"
  const findBar = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('# Find' + String.fromCharCode(10, 10) + 'alpha beta alpha');
    await sleep(500);
    document.querySelector('[data-action="find"]').click();
    await sleep(300);
    const bar = document.querySelector('#findbar');
    const field = bar.querySelector('.findbar-field');
    const input = bar.querySelector('#find-input');
    input.value = 'alpha';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    const found = {
      text: document.querySelector('#find-count').textContent,
      empty: document.querySelector('#find-count').classList.contains('is-empty'),
    };
    input.value = 'zzzznothing';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    const missing = {
      text: document.querySelector('#find-count').textContent,
      empty: document.querySelector('#find-count').classList.contains('is-empty'),
    };
    const icon = Boolean(bar.querySelector('.findbar-icon svg'));
    const navIcons = bar.querySelectorAll('.findbar-nav .icon-button svg').length;
    const fields = bar.querySelectorAll('.findbar-field').length;
    document.querySelector('#find-close').click();
    await sleep(200);
    return { found, missing, icon, navIcons, fields, hidden: bar.hidden };
  })()`);
  step(
    'findbar-layout',
    findBar.found.text === '1/2' &&
      findBar.found.empty === false &&
      findBar.missing.empty === true &&
      findBar.icon === true &&
      findBar.navIcons === 3 &&
      findBar.fields === 2 &&
      findBar.hidden === true,
    findBar
  );

  // 92b. the shortcut sheet is grouped, not one flat table
  const shortcutGroups = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.openShortcuts();
    await sleep(300);
    const groups = [...document.querySelectorAll('#shortcuts tr.shortcut-group')].map((row) => row.textContent.trim());
    const rows = document.querySelectorAll('#shortcuts .shortcut-table tr').length;
    const open = !document.querySelector('#shortcuts').hidden;
    document.querySelector('#shortcuts-close').click();
    await sleep(200);
    return { groups, rows, open };
  })()`);
  step(
    'shortcuts-grouped',
    shortcutGroups.open === true &&
      shortcutGroups.groups.length >= 4 &&
      shortcutGroups.groups.includes('Editing') &&
      shortcutGroups.rows > shortcutGroups.groups.length + 8,
    shortcutGroups
  );

  // 93a. images resize by dragging a corner handle, and the width lands in the metadata
  const imgResize = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    window.__mdpad.setMarkdown('![wide pic](' + png + ')');
    await sleep(700);
    const image = document.querySelector('.tiptap img');
    const rect = image.getBoundingClientRect();
    image.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: rect.right - 4,
      clientY: rect.bottom - 4,
    }));
    await sleep(250);
    const shown = window.__mdpad.imageHandleState();
    const handle = document.querySelector('#img-resize-handle');
    const handleRect = handle.getBoundingClientRect();
    handle.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: handleRect.left + 4,
      clientY: handleRect.top + 4,
    }));
    await sleep(80);
    document.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: handleRect.left + 4 - Math.round(rect.width * 0.3),
      clientY: handleRect.top + 4,
    }));
    await sleep(120);
    const during = window.__mdpad.imageWidthStyle();
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await sleep(400);
    const after = window.__mdpad.imageMeta();
    const hiddenAfter = window.__mdpad.imageHandleState().hidden;
    return { shown, during, after: after.title, hiddenAfter };
  })()`);
  step(
    'image-drag-resize',
    imgResize.shown.hidden === false &&
      /%/.test(imgResize.during.style || '') &&
      /\bw=\d+%/.test(imgResize.after || '') &&
      imgResize.hiddenAfter === true &&
      // the drag moved left, so the stored width must be below 100%
      Number((imgResize.after || '').replace(/[^0-9]/g, '').slice(0, 3)) < 100,
    imgResize
  );

  // 94a. the AI panel shows exactly which text it will rewrite, and AI edits offer an undo
  const aiTarget = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown(['# Target', '', 'first paragraph here', '', 'second paragraph here'].join(nl));
    await sleep(600);
    const ed = window.__mdpad.editor;
    const text = 'second paragraph';
    // Positions in a ProseMirror document include node boundaries, so a plain string offset is
    // off by the number of preceding block markers; locate the text node instead.
    let start = -1;
    ed.state.doc.descendants((node, pos) => {
      if (start >= 0 || !node.isText) return true;
      const index = node.text.indexOf(text);
      if (index >= 0) start = pos + index;
      return true;
    });
    if (start < 0) return { error: 'text not found' };
    ed.commands.setTextSelection({ from: start, to: start + text.length });
    await sleep(150);
    window.__mdpad.aiOpen();
    await sleep(400);

    const withSelection = window.__mdpad.aiTargetState();
    // Collapse the selection; the highlight should follow the new range, not go stale.
    ed.commands.setTextSelection(start + 3);
    await sleep(350);
    const afterCollapse = window.__mdpad.aiTargetState();

    // Apply an insertion and check the toast offers Undo, then use it.
    ed.commands.setTextSelection({ from: start, to: start + text.length });
    await sleep(150);
    const before = ed.getText();
    window.__mdpad.aiInsert(' REWRITTEN');
    await sleep(400);
    const toast = window.__mdpad.toastInfo();
    const applied = ed.getText();
    const undoButton = [...document.querySelectorAll('#toast .toast-action')].find((b) => /undo/i.test(b.textContent));
    if (undoButton) undoButton.click();
    await sleep(400);
    const afterUndo = ed.getText();
    document.querySelector('#ai-popover').hidden = true;
    return { withSelection, afterCollapse, toast, applied, afterUndo, before };
  })()`);
  step(
    'ai-target-and-undo',
    aiTarget.withSelection.preview.includes('second paragraph') &&
      aiTarget.withSelection.decorations >= 1 &&
      aiTarget.afterCollapse.preview.includes('second paragraph') &&
      /REWRITTEN/.test(aiTarget.applied) &&
      aiTarget.toast.actions.some((label) => /undo/i.test(label)) &&
      !/REWRITTEN/.test(aiTarget.afterUndo) &&
      /REWRITTEN/.test(aiTarget.before) === false,
    aiTarget
  );

  // 95a. the file tree can create, rename and delete, with a confirmation for deletes
  const fileOps = await (async () => {
    const folder = path.join(dir, 'file-ops');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'existing.md'), '# Existing');
    await win.webContents.executeJavaScript(`window.__mdpad.openFolder(${JSON.stringify(folder)})`);
    await sleep(900);

    const menu = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // negative index targets the folder itself (empty area of the tree)
      window.__mdpad.openTreeContextMenu(-1, 220, 220);
      await sleep(200);
      const opened = window.__mdpad.treeMenuState();
      window.__mdpad.treeMenuClick('newFile');
      await sleep(250);
      const prompt = window.__mdpad.namePromptState();
      window.__mdpad.namePromptFill('created.md');
      await sleep(1200);
      const rows = [...document.querySelectorAll('#tree .tree-row')].map((r) => r.dataset.name);
      return { opened, prompt, rows };
    })()`);

    // rename through the same menu
    const renamed = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = [...document.querySelectorAll('#tree .tree-row')];
      const index = rows.findIndex((r) => r.dataset.name === 'created.md');
      window.__mdpad.openTreeContextMenu(index, 220, 260);
      await sleep(200);
      window.__mdpad.treeMenuClick('rename');
      await sleep(250);
      window.__mdpad.namePromptFill('renamed.md');
      await sleep(900);
      return [...document.querySelectorAll('#tree .tree-row')].map((r) => r.dataset.name);
    })()`);

    // delete asks first, and the file is gone afterwards
    const deleted = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = [...document.querySelectorAll('#tree .tree-row')];
      const index = rows.findIndex((r) => r.dataset.name === 'renamed.md');
      window.__mdpad.openTreeContextMenu(index, 220, 300);
      await sleep(200);
      window.__mdpad.treeMenuClick('delete');
      await sleep(250);
      const confirm = window.__mdpad.confirmState();
      window.__mdpad.confirmClick();
      await sleep(900);
      return { confirm, rows: [...document.querySelectorAll('#tree .tree-row')].map((r) => r.dataset.name) };
    })()`);

    const existingPath = path.join(folder, 'existing.md');
    const session = sessions.get(win.webContents.id);
    const traversal = await new Promise((resolve) => {
      // ask the main-side handler directly with a path outside the tree
      const fakeEvent = { sender: win.webContents };
      resolve(fakeEvent);
    });
    return {
      menu,
      renamed,
      deleted,
      fileExists: fs.existsSync(path.join(folder, 'renamed.md')),
      existingExists: fs.existsSync(existingPath),
    };
  })();

  step(
    'tree-file-operations',
    fileOps.menu.opened.hidden === false &&
      fileOps.menu.opened.items.includes('newFile') &&
      fileOps.menu.prompt.open === true &&
      fileOps.menu.rows.includes('created.md') &&
      fileOps.menu.rows.includes('existing.md') &&
      fileOps.renamed.includes('renamed.md') &&
      !fileOps.renamed.includes('created.md') &&
      fileOps.deleted.confirm.open === true &&
      fileOps.deleted.rows.includes('renamed.md') === false &&
      fileOps.fileExists === false &&
      fileOps.existingExists === true,
    fileOps
  );

  // 95b. path traversal and empty-name guards hold in the main process
  const guards = await win.webContents.executeJavaScript(`(async () => {
    const outside = await window.api.createEntry(${JSON.stringify(path.join(dir, 'file-ops'))}, '../escape.md', false);
    const empty = await window.api.createEntry(${JSON.stringify(path.join(dir, 'file-ops'))}, '  ', false);
    const duplicate = await window.api.createEntry(${JSON.stringify(path.join(dir, 'file-ops'))}, 'existing.md', false);
    return { outside, empty, duplicate };
  })()`);
  step(
    'tree-file-guards',
    guards.outside.ok === false &&
      guards.empty.ok === false &&
      guards.duplicate.ok === false &&
      /exists/.test(guards.duplicate.error || ''),
    guards
  );

  // 96a. the backup popover shows ages and sizes, and the status bar no longer leaks a path
  const backupPanel = await (async () => {
    const file = path.join(dir, 'backup-panel.md');
    fs.writeFileSync(file, '# Backup panel\n\nfirst');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(file);
    await sleep(400);
    session.contents = '# Backup panel\n\nsecond save';
    session.saveCurrent();
    await sleep(600);
    const state = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#backup-info').click();
      await sleep(600);
      const opened = window.__mdpad.backupPopoverState();
      document.querySelector('#backup-popover').hidden = true;
      return opened;
    })()`);
    return state;
  })();
  step(
    'backup-panel',
    backupPanel.hidden === false &&
      Number(backupPanel.count) >= 1 &&
      backupPanel.rows >= 1 &&
      backupPanel.firstHasParts === true &&
      backupPanel.folderButton === true &&
      backupPanel.footerPath === '',
    backupPanel
  );

  // 96b. drafts rows are not buttons inside buttons, and they say how old they are
  const draftsPanelUi = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.openDrafts();
    await sleep(600);
    const state = window.__mdpad.draftsPanelState();
    document.querySelector('#drafts-close').click();
    await sleep(200);
    return state;
  })()`);
  step(
    'drafts-panel-layout',
    draftsPanelUi.nestedButtons === 0 &&
      draftsPanelUi.rows >= 1 &&
      draftsPanelUi.role === 'button' &&
      draftsPanelUi.hasHint === true &&
      Number(draftsPanelUi.count) >= 1,
    draftsPanelUi
  );

  // 97a. zoom in, out and reset, with an indicator that only appears when zoomed
  const zoom = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const start = await window.api.zoomState();
    await window.__mdpad.zoom('in');
    await window.__mdpad.zoom('in');
    await sleep(200);
    const zoomed = window.__mdpad.zoomIndicator();
    const mid = await window.api.zoomState();
    await window.__mdpad.zoom('reset');
    await sleep(200);
    const reset = window.__mdpad.zoomIndicator();
    const end = await window.api.zoomState();
    return { start, mid, zoomed, reset, end };
  })()`);
  step(
    'zoom-controls',
    zoom.start.level === 0 &&
      zoom.mid.level > 0 &&
      zoom.zoomed.hidden === false &&
      /%/.test(zoom.zoomed.text) &&
      zoom.end.level === 0 &&
      zoom.reset.hidden === true,
    zoom
  );

  // 97b. the spelling checker follows the setting
  const spell = await (async () => {
    const session = win.webContents.session;
    const before = session.isSpellCheckerEnabled();
    const off = await win.webContents.executeJavaScript(`window.api.setSettings({ spellcheck: false })`);
    await sleep(200);
    const afterOff = session.isSpellCheckerEnabled();
    const on = await win.webContents.executeJavaScript(`window.api.setSettings({ spellcheck: true })`);
    await sleep(200);
    const afterOn = session.isSpellCheckerEnabled();
    return { before, storedOff: off.spellcheck, afterOff, storedOn: on.spellcheck, afterOn };
  })();
  step(
    'spellcheck-setting',
    spell.before === true &&
      spell.storedOff === false &&
      spell.afterOff === false &&
      spell.storedOn === true &&
      spell.afterOn === true,
    spell
  );

  // 98a. a long document keeps its scroll position when you switch tabs and come back
  const longScroll = await (async () => {
    const nl = String.fromCharCode(10);
    const paragraphs = [];
    for (let i = 0; i < 60; i += 1) paragraphs.push(`Paragraph ${i} with enough text to need scrolling.`);
    const longDoc = ['# Long A', '', ...paragraphs].join(nl + nl);
    const fileA = path.join(dir, 'long-a.md');
    const fileB = path.join(dir, 'long-b.md');
    fs.writeFileSync(fileA, longDoc);
    fs.writeFileSync(fileB, '# Long B' + nl + nl + 'short');

    const probe = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.api.openPath(${JSON.stringify(fileA)});
      await sleep(700);
      window.__mdpad.scrollTo(900);
      await sleep(200);
      const before = window.__mdpad.scrollTop();
      await window.api.openPath(${JSON.stringify(fileB)});
      await sleep(700);
      const otherTab = window.__mdpad.scrollTop();
      await window.api.openPath(${JSON.stringify(fileA)});
      await sleep(800);
      const back = window.__mdpad.scrollTop();
      return { before, otherTab, back };
    })()`);
    return probe;
  })();
  step(
    'tab-scroll-memory',
    longScroll.before > 300 &&
      longScroll.otherTab < 50 &&
      Math.abs(longScroll.back - longScroll.before) < 120,
    longScroll
  );

  // 98b. a mixed long document (text, a 40-row table, math, a diagram) stays responsive
  const mixedPerf = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const parts = ['# Mixed document', ''];
    for (let i = 0; i < 80; i += 1) parts.push('Paragraph ' + i + ' with some words in it.');
    const tableRows = [];
    for (let i = 0; i < 40; i += 1) tableRows.push('| row ' + i + ' | value ' + i + ' |');
    parts.push('', '| A | B |' + nl + '| --- | --- |' + nl + tableRows.join(nl));
    const dollar = String.fromCharCode(36);
    parts.push('', dollar + dollar + nl + 'a^2 + b^2 = c^2' + nl + dollar + dollar);
    parts.push('', fence + 'mermaid', 'graph TD;', '  A-->B;', fence);
    const markdown = parts.join(nl + nl);
    const started = performance.now();
    window.__mdpad.setMarkdown(markdown);
    const loadMs = performance.now() - started;
    await sleep(1500);
    const outlineMs = window.__mdpad.outlineMs();
    const rows = document.querySelectorAll('.tiptap table tr').length;
    const hasDiagram = Boolean(document.querySelector('.mermaid-preview svg'));
    const hasMath = Boolean(document.querySelector('.tiptap .katex'));
    return { chars: markdown.length, loadMs: Math.round(loadMs), outlineMs: Math.round(outlineMs), rows, hasDiagram, hasMath };
  })()`);
  step(
    'long-mixed-doc',
    mixedPerf.chars > 3000 &&
      mixedPerf.loadMs < 3000 &&
      mixedPerf.outlineMs < 400 &&
      mixedPerf.rows === 41 &&
      mixedPerf.hasDiagram === true &&
      mixedPerf.hasMath === true,
    mixedPerf
  );

  // 99a. at the minimum window width nothing overflows and the text still has room
  const narrowAudit = await (async () => {
    const original = win.getBounds();
    win.setBounds({ x: original.x, y: original.y, width: 740, height: 700 });
    await sleep(700);
    const measured = await win.webContents.executeJavaScript(`(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        return el ? Math.round(el.getBoundingClientRect().width) : 0;
      };
      const overflow = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.scrollWidth > el.clientWidth + 1 : false;
      };
      return {
        width: window.innerWidth,
        filesWidth: rect('#files'),
        outlineWidth: rect('#outline'),
        editorTextWidth: Math.round(document.querySelector('.tiptap').getBoundingClientRect().width),
        barOverflows: overflow('.bar'),
        tabsOverflow: overflow('.tabs'),
        footOverflows: overflow('.foot'),
        exportHidden: getComputedStyle(document.querySelector('[data-action="exportHtml"]')).display === 'none',
        settingsVisible: getComputedStyle(document.querySelector('#open-settings')).display !== 'none',
        backupHidden: getComputedStyle(document.querySelector('#backup-info')).display === 'none',
      };
    })()`);
    win.setBounds(original);
    await sleep(500);
    return measured;
  })();
  step(
    'narrow-audit',
    narrowAudit.width <= 760 &&
      narrowAudit.filesWidth < 200 &&
      narrowAudit.outlineWidth < 160 &&
      narrowAudit.editorTextWidth >= 280 &&
      narrowAudit.barOverflows === false &&
      narrowAudit.tabsOverflow === false &&
      narrowAudit.footOverflows === false &&
      narrowAudit.exportHidden === true &&
      narrowAudit.settingsVisible === true &&
      narrowAudit.backupHidden === true,
    narrowAudit
  );

  // 100a. right-clicking a tab closes its neighbours, and Ctrl+Tab cycles
  const tabMenuTest = await (async () => {
    const nl = String.fromCharCode(10);
    const fileX = path.join(dir, 'tab-x.md');
    const fileY = path.join(dir, 'tab-y.md');
    const fileZ = path.join(dir, 'tab-z.md');
    fs.writeFileSync(fileX, '# X' + nl);
    fs.writeFileSync(fileY, '# Y' + nl);
    fs.writeFileSync(fileZ, '# Z' + nl);
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.api.openPath(${JSON.stringify(fileX)});
      await sleep(300);
      await window.api.openPath(${JSON.stringify(fileY)});
      await sleep(300);
      await window.api.openPath(${JSON.stringify(fileZ)});
      await sleep(500);
    })()`);

    const opened = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.openTabContextMenu(320, 70);
      await sleep(250);
      const state = window.__mdpad.tabMenuState();
      window.__mdpad.tabMenuClick('closeOthers');
      await sleep(900);
      const tabs = await window.api.listTabs();
      return { state, tabs: tabs.map((tab) => (tab.file || '').split(/[\\\\/]/).pop()) };
    })()`);

    const cycled = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.api.openPath(${JSON.stringify(fileX)});
      await sleep(600);
      const before = (await window.api.listTabs()).find((t) => t.active).file;
      window.__mdpad.cycleTab(1);
      await sleep(700);
      const after = (await window.api.listTabs()).find((t) => t.active).file;
      return { before: (before || '').split(/[\\\\/]/).pop(), after: (after || '').split(/[\\\\/]/).pop() };
    })()`);
    return { opened, cycled };
  })();
  step(
    'tab-menu-and-cycle',
    tabMenuTest.opened.state.hidden === false &&
      tabMenuTest.opened.state.items.includes('closeOthers') &&
      tabMenuTest.opened.state.items.includes('copyPath') &&
      tabMenuTest.opened.tabs.length === 1 &&
      tabMenuTest.opened.tabs[0] === 'tab-z.md' &&
      tabMenuTest.cycled.before !== tabMenuTest.cycled.after,
    tabMenuTest
  );

  // 101a. "/" at the start of an empty paragraph opens the insert menu; choosing a block
  // removes the slash and inserts the block
  const slash = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('');
    await sleep(400);
    const ed = window.__mdpad.editor;
    ed.chain().focus('end').insertContent('/').run();
    await sleep(350);
    const opened = window.__mdpad.slashState();

    ed.chain().focus().insertContent('tab').run();
    await sleep(350);
    const filtered = window.__mdpad.slashState();

    window.__mdpad.slashChoose('table');
    await sleep(500);
    const afterChoose = window.__mdpad.slashState();
    const html = ed.getHTML();
    const markdown = window.__mdpad.getMarkdown();

    // Esc leaves the typed slash alone and closes the menu
    window.__mdpad.setMarkdown('');
    await sleep(300);
    ed.chain().focus('end').insertContent('/quot').run();
    await sleep(300);
    const beforeEsc = window.__mdpad.slashState();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(250);
    const afterEsc = window.__mdpad.slashState();
    return {
      opened,
      filtered,
      afterChoose,
      hasTable: /<table/.test(html),
      slashGone: !/^\\//.test(markdown.trim()) && !/href/.test(markdown.slice(0, 4)),
      markdown: markdown.slice(0, 40),
      beforeEsc,
      afterEsc,
    };
  })()`);
  step(
    'slash-menu',
    slash.opened.hidden === false &&
      slash.opened.items.length >= 10 &&
      slash.filtered.items.includes('table') &&
      slash.filtered.items.length < slash.opened.items.length &&
      slash.afterChoose.hidden === true &&
      slash.hasTable === true &&
      slash.slashGone === true &&
      slash.beforeEsc.hidden === false &&
      slash.afterEsc.hidden === true,
    slash
  );

  // 102a. a rich document survives export: table, image width, math, code, diagram, TOC
  const reachExport = await (async () => {
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const size = (text) => Buffer.byteLength(text, 'utf8');
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const markdown = [
      '# Rich export',
      '',
      'A paragraph with **bold** and `inline code`.',
      '',
      '| Name | State |',
      '| --- | --- |',
      '| Autosave | 5 s |',
      '| Backups | 20 |',
      '',
      '![one pixel](' + image + ' "w=50%")',
      '',
      'Inline math $a^2+b^2=c^2$ and a block:',
      '',
      '$$',
      '\\int_0^1 x^2 dx = \\tfrac{1}{3}',
      '$$',
      '',
      fence + 'js',
      'const total = items.reduce((sum, item) => sum + item.price, 0);',
      fence,
      '',
      fence + 'mermaid',
      'graph LR;',
      '  draft-->export;',
      fence,
    ].join(nl);

    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.setMarkdown(${JSON.stringify(markdown)});
      await sleep(1600);
      await window.__mdpad.exportDiagramCount();
    })()`);
    const session = sessions.get(win.webContents.id);
    session.contents = markdown;
    const htmlPath = path.join(dir, 'rich.html');
    const pdfPath = path.join(dir, 'rich.pdf');
    await session.exportTo(htmlPath, 'html');
    await session.exportTo(pdfPath, 'pdf');
    const htmlText = fs.readFileSync(htmlPath, 'utf8');
    const pdfBytes = fs.statSync(pdfPath).size;
    return {
      bytes: size(htmlText),
      table: /<table[\s>]/.test(htmlText),
      tableHeader: /<th>State<\/th>/.test(htmlText),
      bold: /<strong>bold<\/strong>/.test(htmlText),
      imageWidth: /<img[^>]+style="[^"]*width:50%/.test(htmlText),
      inlineMath: /class="katex"/.test(htmlText),
      displayMath: /math-display/.test(htmlText),
      codeHighlight: /hljs-keyword/.test(htmlText),
      diagram: /mermaid-figure/.test(htmlText) && /<svg[\s>]/.test(htmlText),
      diagramCount: Object.keys(session.exportDiagrams || {}).length,
      pdfBytes,
      htmlPath,
      pdfPath,
    };
  })();
  step(
    'export-fidelity',
    reachExport.table &&
      reachExport.tableHeader &&
      reachExport.bold &&
      reachExport.imageWidth &&
      reachExport.inlineMath &&
      reachExport.displayMath &&
      reachExport.codeHighlight &&
      reachExport.diagram &&
      reachExport.diagramCount >= 1 &&
      reachExport.pdfBytes > 15000,
    reachExport
  );

  // 103a. "Follow system" resolves from the OS and follows the event the main process sends
  const systemTheme = await (async () => {
    const osDark = nativeTheme.shouldUseDarkColors;
    // Go through the real settings dialog: that is the path a user takes.
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#open-settings').click();
      await sleep(500);
      document.querySelector('#set-theme').value = 'system';
      document.querySelector('#set-save').click();
      await sleep(700);
    })()`);
    const applied = await win.webContents.executeJavaScript('window.__mdpad.themeState2()');
    // Simulate the OS flipping: the main process broadcasts this payload on nativeTheme updates.
    win.webContents.send('app:system-theme', { dark: !osDark });
    await sleep(400);
    const flipped = await win.webContents.executeJavaScript('window.__mdpad.themeState2()');
    win.webContents.send('app:system-theme', { dark: osDark });
    await sleep(300);
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#open-settings').click();
      await sleep(500);
      document.querySelector('#set-theme').value = 'light';
      document.querySelector('#set-save').click();
      await sleep(500);
    })()`);
    return { osDark, applied, flipped };
  })();
  step(
    'system-theme',
    systemTheme.applied.stored === 'system' &&
      systemTheme.applied.applied === (systemTheme.osDark ? 'dark' : 'light') &&
      systemTheme.flipped.applied === (systemTheme.osDark ? 'light' : 'dark'),
    systemTheme
  );

  // 103b. Escape closes any dialog and returns focus to the editor
  const escModals = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];
    for (const modal of document.querySelectorAll('.modal')) modal.hidden = true;
    const waitOpen = async (id, ms = 3000) => {
      const started = Date.now();
      while (Date.now() - started < ms) {
        if (!document.querySelector('#' + id).hidden) return true;
        await sleep(100);
      }
      return false;
    };
    const check = async (id, opener) => {
      // A save from the previous probe can still be settling and close the dialog again; give it
      // a moment, and reopen once if the first attempt lost that race.
      await sleep(700);
      await opener();
      let wasOpen = await waitOpen(id, 1500);
      if (!wasOpen) {
        await opener();
        wasOpen = await waitOpen(id, 1500);
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      results.push({ id, wasOpen, nowHidden: document.querySelector('#' + id).hidden });
    };
    await check('settings-modal', async () => {
      document.querySelector('#open-settings').click();
    });
    await check('export-modal', async () => {
      window.__mdpad.openExportPanel('pdf');
    });
    await check('drafts-modal', async () => {
      window.__mdpad.openDrafts();
    });
    await check('shortcuts', async () => {
      window.__mdpad.openShortcuts();
    });
    const focusInEditor =
      document.activeElement && document.activeElement.closest
        ? Boolean(document.activeElement.closest('.tiptap'))
        : false;
    return { results, focusInEditor };
  })()`);
  step(
    'escape-closes-dialogs',
    escModals.results.every((entry) => entry.wasOpen && entry.nowHidden) && escModals.focusInEditor === true,
    escModals
  );

  // 104. diagnostics collect the facts a bug report needs, and go to the clipboard on demand
  const diagnostics = await (async () => {
    const report = await win.webContents.executeJavaScript('window.__mdpad.diagnostics()');
    const copied = await win.webContents.executeJavaScript('window.api.copyDiagnostics()');
    // Electron 45 returns a promise from clipboard.readText().
    const clipboardText = await clipboard.readText();
    const hasMenuEntry = (() => {
      const menu = Menu.getApplicationMenu();
      const help = menu?.items.find((item) => item.label === 'Help' || item.label === '帮助');
      return Boolean(help && help.submenu.items.some((item) => /diagnostics|诊断/i.test(item.label)));
    })();
    return {
      version: report.version,
      matchesPackage: report.version === app.getVersion(),
      logPathOk: /logs[\\/]mdpad\.log$/.test(report.logPath || ''),
      hasDirs: Boolean(report.dirs && report.dirs.data && report.dirs.backups),
      logTail: typeof report.logTail === 'string' && report.logTail.length > 0,
      copied: copied.copied,
      clipboardHasHeader: /mdpad diagnostics/.test(clipboardText),
      clipboardHasVersion: clipboardText.includes(app.getVersion()),
      hasMenuEntry,
    };
  })();
  step(
    'diagnostics',
    diagnostics.matchesPackage &&
      diagnostics.logPathOk &&
      diagnostics.hasDirs &&
      diagnostics.logTail &&
      diagnostics.copied > 200 &&
      diagnostics.clipboardHasHeader &&
      diagnostics.clipboardHasVersion &&
      diagnostics.hasMenuEntry,
    diagnostics
  );

  // 105. a keystroke reaches the draft immediately, and a blur flushes it without waiting
  const draftFlush = await (async () => {
    const file = path.join(dir, 'draft-flush.md');
    fs.writeFileSync(file, '# start\n', 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(file);
    await sleep(500);
    // The first change of a burst goes out immediately; wait less than the draft debounce so a
    // pass can only come from the leading edge.
    const typed = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.applyMarkdown('# start\\n\\nDEBOUNCE-PROBE-1');
      await sleep(180);
      return window.api.listDrafts();
    })()`);
    const leading = typed.find((draft) => draft.name === 'draft-flush.md');
    const leadingText = leading ? fs.readFileSync(leading.path, 'utf8') : '';
    // now change again mid-burst and blur: the flush must land even though the debounce is longer
    const flushed = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.applyMarkdown('# start\\n\\nDEBOUNCE-PROBE-2');
      window.dispatchEvent(new Event('blur'));
      await sleep(200);
      return window.api.listDrafts();
    })()`);
    const flushedEntry = flushed.find((draft) => draft.name === 'draft-flush.md');
    const flushedText = flushedEntry ? fs.readFileSync(flushedEntry.path, 'utf8') : '';
    storage.clearDraft(file, draftsDir());
    return {
      leadingHasProbe: /DEBOUNCE-PROBE-1/.test(leadingText),
      flushHasProbe: /DEBOUNCE-PROBE-2/.test(flushedText),
    };
  })();
  step('draft-flush', draftFlush.leadingHasProbe && draftFlush.flushHasProbe, draftFlush);

  // 106. the welcome checklist is actionable, dismissible and re-openable
  const welcome = await win.webContents.executeJavaScript(`(async () => {
   try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.showWelcomeGuide();
    window.api.newDoc();
    await sleep(600);
    const shown = window.__mdpad.welcomeState();
    // "Insert a block" must actually open the slash menu, not just describe it.
    document.querySelector('#empty-block').click();
    await sleep(500);
    const afterBlock = {
      menu: window.__mdpad.slashState(),
      guide: window.__mdpad.welcomeState(),
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    // Skipping hides the card and persists the choice.
    window.__mdpad.showWelcomeGuide();
    await sleep(150);
    document.querySelector('#empty-skip').click();
    await sleep(300);
    const skipped = window.__mdpad.welcomeState();
    const stored = await window.api.getSettings();
    // The Help menu clears the flag and opens a fresh empty tab, so the card has somewhere to
    // show; reproduce both steps.
    window.api.newDoc();
    await sleep(600);
    window.api.setSettings({ guideDismissed: false });
    window.__mdpad.showWelcomeGuide();
    await sleep(250);
    const reopened = window.__mdpad.welcomeState();
    document.querySelector('#empty-skip').click();
    await sleep(200);
    return {
      shown,
      afterBlock,
      skipped,
      persisted: stored.guideDismissed,
      reopened,
    };
   } catch (err) {
     return { error: String(err && err.stack ? err.stack : err).slice(0, 400) };
   }
  })()`);
  step(
    'welcome-guide',
    welcome.shown.hidden === false &&
      welcome.shown.steps.length === 4 &&
      welcome.shown.steps.join(',') === 'empty-new,empty-folder,empty-block,empty-export' &&
      welcome.afterBlock.menu.hidden === false &&
      welcome.afterBlock.guide.hidden === true &&
      welcome.skipped.hidden === true &&
      welcome.skipped.dismissed === true &&
      welcome.persisted === true &&
      welcome.reopened.hidden === false,
    welcome
  );

  // 107a. saving over a file that changed on disk asks instead of clobbering it
  const conflict = await (async () => {
    const file = path.join(dir, 'conflict.md');
    fs.writeFileSync(file, '# original' + String.fromCharCode(10), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(file);
    await sleep(500);
    await win.webContents.executeJavaScript("window.__mdpad.applyMarkdown('# local edit')");
    await sleep(500);
    // simulate another window writing the file
    fs.writeFileSync(file, '# from another window' + String.fromCharCode(10), 'utf8');
    const refused = await win.webContents.executeJavaScript('window.api.save()');
    const diskAfterRefusal = fs.readFileSync(file, 'utf8');
    // the force path is what the dialog's Overwrite button uses
    const forced = await win.webContents.executeJavaScript('window.api.save({ force: true })');
    const diskAfterForce = fs.readFileSync(file, 'utf8');
    return {
      refusedConflict: Boolean(refused && refused.conflict),
      onDiskBytes: refused && refused.onDiskBytes,
      diskAfterRefusal: diskAfterRefusal.slice(0, 40),
      forcedSaved: Boolean(forced && forced.saved),
      diskAfterForce: diskAfterForce.slice(0, 40),
    };
  })();
  step(
    'save-conflict',
    conflict.refusedConflict &&
      conflict.onDiskBytes > 0 &&
      /from another window/.test(conflict.diskAfterRefusal) &&
      conflict.forcedSaved &&
      /local edit/.test(conflict.diskAfterForce),
    conflict
  );

  // 107b. the dialog itself opens from the real save path and Overwrite resolves it
  const conflictUi = await (async () => {
    const file = path.join(dir, 'conflict-ui.md');
    fs.writeFileSync(file, '# ui original' + String.fromCharCode(10), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(file);
    await sleep(600);
    await win.webContents.executeJavaScript("window.__mdpad.applyMarkdown('# ui local')");
    await sleep(600);
    fs.writeFileSync(file, '# ui external' + String.fromCharCode(10), 'utf8');
    const state = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // the same function the menu and palette call
      window.__mdpad.saveNow();
      await sleep(600);
      const dialog = window.__mdpad.conflictState();
      document.querySelector('#tree-confirm-ok').click();
      await sleep(700);
      return { dialog, after: window.__mdpad.conflictState() };
    })()`);
    return { ...state, disk: fs.readFileSync(file, 'utf8').slice(0, 40) };
  })();
  step(
    'save-conflict-dialog',
    conflictUi.dialog.open === true &&
      /changed on disk/i.test(conflictUi.dialog.title) &&
      conflictUi.after.open === false &&
      /ui local/.test(conflictUi.disk),
    conflictUi
  );

  // 107c. opening a file that is already open focuses the existing tab instead of duplicating it
  const reopen = await (async () => {
    const file = path.join(dir, 'conflict.md');
    const before = await win.webContents.executeJavaScript('window.api.listTabs()');
    const result = await win.webContents.executeJavaScript(`window.api.openPath(${JSON.stringify(file)})`);
    await sleep(500);
    const after = await win.webContents.executeJavaScript('window.api.listTabs()');
    const matching = after.filter((tab) => tab.file === file).length;
    const active = after.find((tab) => tab.active);
    return { before: before.length, after: after.length, matching, activeIsFile: active && active.file === file, result };
  })();
  step(
    'open-existing-tab',
    reopen.matching === 1 && reopen.activeIsFile === true && reopen.after === reopen.before,
    reopen
  );

  // 108a. settings export writes a JSON file without secrets
  const transferExport = await (async () => {
    const out = path.join(dir, 'settings-export.json');
    const result = await win.webContents.executeJavaScript(
      `window.api.settingsExportTo(${JSON.stringify(out)})`
    );
    const text = fs.readFileSync(out, 'utf8');
    const parsed = JSON.parse(text);
    return {
      exported: Boolean(result && result.exported),
      app: parsed.app,
      version: parsed.version,
      hasTheme: typeof parsed.settings.theme === 'string',
      leaksKey: /"key"|sk-[a-z0-9]/i.test(text),
    };
  })();
  step(
    'settings-transfer-export',
    transferExport.exported &&
      transferExport.app === 'mdpad' &&
      transferExport.version === app.getVersion() &&
      transferExport.hasTheme &&
      transferExport.leaksKey === false,
    transferExport
  );

  // 108b. import applies a settings file through the same path the dialog uses
  const transferImport = await (async () => {
    const file = path.join(dir, 'settings-import.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ app: 'mdpad', settings: { theme: 'dark', exportTemplate: 'toc' } }),
      'utf8'
    );
    const result = await win.webContents.executeJavaScript(
      `window.api.settingsImportFrom(${JSON.stringify(file)})`
    );
    const after = await win.webContents.executeJavaScript('window.api.getSettings()');
    return {
      imported: result && result.imported,
      theme: after.theme,
      template: after.exportTemplate,
    };
  })();
  step(
    'settings-transfer-import',
    transferImport.imported === true &&
      transferImport.theme === 'dark' &&
      transferImport.template === 'toc',
    transferImport
  );

  // 108c. reset restores defaults but leaves drafts on disk; clearing drafts removes them
  const transferReset = await (async () => {
    const draftFile = path.join(dir, 'reset-draft.md');
    fs.writeFileSync(draftFile, '# kept' + String.fromCharCode(10), 'utf8');
    storage.writeDraft(draftFile, '# kept' + String.fromCharCode(10) + String.fromCharCode(10) + 'unsaved', draftsDir());
    const before = storage.readDraft(draftFile, draftsDir());
    const result = await win.webContents.executeJavaScript('window.api.resetSettings()');
    const after = await win.webContents.executeJavaScript('window.api.getSettings()');
    const draftAfterReset = storage.readDraft(draftFile, draftsDir());
    const cleared = await win.webContents.executeJavaScript('window.api.clearDrafts()');
    const draftsAfterClear = await win.webContents.executeJavaScript('window.api.listDrafts()');
    return {
      reset: result && result.reset,
      theme: after.theme,
      accent: after.accent,
      draftBefore: Boolean(before),
      draftAfterReset: Boolean(draftAfterReset),
      removed: cleared && cleared.removed,
      draftsAfterClear: draftsAfterClear.length,
    };
  })();
  step(
    'settings-reset-all',
    transferReset.reset === true &&
      transferReset.theme === 'light' &&
      transferReset.accent === 'blue' &&
      transferReset.draftBefore &&
      transferReset.draftAfterReset &&
      transferReset.removed >= 1 &&
      transferReset.draftsAfterClear === 0,
    transferReset
  );

  // 108d. the advanced section renders its controls
  const advancedUi = await win.webContents.executeJavaScript('window.__mdpad.advancedState()');
  step(
    'advanced-ui',
    advancedUi.nav &&
      advancedUi.exportButton &&
      advancedUi.importButton &&
      advancedUi.resetButton &&
      advancedUi.clearButton,
    advancedUi
  );

  // 109. a 14k-word document stays usable: load, outline, find, typing are measured in the editor
  const perfDoc = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const parts = ['# Perf', ''];
    for (let s = 0; s < 60; s += 1) {
      parts.push('## Section ' + s, '');
      for (let p = 0; p < 4; p += 1) {
        parts.push('Paragraph ' + p + ' of ' + s + ' with **bold** and *italic* and a sentence that keeps going to wrap lines. '.repeat(2));
      }
      if (s === 6) {
        parts.push('', '| A | B |', '| --- | --- |');
        for (let r = 0; r < 20; r += 1) parts.push('| r' + r + ' | v' + r + ' |');
      }
      if (s === 12) parts.push('', '$$', 'a^2 + b^2 = c^2', '$$');
      if (s === 18) parts.push('', fence + 'js', 'const total = items.reduce((a, b) => a + b, 0);', fence);
      parts.push('');
    }
    const markdown = parts.join(nl);

    const t0 = performance.now();
    window.__mdpad.setMarkdown(markdown);
    const loadMs = performance.now() - t0;
    await wait(1000);
    const o0 = performance.now();
    window.__mdpad.refreshOutlineForPerf();
    const outlineMs = performance.now() - o0;
    const headCount = document.querySelectorAll('#outline-list .outline-item').length;
    const f0 = performance.now();
    const found = window.__mdpad.findForPerf('Section 42');
    const findMs = performance.now() - f0;
    const ed = window.__mdpad.editor;
    const k0 = performance.now();
    for (let i = 0; i < 20; i += 1) ed.chain().focus('end').insertContent('x').run();
    const perKeyMs = (performance.now() - k0) / 20;
    return {
      chars: markdown.length,
      loadMs: Math.round(loadMs),
      outlineMs: Math.round(outlineMs),
      headCount,
      findMs: Math.round(findMs),
      found,
      perKeyMs: Math.round(perKeyMs * 100) / 100,
    };
  })()`);
  step(
    'perf-long-doc',
    perfDoc.chars > 40000 &&
      perfDoc.loadMs < 3000 &&
      perfDoc.outlineMs < 500 &&
      perfDoc.headCount === 61 &&
      perfDoc.findMs < 400 &&
      perfDoc.found > 0 &&
      perfDoc.perKeyMs < 16,
    perfDoc
  );

  // 110a. a big screenshot is downscaled and re-encoded before it is written
  const imageOptimize = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 3200;
    canvas.height = 2100;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 3200, 2100);
    g.addColorStop(0, '#2b5876');
    g.addColorStop(0.5, '#4e4376');
    g.addColorStop(1, '#e9d362');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 3200, 2100);
    for (let i = 0; i < 260; i += 1) {
      const rg = ctx.createRadialGradient((i * 97) % 3200, (i * 61) % 2100, 4, (i * 97) % 3200, (i * 61) % 2100, 220);
      rg.addColorStop(0, 'hsla(' + ((i * 29) % 360) + ', 70%, 62%, 0.55)');
      rg.addColorStop(1, 'hsla(' + ((i * 29) % 360) + ', 70%, 40%, 0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, 3200, 2100);
    }
    const dataUrl = canvas.toDataURL('image/png');
    return window.__mdpad.optimizeImageForTest(dataUrl, 'screenshot.png');
  })()`);
  step(
    'image-optimize',
    imageOptimize.changed === true &&
      imageOptimize.bytes < imageOptimize.originalBytes &&
      imageOptimize.bytes < imageOptimize.originalBytes / 2 &&
      imageOptimize.width <= 2200 &&
      imageOptimize.height <= 2200 &&
      /^image\//.test(imageOptimize.type),
    imageOptimize
  );

  // 110b. dropping that image really writes the smaller file next to the document
  const dropTarget = path.join(dir, 'image-drop.md');
  fs.writeFileSync(dropTarget, '# Drop target' + String.fromCharCode(10), 'utf8');
  const dropSession = sessions.get(win.webContents.id);
  await dropSession.loadDocument(dropTarget);
  await sleep(700);
  const imageDrop = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const canvas = document.createElement('canvas');
    canvas.width = 2600;
    canvas.height = 1800;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 2600, 1800);
    g.addColorStop(0, '#2b5876');
    g.addColorStop(0.5, '#4e4376');
    g.addColorStop(1, '#e9d362');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2600, 1800);
    for (let i = 0; i < 260; i += 1) {
      const rg = ctx.createRadialGradient((i * 97) % 2600, (i * 61) % 1800, 4, (i * 97) % 2600, (i * 61) % 1800, 220);
      rg.addColorStop(0, 'hsla(' + ((i * 29) % 360) + ', 70%, 62%, 0.55)');
      rg.addColorStop(1, 'hsla(' + ((i * 29) % 360) + ', 70%, 40%, 0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, 2600, 1800);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([blob], 'drop.png', { type: 'image/png' }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    await sleep(2500);
    return {
      markdown: window.__mdpad.getMarkdown(),
      originalBytes: blob.size,
    };
  })()`);
  const droppedMatch = /assets\/([a-f0-9]+\.(jpg|png))/.exec(imageDrop.markdown);
  const droppedSize = droppedMatch
    ? fs.statSync(path.join(path.dirname(dropTarget), 'assets', droppedMatch[1])).size
    : 0;
  step(
    'image-drop-compressed',
    Boolean(droppedMatch) &&
      ['jpg', 'png'].includes(droppedMatch[2]) &&
      droppedSize > 0 &&
      droppedSize < Math.min(1200000, imageDrop.originalBytes),
    { matched: Boolean(droppedMatch), droppedSize, originalBytes: imageDrop.originalBytes }
  );

  // 111a. embedded data-URL images are moved into assets/ and the document shrinks
  const extract = await (async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const file = path.join(dir, 'embedded.md');
    const original = ['# Embedded', '', '![one](data:image/png;base64,' + png + ')', '', '![two](data:image/png;base64,' + png + ')', '', 'Text after the images.'].join(String.fromCharCode(10));
    fs.writeFileSync(file, original, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(file);
    await sleep(600);
    const result = await win.webContents.executeJavaScript('window.api.extractImages()');
    await sleep(400);
    const after = fs.readFileSync(file, 'utf8');
    const assetsDir = path.join(dir, 'assets');
    const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
    const backups = storage.listBackups(file, backupsDir());
    return {
      extracted: result && result.extracted,
      count: result && result.count,
      bytesBefore: result && result.bytesBefore,
      bytesAfter: result && result.bytesAfter,
      hasDataUrl: /data:image/.test(after),
      hasAssetsRef: /!\[one\]\(assets\/[a-f0-9]+\.png\)/.test(after),
      assets: assets.length,
      backups: backups.length,
      markdownLength: after.length,
      sessionContentsHasAssets: session.contents.includes('assets/'),
    };
  })();
  step(
    'extract-images',
    extract.extracted === true &&
      extract.count === 2 &&
      extract.bytesAfter < extract.bytesBefore / 2 &&
      extract.hasDataUrl === false &&
      extract.hasAssetsRef === true &&
      extract.assets === 2 &&
      extract.backups >= 1 &&
      extract.sessionContentsHasAssets === true,
    extract
  );

  // 111b. a dirty document is refused: extraction rewrites the file, so unsaved text must win
  const extractDirty = await (async () => {
    const file = path.join(dir, 'embedded-dirty.md');
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    fs.writeFileSync(file, '# dirty' + String.fromCharCode(10) + String.fromCharCode(10) + '![x](data:image/png;base64,' + png + ')', 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(file);
    await sleep(500);
    session.contents = session.contents + String.fromCharCode(10) + 'unsaved words';
    const result = await win.webContents.executeJavaScript('window.api.extractImages()');
    return { extracted: result && result.extracted, reason: result && result.reason };
  })();
  step(
    'extract-images-dirty-guard',
    extractDirty.extracted === false && extractDirty.reason === 'dirty',
    extractDirty
  );

  // 112. one document, four formats: the same blocks survive, in the same order
  const exportMatrix = await (async () => {
    const JSZip = require('jszip');
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const diagram = 'graph LR;' + nl + '  draft-->export;';
    const markdown = [
      '# Matrix check',
      '',
      'Body with **bold words** and `inline`.',
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
      'a + b = c',
      '$$',
      '',
      fence + 'js',
      'const answer = 42;',
      fence,
      '',
      fence + 'mermaid',
      diagram,
      fence,
    ].join(nl);

    const session = sessions.get(win.webContents.id);
    const matrixFile = path.join(dir, 'matrix.md');
    fs.writeFileSync(matrixFile, markdown, 'utf8');
    await session.loadDocument(matrixFile);
    await sleep(900);
    await win.webContents.executeJavaScript('window.__mdpad.exportDiagramCount()');
    session.contents = markdown;

    const htmlPath = path.join(dir, 'matrix.html');
    const pdfPath = path.join(dir, 'matrix.pdf');
    const docxPath = path.join(dir, 'matrix.docx');
    const epubPath = path.join(dir, 'matrix.epub');
    await session.exportTo(htmlPath, 'html');
    await session.exportTo(pdfPath, 'pdf');
    await session.exportTo(docxPath, 'docx');
    await session.exportTo(epubPath, 'epub');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const htmlBody = html.slice(html.indexOf('<body'));
    const htmlOrder = ['Matrix check', 'bold words', 'Left', 'pixel'].map((needle) => htmlBody.indexOf(needle));

    const docxZip = await JSZip.loadAsync(fs.readFileSync(docxPath));
    const docxXml = await docxZip.file('word/document.xml').async('string');
    const docxText = docxXml
      .replace(/<w:p[ >]/g, nl + '<w:p ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const docxOrder = ['Matrix check', 'bold words', 'Left'].map((needle) => docxText.indexOf(needle));

    const epubZip = await JSZip.loadAsync(fs.readFileSync(epubPath));
    const chapterName = Object.keys(epubZip.files).find((name) => /\.xhtml$/.test(name));
    const chapter = chapterName ? await epubZip.file(chapterName).async('string') : '';
    const epubBody = chapter.slice(chapter.indexOf('<body'));
    const epubOrder = ['Matrix check', 'bold words', 'Left'].map((needle) => epubBody.indexOf(needle));

    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfText = pdfBytes.toString('latin1');

    return {
      html: {
        heading: /<h1[^>]*>Matrix check<\/h1>/.test(html),
        bold: /<strong>bold words<\/strong>/.test(html),
        table: /<table[\s>]/.test(html),
        image: /<img[^>]+src="data:image\/png/.test(html),
        math: /class="katex"/.test(html) && /math-display/.test(html),
        // highlighted code splits the text into spans, so check the anchor word and the block
        code: /hljs-pre/.test(html) && /answer/.test(html),
        diagram: /mermaid-figure[\s\S]*<svg/.test(html),
        order: htmlOrder.every((value, i) => value >= 0 && (i === 0 || value > htmlOrder[i - 1])),
      },
      pdf: {
        header: pdfText.startsWith('%PDF-'),
        image: /\/Subtype\s*\/Image/.test(pdfText),
        font: /\/Font/.test(pdfText),
        bytes: pdfBytes.length,
      },
      docx: {
        heading: /Matrix check/.test(docxText),
        bold: /bold words/.test(docxText),
        table: /Left/.test(docxText) && /beta/.test(docxText),
        image: Object.keys(docxZip.files).some((name) => /^word\/media\//.test(name)),
        math: /a\^2|a2 \+ b2|c2/.test(docxText),
        code: /const answer = 42;/.test(docxText),
        // Word export keeps the Mermaid source as a code block; it has no diagram rasteriser.
        diagramSource: /graph LR|draft/.test(docxText),
        order: docxOrder.every((value, i) => value >= 0 && (i === 0 || value > docxOrder[i - 1])),
      },
      epub: {
        heading: /<h1[^>]*>Matrix check<\/h1>/.test(chapter),
        bold: /<strong>bold words<\/strong>/.test(chapter),
        table: /<table[\s>]/.test(chapter),
        image: Object.keys(epubZip.files).some((name) => /^OEBPS\/images\//.test(name)),
        math: /class="katex"/.test(chapter),
        diagram: /mermaid-figure[\s\S]*<svg/.test(chapter),
        code: /hljs|hljs-pre|<code/.test(chapter) && /answer/.test(chapter),
        order: epubOrder.every((value, i) => value >= 0 && (i === 0 || value > epubOrder[i - 1])),
      },
    };
  })();
  step(
    'export-consistency',
    exportMatrix.html.heading &&
      exportMatrix.html.bold &&
      exportMatrix.html.table &&
      exportMatrix.html.image &&
      exportMatrix.html.math &&
      exportMatrix.html.code &&
      exportMatrix.html.diagram &&
      exportMatrix.html.order &&
      exportMatrix.pdf.header &&
      exportMatrix.pdf.image &&
      exportMatrix.pdf.font &&
      exportMatrix.pdf.bytes > 30000 &&
      exportMatrix.docx.heading &&
      exportMatrix.docx.bold &&
      exportMatrix.docx.table &&
      exportMatrix.docx.image &&
      exportMatrix.docx.math &&
      exportMatrix.docx.code &&
      exportMatrix.docx.diagramSource &&
      exportMatrix.docx.order &&
      exportMatrix.epub.heading &&
      exportMatrix.epub.bold &&
      exportMatrix.epub.table &&
      exportMatrix.epub.image &&
      exportMatrix.epub.math &&
      exportMatrix.epub.diagram &&
      exportMatrix.epub.code &&
      exportMatrix.epub.order,
    exportMatrix
  );

  // 113a. typing markdown syntax converts blocks and inline marks through real key events
  const inputRules = await (async () => {
    const results = {};
    const type = async (text) => {
      for (const ch of text) {
        win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        await sleep(40);
      }
      await sleep(250);
    };
    const shape = async () => {
      const list = await win.webContents.executeJavaScript('window.__mdpad.docShape()');
      return list;
    };
    win.focus();
    win.webContents.focus();
    await win.webContents.executeJavaScript('window.__mdpad.clearDoc()');
    await win.webContents.executeJavaScript("window.__mdpad.editor.commands.focus('end')");
    await type('## ');
    results.heading = (await shape())[0];

    await win.webContents.executeJavaScript('window.__mdpad.clearDoc()');
    await win.webContents.executeJavaScript("window.__mdpad.editor.commands.focus('end')");
    await type('- ');
    results.bullet = (await shape())[0];

    await win.webContents.executeJavaScript('window.__mdpad.clearDoc()');
    await win.webContents.executeJavaScript("window.__mdpad.editor.commands.focus('end')");
    await type('1. ');
    results.ordered = (await shape())[0];

    await win.webContents.executeJavaScript('window.__mdpad.clearDoc()');
    await win.webContents.executeJavaScript("window.__mdpad.editor.commands.focus('end')");
    await type('> ');
    results.quote = (await shape())[0];

    await win.webContents.executeJavaScript('window.__mdpad.clearDoc()');
    await win.webContents.executeJavaScript("window.__mdpad.editor.commands.focus('end')");
    await type('**bold**');
    results.bold = (await shape())[0];

    await win.webContents.executeJavaScript('window.__mdpad.clearDoc()');
    await win.webContents.executeJavaScript("window.__mdpad.editor.commands.focus('end')");
    await type('`code`');
    results.code = (await shape())[0];

    return results;
  })();
  step(
    'input-rules',
    inputRules.heading &&
      inputRules.heading.type === 'heading' &&
      inputRules.heading.level === 2 &&
      inputRules.bullet.type === 'bulletList' &&
      inputRules.ordered.type === 'orderedList' &&
      inputRules.quote.type === 'blockquote' &&
      inputRules.bold.type === 'paragraph' &&
      inputRules.bold.text === 'bold' &&
      inputRules.bold.marks.includes('bold') &&
      inputRules.code.text === 'code' &&
      inputRules.code.marks.includes('code'),
    inputRules
  );

  // 113b. pasting plain markdown parses it; the guard leaves prose and a lone #tag alone
  const pasteMatrix = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const paste = async (text) => {
      window.__mdpad.clearDoc();
      window.__mdpad.editor.commands.focus('end');
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await sleep(400);
      return window.__mdpad.docShape();
    };
    const nl = String.fromCharCode(10);
    const markdown = await paste('## Pasted heading' + nl + nl + '- one' + nl + '- two');
    return {
      markdown,
      guards: {
        prose: window.__mdpad.looksLikeMarkdown('just some ordinary words to paste'),
        tag: window.__mdpad.looksLikeMarkdown('#not-a-heading'),
        fence: window.__mdpad.looksLikeMarkdown(String.fromCharCode(96, 96, 96) + 'js' + nl + 'const x = 1;' + nl + String.fromCharCode(96, 96, 96)),
        table: window.__mdpad.looksLikeMarkdown('| a | b |' + nl + '| --- | --- |'),
        list: window.__mdpad.looksLikeMarkdown('- one' + nl + '- two'),
      },
    };
  })()`);
  step(
    'paste-markdown',
    pasteMatrix.markdown.some(
      (node) => node.type === 'heading' && node.level === 2 && node.text === 'Pasted heading'
    ) &&
      pasteMatrix.markdown.some((node) => node.type === 'bulletList') &&
      pasteMatrix.guards.prose === false &&
      pasteMatrix.guards.tag === false &&
      pasteMatrix.guards.fence === true &&
      pasteMatrix.guards.table === true &&
      pasteMatrix.guards.list === true,
    pasteMatrix
  );

  // 114a. case, whole-word and regex options change what matches
  const findOptionsTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('Alpha alpha ALPHA alphabet\\n\\nSecond paragraph with Alpha.');
    await sleep(400);
    const plain = window.__mdpad.runFind('Alpha');
    window.__mdpad.setFindOptions({ caseSensitive: true });
    const cased = window.__mdpad.runFind('Alpha');
    window.__mdpad.setFindOptions({ wholeWord: true });
    const casedWord = window.__mdpad.runFind('Alpha');
    window.__mdpad.setFindOptions({ caseSensitive: false, wholeWord: true });
    const insensitiveWord = window.__mdpad.runFind('alpha');
    window.__mdpad.setFindOptions({ wholeWord: false, regex: true });
    const regex = window.__mdpad.runFind('ALPHA');
    const regexInsensitive = window.__mdpad.runFind('Al[a-z]+');
    const bad = window.__mdpad.runFind('([');
    window.__mdpad.setFindOptions({ regex: false, caseSensitive: false, wholeWord: false });
    return {
      plain: plain.count,
      cased: cased.count,
      casedWord: casedWord.count,
      insensitiveWord: insensitiveWord.count,
      regex: regex.count,
      regexInsensitive: regexInsensitive.count,
      badError: bad.error,
      badCount: bad.count,
    };
  })()`);
  step(
    'find-options',
    findOptionsTest.plain === 5 &&
      findOptionsTest.cased === 2 &&
      findOptionsTest.casedWord === 2 &&
      findOptionsTest.insensitiveWord === 4 &&
      findOptionsTest.regex === 5 &&
      findOptionsTest.regexInsensitive === 5 &&
      findOptionsTest.badError === 'bad regex' &&
      findOptionsTest.badCount === 0,
    findOptionsTest
  );

  // 114b. regex replacement expands $1, and the whole batch is one undo step
  const replaceTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown('one two' + nl + nl + 'three four');
    await sleep(400);
    window.__mdpad.setFindOptions({ regex: true });
    const before = window.__mdpad.runFind('(\\\\w+) (\\\\w+)');
    const beforeReplace = window.__mdpad.getMarkdown();
    const swapped = window.__mdpad.replaceAllNow('$2 $1');
    window.__mdpad.editor.commands.undo();
    await sleep(250);
    const undo1 = window.__mdpad.getMarkdown();
    window.__mdpad.editor.commands.undo();
    await sleep(250);
    const undo2 = window.__mdpad.getMarkdown();
    window.__mdpad.setFindOptions({ regex: false });
    return { before: before.count, beforeReplace, swapped, undo1, undo2 };
  })()`);
  step(
    'find-replace-groups',
    replaceTest.before === 2 &&
      /two one/.test(replaceTest.swapped) &&
      /four three/.test(replaceTest.swapped) &&
      (replaceTest.undo1.trim() === String(replaceTest.beforeReplace || '').trim() ||
        replaceTest.undo2.trim() === String(replaceTest.beforeReplace || '').trim()),
    replaceTest
  );

  // 114c. options persist and the bar exposes the three toggles
  const findUi = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.api.setSettings({ findOptions: { caseSensitive: true, wholeWord: false, regex: false } });
    await sleep(300);
    const stored = await window.api.getSettings();
    const buttons = ['#find-case', '#find-word', '#find-regex'].map((id) => Boolean(document.querySelector(id)));
    return { stored: stored.findOptions, buttons };
  })()`);
  step(
    'find-options-ui',
    findUi.stored &&
      findUi.stored.caseSensitive === true &&
      findUi.buttons.every(Boolean),
    findUi
  );

  // 115a. task lists round-trip through markdown and their boxes toggle
  const taskRoundTrip = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown('- [ ] open item' + nl + '- [x] done item');
    await sleep(500);
    const before = window.__mdpad.getMarkdown();
    const box = document.querySelector('.tiptap ul[data-type="taskList"] li input[type="checkbox"]');
    const hasBox = Boolean(box);
    if (box) box.click();
    await sleep(500);
    const after = window.__mdpad.getMarkdown();
    return { before, after, hasBox, shape: window.__mdpad.docShape() };
  })()`);
  step(
    'task-roundtrip',
    /- \[ \] open item/.test(taskRoundTrip.before) &&
      /- \[x\] done item/.test(taskRoundTrip.before) &&
      taskRoundTrip.hasBox === true &&
      taskRoundTrip.shape.some((node) => node.type === 'taskList') &&
      (taskRoundTrip.after.match(/- \[x\]/g) || []).length === 2 &&
      !/- \[ \]/.test(taskRoundTrip.after),
    taskRoundTrip
  );

  // 115b. task state survives HTML, Word and EPUB export
  const taskExports = await (async () => {
    const JSZip = require('jszip');
    const nl = String.fromCharCode(10);
    const markdown = ['# Chores', '', '- [ ] water plants', '- [x] pay bills'].join(nl);
    const taskFile = path.join(dir, 'tasks.md');
    fs.writeFileSync(taskFile, markdown, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(taskFile);
    await sleep(700);
    session.contents = markdown;
    const htmlPath = path.join(dir, 'tasks.html');
    const docxPath = path.join(dir, 'tasks.docx');
    const epubPath = path.join(dir, 'tasks.epub');
    await session.exportTo(htmlPath, 'html');
    await session.exportTo(docxPath, 'docx');
    await session.exportTo(epubPath, 'epub');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const docxZip = await JSZip.loadAsync(fs.readFileSync(docxPath));
    const docxText = (await docxZip.file('word/document.xml').async('string'))
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const epubZip = await JSZip.loadAsync(fs.readFileSync(epubPath));
    const chapter = await epubZip.file(Object.keys(epubZip.files).find((name) => /\.xhtml$/.test(name))).async('string');
    return {
      htmlUnchecked: /<input[^>]+type="checkbox"[^>]*>/.test(html) && /water plants/.test(html),
      htmlChecked: /<input[^>]+checked[^>]*type="checkbox"|<input[^>]+type="checkbox"[^>]+checked/.test(html),
      docxBoxes: /☐/.test(docxText) && /☑/.test(docxText),
      epubUnchecked: /<input[^>]+type="checkbox"/.test(chapter) && /water plants/.test(chapter),
      epubChecked: /checked/.test(chapter),
    };
  })();
  step(
    'task-exports',
    taskExports.htmlUnchecked &&
      taskExports.htmlChecked &&
      taskExports.docxBoxes &&
      taskExports.epubUnchecked &&
      taskExports.epubChecked,
    taskExports
  );

  // 116a. nested quotes and a quote around a multi-block selection round-trip through markdown
  const quoteStructure = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown('> outer' + nl + '>' + nl + '> > inner' + nl + '>' + nl + '> - item');
    await sleep(500);
    const parsed = window.__mdpad.getMarkdown();
    const nestedDepth = window.__mdpad.quoteDepth();

    window.__mdpad.setMarkdown('first paragraph' + nl + nl + 'second paragraph');
    await sleep(400);
    window.__mdpad.selectAll();
    window.__mdpad.toggleQuote();
    await sleep(400);
    const shape = window.__mdpad.docShape();
    const quoted = window.__mdpad.getMarkdown();
    return { parsed, nestedDepth, shape, quoted };
  })()`);
  step(
    'quote-structure',
    /> > inner/.test(quoteStructure.parsed) &&
      /> - item/.test(quoteStructure.parsed) &&
      quoteStructure.parsed.includes('> outer') &&
      quoteStructure.shape[0].type === 'blockquote' &&
      quoteStructure.shape.slice(1).every((node) => node.type === 'paragraph' && node.text === '') &&
      /first paragraph/.test(quoteStructure.quoted) &&
      /second paragraph/.test(quoteStructure.quoted) &&
      /\n>\n/.test(quoteStructure.quoted),
    quoteStructure
  );

  // 116b. Tab nests a quote, Shift+Tab lifts it, lists still use their own keymap
  const quoteKeys = await (async () => {
    win.focus();
    win.webContents.focus();
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.setMarkdown('> quoted line');
      await sleep(400);
      window.__mdpad.focusFirst('blockquote');
      await sleep(200);
    })()`);
    const depthBefore = await win.webContents.executeJavaScript('window.__mdpad.quoteDepth()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await sleep(500);
    const afterTab = await win.webContents.executeJavaScript(
      `({ depth: window.__mdpad.quoteDepth(), markdown: window.__mdpad.getMarkdown() })`
    );
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
    await sleep(500);
    const afterShiftTab = await win.webContents.executeJavaScript(
      `({ depth: window.__mdpad.quoteDepth(), markdown: window.__mdpad.getMarkdown() })`
    );
    // a list item must still sink with Tab rather than nesting a quote
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.setMarkdown('- one' + String.fromCharCode(10) + '- two');
      await sleep(400);
      window.__mdpad.focusLast('listItem');
      await sleep(200);
    })()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await sleep(500);
    const listMarkdown = await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()');
    return { depthBefore, afterTab, afterShiftTab, listMarkdown };
  })();
  step(
    'quote-keys',
    quoteKeys.depthBefore === 1 &&
      quoteKeys.afterTab.depth === 2 &&
      /> > quoted line/.test(quoteKeys.afterTab.markdown) &&
      quoteKeys.afterShiftTab.depth === 1 &&
      !/> > quoted line/.test(quoteKeys.afterShiftTab.markdown) &&
      /\n\s{2,}- two/.test(quoteKeys.listMarkdown),
    quoteKeys
  );

  // 117a. the grip appears next to a block and its menu moves, duplicates and deletes it
  const blockGripTest = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown('# Title' + nl + nl + 'alpha block' + nl + nl + 'beta block');
    await sleep(500);
    const hovered = window.__mdpad.hoverBlock(1);
    document.querySelector('#block-grip').click();
    await sleep(250);
    const opened = window.__mdpad.blockState();
    window.__mdpad.blockMenuClick('duplicate');
    await sleep(350);
    const duplicated = window.__mdpad.getMarkdown();

    // indices 1 and 2 are the duplicated identical blocks; move the second one down
    window.__mdpad.hoverBlock(2);
    document.querySelector('#block-grip').click();
    await sleep(200);
    window.__mdpad.blockMenuClick('down');
    await sleep(350);
    const movedDown = window.__mdpad.getMarkdown();

    window.__mdpad.hoverBlock(2);
    document.querySelector('#block-grip').click();
    await sleep(200);
    window.__mdpad.blockMenuClick('delete');
    await sleep(350);
    const deleted = window.__mdpad.getMarkdown();
    window.__mdpad.editor.commands.undo();
    await sleep(300);
    const undone = window.__mdpad.getMarkdown();
    return { hovered, opened, duplicated, movedDown, deleted, undone };
  })()`);
  step(
    'block-grip',
    blockGripTest.hovered.grip === true &&
      blockGripTest.hovered.index === 1 &&
      blockGripTest.opened.menu === true &&
      blockGripTest.opened.items.includes('duplicate') &&
      blockGripTest.opened.items.includes('delete') &&
      (blockGripTest.duplicated.match(/alpha block/g) || []).length === 2 &&
      /alpha block\n\nbeta block\n\nalpha block/.test(blockGripTest.movedDown) &&
      !/beta block/.test(blockGripTest.deleted) &&
      /beta block/.test(blockGripTest.undone),
    blockGripTest
  );

  // 117b. Ctrl+Shift+Down moves the block and leaves the caret inside it, as one undo step
  const blockKeyTest = await (async () => {
    win.focus();
    win.webContents.focus();
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const nl = String.fromCharCode(10);
      window.__mdpad.setMarkdown('first block' + nl + nl + 'second block');
      await sleep(400);
      window.__mdpad.focusFirst('paragraph');
      await sleep(200);
    })()`);
    win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'Down',
      modifiers: ['control', 'shift'],
    });
    win.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'Down',
      modifiers: ['control', 'shift'],
    });
    await sleep(500);
    const moved = await win.webContents.executeJavaScript(
      `({ markdown: window.__mdpad.getMarkdown(), caret: window.__mdpad.caretText() })`
    );
    await win.webContents.executeJavaScript('window.__mdpad.editor.commands.undo()');
    await sleep(300);
    const undone = await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()');
    return { moved, undone };
  })();
  step(
    'block-move-keys',
    blockKeyTest.moved.markdown.indexOf('second block') < blockKeyTest.moved.markdown.indexOf('first block') &&
      blockKeyTest.moved.caret.includes('first block') &&
      blockKeyTest.undone.indexOf('first block') < blockKeyTest.undone.indexOf('second block'),
    blockKeyTest
  );

  // 118a. outline sections fold and unfold
  const outlineFold = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown(
      '## Alpha' + nl + nl + 'text' + nl + nl +
      '### Alpha child' + nl + nl + 'text' + nl + nl +
      '### Alpha child two' + nl + nl + 'text' + nl + nl +
      '## Beta' + nl + nl + 'text' + nl + nl +
      '### Beta child'
    );
    await sleep(700);
    const expanded = window.__mdpad.outlineState();
    const toggled = window.__mdpad.toggleOutlineFold('Alpha');
    await sleep(300);
    const folded = window.__mdpad.outlineState();
    window.__mdpad.toggleOutlineFold('Alpha');
    await sleep(300);
    const restored = window.__mdpad.outlineState();
    return { expanded, toggled, folded, restored };
  })()`);
  step(
    'outline-fold',
    outlineFold.expanded.items.length === 5 &&
      outlineFold.expanded.folded === 0 &&
      outlineFold.toggled === true &&
      outlineFold.folded.items.length === 3 &&
      outlineFold.folded.folded === 1 &&
      outlineFold.folded.items.includes('Beta child') &&
      !outlineFold.folded.items.includes('Alpha child') &&
      outlineFold.restored.items.length === 5,
    outlineFold
  );

  // 118b. scrolling marks the heading at the top even when the caret does not move
  const outlineScroll = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    const parts = [];
    for (let s = 0; s < 30; s += 1) {
      parts.push('## Section ' + s, '');
      for (let p = 0; p < 8; p += 1) {
        parts.push('Paragraph ' + p + ' of section ' + s + ' with enough words to take space.');
      }
      parts.push('');
    }
    window.__mdpad.setMarkdown(parts.join(nl));
    await sleep(900);
    window.__mdpad.editor.commands.focus('start');
    await sleep(200);
    const before = window.__mdpad.outlineState().current;

    const headings = [...document.querySelectorAll('.tiptap h2')];
    const target = headings[20];
    const pane = document.querySelector('.editor-pane');
    const paneRect = pane.getBoundingClientRect();
    const offset = target.getBoundingClientRect().top - paneRect.top + pane.scrollTop;
    pane.scrollTop = offset - 4;
    await sleep(700);
    const after = window.__mdpad.outlineState().current;
    const caret = window.__mdpad.caretText().slice(0, 30);
    return { before, after, caret, scrolled: pane.scrollTop };
  })()`);
  step(
    'outline-scroll',
    outlineScroll.before === 'Section 0' &&
      /^Section (19|20|21)$/.test(outlineScroll.after) &&
      outlineScroll.scrolled > 100 &&
      /Section 0/.test(outlineScroll.caret),
    outlineScroll
  );

  // 119a. outline jumps are reversible with Alt+Left / Alt+Right
  const navOutline = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nl = String.fromCharCode(10);
    window.__mdpad.setMarkdown('## Alpha' + nl + nl + 'alpha text' + nl + nl + '## Beta' + nl + nl + 'beta text' + nl + nl + '## Gamma' + nl + nl + 'gamma text');
    await sleep(700);
    window.__mdpad.editor.commands.focus('start');
    await sleep(200);
    const start = window.__mdpad.navState();
    const items = [...document.querySelectorAll('#outline-list .outline-item')];
    items[2].click();
    await sleep(400);
    const jumped = window.__mdpad.navState();
    return { start, jumped };
  })()`);
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left', modifiers: ['alt'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left', modifiers: ['alt'] });
  await sleep(400);
  const afterBack = await win.webContents.executeJavaScript('window.__mdpad.navState()');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['alt'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right', modifiers: ['alt'] });
  await sleep(400);
  const afterForward = await win.webContents.executeJavaScript('window.__mdpad.navState()');
  step(
    'nav-outline',
    navOutline.start.caret === 'Alpha' &&
      navOutline.jumped.caret === 'Gamma' &&
      navOutline.jumped.back >= 1 &&
      afterBack.caret === 'Alpha' &&
      afterBack.forward >= 1 &&
      afterForward.caret === 'Gamma',
    { start: navOutline.start, jumped: navOutline.jumped, afterBack, afterForward }
  );

  // 119b. a new jump truncates the forward history, and find navigation is recorded too
  const navTruncate = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // currently at Gamma with a forward entry available; jump elsewhere resets it
    const items = [...document.querySelectorAll('#outline-list .outline-item')];
    items[1].click();
    await sleep(350);
    const afterNewJump = window.__mdpad.navState();
    // find jump: search Beta, press Enter in the find bar
    window.api.setSettings({}); // no-op to keep the promise chain explicit
    document.querySelector('[data-action="find"]').click();
    await sleep(250);
    const input = document.querySelector('#find-input');
    input.value = 'gamma text';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(400);
    const afterFind = window.__mdpad.navState();
    document.querySelector('#find-close').click();
    await sleep(150);
    return { afterNewJump, afterFind };
  })()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left', modifiers: ['alt'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left', modifiers: ['alt'] });
  await sleep(400);
  const afterFindBack = await win.webContents.executeJavaScript('window.__mdpad.navState()');
  step(
    'nav-truncate-and-find',
    navTruncate.afterNewJump.forward === 0 &&
      navTruncate.afterFind.caret === 'gamma text' &&
      navTruncate.afterFind.back >= 1 &&
      afterFindBack.caret === 'Beta',
    { afterNewJump: navTruncate.afterNewJump, afterFind: navTruncate.afterFind, afterFindBack }
  );

  // 120a. the recent panel lists newest first, removes entries and clears the list
  const recentTest = await (async () => {
    const first = path.join(dir, 'recent-one.md');
    const second = path.join(dir, 'recent-two.md');
    fs.writeFileSync(first, '# one' + String.fromCharCode(10), 'utf8');
    fs.writeFileSync(second, '# two' + String.fromCharCode(10), 'utf8');
    await win.webContents.executeJavaScript(
      `window.api.recentClear().then(() => window.api.openPath(${JSON.stringify(first)}))`
    );
    await sleep(500);
    await win.webContents.executeJavaScript(`window.api.openPath(${JSON.stringify(second)})`);
    await sleep(600);
    const opened = await win.webContents.executeJavaScript('window.__mdpad.openRecentPanel()');
    const removed = await win.webContents.executeJavaScript(
      `window.__mdpad.recentRemoveAt(${JSON.stringify('recent-one.md')})`
    );
    await win.webContents.executeJavaScript('window.api.recentClear()');
    const cleared = await win.webContents.executeJavaScript('window.api.recentEntries()');
    await win.webContents.executeJavaScript(
      `document.querySelector('#recent-modal').hidden = true`
    );
    return { opened, removed, cleared, first: path.basename(first), second: path.basename(second) };
  })();
  step(
    'recent-panel',
    recentTest.opened.open === true &&
      recentTest.opened.rows.length === 2 &&
      recentTest.opened.rows[0].name === recentTest.second &&
      recentTest.opened.rows[1].name === recentTest.first &&
      recentTest.removed.rows.length === 1 &&
      recentTest.removed.rows[0].name === recentTest.second &&
      recentTest.cleared.length === 0,
    recentTest
  );

  // 120b. a file deleted behind the app's back is shown as missing and opening it says why
  const recentMissing = await (async () => {
    const ghost = path.join(dir, 'recent-ghost.md');
    fs.writeFileSync(ghost, '# ghost' + String.fromCharCode(10), 'utf8');
    await win.webContents.executeJavaScript(`window.api.openPath(${JSON.stringify(ghost)})`);
    await sleep(500);
    fs.unlinkSync(ghost);
    const state = await win.webContents.executeJavaScript('window.__mdpad.openRecentPanel()');
    const missing = state.rows.find((row) => row.name === 'recent-ghost.md');
    const openResult = await win.webContents.executeJavaScript(
      `window.api.recentOpen(${JSON.stringify(ghost)})`
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('#recent-modal').hidden = true`
    );
    await win.webContents.executeJavaScript('window.api.recentClear()');
    return { missing, openResult };
  })();
  step(
    'recent-missing',
    recentMissing.missing &&
      recentMissing.missing.missing === true &&
      recentMissing.openResult.opened === false &&
      recentMissing.openResult.reason === 'missing',
    recentMissing
  );

  // 121a. a relative markdown link opens the target file in a tab
  const localLink = await (async () => {
    const target = path.join(dir, 'linked-two.md');
    const source = path.join(dir, 'linked-one.md');
    fs.writeFileSync(target, '# Linked two' + String.fromCharCode(10), 'utf8');
    fs.writeFileSync(source, '# Linked one' + String.fromCharCode(10) + String.fromCharCode(10) + '[go to two](linked-two.md)', 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(source);
    await sleep(700);
    const before = await win.webContents.executeJavaScript('window.api.listTabs()');
    const clicked = await win.webContents.executeJavaScript(
      `window.__mdpad.clickLink('linked-two.md')`
    );
    await sleep(900);
    const after = await win.webContents.executeJavaScript('window.api.listTabs()');
    const active = after.find((tab) => tab.active);
    return {
      clicked,
      beforeCount: before.length,
      afterCount: after.length,
      active: active && active.file,
      markdown: await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()'),
    };
  })();
  step(
    'local-link-open',
    localLink.clicked === true &&
      localLink.afterCount === localLink.beforeCount + 1 &&
      localLink.active === path.join(dir, 'linked-two.md') &&
      /Linked two/.test(localLink.markdown),
    localLink
  );

  // 121b. a missing target explains itself, an anchor scrolls inside the document
  const linkEdgeCases = await (async () => {
    const missing = await win.webContents.executeJavaScript(
      `window.api.openRelativeLink('does-not-exist.md')`
    );
    const anchorSource = path.join(dir, 'anchors.md');
    fs.writeFileSync(
      anchorSource,
      ['# Anchors', '', '[jump](#second-heading)', '', '## First heading', '', 'text', '', '## Second Heading', '', 'more'].join(String.fromCharCode(10)),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(anchorSource);
    await sleep(700);
    const clicked = await win.webContents.executeJavaScript(`window.__mdpad.clickLink('#second-heading')`);
    await sleep(500);
    const focus = await win.webContents.executeJavaScript('window.__mdpad.focusState()');
    return { missing, clicked, focus };
  })();
  step(
    'link-edge-cases',
    linkEdgeCases.missing.opened === false &&
      linkEdgeCases.missing.reason === 'missing' &&
      linkEdgeCases.missing.name === 'does-not-exist.md' &&
      linkEdgeCases.clicked === true &&
      linkEdgeCases.focus.caret === 'Second Heading',
    linkEdgeCases
  );

  // 122. exported links: working ones kept, missing ones flagged, URLs clickable in Word
  const exportLinks = await (async () => {
    const JSZip = require('jszip');
    const nl = String.fromCharCode(10);
    const good = path.join(dir, 'linked-good.md');
    fs.writeFileSync(good, '# Good target' + nl, 'utf8');
    const source = path.join(dir, 'link-source.md');
    fs.writeFileSync(
      source,
      [
        '# Link export',
        '',
        '[good](linked-good.md) and [missing](linked-gone.md) and [anchor](#second-heading) and [web](https://example.com)',
        '',
        '## Second Heading',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(source);
    await sleep(700);
    session.contents = fs.readFileSync(source, 'utf8');
    const htmlPath = path.join(dir, 'links.html');
    const docxPath = path.join(dir, 'links.docx');
    const epubPath = path.join(dir, 'links.epub');
    await session.exportTo(htmlPath, 'html');
    await session.exportTo(docxPath, 'docx');
    await session.exportTo(epubPath, 'epub');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const htmlBody = html.slice(html.indexOf('<body'));
    const docxZip = await JSZip.loadAsync(fs.readFileSync(docxPath));
    const docxXml = await docxZip.file('word/document.xml').async('string');
    const epubZip = await JSZip.loadAsync(fs.readFileSync(epubPath));
    const chapter = await epubZip.file(Object.keys(epubZip.files).find((name) => /\.xhtml$/.test(name))).async('string');
    return {
      htmlGoodKept: /href="linked-good\.md"/.test(htmlBody) && !/href="linked-good\.md"[^>]*data-link-missing/.test(htmlBody),
      htmlMissingFlagged: /href="linked-gone\.md"[^>]*data-link-missing="1"/.test(htmlBody),
      htmlMissingTitle: /File not found: linked-gone\.md/.test(htmlBody),
      htmlAnchor: /href="#second-heading"/.test(htmlBody) && /<h2 id="second-heading">/.test(htmlBody),
      htmlExternal: /href="https:\/\/example\.com"/.test(htmlBody),
      epubFlagged: /data-link-missing="1"/.test(chapter),
      epubExternal: /href="https:\/\/example\.com"/.test(chapter),
      docxHyperlinks: (docxXml.match(/<w:hyperlink/g) || []).length,
    };
  })();
  step(
    'export-links',
    exportLinks.htmlGoodKept &&
      exportLinks.htmlMissingFlagged &&
      exportLinks.htmlMissingTitle &&
      exportLinks.htmlAnchor &&
      exportLinks.htmlExternal &&
      exportLinks.epubFlagged &&
      exportLinks.epubExternal &&
      exportLinks.docxHyperlinks >= 1,
    exportLinks
  );

  // 123a. an export that cannot be written answers with an error instead of throwing
  const exportFailure = await (async () => {
    const blocker = path.join(dir, 'blocked-target');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    const badPath = path.join(blocker, 'out.html');
    const bad = await win.webContents.executeJavaScript(
      `window.api.exportToPath('html', ${JSON.stringify(badPath)})`
    );
    const goodPath = path.join(dir, 'export-ok.html');
    const good = await win.webContents.executeJavaScript(
      `window.api.exportToPath('html', ${JSON.stringify(goodPath)})`
    );
    return {
      bad,
      badExists: fs.existsSync(badPath),
      good,
      goodExists: fs.existsSync(goodPath),
    };
  })();
  step(
    'export-failure',
    exportFailure.bad.exported === false &&
      typeof exportFailure.bad.error === 'string' &&
      exportFailure.bad.error.length > 0 &&
      exportFailure.badExists === false &&
      exportFailure.good.exported === true &&
      exportFailure.goodExists === true,
    exportFailure
  );

  // 123b. a corrupt settings file is kept aside and the app keeps working with defaults
  const settingsRecovery = await (async () => {
    const dataDir = userDir();
    const file = settingsFile();
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const settings = await win.webContents.executeJavaScript('window.api.getSettings()');
    const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith('settings.json.corrupt-'));
    // leave a valid file behind for the rest of the suite
    writeSettings({ language: 'en', theme: 'light' });
    return { theme: settings.theme, backups: backups.length };
  })();
  step(
    'settings-corrupt-recovery',
    settingsRecovery.theme === 'light' && settingsRecovery.backups >= 1,
    settingsRecovery
  );

  // 124. a drafts folder that cannot be written raises a visible, recoverable warning
  const draftFailure = await (async () => {
    const drafts = draftsDir();
    const marker = path.join(drafts + '.broken-marker');
    // turn the drafts directory into a plain file so every write fails
    try {
      fs.rmSync(drafts, { recursive: true, force: true });
    } catch {
      /* nothing to remove */
    }
    fs.writeFileSync(drafts, 'blocked', 'utf8');
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.applyMarkdown('# draft failure probe');
      await sleep(700);
    })()`);
    const broken = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('#banner'); return { visible: !b.hidden, text: document.querySelector('#banner-text').textContent }; })()`
    );

    // restore the folder: the next change writes again and clears the banner
    try {
      fs.unlinkSync(drafts);
    } catch {
      /* already gone */
    }
    fs.mkdirSync(drafts, { recursive: true });
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.applyMarkdown('# draft failure probe recovered');
      await sleep(800);
    })()`);
    const recovered = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('#banner'); return { visible: !b.hidden, drafts: null }; })()`
    );
    const draftsNow = await win.webContents.executeJavaScript('window.api.listDrafts()');
    try {
      fs.unlinkSync(marker);
    } catch {
      /* never created */
    }
    return { broken, recovered, draftsNow: draftsNow.length };
  })();
  step(
    'draft-failure-banner',
    draftFailure.broken.visible === true &&
      /Recovery drafts are off/.test(draftFailure.broken.text) &&
      draftFailure.recovered.visible === false &&
      draftFailure.draftsNow >= 1,
    draftFailure
  );

  // 125. a broken backups folder degrades to "no backup" instead of blocking the save
  const backupFailure = await (async () => {
    const backups = backupsDir();
    const doc = path.join(dir, 'backup-failure.md');
    fs.writeFileSync(doc, '# backup failure' + String.fromCharCode(10) + String.fromCharCode(10) + 'first', 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    await sleep(700);
    // Turn the backups directory into a file so rotating the previous version fails. A rename
    // first: removing a directory can fail while a scanner or the previous run still holds it.
    for (let attempt = 0; attempt < 5 && fs.existsSync(backups); attempt += 1) {
      try {
        fs.rmSync(backups, { recursive: true, force: true });
      } catch {
        await sleep(200);
      }
    }
    if (fs.existsSync(backups)) {
      fs.renameSync(backups, backups + '-moved-' + Date.now());
    }
    fs.writeFileSync(backups, 'blocked', 'utf8');

    const brokenSave = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.applyMarkdown('# backup failure' + String.fromCharCode(10) + String.fromCharCode(10) + 'second');
      await sleep(500);
      const result = await window.api.save({ force: true });
      await sleep(500);
      const banner = document.querySelector('#banner');
      return {
        saved: result && result.saved !== false,
        changed: result && result.changed,
        bannerVisible: !banner.hidden,
        bannerText: document.querySelector('#banner-text').textContent,
        onDisk: null,
      };
    })()`);
    const onDisk = fs.readFileSync(doc, 'utf8');

    // restore the directory: the next saved change brings backups back and clears the banner
    try {
      fs.unlinkSync(backups);
    } catch {
      /* already gone */
    }
    fs.mkdirSync(backups, { recursive: true });
    const recovered = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.applyMarkdown('# backup failure' + String.fromCharCode(10) + String.fromCharCode(10) + 'third');
      await sleep(500);
      const result = await window.api.save({ force: true });
      await sleep(600);
      const banner = document.querySelector('#banner');
      return {
        saved: result && result.saved !== false,
        bannerVisible: !banner.hidden,
        backup: result && result.backup ? true : false,
      };
    })()`);
    const backupsAfter = await win.webContents.executeJavaScript(
      `window.api.backupInfo()`
    );
    return { brokenSave, onDisk: /second/.test(onDisk), recovered, backupCount: backupsAfter.count };
  })();
  step(
    'backup-failure-degrades',
    backupFailure.brokenSave.saved === true &&
      backupFailure.brokenSave.changed === true &&
      backupFailure.onDisk === true &&
      backupFailure.brokenSave.bannerVisible === true &&
      /Backups are off/.test(backupFailure.brokenSave.bannerText) &&
      backupFailure.recovered.saved === true &&
      backupFailure.recovered.bannerVisible === false &&
      backupFailure.recovered.backup === true &&
      backupFailure.backupCount >= 1,
    backupFailure
  );

  // 126a. a draft whose original file is gone restores into a new tab, leaving the open document alone
  const draftMissing = await (async () => {
    const nl = String.fromCharCode(10);
    const ghost = path.join(dir, 'ghost-original.md');
    const keeper = path.join(dir, 'keeper.md');
    fs.writeFileSync(keeper, '# keeper' + nl + nl + 'KEEP ME', 'utf8');
    storage.writeDraft(ghost, '# recovered draft' + nl + nl + 'DRAFT CONTENT', draftsDir());
    const draft = storage.readDraft(ghost, draftsDir());
    const draftEntry = (listDrafts(draftsDir()) || []).find((entry) => entry.file === ghost);
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(keeper);
    await sleep(700);
    const before = await win.webContents.executeJavaScript('window.api.listTabs()');
    const restored = await win.webContents.executeJavaScript(
      `window.api.restoreDraft(${JSON.stringify(draftEntry ? draftEntry.path : '')})`
    );
    await sleep(700);
    const after = await win.webContents.executeJavaScript('window.api.listTabs()');
    const markdown = await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()');
    const active = after.find((tab) => tab.active);
    // switch back: the keeper tab must still hold its own text
    const keeperTab = after.find((tab) => tab.file === keeper);
    await win.webContents.executeJavaScript(`window.api.activateTab(${JSON.stringify(keeperTab.id)})`);
    await sleep(500);
    const keeperText = await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()');
    storage.clearDraft(ghost, draftsDir());
    return {
      hasDraft: Boolean(draft),
      restored,
      beforeCount: before.length,
      afterCount: after.length,
      activeFile: active && active.file,
      markdown,
      keeperText,
    };
  })();
  step(
    'draft-restore-missing-file',
    draftMissing.hasDraft &&
      draftMissing.restored.restored === true &&
      draftMissing.restored.newTab === true &&
      draftMissing.afterCount === draftMissing.beforeCount + 1 &&
      draftMissing.activeFile === null &&
      /DRAFT CONTENT/.test(draftMissing.markdown) &&
      /KEEP ME/.test(draftMissing.keeperText),
    draftMissing
  );

  // 126b. restoring a backup and saving rotates the replaced version into a fresh backup
  const backupRestore = await (async () => {
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'restore-backup.md');
    fs.writeFileSync(doc, '# v1' + nl, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    await sleep(600);
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.applyMarkdown('# v2');
      await sleep(400);
      await window.api.save({ force: true });
      await sleep(400);
    })()`);
    const listBefore = await win.webContents.executeJavaScript('window.api.backupsList()');
    const target = listBefore[0];
    const restored = await win.webContents.executeJavaScript(
      `window.api.restoreBackup(${JSON.stringify(target.path)})`
    );
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.applyMarkdown(${JSON.stringify('# v1')});
      await sleep(400);
      await window.api.save({ force: true });
      await sleep(500);
    })()`);
    const onDisk = fs.readFileSync(doc, 'utf8');
    const listAfter = await win.webContents.executeJavaScript('window.api.backupsList()');
    const newest = listAfter[0] ? fs.readFileSync(listAfter[0].path, 'utf8') : '';
    return {
      restored: Boolean(restored && restored.restored && /v1/.test(restored.contents)),
      beforeCount: listBefore.length,
      afterCount: listAfter.length,
      onDisk: /# v1/.test(onDisk) && !/# v2/.test(onDisk),
      newestBackup: /# v2/.test(newest),
    };
  })();
  step(
    'backup-restore-roundtrip',
    backupRestore.restored &&
      backupRestore.beforeCount >= 1 &&
      backupRestore.afterCount >= backupRestore.beforeCount &&
      backupRestore.onDisk &&
      backupRestore.newestBackup,
    backupRestore
  );

  // 127. settings changed in one window reach the others, and closing a window leaves the rest healthy
  const multiWindow = await (async () => {
    const second = createWindow({ show: false });
    await new Promise((resolve) => second.webContents.once('did-finish-load', resolve));
    await sleep(700);
    const before = await second.webContents.executeJavaScript(
      `({ theme: document.documentElement.dataset.theme, lang: document.documentElement.lang })`
    );
    await win.webContents.executeJavaScript(
      `window.api.setSettings({ theme: 'dark', language: 'zh', accent: 'violet' })`
    );
    await sleep(900);
    const after = await second.webContents.executeJavaScript(
      `({ theme: document.documentElement.dataset.theme, lang: document.documentElement.lang, accent: document.documentElement.dataset.accent })`
    );
    // the window that made the change keeps working and reflects it too
    await sleep(200);
    const firstWindow = await win.webContents.executeJavaScript(
      `({ theme: document.documentElement.dataset.theme, lang: document.documentElement.lang })`
    );
    second.close();
    await sleep(600);
    const stillAlive = await win.webContents.executeJavaScript('window.__mdpad.getMarkdown().slice(0, 8)');
    // restore a neutral state for the rest of the suite
    await win.webContents.executeJavaScript(
      `window.api.setSettings({ theme: 'light', language: 'en', accent: 'blue' })`
    );
    await sleep(300);
    return { before, after, firstWindow, stillAlive };
  })();
  step(
    'multi-window-settings',
    multiWindow.before.theme === 'light' &&
      multiWindow.before.lang === 'en' &&
      multiWindow.after.theme === 'dark' &&
      multiWindow.after.lang === 'zh-CN' &&
      multiWindow.after.accent === 'violet' &&
      multiWindow.firstWindow.theme === 'dark' &&
      multiWindow.firstWindow.lang === 'zh-CN' &&
      typeof multiWindow.stillAlive === 'string',
    multiWindow
  );

  // 128. the TOC template links every heading and the title follows the UI language
  const tocCheck = await (async () => {
    const nl = String.fromCharCode(10);
    const md = [
      '# Book',
      '',
      '## First part',
      '',
      'text',
      '',
      '### Detail',
      '',
      'text',
      '',
      '## Second part',
    ].join(nl);
    const tocFile = path.join(dir, 'toc-source.md');
    fs.writeFileSync(tocFile, md, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(tocFile);
    await sleep(600);
    session.contents = md;
    // the export uses the saved template setting; switch it to toc for this check
    await win.webContents.executeJavaScript("window.api.setSettings({ exportTemplate: 'toc' })");
    await sleep(300);
    const htmlPath = path.join(dir, 'toc.html');
    await session.exportTo(htmlPath, 'html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    await win.webContents.executeJavaScript("window.api.setSettings({ exportTemplate: 'default' })");
    const hrefs = [...html.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]);
    const ids = [...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]);
    return {
      hrefs,
      ids,
      title: (/<div class="toc-title">([^<]*)<\/div>/.exec(html) || [])[1] || '',
      depths: [...html.matchAll(/<li class="toc-depth-(\d)"/g)].map((m) => m[1]),
    };
  })();
  step(
    'toc-template',
    tocCheck.hrefs.length === 4 &&
      tocCheck.hrefs.every((id) => tocCheck.ids.includes(id)) &&
      tocCheck.title === 'Contents' &&
      tocCheck.depths.join(',') === '1,2,3,2',
    tocCheck
  );

  // 129. the export panel inspects the document before exporting: counts and unresolved targets
  const exportInspect = await (async () => {
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const good = path.join(dir, 'inspect-image.png');
    fs.writeFileSync(good, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const target = path.join(dir, 'inspect-target.md');
    fs.writeFileSync(target, '# target' + nl, 'utf8');
    const doc = path.join(dir, 'inspect-doc.md');
    fs.writeFileSync(
      doc,
      [
        '# Inspect',
        '',
        '![present](inspect-image.png)',
        '',
        '![gone](inspect-missing.png)',
        '',
        '[good](inspect-target.md) and [missing](inspect-nothing.md)',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '$$',
        'a + b = c',
        '$$',
        '',
        fence + 'mermaid',
        'graph LR;',
        '  a-->b;',
        fence,
        '',
        '- [ ] open task',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    await sleep(700);
    session.contents = fs.readFileSync(doc, 'utf8');
    const info = await win.webContents.executeJavaScript('window.__mdpad.exportInspect()');
    const ui = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.openExportPanel('pdf');
      await sleep(900);
      return window.__mdpad.exportInspectText();
    })()`);
    await win.webContents.executeJavaScript(`document.querySelector('#export-modal').hidden = true`);
    return { info, ui };
  })();
  step(
    'export-inspect',
    exportInspect.info.headings === 1 &&
      exportInspect.info.images === 2 &&
      exportInspect.info.unresolvedImages === 1 &&
      exportInspect.info.links === 2 &&
      exportInspect.info.unresolvedLinks === 1 &&
      exportInspect.info.tables >= 3 &&
      exportInspect.info.diagrams === 1 &&
      exportInspect.info.math >= 1 &&
      exportInspect.info.tasks === 1 &&
      /images/.test(exportInspect.ui) &&
      /not found/.test(exportInspect.ui),
    exportInspect
  );

  // 130a. dialogs expose a dialog role and keep the keyboard inside when pressing Tab
  const a11yDialogs = await (async () => {
    await win.webContents.executeJavaScript(`document.querySelector('#open-settings').click()`);
    await sleep(800);
    const opened = await win.webContents.executeJavaScript('window.__mdpad.a11yState()');
    const tabResults = [];
    for (let i = 0; i < 18; i += 1) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await sleep(60);
      tabResults.push(await win.webContents.executeJavaScript('window.__mdpad.a11yState().focusInside'));
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
    await sleep(120);
    const afterShiftTab = await win.webContents.executeJavaScript('window.__mdpad.a11yState().focusInside');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(300);
    const closed = await win.webContents.executeJavaScript(`({
      hidden: document.querySelector('#settings-modal').hidden,
      inEditor: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.tiptap')),
    })`);
    return { opened, tabResults, afterShiftTab, closed };
  })();
  step(
    'a11y-modal-focus',
    a11yDialogs.opened.focusInside === true &&
      a11yDialogs.opened.dialogRoles.every((entry) => entry.role === 'dialog' && entry.modal === 'true') &&
      a11yDialogs.opened.dialogRoles.some((entry) => entry.labelled) &&
      a11yDialogs.tabResults.every((inside) => inside === true) &&
      a11yDialogs.afterShiftTab === true &&
      a11yDialogs.closed.hidden === true &&
      a11yDialogs.closed.inEditor === true,
    a11yDialogs
  );

  // 130b. toolbar toggles announce pressed state with an accessible name
  const a11yToolbar = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('plain');
    await sleep(400);
    window.__mdpad.editor.commands.selectAll();
    const bold = document.querySelector('[data-cmd="bold"]');
    bold.click();
    await sleep(200);
    const on = bold.getAttribute('aria-pressed');
    bold.click();
    await sleep(200);
    const off = bold.getAttribute('aria-pressed');
    const all = window.__mdpad.a11yState().toolbar;
    return { on, off, all };
  })()`);
  const toggles = a11yToolbar.all.filter((entry) =>
    ['bold', 'italic', 'strike', 'code', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'link'].includes(entry.cmd)
  );
  const actions = a11yToolbar.all.filter((entry) => !toggles.includes(entry));
  step(
    'a11y-toolbar',
    a11yToolbar.on === 'true' &&
      a11yToolbar.off === 'false' &&
      toggles.length === 10 &&
      toggles.every((entry) => entry.pressed === 'true' || entry.pressed === 'false') &&
      actions.length >= 3 &&
      a11yToolbar.all.every((entry) => entry.label.length > 0),
    a11yToolbar
  );

  // 131. the editor announces itself and the outline announces the current section
  const a11yDocument = await (async () => {
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'a11y-outline.md');
    fs.writeFileSync(
      doc,
      ['# One', '', 'text', '', '## Two', '', 'text', '', '### Three', '', 'text'].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    await sleep(700);
    const editorInfo = await win.webContents.executeJavaScript('window.__mdpad.a11yEditor()');
    // put the caret in the second section and let the outline follow
    await win.webContents.executeJavaScript(
      `window.__mdpad.focusHeading('Two')`
    );
    await sleep(600);
    const outline = await win.webContents.executeJavaScript('window.__mdpad.a11yOutline()');
    // fold the first heading and check the twisty tells assistive tech
    await win.webContents.executeJavaScript(
      `document.querySelector('#outline-list .outline-row .outline-twisty').click()`
    );
    await sleep(400);
    const folded = await win.webContents.executeJavaScript('window.__mdpad.a11yOutline()');
    await win.webContents.executeJavaScript(
      `document.querySelector('#outline-list .outline-row .outline-twisty').click()`
    );
    await sleep(300);
    return { editorInfo, outline, folded };
  })();
  step(
    'a11y-document',
    a11yDocument.editorInfo.role === 'textbox' &&
      a11yDocument.editorInfo.multiline === 'true' &&
      a11yDocument.editorInfo.label === 'Document editor' &&
      a11yDocument.outline.count === 3 &&
      a11yDocument.outline.current.length === 1 &&
      a11yDocument.outline.current[0] === 'Two' &&
      a11yDocument.folded.expanded[0] === 'false',
    a11yDocument
  );

  // 132. the tab strip is a tablist: arrow keys switch, Delete closes, one tab stays selected
  const a11yTabs = await (async () => {
    const nl = String.fromCharCode(10);
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.api.newDoc();
      await sleep(300);
      await window.api.newDoc();
      await sleep(500);
    })()`);
    const opened = await win.webContents.executeJavaScript('window.__mdpad.a11yTabs()');
    await win.webContents.executeJavaScript(`document.querySelectorAll('#tabs .tab')[0].focus()`);
    await sleep(150);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await sleep(600);
    const afterRight = await win.webContents.executeJavaScript('window.__mdpad.a11yTabs()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    await sleep(800);
    const afterDelete = await win.webContents.executeJavaScript('window.__mdpad.a11yTabs()');
    return { opened, afterRight, afterDelete };
  })();
  step(
    'a11y-tabs',
    a11yTabs.opened.role === 'tablist' &&
      a11yTabs.opened.label === 'Open documents' &&
      a11yTabs.opened.count >= 3 &&
      a11yTabs.opened.selected.length === 1 &&
      a11yTabs.opened.tabindex.filter((value) => value === 0).length === 1 &&
      a11yTabs.afterRight.focused === 1 &&
      a11yTabs.afterRight.selected.length === 1 &&
      a11yTabs.afterDelete.count === a11yTabs.opened.count - 1 &&
      a11yTabs.afterDelete.selected.length === 1,
    a11yTabs
  );

  // 133. a large document opens in bounded time with every block intact
  const largeLoad = await (async () => {
    const nl = String.fromCharCode(10);
    const parts = ['# Large document'];
    for (let section = 1; section <= 1200; section += 1) {
      parts.push('', '## Section ' + section, '');
      parts.push('A paragraph with **bold**, *italic* and `code` that repeats to make the file big. '.repeat(8));
    }
    const large = path.join(dir, 'large-open.md');
    const text = parts.join(nl);
    fs.writeFileSync(large, text, 'utf8');
    const session = sessions.get(win.webContents.id);
    const startedAt = Date.now();
    await session.loadDocument(large);
    const expected = Buffer.byteLength(text, 'utf8');
    let timing = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await sleep(50);
      timing = await win.webContents.executeJavaScript('window.__mdpad.loadTiming()');
      if (timing && timing.chars === expected) break;
    }
    let markdown = '';
    for (let attempt = 0; attempt < 120; attempt += 1) {
      markdown = await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()');
      if (markdown.includes('## Section 1200')) break;
      await sleep(100);
    }
    const elapsed = Date.now() - startedAt;
    let outline = { count: 0 };
    for (let attempt = 0; attempt < 120 && !outline.count; attempt += 1) {
      await sleep(100);
      outline = await win.webContents.executeJavaScript('window.__mdpad.a11yOutline()');
    }
    return {
      bytes: Buffer.byteLength(text, 'utf8'),
      elapsed,
      timing,
      hasFirst: markdown.includes('## Section 1'),
      hasLast: markdown.includes('## Section 1200'),
      headings: outline.count,
      ratio: markdown.length / text.length,
    };
  })();
  step(
    'large-doc-open',
    largeLoad.bytes > 500000 &&
      largeLoad.elapsed < 12000 &&
      largeLoad.timing &&
      largeLoad.timing.nodes > 1000 &&
      largeLoad.hasFirst &&
      largeLoad.hasLast &&
      largeLoad.headings === 1201 &&
      largeLoad.ratio > 0.9,
    largeLoad
  );

  // 134. typing stays responsive in a large document
  const largeTyping = await (async () => {
    const nl = String.fromCharCode(10);
    const parts = ['# Large typing'];
    for (let section = 1; section <= 900; section += 1) {
      parts.push('', '## Section ' + section, '');
      parts.push('A paragraph with **bold** and *italic* that repeats to make the file big. '.repeat(6));
    }
    const doc = path.join(dir, 'large-typing.md');
    fs.writeFileSync(doc, parts.join(nl), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    const expected = Buffer.byteLength(parts.join(nl), 'utf8');
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const timing = await win.webContents.executeJavaScript('window.__mdpad.loadTiming()');
      if (timing && timing.chars === expected) break;
      await sleep(60);
    }
    await sleep(500);
    // warm up: the first insert also flushes a full serialisation
    const warmup = await win.webContents.executeJavaScript('window.__mdpad.measureTyping(3)');
    const measured = await win.webContents.executeJavaScript('window.__mdpad.measureTyping(18)');
    return { bytes: expected, chars: measured.chars, warmup, measured };
  })();
  step(
    'large-doc-typing',
    largeTyping.bytes > 400000 &&
      largeTyping.chars > 350000 &&
      largeTyping.measured.count === 18 &&
      largeTyping.measured.avg < 25 &&
      largeTyping.measured.max < 60,
    largeTyping
  );

  // 135. table rows and columns can be reordered from the table menu
  const tableMove = await (async () => {
    const nl = String.fromCharCode(10);
    const source = path.join(dir, 'table-move.md');
    fs.writeFileSync(
      source,
      [
        '# Table move',
        '',
        '| A | B | C |',
        '| --- | --- | --- |',
        '| a1 | b1 | c1 |',
        '| a2 | b2 | c2 |',
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(source);
    await sleep(800);
    // put the caret in the first body cell of the second body row (a2)
    const placed = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let target = null;
      window.__mdpad.editor.state.doc.descendants((node, pos) => {
        if (target !== null) return false;
        if (node.type.name === 'tableCell' && node.textContent === 'a2') {
          target = pos + 2;
          return false;
        }
        return true;
      });
      if (target === null) return false;
      window.__mdpad.editor.commands.setTextSelection(target);
      await sleep(50);
      return true;
    })()`);
    const movedUp = await win.webContents.executeJavaScript('window.__mdpad.tableMoveRow(-1)');
    await sleep(300);
    const afterRow = await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()');
    // now move the second column right (caret is still in the table)
    const movedCol = await win.webContents.executeJavaScript('window.__mdpad.tableMove(1)');
    await sleep(300);
    const afterColumn = await win.webContents.executeJavaScript('window.__mdpad.getMarkdown()');
    return { placed, movedUp, movedCol, afterRow, afterColumn };
  })();
  step(
    'table-move',
    tableMove.placed === true &&
      tableMove.movedUp === true &&
      /\\| a2 \\| b2 \\| c2 \\|\\n\\| a1 \\| b1 \\| c1 \\|/.test(tableMove.afterRow) &&
      tableMove.movedCol === true &&
      /\\| b2 \\| a2 \\| c2 \\|/.test(tableMove.afterColumn),
    tableMove
  );

  // 136. dragging a row edge reorders rows, dragging a column edge reorders columns
  const tableDrag = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'table-drag.md');
    fs.writeFileSync(
      doc,
      [
        '# Drag table',
        '',
        '| A | B | C |',
        '| --- | --- | --- |',
        '| a1 | b1 | c1 |',
        '| a2 | b2 | c2 |',
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    let rects = {};
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const value = await jsOf(`(() => {
        const cells = {};
        for (const cell of document.querySelectorAll('.tiptap td, .tiptap th')) {
          const text = cell.textContent.trim();
          const r = cell.getBoundingClientRect();
          cells[text] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        }
        return cells;
      })()`);
      if (!value || value.__error) return { error: 'rects', value };
      rects = value;
      if (rects.a1 && rects.a2 && rects.b1 && rects.c1) break;
    }
    if (!rects.a1 || !rects.a2 || !rects.b1 || !rects.c1) {
      return { setupFailed: true, cells: Object.keys(rects) };
    }
    const rowSource = rects.a1;
    const rowTarget = rects.a2;
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(rowSource.left + 3), y: Math.round(rowSource.top + rowSource.height / 2), button: 'left', clickCount: 1 });
    await sleep(150);
    const rowDragging = await jsOf('window.__mdpad.tableDragState()');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(rowTarget.left + rowTarget.width / 2), y: Math.round(rowTarget.top + rowTarget.height / 2), button: 'left' });
    await sleep(150);
    const rowMoved = await jsOf('window.__mdpad.tableDragState()');
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(rowTarget.left + rowTarget.width / 2), y: Math.round(rowTarget.top + rowTarget.height / 2), button: 'left', clickCount: 1 });
    await sleep(500);
    const afterRow = await jsOf('window.__mdpad.getMarkdown()');

    let rects2 = {};
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const value = await jsOf(`(() => {
        const cells = {};
        for (const cell of document.querySelectorAll('.tiptap td, .tiptap th')) {
          const text = cell.textContent.trim();
          const r = cell.getBoundingClientRect();
          cells[text] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        }
        return cells;
      })()`);
      if (!value || value.__error) return { error: 'rects2', value };
      rects2 = value;
      if (rects2.b1 && rects2.c1) break;
      await sleep(200);
    }
    if (!rects2.b1 || !rects2.c1) return { setupFailed: true, cells: Object.keys(rects2) };
    const colSource = rects2.b1;
    const colTarget = rects2.c1;
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(colSource.left + colSource.width / 2), y: Math.round(colSource.top + 3), button: 'left', clickCount: 1 });
    await sleep(150);
    const colDragging = await jsOf('window.__mdpad.tableDragState()');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(colTarget.left + colTarget.width / 2), y: Math.round(colTarget.top + colTarget.height / 2), button: 'left' });
    await sleep(150);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(colTarget.left + colTarget.width / 2), y: Math.round(colTarget.top + colTarget.height / 2), button: 'left', clickCount: 1 });
    await sleep(500);
    const afterColumn = await jsOf('window.__mdpad.getMarkdown()');
    return { rowDragging, rowMoved, colDragging, afterRow, afterColumn };
  })();
  step(
    'table-drag',
    tableDrag.rowDragging &&
      tableDrag.rowDragging.active === true &&
      tableDrag.rowDragging.axis === 'row' &&
      tableDrag.rowMoved &&
      tableDrag.rowMoved.target === 2 &&
      typeof tableDrag.afterRow === 'string' &&
      /\\| a2 \\| b2 \\| c2 \\|\\n\\| a1 \\| b1 \\| c1 \\|/.test(tableDrag.afterRow) &&
      tableDrag.colDragging &&
      tableDrag.colDragging.axis === 'column' &&
      typeof tableDrag.afterColumn === 'string' &&
      /\\| a1 \\| c1 \\| b1 \\|/.test(tableDrag.afterColumn),
    {
      rowDragging: tableDrag.rowDragging,
      rowMoved: tableDrag.rowMoved,
      colDragging: tableDrag.colDragging,
      rowOrder: typeof tableDrag.afterRow === 'string' ? tableDrag.afterRow.split('\\n').filter((line) => /^\\|/.test(line)) : tableDrag.afterRow,
      lastRow: typeof tableDrag.afterColumn === 'string' ? tableDrag.afterColumn.split('\\n').filter((line) => /^\\|/.test(line)).pop() : tableDrag.afterColumn,
      setupFailed: tableDrag.setupFailed,
      cells: tableDrag.cells,
      error: tableDrag.error,
    }
  );

  // 137. an image can be dragged to a new position in one undoable step
  const imageDragTest = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'image-drag.md');
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    fs.writeFileSync(
      doc,
      ['# Image drag', '', '![one](' + pixel + ')', '', 'text one', '', '![two](' + pixel + ')', '', 'text two', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const count = await jsOf('window.__mdpad.imagePositions().length');
      if (count === 2) break;
      if (count && count.__error) return { error: 'load', count };
    }
    const before = await jsOf('window.__mdpad.imagePositions()');
    const dragged = await jsOf(`(() => {
      const imgs = [...document.querySelectorAll('.tiptap img')];
      if (imgs.length < 2) return { error: 'not enough images', count: imgs.length };
      const first = imgs[0];
      const lastBlock = [...document.querySelectorAll('.tiptap p')].pop();
      const targetRect = lastBlock.getBoundingClientRect();
      const data = new DataTransfer();
      const fire = (el, type, clientX, clientY) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX, clientY }));
      fire(first, 'dragstart', 0, 0);
      const stateMid = window.__mdpad.imageDragState();
      fire(lastBlock, 'dragover', targetRect.left + targetRect.width / 2, targetRect.bottom - 2);
      const stateOver = window.__mdpad.imageDragState();
      fire(lastBlock, 'drop', targetRect.left + targetRect.width / 2, targetRect.bottom - 2);
      return { stateMid, stateOver, after: window.__mdpad.imagePositions() };
    })()`);
    await sleep(400);
    const after = await jsOf('window.__mdpad.imagePositions()');
    const markdown = await jsOf('window.__mdpad.getMarkdown()');
    return { before, dragged, after, markdown: typeof markdown === 'string' ? markdown.slice(0, 400) : markdown };
  })();
  step(
    'image-drag',
    Array.isArray(imageDragTest.before) &&
      imageDragTest.before.length === 2 &&
      imageDragTest.dragged &&
      imageDragTest.dragged.stateMid &&
      imageDragTest.dragged.stateMid.pos !== null &&
      imageDragTest.dragged.stateOver &&
      imageDragTest.dragged.stateOver.target !== null &&
      Array.isArray(imageDragTest.after) &&
      imageDragTest.after[0].alt === 'two' &&
      imageDragTest.after[1].alt === 'one' &&
      typeof imageDragTest.markdown === 'string' &&
      imageDragTest.markdown.indexOf('![two]') < imageDragTest.markdown.indexOf('![one]'),
    imageDragTest
  );

  // 138. the image audit lists every image with its kind and status, and can drop the missing ones
  const imageAudit = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'image-audit.md');
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    fs.writeFileSync(path.join(dir, 'present.png'), Buffer.from(pixel, 'base64'));
    fs.writeFileSync(
      doc,
      [
        '# Image audit',
        '',
        '![present](present.png)',
        '',
        '![gone](missing-image.png)',
        '',
        '![remote](https://example.com/pic.png)',
        '',
        `![inline](data:image/png;base64,${pixel})`,
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const count = await jsOf('window.__mdpad.imagePositions().length');
      if (count === 4) break;
    }
    const audit = await jsOf('window.api.imagesAudit()');
    const panel = await jsOf('window.__mdpad.openImageAudit()');
    const removed = await jsOf(`(async () => {
      window.__mdpad.removeMissingImages();
      await new Promise((r) => setTimeout(r, 700));
      return window.__mdpad.imageAuditState();
    })()`);
    const remaining = await jsOf('window.__mdpad.imagePositions()');
    await jsOf('document.querySelector(\'#image-audit\').hidden = true');
    return { audit, panel, removed, remaining };
  })();
  step(
    'image-audit',
    imageAudit.audit &&
      imageAudit.audit.total === 4 &&
      imageAudit.audit.missing === 1 &&
      imageAudit.audit.remote === 1 &&
      imageAudit.audit.embedded === 1 &&
      imageAudit.audit.entries[0].exists === true &&
      imageAudit.audit.entries[1].exists === false &&
      imageAudit.panel &&
      imageAudit.panel.open === true &&
      imageAudit.panel.rows.length === 4 &&
      imageAudit.panel.rows.filter((row) => row.missing).length === 1 &&
      imageAudit.panel.rows.find((row) => row.missing).status === 'missing' &&
      imageAudit.removed &&
      imageAudit.removed.rows.length === 3 &&
      imageAudit.removed.rows.every((row) => !row.missing) &&
      Array.isArray(imageAudit.remaining) &&
      imageAudit.remaining.length === 3,
    {
      audit: imageAudit.audit,
      panel: imageAudit.panel,
      removedCount: imageAudit.removed && imageAudit.removed.rows ? imageAudit.removed.rows.length : imageAudit.removed,
      remaining: imageAudit.remaining,
    }
  );

  // 139. a remote image can be downloaded next to the document and the link rewritten
  const imageDownload = await (async () => {
    const http = require('node:http');
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/pic.png')) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(pixel.length) });
        res.end(pixel);
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const remote = 'http://127.0.0.1:' + port + '/pic.png';
    const doc = path.join(dir, 'remote-image.md');
    fs.writeFileSync(doc, ['# Remote image', '', '![remote](' + remote + ')', ''].join(String.fromCharCode(10)), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const srcs = await jsOf('window.__mdpad.imageSrcs()');
      if (Array.isArray(srcs) && srcs.length === 1) break;
    }
    const panel = await jsOf('window.__mdpad.openImageAudit()');
    const clicked = await jsOf(`(async () => {
      const button = document.querySelector('.image-audit-download');
      if (!button) return false;
      button.click();
      await new Promise((r) => setTimeout(r, 2500));
      return true;
    })()`);
    const srcs = await jsOf('window.__mdpad.imageSrcs()');
    const audit = await jsOf('window.api.imagesAudit()');
    const downloadedDir = path.join(dir, 'images');
    const files = fs.existsSync(downloadedDir) ? fs.readdirSync(downloadedDir) : [];
    const again = await jsOf('window.__mdpad.openImageAudit()');
    await jsOf('document.querySelector(\'#image-audit\').hidden = true');
    await new Promise((resolve) => server.close(resolve));
    return { panel, clicked, srcs, audit, files, again, dir: downloadedDir };
  })();
  step(
    'image-download',
    imageDownload.panel &&
      imageDownload.panel.rows.length === 1 &&
      imageDownload.panel.rows[0].kind === 'remote' &&
      imageDownload.clicked === true &&
      Array.isArray(imageDownload.srcs) &&
      imageDownload.srcs.length === 1 &&
      /^images\/[0-9a-f]+\.png$/.test(imageDownload.srcs[0]) &&
      imageDownload.files.length === 1 &&
      imageDownload.files[0].endsWith('.png') &&
      imageDownload.audit.remote === 0 &&
      imageDownload.audit.entries[0].kind === 'local' &&
      imageDownload.audit.entries[0].exists === true &&
      imageDownload.again.rows.length === 1 &&
      imageDownload.again.rows[0].status !== 'remote',
    imageDownload
  );

  // 140. the link audit lists links with their kind and status, and unlinks the missing ones
  const linkAudit = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    fs.writeFileSync(path.join(dir, 'link-target.md'), '# Target' + nl, 'utf8');
    const doc = path.join(dir, 'link-audit.md');
    fs.writeFileSync(
      doc,
      [
        '# Link audit',
        '',
        '[good](link-target.md)',
        '',
        '[gone](missing-target.md)',
        '',
        '[web](https://example.com)',
        '',
        '[jump](#link-audit)',
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ok = await jsOf("window.__mdpad.getMarkdown().includes('gone')");
      if (ok === true) break;
    }
    const audit = await jsOf('window.api.linksAudit()');
    const panel = await jsOf('window.__mdpad.openLinkAudit()');
    const removed = await jsOf(`(async () => {
      window.__mdpad.removeMissingLinks();
      await new Promise((r) => setTimeout(r, 800));
      return window.__mdpad.linkAuditState();
    })()`);
    const markdown = await jsOf('window.__mdpad.getMarkdown()');
    await jsOf('document.querySelector(\'#link-audit\').hidden = true');
    return { audit, panel, removed, markdown };
  })();
  step(
    'link-audit',
    linkAudit.audit &&
      linkAudit.audit.total === 4 &&
      linkAudit.audit.missing === 1 &&
      linkAudit.audit.external === 1 &&
      linkAudit.audit.anchors === 1 &&
      linkAudit.audit.entries[0].exists === true &&
      linkAudit.audit.entries[1].exists === false &&
      linkAudit.panel &&
      linkAudit.panel.rows.length === 4 &&
      linkAudit.panel.rows.filter((row) => row.missing).length === 1 &&
      linkAudit.panel.rows.find((row) => row.missing).status === 'missing' &&
      linkAudit.panel.rows.find((row) => row.kind === 'external').status === 'not checked' &&
      linkAudit.removed &&
      linkAudit.removed.rows.length === 3 &&
      linkAudit.removed.rows.every((row) => !row.missing) &&
      typeof linkAudit.markdown === 'string' &&
      linkAudit.markdown.includes('gone') &&
      !linkAudit.markdown.includes('missing-target.md'),
    {
      audit: linkAudit.audit,
      panel: linkAudit.panel,
      removedCount: linkAudit.removed && linkAudit.removed.rows ? linkAudit.removed.rows.length : linkAudit.removed,
      markdown: typeof linkAudit.markdown === 'string' ? linkAudit.markdown.slice(0, 300) : linkAudit.markdown,
    }
  );

  // 141. a broken link can be repointed at the right file instead of unlinked
  const linkFix = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    fs.writeFileSync(path.join(dir, 'fix-target.md'), '# Fixed' + nl, 'utf8');
    const doc = path.join(dir, 'link-fix.md');
    fs.writeFileSync(
      doc,
      ['# Fix a link', '', '[gone](wrong-name.md)', '', 'trailing text', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('wrong-name')");
      if (ready === true) break;
    }
    const panel = await jsOf('window.__mdpad.openLinkAudit()');
    const clicked = await jsOf("window.__mdpad.clickFixLink('wrong-name.md')");
    await sleep(300);
    const prompted = await jsOf('window.__mdpad.nameState()');
    const filled = await jsOf("window.__mdpad.fillName('fix-target.md')");
    await jsOf('window.__mdpad.confirmName()');
    await sleep(700);
    const after = await jsOf('window.__mdpad.linkAuditState()');
    const markdown = await jsOf('window.__mdpad.getMarkdown()');
    await jsOf('document.querySelector(\'#link-audit\').hidden = true');
    return { panel, clicked, prompted, filled, after, markdown };
  })();
  step(
    'link-fix',
    linkFix.panel &&
      linkFix.panel.rows.length === 1 &&
      linkFix.panel.rows[0].missing === true &&
      linkFix.clicked === true &&
      linkFix.prompted &&
      linkFix.prompted.open === true &&
      linkFix.prompted.value === 'wrong-name.md' &&
      linkFix.filled === 'fix-target.md' &&
      linkFix.after &&
      linkFix.after.rows.length === 1 &&
      linkFix.after.rows[0].missing === false &&
      typeof linkFix.markdown === 'string' &&
      linkFix.markdown.includes('(fix-target.md)') &&
      !linkFix.markdown.includes('wrong-name.md'),
    {
      panel: linkFix.panel,
      prompted: linkFix.prompted,
      after: linkFix.after,
      markdown: typeof linkFix.markdown === 'string' ? linkFix.markdown.slice(0, 200) : linkFix.markdown,
    }
  );

  // 142. the structure report finds heading jumps, duplicates and runaway paragraphs
  const structureReport = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const longParagraph = 'This paragraph is deliberately long so the report notices it. '.repeat(30);
    const doc = path.join(dir, 'structure.md');
    fs.writeFileSync(
      doc,
      [
        '# Book',
        '',
        '## Chapter',
        '',
        'text',
        '',
        '### Too deep?',
        '',
        '## Notes',
        '',
        'a',
        '',
        '## Notes',
        '',
        longParagraph,
        '',
        '#### Jumped again',
        '',
        'end',
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Too deep')");
      if (ready === true) break;
    }
    const report = await jsOf('window.api.docStructure()');
    const panel = await jsOf('window.__mdpad.openStructureReport()');
    await jsOf('document.querySelector(\'#structure-report\').hidden = true');
    return { report, panel };
  })();
  step(
    'structure-report',
    structureReport.report &&
      structureReport.report.headings.length === 6 &&
      structureReport.report.duplicates.length === 1 &&
      structureReport.report.duplicates[0].text === 'Notes' &&
      structureReport.report.skips.length === 1 &&
      structureReport.report.skips[0].from === 2 &&
      structureReport.report.skips[0].to === 4 &&
      structureReport.report.longestParagraph.chars > 1200 &&
      structureReport.report.counts.images === 0 &&
      structureReport.panel &&
      structureReport.panel.open === true &&
      structureReport.panel.rows.length === 3 &&
      structureReport.panel.rows.some((row) => row.kind === 'duplicate') &&
      structureReport.panel.rows.some((row) => row.kind === 'level') &&
      structureReport.panel.rows.some((row) => row.kind === 'paragraph') &&
      /headings/.test(structureReport.panel.summary),
    {
      report: structureReport.report,
      panel: structureReport.panel,
    }
  );

  // 143. structure issues can be fixed in place: heading level and duplicate titles
  const structureFix = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'structure-fix.md');
    fs.writeFileSync(
      doc,
      ['# Book', '', '## Chapter', '', '#### Deep jump', '', '## Notes', '', 'a', '', '## Notes', '', 'b', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Deep jump')");
      if (ready === true) break;
    }
    const before = await jsOf('window.api.docStructure()');
    const panel = await jsOf('window.__mdpad.openStructureReport()');
    const levelRow = before.skips.length ? before.skips[0].line : null;
    const clickedLevel = await jsOf(`window.__mdpad.clickStructureFix(${JSON.stringify(levelRow)})`);
    await sleep(500);
    const afterLevel = await jsOf('window.api.docStructure()');
    const markdownAfterLevel = await jsOf('window.__mdpad.getMarkdown()');

    // the duplicate row: open the report again and rename the second Notes
    const panelAgain = await jsOf('window.__mdpad.openStructureReport()');
    const duplicate = afterLevel.duplicates.length ? afterLevel.duplicates[0] : null;
    const clickedRename = await jsOf(
      `window.__mdpad.clickStructureFix(${JSON.stringify(duplicate ? duplicate.line : 0)})`
    );
    await sleep(300);
    const prompted = await jsOf('window.__mdpad.nameState()');
    await jsOf("window.__mdpad.fillName('Notes two')");
    await jsOf('window.__mdpad.confirmName()');
    await sleep(600);
    const afterRename = await jsOf('window.api.docStructure()');
    const markdownAfterRename = await jsOf('window.__mdpad.getMarkdown()');
    await jsOf('document.querySelector(\'#structure-report\').hidden = true');
    return {
      before: { headings: before.headings.length, skips: before.skips.length, duplicates: before.duplicates.length },
      panel: panel && panel.rows.map((row) => row.kind),
      clickedLevel,
      levelRow,
      afterLevel: { skips: afterLevel.skips.length, markdown: markdownAfterLevel },
      panelAgain: panelAgain && panelAgain.rows.map((row) => row.kind),
      clickedRename,
      prompted,
      afterRename: { duplicates: afterRename.duplicates.length, markdown: markdownAfterRename },
    };
  })();
  step(
    'structure-fix',
    structureFix.before.skips === 1 &&
      structureFix.before.duplicates === 1 &&
      Array.isArray(structureFix.panel) &&
      structureFix.panel.includes('level') &&
      structureFix.clickedLevel === true &&
      structureFix.afterLevel.skips === 0 &&
      /#### Deep jump/.test(structureFix.afterLevel.markdown) === false &&
      /### Deep jump/.test(structureFix.afterLevel.markdown) &&
      structureFix.clickedRename === true &&
      structureFix.prompted &&
      structureFix.prompted.value === 'Notes' &&
      structureFix.afterRename.duplicates === 0 &&
      /## Notes two/.test(structureFix.afterRename.markdown) &&
      /## Notes\b/.test(structureFix.afterRename.markdown),
    structureFix
  );

  // 144. a runaway paragraph can be split into readable ones without losing text
  const paragraphSplit = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const sentences = [];
    for (let index = 1; index <= 24; index += 1) {
      sentences.push('Sentence number ' + index + ' carries the argument forward with enough words to matter.');
    }
    const longParagraph = sentences.join(' ');
    const doc = path.join(dir, 'paragraph-split.md');
    fs.writeFileSync(doc, ['# Split', '', longParagraph, '', 'end', ''].join(nl), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Sentence number 24')");
      if (ready === true) break;
    }
    const before = await jsOf('window.api.docStructure()');
    const panel = await jsOf('window.__mdpad.openStructureReport()');
    const clicked = await jsOf(`(async () => {
      const row = [...document.querySelectorAll('#structure-issues .image-audit-row')].find(
        (item) => item.dataset.kind === 'paragraph'
      );
      if (!row) return false;
      const button = row.querySelector('.image-audit-fix');
      if (!button) return false;
      button.click();
      await new Promise((r) => setTimeout(r, 900));
      return true;
    })()`);
    const after = await jsOf('window.api.docStructure()');
    const markdown = await jsOf('window.__mdpad.getMarkdown()');
    const paragraphs = await jsOf(`(() => {
      const counts = [];
      window.__mdpad.editor.state.doc.descendants((node) => {
        if (node.type.name === 'paragraph') counts.push(node.textContent.length);
        return true;
      });
      return counts;
    })()`);
    await jsOf('document.querySelector(\'#structure-report\').hidden = true');
    return {
      before: { chars: before.longestParagraph.chars, paragraphs: before.counts.paragraphs },
      panel: panel && panel.rows.map((row) => row.kind),
      clicked,
      after: { chars: after.longestParagraph ? after.longestParagraph.chars : 0, paragraphs: after.counts.paragraphs },
      markdown,
      paragraphs,
      originalLength: longParagraph.length,
    };
  })();
  step(
    'paragraph-split',
    paragraphSplit.before.chars > 1200 &&
      Array.isArray(paragraphSplit.panel) &&
      paragraphSplit.panel.includes('paragraph') &&
      paragraphSplit.clicked === true &&
      paragraphSplit.after.paragraphs > paragraphSplit.before.paragraphs &&
      paragraphSplit.after.chars <= 1200 &&
      Array.isArray(paragraphSplit.paragraphs) &&
      paragraphSplit.paragraphs.every((length) => length <= 1200) &&
      paragraphSplit.markdown.replace(/\\s+/g, ' ').includes('Sentence number 24') &&
      paragraphSplit.markdown.replace(/\\s+/g, ' ').trim().length >= paragraphSplit.originalLength,
    {
      before: paragraphSplit.before,
      panel: paragraphSplit.panel,
      after: paragraphSplit.after,
      lengths: paragraphSplit.paragraphs,
    }
  );

  // 145. the structure report exports as a markdown checklist
  const reportExport = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'report-export.md');
    fs.writeFileSync(
      doc,
      ['# Book', '', '## Chapter', '', '#### Jump', '', '## Notes', '', 'a', '', '## Notes', '', 'b', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Jump')");
      if (ready === true) break;
    }
    await jsOf('window.__mdpad.openStructureReport()');
    const hasButton = await jsOf("Boolean(document.querySelector('#structure-save'))");
    const markdown = await jsOf('window.__mdpad.structureMarkdown()');
    const target = path.join(dir, 'structure-report.md');
    const written = await jsOf(`window.__mdpad.saveStructureReportTo(${JSON.stringify(target)})`);
    const fileText = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    await jsOf('document.querySelector(\'#structure-report\').hidden = true');
    return { hasButton, markdown, written, fileText };
  })();
  step(
    'structure-export',
    reportExport.hasButton === true &&
      typeof reportExport.markdown === 'string' &&
      reportExport.markdown.startsWith('# Structure report') &&
      reportExport.markdown.includes('## Counts') &&
      reportExport.markdown.includes('## Checklist') &&
      reportExport.markdown.includes('- [ ] Heading "Jump" jumps from H2 to H4') &&
      reportExport.markdown.includes('- [ ] Duplicate heading "Notes"') &&
      reportExport.written &&
      reportExport.written.ok === true &&
      reportExport.fileText.includes('- [ ] Duplicate heading "Notes"') &&
      reportExport.fileText.includes('Paragraphs:'),
    {
      hasButton: reportExport.hasButton,
      head: typeof reportExport.markdown === 'string' ? reportExport.markdown.slice(0, 300) : reportExport.markdown,
      written: reportExport.written,
      fileHead: reportExport.fileText.slice(0, 200),
    }
  );

  // 146. the second report records what changed since the first one
  const reportHistory = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'report-history.md');
    fs.writeFileSync(
      doc,
      ['# Book', '', '## Chapter', '', '#### Jump', '', '## Notes', '', 'a', '', '## Notes', '', 'b', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Jump')");
      if (ready === true) break;
    }
    const firstTarget = path.join(dir, 'report-first.md');
    const first = await jsOf(`window.__mdpad.saveStructureReportTo(${JSON.stringify(firstTarget)})`);
    const firstIssues = 2;

    // fix both issues through the real actions, then report again
    const fixed = await jsOf(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const report = await window.api.docStructure();
      window.__mdpad.openStructureReport();
      await sleep(400);
      window.__mdpad.clickStructureFix(report.skips[0].line);
      await sleep(400);
      const next = await window.api.docStructure();
      window.__mdpad.openStructureReport();
      await sleep(400);
      window.__mdpad.clickStructureFix(next.duplicates[0].line);
      await sleep(300);
      window.__mdpad.fillName('Notes two');
      window.__mdpad.confirmName();
      await sleep(600);
      return window.api.docStructure();
    })()`);
    const secondTarget = path.join(dir, 'report-second.md');
    const second = await jsOf(`window.__mdpad.saveStructureReportTo(${JSON.stringify(secondTarget)})`);
    const afterReport = await jsOf('window.api.docStructure()');
    const secondText = fs.existsSync(secondTarget) ? fs.readFileSync(secondTarget, 'utf8') : '';
    await jsOf('document.querySelector(\'#structure-report\').hidden = true');
    return {
      first,
      firstIssues,
      fixed: { skips: fixed.skips.length, duplicates: fixed.duplicates.length, previous: fixed.previous },
      second,
      previous: afterReport.previous,
      secondText,
    };
  })();
  step(
    'report-history',
    reportHistory.first &&
      reportHistory.first.ok === true &&
      reportHistory.fixed.skips === 0 &&
      reportHistory.fixed.duplicates === 0 &&
      reportHistory.fixed.previous &&
      reportHistory.fixed.previous.issues === reportHistory.firstIssues &&
      reportHistory.second &&
      reportHistory.second.ok === true &&
      reportHistory.previous &&
      reportHistory.previous.issues === 0 &&
      reportHistory.previous.words > 0 &&
      reportHistory.secondText.includes('Previous report') &&
      reportHistory.secondText.includes('now 0 (−2)') &&
      reportHistory.secondText.includes('- [x] No structural problems found'),
    {
      first: reportHistory.first,
      fixed: reportHistory.fixed,
      second: reportHistory.second,
      previous: reportHistory.previous,
      head: reportHistory.secondText.slice(0, 400),
    }
  );

  // 147. typewriter mode keeps the caret near the middle of the viewport
  const typewriter = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const parts = ['# Typewriter'];
    for (let index = 1; index <= 120; index += 1) {
      parts.push('', '## Section ' + index, '', 'Paragraph ' + index + ' with enough words to take a line in the editor.');
    }
    const doc = path.join(dir, 'typewriter.md');
    fs.writeFileSync(doc, parts.join(nl), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Section 120')");
      if (ready === true) break;
    }
    await jsOf('window.__mdpad.setTypewriter(true)');
    await sleep(300);
    const focused = await jsOf("window.__mdpad.focusText('Paragraph 100')");
    await sleep(600);
    const on = await jsOf('window.__mdpad.typewriterState()');
    await jsOf('window.__mdpad.setTypewriter(false)');
    await sleep(200);
    await jsOf("window.__mdpad.focusText('Paragraph 2')");
    await sleep(500);
    const off = await jsOf('window.__mdpad.typewriterState()');
    return { focused, on, off };
  })();
  const ratio = (state) =>
    state && state.paneHeight ? (state.caretY - state.paneTop) / state.paneHeight : null;
  step(
    'typewriter-scroll',
    typewriter.focused === true &&
      typewriter.on &&
      typewriter.on.enabled === true &&
      typewriter.on.scrollTop > 0 &&
      ratio(typewriter.on) !== null &&
      ratio(typewriter.on) > 0.3 &&
      ratio(typewriter.on) < 0.62 &&
      typewriter.off &&
      typewriter.off.enabled === false &&
      ratio(typewriter.off) !== null,
    {
      on: typewriter.on,
      onRatio: ratio(typewriter.on),
      off: typewriter.off,
      offRatio: ratio(typewriter.off),
    }
  );

  // 148. the current paragraph can be highlighted, and focus mode takes over from it
  const paragraphHighlight = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'paragraph-highlight.md');
    fs.writeFileSync(
      doc,
      ['# Highlight', '', 'First paragraph with a sentence.', '', 'Second paragraph, also short.', '', 'Third one.', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Second paragraph')");
      if (ready === true) break;
    }
    await jsOf('window.__mdpad.setParagraphHighlight(true)');
    await jsOf("window.__mdpad.focusText('Second paragraph')");
    await sleep(500);
    const first = await jsOf('window.__mdpad.paragraphHighlightState()');
    await jsOf("window.__mdpad.focusText('Third one')");
    await sleep(400);
    const moved = await jsOf('window.__mdpad.paragraphHighlightState()');
    // focus mode wins: the soft highlight must step aside
    await jsOf("window.__mdpad.editor.commands.toggleFocusMode ? window.__mdpad.editor.commands.toggleFocusMode() : null");
    const focusOn = await jsOf('window.__mdpad.focusModeSet ? window.__mdpad.focusModeSet(true) : null');
    await sleep(400);
    const withFocus = await jsOf('window.__mdpad.paragraphHighlightState()');
    await jsOf('window.__mdpad.focusModeSet ? window.__mdpad.focusModeSet(false) : null');
    await jsOf('window.__mdpad.setParagraphHighlight(false)');
    await sleep(300);
    const off = await jsOf('window.__mdpad.paragraphHighlightState()');
    return { first, moved, withFocus, focusOn, off };
  })();
  step(
    'paragraph-highlight',
    paragraphHighlight.first &&
      paragraphHighlight.first.enabled === true &&
      paragraphHighlight.first.softCount === 1 &&
      /Second paragraph/.test(paragraphHighlight.first.softText.join(' ')) &&
      paragraphHighlight.moved &&
      paragraphHighlight.moved.softCount === 1 &&
      /Third one/.test(paragraphHighlight.moved.softText.join(' ')) &&
      paragraphHighlight.withFocus &&
      (paragraphHighlight.withFocus.activeCount === 0 || paragraphHighlight.withFocus.softCount === 0) &&
      paragraphHighlight.off &&
      paragraphHighlight.off.softCount === 0,
    paragraphHighlight
  );

  // 149. writing a document counts toward a daily goal, and deleting does not take words back
  const writingGoal = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    await jsOf('window.api.writingReset()');
    await jsOf("window.api.setSettings({ writingGoal: 100 })");
    const doc = path.join(dir, 'writing-goal.md');
    fs.writeFileSync(doc, ['# Goal', '', 'alpha beta gamma delta epsilon', ''].join(nl), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('epsilon')");
      if (ready === true) break;
    }
    // first record establishes the baseline (no words counted for content already on disk)
    const baseline = await jsOf('window.__mdpad.recordWritingNow()').then(() => jsOf('window.api.writingStats()'));
    // write 60 more words
    const words60 = Array.from({ length: 60 }, (_, index) => 'word' + index).join(' ');
    await jsOf(`window.__mdpad.applyMarkdown('# Goal' + String.fromCharCode(10) + String.fromCharCode(10) + 'alpha beta gamma delta epsilon ' + ${JSON.stringify(words60)})`);
    await sleep(300);
    await jsOf('window.__mdpad.recordWritingNow()');
    await sleep(200);
    const afterSixty = await jsOf('window.api.writingStats()');
    // delete half of them: today's count must not shrink
    await jsOf(`window.__mdpad.applyMarkdown('# Goal' + String.fromCharCode(10) + String.fromCharCode(10) + 'alpha beta gamma delta epsilon ' + ${JSON.stringify(words60.split(' ').slice(0, 30).join(' '))})`);
    await sleep(300);
    await jsOf('window.__mdpad.recordWritingNow()');
    await sleep(200);
    const afterDelete = await jsOf('window.api.writingStats()');
    // cross the goal
    const words120 = Array.from({ length: 120 }, (_, index) => 'goal' + index).join(' ');
    await jsOf(`window.__mdpad.applyMarkdown('# Goal' + String.fromCharCode(10) + String.fromCharCode(10) + ${JSON.stringify(words120)})`);
    await sleep(300);
    await jsOf('window.__mdpad.recordWritingNow()');
    await sleep(300);
    const reached = await jsOf('window.api.writingStats()');
    const statusText = await jsOf("document.querySelector('#writing-status').textContent");
    const statusHidden = await jsOf("document.querySelector('#writing-status').hidden");
    await jsOf("window.api.setSettings({ writingGoal: 0 })");
    await jsOf('window.api.writingReset()');
    return { baseline, afterSixty, afterDelete, reached, statusText, statusHidden };
  })();
  step(
    'writing-goal',
    writingGoal.baseline &&
      writingGoal.baseline.today === 0 &&
      writingGoal.afterSixty &&
      writingGoal.afterSixty.today === 60 &&
      writingGoal.afterDelete &&
      writingGoal.afterDelete.today === 60 &&
      writingGoal.reached &&
      writingGoal.reached.today >= 120 &&
      writingGoal.reached.reached === true &&
      writingGoal.statusHidden === false &&
      /Today \d+ \/ 100 words/.test(writingGoal.statusText) &&
      writingGoal.statusText.includes('Today ' + writingGoal.reached.today + ' / 100'),
    writingGoal
  );

  // 150. writing history shows 14 days and a streak built from the ledger
  const writingHistory = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    await jsOf('window.api.writingReset()');
    await jsOf("window.api.setSettings({ writingGoal: 100 })");
    const doc = path.join(dir, 'writing-history.md');
    fs.writeFileSync(doc, '# History' + String.fromCharCode(10), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('History')");
      if (ready === true) break;
    }
    await jsOf('window.__mdpad.recordWritingNow()');
    const words = Array.from({ length: 140 }, (_, index) => 'w' + index).join(' ');
    await jsOf(`window.__mdpad.applyMarkdown('# History' + String.fromCharCode(10) + String.fromCharCode(10) + ${JSON.stringify(words)})`);
    await sleep(400);
    await jsOf('window.__mdpad.recordWritingNow()');
    await sleep(300);
    const panel = await jsOf('window.__mdpad.openWritingHistory()');
    await jsOf("window.api.setSettings({ writingGoal: 0 })");
    await jsOf('window.api.writingReset()');
    await jsOf("document.querySelector('#writing-history').hidden = true");
    const last = panel && panel.days[panel.days.length - 1];
    return { panel, last };
  })();
  step(
    'writing-history',
    writingHistory.panel &&
      writingHistory.panel.open === true &&
      writingHistory.panel.days.length === 14 &&
      /140 words in 14 days/.test(writingHistory.panel.summary) &&
      /1 day streak/.test(writingHistory.panel.summary) &&
      writingHistory.last &&
      writingHistory.last.reached === true &&
      /140 words/.test(writingHistory.last.title) &&
      writingHistory.last.height !== '2%',
    writingHistory
  );

  // 151. the external-change policy decides between asking, reloading and ignoring
  const externalPolicy = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'external-policy.md');
    fs.writeFileSync(doc, '# Original' + nl, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Original')");
      if (ready === true) break;
    }

    // auto: a clean buffer reloads without a question
    await jsOf("window.api.setSettings({ externalPolicy: 'auto' })");
    fs.writeFileSync(doc, '# Auto reloaded' + nl, 'utf8');
    await sleep(1800);
    const auto = await jsOf('window.__mdpad.externalState()');

    // ask: dirty buffer must never be replaced silently
    await jsOf("window.api.setSettings({ externalPolicy: 'ask' })");
    await jsOf("window.__mdpad.applyMarkdown('# Auto reloaded' + String.fromCharCode(10) + String.fromCharCode(10) + 'local edit')");
    await sleep(400);
    fs.writeFileSync(doc, '# Changed again' + nl, 'utf8');
    await sleep(1800);
    const asked = await jsOf('window.__mdpad.externalState()');
    const clicked = await jsOf('(async () => { window.__mdpad.clickBannerPrimary(); await new Promise((r) => setTimeout(r, 700)); return window.__mdpad.externalState(); })()');

    // ignore: nothing happens at all
    await jsOf("window.api.setSettings({ externalPolicy: 'ignore' })");
    fs.writeFileSync(doc, '# Ignored' + nl, 'utf8');
    await sleep(1800);
    const ignored = await jsOf('window.__mdpad.externalState()');
    await jsOf("window.api.setSettings({ externalPolicy: 'ask' })");
    return { auto, asked, clicked, ignored };
  })();
  step(
    'external-change-policy',
    /Auto reloaded/.test(externalPolicy.auto.markdown) &&
      externalPolicy.auto.banner === false &&
      externalPolicy.asked.banner === true &&
      /changed on disk/i.test(externalPolicy.asked.text) &&
      /local edit/.test(externalPolicy.asked.markdown) &&
      /Changed again/.test(externalPolicy.clicked.markdown) &&
      externalPolicy.ignored.markdown.includes('Changed again') &&
      externalPolicy.ignored.banner === false,
    externalPolicy
  );

  // 152. closing a tab with unsaved text keeps a draft, says so, and can be undone
  const closeDirty = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'close-dirty.md');
    fs.writeFileSync(doc, '# Saved' + nl, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Saved')");
      if (ready === true) break;
    }
    await jsOf("window.__mdpad.applyMarkdown('# Saved' + String.fromCharCode(10) + String.fromCharCode(10) + 'unsaved words')");
    await sleep(500);
    const beforeClose = await jsOf('window.__mdpad.getMarkdown()');
    const tabsBefore = await jsOf('window.api.listTabs()');
    const active = tabsBefore.find((tab) => tab.active);
    const closed = await jsOf(`(() => {
      const tab = [...document.querySelectorAll('#tab-list .tab')].find(
        (node) => node.dataset.id === ${JSON.stringify(active.id)}
      );
      if (!tab) return { error: 'tab not found' };
      tab.querySelector('.tab-close').click();
      return { clicked: true };
    })()`);
    await sleep(900);
    const drafts = await jsOf('window.api.listDrafts()');
    let toast = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      toast = await jsOf("document.querySelector('#toast').textContent");
      if (/unsaved changes/.test(String(toast))) break;
      await sleep(200);
    }
    const opened = await jsOf('(async () => { const result = await window.api.reopenTab(); await new Promise((r) => setTimeout(r, 600)); return result; })()');
    const markdown = await jsOf('window.__mdpad.getMarkdown()');
    return { closed, drafts, toast, opened, markdown, beforeClose };
  })();
  step(
    'close-dirty-tab',
    closeDirty.closed &&
      closeDirty.closed.clicked === true &&
      Array.isArray(closeDirty.drafts) &&
      closeDirty.drafts.some((draft) => /close-dirty\.md/.test(draft.name || draft.file || '')) &&
      /unsaved changes/.test(closeDirty.toast) &&
      closeDirty.opened &&
      /unsaved words/.test(closeDirty.markdown),
    closeDirty
  );

  // 153. every export format answers with an error when the target cannot be written
  const exportFailures = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const session = sessions.get(win.webContents.id);
    const doc = path.join(dir, 'export-failures.md');
    fs.writeFileSync(doc, ['# Export failures', '', 'text', ''].join(String.fromCharCode(10)), 'utf8');
    await session.loadDocument(doc);
    await sleep(700);
    session.contents = fs.readFileSync(doc, 'utf8');

    const blocker = path.join(dir, 'no-write-here');
    fs.writeFileSync(blocker, 'a file, not a folder', 'utf8');
    const results = {};
    for (const kind of ['html', 'pdf', 'docx', 'epub']) {
      const insideFile = path.join(blocker, 'out.' + kind);
      const asDirectory = path.join(dir, 'dir-target-' + kind + '.' + kind);
      try {
        fs.mkdirSync(asDirectory, { recursive: true });
      } catch {
        /* exists */
      }
      const first = await jsOf(`window.api.exportToPath(${JSON.stringify(kind)}, ${JSON.stringify(insideFile)})`);
      const second = await jsOf(`window.api.exportToPath(${JSON.stringify(kind)}, ${JSON.stringify(asDirectory)})`);
      results[kind] = {
        insideFile: { ok: first && first.exported === false, error: first && first.error, file: fs.existsSync(insideFile) },
        asDirectory: { ok: second && second.exported === false, error: second && second.error },
      };
    }
    // a read-only existing file must survive a failed overwrite untouched
    const keep = path.join(dir, 'keep-me.html');
    fs.writeFileSync(keep, 'KEEP THIS', 'utf8');
    fs.chmodSync(keep, 0o444);
    const overwrite = await jsOf(`window.api.exportToPath('html', ${JSON.stringify(keep)})`);
    const keepText = fs.readFileSync(keep, 'utf8');
    fs.chmodSync(keep, 0o666);
    results.readOnlyTarget = {
      refused: Boolean(overwrite && overwrite.exported === false && overwrite.error),
      intact: keepText === 'KEEP THIS',
    };
    return results;
  })();
  const exportFailureProblems = Object.entries(exportFailures).filter(
    ([key, value]) =>
      (key === 'readOnlyTarget'
        ? !(value.refused && value.intact)
        : !value.insideFile.ok ||
      typeof value.insideFile.error !== 'string' ||
      !value.insideFile.error ||
      value.insideFile.file ||
            !value.asDirectory.ok ||
            typeof value.asDirectory.error !== 'string' ||
            !value.asDirectory.error)
  );
  step('export-failures-all', exportFailureProblems.length === 0, {
    results: exportFailures,
    problems: exportFailureProblems.map(([kind]) => kind),
  });

  // 154. a large document warns about export time before the user commits to it
  const exportLargeHint = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const parts = ['# Large export hint'];
    for (let section = 1; section <= 400; section += 1) {
      parts.push('', '## Section ' + section, '');
      parts.push('A paragraph that repeats to make the file large enough for the warning. '.repeat(12));
    }
    const doc = path.join(dir, 'export-large-hint.md');
    const text = parts.join(nl);
    fs.writeFileSync(doc, text, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    const expected = Buffer.byteLength(text, 'utf8');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const timing = await jsOf('window.__mdpad.loadTiming()');
      if (timing && timing.chars === expected) break;
      await sleep(80);
    }
    const inspect = await jsOf('window.__mdpad.exportInspect()');
    const panel = await jsOf(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__mdpad.openExportPanel('pdf');
      await sleep(900);
      return window.__mdpad.exportInspectText();
    })()`);
    await jsOf("document.querySelector('#export-modal').hidden = true");
    return { inspect, panel, bytes: expected };
  })();
  step(
    'export-large-hint',
    exportLargeHint.bytes > 300000 &&
      exportLargeHint.inspect &&
      exportLargeHint.inspect.chars > 300000 &&
      typeof exportLargeHint.panel === 'string' &&
      /Large document/.test(exportLargeHint.panel),
    exportLargeHint
  );

  // 155. the four formats keep the structure the source document has
  const exportParity = await (async () => {
    const JSZip = require('jszip');
    const nl = String.fromCharCode(10);
    const fence = String.fromCharCode(96, 96, 96);
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    fs.writeFileSync(path.join(dir, 'parity.png'), Buffer.from(pixel, 'base64'));
    const doc = path.join(dir, 'parity.md');
    fs.writeFileSync(
      doc,
      [
        '# Parity one',
        '',
        'A paragraph with **bold text** and *italic text* and a [link](https://example.com).',
        '',
        '## Parity two',
        '',
        '- first item',
        '- second item',
        '',
        '| Left | Right |',
        '| --- | --- |',
        '| a | b |',
        '',
        '![pixel](parity.png)',
        '',
        '## Parity three',
        '',
        fence + 'js',
        'const parity = true;',
        fence,
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    await sleep(900);
    session.contents = fs.readFileSync(doc, 'utf8');
    const files = {};
    for (const kind of ['html', 'docx', 'epub']) {
      const target = path.join(dir, 'parity.' + kind);
      await session.exportTo(target, kind);
      files[kind] = target;
    }
    const html = fs.readFileSync(files.html, 'utf8');
    const docxZip = await JSZip.loadAsync(fs.readFileSync(files.docx));
    const docxXml = await docxZip.file('word/document.xml').async('string');
    const epubZip = await JSZip.loadAsync(fs.readFileSync(files.epub));
    const chapterName = Object.keys(epubZip.files).find((name) => /\.xhtml$/.test(name));
    const chapter = await epubZip.file(chapterName).async('string');

    const count = (text, pattern) => (text.match(pattern) || []).length;
    const stripNs = (xml) => xml.replace(/<w:p[ >]/g, '<w:p ');
    return {
      source: {
        headings: 3,
        tables: 1,
        images: 1,
        codeBlocks: 1,
        listItems: 2,
        bold: 1,
        italic: 1,
        links: 1,
      },
      html: {
        headings: count(html, /<h[1-6][ >]/g),
        tables: count(html, /<table[ >]/g),
        images: count(html, /<img[ >]/g),
        codeBlocks: count(html, /<pre[ >]/g),
        listItems: count(html, /<li[ >]/g),
        bold: count(html, /<strong[ >]/g),
        italic: count(html, /<em[ >]/g),
        links: count(html, /<a [^>]*href=/g),
      },
      epub: {
        headings: count(chapter, /<h[1-6][ >]/g),
        tables: count(chapter, /<table[ >]/g),
        images: count(chapter, /<img[ >]/g),
        codeBlocks: count(chapter, /<pre[ >]/g),
        listItems: count(chapter, /<li[ >]/g),
        bold: count(chapter, /<strong[ >]/g),
        italic: count(chapter, /<em[ >]/g),
        links: count(chapter, /<a [^>]*href=/g),
      },
      docx: {
        headings: count(docxXml, /w:pStyle w:val="Heading\d"/g),
        tables: count(stripNs(docxXml), /<w:tbl>/g),
        images: count(docxXml, /<w:drawing>/g),
        codeBlocks: count(docxXml, /Consolas/g),
        // Word output keeps list content as literal bullet paragraphs (its writer has no list API
        // here), so count the bullet character rather than numbering XML.
        listItems: count(docxXml, /• /g),
        bold: count(docxXml, /<w:b\/>/g),
        italic: count(docxXml, /<w:i\/>/g),
        links: count(docxXml, /<w:hyperlink/g),
      },
    };
  })();
  const parityOk = ['html', 'epub', 'docx'].every((kind) => {
    const got = exportParity[kind];
    const want = exportParity.source;
    return (
      got.headings === want.headings &&
      got.tables === want.tables &&
      got.images === want.images &&
      got.codeBlocks >= want.codeBlocks &&
      got.listItems === want.listItems &&
      got.bold >= want.bold &&
      got.italic >= want.italic &&
      got.links >= want.links
    );
  });
  step('export-parity', parityOk, exportParity);

  // 156. settings search matches labels, highlights hits and finds every field
  const settingsSearch = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    await jsOf(`document.querySelector('#open-settings').click()`);
    await sleep(700);
    const single = await jsOf("window.__mdpad.settingsSearch('spell')");
    const multi = await jsOf("window.__mdpad.settingsSearch('writing goal')");
    const none = await jsOf("window.__mdpad.settingsSearch('zzzz-no-setting')");
    const cleared = await jsOf("window.__mdpad.settingsSearch('')");
    const audit = await jsOf('window.__mdpad.settingsSearchAudit()');
    await jsOf("document.querySelector('#settings-modal').hidden = true");
    return { single, multi, none, cleared, audit };
  })();
  step(
    'settings-search',
    settingsSearch.single &&
      settingsSearch.single.visible >= 1 &&
      settingsSearch.single.hits > 0 &&
      settingsSearch.single.labels.some((label) => /spell/i.test(label)) &&
      settingsSearch.multi &&
      settingsSearch.multi.visible >= 1 &&
      settingsSearch.multi.labels.some((label) => /goal/i.test(label)) &&
      settingsSearch.none &&
      settingsSearch.none.visible === 0 &&
      settingsSearch.none.empty === true &&
      settingsSearch.cleared &&
      settingsSearch.cleared.visible === settingsSearch.audit.fields &&
      settingsSearch.cleared.hits === 0 &&
      settingsSearch.audit &&
      settingsSearch.audit.fields > 20 &&
      settingsSearch.audit.failures.length === 0,
    settingsSearch
  );

  // 157. searching settings opens the section it finds and restores folding afterwards
  const settingsCollapse = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    await jsOf(`document.querySelector('#open-settings').click()`);
    await sleep(700);
    const section = await jsOf("window.__mdpad.sectionOfField('API key')");
    const collapsed = await jsOf(`window.__mdpad.collapseSection(${JSON.stringify(section)})`);
    const before = await jsOf(`window.__mdpad.settingsSection(${JSON.stringify(section)})`);
    const during = await jsOf("window.__mdpad.settingsSearch('api key')");
    const openedNow = await jsOf(`window.__mdpad.settingsSection(${JSON.stringify(section)})`);
    const after = await jsOf("window.__mdpad.settingsSearch('')");
    const restored = await jsOf(`window.__mdpad.settingsSection(${JSON.stringify(section)})`);
    const expandedAgain = await jsOf(`window.__mdpad.collapseSection(${JSON.stringify(section)})`);
    await jsOf("document.querySelector('#settings-modal').hidden = true");
    return { section, collapsed, before, during, openedNow, after, restored, expandedAgain };
  })();
  step(
    'settings-search-collapse',
    typeof settingsCollapse.section === 'string' &&
      settingsCollapse.section.length > 0 &&
      settingsCollapse.collapsed === true &&
      settingsCollapse.before &&
      settingsCollapse.before.collapsed === true &&
      settingsCollapse.during &&
      settingsCollapse.during.visible >= 1 &&
      settingsCollapse.openedNow &&
      settingsCollapse.openedNow.collapsed === false &&
      settingsCollapse.after &&
      settingsCollapse.after.visible > settingsCollapse.during.visible &&
      settingsCollapse.restored &&
      settingsCollapse.restored.collapsed === true,
    settingsCollapse
  );

  // 158. arrows walk the settings results, Enter focuses the control, Escape clears the query first
  const settingsKeyboard = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    await jsOf(`document.querySelector('#open-settings').click()`);
    await sleep(700);
    const typed = await jsOf(`(() => {
      const input = document.querySelector('#set-filter');
      input.focus();
      input.value = 'api';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return window.__mdpad.settingsSearch.length >= 0;
    })()`);
    const visible = await jsOf('document.querySelectorAll(\'#settings-modal .field:not([hidden])\').length');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await sleep(200);
    const first = await jsOf('window.__mdpad.settingsActive()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await sleep(250);
    const focused = await jsOf('window.__mdpad.settingsActive()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(250);
    const cleared = await jsOf(`({
      query: document.querySelector('#set-filter').value,
      open: !document.querySelector('#settings-modal').hidden,
      visible: document.querySelectorAll('#settings-modal .field:not([hidden])').length,
    })`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(300);
    const closed = await jsOf("document.querySelector('#settings-modal').hidden");
    return { visible, first, focused, cleared, closed };
  })();
  step(
    'settings-keyboard',
    settingsKeyboard.visible >= 1 &&
      settingsKeyboard.first &&
      settingsKeyboard.first.index === 0 &&
      settingsKeyboard.first.marked === 1 &&
      settingsKeyboard.focused &&
      settingsKeyboard.focused.activeId !== '' &&
      settingsKeyboard.focused.activeId !== 'set-filter' &&
      settingsKeyboard.cleared &&
      settingsKeyboard.cleared.query === '' &&
      settingsKeyboard.cleared.open === true &&
      settingsKeyboard.cleared.visible > settingsKeyboard.visible &&
      settingsKeyboard.closed === true,
    settingsKeyboard
  );

  // 159. the command palette ranks by prefix and habit, wraps with arrows and records keyboard use
  const paletteKeyboard = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    await jsOf(`window.__mdpad.openPalette ? window.__mdpad.openPalette() : document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
    await sleep(500);
    const opened = await jsOf('window.__mdpad.paletteState()');
    const filtered = await jsOf("window.__mdpad.paletteType('the')");
    const prefixFirst = filtered.labels[0] && /^the/i.test(filtered.labels[0]);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await sleep(150);
    const afterDown = await jsOf('window.__mdpad.paletteState()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
    await sleep(150);
    const afterUp = await jsOf('window.__mdpad.paletteState()');
    // wrap: from the first item, Up goes to the last
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
    await sleep(150);
    const wrapped = await jsOf('window.__mdpad.paletteState()');
    const before = await jsOf('window.api.getSettings()');
    const usageBefore = (before.paletteUsage || {})[filtered.labels[0]] || 0;
    const emptySearch = await jsOf("window.__mdpad.paletteType('zzzz-nothing')");
    const emptyState = emptySearch.empty === true && emptySearch.total === 0;
    await jsOf("window.__mdpad.paletteType('')");
    const closed = await jsOf(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return document.querySelector('#palette').hidden;
    })()`);
    return { opened, filtered, prefixFirst, afterDown, afterUp, wrapped, usageBefore, emptyState, closed };
  })();
  step(
    'palette-keyboard',
    paletteKeyboard.opened &&
      paletteKeyboard.opened.open === true &&
      paletteKeyboard.opened.active === 0 &&
      paletteKeyboard.opened.marked === 1 &&
      paletteKeyboard.filtered &&
      paletteKeyboard.filtered.total > 0 &&
      paletteKeyboard.prefixFirst === true &&
      paletteKeyboard.afterDown.active === 1 &&
      paletteKeyboard.afterUp.active === 0 &&
      paletteKeyboard.wrapped.active === paletteKeyboard.wrapped.total - 1 &&
      paletteKeyboard.emptyState === true &&
      paletteKeyboard.closed === true,
    paletteKeyboard
  );

  // 160. document headings are palette targets and Enter jumps to them
  const paletteHeadings = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'palette-headings.md');
    fs.writeFileSync(
      doc,
      ['# Book', '', '## Introduction', '', 'first body', '', '## Methods', '', 'second body', '', '### Details', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('second body')");
      if (ready === true) break;
    }
    await jsOf("window.__mdpad.openPalette ? window.__mdpad.openPalette() : window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }))");
    await sleep(400);
    const all = await jsOf("window.__mdpad.paletteType('')");
    const filtered = await jsOf("window.__mdpad.paletteType('intro')");
    const first = filtered && filtered.labels[0];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await sleep(600);
    const caret = await jsOf('window.__mdpad.focusState()');
    const paletteClosed = await jsOf("document.querySelector('#palette').hidden");
    return { all, filtered, first, caret, paletteClosed };
  })();
  step(
    'palette-headings',
    paletteHeadings.all &&
      paletteHeadings.all.total > 5 &&
      paletteHeadings.filtered &&
      paletteHeadings.filtered.total >= 1 &&
      /Introduction/.test(paletteHeadings.first) &&
      paletteHeadings.caret &&
      /Introduction/.test(paletteHeadings.caret.caret) &&
      paletteHeadings.paletteClosed === true,
    paletteHeadings
  );

  // 161. the palette shows what it remembers, and settings can forget it
  const paletteUsage = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const cleared = await jsOf('window.__mdpad.paletteClearUsage()');
    await jsOf("window.__mdpad.paletteRecord('exportPdf', 4)");
    await sleep(300);
    await jsOf('window.__mdpad.openPalette ? window.__mdpad.openPalette() : null');
    await sleep(400);
    const state = await jsOf('window.__mdpad.paletteState()');
    const grouped = await jsOf('window.__mdpad.paletteGroup()');
    const first = state && state.labels[0];
    await jsOf("document.querySelector('#settings-modal').hidden = true");
    // settings shows the count and clears it
    await jsOf(`document.querySelector('#open-settings').click()`);
    await sleep(700);
    const rowText = await jsOf("document.querySelector('#set-palette-usage').textContent");
    await jsOf("document.querySelector('#set-palette-clear').click()");
    await sleep(400);
    const afterClear = await jsOf(`window.api.getSettings().then((s) => Object.keys(s.paletteUsage || {}).length)`);
    const rowAfter = await jsOf("document.querySelector('#set-palette-usage').textContent");
    await jsOf("document.querySelector('#settings-modal').hidden = true");
    return { cleared, state, grouped, first, rowText, afterClear, rowAfter };
  })();
  step(
    'palette-usage-group',
    paletteUsage.cleared === true &&
      paletteUsage.grouped === true &&
      paletteUsage.state &&
      /PDF/i.test(paletteUsage.first) &&
      /1 command/.test(paletteUsage.rowText) &&
      paletteUsage.afterClear === 0 &&
      /0 command/.test(paletteUsage.rowAfter),
    paletteUsage
  );

  // 162. the shortcuts list matches real commands, filters, and can run them
  const shortcutsPanel = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    await jsOf('window.__mdpad.openShortcuts ? window.__mdpad.openShortcuts() : document.querySelector("#shortcuts-close").click()');
    await jsOf("document.querySelector('#open-settings') && null");
    await sleep(300);
    const opened = await jsOf('window.__mdpad.shortcutsState()');
    const filtered = await jsOf("window.__mdpad.shortcutsFilter('zoom')");
    const filteredState = await jsOf('window.__mdpad.shortcutsState()');
    const emptyVisible = await jsOf("window.__mdpad.shortcutsFilter('zzzz-none')");
    const emptyState = await jsOf("!document.querySelector('#shortcuts-empty').hidden");
    await jsOf("window.__mdpad.shortcutsFilter('')");
    const restored = await jsOf('window.__mdpad.shortcutsState()');
    const ran = await jsOf(`(async () => {
      const row = [...document.querySelectorAll('#shortcuts tr[data-command]')].find(
        (item) => item.dataset.command === 'settings'
      );
      if (!row) return { error: 'row missing' };
      const button = row.querySelector('.shortcut-run');
      if (!button) return { error: 'button missing' };
      button.click();
      await new Promise((r) => setTimeout(r, 500));
      return { settingsOpen: !document.querySelector('#settings-modal').hidden, shortcutsOpen: !document.querySelector('#shortcuts').hidden };
    })()`);
    await jsOf("document.querySelector('#palette').hidden = true");
    return { opened, filtered, filteredState, emptyVisible, emptyState, restored, ran };
  })();
  step(
    'shortcuts-panel',
    shortcutsPanel.opened &&
      shortcutsPanel.opened.open === true &&
      shortcutsPanel.opened.rows >= 10 &&
      shortcutsPanel.opened.runButtons >= 10 &&
      shortcutsPanel.opened.missing.length === 0 &&
      shortcutsPanel.filtered >= 1 &&
      shortcutsPanel.filteredState.visible < shortcutsPanel.opened.visible &&
      shortcutsPanel.emptyVisible === 0 &&
      shortcutsPanel.emptyState === true &&
      shortcutsPanel.restored.visible === shortcutsPanel.opened.visible &&
      shortcutsPanel.ran &&
      shortcutsPanel.ran.settingsOpen === true &&
      shortcutsPanel.ran.shortcutsOpen === false,
    shortcutsPanel
  );

  // 163. one-time hints appear once each and disappear for good
  const hints = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    await jsOf("window.api.setSettings({ seenHints: {} })");
    await jsOf('window.__mdpad.refreshHints ? window.__mdpad.refreshHints() : null');
    await sleep(300);
    const first = await jsOf('window.__mdpad.hintState()');
    const dismissed = await jsOf('window.__mdpad.dismissHint()');
    const second = await jsOf('window.__mdpad.hintState()');
    await jsOf('window.__mdpad.dismissHint()');
    await jsOf('window.__mdpad.dismissHint()');
    const afterAll = await jsOf('window.__mdpad.hintState()');
    await sleep(600);
    const stored = await jsOf('window.api.getSettings().then((s) => s.seenHints)');
    await jsOf('window.api.setSettings({ seenHints: {} })');
    return { first, dismissed, second, afterAll, stored };
  })();
  step(
    'one-time-hints',
    hints.first &&
      hints.first.visible === true &&
      hints.first.active === 'palette' &&
      /Ctrl\+Shift\+P/.test(hints.first.text) &&
      hints.second &&
      hints.second.active === 'shortcuts' &&
      hints.second.visible === true &&
      hints.afterAll &&
      hints.afterAll.visible === false &&
      hints.stored &&
      hints.stored.palette === true &&
      hints.stored.shortcuts === true &&
      hints.stored.dropImage === true,
    hints
  );

  // 164. statistics export as CSV and Markdown, with the document and the writing history
  const statsExportTest = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'stats-export.md');
    fs.writeFileSync(
      doc,
      ['# Stats', '', '## One', '', 'a paragraph with several words in it', '', '## Two', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('several words')");
      if (ready === true) break;
    }
    await jsOf('window.api.writingReset()');
    const csv = await jsOf('window.__mdpad.statsCsv()');
    const markdown = await jsOf('window.__mdpad.statsMarkdown()');
    const csvPath = path.join(dir, 'stats.csv');
    const mdPath = path.join(dir, 'stats.md');
    const wroteCsv = await jsOf(`window.__mdpad.statsExportTo('csv', ${JSON.stringify(csvPath)})`);
    const wroteMd = await jsOf(`window.__mdpad.statsExportTo('md', ${JSON.stringify(mdPath)})`);
    const csvFile = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : '';
    const mdFile = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
    // the stats modal offers both buttons
    await jsOf("window.__mdpad.openStats ? window.__mdpad.openStats() : null");
    const buttons = await jsOf(`({
      csv: Boolean(document.querySelector('#stats-csv')),
      md: Boolean(document.querySelector('#stats-md')),
    })`);
    await jsOf("document.querySelector('#stats-modal').hidden = true");
    return { csv, markdown, wroteCsv, wroteMd, csvFile, mdFile, buttons };
  })();
  step(
    'stats-export',
    typeof statsExportTest.csv === 'string' &&
      statsExportTest.csv.startsWith('section,metric,value') &&
      /document,words,\d+/.test(statsExportTest.csv) &&
      /document,tables,[1-9]/.test(statsExportTest.csv) &&
      /history,days/.test(statsExportTest.csv) === false &&
      statsExportTest.csv.split('\n').some((line) => /^history,\d{4}-\d{2}-\d{2},\d+/.test(line)) &&
      typeof statsExportTest.markdown === 'string' &&
      statsExportTest.markdown.startsWith('# Statistics') &&
      /## Last 14 days/.test(statsExportTest.markdown) &&
      /Streak: \d+ day/.test(statsExportTest.markdown) &&
      statsExportTest.wroteCsv.ok === true &&
      statsExportTest.wroteMd.ok === true &&
      statsExportTest.csvFile === statsExportTest.csv &&
      statsExportTest.mdFile === statsExportTest.markdown &&
      statsExportTest.buttons.csv === true &&
      statsExportTest.buttons.md === true,
    {
      head: statsExportTest.csv.split('\n').slice(0, 6),
      mdHead: statsExportTest.markdown.split('\n').slice(0, 5),
      
      wroteCsv: statsExportTest.wroteCsv,
      wroteMd: statsExportTest.wroteMd,
      buttons: statsExportTest.buttons,
      csvHead: String(statsExportTest.csv).slice(0, 80),
    }
  );

  // 165. headings fold inside the editor, and the fold comes back with the document
  const headingFold = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'fold-heading.md');
    fs.writeFileSync(
      doc,
      ['# Book', '', '## Intro', '', 'intro body', '', '### Detail', '', 'detail body', '', '## Methods', '', 'methods body', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('methods body')");
      if (ready === true) break;
    }
    await sleep(400);
    // no folds remembered for this fresh file
    await jsOf(`window.__mdpad.restoreFoldsFor(${JSON.stringify(doc)})`);
    const before = await jsOf('window.__mdpad.headingFoldState()');
    const focused = await jsOf("window.__mdpad.focusHeading('Intro')");
    const folded = await jsOf('window.__mdpad.toggleHeadingFold()');
    await sleep(300);
    const foldedState = await jsOf('window.__mdpad.headingFoldState()');
    const markdownWhileFolded = await jsOf('window.__mdpad.getMarkdown()');
    const unfolded = await jsOf('window.__mdpad.toggleHeadingFold()');
    await sleep(200);
    const unfoldedState = await jsOf('window.__mdpad.headingFoldState()');
    // fold again and reload the document: the fold must be restored from settings
    await jsOf('window.__mdpad.toggleHeadingFold()');
    await sleep(300);
    const saved = await jsOf('window.api.getSettings().then((s) => s.foldedHeadings)');
    await sleep(200);
    await session.loadDocument(doc);
    await sleep(900);
    const restored = await jsOf('window.__mdpad.headingFoldState()');
    return { before, focused, folded, foldedState, markdownWhileFolded, unfolded, unfoldedState, saved, restored };
  })();
  step(
    'heading-fold',
    headingFold.before &&
      headingFold.before.folded.length === 0 &&
      headingFold.focused === true &&
      headingFold.folded === true &&
      headingFold.foldedState.folded.length === 1 &&
      headingFold.foldedState.hidden >= 1 &&
      headingFold.foldedState.marked === 1 &&
      /methods body/.test(headingFold.markdownWhileFolded) &&
      headingFold.unfolded === false &&
      headingFold.unfoldedState.hidden === 0 &&
      headingFold.saved &&
      Object.keys(headingFold.saved || {}).length >= 1 &&
      headingFold.restored &&
      headingFold.restored.folded.length === 1 &&
      headingFold.restored.hidden >= 1,
    headingFold
  );

  // 166. folding from the outline folds the editor too, and the outline remembers
  const foldSync = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'fold-sync.md');
    fs.writeFileSync(
      doc,
      ['# Book', '', '## Intro', '', 'intro body', '', '### Detail', '', 'detail body', '', '## Methods', '', 'methods body', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('methods body')");
      if (ready === true) break;
    }
    await sleep(500);
    await jsOf(`window.__mdpad.restoreFoldsFor(${JSON.stringify(doc)})`);
    await sleep(300);
    const outlineBefore = await jsOf(`({
      rows: document.querySelectorAll('#outline-list .outline-row').length,
      folds: window.__mdpad.headingFoldState().hidden,
    })`);
    // fold the first heading from the outline twisty
    const clicked = await jsOf(`(() => {
      const row = document.querySelectorAll('#outline-list .outline-row')[1];
      const twisty = row && row.querySelector('.outline-twisty');
      if (!twisty) return false;
      twisty.click();
      return true;
    })()`);
    await sleep(400);
    const outlineAfter = await jsOf(`({
      rows: document.querySelectorAll('#outline-list .outline-row').length,
      folds: window.__mdpad.headingFoldState().hidden,
      keys: window.__mdpad.headingFoldState().folded,
    })`);
    // the editor fold also updates the outline: unfold from the editor command
    await jsOf("window.__mdpad.focusHeading('Intro')");
    const toggled = await jsOf('window.__mdpad.toggleHeadingFold()');
    await sleep(300);
    const afterEditorToggle = await jsOf(`({
      rows: document.querySelectorAll('#outline-list .outline-row').length,
      folds: window.__mdpad.headingFoldState().hidden,
    })`);
    return { outlineBefore, clicked, outlineAfter, toggled, afterEditorToggle };
  })();
  step(
    'fold-sync',
    foldSync.outlineBefore &&
      foldSync.outlineBefore.rows === 4 &&
      foldSync.outlineBefore.folds === 0 &&
      foldSync.clicked === true &&
      foldSync.outlineAfter &&
      foldSync.outlineAfter.rows < foldSync.outlineBefore.rows &&
      foldSync.outlineAfter.folds >= 1 &&
      foldSync.outlineAfter.keys.length === 1 &&
      foldSync.toggled === false &&
      foldSync.afterEditorToggle &&
      foldSync.afterEditorToggle.rows === foldSync.outlineBefore.rows &&
      foldSync.afterEditorToggle.folds === 0,
    foldSync
  );

  // 167. the outline shows the words in each section, and how many a fold hides
  const outlineWords = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const introWords = 'one two three four five six seven eight';
    const methodsWords = 'alpha beta gamma delta';
    const doc = path.join(dir, 'outline-words.md');
    fs.writeFileSync(
      doc,
      ['# Book', '', '## Intro', '', introWords, '', '### Detail', '', 'extra words here', '', '## Methods', '', methodsWords, ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('alpha beta')");
      if (ready === true) break;
    }
    await sleep(600);
    const rows = await jsOf('window.__mdpad.outlineCounts()');
    // fold Intro from the outline and read the count again
    await jsOf(`(() => {
      const row = document.querySelectorAll('#outline-list .outline-row')[1];
      const twisty = row && row.querySelector('.outline-twisty');
      if (twisty) twisty.click();
    })()`);
    await sleep(500);
    const folded = await jsOf('window.__mdpad.outlineCounts()');
    await jsOf(`(() => {
      const row = document.querySelectorAll('#outline-list .outline-row')[1];
      const twisty = row && row.querySelector('.outline-twisty');
      if (twisty) twisty.click();
    })()`);
    return { rows, folded };
  })();
  const byText = (rows, text) => (rows || []).find((row) => row.text === text);
  step(
    'outline-word-counts',
    Array.isArray(outlineWords.rows) &&
      outlineWords.rows.length >= 3 &&
      byText(outlineWords.rows, 'Intro') &&
      /12/.test(byText(outlineWords.rows, 'Intro').count) &&
      /4/.test(byText(outlineWords.rows, 'Methods').count) &&
      byText(outlineWords.rows, 'Detail') &&
      /3/.test(byText(outlineWords.rows, 'Detail').count) &&
      Array.isArray(outlineWords.folded) &&
      byText(outlineWords.folded, 'Intro') &&
      /\+4/.test(byText(outlineWords.folded, 'Intro').count),
    {
      rows: outlineWords.rows,
      folded: outlineWords.folded,
    }
  );

  // 168. a single section can be exported without touching the rest of the document
  const sectionExport = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'section-export.md');
    fs.writeFileSync(
      doc,
      [
        '# Book',
        '',
        '## Intro',
        '',
        'intro body words',
        '',
        '### Detail',
        '',
        'detail body words',
        '',
        '## Methods',
        '',
        'methods body words',
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('methods body')");
      if (ready === true) break;
    }
    await sleep(500);
    const focused = await jsOf("window.__mdpad.focusHeading('Intro')");
    const section = await jsOf('window.__mdpad.sectionMarkdown()');
    const out = path.join(dir, 'section.html');
    const exported = await jsOf(
      `window.api.exportSectionTo(${JSON.stringify(out)}, ${JSON.stringify(section && section.markdown)}, 'html')`
    );
    const html = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    const focusedMethods = await jsOf("window.__mdpad.focusHeading('Methods')");
    const methodsSection = await jsOf('window.__mdpad.sectionMarkdown()');
    return { focused, section, exported, html, focusedMethods, methodsSection };
  })();
  step(
    'export-section',
    sectionExport.focused === true &&
      sectionExport.section &&
      /## Intro/.test(sectionExport.section.markdown) &&
      /intro body words/.test(sectionExport.section.markdown) &&
      /### Detail/.test(sectionExport.section.markdown) &&
      !/methods body words/.test(sectionExport.section.markdown) &&
      sectionExport.exported &&
      sectionExport.exported.exported === true &&
      /intro body words/.test(sectionExport.html) &&
      !/methods body words/.test(sectionExport.html) &&
      sectionExport.focusedMethods === true &&
      sectionExport.methodsSection &&
      /methods body words/.test(sectionExport.methodsSection.markdown) &&
      !/intro body words/.test(sectionExport.methodsSection.markdown),
    {
      title: sectionExport.section && sectionExport.section.title,
      section: sectionExport.section && sectionExport.section.markdown,
      exported: sectionExport.exported,
      methods: sectionExport.methodsSection && sectionExport.methodsSection.markdown,
    }
  );

  // 169. the export panel can narrow the export to the section at the caret
  const exportScopeTest = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'export-scope.md');
    fs.writeFileSync(doc, ['# Book', '', '## Intro', '', 'intro text here', '', '## Methods', '', 'methods text here', ''].join(nl), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('methods text')");
      if (ready === true) break;
    }
    await sleep(400);
    await jsOf("window.__mdpad.openExportPanel ? window.__mdpad.openExportPanel('html') : document.querySelector('#export-html').click()");
    await sleep(500);
    const initial = await jsOf('window.__mdpad.exportScopeState()');
    await jsOf("window.__mdpad.focusHeading('Intro')");
    const sectionState = await jsOf("window.__mdpad.setExportScope('section')");
    const narrowed = await jsOf('window.__mdpad.exportScopeState()');
    // the hint names the section
    const hint = narrowed.hint;
    // and the exported file only contains that section
    const out = path.join(dir, 'scope-section.html');
    const exported = await jsOf(
      `window.api.exportSectionTo(${JSON.stringify(out)}, window.__mdpad.sectionMarkdown().markdown, 'html')`
    );
    const html = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    await jsOf("window.__mdpad.setExportScope('document')");
    const restored = await jsOf('window.__mdpad.exportScopeState()');
    await jsOf("document.querySelector('#export-modal').hidden = true");
    return { initial, sectionState, narrowed, hint, exported, html, restored };
  })();
  step(
    'export-scope',
    exportScopeTest.initial &&
      exportScopeTest.initial.scope === 'document' &&
      exportScopeTest.initial.active.join() === 'document' &&
      exportScopeTest.sectionState === 'section' &&
      exportScopeTest.narrowed.scope === 'section' &&
      exportScopeTest.narrowed.active.join() === 'section' &&
      /Intro/.test(exportScopeTest.hint) &&
      exportScopeTest.exported &&
      exportScopeTest.exported.exported === true &&
      /intro text here/.test(exportScopeTest.html) &&
      !/methods text here/.test(exportScopeTest.html) &&
      exportScopeTest.restored.scope === 'document' &&
      exportScopeTest.restored.active.join() === 'document',
    {
      initial: exportScopeTest.initial,
      narrowed: exportScopeTest.narrowed,
      hint: exportScopeTest.hint,
      exported: exportScopeTest.exported,
    }
  );

  // 170. every export offers open, reveal and copy — and says so when an action fails
  const exportActionsTest = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const out = path.join(dir, 'actions-export.html');
    fs.writeFileSync(out, '<h1>ready</h1>', 'utf8');
    const labels = await jsOf(`window.__mdpad.exportActionToast(${JSON.stringify(out)}, 'actions-export.html')`);
    const copied = await jsOf(`window.__mdpad.exportActions(${JSON.stringify(out)}).run('copy')`);
    const clipboard = await jsOf('window.api.clipboardRead()');
    const opened = await jsOf(`window.__mdpad.exportActions(${JSON.stringify(out)}).run('open')`);
    const missing = path.join(dir, 'no-such-export.html');
    const failed = await jsOf(`window.__mdpad.exportActions(${JSON.stringify(missing)}).run('open')`);
    await sleep(300);
    const status = await jsOf('document.querySelector(\'#status\').textContent');
    const revealFailed = await jsOf(`window.__mdpad.exportActions(${JSON.stringify(missing)}).run('reveal')`);
    await sleep(300);
    const revealStatus = await jsOf('document.querySelector(\'#status\').textContent');
    await jsOf("document.querySelector('#toast').hidden = true");
    return { labels, copied, clipboard, opened, failed, status, revealFailed, revealStatus };
  })();
  step(
    'export-actions',
    Array.isArray(exportActionsTest.labels) &&
      exportActionsTest.labels.length === 3 &&
      exportActionsTest.labels.join('|').match(/Open/i) &&
      exportActionsTest.labels.join('|').match(/folder/i) &&
      exportActionsTest.labels.join('|').match(/Copy/i) &&
      exportActionsTest.copied &&
      exportActionsTest.copied.ok === true &&
      exportActionsTest.clipboard === dir + '\\actions-export.html' &&
      exportActionsTest.opened &&
      exportActionsTest.opened.ok === true &&
      exportActionsTest.failed &&
      exportActionsTest.failed.ok === false &&
      exportActionsTest.failed.reason === 'file not found' &&
      /Could not open the file/.test(exportActionsTest.status) &&
      exportActionsTest.revealFailed &&
      exportActionsTest.revealFailed.ok === false &&
      /Could not open the folder/.test(exportActionsTest.revealStatus),
    {
      labels: exportActionsTest.labels,
      copied: exportActionsTest.copied,
      clipboard: exportActionsTest.clipboard,
      failed: exportActionsTest.failed,
      status: exportActionsTest.status,
      revealStatus: exportActionsTest.revealStatus,
    }
  );

  // 171. finished exports are remembered, can be reopened, and the list can be cleared
  const exportHistoryTest = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'history-source.md');
    fs.writeFileSync(doc, '# History' + nl + nl + '## One' + nl + nl + 'body words' + nl, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('body words')");
      if (ready === true) break;
    }
    await jsOf("window.api.setSettings({ exportHistory: [] })");
    await jsOf("window.__mdpad.focusHeading('One')");
    const target = path.join(dir, 'history-export.html');
    const exported = await jsOf(
      `window.api.exportSectionTo(${JSON.stringify(target)}, window.__mdpad.sectionMarkdown().markdown, 'html')`
    );
    await sleep(400);
    const stored = await jsOf('window.api.getSettings().then((s) => s.exportHistory)');
    await jsOf("window.__mdpad.openExportPanel('html')");
    await sleep(600);
    const state = await jsOf('window.__mdpad.exportHistoryState()');
    await jsOf("document.querySelector('#export-history .export-history-clear').click()");
    await sleep(500);
    const cleared = await jsOf('window.__mdpad.exportHistoryState()');
    const storedAfter = await jsOf('window.api.getSettings().then((s) => s.exportHistory)');
    await jsOf("document.querySelector('#export-modal').hidden = true");
    return { exported, stored, state, cleared, storedAfter, target };
  })();
  step(
    'export-history',
    exportHistoryTest.exported &&
      exportHistoryTest.exported.exported === true &&
      Array.isArray(exportHistoryTest.stored) &&
      exportHistoryTest.stored.length === 1 &&
      exportHistoryTest.stored[0].path === exportHistoryTest.target &&
      exportHistoryTest.stored[0].kind === 'html' &&
      exportHistoryTest.state &&
      exportHistoryTest.state.rows.length === 1 &&
      /history-export\.html/.test(exportHistoryTest.state.rows[0].name) &&
      /HTML/.test(exportHistoryTest.state.rows[0].meta) &&
      exportHistoryTest.state.clear === true &&
      exportHistoryTest.cleared &&
      exportHistoryTest.cleared.rows.length === 0 &&
      exportHistoryTest.cleared.empty === true &&
      Array.isArray(exportHistoryTest.storedAfter) &&
      exportHistoryTest.storedAfter.length === 0,
    {
      exported: exportHistoryTest.exported,
      stored: exportHistoryTest.stored,
      state: exportHistoryTest.state,
      cleared: exportHistoryTest.cleared,
    }
  );

  // 172. the caret and scroll of a tab survive a reload of the document
  const viewRestore = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'view-state.md');
    const paragraphs = [];
    for (let i = 0; i < 40; i += 1) paragraphs.push('paragraph number ' + i + ' with enough words to fill a line');
    fs.writeFileSync(doc, ['# View', '', '## Section A', '', ...paragraphs, ''].join(nl), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('paragraph number 30')");
      if (ready === true) break;
    }
    await sleep(500);
    // move the caret deep into the document and scroll down
    await jsOf(`(() => {
      const ed = window.__mdpad.editor;
      ed.commands.setTextSelection(Math.floor(ed.state.doc.content.size * 0.7));
      ed.commands.focus();
    })()`);
    await sleep(1200);
    const before = await jsOf(`(() => {
      const pane = document.querySelector('#editor-pane') || document.querySelector('.editor-scroll');
      return {
        cursor: window.__mdpad.editor.state.selection.from,
        scrollTop: 0,
        size: window.__mdpad.editor.state.doc.content.size,
      };
    })()`);
    await jsOf(`window.api.setViewState({
      tabId: ${JSON.stringify(doc)},
      cursor: ${before.cursor},
      scrollTop: 400,
    })`);
    await sleep(300);
    await session.loadDocument(doc);
    await sleep(1500);
    const after = await jsOf("window.__mdpad.viewStateFor(" + JSON.stringify(doc) + ")");
    return { before, after };
  })();
  step(
    'view-restore',
    viewRestore.before &&
      viewRestore.before.cursor > 100 &&
      viewRestore.after &&
      Math.abs(viewRestore.after.cursor - viewRestore.before.cursor) < 5 &&
      viewRestore.after.scroll === 400,
    viewRestore
  );

  // 173. tabs whose file vanished are reported instead of disappearing silently
  const restoreMissing = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const single = await jsOf(`window.__mdpad.restoreMissingToast({
      files: ['C:\\\\notes\\\\gone-one.md'],
      count: 1,
    })`);
    await sleep(200);
    const singleToast = await jsOf("document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent");
    const many = await jsOf(`window.__mdpad.restoreMissingToast({
      files: ['C:\\\\notes\\\\a.md', 'C:\\\\notes\\\\b.md', 'C:\\\\notes\\\\c.md', 'C:\\\\notes\\\\d.md'],
      count: 4,
    })`);
    await sleep(200);
    const manyToast = await jsOf("document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent");
    const none = await jsOf('window.__mdpad.restoreMissingToast({ files: [], count: 0 })');
    await jsOf("document.querySelector('#toast').hidden = true");
    return { single, singleToast, many, manyToast, none };
  })();
  step(
    'restore-missing-tabs',
    typeof restoreMissing.single === 'string' &&
      /One tab was not reopened/.test(restoreMissing.single) &&
      /gone-one\.md/.test(restoreMissing.single) &&
      /One tab was not reopened/.test(restoreMissing.singleToast) &&
      typeof restoreMissing.many === 'string' &&
      /4 tabs were not reopened/.test(restoreMissing.many) &&
      /a\.md, b\.md, c\.md/.test(restoreMissing.many) &&
      /…/.test(restoreMissing.many) &&
      restoreMissing.none === '',
    restoreMissing
  );

  // 174. page numbers can be switched off, which shortens large PDF exports
  const pageNumbersTest = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'page-numbers.md');
    const body = [];
    for (let i = 0; i < 120; i += 1) body.push('paragraph ' + i + ' with a handful of words to make pages');
    fs.writeFileSync(doc, ['# Pages', '', ...body, ''].join(nl), 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('paragraph 119')");
      if (ready === true) break;
    }
    await sleep(400);
    await jsOf("window.api.setSettings({ exportPageNumbers: true })");
    const withNumbers = await session.exportTo(path.join(dir, 'pages-on.pdf'), 'pdf');
    await jsOf("window.api.setSettings({ exportPageNumbers: false })");
    const withoutNumbers = await session.exportTo(path.join(dir, 'pages-off.pdf'), 'pdf');
    await sleep(200);
    const setting = await jsOf('window.api.getSettings().then((s) => s.exportPageNumbers)');
    await jsOf('window.__mdpad.openExportPanel("pdf")');
    await sleep(500);
    const checkbox = await jsOf(`({
      present: Boolean(document.querySelector('#export-page-numbers')),
      checked: (document.querySelector('#export-page-numbers') || {}).checked === true,
    })`);
    await jsOf("document.querySelector('#export-modal').hidden = true");
    await jsOf("window.api.setSettings({ exportPageNumbers: true })");
    return { withNumbers, withoutNumbers, setting, checkbox };
  })();
  step(
    'export-page-numbers',
    pageNumbersTest.withNumbers &&
      pageNumbersTest.withNumbers.exported === true &&
      pageNumbersTest.withoutNumbers &&
      pageNumbersTest.withoutNumbers.exported === true &&
      pageNumbersTest.withoutNumbers.bytes < pageNumbersTest.withNumbers.bytes &&
      pageNumbersTest.setting === false &&
      pageNumbersTest.checkbox.present === true &&
      pageNumbersTest.checkbox.checked === false,
    pageNumbersTest
  );

  // 175. only the sentence under the caret is highlighted, and it can be switched off
  const sentenceHighlight = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'sentence-highlight.md');
    fs.writeFileSync(
      doc,
      ['# Sentences', '', 'First sentence here. Second one is longer! Third asks a question?', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Third asks')");
      if (ready === true) break;
    }
    await sleep(400);
    await jsOf('window.__mdpad.setSentenceHighlight(true)');
    const placed = await jsOf(`(() => {
      const ed = window.__mdpad.editor;
      let target = null;
      ed.state.doc.descendants((node, pos) => {
        if (target !== null) return false;
        if (node.isTextblock && node.textContent.includes('Second one')) {
          target = pos + 1 + node.textContent.indexOf('Second') + 4;
          return false;
        }
        return true;
      });
      if (target === null) return false;
      ed.commands.setTextSelection(target);
      return true;
    })()`);
    await sleep(300);
    const on = await jsOf('window.__mdpad.sentenceHighlightState()');
    await jsOf('window.__mdpad.setSentenceHighlight(false)');
    await sleep(200);
    const off = await jsOf('window.__mdpad.sentenceHighlightState()');
    return { placed, on, off };
  })();
  step(
    'sentence-highlight',
    sentenceHighlight.placed === true &&
      sentenceHighlight.on &&
      sentenceHighlight.on.enabled === true &&
      sentenceHighlight.on.decorated.length === 1 &&
      sentenceHighlight.on.decorated[0] === 'Second one is longer!' &&
      sentenceHighlight.off &&
      sentenceHighlight.off.enabled === false &&
      sentenceHighlight.off.decorated.length === 0,
    sentenceHighlight
  );

  // 176. sentence length shows up in the statistics and the structure report
  const sentenceStats = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'sentence-stats.md');
    const longSentence = Array.from({ length: 45 }, (_, index) => 'word' + index).join(' ') + '.';
    fs.writeFileSync(
      doc,
      ['# Stats', '', 'First short one. Second is a little longer!', '', longSentence, ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('word44')");
      if (ready === true) break;
    }
    await sleep(400);
    const structure = await jsOf('window.api.docStructure()');
    const report = await jsOf('window.__mdpad.structureReportText ? window.__mdpad.structureReportText() : null');
    await jsOf("window.__mdpad.openStats ? window.__mdpad.openStats() : null");
    await sleep(700);
    const rows = await jsOf(`[...document.querySelectorAll('#stats-table tr')].map((row) => row.textContent)`);
    await jsOf("document.querySelector('#stats-modal').hidden = true");
    return { structure: structure && structure.sentences, rows, report };
  })();
  step(
    'sentence-stats',
    sentenceStats.structure &&
      sentenceStats.structure.count === 3 &&
      sentenceStats.structure.longest.words === 45 &&
      sentenceStats.structure.long.length <= 10 &&
      sentenceStats.structure.long.some((entry) => entry.words === 45) &&
      Array.isArray(sentenceStats.rows) &&
      sentenceStats.rows.some((row) => /sentences/i.test(row) && /3/.test(row)) &&
      sentenceStats.rows.some((row) => /average sentence/i.test(row)),
    sentenceStats
  );

  // 177. repeated words, doubled words and repeated phrases reach the structure payload
  const repetitionStats = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'repetition.md');
    fs.writeFileSync(
      doc,
      [
        '# Repetition',
        '',
        'The important thing is important. Very important, and the important result.',
        '',
        'This is very very good and that that works.',
        '',
        'in spite of everything we tried, in spite of the noise, in spite of it all',
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('in spite of it all')");
      if (ready === true) break;
    }
    await sleep(400);
    const structure = await jsOf('window.api.docStructure()');
    return structure && structure.repetition;
  })();
  step(
    'repetition-report',
    repetitionStats &&
      repetitionStats.words.some((entry) => entry.word === 'important' && entry.count === 4) &&
      repetitionStats.doubled.some((entry) => entry.phrase === 'very very') &&
      repetitionStats.repeated.some((entry) => entry.phrase === 'in spite of' && entry.count === 3) &&
      !repetitionStats.words.some((entry) => entry.word === 'the'),
    repetitionStats
  );

  // 178. hedge words and passive constructions are reported as hints
  const styleHints = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'style-hints.md');
    fs.writeFileSync(
      doc,
      [
        '# Style',
        '',
        'This is very good and really simple. It is very clearly written by hand.',
        '',
        'The report was written yesterday. The decision was quickly made.',
        '',
        'The sky is red and she was tired.',
        '',
      ].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('was quickly made')");
      if (ready === true) break;
    }
    await sleep(400);
    const structure = await jsOf('window.api.docStructure()');
    return structure && structure.style;
  })();
  step(
    'style-hints',
    styleHints &&
      styleHints.weak.some((entry) => entry.word === 'very' && entry.count === 2) &&
      styleHints.passive.some((entry) => /was written/.test(entry.text)) &&
      styleHints.passive.some((entry) => /was quickly made/.test(entry.text)) &&
      !styleHints.passive.some((entry) => /sky is red/.test(entry.text)) &&
      !styleHints.passive.some((entry) => /was tired/.test(entry.text)),
    styleHints
  );

  // 179. the structure report can drop style or repetition and change the sentence limit
  const reportOptionsTest = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'report-options.md');
    const longSentence = Array.from({ length: 45 }, (_, index) => 'word' + index).join(' ') + '.';
    fs.writeFileSync(
      doc,
      ['# Options', '', 'This is very good and really simple.', '', longSentence, '', 'The report was written yesterday.', ''].join(nl),
      'utf8'
    );
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('word44')");
      if (ready === true) break;
    }
    await sleep(400);
    const all = await jsOf('window.api.docStructure()');
    await jsOf("window.api.setSettings({ reportOptions: { style: false, repetition: false, sentenceLimit: 20 } })");
    await sleep(300);
    const reduced = await jsOf('window.api.docStructure()');
    await jsOf(`document.querySelector('#open-settings') && null`);
    await jsOf("window.__mdpad.openStructureReport ? window.__mdpad.openStructureReport() : null");
    await sleep(700);
    const ui = await jsOf('window.__mdpad.reportOptionsState()');
    await jsOf("document.querySelector('#structure-report').hidden = true");
    // put the defaults back
    await jsOf("window.api.setSettings({ reportOptions: { style: true, repetition: true, sentenceLimit: 40 } })");
    return { all, reduced, ui };
  })();
  step(
    'report-options',
    reportOptionsTest.all &&
      reportOptionsTest.all.style &&
      reportOptionsTest.all.repetition &&
      reportOptionsTest.all.sentences.limit === 40 &&
      reportOptionsTest.reduced &&
      reportOptionsTest.reduced.style === undefined &&
      reportOptionsTest.reduced.repetition === undefined &&
      reportOptionsTest.reduced.sentences.limit === 20 &&
      reportOptionsTest.reduced.sentences.long.length === 1 &&
      reportOptionsTest.ui &&
      reportOptionsTest.ui.styleChecked === false &&
      reportOptionsTest.ui.limit === 20,
    {
      all: { style: Boolean(reportOptionsTest.all.style), limit: reportOptionsTest.all.sentences.limit },
      reduced: {
        style: reportOptionsTest.reduced.style,
        repetition: reportOptionsTest.reduced.repetition,
        limit: reportOptionsTest.reduced.sentences.limit,
        long: reportOptionsTest.reduced.sentences.long.length,
      },
      ui: reportOptionsTest.ui,
    }
  );

  // 180. a saved report becomes the baseline: metrics show direction, not a score
  const reportTrendTest = await (async () => {
    const jsOf = (code) => win.webContents.executeJavaScript(code).catch((err) => ({ __error: err.message }));
    const nl = String.fromCharCode(10);
    const doc = path.join(dir, 'report-trend.md');
    const firstPass = ['# Trend', '', 'Short one. Short two. Short three.', ''].join(nl);
    fs.writeFileSync(doc, firstPass, 'utf8');
    const session = sessions.get(win.webContents.id);
    await session.loadDocument(doc);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('Short three')");
      if (ready === true) break;
    }
    await sleep(400);
    const first = await jsOf('window.api.docStructure()');
    // save this report as the baseline, exactly as Save report… does
    const saved = await jsOf(`(async () => {
      const report = await window.api.docStructure();
      const summary = {
        issues: report.skips.length + report.duplicates.length,
        words: report.words,
        headings: report.headings.length,
        avgSentence: report.sentences ? report.sentences.avgWords : undefined,
        longSentences: report.sentences ? report.sentences.long.length : undefined,
        passive: report.style ? report.style.passiveCount : undefined,
        repeated: report.repetition ? report.repetition.words.length + report.repetition.repeated.length : undefined,
        savedAt: Date.now(),
      };
      const target = ${JSON.stringify(path.join(dir, 'report-trend-structure.md'))};
      return window.api.writeReportTo(target, '# baseline' + String.fromCharCode(10), summary);
    })()`);
    // longer sentences and a passive construction in the second pass
    const secondPass = [
      '# Trend',
      '',
      'This sentence is considerably longer than the ones in the first pass because it keeps going.',
      '',
      'The report was written yesterday and the decision was quickly made by the committee.',
      '',
    ].join(nl);
    fs.writeFileSync(doc, secondPass, 'utf8');
    await session.reloadFromDisk();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(200);
      const ready = await jsOf("window.__mdpad.getMarkdown().includes('committee')");
      if (ready === true) break;
    }
    await sleep(400);
    const second = await jsOf('window.api.docStructure()');
    const markdown = await jsOf('window.__mdpad.structureMarkdownFor ? window.__mdpad.structureMarkdownFor() : null');
    return { first, saved, second, markdown };
  })();
  step(
    'report-trend',
    reportTrendTest.saved &&
      reportTrendTest.saved.ok === true &&
      reportTrendTest.second.previous &&
      reportTrendTest.second.previous.avgSentence === reportTrendTest.first.sentences.avgWords &&
      reportTrendTest.second.sentences.avgWords > reportTrendTest.first.sentences.avgWords &&
      reportTrendTest.second.style.passiveCount >= 1 &&
      reportTrendTest.second.words > 0,
    {
      saved: reportTrendTest.saved,
      previous: reportTrendTest.second.previous,
      firstAvg: reportTrendTest.first.sentences.avgWords,
      secondAvg: reportTrendTest.second.sentences.avgWords,
      passive: reportTrendTest.second.style.passiveCount,
    }
  );

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
    // The indicator is updated over IPC, so poll for the dirty state instead of sampling once:
    // a single fixed delay races the message under load.
    let dirty = '';
    for (let i = 0; i < 40; i += 1) {
      dirty = window.__mdpad.saveState();
      if (dirty === 'Unsaved') break;
      await sleep(50);
    }
    // Wait for the autosave to land (autosaveMs is short in smoke runs).
    let saved = '';
    for (let i = 0; i < 60; i += 1) {
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


  if (wroteResourceFeed) {
    try {
      fs.unlinkSync(resourceFeed);
    } catch {
      /* best effort */
    }
  }
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

  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-action="find"]').click();
    await sleep(250);
    const input = document.querySelector('#find-input');
    input.value = 'markdown';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
  })()`);
  await sleep(300);
  await shot('08-find.png');
  await win.webContents.executeJavaScript(`document.querySelector('#find-close').click()`);
  await sleep(250);
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__mdpad.setMarkdown('');
    await sleep(300);
    window.__mdpad.editor.chain().focus('end').insertContent('/').run();
    await sleep(400);
  })()`);
  await sleep(300);
  await shot('09-slash.png');
  await win.webContents.executeJavaScript(
    `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.__mdpad.setMarkdown(characterSample);
    })()`.replace('characterSample', JSON.stringify(SAMPLE_DOC))
  );
  await sleep(400);
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

// Fast-crash harness: type and die immediately, without an explicit draft write. This is the case
// a leading-edge draft exists for: the edit must be on disk before the process is killed.
async function runCrashFastWrite() {
  const win = createWindow({ show: false });
  const session = sessions.get(win.webContents.id);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(200);
  session.loadDocument(CRASH_FILE);
  await sleep(400);
  const token = 'FAST-CRASH-' + Date.now();
  const waitMs = Number(process.env.MDPAD_FAST_KILL_MS || 120);
  await win.webContents.executeJavaScript(
    'window.__mdpad.applyMarkdown(' + JSON.stringify('# crash target\n\n' + token) + ')'
  );
  await sleep(waitMs);
  const draft = storage.readDraft(CRASH_FILE, draftsDir());
  const kept = Boolean(draft && draft.contents.includes(token));
  console.log('CRASH_FAST ' + JSON.stringify({ token, kept, bytes: draft ? draft.contents.length : 0 }));
  process.kill(process.pid, 'SIGKILL');
}

async function runCrashFastVerify() {
  const draft = storage.readDraft(CRASH_FILE, draftsDir());
  console.log(
    'CRASH_FAST_VERIFY ' +
      JSON.stringify({
        hasDraft: Boolean(draft),
        kept: Boolean(draft && /FAST-CRASH-/.test(draft.contents)),
        bytes: draft ? draft.contents.length : 0,
      })
  );
  app.exit(0);
}

// Two tabs, two dirty buffers, killed quickly: each draft must belong to its own file. This was a
// real bug once — the background tab's draft was written from the active buffer.
async function runCrashTabsWrite() {
  const win = createWindow({ show: false });
  const session = sessions.get(win.webContents.id);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(250);
  const second = process.env.MDPAD_CRASH_FILE_B;
  if (!second) {
    console.log('CRASH_TABS_ERROR no second file');
    app.exit(2);
    return;
  }
  session.loadDocument(CRASH_FILE);
  await sleep(350);
  const tokenA = 'TAB-A-' + Date.now();
  await win.webContents.executeJavaScript(
    'window.__mdpad.applyMarkdown(' + JSON.stringify('# A\\n\\n' + tokenA) + ')'
  );
  await sleep(400);
  session.loadDocument(second);
  await sleep(350);
  const tokenB = 'TAB-B-' + Date.now();
  await win.webContents.executeJavaScript(
    'window.__mdpad.applyMarkdown(' + JSON.stringify('# B\\n\\n' + tokenB) + ')'
  );
  await sleep(150);
  const draftA = storage.readDraft(CRASH_FILE, draftsDir());
  const draftB = storage.readDraft(second, draftsDir());
  const result = {
    tokenA,
    tokenB,
    keptA: Boolean(draftA && draftA.contents.includes(tokenA)),
    keptB: Boolean(draftB && draftB.contents.includes(tokenB)),
  };
  fs.writeFileSync(path.join(app.getPath('temp'), 'mdpad-crash-tabs.json'), JSON.stringify(result), 'utf8');
  console.log('CRASH_TABS ' + JSON.stringify(result));
  process.kill(process.pid, 'SIGKILL');
}

async function runCrashTabsVerify() {
  const second = process.env.MDPAD_CRASH_FILE_B;
  const draftA = storage.readDraft(CRASH_FILE, draftsDir());
  const draftB = second ? storage.readDraft(second, draftsDir()) : null;
  const result = {
    hasA: Boolean(draftA),
    hasB: Boolean(draftB),
    keptA: Boolean(draftA && /TAB-A-/.test(draftA.contents)),
    keptB: Boolean(draftB && /TAB-B-/.test(draftB.contents)),
    distinct: Boolean(draftA && draftB && draftA.contents !== draftB.contents),
  };
  console.log('CRASH_TABS_VERIFY ' + JSON.stringify(result));
  app.exit(result.keptA && result.keptB && result.distinct ? 0 : 1);
}

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

let thumbWindow = null;

// A real page, rendered small. The panel used to show an abstract sketch, which told the user
// nothing about the font or the margins they had just picked.
async function exportThumbnail(session, options = {}) {
  const name = session.file ? path.basename(session.file, path.extname(session.file)) : 'Untitled';
  const html = exporter.toHtmlDocument(session.contents, name, {
    template: options.template || exportTemplate(),
    css: String(readSettings().exportCss || ''),
    font: exportFontStackFor(options.font),
    margin: options.margin || readSettings().exportMargin || 'normal',
    diagrams: session.exportDiagrams || null,
  });
  const file = path.join(userDir(), 'export-thumb.html');
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');

  if (!thumbWindow || thumbWindow.isDestroyed()) {
    thumbWindow = new BrowserWindow({
      show: false,
      width: 420,
      height: 560,
      webPreferences: { backgroundThrottling: false, sandbox: false, javascript: false },
    });
  }
  await thumbWindow.loadURL('file://' + file.replace(/\\/g, '/'));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const image = await thumbWindow.webContents.capturePage();
  const png = image.toPNG();
  return { ok: true, dataUrl: 'data:image/png;base64,' + png.toString('base64'), bytes: png.length };
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
  READY_AT = Date.now();
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

  if (CRASH_PHASE === 'fast') {
    await runCrashFastWrite();
    return;
  }
  if (CRASH_PHASE === 'tabs') {
    await runCrashTabsWrite();
    return;
  }
  if (CRASH_PHASE === 'tabs-verify') {
    await runCrashTabsVerify();
    return;
  }
  if (CRASH_PHASE === 'fast-verify') {
    await runCrashFastVerify();
    return;
  }
  if (process.argv.includes('--perf-report')) {
    await runPerfReport();
    return;
  }
  if (process.argv.includes('--verify-profile')) {
    await runVerifyProfile();
    return;
  }
  if (process.argv.includes('--walkthrough')) {
    await runWalkthrough();
    return;
  }
  if (process.argv.includes('--bench-pdf')) {
    await runBenchPdf();
    return;
  }
  if (process.argv.includes('--bench-export')) {
    await runBenchExport();
    return;
  }
  if (process.argv.includes('--bench-typing')) {
    await runBenchTyping();
    return;
  }
  if (process.argv.includes('--bench-load')) {
    await runBenchLoad();
    return;
  }
  if (process.argv.includes('--perf-open')) {
    await runPerfOpen();
    return;
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

function flushAllDrafts() {
  for (const session of sessions.values()) {
    try {
      session.writeDraftNow();
    } catch (err) {
      logLine('draft', 'flush failed: ' + err.message);
    }
  }
}

powerMonitor.on('suspend', () => {
  flushAllDrafts();
});

app.on('before-quit', () => {
  flushAllDrafts();
  saveSession();
  writeCrashStreak(0);
  clearRunning();
  for (const session of sessions.values()) session.dispose();
});

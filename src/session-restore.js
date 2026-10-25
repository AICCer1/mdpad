'use strict';

// Pure planning for session restore: which windows and tabs are worth reopening.
// Kept separate from main.js so the capping rules can be unit-tested without Electron.

const MAX_WINDOWS = 4;
const MAX_TABS_PER_WINDOW = 20;
const MAX_UNTITLED_PER_WINDOW = 5;
const MAX_UNTITLED_BYTES = 200_000;

function planRestore(snapshot, options = {}) {
  const {
    exists = () => true,
    maxWindows = MAX_WINDOWS,
    maxTabs = MAX_TABS_PER_WINDOW,
    maxUntitled = MAX_UNTITLED_PER_WINDOW,
    maxUntitledBytes = MAX_UNTITLED_BYTES,
  } = options;

  if (!snapshot || !Array.isArray(snapshot.windows)) return [];

  const plans = [];
  let totalDropped = 0;
  for (const win of snapshot.windows.slice(0, maxWindows)) {
    if (!win || typeof win !== 'object') continue;
    const tabs = Array.isArray(win.tabs) ? win.tabs : [];
    const kept = [];
    const missing = [];
    let untitled = 0;
    let dropped = 0;

    for (const tab of tabs) {
      if (kept.length >= maxTabs) {
        dropped += 1;
        continue;
      }
      if (!tab || typeof tab !== 'object') continue;
      if (tab.file) {
        if (!exists(tab.file)) {
          dropped += 1;
          missing.push(tab.file);
          continue;
        }
        // the view (caret and scroll) travels with the tab, so a restart also lands in the right place
        kept.push(tab.view ? { file: tab.file, contents: null, view: tab.view } : { file: tab.file, contents: null });
      } else {
        const contents = String(tab.contents || '');
        if (untitled >= maxUntitled || contents.length > maxUntitledBytes) {
          dropped += 1;
          continue;
        }
        untitled += 1;
        kept.push({ file: null, contents });
      }
    }

    if (!kept.length) continue; // never reopen an empty window
    totalDropped += dropped;
    plans.push({
      tabs: kept,
      activeId: win.activeId || null,
      treeRoot: win.treeRoot || null,
      bounds: win.bounds || null,
      maximized: win.maximized === true,
      dropped,
      missing,
    });
  }

  return plans;
}

module.exports = { planRestore, MAX_WINDOWS, MAX_TABS_PER_WINDOW, MAX_UNTITLED_PER_WINDOW };

'use strict';

// Close-guard summary: "3 documents with unsaved changes: a.md, b.md, +1 more".
// Pure so the wording rules are testable without opening a dialog.

const path = require('node:path');

function displayName(tab) {
  if (!tab) return 'Untitled';
  if (tab.file) return path.basename(tab.file);
  return 'Untitled';
}

function summarizeDirty(tabs, limit = 5) {
  const list = Array.isArray(tabs) ? tabs.filter(Boolean) : [];
  const names = list.map(displayName);
  const shown = names.slice(0, limit);
  const extra = names.length - shown.length;
  return {
    count: names.length,
    names,
    detail: extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', '),
  };
}

module.exports = { summarizeDirty, displayName };

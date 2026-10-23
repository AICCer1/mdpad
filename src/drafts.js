'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Enumerates recovery drafts so the UI can offer them as a list instead of only
// reacting when the matching file happens to be opened.

function listDrafts(draftsDir) {
  let names = [];
  try {
    names = fs.readdirSync(draftsDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const drafts = [];
  for (const name of names) {
    const full = path.join(draftsDir, name);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!data || typeof data.contents !== 'string') continue;
      drafts.push({
        path: full,
        file: typeof data.file === 'string' ? data.file : null,
        name: data.file ? path.basename(data.file) : 'Untitled',
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
        bytes: data.contents.length,
        contents: data.contents,
      });
    } catch {
      /* unreadable draft: skip it rather than failing the whole list */
    }
  }

  drafts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return drafts;
}

// Drafts older than the cutoff are candidates for cleanup. Nothing is deleted without the
// user confirming, and drafts whose source file still exists are kept regardless.
function selectStaleDrafts(drafts, { now = Date.now(), olderThanDays = 30, days: legacyDays } = {}) {
  const days = Number.isFinite(olderThanDays) ? olderThanDays : legacyDays;
  if (!Array.isArray(drafts) || !Number.isFinite(days)) return [];
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return drafts.filter((draft) => {
    if (!draft || !draft.updatedAt) return false;
    const stamp = Date.parse(draft.updatedAt);
    if (!Number.isFinite(stamp) || stamp > cutoff) return false;
    return true;
  });
}

module.exports = { listDrafts, selectStaleDrafts };

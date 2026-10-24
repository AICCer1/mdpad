'use strict';

// Exported documents keep their links, but a relative link to a file that is not there would fail
// silently in the reader. Mark it instead: the text stays, the reader learns why it cannot open.
const fs = require('node:fs');
const path = require('node:path');

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// epub: relative .md links can never resolve inside the container, so they are always flagged.
function markLinkTargets(html, baseDir, { epub = false } = {}) {
  return String(html || '').replace(
    /<a\b([^>]*?)\bhref="([^"]*)"([^>]*)>/gi,
    (match, before, href, after) => {
      if (EXTERNAL.test(href)) return match;
      const clean = decodeURI(href.replace(/[#?].*$/, ''));
      if (!clean) return match;
      let exists = false;
      try {
        exists = fs.existsSync(path.resolve(baseDir || process.cwd(), clean));
      } catch {
        exists = false;
      }
      if (epub) {
        return '<a' + before + 'href="' + href + '"' + after + ' data-link-missing="1" title="Not included in this EPUB: ' + escapeAttr(clean) + '">';
      }
      if (!exists) {
        return '<a' + before + 'href="' + href + '"' + after + ' data-link-missing="1" title="File not found: ' + escapeAttr(clean) + '">';
      }
      return match;
    }
  );
}

module.exports = { markLinkTargets };

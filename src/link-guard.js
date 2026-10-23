'use strict';

// Link handling rules. The editor lives in a window that must never navigate away from the
// app, so a click either places the caret or (with a modifier) hands the URL to the OS browser.

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false;
  const text = url.trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return SAFE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function shouldOpenExternal(event) {
  if (!event) return false;
  return Boolean(event.ctrlKey || event.metaKey || event.button === 1);
}

module.exports = { isSafeExternalUrl, shouldOpenExternal, SAFE_PROTOCOLS };

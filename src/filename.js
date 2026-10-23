'use strict';

// Export file-name template: "{title}-{date}" -> "notes-2026-10-22".
// Kept pure so the placeholder and sanitising rules are testable.

const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(date) {
  return `${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

function sanitizeName(name, fallback = 'Untitled') {
  const cleaned = String(name || '')
    .replace(INVALID, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}

function buildExportName(template, { title = 'Untitled', now = new Date() } = {}) {
  const pattern = String(template || '{title}').trim() || '{title}';
  const replaced = pattern
    .replace(/\{title\}/gi, title)
    .replace(/\{date\}/gi, formatDate(now))
    .replace(/\{time\}/gi, formatTime(now));
  return sanitizeName(replaced);
}

module.exports = { buildExportName, sanitizeName, formatDate };

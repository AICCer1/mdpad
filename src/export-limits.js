'use strict';

// Export size guard: a document with a few camera photos can produce a 30 MB docx
// without the user noticing. Warn above a threshold instead of staying silent.

const DEFAULT_WARN_BYTES = 20 * 1024 * 1024;

function isLargeExport(bytes, limit = DEFAULT_WARN_BYTES) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return false;
  return size > limit;
}

function describeSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

module.exports = { isLargeExport, describeSize, DEFAULT_WARN_BYTES };

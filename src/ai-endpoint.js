'use strict';

// Base-URL handling is where most "it never works" reports come from: people paste the host
// (https://api.deepseek.com), the versioned root (…/v1) or the full endpoint. All three should
// work, and a 404 on the bare host should retry once with /v1 appended.
function normalizeBaseUrl(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  base = base.replace(/\/chat\/completions$/i, '');
  return base;
}

function endpointFrom(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('AI endpoint is not configured');
  if (/\/chat\/completions$/i.test(String(baseUrl || '').trim())) return String(baseUrl).trim();
  return `${base}/chat/completions`;
}

// When the host has no path at all, OpenAI-compatible providers usually want /v1 in front.
function versionedEndpointFrom(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return '';
  try {
    const url = new URL(base);
    if (url.pathname === '/' || url.pathname === '') {
      return `${base}/v1/chat/completions`;
    }
  } catch {
    /* not a URL — fall through */
  }
  return '';
}

module.exports = { endpointFrom, normalizeBaseUrl, versionedEndpointFrom };

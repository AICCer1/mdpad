'use strict';

// Lists the models an OpenAI-compatible gateway exposes, so the model name can be picked
// instead of typed. Not every gateway implements /models, so callers must treat failure as
// normal and fall back to manual entry.

function modelsUrlFrom(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('AI endpoint is not configured');
  if (/\/chat\/completions$/.test(base)) return base.replace(/\/chat\/completions$/, '/models');
  return `${base}/models`;
}

function parseModels(payload) {
  const list = payload && Array.isArray(payload.data) ? payload.data : [];
  const ids = list
    .map((entry) => (entry && (entry.id || entry.name)) || null)
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function listModels({ baseUrl, apiKey, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const url = modelsUrlFrom(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`.trim());
    }
    return parseModels(await res.json());
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('listing models timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { listModels, parseModels, modelsUrlFrom };

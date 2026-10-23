'use strict';

// Minimal OpenAI-compatible chat client. Works with DeepSeek, OpenAI, Ollama,
// and any gateway that exposes POST /chat/completions.

const DEFAULT_TIMEOUT_MS = 60000;

const { endpointFrom, versionedEndpointFrom } = require('./ai-endpoint');

// Providers differ: some want /v1 in front of /chat/completions, some do not. On a 404 from a
// bare host, retry once against /v1 before reporting the failure.
async function fetchChat(url, init, { retryVersioned = true } = {}) {
  const res = await fetch(url, init);
  if (res.status === 404 && retryVersioned) {
    const fallback = versionedEndpointFrom(url.replace(/\/chat\/completions$/i, ''));
    if (fallback && fallback !== url) {
      const retryInit = { ...init, body: init.body };
      const retried = await fetch(fallback, retryInit);
      if (retried.ok) return retried;
      return retried;
    }
  }
  return res;
}

function buildMessages({ instruction, selection, context, language, history, systemPrompt }) {
  const system =
    'You are a writing assistant inside a markdown editor. ' +
    'Return only the text the user asked for: no preamble, no explanation, ' +
    'no surrounding code fences unless the requested content is code. ' +
    'Preserve markdown structure when rewriting.';
  const extra = String(systemPrompt || '').trim().slice(0, 2000);
  const messages = [
    { role: 'system', content: extra ? `${system}\n\nAdditional guidance from the user:\n${extra}` : system },
  ];

  // Earlier turns let follow-ups like "shorter" reuse the previous result.
  for (const turn of Array.isArray(history) ? history.slice(-4) : []) {
    if (turn && turn.instruction) messages.push({ role: 'user', content: String(turn.instruction).slice(0, 2000) });
    if (turn && turn.result) messages.push({ role: 'assistant', content: String(turn.result).slice(0, 6000) });
  }

  const parts = [];
  if (context) parts.push(`Document context (may be truncated):\n"""\n${context}\n"""`);
  if (selection) parts.push(`Selected text:\n"""\n${selection}\n"""`);
  parts.push(`Task: ${instruction || 'Continue writing in the same voice.'}`);
  if (language) parts.push(`Write in ${language}.`);
  messages.push({ role: 'user', content: parts.join('\n\n') });
  return messages;
}

async function complete({ baseUrl, apiKey, model, instruction, selection, context, language, history, systemPrompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = endpointFrom(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchChat(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: buildMessages({ instruction, selection, context, language, history, systemPrompt }),
        temperature: 0.4,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const text = (choice && (choice.message?.content ?? choice.text)) || '';
    const cleaned = String(text).trim();
    if (!cleaned) throw new Error('the model returned an empty response');
    return cleaned;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function completeStream({ baseUrl, apiKey, model, instruction, selection, context, language, history, systemPrompt, timeoutMs = 120000, onRetry }, onDelta, signal) {
  const url = endpointFrom(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });

  try {
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: buildMessages({ instruction, selection, context, language, history, systemPrompt }),
        temperature: 0.4,
        stream: true,
      }),
      signal: controller.signal,
    };

    // One automatic retry for transient failures (network error, 429, 5xx). Only the
    // request is retried — never a stream that already produced text.
    const MAX_ATTEMPTS = 2;
    let res = null;
    let failure = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (err.name === 'AbortError') throw new Error('request cancelled or timed out');
        failure = err;
        res = null;
      }
      if (res) {
        if (res.ok) break;
        const body = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        failure = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        res = null;
        if (!retryable) break;
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        if (typeof onRetry === 'function') {
          try {
            onRetry({ attempt: attempt + 1, reason: failure ? failure.message : 'network error' });
          } catch {
            /* a listener must not break the request */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!res) throw failure || new Error('request failed');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          const piece = delta && delta.content;
          if (piece) {
            full += piece;
            onDelta(piece);
          }
        } catch {
          /* ignore keep-alive or malformed lines */
        }
      }
    }

    const cleaned = full.trim();
    if (!cleaned) throw new Error('the model returned an empty response');
    return cleaned;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('request cancelled or timed out');
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

module.exports = { complete, completeStream, buildMessages, endpointFrom };

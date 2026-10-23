'use strict';

// Turns a raw request error into something a writer can act on.
const RULES = [
  {
    match: /401|403|unauthor|invalid.*key|api.?key/i,
    hint: 'The endpoint rejected the key. Check that the API key belongs to this provider, then test again.',
  },
  {
    match: /404|not found|unknown model|model.*(not|does not) exist/i,
    hint: 'The endpoint answered but not the way the app expects. Check the base URL path (usually ends in /v1) and the model name.',
  },
  {
    match: /429|rate limit|quota/i,
    hint: 'The provider is rate limiting or the quota is used up. Wait a moment, or pick another model.',
  },
  {
    match: /ENOTFOUND|EAI_AGAIN|getaddrinfo|name or service not known/i,
    hint: 'The host name did not resolve. Check the base URL for typos and that you are online.',
  },
  {
    match: /ECONNREFUSED|ECONNRESET|socket hang up|network/i,
    hint: 'Nothing answered at that address. For a local model, confirm the server is running (e.g. ollama serve).',
  },
  {
    match: /timeout|timed out|aborted|ETIMEDOUT|context length|too long/i,
    hint: 'The request timed out. A cold local model or a very long context can cause this; try again with a paragraph instead of the whole document.',
  },
  {
    match: /TLS|certificate|self.signed/i,
    hint: 'The TLS certificate was rejected. Use an https endpoint with a valid certificate.',
  },
];

function diagnoseAiError(message) {
  const text = String(message || '');
  for (const rule of RULES) {
    if (rule.match.test(text)) return rule.hint;
  }
  return 'No answer came back that the app could read. Confirm the endpoint speaks the OpenAI chat-completions API.';
}

module.exports = { diagnoseAiError };

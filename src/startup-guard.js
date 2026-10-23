'use strict';

// If the app died twice in a row while restoring a session, restoring it again would
// reproduce the crash. In that case the session is set aside instead of replayed.

const MAX_STARTUP_CRASHES = 2;

function decideRestore({ crashes = 0, hasSession = false } = {}) {
  if (!hasSession) return { action: 'new', reason: 'no-session' };
  if (crashes >= MAX_STARTUP_CRASHES) {
    return { action: 'skip', reason: 'crash-loop' };
  }
  return { action: 'restore', reason: 'ok' };
}

module.exports = { decideRestore, MAX_STARTUP_CRASHES };

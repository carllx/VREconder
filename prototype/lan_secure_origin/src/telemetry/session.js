/**
 * Session Identity Module (Issue #28)
 * 
 * Provides a stable session ID per page-load / client lifecycle.
 */

let activeSessionId = null;

export function generateSessionId() {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `sess_${timestamp}_${randomPart}`;
}

export function getSessionId() {
  if (!activeSessionId) {
    if (typeof sessionStorage !== 'undefined') {
      try {
        const stored = sessionStorage.getItem('vreconder_session_id');
        if (stored) {
          activeSessionId = stored;
          return activeSessionId;
        }
      } catch (_) {}
    }
    activeSessionId = generateSessionId();
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem('vreconder_session_id', activeSessionId);
      } catch (_) {}
    }
  }
  return activeSessionId;
}

export function setSessionId(id) {
  activeSessionId = id;
}

export function resetSessionId() {
  activeSessionId = null;
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem('vreconder_session_id');
    } catch (_) {}
  }
}

// TablaCognita — Session management
// Phase 1: hardcoded single session. Phase 6 adds dynamic token generation.

import { DEFAULT_SESSION_TOKEN, MAX_EVENT_QUEUE } from '../shared/protocol.js';

export class SessionManager {
  constructor() {
    // Map<sessionToken, SessionState>
    this.sessions = new Map();
  }

  // Get or create session state for a token
  getOrCreate(token = DEFAULT_SESSION_TOKEN) {
    if (!this.sessions.has(token)) {
      this.sessions.set(token, {
        token,
        editorWs: null,       // WebSocket connection to browser
        mcpConnection: null,  // MCP connection reference (for notifications)
        eventQueue: [],       // Notification queue for poll_context
        createdAt: Date.now(),
      });
    }
    return this.sessions.get(token);
  }

  // Bind a browser WebSocket to a session
  bindEditor(token, ws) {
    const session = this.getOrCreate(token);
    // If there's an existing connection, close it (I4: one browser per session)
    if (session.editorWs && session.editorWs.readyState === 1) {
      session.editorWs.close(4001, 'Replaced by new connection');
    }
    session.editorWs = ws;
    return session;
  }

  // Unbind editor WebSocket
  unbindEditor(token) {
    const session = this.sessions.get(token);
    if (session) {
      session.editorWs = null;
    }
  }

  // Check if editor is connected for a session
  hasEditor(token) {
    const session = this.sessions.get(token);
    return session?.editorWs?.readyState === 1;
  }

  // Get the editor WebSocket for a session
  getEditorWs(token) {
    const session = this.sessions.get(token);
    if (!session?.editorWs || session.editorWs.readyState !== 1) {
      return null;
    }
    return session.editorWs;
  }

  // Queue a notification event for poll_context
  queueEvent(token, event) {
    const session = this.getOrCreate(token);
    session.eventQueue.push({
      ...event,
      timestamp: new Date().toISOString(),
    });
    // FIFO eviction at max capacity
    if (session.eventQueue.length > MAX_EVENT_QUEUE) {
      session.eventQueue.shift();
    }
  }

  // Drain event queue (returns and clears)
  drainEvents(token) {
    const session = this.sessions.get(token);
    if (!session) return [];
    const events = session.eventQueue;
    session.eventQueue = [];
    return events;
  }

  // Get the default session token (Phase 1)
  getDefaultToken() {
    return DEFAULT_SESSION_TOKEN;
  }
}

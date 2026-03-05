// TablaCognita — WebSocket relay
// Bridges MCP tool calls to browser WebSocket, correlates request/response by ID.

import { WebSocketServer } from 'ws';
import {
  generateRequestId,
  ErrorCode,
  makeError,
  RELAY_TIMEOUT_MS,
  NotificationEvent,
} from '../shared/protocol.js';

export class Relay {
  constructor(sessionManager) {
    this.sessions = sessionManager;
    this.wss = null;
    // Map<requestId, { resolve, reject, timer }>
    this.pending = new Map();
  }

  // Attach WebSocket server to an HTTP server
  attach(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer });

    this.wss.on('connection', (ws, req) => {
      // Extract session token from query string: ?token=xxx
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token') || this.sessions.getDefaultToken();

      const session = this.sessions.bindEditor(token, ws);
      console.error(`[relay] Editor connected for session: ${token}`);

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          console.error('[relay] Invalid JSON from editor');
          return;
        }

        // If it has an id, it's a response to a pending request
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          resolve(msg);
          return;
        }

        // Otherwise it's a notification from the editor
        if (msg.type === 'notification' && msg.event) {
          this.sessions.queueEvent(token, {
            event: msg.event,
            data: msg.data || {},
          });
        }
      });

      ws.on('close', () => {
        console.error(`[relay] Editor disconnected for session: ${token}`);
        this.sessions.unbindEditor(token);
        // Resolve all pending requests immediately — don't make the agent wait 90s
        for (const [id, { resolve, timer }] of this.pending) {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve({
            ok: false,
            error: makeError(
              ErrorCode.NO_EDITOR_CONNECTED,
              'Browser editor disconnected during request'
            ),
          });
        }
      });

      ws.on('error', (err) => {
        console.error(`[relay] WebSocket error for session ${token}:`, err.message);
      });
    });
  }

  // Send a request to the browser editor and wait for response
  async sendRequest(token, type, params = {}) {
    const ws = this.sessions.getEditorWs(token);
    if (!ws) {
      return {
        ok: false,
        error: makeError(
          ErrorCode.NO_EDITOR_CONNECTED,
          'No browser editor connected to this session'
        ),
      };
    }

    const id = generateRequestId();
    const request = { id, type, params };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: makeError(
            ErrorCode.RELAY_TIMEOUT,
            `Editor did not respond within ${RELAY_TIMEOUT_MS}ms`
          ),
        });
      }, RELAY_TIMEOUT_MS);

      this.pending.set(id, { resolve, timer });

      try {
        ws.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          ok: false,
          error: makeError(
            ErrorCode.NO_EDITOR_CONNECTED,
            `Failed to send to editor: ${err.message}`
          ),
        });
      }
    });
  }

  // Close all connections
  close() {
    if (this.wss) {
      // Clean up pending requests
      for (const [id, { timer }] of this.pending) {
        clearTimeout(timer);
      }
      this.pending.clear();
      this.wss.close();
    }
  }
}

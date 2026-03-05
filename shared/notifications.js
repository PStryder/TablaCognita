// TablaCognita — Notification system
// Handles debouncing, filtering, and formatting of editor notifications.

import { NotificationEvent } from './protocol.js';

/**
 * Notification debouncer for cursor_moved events.
 * Collapses rapid cursor moves into at most 1 per second.
 */
export class NotificationDebouncer {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || 1000; // 1 per second for cursor_moved
    this.lastSent = new Map(); // eventType → timestamp
    this.pending = new Map();  // eventType → { data, timer }
    this.onEmit = null;        // (event, data) => void
  }

  /**
   * Submit a notification. Debounced events may be delayed.
   * Non-debounced events fire immediately.
   */
  submit(event, data) {
    if (event === NotificationEvent.CURSOR_MOVED) {
      this._debounce(event, data);
    } else {
      // All other events fire immediately (I7 / design spec)
      this._emit(event, data);
    }
  }

  _debounce(event, data) {
    const now = Date.now();
    const lastSent = this.lastSent.get(event) || 0;
    const elapsed = now - lastSent;

    if (elapsed >= this.intervalMs) {
      // Enough time has passed — send immediately
      this._emit(event, data);
      this.lastSent.set(event, now);

      // Cancel any pending timer
      const pending = this.pending.get(event);
      if (pending?.timer) {
        clearTimeout(pending.timer);
        this.pending.delete(event);
      }
    } else {
      // Too soon — schedule for later (replace any pending)
      const pending = this.pending.get(event);
      if (pending?.timer) {
        clearTimeout(pending.timer);
      }

      const delay = this.intervalMs - elapsed;
      const timer = setTimeout(() => {
        this._emit(event, data);
        this.lastSent.set(event, Date.now());
        this.pending.delete(event);
      }, delay);

      this.pending.set(event, { data, timer });
    }
  }

  _emit(event, data) {
    if (this.onEmit) {
      this.onEmit(event, data);
    }
  }

  /**
   * Clean up timers.
   */
  destroy() {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pending.clear();
    this.lastSent.clear();
  }
}

/**
 * Format a notification for the WebSocket protocol.
 */
export function formatNotification(event, data) {
  return {
    type: 'notification',
    event,
    data: {
      ...data,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Standard notification data shapes for each event type.
 */
export const NotificationSchemas = {
  [NotificationEvent.CURSOR_MOVED]: {
    required: ['section_id', 'line'],
    optional: ['column'],
  },
  [NotificationEvent.SECTION_DELETED]: {
    required: ['section_id', 'heading'],
    optional: [],
  },
  [NotificationEvent.SECTION_RENAMED]: {
    required: ['section_id', 'old_heading', 'new_heading'],
    optional: [],
  },
  [NotificationEvent.USER_SELECTION]: {
    required: ['section_id', 'selected_text'],
    optional: ['instruction'],
  },
  [NotificationEvent.DOCUMENT_CHANGED]: {
    required: ['change_type'],
    optional: ['sections_affected'],
  },
};

/**
 * Validate notification data against its schema.
 */
export function validateNotification(event, data) {
  const schema = NotificationSchemas[event];
  if (!schema) return { valid: false, error: `Unknown event type: ${event}` };

  for (const field of schema.required) {
    if (data[field] === undefined) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }
  return { valid: true };
}

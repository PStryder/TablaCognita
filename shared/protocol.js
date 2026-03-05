// TablaCognita — Shared protocol constants
// Message types, error codes, and shared constants used by relay, editor, and tests.

// WebSocket request types (relay → browser)
export const RequestType = {
  READ_DOCUMENT: 'read_document',
  GET_STRUCTURE: 'get_structure',
  GET_SECTION: 'get_section',
  REPLACE_SECTION: 'replace_section',
  REPLACE_TEXT: 'replace_text',
  INSERT_AFTER: 'insert_after',
  APPEND: 'append',
  WRITE_DOCUMENT: 'write_document',
  REQUEST_LOCK: 'request_lock',
  RELEASE_LOCK: 'release_lock',
  GET_CURSOR: 'get_cursor',
  GET_DIRTY: 'get_dirty',
  OPEN_DOCUMENT: 'open_document',
  SNAPSHOT: 'snapshot',
  GET_REVISIONS: 'get_revisions',
  RESTORE_SNAPSHOT: 'restore_snapshot',
  GET_POLL_STATE: 'get_poll_state',
};

// Notification events (browser → relay)
export const NotificationEvent = {
  CURSOR_MOVED: 'cursor_moved',
  SECTION_DELETED: 'section_deleted',
  SECTION_RENAMED: 'section_renamed',
  USER_SELECTION: 'user_selection',
  DOCUMENT_CHANGED: 'document_changed',
};

// Error codes
export const ErrorCode = {
  NO_EDITOR_CONNECTED: 'NO_EDITOR_CONNECTED',
  DOCUMENT_NOT_OPEN: 'DOCUMENT_NOT_OPEN',
  SECTION_NOT_FOUND: 'SECTION_NOT_FOUND',
  SECTION_AMBIGUOUS: 'SECTION_AMBIGUOUS',
  SECTION_LOCKED_BY_USER: 'SECTION_LOCKED_BY_USER',
  LOCK_NOT_HELD: 'LOCK_NOT_HELD',
  LOCK_EXPIRED: 'LOCK_EXPIRED',
  FUZZY_MATCH_FAILED: 'FUZZY_MATCH_FAILED',
  FUZZY_MATCH_AMBIGUOUS: 'FUZZY_MATCH_AMBIGUOUS',
  CONFIRMATION_DENIED: 'CONFIRMATION_DENIED',
  CONFIRMATION_TIMEOUT: 'CONFIRMATION_TIMEOUT',
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  SOURCE_READ_FAILED: 'SOURCE_READ_FAILED',
  SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
  DRIVE_NOT_CONNECTED: 'DRIVE_NOT_CONNECTED',
  RELAY_TIMEOUT: 'RELAY_TIMEOUT',
  INVALID_REQUEST: 'INVALID_REQUEST',
};

// MCP tool name → WebSocket request type mapping
export const ToolToRequest = {
  read_document: RequestType.READ_DOCUMENT,
  get_structure: RequestType.GET_STRUCTURE,
  get_section: RequestType.GET_SECTION,
  replace_section: RequestType.REPLACE_SECTION,
  replace_text: RequestType.REPLACE_TEXT,
  insert_after: RequestType.INSERT_AFTER,
  append: RequestType.APPEND,
  write_document: RequestType.WRITE_DOCUMENT,
  request_edit_lock: RequestType.REQUEST_LOCK,
  release_lock: RequestType.RELEASE_LOCK,
  get_cursor_context: RequestType.GET_CURSOR,
  get_dirty_regions: RequestType.GET_DIRTY,
  open_document: RequestType.OPEN_DOCUMENT,
  snapshot: RequestType.SNAPSHOT,
  get_revision_history: RequestType.GET_REVISIONS,
  restore_snapshot: RequestType.RESTORE_SNAPSHOT,
};

// Relay config
// Must be longer than CONFIRMATION_TIMEOUT_MS (60s) in editor/app.js
export const RELAY_TIMEOUT_MS = 90_000;
export const MAX_EVENT_QUEUE = 50;
export const DEFAULT_LOCK_TTL = 30;
export const MAX_LOCK_TTL = 120;
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_SESSION_TOKEN = 'dev-session';

// Helper: generate a unique request ID
let reqCounter = 0;
export function generateRequestId() {
  return `req_${Date.now().toString(36)}_${(++reqCounter).toString(36)}`;
}

// Helper: create a structured error
export function makeError(code, message, extra = {}) {
  return { code, message, ...extra };
}

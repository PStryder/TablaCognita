// TablaCognita — Editor application
// Initializes CodeMirror 6, WebSocket connection, and message dispatch.

import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';

// Shared modules (served from /shared/ static route)
import {
  parseSections, findSection, SectionRegistry,
  getSectionContent, countTopLevelSections,
} from '/shared/sections.js';
import { fuzzyReplace } from '/shared/fuzzy.js';
import { LockManager } from '/shared/locks.js';
import { NotificationDebouncer, formatNotification } from '/shared/notifications.js';
import { NotificationEvent } from '/shared/protocol.js';

// --- State ---
let view = null;
let ws = null;
let sessionToken = null;

// Section registry (stable IDs — I2)
const sectionRegistry = new SectionRegistry();
let dirtyMap = new Map(); // stableId → bool

// Lock manager
const lockManager = new LockManager();

// Notifications
const notifier = new NotificationDebouncer();
notifier.onEmit = (event, data) => {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(formatNotification(event, data)));
};

// Section diff state for detecting renames/deletes
let prevSections = []; // [{ id, heading }]
let lastCursorSectionId = null;

// Idle tracking
let lastActivityTime = Date.now();
function resetIdleTimer() { lastActivityTime = Date.now(); }
function getIdleSeconds() { return Math.floor((Date.now() - lastActivityTime) / 1000); }

// Flag to suppress notifications during agent-initiated edits
let isAgentEdit = false;

// File handle for Save (File System Access API)
let currentFileHandle = null;

// WebSocket reconnect with exponential backoff
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// Snapshot storage (IndexedDB)
const DB_NAME = 'TablaCognita';
const DB_VERSION = 1;
const SNAPSHOTS_STORE = 'snapshots';

// --- Lock Indicators (DOM-based) ---
function refreshLockIndicators() {
  if (!view) return;

  // Clear existing indicators
  view.contentDOM.querySelectorAll('.section-locked').forEach(el => {
    el.classList.remove('section-locked');
  });

  const locks = lockManager.getAll();
  if (locks.length === 0) return;

  const sections = getStableSections(getDocContent());
  for (const lock of locks) {
    const section = sections.find(s => s.id === lock.sectionId);
    if (!section) continue;
    const maxLine = view.state.doc.lines;
    for (let ln = section.line_start; ln <= Math.min(section.line_end, maxLine); ln++) {
      const pos = view.state.doc.line(ln).from;
      const { node } = view.domAtPos(pos);
      const cmLine = (node.nodeType === 1 ? node : node.parentElement)?.closest('.cm-line');
      if (cmLine) cmLine.classList.add('section-locked');
    }
  }
}

lockManager.onLockChange = () => refreshLockIndicators();

// --- Section parsing with stable IDs ---
function getStableSections(content) {
  const raw = parseSections(content);
  const stable = sectionRegistry.reconcile(raw);
  for (const sec of stable) {
    sec.dirty = dirtyMap.get(sec.id) || false;
    const lock = lockManager.getLock(sec.id);
    sec.locked = !!lock;
    sec.locked_by = lock?.owner || null;
  }
  return stable;
}

// --- Editor Setup ---
function initEditor() {
  const parent = document.getElementById('editor-pane');

  view = new EditorView({
    doc: '# Welcome to TablaCognita\n\nStart writing, or let an AI agent open a document.\n',
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
        '.cm-content': { caretColor: '#e94560' },
        '&.cm-focused .cm-cursor': { borderLeftColor: '#e94560' },
        '&.cm-focused .cm-selectionBackground, ::selection': {
          backgroundColor: 'rgba(233, 69, 96, 0.3)',
        },
        '.cm-gutters': {
          backgroundColor: '#16213e',
          color: '#555',
          border: 'none',
        },
      }, { dark: true }),
      EditorView.baseTheme({
        '&': { backgroundColor: '#1a1a2e', color: '#e0e0e0' },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          updatePreview();
          const content = update.state.doc.toString();
          const newSections = getStableSections(content);

          if (!isAgentEdit) {
            trackDirtyFromRanges(update, newSections);
            detectSectionChanges(newSections);
            notifyDocumentChanged(update, newSections);
          }

          prevSections = newSections.map(s => ({ id: s.id, heading: s.heading }));
        }
        if (update.selectionSet && !isAgentEdit) {
          detectCursorMove(update);
        }
        if (!isAgentEdit) {
          resetIdleTimer();
        }
        refreshLockIndicators();
      }),
    ],
    parent,
  });

  // Seed section registry + prevSections
  const initSections = getStableSections(getDocContent());
  prevSections = initSections.map(s => ({ id: s.id, heading: s.heading }));

  // Idle tracking from mouse/keyboard outside CM6
  document.addEventListener('mousemove', resetIdleTimer);
  document.addEventListener('keydown', resetIdleTimer);

  document.getElementById('preview-pane').style.display = 'block';
  updatePreview();
}

// --- Dirty Tracking ---
function trackDirtyFromRanges(update, sections) {
  update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const startLine = update.state.doc.lineAt(fromB).number;
    const endLine = update.state.doc.lineAt(Math.min(toB, update.state.doc.length)).number;
    for (const sec of sections) {
      if (sec.line_start <= endLine && sec.line_end >= startLine) {
        dirtyMap.set(sec.id, true);
      }
    }
  });
}

// --- Notification Detection ---
function detectSectionChanges(newSections) {
  // Detect deleted sections
  for (const old of prevSections) {
    if (!newSections.find(s => s.id === old.id)) {
      notifier.submit(NotificationEvent.SECTION_DELETED, {
        section_id: old.id,
        heading: old.heading,
      });
    }
  }
  // Detect renamed sections
  for (const sec of newSections) {
    const old = prevSections.find(s => s.id === sec.id);
    if (old && old.heading !== null && old.heading !== sec.heading) {
      notifier.submit(NotificationEvent.SECTION_RENAMED, {
        section_id: sec.id,
        old_heading: old.heading,
        new_heading: sec.heading,
      });
    }
  }
}

function notifyDocumentChanged(update, sections) {
  const affectedIds = new Set();
  update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const startLine = update.state.doc.lineAt(fromB).number;
    const endLine = update.state.doc.lineAt(Math.min(toB, update.state.doc.length)).number;
    for (const sec of sections) {
      if (sec.line_start <= endLine && sec.line_end >= startLine) {
        affectedIds.add(sec.id);
      }
    }
  });
  if (affectedIds.size > 0) {
    notifier.submit(NotificationEvent.DOCUMENT_CHANGED, {
      change_type: 'edit',
      sections_affected: [...affectedIds],
    });
  }
}

function detectCursorMove(update) {
  const cursorPos = update.state.selection.main.head;
  const line = update.state.doc.lineAt(cursorPos).number;
  const sections = getStableSections(update.state.doc.toString());
  const cursorSection = sections.find(s => s.line_start <= line && s.line_end >= line);
  const newId = cursorSection?.id || null;

  if (newId !== lastCursorSectionId) {
    lastCursorSectionId = newId;
    if (newId) {
      notifier.submit(NotificationEvent.CURSOR_MOVED, {
        section_id: newId,
        line,
      });
    }
  }
}

// --- WebSocket ---
function connectWs() {
  const url = new URL(window.location.href);
  sessionToken = url.searchParams.get('token') || 'dev-session';
  document.getElementById('session-token').textContent = `[${sessionToken}]`;

  const wsUrl = `ws://${window.location.host}?token=${encodeURIComponent(sessionToken)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('connected');
    reconnectDelay = 1000;
    console.log('[ws] Connected');
  };

  ws.onclose = () => {
    setStatus('disconnected');
    console.log(`[ws] Disconnected — reconnecting in ${reconnectDelay / 1000}s`);
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  };

  ws.onerror = (err) => {
    console.error('[ws] Error:', err);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error('[ws] Invalid JSON received');
      return;
    }

    if (msg.id && msg.type) {
      handleRequest(msg);
    }
  };
}

function setStatus(state) {
  const el = document.getElementById('connection-status');
  el.textContent = state === 'connected' ? 'Connected' : 'Disconnected';
  el.className = `status ${state}`;
}

// --- Request Dispatch ---
function handleRequest(msg) {
  const handler = requestHandlers[msg.type];
  if (!handler) {
    sendResponse(msg.id, false, null, {
      code: 'INVALID_REQUEST',
      message: `Unknown request type: ${msg.type}`,
    });
    return;
  }

  try {
    const result = handler(msg.params || {});
    if (result instanceof Promise) {
      result.then(
        (data) => sendResponse(msg.id, true, data),
        (err) => sendResponse(msg.id, false, null, err)
      );
    } else {
      sendResponse(msg.id, true, result);
    }
  } catch (err) {
    sendResponse(msg.id, false, null, {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message,
    });
  }
}

function sendResponse(id, ok, data, error) {
  if (!ws || ws.readyState !== 1) return;
  const msg = { id, ok };
  if (ok) msg.data = data;
  else msg.error = error;
  ws.send(JSON.stringify(msg));
}

function sectionNotFound(query, allSections) {
  return {
    code: 'SECTION_NOT_FOUND',
    message: `No section matching '${query}'`,
    suggestions: allSections.slice(0, 3).map(s => ({
      id: s.id, heading: s.heading, line_start: s.line_start,
    })),
  };
}

// --- Request Handlers ---
const requestHandlers = {
  read_document: () => {
    const content = getDocContent();
    return {
      content,
      total_lines: content.split('\n').length,
      sections: countTopLevelSections(content),
      has_unsaved_changes: false,
    };
  },

  get_structure: () => {
    return { sections: getStableSections(getDocContent()) };
  },

  get_section: (params) => {
    const content = getDocContent();
    const allSections = getStableSections(content);
    const section = findSection(allSections, params.section);
    if (!section) throw sectionNotFound(params.section, allSections);
    const sectionContent = getSectionContent(content, section);
    dirtyMap.set(section.id, false);
    return { ...section, content: sectionContent, dirty: false };
  },

  replace_section: (params) => {
    const content = getDocContent();
    const allSections = getStableSections(content);
    const section = findSection(allSections, params.section);
    if (!section) throw sectionNotFound(params.section, allSections);

    const lockResult = lockManager.acquireAuto(section.id);
    const lockStart = Date.now();

    const lines = content.split('\n');
    const before = lines.slice(0, section.line_start - 1);
    const after = lines.slice(section.line_end);
    let newContent;
    if (params.keep_heading) {
      const headingLine = lines[section.line_start - 1];
      newContent = [...before, headingLine, params.content, ...after].join('\n');
    } else {
      newContent = [...before, params.content, ...after].join('\n');
    }
    setDocContent(newContent);

    const newSections = getStableSections(newContent);
    const newIds = newSections.filter(s => !allSections.find(o => o.id === s.id)).map(s => s.id);

    lockManager.release(section.id);
    const lockHeldMs = Date.now() - lockStart;

    return {
      id: section.id,
      heading: section.heading,
      lines_before: section.line_end - section.line_start + 1,
      lines_after: params.content.split('\n').length + (params.keep_heading ? 1 : 0),
      new_section_ids: newIds,
      lock_held_ms: lockHeldMs,
    };
  },

  replace_text: (params) => {
    const fullContent = getDocContent();
    const opts = { ...(params.options || {}) };

    if (opts.section) {
      const allSections = getStableSections(fullContent);
      const section = findSection(allSections, opts.section);
      if (!section) throw sectionNotFound(opts.section, allSections);

      const lines = fullContent.split('\n');
      const secContent = lines.slice(section.line_start - 1, section.line_end).join('\n');
      const offset = lines.slice(0, section.line_start - 1).join('\n').length
        + (section.line_start > 1 ? 1 : 0);
      delete opts.section;

      const result = fuzzyReplace(secContent, params.search, params.replace, opts);
      if (result.error) throw result.error;

      const newFull = fullContent.slice(0, offset)
        + result.newContent
        + fullContent.slice(offset + secContent.length);
      setDocContent(newFull);
      result.data.section_id = section.id;
      result.data.line += section.line_start - 1;
      return result.data;
    }

    const result = fuzzyReplace(fullContent, params.search, params.replace, opts);
    if (result.error) throw result.error;
    setDocContent(result.newContent);
    if (result.data.line) {
      const allSections = getStableSections(fullContent);
      const sec = allSections.find(s => s.line_start <= result.data.line && s.line_end >= result.data.line);
      result.data.section_id = sec?.id || null;
    }
    return result.data;
  },

  insert_after: (params) => {
    const content = getDocContent();
    const allSections = getStableSections(content);
    const section = findSection(allSections, params.section);
    if (!section) throw sectionNotFound(params.section, allSections);

    const lines = content.split('\n');
    const before = lines.slice(0, section.line_end);
    const after = lines.slice(section.line_end);
    const newContent = [...before, params.text, ...after].join('\n');
    setDocContent(newContent);

    const newSections = getStableSections(newContent);
    const newIds = newSections.filter(s => !allSections.find(o => o.id === s.id)).map(s => s.id);
    return { inserted_at_line: section.line_end + 1, new_section_ids: newIds };
  },

  append: (params) => {
    const content = getDocContent();
    const oldSections = getStableSections(content);
    const linesBefore = content.split('\n').length;
    const newContent = content + '\n' + params.text;
    setDocContent(newContent);

    const newSections = getStableSections(newContent);
    const newIds = newSections.filter(s => !oldSections.find(o => o.id === s.id)).map(s => s.id);
    return { inserted_at_line: linesBefore + 1, new_section_ids: newIds };
  },

  write_document: (params) => {
    return showWriteConfirmation(params.content);
  },

  open_document: async (params) => {
    let content = '';
    let sourceType = 'blank';

    if (params.source) {
      const src = params.source.trim();
      if (src.startsWith('http://') || src.startsWith('https://')) {
        sourceType = 'url';
        try {
          const resp = await fetch(src);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          content = await resp.text();
        } catch (err) {
          throw { code: 'SOURCE_READ_FAILED', message: `Failed to fetch URL: ${err.message}` };
        }
      } else {
        sourceType = 'file';
        try {
          const resp = await fetch(`/api/read-file?path=${encodeURIComponent(src)}`);
          const body = await resp.json();
          if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
          content = body.content;
        } catch (err) {
          throw { code: 'SOURCE_READ_FAILED', message: `Failed to read file: ${err.message}` };
        }
      }
    }

    setDocContent(content);
    dirtyMap.clear();
    sectionRegistry.reset();
    const initSections = getStableSections(content);
    prevSections = initSections.map(s => ({ id: s.id, heading: s.heading }));
    return {
      total_lines: content.split('\n').length,
      sections: countTopLevelSections(content),
      source_type: sourceType,
      source_ref: params.source || null,
    };
  },

  snapshot: async (params) => {
    const content = getDocContent();
    const id = `snap_${Date.now().toString(36)}`;
    const snapshot = {
      id,
      label: params.label,
      content,
      sections: getStableSections(content),
      timestamp: new Date().toISOString(),
      lines: content.split('\n').length,
    };
    await saveSnapshot(snapshot);
    return { storage: 'local', snapshot_id: id, timestamp: snapshot.timestamp, lines: snapshot.lines };
  },

  get_revisions: async () => {
    const snapshots = await getSnapshots();
    return {
      revisions: snapshots.map(s => ({
        id: s.id, label: s.label, source: 'local',
        timestamp: s.timestamp, lines: s.lines,
      })),
    };
  },

  restore_snapshot: async (params) => {
    const snapshot = await getSnapshotById(params.snapshot_id);
    if (!snapshot) {
      throw { code: 'SNAPSHOT_NOT_FOUND', message: `Snapshot '${params.snapshot_id}' not found` };
    }
    const current = getDocContent();
    await saveSnapshot({
      id: `snap_${Date.now().toString(36)}`,
      label: 'Auto-save before restore',
      content: current,
      timestamp: new Date().toISOString(),
      lines: current.split('\n').length,
    });
    setDocContent(snapshot.content);
    sectionRegistry.reset();
    const initSections = getStableSections(snapshot.content);
    prevSections = initSections.map(s => ({ id: s.id, heading: s.heading }));
    return {
      accepted: true,
      lines_restored: snapshot.lines,
      label: snapshot.label,
      snapshot_timestamp: snapshot.timestamp,
    };
  },

  get_poll_state: () => {
    const cursorPos = view ? view.state.selection.main.head : 0;
    const line = view ? view.state.doc.lineAt(cursorPos).number : 1;
    const allSections = getStableSections(getDocContent());
    const cursorSection = allSections.find(s => s.line_start <= line && s.line_end >= line);
    return {
      cursor: {
        section_id: cursorSection?.id || null,
        line,
        idle_seconds: getIdleSeconds(),
      },
      dirty_count: [...dirtyMap.values()].filter(Boolean).length,
    };
  },

  request_lock: (params) => {
    const allSections = getStableSections(getDocContent());
    const section = findSection(allSections, params.section);
    if (!section) throw sectionNotFound(params.section, allSections);

    const cursorPos = view ? view.state.selection.main.head : 0;
    const cursorLine = view ? view.state.doc.lineAt(cursorPos).number : 0;
    const userInSection = cursorLine >= section.line_start && cursorLine <= section.line_end;

    const result = lockManager.acquireExplicit(section.id, params.ttl || 30);
    if (!result.ok) throw result.error;

    return {
      id: section.id,
      heading: section.heading,
      locked: true,
      ttl: result.lock.ttl,
      user_cursor_in_section: userInSection,
    };
  },

  release_lock: (params) => {
    if (params.section === 'all') {
      return { released: lockManager.releaseAll() };
    }
    return { released: lockManager.release(params.section) };
  },

  get_cursor: () => {
    if (!view) return { section_id: null, line: 1, column: 1, nearby_text: '', selection: null, idle_seconds: 0 };
    const pos = view.state.selection.main;
    const line = view.state.doc.lineAt(pos.head);
    const nearby = view.state.doc.sliceString(
      Math.max(0, pos.head - 100),
      Math.min(view.state.doc.length, pos.head + 100),
    );
    const selected = pos.from !== pos.to ? view.state.doc.sliceString(pos.from, pos.to) : null;
    const allSections = getStableSections(getDocContent());
    const cursorSection = allSections.find(s => s.line_start <= line.number && s.line_end >= line.number);
    return {
      section_id: cursorSection?.id || null,
      section_heading: cursorSection?.heading || null,
      line: line.number,
      column: pos.head - line.from + 1,
      nearby_text: nearby,
      selection: selected,
      idle_seconds: getIdleSeconds(),
    };
  },

  get_dirty: () => {
    const allSections = getStableSections(getDocContent());
    const dirtySections = allSections.filter(s => dirtyMap.get(s.id));
    return {
      dirty_sections: dirtySections.map(s => ({
        id: s.id, heading: s.heading, lines_changed: 0, last_edited: new Date().toISOString(),
      })),
      clean_sections: allSections.length - dirtySections.length,
    };
  },
};

// --- Write Document Confirmation (I6) ---
const CONFIRMATION_TIMEOUT_MS = 60_000;

function showWriteConfirmation(newContent) {
  return new Promise((resolve, reject) => {
    const oldContent = getDocContent();
    const oldLines = oldContent.split('\n').length;
    const newLines = newContent.split('\n').length;

    const overlay = document.createElement('div');
    overlay.className = 'confirmation-overlay';
    overlay.innerHTML = `
      <div class="confirmation-dialog">
        <h2>Agent requests full document replacement</h2>
        <p class="confirmation-summary">
          ${oldLines} lines \u2192 ${newLines} lines
          (${newLines > oldLines ? '+' : ''}${newLines - oldLines} lines)
        </p>
        <pre class="confirmation-diff"></pre>
        <div class="confirmation-buttons">
          <button class="btn-reject">Reject</button>
          <button class="btn-accept">Accept</button>
        </div>
      </div>
    `;

    overlay.querySelector('.confirmation-diff').textContent = newContent;

    const cleanup = () => {
      clearTimeout(timer);
      overlay.remove();
    };

    const timer = setTimeout(() => {
      cleanup();
      reject({ code: 'CONFIRMATION_TIMEOUT', message: 'User did not respond within 60s' });
    }, CONFIRMATION_TIMEOUT_MS);

    overlay.querySelector('.btn-accept').onclick = () => {
      cleanup();
      setDocContent(newContent);
      sectionRegistry.reset();
      dirtyMap.clear();
      const initSections = getStableSections(newContent);
      prevSections = initSections.map(s => ({ id: s.id, heading: s.heading }));
      resolve({
        accepted: true,
        lines_before: oldLines,
        lines_after: newLines,
        diff_summary: `+${newLines} -${oldLines} lines (full replacement)`,
      });
    };

    overlay.querySelector('.btn-reject').onclick = () => {
      cleanup();
      reject({ code: 'CONFIRMATION_DENIED', message: 'User rejected the document replacement' });
    };

    document.body.appendChild(overlay);
  });
}

// --- Document helpers ---
function getDocContent() {
  if (!view) return '';
  return view.state.doc.toString();
}

function setDocContent(content) {
  if (!view) return;
  isAgentEdit = true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
  });
  isAgentEdit = false;
  // Keep prevSections in sync after agent edits
  const newSections = getStableSections(content);
  prevSections = newSections.map(s => ({ id: s.id, heading: s.heading }));
}

// --- IndexedDB for snapshots ---
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS_STORE)) {
        db.createObjectStore(SNAPSHOTS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveSnapshot(snapshot) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOTS_STORE, 'readwrite');
    tx.objectStore(SNAPSHOTS_STORE).put(snapshot);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function getSnapshots() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOTS_STORE, 'readonly');
    const req = tx.objectStore(SNAPSHOTS_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getSnapshotById(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOTS_STORE, 'readonly');
    const req = tx.objectStore(SNAPSHOTS_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- Preview ---
let previewTimer = null;
function updatePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const previewPane = document.getElementById('preview-pane');
    if (!previewPane || !view) return;
    const content = getDocContent();
    if (typeof marked !== 'undefined') {
      const html = marked.parse(content);
      previewPane.innerHTML = typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(html)
        : html;
    } else {
      previewPane.innerHTML = '<pre>' + content.replace(/</g, '&lt;') + '</pre>';
    }
  }, 150);
}

// --- File Picker ---
function loadContent(content, filename, fileHandle) {
  setDocContent(content);
  dirtyMap.clear();
  sectionRegistry.reset();
  currentFileHandle = fileHandle || null;
  const initSections = getStableSections(content);
  prevSections = initSections.map(s => ({ id: s.id, heading: s.heading }));
  const nameEl = document.getElementById('file-name');
  nameEl.textContent = filename || '';
  document.title = filename ? `${filename} — TablaCognita` : 'TablaCognita';
}

async function saveToHandle(handle) {
  const writable = await handle.createWritable();
  await writable.write(getDocContent());
  await writable.close();
  const name = handle.name;
  document.getElementById('file-name').textContent = name;
  document.title = `${name} — TablaCognita`;
}

async function saveAs() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: currentFileHandle?.name || 'document.md',
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
    });
    currentFileHandle = handle;
    await saveToHandle(handle);
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Save failed:', e);
  }
}

async function saveFile() {
  if (!currentFileHandle) {
    await saveAs();
    return;
  }
  const overwrite = confirm(`Overwrite "${currentFileHandle.name}"?`);
  if (overwrite) {
    await saveToHandle(currentFileHandle);
  } else {
    await saveAs();
  }
}

function downloadFallback() {
  const blob = new Blob([getDocContent()], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = document.getElementById('file-name').textContent || 'document.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

function initFilePicker() {
  const openBtn = document.getElementById('open-file-btn');
  const newBtn = document.getElementById('new-doc-btn');
  const saveBtn = document.getElementById('save-file-btn');
  const input = document.getElementById('file-input');
  const hasFileSystemAccess = typeof window.showSaveFilePicker === 'function';

  newBtn.addEventListener('click', () => {
    loadContent('', null, null);
  });

  if (typeof window.showOpenFilePicker === 'function') {
    openBtn.addEventListener('click', async () => {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.txt', '.text'] } }],
          multiple: false,
        });
        const file = await handle.getFile();
        const text = await file.text();
        loadContent(text, file.name, handle);
      } catch (e) {
        if (e.name !== 'AbortError') console.error('Open failed:', e);
      }
    });
  } else {
    openBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadContent(reader.result, file.name, null);
      reader.readAsText(file);
      input.value = '';
    });
  }

  saveBtn.addEventListener('click', () => {
    if (hasFileSystemAccess) {
      saveFile();
    } else {
      downloadFallback();
    }
  });
}

// --- Resizable Split Pane ---
function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const editorPane = document.getElementById('editor-pane');
  const previewPane = document.getElementById('preview-pane');
  const workspace = document.getElementById('workspace');

  let dragging = false;

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = workspace.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const total = rect.width - handle.offsetWidth;
    const editorWidth = Math.max(100, Math.min(x, total - 100));
    editorPane.style.flex = 'none';
    editorPane.style.width = editorWidth + 'px';
    previewPane.style.flex = '1';
  });

  handle.addEventListener('pointerup', () => {
    dragging = false;
    handle.classList.remove('dragging');
  });
}

// --- Init ---
initEditor();
initFilePicker();
initResizeHandle();
connectWs();

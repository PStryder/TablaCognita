// TablaCognita — Mock browser WebSocket client
// Simulates the browser editor for automated testing.
// Connects to relay, responds to requests with canned/dynamic responses.

import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSections, findSection, SectionRegistry,
  getSectionContent, countTopLevelSections,
} from '../shared/sections.js';
import { LockManager } from '../shared/locks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class MockBrowser {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.token = options.token || 'dev-session';
    this.ws = null;
    this.connected = false;
    this.messageLog = [];

    // Document state
    this.content = options.content || readFileSync(
      join(__dirname, 'fixtures', 'sample.md'), 'utf-8'
    );
    this.sectionRegistry = new SectionRegistry();
    this.sections = [];
    this.dirtyMap = new Map();
    this.snapshots = new Map();
    this.lockManager = new LockManager();

    // Parse sections on init
    this._updateSections();
  }

  // Connect to the relay WebSocket
  connect() {
    return new Promise((resolve, reject) => {
      const url = `ws://localhost:${this.port}?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.messageLog.push({ direction: 'received', ...msg });

        // Auto-respond to requests
        if (msg.id && msg.type) {
          this._handleRequest(msg);
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
      });

      this.ws.on('error', reject);

      // Timeout
      setTimeout(() => {
        if (!this.connected) reject(new Error('Connection timeout'));
      }, 5000);
    });
  }

  // Disconnect
  disconnect() {
    this.lockManager.destroy();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  // Send a notification (browser → relay)
  sendNotification(event, data) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ type: 'notification', event, data }));
  }

  // Set document content
  setContent(content) {
    this.content = content;
    this._updateSections();
  }

  // --- Internal: parse sections with stable IDs ---
  _updateSections() {
    const raw = parseSections(this.content);
    this.sections = this.sectionRegistry.reconcile(raw);
    // Apply dirty + lock status
    for (const sec of this.sections) {
      sec.dirty = this.dirtyMap.get(sec.id) || false;
      const lock = this.lockManager.getLock(sec.id);
      sec.locked = !!lock;
      sec.locked_by = lock?.owner || null;
    }
  }

  // --- Internal: find section with structured error ---
  _findSectionOrThrow(query) {
    const section = findSection(this.sections, query);
    if (!section) {
      throw {
        code: 'SECTION_NOT_FOUND',
        message: `No section matching '${query}'`,
        suggestions: this.sections.slice(0, 3).map(s => ({
          id: s.id, heading: s.heading, line_start: s.line_start,
        })),
      };
    }
    return section;
  }

  // --- Request handlers ---
  _handleRequest(msg) {
    const handler = this._handlers[msg.type];
    if (!handler) {
      this._respond(msg.id, false, null, {
        code: 'INVALID_REQUEST',
        message: `Unknown request type: ${msg.type}`,
      });
      return;
    }

    try {
      const result = handler.call(this, msg.params || {});
      if (result instanceof Promise) {
        result.then(
          (data) => this._respond(msg.id, true, data),
          (err) => this._respond(msg.id, false, null, err)
        );
      } else {
        this._respond(msg.id, true, result);
      }
    } catch (err) {
      // Pass through full error object (including suggestions, matches, candidates)
      const errorPayload = typeof err === 'object' && err.code
        ? err
        : { code: 'ERROR', message: err.message || String(err) };
      this._respond(msg.id, false, null, errorPayload);
    }
  }

  _respond(id, ok, data, error) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const msg = { id, ok };
    if (ok) msg.data = data;
    else msg.error = error;
    this.ws.send(JSON.stringify(msg));
    this.messageLog.push({ direction: 'sent', ...msg });
  }

  _handlers = {
    read_document: function () {
      return {
        content: this.content,
        total_lines: this.content.split('\n').length,
        sections: countTopLevelSections(this.content),
        has_unsaved_changes: false,
      };
    },

    get_structure: function () {
      return { sections: this.sections };
    },

    get_section: function (params) {
      const section = this._findSectionOrThrow(params.section);
      const sectionContent = getSectionContent(this.content, section);
      this.dirtyMap.set(section.id, false);
      return { ...section, content: sectionContent, dirty: false };
    },

    replace_section: function (params) {
      const section = this._findSectionOrThrow(params.section);

      const lines = this.content.split('\n');
      const before = lines.slice(0, section.line_start - 1);
      const after = lines.slice(section.line_end);

      if (params.keep_heading) {
        const headingLine = lines[section.line_start - 1];
        this.content = [...before, headingLine, params.content, ...after].join('\n');
      } else {
        this.content = [...before, params.content, ...after].join('\n');
      }

      const oldSections = [...this.sections];
      this._updateSections();
      const newIds = this.sections.filter(s => !oldSections.find(o => o.id === s.id)).map(s => s.id);

      return {
        id: section.id,
        heading: section.heading,
        lines_before: section.line_end - section.line_start + 1,
        lines_after: params.content.split('\n').length,
        new_section_ids: newIds,
        lock_held_ms: 1,
      };
    },

    replace_text: function (params) {
      const idx = this.content.indexOf(params.search);
      if (idx === -1) {
        throw { code: 'FUZZY_MATCH_FAILED', message: `No match for '${params.search}'`, candidates: [] };
      }
      const line = this.content.slice(0, idx).split('\n').length;
      const matched = params.search;
      this.content = this.content.slice(0, idx) + params.replace + this.content.slice(idx + params.search.length);
      this._updateSections();
      const sec = this.sections.find(s => s.line_start <= line && s.line_end >= line);
      return {
        matched,
        matched_plain: matched,
        section_id: sec?.id || null,
        line,
        fuzzy_applied: false,
        markdown_stripped: false,
      };
    },

    insert_after: function (params) {
      const section = this._findSectionOrThrow(params.section);

      const lines = this.content.split('\n');
      const before = lines.slice(0, section.line_end);
      const after = lines.slice(section.line_end);
      this.content = [...before, params.text, ...after].join('\n');
      const oldSections = [...this.sections];
      this._updateSections();
      const newIds = this.sections.filter(s => !oldSections.find(o => o.id === s.id)).map(s => s.id);
      return { inserted_at_line: section.line_end + 1, new_section_ids: newIds };
    },

    append: function (params) {
      const linesBefore = this.content.split('\n').length;
      this.content += '\n' + params.text;
      const oldSections = [...this.sections];
      this._updateSections();
      const newIds = this.sections.filter(s => !oldSections.find(o => o.id === s.id)).map(s => s.id);
      return { inserted_at_line: linesBefore + 1, new_section_ids: newIds };
    },

    write_document: function (params) {
      const oldLines = this.content.split('\n').length;
      this.content = params.content;
      this.sectionRegistry.reset();
      this._updateSections();
      const newLines = this.content.split('\n').length;
      return { accepted: true, lines_before: oldLines, lines_after: newLines, diff_summary: 'Full replacement' };
    },

    open_document: function (params) {
      this.content = params.source ? `<!-- Loaded from: ${params.source} -->\n` : '';
      this.dirtyMap.clear();
      this.sectionRegistry.reset();
      this._updateSections();
      return {
        total_lines: this.content.split('\n').length,
        sections: countTopLevelSections(this.content),
        source_type: params.source ? 'file' : 'blank',
        source_ref: params.source || null,
      };
    },

    snapshot: function (params) {
      const id = `snap_${Date.now().toString(36)}`;
      this.snapshots.set(id, { id, label: params.label, content: this.content, timestamp: new Date().toISOString(), lines: this.content.split('\n').length });
      return { storage: 'local', snapshot_id: id, timestamp: new Date().toISOString(), lines: this.content.split('\n').length };
    },

    get_revisions: function () {
      return { revisions: [...this.snapshots.values()].map(s => ({ id: s.id, label: s.label, source: 'local', timestamp: s.timestamp, lines: s.lines })) };
    },

    restore_snapshot: function (params) {
      const snap = this.snapshots.get(params.snapshot_id);
      if (!snap) throw { code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot not found' };
      this.content = snap.content;
      this.sectionRegistry.reset();
      this._updateSections();
      return { accepted: true, lines_restored: snap.lines, label: snap.label, snapshot_timestamp: snap.timestamp };
    },

    get_poll_state: function () {
      return { cursor: { section_id: this.sections[0]?.id || null, line: 1, idle_seconds: 5 }, dirty_count: 0 };
    },

    request_lock: function (params) {
      const section = this._findSectionOrThrow(params.section);
      const result = this.lockManager.acquireExplicit(section.id, params.ttl || 30);
      if (!result.ok) throw result.error;
      return { id: section.id, heading: section.heading, locked: true, ttl: result.lock.ttl, user_cursor_in_section: false };
    },

    release_lock: function (params) {
      if (params.section === 'all') {
        return { released: this.lockManager.releaseAll() };
      }
      return { released: this.lockManager.release(params.section) };
    },

    get_cursor: function () {
      return { section_id: this.sections[0]?.id || null, section_heading: this.sections[0]?.heading || null, line: 1, column: 1, nearby_text: this.content.slice(0, 100), selection: null, idle_seconds: 0 };
    },

    get_dirty: function () {
      return { dirty_sections: [], clean_sections: this.sections.length };
    },
  };
}

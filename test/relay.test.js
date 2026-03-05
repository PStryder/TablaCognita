// TablaCognita — Relay round-trip tests
// Validates: MCP tool call → Relay → WebSocket → MockBrowser → WebSocket → Relay → MCP result

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { SessionManager } from '../server/sessions.js';
import { Relay } from '../server/relay.js';
import { createToolHandler } from '../server/tools.js';
import { MockBrowser } from './mock-browser.js';
import { DEFAULT_SESSION_TOKEN } from '../shared/protocol.js';

const TEST_PORT = 9876;

describe('Phase 1: Relay round-trip', () => {
  let httpServer, sessionManager, relay, handleTool, mockBrowser;

  before(async () => {
    // Set up server
    sessionManager = new SessionManager();
    relay = new Relay(sessionManager);
    const app = express();
    httpServer = http.createServer(app);
    relay.attach(httpServer);

    await new Promise((resolve) => httpServer.listen(TEST_PORT, resolve));

    // Connect mock browser
    mockBrowser = new MockBrowser({ port: TEST_PORT });
    await mockBrowser.connect();

    // Create tool handler
    handleTool = createToolHandler(relay, DEFAULT_SESSION_TOKEN);
  });

  after(async () => {
    mockBrowser.disconnect();
    relay.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('read_document returns full content', async () => {
    const result = await handleTool('read_document', {});
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.content.includes('# Introduction'));
    assert.ok(data.total_lines > 0);
    assert.equal(typeof data.sections, 'number');
    assert.equal(typeof data.has_unsaved_changes, 'boolean');
  });

  it('get_structure returns section outline', async () => {
    const result = await handleTool('get_structure', {});
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.sections));
    assert.ok(data.sections.length >= 4); // Introduction, Getting Started, Prerequisites, Features, Conclusion
    assert.equal(data.sections[0].heading, 'Introduction');
    assert.equal(data.sections[0].level, 1);
    assert.ok(data.sections[0].id.startsWith('sec_'));
  });

  it('get_section by heading returns section content', async () => {
    const result = await handleTool('get_section', { section: 'Introduction' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.heading, 'Introduction');
    assert.ok(data.content.includes('sample document'));
    assert.equal(data.dirty, false);
  });

  it('get_section by ID works', async () => {
    // Get actual stable ID from structure first
    const structResult = await handleTool('get_structure', {});
    const structData = JSON.parse(structResult.content[0].text);
    const introId = structData.sections[0].id;

    const result = await handleTool('get_section', { section: introId });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.heading, 'Introduction');
  });

  it('get_section with unknown heading returns error', async () => {
    const result = await handleTool('get_section', { section: 'NonExistent' });
    assert.equal(result.isError, true);
    const err = JSON.parse(result.content[0].text);
    assert.equal(err.error.code, 'SECTION_NOT_FOUND');
    assert.ok(Array.isArray(err.error.suggestions));
  });

  it('replace_section replaces content', async () => {
    const original = mockBrowser.content;
    const result = await handleTool('replace_section', {
      section: 'Conclusion',
      content: '## Conclusion\n\nThis has been updated by the test.',
    });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.lines_before > 0);
    assert.ok(data.lines_after > 0);
    assert.ok(mockBrowser.content.includes('updated by the test'));

    // Restore original for subsequent tests
    mockBrowser.setContent(original);
  });

  it('replace_section with keep_heading preserves heading', async () => {
    const original = mockBrowser.content;
    const result = await handleTool('replace_section', {
      section: 'Conclusion',
      content: 'New body only.',
      keep_heading: true,
    });
    const data = JSON.parse(result.content[0].text);
    assert.ok(mockBrowser.content.includes('## Conclusion'));
    assert.ok(mockBrowser.content.includes('New body only.'));

    mockBrowser.setContent(original);
  });

  it('replace_text finds and replaces', async () => {
    const original = mockBrowser.content;
    const result = await handleTool('replace_text', {
      search: 'sample document',
      replace: 'test document',
    });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.matched, 'sample document');
    assert.ok(data.line > 0);
    assert.ok(mockBrowser.content.includes('test document'));

    mockBrowser.setContent(original);
  });

  it('replace_text with no match returns error', async () => {
    const result = await handleTool('replace_text', {
      search: 'this text does not exist anywhere',
      replace: 'replacement',
    });
    assert.equal(result.isError, true);
    const err = JSON.parse(result.content[0].text);
    assert.equal(err.error.code, 'FUZZY_MATCH_FAILED');
  });

  it('insert_after adds content after section', async () => {
    const original = mockBrowser.content;
    const result = await handleTool('insert_after', {
      section: 'Introduction',
      text: '\n## Inserted Section\n\nThis was inserted.',
    });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.inserted_at_line > 0);
    assert.ok(mockBrowser.content.includes('Inserted Section'));

    mockBrowser.setContent(original);
  });

  it('append adds content at end', async () => {
    const original = mockBrowser.content;
    const result = await handleTool('append', {
      text: '\n## Appendix\n\nAppended content.',
    });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.inserted_at_line > 0);
    assert.ok(mockBrowser.content.includes('Appendix'));

    mockBrowser.setContent(original);
  });

  it('write_document replaces full document', async () => {
    const original = mockBrowser.content;
    const result = await handleTool('write_document', {
      content: '# New Document\n\nFresh start.',
    });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.accepted, true);
    assert.ok(data.lines_before > 0);
    assert.ok(data.lines_after > 0);
    assert.ok(mockBrowser.content.includes('Fresh start'));

    mockBrowser.setContent(original);
  });

  it('open_document creates blank doc', async () => {
    const original = mockBrowser.content;
    const result = await handleTool('open_document', {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.source_type, 'blank');

    mockBrowser.setContent(original);
  });

  it('snapshot and restore round-trip', async () => {
    const original = mockBrowser.content;

    // Create snapshot
    const snapResult = await handleTool('snapshot', { label: 'test-snap' });
    const snapData = JSON.parse(snapResult.content[0].text);
    assert.equal(snapData.storage, 'local');
    assert.ok(snapData.snapshot_id.startsWith('snap_'));

    // Modify content
    mockBrowser.setContent('# Modified\n\nChanged.');

    // Get revision history
    const histResult = await handleTool('get_revision_history', {});
    const histData = JSON.parse(histResult.content[0].text);
    assert.ok(histData.revisions.length >= 1);

    // Restore
    const restoreResult = await handleTool('restore_snapshot', { snapshot_id: snapData.snapshot_id });
    const restoreData = JSON.parse(restoreResult.content[0].text);
    assert.equal(restoreData.accepted, true);
    assert.ok(mockBrowser.content.includes('Introduction'));

    mockBrowser.setContent(original);
  });

  it('poll_context returns events and cursor state', async () => {
    // Queue a notification
    sessionManager.queueEvent(DEFAULT_SESSION_TOKEN, {
      event: 'cursor_moved',
      data: { section_id: 'sec_1', line: 5 },
    });

    const result = await handleTool('poll_context', {});
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.events));
    assert.ok(data.events.length >= 1);
    assert.equal(data.events[0].event, 'cursor_moved');
    assert.ok(data.cursor !== undefined);
  });

  it('request_edit_lock and release work', async () => {
    const lockResult = await handleTool('request_edit_lock', { section: 'Introduction' });
    const lockData = JSON.parse(lockResult.content[0].text);
    assert.equal(lockData.locked, true);

    // Use the actual section ID from the lock result
    const releaseResult = await handleTool('release_lock', { section: lockData.id });
    const releaseData = JSON.parse(releaseResult.content[0].text);
    assert.ok(Array.isArray(releaseData.released));
    assert.ok(releaseData.released.includes(lockData.id));
  });

  it('get_cursor_context returns position info', async () => {
    const result = await handleTool('get_cursor_context', {});
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.line >= 1);
    assert.ok(typeof data.nearby_text === 'string');
  });

  it('get_dirty_regions returns clean state', async () => {
    const result = await handleTool('get_dirty_regions', {});
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.dirty_sections));
    assert.ok(typeof data.clean_sections === 'number');
  });
});

describe('Phase 1: Error handling', () => {
  let httpServer, sessionManager, relay, handleTool;

  before(async () => {
    sessionManager = new SessionManager();
    relay = new Relay(sessionManager);
    const app = express();
    httpServer = http.createServer(app);
    relay.attach(httpServer);
    await new Promise((resolve) => httpServer.listen(TEST_PORT + 1, resolve));
    handleTool = createToolHandler(relay, DEFAULT_SESSION_TOKEN);
  });

  after(async () => {
    relay.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('returns NO_EDITOR_CONNECTED when no browser', async () => {
    const result = await handleTool('read_document', {});
    assert.equal(result.isError, true);
    const err = JSON.parse(result.content[0].text);
    assert.equal(err.error.code, 'NO_EDITOR_CONNECTED');
  });
});

describe('SessionManager', () => {
  it('creates and retrieves sessions', () => {
    const sm = new SessionManager();
    const session = sm.getOrCreate('test-token');
    assert.equal(session.token, 'test-token');
    assert.equal(session.editorWs, null);
  });

  it('queues and drains events with FIFO eviction', () => {
    const sm = new SessionManager();
    const token = 'test-token';
    sm.getOrCreate(token);

    // Queue some events
    for (let i = 0; i < 5; i++) {
      sm.queueEvent(token, { event: 'test', data: { i } });
    }

    const events = sm.drainEvents(token);
    assert.equal(events.length, 5);
    assert.equal(events[0].data.i, 0);

    // Queue should be empty after drain
    const empty = sm.drainEvents(token);
    assert.equal(empty.length, 0);
  });

  it('evicts oldest events at max capacity', () => {
    const sm = new SessionManager();
    const token = 'test-token';
    sm.getOrCreate(token);

    for (let i = 0; i < 60; i++) {
      sm.queueEvent(token, { event: 'test', data: { i } });
    }

    const events = sm.drainEvents(token);
    assert.equal(events.length, 50); // MAX_EVENT_QUEUE
    assert.equal(events[0].data.i, 10); // First 10 evicted
  });
});

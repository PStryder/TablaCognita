// TablaCognita — Notification system tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  NotificationDebouncer,
  formatNotification,
  validateNotification,
} from '../shared/notifications.js';
import { NotificationEvent } from '../shared/protocol.js';

describe('NotificationDebouncer', () => {
  let debouncer;

  beforeEach(() => {
    debouncer = new NotificationDebouncer({ intervalMs: 100 }); // Fast for testing
  });

  afterEach(() => {
    debouncer.destroy();
  });

  it('emits non-cursor events immediately', () => {
    const emitted = [];
    debouncer.onEmit = (event, data) => emitted.push({ event, data });

    debouncer.submit(NotificationEvent.SECTION_DELETED, { section_id: 'sec_1', heading: 'Test' });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'section_deleted');
  });

  it('emits first cursor_moved immediately', () => {
    const emitted = [];
    debouncer.onEmit = (event, data) => emitted.push({ event, data });

    debouncer.submit(NotificationEvent.CURSOR_MOVED, { section_id: 'sec_1', line: 5 });
    assert.equal(emitted.length, 1);
  });

  it('debounces rapid cursor_moved events', async () => {
    const emitted = [];
    debouncer.onEmit = (event, data) => emitted.push({ event, data });

    // Send 5 rapid cursor moves
    for (let i = 0; i < 5; i++) {
      debouncer.submit(NotificationEvent.CURSOR_MOVED, { section_id: 'sec_1', line: i });
    }

    // Only first should have fired immediately
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].data.line, 0);

    // Wait for debounce interval
    await new Promise(r => setTimeout(r, 150));

    // The last one should have fired after debounce
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].data.line, 4); // Last submitted value
  });

  it('allows cursor_moved after interval passes', async () => {
    const emitted = [];
    debouncer.onEmit = (event, data) => emitted.push({ event, data });

    debouncer.submit(NotificationEvent.CURSOR_MOVED, { section_id: 'sec_1', line: 1 });
    assert.equal(emitted.length, 1);

    // Wait for interval to pass
    await new Promise(r => setTimeout(r, 150));

    debouncer.submit(NotificationEvent.CURSOR_MOVED, { section_id: 'sec_2', line: 10 });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].data.line, 10);
  });

  it('does not debounce section_renamed', () => {
    const emitted = [];
    debouncer.onEmit = (event, data) => emitted.push({ event, data });

    for (let i = 0; i < 3; i++) {
      debouncer.submit(NotificationEvent.SECTION_RENAMED, {
        section_id: 'sec_1', old_heading: 'Old', new_heading: `New${i}`,
      });
    }
    assert.equal(emitted.length, 3); // All fire immediately
  });

  it('does not debounce user_selection', () => {
    const emitted = [];
    debouncer.onEmit = (event, data) => emitted.push({ event, data });

    debouncer.submit(NotificationEvent.USER_SELECTION, {
      section_id: 'sec_1', selected_text: 'hello', instruction: 'fix this',
    });
    assert.equal(emitted.length, 1);
  });

  it('cleans up on destroy', () => {
    debouncer.submit(NotificationEvent.CURSOR_MOVED, { section_id: 'sec_1', line: 1 });
    debouncer.submit(NotificationEvent.CURSOR_MOVED, { section_id: 'sec_1', line: 2 });
    debouncer.destroy();
    assert.equal(debouncer.pending.size, 0);
  });
});

describe('formatNotification', () => {
  it('creates properly formatted notification', () => {
    const notif = formatNotification(NotificationEvent.CURSOR_MOVED, {
      section_id: 'sec_1',
      line: 42,
    });

    assert.equal(notif.type, 'notification');
    assert.equal(notif.event, 'cursor_moved');
    assert.equal(notif.data.section_id, 'sec_1');
    assert.equal(notif.data.line, 42);
    assert.ok(notif.data.timestamp); // ISO-8601 timestamp added
  });
});

describe('validateNotification', () => {
  it('validates cursor_moved with required fields', () => {
    const result = validateNotification(NotificationEvent.CURSOR_MOVED, {
      section_id: 'sec_1',
      line: 5,
    });
    assert.equal(result.valid, true);
  });

  it('rejects cursor_moved missing section_id', () => {
    const result = validateNotification(NotificationEvent.CURSOR_MOVED, {
      line: 5,
    });
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('section_id'));
  });

  it('validates user_selection with required fields', () => {
    const result = validateNotification(NotificationEvent.USER_SELECTION, {
      section_id: 'sec_1',
      selected_text: 'some text',
    });
    assert.equal(result.valid, true);
  });

  it('validates section_renamed with all required fields', () => {
    const result = validateNotification(NotificationEvent.SECTION_RENAMED, {
      section_id: 'sec_1',
      old_heading: 'Old',
      new_heading: 'New',
    });
    assert.equal(result.valid, true);
  });

  it('rejects section_renamed missing new_heading', () => {
    const result = validateNotification(NotificationEvent.SECTION_RENAMED, {
      section_id: 'sec_1',
      old_heading: 'Old',
    });
    assert.equal(result.valid, false);
  });

  it('rejects unknown event type', () => {
    const result = validateNotification('unknown_event', {});
    assert.equal(result.valid, false);
  });
});

describe('Notification flow through relay', () => {
  // These tests verify that browser → relay → event queue works
  // using the mock browser and relay infrastructure

  it('browser notifications arrive in event queue via relay', async () => {
    // This is already tested in relay.test.js (poll_context test),
    // but we add an explicit integration test here
    const { SessionManager } = await import('../server/sessions.js');
    const { Relay } = await import('../server/relay.js');
    const { MockBrowser } = await import('./mock-browser.js');
    const http = await import('node:http');
    const express = (await import('express')).default;

    const sm = new SessionManager();
    const relay = new Relay(sm);
    const app = express();
    const server = http.createServer(app);
    relay.attach(server);

    const port = 9878;
    await new Promise(r => server.listen(port, r));

    const browser = new MockBrowser({ port });
    await browser.connect();

    // Browser sends a notification
    browser.sendNotification('cursor_moved', { section_id: 'sec_1', line: 10 });

    // Small delay for message processing
    await new Promise(r => setTimeout(r, 50));

    // Check event queue
    const events = sm.drainEvents('dev-session');
    assert.ok(events.length >= 1, `Expected events, got ${events.length}`);
    assert.equal(events[0].event, 'cursor_moved');
    assert.equal(events[0].data.section_id, 'sec_1');

    browser.disconnect();
    relay.close();
    await new Promise(r => server.close(r));
  });

  it('multiple notification types queue correctly', async () => {
    const { SessionManager } = await import('../server/sessions.js');
    const { Relay } = await import('../server/relay.js');
    const { MockBrowser } = await import('./mock-browser.js');
    const http = await import('node:http');
    const express = (await import('express')).default;

    const sm = new SessionManager();
    const relay = new Relay(sm);
    const app = express();
    const server = http.createServer(app);
    relay.attach(server);

    const port = 9879;
    await new Promise(r => server.listen(port, r));

    const browser = new MockBrowser({ port });
    await browser.connect();

    // Send different notification types
    browser.sendNotification('cursor_moved', { section_id: 'sec_1', line: 1 });
    browser.sendNotification('section_deleted', { section_id: 'sec_2', heading: 'Removed' });
    browser.sendNotification('user_selection', {
      section_id: 'sec_1', selected_text: 'Fix this', instruction: 'Make it better',
    });

    await new Promise(r => setTimeout(r, 50));

    const events = sm.drainEvents('dev-session');
    assert.equal(events.length, 3);
    assert.equal(events[0].event, 'cursor_moved');
    assert.equal(events[1].event, 'section_deleted');
    assert.equal(events[2].event, 'user_selection');

    browser.disconnect();
    relay.close();
    await new Promise(r => server.close(r));
  });
});

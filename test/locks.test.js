// TablaCognita — Lock state machine unit tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LockManager, LockState } from '../shared/locks.js';

describe('LockState', () => {
  it('tracks expiration correctly', () => {
    const lock = new LockState('sec_1', 'explicit', 'agent', 30);
    assert.equal(lock.expired(), false);
    assert.ok(lock.remainingMs() > 29000);
    assert.ok(lock.remainingMs() <= 30000);
  });

  it('serializes to JSON', () => {
    const lock = new LockState('sec_1', 'explicit', 'agent', 30);
    const json = lock.toJSON();
    assert.equal(json.sectionId, 'sec_1');
    assert.equal(json.type, 'explicit');
    assert.equal(json.owner, 'agent');
    assert.equal(json.ttl, 30);
    assert.ok(json.remainingMs > 0);
  });
});

describe('LockManager — Explicit locks', () => {
  let lm;

  beforeEach(() => {
    lm = new LockManager();
  });

  afterEach(() => {
    lm.destroy();
  });

  it('acquires an explicit lock', () => {
    const result = lm.acquireExplicit('sec_1', 30, 'agent');
    assert.equal(result.ok, true);
    assert.equal(result.lock.sectionId, 'sec_1');
    assert.equal(result.lock.type, 'explicit');
    assert.equal(lm.isLocked('sec_1'), true);
  });

  it('clamps TTL to MAX_LOCK_TTL', () => {
    const result = lm.acquireExplicit('sec_1', 999, 'agent');
    assert.equal(result.ok, true);
    assert.equal(result.lock.ttl, 120); // MAX_LOCK_TTL
  });

  it('rejects lock when section locked by user', () => {
    // Simulate user lock
    lm.acquireExplicit('sec_1', 30, 'user');
    const result = lm.acquireExplicit('sec_1', 30, 'agent');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SECTION_LOCKED_BY_USER');
  });

  it('allows re-lock by same owner', () => {
    lm.acquireExplicit('sec_1', 30, 'agent');
    const result = lm.acquireExplicit('sec_1', 60, 'agent');
    assert.equal(result.ok, true);
    assert.equal(result.lock.ttl, 60);
  });

  it('clears expired lock and allows new acquisition', async () => {
    const result1 = lm.acquireExplicit('sec_1', 1, 'user'); // 1 second TTL
    assert.equal(result1.ok, true);

    // Wait for expiry
    await new Promise(r => setTimeout(r, 1100));

    const result2 = lm.acquireExplicit('sec_1', 30, 'agent');
    assert.equal(result2.ok, true);
  });

  it('fires onLockChange callback', () => {
    const changes = [];
    lm.onLockChange = (sectionId, lockState) => {
      changes.push({ sectionId, locked: !!lockState });
    };

    lm.acquireExplicit('sec_1', 30, 'agent');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].sectionId, 'sec_1');
    assert.equal(changes[0].locked, true);
  });
});

describe('LockManager — Auto locks', () => {
  let lm;

  beforeEach(() => {
    lm = new LockManager();
  });

  afterEach(() => {
    lm.destroy();
  });

  it('acquires an auto lock', () => {
    const result = lm.acquireAuto('sec_1', 'agent');
    assert.equal(result.ok, true);
    assert.equal(result.lock.type, 'auto');
    assert.equal(result.lock.ttl, 5);
  });

  it('auto-lock does not conflict with user cursor (no explicit user lock)', () => {
    // No existing lock — should succeed
    const result = lm.acquireAuto('sec_1', 'agent');
    assert.equal(result.ok, true);
  });

  it('auto-lock fails when explicit user lock exists', () => {
    lm.acquireExplicit('sec_1', 30, 'user');
    const result = lm.acquireAuto('sec_1', 'agent');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SECTION_LOCKED_BY_USER');
  });
});

describe('LockManager — Release', () => {
  let lm;

  beforeEach(() => {
    lm = new LockManager();
  });

  afterEach(() => {
    lm.destroy();
  });

  it('releases a lock by section ID', () => {
    lm.acquireExplicit('sec_1', 30, 'agent');
    const released = lm.release('sec_1', 'agent');
    assert.deepEqual(released, ['sec_1']);
    assert.equal(lm.isLocked('sec_1'), false);
  });

  it('releases all locks', () => {
    lm.acquireExplicit('sec_1', 30, 'agent');
    lm.acquireExplicit('sec_2', 30, 'agent');
    const released = lm.release('all', 'agent');
    assert.ok(released.includes('sec_1'));
    assert.ok(released.includes('sec_2'));
    assert.equal(lm.getAll().length, 0);
  });

  it('does not release another owner\'s lock', () => {
    lm.acquireExplicit('sec_1', 30, 'user');
    const released = lm.release('sec_1', 'agent');
    assert.deepEqual(released, []);
    assert.equal(lm.isLocked('sec_1'), true);
  });

  it('returns empty array for non-existent lock', () => {
    const released = lm.release('sec_999', 'agent');
    assert.deepEqual(released, []);
  });

  it('fires onLockChange on release', () => {
    const changes = [];
    lm.onLockChange = (sectionId, lockState) => {
      changes.push({ sectionId, locked: !!lockState });
    };

    lm.acquireExplicit('sec_1', 30, 'agent');
    lm.release('sec_1', 'agent');

    assert.equal(changes.length, 2);
    assert.equal(changes[1].sectionId, 'sec_1');
    assert.equal(changes[1].locked, false);
  });
});

describe('LockManager — TTL expiration', () => {
  let lm;

  beforeEach(() => {
    lm = new LockManager();
  });

  afterEach(() => {
    lm.destroy();
  });

  it('auto-releases on TTL expiry', async () => {
    lm.acquireExplicit('sec_1', 1, 'agent'); // 1 second
    assert.equal(lm.isLocked('sec_1'), true);

    await new Promise(r => setTimeout(r, 1100));
    assert.equal(lm.isLocked('sec_1'), false);
  });

  it('getLock returns null for expired lock', async () => {
    lm.acquireExplicit('sec_1', 1, 'agent');
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(lm.getLock('sec_1'), null);
  });
});

describe('LockManager — getAll', () => {
  let lm;

  beforeEach(() => {
    lm = new LockManager();
  });

  afterEach(() => {
    lm.destroy();
  });

  it('returns all active locks', () => {
    lm.acquireExplicit('sec_1', 30, 'agent');
    lm.acquireExplicit('sec_2', 30, 'agent');
    const all = lm.getAll();
    assert.equal(all.length, 2);
  });

  it('filters out expired locks', async () => {
    lm.acquireExplicit('sec_1', 1, 'agent');
    lm.acquireExplicit('sec_2', 30, 'agent');

    await new Promise(r => setTimeout(r, 1100));

    const all = lm.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].sectionId, 'sec_2');
  });
});

describe('LockManager — destroy', () => {
  it('clears all locks and timers', () => {
    const lm = new LockManager();
    lm.acquireExplicit('sec_1', 30, 'agent');
    lm.acquireExplicit('sec_2', 30, 'agent');
    lm.destroy();
    assert.equal(lm.locks.size, 0);
  });
});

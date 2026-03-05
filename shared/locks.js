// TablaCognita — Lock state machine
// Manages section locks with TTL, auto-lock for edits, and explicit locks for multi-step operations.
// Shared between editor and mock browser for testing.

import { DEFAULT_LOCK_TTL, MAX_LOCK_TTL } from './protocol.js';

/**
 * Lock types:
 * - 'auto': Brief lock during a single edit operation (no sustained UI indicator)
 * - 'explicit': Agent-requested lock with TTL (shows sustained UI indicator)
 */

export class LockManager {
  constructor() {
    // Map<sectionId, LockState>
    this.locks = new Map();
    // Callbacks
    this.onLockChange = null; // (sectionId, lockState | null) => void
  }

  /**
   * Acquire an explicit lock on a section.
   * @param {string} sectionId
   * @param {number} ttl - TTL in seconds (clamped to MAX_LOCK_TTL)
   * @param {string} owner - 'agent' or agent identifier
   * @returns {{ ok: boolean, lock?: LockState, error?: object }}
   */
  acquireExplicit(sectionId, ttl = DEFAULT_LOCK_TTL, owner = 'agent') {
    const existing = this.locks.get(sectionId);

    // Check if locked by user
    if (existing && existing.owner === 'user' && !existing.expired()) {
      return {
        ok: false,
        error: { code: 'SECTION_LOCKED_BY_USER', message: 'User declined to yield the section' },
      };
    }

    // Clear any expired lock
    if (existing && existing.expired()) {
      this._releaseLock(sectionId);
    }

    // Check if already locked by another agent
    if (existing && existing.owner !== owner && !existing.expired()) {
      return {
        ok: false,
        error: { code: 'SECTION_LOCKED', message: `Section locked by ${existing.owner}` },
      };
    }

    const clampedTtl = Math.min(Math.max(1, ttl), MAX_LOCK_TTL);
    const lock = new LockState(sectionId, 'explicit', owner, clampedTtl);
    this.locks.set(sectionId, lock);

    // Set TTL timer
    lock._timer = setTimeout(() => {
      this._releaseLock(sectionId);
    }, clampedTtl * 1000);

    this._notifyChange(sectionId, lock);
    return { ok: true, lock };
  }

  /**
   * Acquire an auto-lock (brief, during edit operation).
   * Auto-locks don't conflict with user cursor — they're too brief (I8).
   * @param {string} sectionId
   * @param {string} owner
   * @returns {{ ok: boolean, lock?: LockState }}
   */
  acquireAuto(sectionId, owner = 'agent') {
    const existing = this.locks.get(sectionId);

    // Auto-locks can proceed even if user cursor is in section (I8/design conditional)
    // Only block if there's an explicit user lock
    if (existing && existing.owner === 'user' && existing.type === 'explicit' && !existing.expired()) {
      return {
        ok: false,
        error: { code: 'SECTION_LOCKED_BY_USER', message: 'Section has explicit user lock' },
      };
    }

    const lock = new LockState(sectionId, 'auto', owner, 5); // 5s max for auto-locks
    this.locks.set(sectionId, lock);

    lock._timer = setTimeout(() => {
      this._releaseLock(sectionId);
    }, 5000);

    return { ok: true, lock };
  }

  /**
   * Release a lock.
   * @param {string} sectionId - Section ID or 'all'
   * @returns {string[]} List of released section IDs
   */
  release(sectionId, owner = 'agent') {
    if (sectionId === 'all') {
      return this.releaseAll(owner);
    }

    const existing = this.locks.get(sectionId);
    if (!existing) {
      return []; // LOCK_NOT_HELD — not fatal
    }

    // Only release if owner matches (or if expired)
    if (existing.owner !== owner && !existing.expired()) {
      return [];
    }

    this._releaseLock(sectionId);
    return [sectionId];
  }

  /**
   * Release all locks held by an owner.
   */
  releaseAll(owner = 'agent') {
    const released = [];
    for (const [sectionId, lock] of this.locks) {
      if (lock.owner === owner || lock.expired()) {
        this._releaseLock(sectionId);
        released.push(sectionId);
      }
    }
    return released;
  }

  /**
   * Check if a section is locked.
   */
  isLocked(sectionId) {
    const lock = this.locks.get(sectionId);
    if (!lock) return false;
    if (lock.expired()) {
      this._releaseLock(sectionId);
      return false;
    }
    return true;
  }

  /**
   * Get lock state for a section.
   */
  getLock(sectionId) {
    const lock = this.locks.get(sectionId);
    if (!lock) return null;
    if (lock.expired()) {
      this._releaseLock(sectionId);
      return null;
    }
    return lock;
  }

  /**
   * Get all active locks.
   */
  getAll() {
    const result = [];
    for (const [sectionId, lock] of this.locks) {
      if (lock.expired()) {
        this._releaseLock(sectionId);
      } else {
        result.push(lock);
      }
    }
    return result;
  }

  /**
   * Internal: release lock and clean up timer.
   */
  _releaseLock(sectionId) {
    const lock = this.locks.get(sectionId);
    if (lock?._timer) {
      clearTimeout(lock._timer);
    }
    this.locks.delete(sectionId);
    this._notifyChange(sectionId, null);
  }

  _notifyChange(sectionId, lockState) {
    if (this.onLockChange) {
      this.onLockChange(sectionId, lockState);
    }
  }

  /**
   * Clean up all timers.
   */
  destroy() {
    for (const [, lock] of this.locks) {
      if (lock._timer) clearTimeout(lock._timer);
    }
    this.locks.clear();
  }
}

export class LockState {
  constructor(sectionId, type, owner, ttlSeconds) {
    this.sectionId = sectionId;
    this.type = type;       // 'auto' | 'explicit'
    this.owner = owner;     // 'agent' | 'user' | specific identifier
    this.ttl = ttlSeconds;
    this.acquiredAt = Date.now();
    this.expiresAt = Date.now() + (ttlSeconds * 1000);
    this._timer = null;     // TTL timeout handle
  }

  expired() {
    return Date.now() >= this.expiresAt;
  }

  remainingMs() {
    return Math.max(0, this.expiresAt - Date.now());
  }

  toJSON() {
    return {
      sectionId: this.sectionId,
      type: this.type,
      owner: this.owner,
      ttl: this.ttl,
      acquiredAt: this.acquiredAt,
      expiresAt: this.expiresAt,
      remainingMs: this.remainingMs(),
    };
  }
}

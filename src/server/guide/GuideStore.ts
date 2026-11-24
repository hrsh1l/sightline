/**
 * Memory-only guide store: resumeKey -> GuideMachine, so a socket reconnect from the SAME open page (it sends back
 * the key from `ready`) re-attaches guide progress. Nothing is persisted to disk; a server restart or page reload
 * loses it (the client then reports the loss honestly). Mutations are never replayed: the machine itself is kept.
 *
 * TTL counts from the last time the entry was touched or released; attached entries never expire or get evicted.
 */
import { randomBytes } from 'node:crypto';
import { GUIDE_LIMITS } from '../../shared/guide.js';
import { GuideMachine, type GuideMachineOptions } from './GuideMachine.js';

export interface GuideStoreOptions {
  ttlMs?: number;
  /** Max entries kept (oldest detached entries evicted first). */
  cap?: number;
  now?: () => number;
  newKey?: () => string;
  machine?: GuideMachineOptions;
}

interface Entry {
  machine: GuideMachine;
  lastSeen: number;
  /** Session currently attached, or null when detached (waiting for a reconnect). */
  owner: string | null;
}

/** 24 random bytes -> 32 base64url chars (matches hello.resumeKey: [A-Za-z0-9_-], 16..64). */
export const newResumeKey = () => randomBytes(24).toString('base64url');

export class GuideStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly now: () => number;
  private readonly newKey: () => string;
  private readonly machineOpts: GuideMachineOptions;

  constructor(opts: GuideStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? GUIDE_LIMITS.resumeTtlMs;
    this.cap = opts.cap ?? 32;
    this.now = opts.now ?? Date.now;
    this.newKey = opts.newKey ?? newResumeKey;
    this.machineOpts = opts.machine ?? {};
  }

  get size(): number {
    return this.entries.size;
  }

  /** New entry owned by `owner`. */
  create(owner: string): { key: string; machine: GuideMachine } {
    this.sweep();
    let key = this.newKey();
    while (this.entries.has(key)) key = this.newKey();
    const machine = new GuideMachine(this.machineOpts);
    this.entries.set(key, { machine, lastSeen: this.now(), owner });
    this.evict();
    return { key, machine };
  }

  /** Re-attach a known, unexpired key (ownership moves to `owner`). Unknown/expired -> null. */
  attach(key: string, owner: string): GuideMachine | null {
    this.sweep();
    const e = this.entries.get(key);
    if (!e) return null;
    e.owner = owner;
    e.lastSeen = this.now();
    return e.machine;
  }

  isOwner(key: string, owner: string): boolean {
    return this.entries.get(key)?.owner === owner;
  }

  touch(key: string) {
    const e = this.entries.get(key);
    if (e) e.lastSeen = this.now();
  }

  /** Socket gone: keep the entry until TTL so a reconnect can restore it. No-op if another session took over. */
  release(key: string, owner: string) {
    const e = this.entries.get(key);
    if (!e || e.owner !== owner) return;
    e.owner = null;
    e.lastSeen = this.now();
  }

  /** Explicit end of session (bye): forget it now. Only the owner may delete. */
  delete(key: string, owner: string) {
    const e = this.entries.get(key);
    if (e && (e.owner === owner || e.owner === null)) this.entries.delete(key);
  }

  sweep() {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.owner === null && now - e.lastSeen > this.ttlMs) this.entries.delete(k);
  }

  private evict() {
    if (this.entries.size <= this.cap) return;
    const detached = [...this.entries].filter(([, e]) => e.owner === null).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [k] of detached) {
      if (this.entries.size <= this.cap) break;
      this.entries.delete(k);
    }
  }
}

/** Process-wide store used by ClientSession (tests inject their own). */
export const defaultGuideStore = new GuideStore();

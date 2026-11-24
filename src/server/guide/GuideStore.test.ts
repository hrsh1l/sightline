import { describe, expect, it } from 'vitest';
import { ClientHello } from '../../shared/protocol.js';
import { GUIDE_LIMITS } from '../../shared/guide.js';
import { GuideStore, newResumeKey } from './GuideStore.js';

function store(over: { cap?: number } = {}) {
  let now = 1_000;
  const s = new GuideStore({ now: () => now, ...over });
  return { s, advance: (ms: number) => (now += ms) };
}

describe('GuideStore', () => {
  it('issues random 32-character keys accepted by hello.resumeKey', () => {
    const a = newResumeKey();
    const b = newResumeKey();
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(ClientHello.shape.resumeKey.safeParse(a).success).toBe(true);
  });

  it('re-attaches the same machine within the TTL after release; never after expiry', () => {
    const { s, advance } = store();
    const { key, machine } = s.create('sess-1');
    machine.start('cooking');
    s.release(key, 'sess-1');
    advance(GUIDE_LIMITS.resumeTtlMs - 1);
    expect(s.attach(key, 'sess-2')).toBe(machine);
    s.release(key, 'sess-2');
    advance(GUIDE_LIMITS.resumeTtlMs + 1);
    expect(s.attach(key, 'sess-3')).toBeNull();
    expect(s.size).toBe(0);
  });

  it('attached entries never expire; unknown keys return null', () => {
    const { s, advance } = store();
    const { key } = s.create('sess-1');
    advance(GUIDE_LIMITS.resumeTtlMs * 3);
    s.sweep();
    expect(s.size).toBe(1);
    expect(s.attach('x'.repeat(32), 'sess-2')).toBeNull();
    expect(s.isOwner(key, 'sess-1')).toBe(true);
  });

  it('ownership moves on attach; the old session can no longer release or delete it', () => {
    const { s, advance } = store();
    const { key } = s.create('old');
    s.attach(key, 'new');
    s.release(key, 'old');
    s.delete(key, 'old');
    expect(s.isOwner(key, 'new')).toBe(true);
    advance(GUIDE_LIMITS.resumeTtlMs * 2);
    s.sweep();
    expect(s.size).toBe(1);
    s.delete(key, 'new');
    expect(s.size).toBe(0);
  });

  it('evicts the oldest detached entries beyond the cap, never attached ones', () => {
    const { s, advance } = store({ cap: 2 });
    const a = s.create('a');
    s.release(a.key, 'a');
    advance(10);
    const b = s.create('b');
    advance(10);
    s.create('c');
    expect(s.size).toBe(2);
    expect(s.attach(a.key, 'x')).toBeNull();
    expect(s.isOwner(b.key, 'b')).toBe(true);
  });
});

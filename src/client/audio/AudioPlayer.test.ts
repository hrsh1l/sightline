import { describe, expect, it, vi } from 'vitest';
import { createAudioPlayer } from './AudioPlayer.js';
import { encodePcm16Base64 } from './pcm.js';

/** FIXTURE: minimal fake AudioContext recording scheduled sources. */
function createFakeContext() {
  const sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; startAt?: number; onended: (() => void) | null; stopped: boolean }[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const ctx = {
    currentTime: 0,
    state: 'suspended' as AudioContextState,
    outputLatency: 0,
    destination: {},
    resume: vi.fn(() => {
      ctx.state = 'running';
      for (const l of listeners.statechange ?? []) l();
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      ctx.state = 'closed';
      return Promise.resolve();
    }),
    addEventListener: (type: string, l: () => void) => {
      (listeners[type] ??= []).push(l);
    },
    createBuffer: (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const src = {
        buffer: null as unknown,
        onended: null as (() => void) | null,
        stopped: false,
        startAt: undefined as number | undefined,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn((t: number) => {
          src.startAt = t;
        }),
        stop: vi.fn(() => {
          src.stopped = true;
        }),
      };
      sources.push(src);
      return src;
    },
  };
  return { ctx, sources };
}

const chunk = (samples: number) => encodePcm16Base64(new Float32Array(samples).fill(0.1));

function setup(opts: { maxScheduledSec?: number } = {}) {
  const fake = createFakeContext();
  let perf = 1_000;
  const player = createAudioPlayer({
    createContext: () => fake.ctx as unknown as AudioContext,
    perfNow: () => perf,
    ...opts,
  });
  return { ...fake, player, setPerf: (p: number) => (perf = p) };
}

describe('AudioPlayer', () => {
  it('unlock creates and resumes the context synchronously', () => {
    const { ctx, player } = setup();
    void player.unlock();
    expect(ctx.resume).toHaveBeenCalledTimes(1); // called before any await
    expect(player.getState().contextState).toBe('running');
  });

  it('schedules chunks gap-free with a small lead and restarts the cursor when behind', async () => {
    const { ctx, sources, player } = setup();
    await player.unlock();
    ctx.currentTime = 10;
    player.enqueue(1, chunk(2400)); // 0.1 s
    player.enqueue(1, chunk(1200)); // 0.05 s
    expect(sources[0]!.startAt).toBeCloseTo(10.05, 6);
    expect(sources[1]!.startAt).toBeCloseTo(10.15, 6);
    expect(player.getState()).toMatchObject({ playing: true, turnId: 1 });
    ctx.currentTime = 20; // fell behind
    player.enqueue(1, chunk(240));
    expect(sources[2]!.startAt).toBeCloseTo(20.05, 6);
  });

  it('flush stops all scheduled sources and rejects late chunks of the flushed turn', async () => {
    const { sources, player } = setup();
    await player.unlock();
    player.enqueue(3, chunk(2400));
    player.enqueue(3, chunk(2400));
    player.flush(3);
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(player.getState().playing).toBe(false);
    player.enqueue(3, chunk(2400));
    player.enqueue(2, chunk(2400));
    expect(sources).toHaveLength(2);
    expect(player.rejectedChunks).toBe(2);
    player.enqueue(4, chunk(2400));
    expect(sources).toHaveLength(3);
  });

  it('flush() without a turn stops audio but still accepts the same turn', async () => {
    const { sources, player } = setup();
    await player.unlock();
    player.enqueue(1, chunk(240));
    player.flush();
    player.enqueue(1, chunk(240));
    expect(sources).toHaveLength(2);
  });

  it('fires onTurnAudible once per turn at the scheduled start (performance.now clock)', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    const cb = vi.fn();
    player.onTurnAudible(cb);
    ctx.currentTime = 5;
    player.enqueue(1, chunk(2400));
    player.enqueue(1, chunk(2400));
    player.enqueue(2, chunk(2400));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0]![0]).toBe(1);
    expect(cb.mock.calls[0]![1]).toBeCloseTo(1_050, 6);
    expect(cb.mock.calls[1]![0]).toBe(2);
    expect(cb.mock.calls[1]![1]).toBeCloseTo(1_250, 6);
  });

  it('bounds scheduled audio and counts overflow', async () => {
    const { sources, player } = setup({ maxScheduledSec: 0.25 });
    await player.unlock();
    for (let i = 0; i < 5; i++) player.enqueue(1, chunk(2400)); // 0.1 s each
    expect(sources).toHaveLength(2);
    expect(player.overflowDropped).toBe(3);
  });

  it('drops chunks before unlock and updates playing when sources end', async () => {
    const { sources, player } = setup();
    player.enqueue(1, chunk(240));
    expect(sources).toHaveLength(0);
    await player.unlock();
    player.enqueue(1, chunk(240));
    sources[0]!.onended?.();
    expect(player.getState()).toMatchObject({ playing: false, turnId: null });
  });
});

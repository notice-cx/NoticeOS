import { describe, expect, it, vi } from 'vitest';
import { createTestTimeoutSignals } from './timeout-signals';

/** A quick mock still receives the real deadline the collector requested. */
const reply = async (signal: AbortSignal) => ({ aborted: signal.aborted, reason: signal.reason });

describe('provider deadlines belong to their test', () => {
  // More than the Worker's active quota across tests, never within one test.
  // With native request-scoped deadlines these finished calls exhaust it.
  for (let batch = 0; batch < 12; batch += 1) {
    it(`retires the deadlines of 1,000 completed calls (batch ${batch + 1})`, async () => {
      const calls = Array.from({ length: 1_000 }, () => reply(AbortSignal.timeout(60_000)));
      expect(await Promise.all(calls)).toEqual(Array.from({ length: 1_000 }, () => ({ aborted: false, reason: undefined })));
    });
  }

  it('fires a real deadline with the native TimeoutError reason', async () => {
    const signal = AbortSignal.timeout(0);
    expect(signal.aborted).toBe(false);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason).toMatchObject({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' });
    expect(() => signal.throwIfAborted()).toThrow(signal.reason);
  });

  it('uses real deadlines even while a test advances a fake clock', async () => {
    const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const signals = createTestTimeoutSignals(real);
    await signals.run(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const later = signals.timeout(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(later.aborted).toBe(false);
        const now = signals.timeout(0);
        await new Promise<void>((resolve) => now.addEventListener('abort', () => resolve(), { once: true }));
        expect(now.reason.name).toBe('TimeoutError');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('delegates outside its scope and keeps a parent deadline while a child ends', async () => {
    const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const native = vi.fn(AbortSignal.timeout);
    const signals = createTestTimeoutSignals(real, native);
    const outside = signals.timeout(0);
    expect(native).toHaveBeenCalledExactlyOnceWith(0);
    await new Promise<void>((resolve) => outside.addEventListener('abort', () => resolve(), { once: true }));
    await signals.run(async () => {
      const parent = signals.timeout(0);
      await signals.run(async () => { signals.timeout(60_000); });
      await new Promise<void>((resolve) => parent.addEventListener('abort', () => resolve(), { once: true }));
      expect(parent.reason.name).toBe('TimeoutError');
    });
  });

  it('retires deadlines when work rejects and refuses an ended scope', async () => {
    const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const signals = createTestTimeoutSignals(real);
    let release!: () => void;
    let late!: Promise<AbortSignal>;
    await expect(signals.run(async () => {
      for (let index = 0; index < 1_000; index += 1) signals.timeout(60_000);
      // A promise continuation retains its owner's async context after return.
      late = new Promise<void>((resolve) => { release = resolve; }).then(() => signals.timeout(0));
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');
    const refused = expect(late).rejects.toThrow('timeout signal requested after its test ended');
    release();
    await refused;
    await signals.run(async () => {
      for (let index = 0; index < 9_500; index += 1) signals.timeout(60_000);
    });
  });
});

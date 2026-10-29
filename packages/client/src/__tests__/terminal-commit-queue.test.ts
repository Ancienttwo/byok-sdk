import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_COMMIT_RETRY_BASE_MS, TerminalCommitQueue } from '../daemon/terminal-commit-queue';

describe('terminal commit receipts', () => {
  it('retains the first exact commit after failure while other tasks progress', async () => {
    const committed: string[] = [];
    const queue = new TerminalCommitQueue(id => committed.push(id));
    let unavailable = true;
    const write = vi.fn(async () => { if (unavailable) throw new Error('EIO'); });
    const replacement = vi.fn(async () => {});
    queue.enqueue('a', write);
    await expect(queue.receipt('a')).rejects.toThrow('EIO');
    queue.enqueue('b', async () => {});
    await queue.receipt('b');
    expect(committed).toEqual(['b']);
    expect(queue.pendingCount).toBe(1);
    unavailable = false;
    queue.enqueue('a', replacement);
    await queue.receipt('a');
    expect(replacement).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(2);
    expect(committed).toEqual(['b', 'a']);
    expect(queue.pendingCount).toBe(0);
    await queue.stop();
  });

  it('permanent failure rejects stop and retains recovery state', async () => {
    const queue = new TerminalCommitQueue(() => {});
    queue.enqueue('a', async () => { throw new Error('ENOSPC'); });
    await expect(queue.receipt('a')).rejects.toThrow('ENOSPC');
    await expect(queue.stop()).rejects.toThrow('ENOSPC');
    expect(queue.pendingCount).toBe(1);
  });

  it('backs automatic retries off exponentially to a ceiling and restarts after a success', async () => {
    vi.useFakeTimers();
    try {
      const queue = new TerminalCommitQueue(() => {});
      let failing = true;
      const write = vi.fn(async () => { if (failing) throw new Error('EIO'); });
      queue.enqueue('a', write);
      await expect(queue.receipt('a')).rejects.toThrow('EIO');
      const gaps: number[] = [];
      for (let round = 0; round < 8; round += 1) {
        const before = write.mock.calls.length;
        const started = Date.now();
        while (write.mock.calls.length === before) await vi.advanceTimersByTimeAsync(100);
        gaps.push(Date.now() - started);
      }
      const base = TERMINAL_COMMIT_RETRY_BASE_MS;
      expect(gaps).toEqual([base, 2 * base, 4 * base, 8 * base, 16 * base, 32 * base, 32 * base, 32 * base]);

      failing = false;
      await vi.advanceTimersByTimeAsync(32 * base);
      expect(queue.pendingCount).toBe(0);
      failing = true;
      queue.enqueue('b', write);
      await expect(queue.receipt('b')).rejects.toThrow('EIO');
      const before = write.mock.calls.length;
      await vi.advanceTimersByTimeAsync(base);
      expect(write.mock.calls.length).toBe(before + 1);

      // Grow the schedule, then restart the run: the first retry is back at the base.
      await vi.advanceTimersByTimeAsync(2 * base + 4 * base);
      await queue.stop().catch(() => undefined);
      queue.resume();
      const afterResume = write.mock.calls.length;
      await vi.advanceTimersByTimeAsync(base);
      expect(write.mock.calls.length).toBe(afterResume + 1);
      await queue.stop().catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});


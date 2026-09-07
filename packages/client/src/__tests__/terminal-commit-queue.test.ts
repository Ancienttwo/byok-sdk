import { describe, expect, it, vi } from 'vitest';
import { TerminalCommitQueue } from '../daemon/terminal-commit-queue';

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
});

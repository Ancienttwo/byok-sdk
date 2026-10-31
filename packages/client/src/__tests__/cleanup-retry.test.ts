import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_MAX_ATTEMPTS, removeDirectoryWithRetry } from './support/cleanup-retry';

/** The transient Windows busy-file shape: `code` is the only field the retry reads. */
function busyError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, unlink 'hermes.exe'`), { code });
}

describe('fixture cleanup retry (#1208)', () => {
  it.each(['EPERM', 'EBUSY'])('retries transient %s until the removal succeeds', async (code) => {
    const remove = vi
      .fn<(target: string) => Promise<void>>()
      .mockRejectedValueOnce(busyError(code))
      .mockRejectedValueOnce(busyError(code))
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn(async (_ms: number) => {});

    await removeDirectoryWithRetry('/tmp/bhc-fixture', { remove, wait });

    expect(remove).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledWith('/tmp/bhc-fixture');
    expect(wait.mock.calls).toEqual([[100], [200]]);
  });

  it('rethrows the original persistent EPERM after the bounded attempts', async () => {
    const lock = busyError('EPERM');
    const remove = vi.fn<(target: string) => Promise<void>>(async () => {
      throw lock;
    });
    const wait = vi.fn(async (_ms: number) => {});

    // Same identity, not a wrapped "retries exhausted" error: a genuinely
    // locked fixture must still surface the real cause.
    await expect(removeDirectoryWithRetry('/tmp/bhc-fixture', { remove, wait })).rejects.toBe(lock);
    expect(remove).toHaveBeenCalledTimes(CLEANUP_MAX_ATTEMPTS);
    expect(wait).toHaveBeenCalledTimes(CLEANUP_MAX_ATTEMPTS - 1);
  });

  it('does not retry errors outside EPERM/EBUSY', async () => {
    const denied = busyError('EACCES');
    const remove = vi.fn<(target: string) => Promise<void>>(async () => {
      throw denied;
    });
    const wait = vi.fn(async (_ms: number) => {});

    await expect(removeDirectoryWithRetry('/tmp/bhc-fixture', { remove, wait })).rejects.toBe(denied);
    expect(remove).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
});

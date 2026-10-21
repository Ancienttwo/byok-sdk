import { afterEach, expect, it, vi } from 'vitest';
import { withFailureSnapshot } from './failure-diagnostics';
afterEach(() => vi.restoreAllMocks());
it('does not collect a snapshot after successful observation', async () => {
  const snapshot = vi.fn();
  expect(await withFailureSnapshot(Promise.resolve(42), snapshot)).toBe(42);
  expect(snapshot).not.toHaveBeenCalled();
});
it('preserves the original error even when snapshot collection fails', async () => {
  const error = new Error('original assertion');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(withFailureSnapshot(Promise.reject(error), () => { throw new Error('must not be logged'); })).rejects.toBe(error);
  expect(log).toHaveBeenCalledWith('[host-wait-failure]', '{"unavailable":"snapshot-failed"}');
});
it('bounds a stalled snapshot and preserves the original error', async () => {
  const error = new Error('original assertion');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(withFailureSnapshot(Promise.reject(error), () => new Promise(() => {}))).rejects.toBe(error);
  expect(log).toHaveBeenCalledWith('[host-wait-failure]', '{"unavailable":"snapshot-deadline"}');
});

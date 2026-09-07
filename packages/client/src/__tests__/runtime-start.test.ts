import { expect, it, vi } from 'vitest';
import { startOwnedRuntime } from '../daemon/runtime-start';
import { RuntimeStartupDisposalFailure } from '../runtime-failure';
import type { RuntimeOperationStartInput, Session } from '../types';

it('a startup deadline retains a late session until its close receipt', async () => {
  let resolve!: (session: Session) => void;
  const pending = new Promise<Session>(r => { resolve = r; });
  const error = await startOwnedRuntime(() => pending, {} as RuntimeOperationStartInput, new AbortController().signal, 10).catch(e => e);
  expect(error).toBeInstanceOf(RuntimeStartupDisposalFailure);
  await expect(error.retryDisposal()).rejects.toThrow('receipt');
  const close = vi.fn().mockRejectedValueOnce(new Error('not quiescent')).mockResolvedValue(undefined);
  const interrupt = vi.fn().mockResolvedValue(undefined);
  resolve({ close, interrupt } as unknown as Session);
  await new Promise(resolve => setImmediate(resolve));
  await expect(error.retryDisposal()).rejects.toThrow('not quiescent');
  await expect(error.retryDisposal()).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(2);
});

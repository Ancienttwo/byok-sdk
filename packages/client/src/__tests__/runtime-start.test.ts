import { testExecutionScratch } from "./fixtures/execution-scratch";
import { expect, it, vi } from 'vitest';
import { startOwnedRuntime } from '../daemon/runtime-start';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapterDescriptor, type RuntimeOperationStartInput, type Session } from '../types';

const descriptor = (progressMessageBoundary?: RuntimeAdapterDescriptor['progressMessageBoundary']): RuntimeAdapterDescriptor =>
  freezeRuntimeAdapterDescriptor({ id: 'wrapped', supportsDispatchSelection: false, capabilities: { steer: false, resume: false, approvalInteractive: false }, progressMessageBoundary });

it('a startup deadline retains a late session until its close receipt', async () => {
const __executionScratch = await testExecutionScratch();

  let resolve!: (session: Session) => void;
  const pending = new Promise<Session>(r => { resolve = r; });
  const error = await startOwnedRuntime(() => pending, { scratch: __executionScratch, } as RuntimeOperationStartInput, descriptor(), new AbortController().signal, 10).catch(e => e);
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

it('closes, then refuses a session that lacks the progressStartsMessage its descriptor declares', async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const error = await startOwnedRuntime(async () => ({ close } as unknown as Session), {} as RuntimeOperationStartInput,
    descriptor('session'), new AbortController().signal, 1_000).catch(e => e);
  expect(close).toHaveBeenCalledTimes(1);
  expect(error).toBeInstanceOf(RuntimeExecutionFailure);
  expect(error).toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable' });
  expect(error.message).toMatch(/^runtime_session_incomplete: /);
});

it('quarantines an incomplete session whose close() fails', async () => {
  const close = vi.fn().mockRejectedValueOnce(new Error('not quiescent')).mockResolvedValue(undefined);
  const error = await startOwnedRuntime(async () => ({ close } as unknown as Session), {} as RuntimeOperationStartInput,
    descriptor('session'), new AbortController().signal, 1_000).catch(e => e);
  expect(error).toBeInstanceOf(RuntimeStartupDisposalFailure);
  await expect(error.retryDisposal()).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(2);
});

it.each([['event'], [undefined]] as const)('starts a session without progressStartsMessage for boundary %s', async boundary => {
  const session = { close: vi.fn() } as unknown as Session;
  const started = await startOwnedRuntime(async () => session, {} as RuntimeOperationStartInput,
    descriptor(boundary), new AbortController().signal, 1_000);
  expect(started).toEqual({ session, members: {} });
  expect(session.close).not.toHaveBeenCalled();
});

it('refuses a progressMessageBoundary outside its closed set', () => {
  expect(() => descriptor('message' as never)).toThrow(TypeError);
});

it('keeps a timed-out memory startup pending until the late session acknowledges abort', async () => {
  let releaseStart!: (session: Session) => void, acknowledge!: () => void;
  const pending = new Promise<Session>(resolve => { releaseStart = resolve; });
  const drain = new Promise<void>(resolve => { acknowledge = resolve; });
  const interrupt = vi.fn(() => drain), close = vi.fn(async () => {});
  let ended = false;
  const opening = startOwnedRuntime(() => pending, { memoryLane: { mode: 'memory' } } as RuntimeOperationStartInput,
    descriptor(), new AbortController().signal, 1).catch(error => { ended = true; return error; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ended).toBe(false);
    releaseStart({ interrupt, close } as unknown as Session);
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    expect(ended).toBe(false);
    acknowledge();
    expect(await opening).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(close).toHaveBeenCalledOnce();
  } finally { acknowledge(); releaseStart({ interrupt, close } as unknown as Session); await opening; }
});

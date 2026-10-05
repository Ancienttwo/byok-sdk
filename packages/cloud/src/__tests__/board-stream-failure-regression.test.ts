import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_ORIGIN, createHarness, TENANT_A } from './support/harness';

const POLL_MS = 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function openedStream() {
  const harness = createHarness({ boardStreamQueryIntervalMs: POLL_MS });
  const device = await harness.pairDevice(TENANT_A);
  await harness.cloud.createBoardItem(TENANT_A, {
    itemId: 'first-snapshot', channel: 'test', title: 'initial board snapshot',
  });
  const abort = new AbortController();
  const request = new Request(`${CLOUD_ORIGIN}/byok/board/stream`, {
    headers: device.authorization, signal: abort.signal,
  });
  const addListener = vi.spyOn(request.signal, 'addEventListener');
  const removeListener = vi.spyOn(request.signal, 'removeEventListener');
  const list = vi.spyOn(harness.core.board, 'list');
  const getDevice = vi.spyOn(harness.stores.devices, 'get');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = await harness.cloud.fetch(request);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('first-snapshot');
  expect(vi.getTimerCount()).toBe(1);
  const abortListener = addListener.mock.calls.find(([type]) => type === 'abort')?.[1];
  expect(abortListener).toBeTypeOf('function');
  return { harness, abort, request, reader, list, getDevice, removeListener, abortListener };
}

async function observedRead(reader: ReadableStreamDefaultReader<Uint8Array>) {
  return reader.read().then(
    (value) => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
}

describe('board SSE detached pump failures (F03-2)', () => {
  it.each(['board store', 'device authentication'] as const)('errors the established response and cleans up when %s rejects', async (source) => {
    const stream = await openedStream();
    const failure = new Error(`injected ${source} failure`);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      if (source === 'board store') stream.list.mockRejectedValueOnce(failure);
      else stream.getDevice.mockRejectedValueOnce(failure);
      const next = observedRead(stream.reader);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      const outcome = await next;
      await nextTurn();
      expect(unhandled).toEqual([]);
      expect(outcome).toEqual({ kind: 'error', error: failure });
      expect(stream.removeListener).toHaveBeenCalledWith('abort', stream.abortListener);
      expect(vi.getTimerCount()).toBe(0);
      const listCalls = stream.list.mock.calls.length;
      const authCalls = stream.getDevice.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(stream.list).toHaveBeenCalledTimes(listCalls);
      expect(stream.getDevice).toHaveBeenCalledTimes(authCalls);
    } finally {
      stream.abort.abort();
      stream.reader.releaseLock();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it.each(['cancel', 'abort'] as const)('handles a late store rejection after consumer %s without rejecting cancellation', async (mode) => {
    const stream = await openedStream();
    let rejectList!: (error: Error) => void;
    let enterList!: () => void;
    const entered = new Promise<void>((resolve) => { enterList = resolve; });
    stream.list.mockImplementationOnce(() => {
      enterList();
      return new Promise((_, reject) => { rejectList = reject; });
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await entered;
      if (mode === 'cancel') await expect(stream.reader.cancel()).resolves.toBeUndefined();
      else stream.abort.abort();
      await expect(stream.reader.read()).resolves.toEqual({ done: true, value: undefined });
      rejectList(new Error('store failed after peer left'));
      await nextTurn();
      expect(unhandled).toEqual([]);
      expect(stream.removeListener).toHaveBeenCalledWith('abort', stream.abortListener);
      expect(vi.getTimerCount()).toBe(0);
      expect(stream.list).toHaveBeenCalledTimes(2);
    } finally {
      stream.abort.abort();
      stream.reader.releaseLock();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('surfaces a cleanup failure through the response rather than another detached rejection', async () => {
    const stream = await openedStream();
    const failure = new Error('request-listener cleanup failed');
    const remove = stream.request.signal.removeEventListener.bind(stream.request.signal);
    stream.removeListener.mockImplementationOnce((type, callback, options) => {
      remove(type, callback, options);
      throw failure;
    });
    // Revocation makes the pump return normally, then inject a cleanup failure.
    stream.getDevice.mockResolvedValueOnce(undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const next = observedRead(stream.reader);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      const outcome = await next;
      await nextTurn();
      expect(unhandled).toEqual([]);
      expect(outcome).toEqual({ kind: 'error', error: failure });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stream.abort.abort();
      stream.reader.releaseLock();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

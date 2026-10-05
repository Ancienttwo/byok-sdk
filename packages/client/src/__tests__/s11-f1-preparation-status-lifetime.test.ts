import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentInputPreparationPayload, type InputPreparationReadback } from '@byok-sdk/protocol';
import { InputPreparationCompletionClient, InputPreparationCompletionError } from '../daemon/input-preparation-completion-client';
import { createRemoteInputPreparationHandler } from '../daemon/input-preparation-remote';
import type { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';

const identity = { requestId: '10000000-0000-4000-8000-000000000501', agentRef: { agentId: 'agent', profileRevision: 'rev' }, profileId: 'profile', policyRevision: 'policy' };
const terminal: InputPreparationReadback = { ...identity, tenantId: 'tenant', deviceId: 'device', status: 'rejected', reason: 'unsupported_input', completedAt: '2026-01-01T00:00:00.000Z' };
const payload: AgentInputPreparationPayload = { ...identity, deadlineAt: new Date(0).toISOString(), agentMemory: 'none', source: { revision: 'src', digest: 'digest' }, selection: { model: { id: 'model', name: 'Model', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20000, maxTokens: 1000 }, options: { cacheRetention: 'none', maxTokens: 1000 } }, context: { inline: JSON.stringify({ prompt: { systemPrompt: 'fixture' }, messages: [] }) }, requiredToolsets: [], permissionMode: 'auto' };
const expected = { ...identity, outcome: 'rejected', reason: 'unsupported_input' };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); while (cleanup.length) await cleanup.pop()?.(); vi.restoreAllMocks(); });

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function observe<T>(promise: Promise<T>) {
  const result: { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { state: 'pending' };
  void promise.then(value => { result.state = 'resolved'; result.value = value; }, error => { result.state = 'rejected'; result.error = error; });
  return result;
}
function harness(options: { statusReadDeadlineMs?: number; statusReadSignal?: AbortSignal; auth?: AuthManager } = {}) {
  const auth = options.auth ?? { getValidAccessToken: async () => 'fixture-token', handleUnauthorized: async () => 'renewed-token' } as AuthManager;
  const clientOptions = { serverUrl: 'http://cloud.test', tenantId: 'tenant', deviceId: 'device', auth, ...options };
  const client = new InputPreparationCompletionClient(clientOptions);
  const handle = createRemoteInputPreparationHandler({ deviceId: 'device', service: undefined, limits: undefined, completion: client, resolveBlobText: async () => { throw new Error('unexpected context resolution'); } });
  return { client, auth, handle: () => handle(payload) };
}
function expectAborted(result: ReturnType<typeof observe>, reason: string) {
  expect(result.state).toBe('rejected');
  expect(result.error).toBeInstanceOf(InputPreparationCompletionError);
  expect((result.error as Error).message).toContain(reason);
}

describe('S11-F1 status read owns headers, body and cancellation', () => {
  it('bounds abort-ignoring headers, discards late responses, and recovers after the preparation deadline', async () => {
    vi.useFakeTimers();
    const headers = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return headers.promise;
    });
    const h = harness();
    const result = observe(h.handle());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(result.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expectAborted(result, 'deadline');
    expect(signal?.aborted).toBe(true);
    const cancelled = vi.fn();
    headers.resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(result.state).toBe('rejected');
    fetchMock.mockResolvedValue(Response.json(terminal));
    await expect(h.handle()).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one header-and-body budget and cancels a stalled reader without awaiting its cancel acknowledgement', async () => {
    vi.useFakeTimers();
    const headers = deferred<Response>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ start: c => { c.enqueue(new TextEncoder().encode('{"status":')); }, cancel });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(headers.promise);
    const h = harness();
    const result = observe(h.handle());
    await vi.advanceTimersByTimeAsync(10_000);
    headers.resolve(new Response(stream));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expectAborted(result, 'deadline');
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    fetchMock.mockResolvedValue(Response.json(terminal));
    await expect(h.handle()).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a late GET when authentication ignored cancellation', async () => {
    vi.useFakeTimers();
    const token = deferred<string>();
    const auth = { getValidAccessToken: () => token.promise } as AuthManager;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(terminal));
    const result = observe(harness({ auth }).handle());
    await vi.advanceTimersByTimeAsync(15_000);
    expectAborted(result, 'deadline');
    token.resolve('late-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes one 401 renewal and its retried response body in the original deadline', async () => {
    vi.useFakeTimers();
    const renewal = deferred<string>();
    const auth = { getValidAccessToken: async () => 'fixture-token', handleUnauthorized: vi.fn(() => renewal.promise) } as unknown as AuthManager;
    const cancel = vi.fn();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const result = observe(harness({ auth }).handle());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(auth.handleUnauthorized).toHaveBeenCalledOnce();
    renewal.resolve('renewed-token');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expectAborted(result, 'deadline');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer renewed-token' });
  });

  it.each(['late-401', 'late-renewal'])('fences authentication continuations after deadline: %s', async stage => {
    vi.useFakeTimers();
    const headers = deferred<Response>();
    const renewal = deferred<string>();
    const auth = { getValidAccessToken: async () => 'fixture-token', handleUnauthorized: vi.fn(() => renewal.promise) } as unknown as AuthManager;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => stage === 'late-401' ? headers.promise : new Response('', { status: 401 }));
    const result = observe(harness({ auth }).handle());
    await vi.advanceTimersByTimeAsync(15_000);
    expectAborted(result, 'deadline');
    headers.resolve(new Response('', { status: 401 }));
    renewal.resolve('late-renewed-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.handleUnauthorized).toHaveBeenCalledTimes(stage === 'late-401' ? 0 : 1);
    expect(result.state).toBe('rejected');
  });

  it('honors a shorter explicit transport budget without resetting it on read progress', async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: controller => { streamController = controller; } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
    const result = observe(harness({ statusReadDeadlineMs: 100 }).handle());
    for (let n = 0; n < 4; n += 1) {
      await vi.advanceTimersByTimeAsync(20);
      streamController.enqueue(new TextEncoder().encode(' '));
      expect(result.state).toBe('pending');
    }
    await vi.advanceTimersByTimeAsync(20);
    expectAborted(result, 'deadline');
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['headers', 'body'])('allows real connection shutdown after owner cancellation during %s, without acknowledgement', async stage => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s11-status-stop-'));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const lifecycle = new AbortController();
    const started = deferred<void>();
    const late = deferred<Response>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream({ cancel });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      started.resolve();
      return stage === 'headers' ? late.promise : new Response(stream);
    });
    const h = harness({ statusReadSignal: lifecycle.signal });
    const cursorStore = new CursorStore(dir);
    const connection = new ConnectionManager({ serverUrl: 'http://cloud.test', deviceId: 'device', productId: 'fixture', capabilities: [], runtimes: [], auth: h.auth, cursorStore,
      onEnvelope: async e => { if (e.type === 'agent.input.preparation') await h.handle(); },
    });
    const delivery = connection as unknown as { deliver: (e: ReturnType<typeof createEnvelope>) => boolean };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delivery.deliver(createEnvelope('agent.input.preparation', payload, { seq: 1 }));
    await started.promise;
    if (stage === 'body') await vi.waitFor(() => expect(stream.locked).toBe(true));
    // Match daemon teardown ordering: abort owned reads before draining handlers.
    lifecycle.abort();
    const stopped = observe(connection.stop());
    await vi.waitFor(() => expect(stopped.state).toBe('resolved'), { timeout: 1_000 });
    expect(await cursorStore.load('http://cloud.test', 'device')).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (stage === 'headers') {
      late.resolve(Response.json(terminal));
      await new Promise(resolve => setTimeout(resolve, 0));
    } else expect(cancel).toHaveBeenCalledOnce();
    // A fresh lifecycle can recover the terminal; the original expired Host
    // deadline must not suppress readback or convert it into another rejection.
    fetchMock.mockResolvedValue(Response.json(terminal));
    await expect(harness().handle()).resolves.toEqual(expected);
  });

  it.each([0, -1, 0.5, Infinity, 2_147_483_648])('rejects an invalid status deadline %s', deadline => {
    expect(() => harness({ statusReadDeadlineMs: deadline })).toThrow('positive timer-safe integer');
  });

  it('refuses an already cancelled owner without entering authentication or fetch', async () => {
    const lifecycle = new AbortController();
    lifecycle.abort();
    const auth = { getValidAccessToken: vi.fn(async () => 'fixture-token') } as unknown as AuthManager;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(harness({ auth, statusReadSignal: lifecycle.signal }).handle()).rejects.toThrow('cancelled');
    expect(auth.getValidAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentInputPreparationPayload, type InputPreparationReadback } from '@byok-sdk/protocol';
import { CursorStore } from '../daemon/cursor-store';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const identity = { requestId: '10000000-0000-4000-8000-000000000501', agentRef: { agentId: 'agent', profileRevision: 'rev' }, profileId: 'profile', policyRevision: 'policy' };
const terminal: InputPreparationReadback = { ...identity, tenantId: 'tenant', deviceId: 'device', status: 'rejected', reason: 'unsupported_input', completedAt: '2026-01-01T00:00:00.000Z' };
const payload: AgentInputPreparationPayload = { ...identity, deadlineAt: new Date(0).toISOString(), agentMemory: 'none', source: { revision: 'src', digest: 'digest' }, selection: { model: { id: 'model', name: 'Model', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20000, maxTokens: 1000 }, options: { cacheRetention: 'none', maxTokens: 1000 } }, context: { inline: JSON.stringify({ prompt: { systemPrompt: 'fixture' }, messages: [] }) }, requiredToolsets: [], permissionMode: 'auto' };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); while (cleanup.length) await cleanup.pop()?.(); vi.restoreAllMocks(); });

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function observe<T>(promise: Promise<T>) {
  const result: { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { state: 'pending' };
  void promise.then(value => { result.state = 'resolved'; result.value = value; }, error => { result.state = 'rejected'; result.error = error; });
  return result;
}

// Requires the production daemon-owner Unix socket substrate. No owner/gate mocks.
describe('S11-F1 daemon status-read lifetime', () => {
  it('wires daemon stop to status cancellation and creates a fresh owner on restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s11-daemon-stop-'));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const server = await TestServer.start();
    cleanup.push(() => server.close());
    server.setPairingTenantId('fixture-code', 'tenant');
    const daemon = createDaemonWithAdapters({ localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot: path.join(dir, 'workspace'), storeDir: path.join(dir, 'store') }, [new StubRuntimeAdapter()]);
    cleanup.push(() => daemon.stop());
    const device = await daemon.pair('fixture-code');
    const originalFetch = globalThis.fetch;
    const reading = deferred<void>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let statusSignal: AbortSignal | undefined;
    let stalled = true;
    let puts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(server.url);
      if (!url.pathname.startsWith('/byok/input-preparations/')) return originalFetch(input, init);
      if (init?.method === 'PUT') { puts += 1; throw new Error('unexpected PUT'); }
      statusSignal = init?.signal as AbortSignal;
      reading.resolve();
      return stalled ? new Response(new ReadableStream({ cancel })) : Response.json({ ...terminal, deviceId: device.deviceId });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await daemon.start();
    const seq = server.nextSeq();
    const envelope = createEnvelope('agent.input.preparation', payload, { seq });
    server.send(envelope);
    await reading.promise;
    const stopped = observe(daemon.stop());
    await vi.waitFor(() => expect(stopped.state).toBe('resolved'), { timeout: 1_000 });
    expect(statusSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    const cursor = new CursorStore(path.join(dir, 'store'));
    expect(await cursor.load(server.url, device.deviceId)).toBe(0);
    expect(puts).toBe(0);
    stalled = false;
    await daemon.start();
    server.send(envelope);
    await vi.waitFor(async () => expect(await cursor.load(server.url, device.deviceId)).toBe(seq), { timeout: 2_000 });
    expect(statusSignal?.aborted).toBe(false);
    expect(puts).toBe(0);
  });

});

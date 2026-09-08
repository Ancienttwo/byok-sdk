import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { DeviceStore } from '../daemon/store';
import { startRealServer, type RealServerHandle } from './fixtures/real-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('protocol-version admission at real long-poll receive', () => {
  let real: RealServerHandle | undefined;
  let connection: ConnectionManager | undefined;
  let auth: AuthManager | undefined;
  let storeDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await connection?.stop();
    await auth?.stop();
    await real?.close();
    if (storeDir !== undefined) await fs.rm(storeDir, { recursive: true, force: true });
  });

  it('does not execute or acknowledge an otherwise-known task.offer carrying unsupported v:2', async () => {
    real = await startRealServer({
      productId: 'version-admission-client',
      longPollHoldMs: 20,
      rateLimit: { messagesPerSecond: 10_000, burst: 10_000 },
    });
    storeDir = await tmpDir('byok-version-admission-client-');
    auth = new AuthManager({ serverUrl: real.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair((await real.createPairingCode()).code);
    const cursorStore = new CursorStore(storeDir);
    const received: number[] = [];
    const nativeFetch = globalThis.fetch;
    let rewroteKnownOffer = false;
    let rewriteV2 = true;
    let eventsRequestsAfterV2 = 0;
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${real!.url}/byok/events`) && rewroteKnownOffer) eventsRequestsAfterV2 += 1;
      const response = await nativeFetch(input, init);
      if (!url.startsWith(`${real!.url}/byok/events`) || !response.ok) return response;
      const page = await response.json() as { events: Array<Record<string, unknown>>; cursor: number; capabilities?: string[] };
      const events = page.events.map((event) => {
        if (!rewriteV2 || event.type !== 'task.offer') return event;
        rewroteKnownOffer = true;
        return { ...event, v: 2 };
      });
      return new Response(JSON.stringify({ ...page, events }), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);

    connection = new ConnectionManager({
      serverUrl: real.url,
      deviceId: record.deviceId,
      productId: 'version-admission-client',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: (envelope) => {
        if (envelope.type === 'task.offer') received.push(envelope.v);
      },
      longPollRetryDelayMs: 10,
      longPollIdleDelayMs: 10,
    });
    await connection.start();
    await connection.waitForConnection();
    await real.byok.dispatch({ instruction: 'known v2 offer must not run', policy: { mode: 'auto' } });

    await vi.waitFor(() => expect(rewroteKnownOffer).toBe(true));
    // The next poll starts only after LongPollClient has completed the prior
    // response's per-entry parse and dispatch loop, so it is a real receive
    // barrier rather than a timing guess.
    await vi.waitFor(() => expect(eventsRequestsAfterV2).toBeGreaterThan(0));
    expect(received).toEqual([]);
    expect(await cursorStore.load(real.url, record.deviceId)).toBeUndefined();

    // The same retained offer becomes deliverable once its wire major is the
    // supported one; rejection did not consume its cursor or task semantics.
    rewriteV2 = false;
    await vi.waitFor(() => expect(received).toEqual([1]));
    await vi.waitFor(async () => expect(await cursorStore.load(real!.url, record.deviceId)).toBeGreaterThan(0));
  }, 10_000);
});

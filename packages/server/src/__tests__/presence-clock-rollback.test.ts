import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer } from './test-support';

const productId = 'presence-clock-rollback';
const t0 = Date.parse('2026-10-22T00:00:00Z');
describe.each(['memory', 'sqlite'] as const)('%s transport presence after clock rollback', storage => {
  let byok: ByokServer | undefined, http: Server | undefined, root: string | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    try { await byok?.close(); } finally {
      try { if (http) await stopServer(http); } finally { if (root) await rm(root, { recursive: true, force: true }); }
    }
    byok = undefined; http = undefined; root = undefined;
  });
  async function setup() {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(t0);
    root = await mkdtemp(join(tmpdir(), 'byok-presence-rollback-'));
    byok = createByokServer({ productId, longPollHoldMs: 1, presenceTtlMs: 90_000,
      storage: storage === 'sqlite' ? { kind: 'sqlite', path: join(root, 'server.sqlite') } : { kind: 'memory' } });
    const started = await startServer(byok); http = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, byok, { productId });
    vi.setSystemTime(t0 + 2000);
    expect((await daemon.replay(0)).status).toBe(200);
    vi.setSystemTime(t0 + 1000);
    return { daemon, byok };
  }
  it('accepts a fresh inbound envelope before recording a genuine duplicate', async () => {
    const { daemon, byok } = await setup();
    const envelope = createEnvelope('conn.hello', { deviceId: daemon.deviceId, productId, protocolVersions: [PROTOCOL_VERSION], capabilities: [] });
    const first = await daemon.send(envelope);
    // Inspect replay too: baseline records dedup before its renewal throws.
    const replay = await daemon.send(envelope);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcomes: [{ id: envelope.id, outcome: 'accepted' }] });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcomes: [{ id: envelope.id, outcome: 'duplicate' }] });
    expect((await byok.machines.list())[0]).toMatchObject({ connected: true, lastSeen: new Date(t0 + 1000).toISOString() });
  });
  it('serves event polls while renewing the lease at the current wall clock', async () => {
    const { daemon, byok } = await setup();
    expect((await daemon.replay(0)).status).toBe(200);
    expect((await byok.machines.list())[0]).toMatchObject({ connected: true, lastSeen: new Date(t0 + 1000).toISOString() });
    vi.setSystemTime(t0 + 91_000);
    expect((await byok.machines.list())[0]?.connected).toBe(false);
  });
});

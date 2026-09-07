import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, decodeEnvelope, encodeEnvelope, type Envelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { journalHash, type LocalTerminalRecord } from '../daemon/journal/journal';
import { DeviceStore } from '../daemon/store';
import { CursorStore } from '../daemon/cursor-store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { startRealCloud } from './fixtures/real-cloud';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });
async function config(serverUrl: string): Promise<DaemonConfig> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-terminal-boundaries-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return { serverUrl, productId: 'terminal-boundaries', productName: 'Terminal boundaries',
    localAgentRelease: { version: '0.0.0-test' }, workspaceRoot: path.join(root, 'work'),
    storeDir: path.join(root, 'store'), hostedJournal: { mode: 'sqlite', maxRecordBytes: 2048 } };
}
async function post(url: string, token: string, envelope: Envelope) {
  const response = await fetch(`${url}/byok/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [envelope] }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { accepted: number };
  expect(body.accepted).toBe(1);
}

describe('terminal durability and actual harness boundaries', () => {
  it('R1: retries the original decline after SQLite rollback even when admission becomes available', async () => {
    const server = await TestServer.start(); cleanup.push(() => server.close());
    const cfg = await config(server.url);
    const adapter = new StubRuntimeAdapter();
    let available = false;
    vi.spyOn(adapter, 'detect').mockImplementation(async () => available
      ? { kind: 'available', version: '0.0.0' } : { kind: 'not-found' });
    let fail = true;
    const journal = new SqliteLocalTaskJournal({ storeDir: cfg.storeDir!, faults: { onStep(step) {
      if (step === 'terminal:before-commit' && fail) throw new Error('injected EIO before commit');
    } } });
    const candidates: LocalTerminalRecord[] = [];
    const write = journal.recordTerminal.bind(journal);
    vi.spyOn(journal, 'recordTerminal').mockImplementation(async record => { candidates.push(record); return write(record); });
    const daemon = createDaemonWithAdapters(cfg, [adapter], { hostedJournal: { journal }, longPoll: { retryDelayMs: 10, idleDelayMs: 10 } });
    cleanup.push(async () => { fail = false; await daemon.stop(); await journal.close(); });
    await daemon.pair('pairing-code');
    const record = (await new DeviceStore(cfg.storeDir!, undefined, cfg.productId).credentials.read())!;
    await daemon.start();
    const identity = { tenantId: record.tenantId, deviceId: record.deviceId, productId: cfg.productId };
    const seq = server.nextSeq();
    const offer = createEnvelope('task.offer', { instruction: 'run once', policy: { mode: 'auto' } }, { taskId: 'pending-decline', seq });
    server.send(offer);
    await vi.waitFor(() => expect(candidates.length).toBeGreaterThan(0));
    expect((await journal.readTask('pending-decline', identity))?.localState).toBe('received');
    const first = candidates[0]!.bytes;
    expect(decodeEnvelope(first).type).toBe('task.decline');
    available = true;
    const previousWrites = candidates.length;
    server.send(offer);
    await vi.waitFor(() => expect(candidates.length).toBeGreaterThan(previousWrites));
    expect(adapter.startCalls).toHaveLength(0);
    expect(await new CursorStore(cfg.storeDir!).load(server.url, record.deviceId)).toBe(0);
    fail = false; server.send(offer);
    const terminal = await server.waitFor(e => e.type === 'task.decline', 4000);
    expect(encodeEnvelope(terminal)).toBe(first);
    await vi.waitFor(async () => {
      server.send(offer); // Retry after any still-in-flight failed delivery settles.
      expect(await new CursorStore(cfg.storeDir!).load(server.url, record.deviceId)).toBe(seq);
    });
    expect(candidates.every(candidate => candidate.bytes === first)).toBe(true);
    expect(adapter.startCalls).toHaveLength(0);
  });

  for (const explicit of [false, true]) {
    for (const claimed of [false, true]) {
      it(`R2: SQLite recovery custom explicit=${explicit} cloudClaimed=${claimed}`, async () => {
        const cloud = await startRealCloud({ productId: 'terminal-boundaries' }); cleanup.push(() => cloud.close());
        const cfg = await config(cloud.url);
        const adapter = new StubRuntimeAdapter('acme-harness');
        const daemon = createDaemonWithAdapters(cfg, [adapter]); cleanup.push(() => daemon.stop());
        const pairing = await cloud.createPairingCode();
        await daemon.pair(pairing.code);
        const device = (await new DeviceStore(cfg.storeDir!, undefined, cfg.productId).credentials.read())!;
        await post(cloud.url, device.accessToken, createEnvelope('conn.hello', {
          deviceId: device.deviceId, productId: cfg.productId, protocolVersions: [1],
          capabilities: ['custom-harness'], runtimes: [], harnesses: [{ id: 'acme-harness', capabilities: { ...adapter.descriptor.capabilities, permissionModes: [...adapter.descriptor.capabilities.permissionModes] } }],
        }));
        const offer = await cloud.cloud.enqueueOffer(cloud.tenant, device.deviceId, { payload: {
          instruction: 'interrupted', policy: { mode: 'auto' }, ...(explicit ? { harnessId: 'acme-harness' } : {}),
        } });
        const journal = new SqliteLocalTaskJournal({ storeDir: cfg.storeDir! });
        const bytes = encodeEnvelope(offer.envelope);
        await journal.appendEnvelope({ identity: { tenantId: device.tenantId, productId: cfg.productId, deviceId: device.deviceId },
          taskId: offer.taskId, envelopeId: offer.envelope.id, seq: offer.seq, bytes, bytesHash: journalHash(bytes),
          opensTask: true, receivedAt: new Date().toISOString() });
        await journal.recordAdmission({ taskId: offer.taskId, admitted: true, claimedRuntime: 'acme-harness', decidedAt: new Date().toISOString() });
        if (claimed) await post(cloud.url, device.accessToken, createEnvelope('task.claim', { deviceId: device.deviceId, harnessId: 'acme-harness' }, { taskId: offer.taskId }));
        await journal.close(); // Persisted crash image; no graceful task finalization.
        await daemon.start();
        await vi.waitFor(async () => expect((await cloud.readTaskAttempt(offer.taskId))?.status).toBe('failed'), { timeout: 4000 });
        const terminal = decodeEnvelope((await cloud.readTerminalBody(offer.taskId))!);
        expect(terminal.payload).toMatchObject({ reason: 'daemon_interrupted', harnessId: 'acme-harness', retryable: false,
          recovery: { kind: 'daemon_interrupted', offerId: offer.envelope.id } });
        expect((await cloud.readTaskAttempt(offer.taskId))?.claimedHarnessId).toBe(claimed ? 'acme-harness' : undefined);
        expect(adapter.startCalls).toHaveLength(0);
      });
    }
    it(`R3: oversized custom terminal accepted by cloud explicit=${explicit}`, async () => {
      const cloud = await startRealCloud({ productId: 'terminal-boundaries' }); cleanup.push(() => cloud.close());
      const cfg = await config(cloud.url);
      const adapter = new StubRuntimeAdapter('acme-harness');
      const daemon = createDaemonWithAdapters(cfg, [adapter]); cleanup.push(() => daemon.stop());
      const device = await daemon.pair((await cloud.createPairingCode()).code); await daemon.start();
      await vi.waitFor(async () => expect((await cloud.cloud.listDevices(cloud.tenant))[0]?.harnesses?.[0]?.id).toBe('acme-harness'));
      const offer = await cloud.cloud.enqueueOffer(cloud.tenant, device.deviceId, { payload: {
        instruction: 'large result', policy: { mode: 'auto' }, ...(explicit ? { harnessId: 'acme-harness' } : {}),
      } });
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      adapter.sessions[0]!.emit({ type: 'progress', text: 'x'.repeat(8192) });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      await vi.waitFor(async () => expect((await cloud.readTaskAttempt(offer.taskId))?.status).toBe('failed'), { timeout: 4000 });
      expect(decodeEnvelope((await cloud.readTerminalBody(offer.taskId))!).payload).toMatchObject({ reason: 'terminal_result_too_large', retryable: false, harnessId: 'acme-harness' });
      expect(adapter.startCalls).toHaveLength(1);
    });
  }
});

it('R1/R6: committed decline settles its failed receipt after cancellation filters the offer', async () => {
  const cloud = await startRealCloud({ productId: 'terminal-boundaries', eventsPageLimit: 2, longPollHoldMs: 20, longPollIntervalMs: 5 });
  cleanup.push(() => cloud.close());
  const cfg = await config(cloud.url);
  const adapter = new StubRuntimeAdapter();
  let available = false, fail = true;
  vi.spyOn(adapter, 'detect').mockImplementation(async () => available ? { kind: 'available', version: '0.0.0' } : { kind: 'not-found' });
  const journal = new SqliteLocalTaskJournal({ storeDir: cfg.storeDir!, faults: { onStep(step) {
    if (step === 'terminal:before-commit' && fail) throw new Error('injected EIO');
  } } });
  const candidates: LocalTerminalRecord[] = [];
  const recordTerminal = journal.recordTerminal.bind(journal);
  vi.spyOn(journal, 'recordTerminal').mockImplementation(async record => { candidates.push(record); return recordTerminal(record); });
  const daemon = createDaemonWithAdapters(cfg, [adapter], { hostedJournal: { journal }, longPoll: { retryDelayMs: 5, idleDelayMs: 5 } });
  cleanup.push(async () => { fail = false; await daemon.stop(); await journal.close(); });
  const device = await daemon.pair((await cloud.createPairingCode()).code);
  const a = await cloud.enqueueOffer(device.deviceId, 'declined while temporarily unavailable');
  const b = await cloud.enqueueOffer(device.deviceId, 'second offer');
  await daemon.start();
  await vi.waitFor(() => expect(candidates.some(record => record.taskId === a.taskId)).toBe(true));
  const first = candidates.find(record => record.taskId === a.taskId)!.bytes;
  await cloud.cancelTask(a.taskId, 'filter failed offer');
  available = true;
  expect(await new CursorStore(cfg.storeDir!).load(cloud.url, device.deviceId)).toBe(0);
  fail = false;
  await vi.waitFor(async () => expect(await new CursorStore(cfg.storeDir!).load(cloud.url, device.deviceId)).toBe(3), { timeout: 3500 });
  expect(await cloud.readTerminalBody(a.taskId)).toBe(first);
  expect(candidates.filter(record => record.taskId === a.taskId).every(record => record.bytes === first)).toBe(true);
  expect(adapter.startCalls).toHaveLength(0);
  expect((await cloud.readTaskAttempt(b.taskId))?.status).toBe('failed');
});

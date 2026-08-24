import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import type { JournalReceipt, LocalTaskJournal, ReceivedEnvelopeRecord } from '../daemon/journal/journal';
import { DeviceStore } from '../daemon/store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const roots: string[] = [];
let server: TestServer | undefined;
let daemon: Daemon | undefined;

async function tmpDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await daemon?.stop();
  daemon = undefined;
  await server?.close();
  server = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

class CapturingJournal implements LocalTaskJournal {
  readonly appended: ReceivedEnvelopeRecord[] = [];

  async appendEnvelope(record: ReceivedEnvelopeRecord): Promise<JournalReceipt> {
    this.appended.push(record);
    return {
      envelopeId: record.envelopeId,
      seq: record.seq,
      bytesHash: record.bytesHash,
      committedAt: new Date().toISOString(),
      created: true,
    };
  }

  async recordAdmission(): Promise<void> {}
  async recordTransition(): Promise<void> {}
  async recordTerminal(): Promise<void> {}
  async listRecoverable(): Promise<[]> { return []; }
  async markRecovered(): Promise<void> {}
  async measureUsage(): Promise<never> { throw new Error('not used'); }
  async listCleanupCandidates(): Promise<[]> { return []; }
  async markCleanupResult(): Promise<void> {}
  async compact(): Promise<never> { throw new Error('not used'); }
  async close(): Promise<void> {}
}

describe('authenticated enrollment tenant projection', () => {
  it('persists exact tenant binding and reads it unchanged after restart', async () => {
    server = await TestServer.start();
    server.setPairingTenantId('restart-code', 'tenant-restart');
    const store = new DeviceStore(await tmpDir('byok-enrollment-restart-'));
    const paired = await new AuthManager({ serverUrl: server.url, store }).pair('restart-code');

    const restarted = await new AuthManager({ serverUrl: server.url, store }).loadExisting();

    expect(paired.tenantId).toBe('tenant-restart');
    expect(restarted).toEqual(paired);
  });

  it('refuses legacy and tampered enrollment records with an explicit re-pair requirement', async () => {
    const storeDir = await tmpDir('byok-enrollment-invalid-');
    const filePath = path.join(storeDir, 'device.json');
    await fs.writeFile(filePath, JSON.stringify({
      deviceId: 'device-legacy',
      accessToken: 'opaque-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      devicePrivateKeyPem: 'pem',
      devicePublicKey: 'public-key',
    }));

    const store = new DeviceStore(storeDir);
    await expect(store.load()).rejects.toThrow(/re-pair required/);

    await fs.writeFile(filePath, JSON.stringify({
      deviceId: 'device-tampered',
      tenantId: `tenant-${'x'.repeat(200)}`,
      accessToken: 'opaque-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      devicePrivateKeyPem: 'pem',
      devicePublicKey: 'public-key',
    }));
    await expect(store.load()).rejects.toThrow(/re-pair required/);
  });

  it('keeps a legacy record unusable for start/load but lets explicit pairing atomically replace it', async () => {
    server = await TestServer.start();
    server.setPairingTenantId('repair-code', 'tenant-repaired');
    const workspaceRoot = await tmpDir('byok-enrollment-repair-workspace-');
    const storeDir = await tmpDir('byok-enrollment-repair-store-');
    await fs.writeFile(path.join(storeDir, 'device.json'), JSON.stringify({
      deviceId: 'legacy-device',
      accessToken: 'legacy-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      devicePrivateKeyPem: 'legacy-pem',
      devicePublicKey: 'legacy-public-key',
    }));
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Enrollment repair test',
        productId: 'enrollment-repair-test',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
      },
      [new StubRuntimeAdapter('pi')],
    );

    await expect(daemon.start()).rejects.toThrow(/re-pair required/);
    const repaired = await daemon.pair('repair-code');
    expect(repaired).toEqual({ deviceId: expect.any(String) });
    expect(await new DeviceStore(storeDir).load()).toMatchObject({
      deviceId: repaired.deviceId,
      tenantId: 'tenant-repaired',
    });
  });

  it('rejects a pair response without the required authenticated tenant before writing device.json', async () => {
    const store = new DeviceStore(await tmpDir('byok-enrollment-pair-response-'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      deviceId: 'device-malformed',
      accessToken: 'opaque-token',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(new AuthManager({ serverUrl: 'http://127.0.0.1:1', store }).pair('malformed-code')).rejects.toThrow();
    expect(await store.load()).toBeUndefined();
  });

  it('preserves the exact enrolled tenant through renewal without parsing the opaque token', async () => {
    server = await TestServer.start();
    server.setPairingTenantId('renew-code', 'tenant-renew');
    const store = new DeviceStore(await tmpDir('byok-enrollment-renew-'));
    const auth = new AuthManager({ serverUrl: server.url, store });
    const paired = await auth.pair('renew-code');
    expect(paired.accessToken.split('.')).toHaveLength(1);

    server.rotateDeviceToken(paired.deviceId);
    await auth.handleUnauthorized();

    expect((await store.load())?.tenantId).toBe('tenant-renew');
    await auth.stop();
  });

  it('re-pair atomically replaces the complete enrollment binding', async () => {
    server = await TestServer.start();
    server.setPairingTenantId('first-code', 'tenant-first');
    server.setPairingTenantId('replacement-code', 'tenant-replacement');
    const store = new DeviceStore(await tmpDir('byok-enrollment-repair-'));
    const auth = new AuthManager({ serverUrl: server.url, store });
    const first = await auth.pair('first-code');
    const replacement = await auth.pair('replacement-code');

    expect(first.tenantId).toBe('tenant-first');
    expect(replacement.tenantId).toBe('tenant-replacement');
    expect(await store.load()).toEqual({
      deviceId: replacement.deviceId,
      tenantId: replacement.tenantId,
      devicePublicKey: replacement.devicePublicKey,
    });
    expect(await store.credentials.read()).toMatchObject({ accessToken: replacement.accessToken });
    await auth.stop();
  });

  it('stops before re-pairing a running daemon so active tenant composition cannot remain stale', async () => {
    server = await TestServer.start();
    server.setPairingTenantId('active-first-code', 'tenant-active-first');
    server.setPairingTenantId('active-replacement-code', 'tenant-active-replacement');
    const workspaceRoot = await tmpDir('byok-enrollment-active-workspace-');
    const storeDir = await tmpDir('byok-enrollment-active-store-');
    const hostStorageRoot = await tmpDir('byok-enrollment-active-agent-home-');
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Enrollment active test',
        productId: 'enrollment-active-test',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
        agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      },
      [new StubRuntimeAdapter('pi')],
    );

    const first = await daemon.pair('active-first-code');
    await daemon.start();
    const replacement = await daemon.pair('active-replacement-code');
    expect(first).toEqual({ deviceId: expect.any(String) });
    expect(replacement).toEqual({ deviceId: expect.any(String) });
    expect(daemon.status().connected).toBe(false);
    expect((await new DeviceStore(storeDir).load())?.tenantId).toBe('tenant-active-replacement');
    expect(server.httpRequests.filter((request) => request.pathname === '/byok/pair')).toHaveLength(2);
    await expect(daemon.publishReliableAgentEgress?.({
      agentRef: { agentId: 'active-repair-agent', profileRevision: 'r1' },
      sessionRef: 'active-repair-session',
      runtimeId: 'pi',
      taskId: 'active-repair-task',
      payload: { status: 'must-not-use-stale-tenant' },
    })).rejects.toThrow(/handoff/i);
  });

  it('binds final egress and journal composition to the loaded enrollment record, not host config', async () => {
    server = await TestServer.start();
    server.setPairingTenantId('daemon-code', 'tenant-daemon');
    server.setAckCapabilities(['agent-egress-reliable-ack']);
    const workspaceRoot = await tmpDir('byok-enrollment-workspace-');
    const storeDir = await tmpDir('byok-enrollment-store-');
    const hostStorageRoot = await tmpDir('byok-enrollment-agent-home-');
    const agentRef = { agentId: 'enrollment-agent', profileRevision: 'r1' };
    const agentHome = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    await fs.mkdir(agentHome, { recursive: true });
    await new AgentSessionHandoffStore().record({
      agentRef,
      taskId: 'enrollment-egress-task',
      sessionRef: 'enrollment-session',
      runtimeId: 'pi',
      cwd: agentHome,
      leaseId: 'enrollment-egress-lease',
    });
    const journal = new CapturingJournal();
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Enrollment test',
        productId: 'enrollment-test',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
        agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
        hostedJournal: { mode: 'sqlite' },
      },
      [new StubRuntimeAdapter('pi')],
      { hostedJournal: { journal } },
    );

    const record = await daemon.pair('daemon-code');
    await daemon.start();
    const appended = await daemon.publishReliableAgentEgress?.({
      agentRef,
      sessionRef: 'enrollment-session',
      runtimeId: 'pi',
      taskId: 'enrollment-egress-task',
      payload: { status: 'authenticated' },
    });
    expect(appended).toMatchObject({ ok: true, record: { tenantId: 'tenant-daemon' } });

    const sequence = server.nextSeq();
    server.send(createEnvelope('task.offer', { instruction: 'journal identity', policy: { mode: 'auto' } }, {
      taskId: 'enrollment-journal-task',
      seq: sequence,
    }));
    await vi.waitFor(() => expect(journal.appended.some((entry) => entry.taskId === 'enrollment-journal-task')).toBe(true));
    expect(journal.appended.find((entry) => entry.taskId === 'enrollment-journal-task')?.identity).toEqual({
      tenantId: 'tenant-daemon',
      productId: 'enrollment-test',
      deviceId: record.deviceId,
    });
    const observableEgress = JSON.stringify({ appended, journal: journal.appended, wire: server.received });
    const credentials = await new DeviceStore(storeDir, undefined, 'enrollment-test').credentials.read();
    expect(credentials).toBeDefined();
    expect(observableEgress).not.toContain(credentials!.accessToken);
    expect(observableEgress).not.toContain(credentials!.devicePrivateKeyPem);
  });
});

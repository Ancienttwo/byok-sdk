/**
 * #654 E2d-1: a daemon paired with a verification secret enrolls as an E2EE
 * member (design §7.2, owner 10b, 11b, §50c). The test plays the web client
 * and the Host's member routes; the daemon keeps its member entries in the
 * unit-suite member custody.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControlClient } from '../bin/control-client';
import { parseEnrollmentPairParams, type ControlStatusResult } from '../daemon/control-protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { InMemoryDeviceCredentialStore, testDeviceMemberCustody } from './fixtures/credential-backend';
import { E2eeWebClient } from './fixtures/e2ee-web-client';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const dirs: string[] = [];
const daemons: Daemon[] = [];
let server: TestServer | undefined;

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-member-'));
  dirs.push(root);
  server = await TestServer.start();
  const productId = `member-test-${randomUUID()}`;
  const config = {
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Member test', productId,
    serverUrl: server.url, storeDir: path.join(root, 'store'),
  };
  const daemon = (overrides = {}) => {
    const created = createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')], overrides);
    daemons.push(created);
    return created;
  };
  return { server, custody: testDeviceMemberCustody(productId), daemon, config };
}

function state(custody: { entries: Map<string, string> }): Record<string, unknown> | undefined {
  const text = custody.entries.get('member-state');
  return text === undefined ? undefined : JSON.parse(text) as Record<string, unknown>;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('E2EE member enrollment (E2d-1)', () => {
  it('registers the bundle at pair time, then anchors at start and deletes pv (§7.2 steps 3 and 5)', async () => {
    const { server, custody, daemon } = await setup();
    const client = await E2eeWebClient.create(server.e2ee);
    const paired = daemon();
    const { deviceId } = await paired.pair('pair-code', { verificationSecret: client.verificationSecret });
    // Only the code reached the Host; pv stays on the device.
    expect(server.pairRequests.at(-1)?.pairingCode).toBe('pair-code');
    expect(JSON.stringify(server.pairRequests)).not.toContain(client.verificationSecret);
    expect(custody.entries.has('member-keys')).toBe(true);
    expect(custody.entries.has('pairing-verification')).toBe(true);
    expect(state(custody)).toMatchObject({ deviceId, tenantId: 'tenant-test' });
    expect(state(custody)?.anchor).toBeUndefined();

    const device = await client.approve(deviceId);
    expect(device.deviceId).toBe(deviceId);
    expect(server.e2ee.registration(deviceId)?.member).toEqual(state(custody)?.member);

    await paired.start();
    await until(() => state(custody)?.anchor !== undefined, 'the member anchor');
    expect(state(custody)).toMatchObject({
      member: server.e2ee.registration(deviceId)?.member,
      anchor: { approverSigningPublicJwk: client.member.signingPublicJwk, entry: client.head },
      head: client.head,
    });
    expect(custody.entries.has('pairing-verification')).toBe(false);
  });

  it('pairs without E2EE when no verification secret is given', async () => {
    const { server, custody, daemon } = await setup();
    const { deviceId } = await daemon().pair('pair-code');
    expect(custody.entries.size).toBe(0);
    expect(server.e2ee.registration(deviceId)).toBeUndefined();
  });

  it('refuses a malformed verification secret before it spends the pairing code', async () => {
    const { server, daemon } = await setup();
    await expect(daemon().pair('pair-code', { verificationSecret: 'not-a-secret' })).rejects.toThrow();
    expect(server.pairRequests).toHaveLength(0);
  });

  it('refuses an E2EE pairing with an injected credential backend', async () => {
    const { server, daemon } = await setup();
    const client = await E2eeWebClient.create(server.e2ee);
    await expect(daemon({ deviceCredentials: new InMemoryDeviceCredentialStore() })
      .pair('pair-code', { verificationSecret: client.verificationSecret })).rejects.toThrow(/OS credential custody/);
    expect(server.pairRequests).toHaveLength(0);
  });

  it('retries a lost registration at start with the same bundle', async () => {
    const { server, custody, daemon } = await setup();
    const warn = vi.spyOn(console, 'warn');
    const client = await E2eeWebClient.create(server.e2ee);
    server.e2ee.failRegistrations = 1;
    const paired = daemon();
    const { deviceId } = await paired.pair('pair-code', { verificationSecret: client.verificationSecret });
    expect(server.e2ee.registration(deviceId)).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toContain('E2EE member registration failed');
    const stored = state(custody)?.member;

    await paired.start();
    await until(() => server.e2ee.registration(deviceId) !== undefined, 'the registration retry');
    expect(server.e2ee.registration(deviceId)?.member).toEqual(stored);
    await client.approve(deviceId);
    await until(() => state(custody)?.anchor !== undefined, 'the member anchor');
  }, 10_000);

  it('re-walks the chain at restart and stores the newer head', async () => {
    const { server, custody, daemon } = await setup();
    const client = await E2eeWebClient.create(server.e2ee);
    const first = daemon();
    const { deviceId } = await first.pair('pair-code', { verificationSecret: client.verificationSecret });
    const device = await client.approve(deviceId);
    await first.start();
    await until(() => state(custody)?.anchor !== undefined, 'the member anchor');
    const anchor = state(custody)?.anchor;
    await first.stop();

    await client.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input', 'task-output'], members: [client.member.memberId, device.memberId].sort() });
    const reads = server.e2ee.chainReads;
    const second = daemon();
    await second.start();
    await until(() => (state(custody)?.head as { seq?: number } | undefined)?.seq === client.head!.seq, 'the newer head');
    expect(server.e2ee.chainReads).toBeGreaterThan(reads);
    expect(state(custody)?.anchor).toEqual(anchor);
    expect(state(custody)?.head).toEqual(client.head);
  });

  it('keeps E2EE off at restart when the Host rewinds the chain below the verified head', async () => {
    const { server, custody, daemon } = await setup();
    const warn = vi.spyOn(console, 'warn');
    const client = await E2eeWebClient.create(server.e2ee);
    const first = daemon();
    const { deviceId } = await first.pair('pair-code', { verificationSecret: client.verificationSecret });
    const device = await client.approve(deviceId);
    await client.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input'], members: [client.member.memberId, device.memberId].sort() });
    await first.start();
    await until(() => (state(custody)?.head as { seq?: number } | undefined)?.seq === 3, 'the head at seq 3');
    await first.stop();
    const verified = state(custody);

    server.e2ee.chain.splice(2);
    await daemon().start();
    await until(() => warn.mock.calls.flat().join('\n').includes('shorter than the verified head seq 3'), 'the rewind refusal');
    expect(state(custody)).toEqual(verified);
  });

  it('clears every member entry on unpair', async () => {
    const { server, custody, daemon } = await setup();
    const client = await E2eeWebClient.create(server.e2ee);
    const paired = daemon();
    await paired.pair('pair-code', { verificationSecret: client.verificationSecret });
    expect(custody.entries.size).toBe(3);
    await paired.unpair();
    expect(custody.entries.size).toBe(0);
  });

  it('keeps the device paired when the member entries cannot be deleted after the pairing is saved (#861 L4)', async () => {
    const { server, custody, daemon } = await setup();
    custody.delete = async () => { throw new Error('provider unavailable'); };
    const paired = daemon();
    await expect(paired.pair('pair-code')).rejects.toThrow(
      'device device-1 is paired, but the previous E2EE member entries could not be deleted: provider unavailable',
    );
    expect(server.pairRequests).toHaveLength(1);
    await paired.start();
    expect(paired.status().paired).toBe(true);
  });

  it('starts a service daemon whose member entries cannot be deleted after the pairing is saved (#861 L4)', async () => {
    const { custody, config } = await setup();
    custody.delete = async () => { throw new Error('provider unavailable'); };
    const service = createDaemonWithAdapters({ ...config, serviceEnrollment: { enabled: true } }, [new StubRuntimeAdapter('pi')]);
    daemons.push(service);
    await service.start();
    const enrollment = await connectControlClient({ storeDir: config.storeDir, productId: config.productId });
    if (!enrollment.ok) throw new Error('expected the enrollment control endpoint');
    await expect(enrollment.client.request('enrollment.pair', { pairingCode: 'pair-code' })).rejects.toMatchObject({
      code: 'internal_error', message: expect.stringContaining('device device-1 is paired, but the previous E2EE member entries could not be deleted'),
    });
    enrollment.client.close();
    await vi.waitFor(async () => {
      const conn = await connectControlClient({ storeDir: config.storeDir, productId: config.productId });
      expect(conn.ok).toBe(true);
      if (!conn.ok) return;
      try {
        const status = await conn.client.request<ControlStatusResult>('status');
        expect(status.paired).toBe(true);
        expect(status.lifecycle.phase).toBe('running');
      } finally {
        conn.client.close();
      }
    }, { timeout: 5_000 });
  }, 10_000);

  it('clears the previous member at a re-pair without a verification secret', async () => {
    const { server, custody, daemon } = await setup();
    const client = await E2eeWebClient.create(server.e2ee);
    const paired = daemon();
    await paired.pair('pair-code', { verificationSecret: client.verificationSecret });
    await paired.pair('pair-code-2');
    expect(custody.entries.size).toBe(0);
  });
});

describe('enrollment.pair params (E2d-1)', () => {
  it('accepts an optional verification secret and nothing else', () => {
    expect(parseEnrollmentPairParams({ pairingCode: 'code' })).toEqual({ pairingCode: 'code' });
    expect(parseEnrollmentPairParams({ pairingCode: 'code', verificationSecret: 'PV' })).toEqual({ pairingCode: 'code', verificationSecret: 'PV' });
    expect(parseEnrollmentPairParams({ pairingCode: 'code', verificationSecret: '' })).toBeUndefined();
    expect(parseEnrollmentPairParams({ pairingCode: 'code', verificationSecret: 7 })).toBeUndefined();
    expect(parseEnrollmentPairParams({ pairingCode: 'code', verificationSecret: 'A'.repeat(65) })).toBeUndefined();
    expect(parseEnrollmentPairParams({ pairingCode: 'code', pv: 'PV' })).toBeUndefined();
  });
});

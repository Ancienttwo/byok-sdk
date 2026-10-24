/**
 * #654 E2d-1: the start-time member resume (design §7.2 step 5, owner 10b,
 * 11b; E2d-e1, E2d-e7, E2d-e8), with short poll delays and a test clock.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthManager } from '../daemon/auth-manager';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { DeviceMemberRecords } from '../daemon/device-member-custody';
import { PAIRING_VERIFICATION_TTL_MS, enrollDeviceMember, resumeDeviceMember, type ResumeDeviceMemberOptions } from '../daemon/device-member';
import { StoredDeviceProofSigner } from '../daemon/device-proof-signer';
import { E2eeMemberClient } from '../daemon/e2ee-member-client';
import { enrollmentIdentityOf } from '../daemon/store';
import { InMemoryDeviceMemberCustody, testDeviceCredentials } from './fixtures/credential-backend';
import { E2eeWebClient } from './fixtures/e2ee-web-client';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const dirs: string[] = [];
let server: TestServer | undefined;

afterEach(async () => {
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A paired device on the test server, with member entries in a fresh in-memory custody. */
async function device() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-member-resume-'));
  dirs.push(root);
  server = await TestServer.start();
  const productId = `member-resume-${randomUUID()}`;
  const daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Member resume test', productId,
    serverUrl: server.url, storeDir: path.join(root, 'store'), workspaceRoot: path.join(root, 'workspace'),
  }, [new StubRuntimeAdapter('pi')]);
  const { deviceId } = await daemon.pair('pair-code');
  const record = (await testDeviceCredentials(productId).read())!;
  const auth = {
    readCurrent: async () => record,
    getValidAccessToken: async () => record.accessToken,
    handleUnauthorized: async () => record.accessToken,
  } as unknown as AuthManager;
  const identity = enrollmentIdentityOf(record);
  const client = new E2eeMemberClient({
    serverUrl: server.url,
    auth,
    signer: new StoredDeviceProofSigner({ auth, tenantId: identity.tenantId, productId, keyId: identity.proofKeyId, keyEpoch: identity.proofKeyEpoch }),
  });
  const custody = new InMemoryDeviceMemberCustody();
  const records = new DeviceMemberRecords(custody);
  const logs: string[] = [];
  const web = await E2eeWebClient.create(server.e2ee);
  const clock = { now: Date.now() };
  const base = { records, client, tenantId: record.tenantId, deviceId, log: (line: string) => logs.push(line), now: () => clock.now };
  await enrollDeviceMember({ ...base, verificationSecret: web.verificationSecret });
  const abort = new AbortController();
  const resume = (options: Partial<ResumeDeviceMemberOptions> = {}) =>
    resumeDeviceMember({ ...base, signal: abort.signal, minDelayMs: 5, maxDelayMs: 20, ...options });
  return { server: server!, deviceId, custody, records, logs, web, clock, abort, resume };
}

describe('device member resume (E2d-1)', () => {
  it('polls for the client MAC with backoff until it arrives', async () => {
    const { server, deviceId, web, resume, custody } = await device();
    const resumed = resume();
    while (server.e2ee.pairingMacReads < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    await web.approve(deviceId);
    const session = await resumed;
    expect(session?.member.deviceId).toBe(deviceId);
    expect(session?.state.head).toEqual(web.head);
    expect(session?.hashes).toEqual([expect.stringMatching(/^sha256:/u), web.head!.hash]);
    expect(custody.entries.has('pairing-verification')).toBe(false);
  });

  it('stops at the pv deadline and deletes pv (hard stop)', async () => {
    const { server, clock, resume, custody, logs } = await device();
    const resumed = resume();
    while (server.e2ee.pairingMacReads < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    clock.now += PAIRING_VERIFICATION_TTL_MS;
    expect(await resumed).toBeUndefined();
    expect(custody.entries.has('pairing-verification')).toBe(false);
    expect(logs.join('\n')).toContain('expired before the client confirmed it');
  });

  it('deletes an expired pv without a request', async () => {
    const { server, clock, resume, custody } = await device();
    clock.now += PAIRING_VERIFICATION_TTL_MS;
    const reads = server.e2ee.pairingMacReads;
    expect(await resume()).toBeUndefined();
    expect(server.e2ee.pairingMacReads).toBe(reads);
    expect(custody.entries.has('pairing-verification')).toBe(false);
  });

  it('stops at shutdown and keeps pv for the next start', async () => {
    const { server, abort, resume, custody } = await device();
    const resumed = resume();
    while (server.e2ee.pairingMacReads < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    abort.abort();
    expect(await resumed).toBeUndefined();
    expect(custody.entries.has('pairing-verification')).toBe(true);
  });

  it('waits past a client MAC that does not verify', async () => {
    const { server, deviceId, web, resume, logs } = await device();
    await web.approve(deviceId);
    const relay = { ...(await web.relayBody()), mac: 'A'.repeat(43) };
    server.e2ee.clientRelayPairingMac(deviceId, relay);
    const resumed = resume();
    while (server.e2ee.pairingMacReads < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(logs.join('\n')).toContain('does not verify');
    await web.relay(deviceId);
    expect((await resumed)?.state.head).toEqual(web.head);
  });

  it('fails closed when the chain lacks the add(device) the client confirmed', async () => {
    const { server, deviceId, web, resume, custody, logs } = await device();
    await web.approve(deviceId);
    server.e2ee.chain.splice(1);
    expect(await resume()).toBeUndefined();
    expect(logs.join('\n')).toContain('does not hold the add(device) entry');
    expect(custody.entries.has('pairing-verification')).toBe(false);
  });

  it('fails closed on a registration conflict', async () => {
    const { server, deviceId, resume, logs } = await device();
    const registered = server.e2ee.registrations.get(deviceId)!;
    registered[0] = { ...registered[0]!, member: { ...registered[0]!.member, kemEpoch: 2 } };
    expect(await resume()).toBeUndefined();
    expect(logs.join('\n')).toContain('e2ee_member_key_conflict');
  });

  it('retries a failed chain read', async () => {
    const { server, deviceId, web, resume } = await device();
    await web.approve(deviceId);
    server.e2ee.failChainReads = 2;
    expect((await resume())?.state.head).toEqual(web.head);
  });

  it('fails closed when the member keys no longer match the registered bundle (E2d-e8)', async () => {
    const { records, resume, logs, deviceId } = await device();
    const state = (await records.readState())!;
    await records.keys.loadOrCreate({ tenantId: state.tenantId, deviceId: 'another-device' });
    expect(await records.keys.load({ tenantId: state.tenantId, deviceId })).toBeUndefined();
    expect(await resume()).toBeUndefined();
    expect(logs.join('\n')).toContain('re-pair the device');
  });

  describe('restart re-walk (E2d-e7)', () => {
    async function anchored() {
      const setup = await device();
      await setup.web.approve(setup.deviceId);
      const first = await setup.resume();
      expect(first).toBeDefined();
      return { ...setup, member: first!.member };
    }

    it('applies the entries after the stored head and stores the new head', async () => {
      const { web, resume, records, member } = await anchored();
      await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input'], members: [web.member.memberId, member.memberId].sort() });
      const session = await resume();
      expect(session?.state.scopes.get('scope-a')?.members).toContain(member.memberId);
      expect(session?.hashes).toHaveLength(3);
      expect((await records.readState())?.head).toEqual(web.head);
    });

    it('refuses another history at the stored head seq', async () => {
      const { server, web, resume, logs, member } = await anchored();
      const anchorHead = web.head!;
      const members = [web.member.memberId, member.memberId].sort();
      await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input'], members });
      expect((await resume())?.state.head?.seq).toBe(3);
      // The Host swaps entry 3 for another validly signed entry at the same seq.
      server.e2ee.chain.splice(2);
      web.head = anchorHead;
      await web.append('scope-policy', { scopeId: 'scope-b', categories: ['task-input'], members });
      expect(await resume()).toBeUndefined();
      expect(logs.join('\n')).toContain('does not extend the verified head at seq 3');
    });

    it('refuses an invalid entry after the stored head', async () => {
      const { server, resume, logs } = await anchored();
      server.e2ee.clientAppend({ v: 1, tenantId: 'tenant-test', seq: 3, prev: null, op: 'remove', subject: {}, signer: 'x'.repeat(43), sig: 'A'.repeat(86) });
      expect(await resume()).toBeUndefined();
      expect(logs.join('\n')).toContain('after seq 2 is invalid');
    });

    it('is no member after its own removal', async () => {
      const { web, resume, logs, member } = await anchored();
      await web.append('remove', { memberId: member.memberId });
      expect(await resume()).toBeUndefined();
      expect(logs.join('\n')).toContain('no longer a current member');
    });
  });
});

/**
 * #654 E2d-2: the member keyring. It catches the chain up from the verified
 * head, and opens a scope key package only for a scope in the verified state
 * whose latest policy holds this device and the sender, with the sender key
 * from the verified chain.
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
import { enrollDeviceMember, resumeDeviceMember } from '../daemon/device-member';
import { StoredDeviceProofSigner } from '../daemon/device-proof-signer';
import { DeviceMemberKeyring } from '../daemon/e2ee-keyring';
import { E2eeMemberClient, MEMBER_OBJECT_MAX_BYTES } from '../daemon/e2ee-member-client';
import { enrollmentIdentityOf } from '../daemon/store';
import { InMemoryDeviceMemberCustody, testDeviceCredentials } from './fixtures/credential-backend';
import type { E2eeTestHost } from './fixtures/e2ee-test-host';
import { E2eeWebClient } from './fixtures/e2ee-web-client';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const dirs: string[] = [];
let server: TestServer | undefined;

afterEach(async () => {
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A paired, approved device member with its keyring, and the web client that approved it. */
async function member(keyringOptions: { readonly requestTimeoutMs?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-keyring-'));
  dirs.push(root);
  server = await TestServer.start();
  const productId = `keyring-${randomUUID()}`;
  const daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Keyring test', productId,
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
  const options = { records, client, tenantId: record.tenantId, deviceId, log: (line: string) => logs.push(line), signal: new AbortController().signal };
  await enrollDeviceMember({ ...options, verificationSecret: web.verificationSecret });
  const device = await web.approve(deviceId);
  const session = (await resumeDeviceMember({ ...options, minDelayMs: 5, maxDelayMs: 20 }))!;
  return { server: server!, web, device, custody, logs, keyring: new DeviceMemberKeyring(session, { ...options, ...keyringOptions }) };
}

function head(custody: InMemoryDeviceMemberCustody): unknown {
  return (JSON.parse(custody.entries.get('member-state')!) as { head?: unknown }).head;
}

/** A client member that is on no chain of this test. */
function stranger(): Promise<E2eeWebClient> {
  return E2eeWebClient.create({ clientAppend: () => undefined } as unknown as E2eeTestHost);
}

describe('device member keyring (E2d-2)', () => {
  it('catches up, then opens and caches the package of a scope that holds the device', async () => {
    const { server, web, device, custody, keyring } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    const fetched = await keyring.fetch('scope-a', 1);
    expect(fetched).toEqual({ ok: true, key: { scopeKey, keyId: expect.any(String), sender: web.member.memberId } });
    expect(keyring.session?.state.head).toEqual(web.head);
    expect(keyring.session?.hashes).toHaveLength(web.head!.seq);
    expect(head(custody)).toEqual(web.head);

    const reads = server.e2ee.packageReads;
    expect(await keyring.fetch('scope-a', 1)).toEqual(fetched);
    expect(server.e2ee.packageReads).toBe(reads);
    expect(keyring.cached('scope-a', 1)).toEqual(fetched.ok ? fetched.key : undefined);
    expect(keyring.cached('scope-a', 2)).toBeUndefined();
  });

  it('refuses a scope absent from the verified state, and one whose policy does not hold the device', async () => {
    const { server, web, device, keyring } = await member();
    server.e2ee.clientPutPackages(await web.sealPackage('scope-a', device, new Uint8Array(32).fill(7)));
    expect(await keyring.fetch('scope-a', 1)).toEqual({ ok: false, reason: 'scope_unknown' });
    await web.putScope('scope-b', []);
    server.e2ee.clientPutPackages(await web.sealPackage('scope-b', device, new Uint8Array(32).fill(7)));
    expect(await keyring.fetch('scope-b', 1)).toEqual({ ok: false, reason: 'not_a_scope_member' });
    expect(server.e2ee.packageReads).toBe(0);
  });

  it('reports a missing package, and refuses a sender outside the scope policy', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device], { epoch: 2 });
    expect(await keyring.fetch('scope-a', 1)).toEqual({ ok: false, reason: 'key_package_missing' });

    await web.append('scope-policy', { scopeId: 'scope-c', categories: ['task-input'], members: [web.member.memberId, device.memberId].sort() });
    server.e2ee.clientPutPackages(await (await stranger()).sealPackage('scope-c', device, new Uint8Array(32).fill(1)));
    expect(await keyring.fetch('scope-c', 1)).toEqual({ ok: false, reason: 'key_package_sender_invalid' });
  });

  it('refuses a package whose signature does not verify under the chain sender key', async () => {
    const { server, web, device, keyring } = await member();
    await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input'], members: [web.member.memberId, device.memberId].sort() });
    const pkg = await web.sealPackage('scope-a', device, new Uint8Array(32).fill(3));
    const other = await web.sealPackage('scope-a', device, new Uint8Array(32).fill(4));
    server.e2ee.clientPutPackages({ ...pkg, sig: other.sig });
    expect(await keyring.fetch('scope-a', 1)).toEqual({ ok: false, reason: 'key_package_signature_invalid' });
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
  });

  it('throws on a failed Host read and opens the package on the next call', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    server.e2ee.failPackageReads = 1;
    await expect(keyring.fetch('scope-a', 1)).rejects.toThrow(/HTTP 503/u);
    expect((await keyring.fetch('scope-a', 1)).ok).toBe(true);
  });

  it('ends the member and zeroes its keys at an invalid chain entry', async () => {
    const { server, web, device, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    const fetched = await keyring.fetch('scope-a', 1);
    if (!fetched.ok) throw new Error(fetched.reason);
    server.e2ee.clientAppend({ v: 1, tenantId: 'tenant-test', seq: web.head!.seq + 1, prev: web.head!.hash, op: 'remove', subject: {}, signer: web.member.memberId, sig: 'A'.repeat(86) });
    expect(await keyring.fetch('scope-a', 1)).toEqual({ ok: false, reason: 'member_lost' });
    expect(keyring.session).toBeUndefined();
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
    expect(fetched.key.scopeKey.every((byte) => byte === 0)).toBe(true);
    expect(logs.join('\n')).toContain('is invalid (member_chain_');
  });

  it('drops a cached key once a policy drops the device, and once the scope is shredded', async () => {
    const { web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await web.putScope('scope-b', [device]);
    const [first, second] = [await keyring.fetch('scope-a', 1), await keyring.fetch('scope-b', 1)];
    if (!first.ok || !second.ok) throw new Error('the packages did not open');

    await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input'], members: [web.member.memberId] });
    await web.append('shred', { scopeId: 'scope-b' });
    expect(keyring.cached('scope-a', 1)).toBeDefined();
    await keyring.catchUp();
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
    expect(keyring.cached('scope-b', 1)).toBeUndefined();
    expect(first.key.scopeKey.every((byte) => byte === 0)).toBe(true);
    expect(second.key.scopeKey.every((byte) => byte === 0)).toBe(true);
    expect(await keyring.fetch('scope-a', 1)).toEqual({ ok: false, reason: 'not_a_scope_member' });
    expect(await keyring.fetch('scope-b', 1)).toEqual({ ok: false, reason: 'scope_unknown' });
  });

  it('drops a cached key once the policy drops its sender', async () => {
    const { web, device, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device, helper.member]);
    const fetched = await keyring.fetch('scope-a', 1);
    if (!fetched.ok) throw new Error(fetched.reason);
    await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input'], members: [device.memberId, helper.member.memberId].sort() });
    await keyring.catchUp();
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
    expect(fetched.key.scopeKey.every((byte) => byte === 0)).toBe(true);
  });

  it('refuses a package that is not an object without throwing', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    server.e2ee.packageResponse = [null];
    expect(await keyring.fetch('scope-a', 1)).toEqual({ ok: false, reason: 'key_package_invalid' });
  });

  it('does not keep a key whose scope was shredded while its package was read', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    let release!: () => void;
    server.e2ee.holdPackageReads = new Promise<void>((resolve) => { release = resolve; });
    const fetching = keyring.fetch('scope-a', 1);
    while (server.e2ee.packageReads === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await web.append('shred', { scopeId: 'scope-a' });
    await keyring.catchUp();
    release();
    expect(await fetching).toEqual({ ok: false, reason: 'scope_unknown' });
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
  });

  it('cuts off a hung chain read and a hung package read after the request timeout (#863 M1)', async () => {
    const { server, web, device, keyring } = await member({ requestTimeoutMs: 50 });
    await web.putScope('scope-a', [device]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      server.e2ee.holdChainReads = held;
      await expect(keyring.catchUp()).rejects.toMatchObject({ name: 'TimeoutError' });
      server.e2ee.holdChainReads = undefined;
      server.e2ee.holdPackageReads = held;
      await expect(keyring.fetch('scope-a', 1)).rejects.toMatchObject({ name: 'TimeoutError' });
      server.e2ee.holdPackageReads = undefined;
      expect((await keyring.fetch('scope-a', 1)).ok).toBe(true);
    } finally {
      release();
    }
  });

  it('refuses an oversized key package body and a two-package answer as final (#863 M1)', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    server.e2ee.packageResponse = [{ pad: 'x'.repeat(MEMBER_OBJECT_MAX_BYTES) }];
    await expect(keyring.fetch('scope-a', 1)).rejects.toMatchObject({
      name: 'E2eeMemberClientError', final: true, message: `key package read returned a body larger than ${MEMBER_OBJECT_MAX_BYTES} bytes`,
    });
    server.e2ee.packageResponse = [{}, {}];
    await expect(keyring.fetch('scope-a', 1)).rejects.toMatchObject({
      name: 'E2eeMemberClientError', final: true, message: 'key package read returned more than one package',
    });
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
  });

  it('ends the member when the chain removes this device', async () => {
    const { web, device, logs, keyring } = await member();
    await web.append('remove', { memberId: device.memberId });
    await keyring.catchUp();
    expect(keyring.session).toBeUndefined();
    expect(logs.join('\n')).toContain('no longer a current member');
  });
});

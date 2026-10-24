/**
 * #654 E2d-2 to E2d-4: the member keyring. It catches the chain up from the verified
 * head, and opens a scope key package only for a scope in the verified state
 * whose latest policy holds this device and the sender, with the sender key
 * from the verified chain.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMemberKeyBundle,
  generateMemberKeyRecord,
  openMemberKeyRecord,
  openScopeKeyPackage,
  type MemberKeyBundleV1,
  type MemberKeys,
  type SealedContentHeaderV1,
} from '@byok-sdk/core/sealed-payload';
import { E2EE_SCOPE_KEY_PACKAGE_PUT_MAX } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthManager } from '../daemon/auth-manager';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { DeviceMemberRecords } from '../daemon/device-member-custody';
import { enrollDeviceMember, resumeDeviceMember } from '../daemon/device-member';
import { StoredDeviceProofSigner } from '../daemon/device-proof-signer';
import { DeviceMemberKeyring } from '../daemon/e2ee-keyring';
import { E2eeMemberClient, MEMBER_CHAIN_PAGE_MAX_BYTES, MEMBER_OBJECT_MAX_BYTES } from '../daemon/e2ee-member-client';
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

  it('refuses a chain page body over its byte cap as final', async () => {
    const { server, keyring } = await member();
    server.e2ee.chainResponse = [{ pad: 'x'.repeat(MEMBER_CHAIN_PAGE_MAX_BYTES) }];
    await expect(keyring.catchUp()).rejects.toMatchObject({
      name: 'E2eeMemberClientError', final: true, message: `member chain read returned a body larger than ${MEMBER_CHAIN_PAGE_MAX_BYTES} bytes`,
    });
  });

  it('lets the status decide an error whose body is over the 1 KiB cap', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    server.e2ee.rejectPackageReads = 403;
    server.e2ee.rejectPackageBody = { error: 'forbidden', pad: 'x'.repeat(2048) };
    await expect(keyring.fetch('scope-a', 1)).rejects.toMatchObject({
      name: 'E2eeMemberClientError', final: true, status: 403, code: undefined, message: 'key package read failed with HTTP 403',
    });
  });

  it('ends the member when the chain removes this device', async () => {
    const { web, device, logs, keyring } = await member();
    await web.append('remove', { memberId: device.memberId });
    await keyring.catchUp();
    expect(keyring.session).toBeUndefined();
    expect(logs.join('\n')).toContain('no longer a current member');
  });
});

/** A member bundle of another device, added by the web client. */
async function otherDevice(web: E2eeWebClient) {
  const keys = (await openMemberKeyRecord(await generateMemberKeyRecord({ tenantId: 'tenant-test', deviceId: 'device-other' })))!;
  const bundle = await createMemberKeyBundle({
    signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey, kemPublicJwk: keys.kem.publicJwk, kemEpoch: keys.kem.epoch, deviceId: 'device-other',
  });
  await web.append('add', { member: bundle });
  return bundle;
}

function header(scopeId: string, epoch: number, chainHead: { seq: number; hash: string }, sender: string): SealedContentHeaderV1 {
  return { scope: { id: scopeId, epoch }, chainHead, sender } as SealedContentHeaderV1;
}

/** Open the stored package of one scope epoch for `recipient` with the KEM key pair given; it throws when there is none or it does not open. */
async function openStored(host: E2eeTestHost, sender: MemberKeyBundleV1, scopeId: string, epoch: number, recipient: string, kem: MemberKeys['kem']): Promise<Uint8Array> {
  const pkg = host.packages.find((stored) => stored.scopeId === scopeId && stored.epoch === epoch && stored.recipient === recipient);
  const opened = await openScopeKeyPackage({
    package: pkg,
    expected: { tenantId: 'tenant-test', scopeId, epoch },
    recipient: { memberId: recipient, kemPublicJwk: kem.publicJwk, kemPrivateKey: kem.privateKey },
    senderSigningPublicJwk: sender.signingPublicJwk,
  });
  if (!opened.ok) throw new Error(`the package of epoch ${epoch} does not open: ${opened.reason}`);
  return opened.scopeKey;
}

describe('device member keyring sealing rules (E2d-3)', () => {
  it('refuses a scope whose policy holds another device (§7.9 requirement 1)', async () => {
    const { web, device, keyring } = await member();
    const other = await otherDevice(web);
    await web.putScope('scope-a', [device, other]);
    expect(await keyring.scopeCategories('scope-a')).toBeUndefined();
    expect(await keyring.fetch('scope-a', 1)).toEqual({ ok: false, reason: 'scope_shared_with_device' });
    await web.putScope('scope-b', [device], { categories: ['task-output'] });
    expect(await keyring.scopeCategories('scope-b')).toEqual(['task-output']);
  });

  it('accepts content only from a current member of the scope policy at a head on the verified chain', async () => {
    const { web, device, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    const sender = web.member.memberId;
    expect(await keyring.acceptHeader(header('scope-a', 1, { seq: web.head!.seq, hash: `sha256:${'0'.repeat(64)}` }, sender))).toBe(false);
    expect(logs.at(-1)).toContain('not on the verified chain');
    // The policy did not exist at seq 2 (the device's add).
    expect(await keyring.acceptHeader(header('scope-a', 1, { seq: 2, hash: keyring.session!.hashes[1]! }, sender))).toBe(false);
    expect(logs.at(-1)).toContain('not in the scope policy at its chain head');
    expect(await keyring.acceptHeader(header('scope-a', 1, web.head!, (await stranger()).member.memberId))).toBe(false);
    expect(logs.at(-1)).toContain('no current member');
    expect(await keyring.acceptHeader(header('scope-a', 1, web.head!, sender))).toBe(true);
  });

  it('catches up when the content head is ahead of the verified head', async () => {
    const { web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    expect(keyring.session!.state.head!.seq).toBeLessThan(web.head!.seq);
    expect(await keyring.acceptHeader(header('scope-a', 1, web.head!, web.member.memberId))).toBe(true);
    expect(keyring.session!.state.head).toEqual(web.head);
  });

  it('seals only at an epoch with a freshness point and no member loss after it (§50d)', async () => {
    const { server, web, device, keyring } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    await keyring.catchUp();

    expect(await keyring.acceptHeader(header('scope-a', 1, web.head!, web.member.memberId))).toBe(true);
    expect(await keyring.sealingKey('scope-a', 1)).toEqual({ scopeKey, epoch: 1, sender: device.memberId, chainHead: web.head });

    // Epoch 2, fresh at a later head: the newest fresh epoch wins.
    const second = new Uint8Array(32).fill(9);
    server.e2ee.clientPutPackages(await web.sealPackage('scope-a', device, second, 2));
    const other = await otherDevice(web);
    await keyring.catchUp();
    expect(await keyring.acceptHeader(header('scope-a', 2, web.head!, web.member.memberId))).toBe(true);
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(2);

    // A remove of a scope member after the point makes the epoch stale; a member outside the scope does not.
    await web.append('remove', { memberId: other.memberId });
    await keyring.catchUp();
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(2);
    await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input', 'task-output'], members: [device.memberId] });
    await keyring.catchUp();
    expect(await keyring.sealingKey('scope-a', 1)).toBeUndefined();
  });

  it('hands out a copy of the key, which a later purge does not zero', async () => {
    const { web, device, keyring } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    const opening = (await keyring.openingKey({ id: 'scope-a', epoch: 1 }))!;
    await web.append('shred', { scopeId: 'scope-a' });
    await keyring.catchUp();
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
    expect(opening).toEqual(scopeKey);
  });

  it('makes an epoch stale when a scope member is removed after its point', async () => {
    const { server, web, device, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device, helper.member]);
    await keyring.catchUp();
    expect(await keyring.acceptHeader(header('scope-a', 1, web.head!, web.member.memberId))).toBe(true);
    expect(await keyring.sealingKey('scope-a', 1)).toBeDefined();
    await web.append('remove', { memberId: helper.member.memberId });
    await keyring.catchUp();
    // The device rotates past the stale epoch and leaves the removed member out (E2d-4).
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(2);
    expect(server.e2ee.devicePuts.at(-1)!.map((pkg) => pkg.recipient).sort()).toEqual([device.memberId, web.member.memberId].sort());
  });
});

describe('device member keyring rotation (E2d-4)', () => {
  it('rotates a scope with no fresh epoch: a new key for every current scope member, fresh at the verified head', async () => {
    const { server, web, device, logs, keyring } = await member();
    const first = await web.putScope('scope-a', [device], { categories: ['task-output'] });
    await keyring.catchUp();
    const sealing = (await keyring.sealingKey('scope-a', 1))!;
    expect(sealing).toMatchObject({ epoch: 2, sender: device.memberId, chainHead: web.head });
    expect(sealing.scopeKey).not.toEqual(first);
    expect(await web.openPackage('scope-a', 2, device)).toEqual(sealing.scopeKey);
    const put = server.e2ee.devicePuts.at(-1)!;
    expect(put.map((pkg) => pkg.recipient).sort()).toEqual([device.memberId, web.member.memberId].sort());
    expect(new Set(put.map((pkg) => pkg.sender))).toEqual(new Set([device.memberId]));
    expect(logs.at(-1)).toContain('rotated scope "scope-a" to epoch 2 for 2 members');

    // The epoch is fresh now: the next seal uses it, and the device's own package opens.
    expect(await keyring.sealingKey('scope-a', 1)).toEqual(sealing);
    expect(server.e2ee.devicePuts).toHaveLength(1);
    expect(await keyring.fetch('scope-a', 2)).toEqual({ ok: true, key: { scopeKey: sealing.scopeKey, keyId: put[0]!.keyId, sender: device.memberId } });
  });

  it('rotates to the epoch after the newest one the Host holds for this member', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device], { epoch: 3 });
    await keyring.catchUp();
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(4);
    expect((await keyring.sealingKey('scope-a', 5))?.epoch).toBe(6);
    expect(server.e2ee.devicePuts.map((put) => put[0]!.epoch)).toEqual([4, 6]);
  });

  it('puts the packages of a scope with more members than one put takes in bounded puts', async () => {
    const { server, web, device, keyring } = await member();
    const clients = await Promise.all(Array.from({ length: E2EE_SCOPE_KEY_PACKAGE_PUT_MAX }, () => stranger()));
    for (const client of clients) await web.append('add', { member: client.member });
    await web.putScope('scope-a', [device, ...clients.map((client) => client.member)]);
    await keyring.catchUp();
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(2);
    expect(server.e2ee.devicePuts.map((put) => put.length)).toEqual([E2EE_SCOPE_KEY_PACKAGE_PUT_MAX, 2]);
    expect(server.e2ee.devicePuts[0]![0]!.recipient).toBe(device.memberId);
  });

  it('moves past an epoch whose first put landed and a later one failed', async () => {
    const { server, web, device, keyring } = await member();
    const clients = await Promise.all(Array.from({ length: E2EE_SCOPE_KEY_PACKAGE_PUT_MAX }, () => stranger()));
    for (const client of clients) await web.append('add', { member: client.member });
    await web.putScope('scope-a', [device, ...clients.map((client) => client.member)]);
    await keyring.catchUp();
    const put = server.e2ee.devicePuts;
    // The second put of the rotation fails after the first stored.
    const original = server.e2ee.handle.bind(server.e2ee);
    let posts = 0;
    server.e2ee.handle = async (req, res, url) => {
      if (req.method === 'POST' && url.pathname.endsWith('/key-packages') && ++posts === 2) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unavailable' }));
        return true;
      }
      return original(req, res, url);
    };
    await expect(keyring.sealingKey('scope-a', 1)).rejects.toThrow(/HTTP 503/u);
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(3);
    expect(put.map((batch) => batch[0]!.epoch)).toEqual([2, 3, 3]);
  });

  it('rotates once for concurrent seals of one scope', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    const [left, right] = await Promise.all([keyring.sealingKey('scope-a', 1), keyring.sealingKey('scope-a', 1)]);
    expect(server.e2ee.devicePuts).toHaveLength(1);
    expect(left).toEqual(right);
    expect(left!.scopeKey).not.toBe(right!.scopeKey);
  });

  it('rotates again for a concurrent seal that needs a later epoch than the shared rotation', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    const [low, high] = await Promise.all([keyring.sealingKey('scope-a', 1), keyring.sealingKey('scope-a', 5)]);
    expect(low?.epoch).toBe(2);
    expect(high?.epoch).toBe(6);
    expect(server.e2ee.devicePuts.map((put) => put[0]!.epoch)).toEqual([2, 6]);
  });

  it('fails closed when the Host holds the new epoch under another key, and throws on a failed put', async () => {
    const { server, web, device, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackagePuts = new Promise<void>((resolve) => { release = resolve; });
    const sealing = keyring.sealingKey('scope-a', 1);
    while (server.e2ee.devicePuts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    server.e2ee.clientPutPackages(await web.sealPackage('scope-a', device, new Uint8Array(32).fill(5), 2));
    release();
    expect(await sealing).toBeUndefined();
    expect(logs.join('\n')).toContain('the Host holds epoch 2 of scope "scope-a" under another key');
    expect(keyring.cached('scope-a', 2)).toBeUndefined();

    server.e2ee.holdPackagePuts = undefined;
    server.e2ee.failPackageReads = 1;
    await expect(keyring.sealingKey('scope-a', 1)).rejects.toThrow(/HTTP 503/u);
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(3);
  });

  it('does not seal at a new epoch that a remove made stale while its packages were put', async () => {
    const { server, web, device, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device, helper.member]);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackagePuts = new Promise<void>((resolve) => { release = resolve; });
    const sealing = keyring.sealingKey('scope-a', 1);
    while (server.e2ee.devicePuts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await web.append('remove', { memberId: helper.member.memberId });
    await keyring.catchUp();
    release();
    expect(await sealing).toBeUndefined();
    server.e2ee.holdPackagePuts = undefined;
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(3);
    expect(server.e2ee.devicePuts.at(-1)!.map((pkg) => pkg.recipient)).not.toContain(helper.member.memberId);
  });

  it('does not rotate a scope it may not use, or one whose only current member is this device', async () => {
    const { server, web, device, logs, keyring } = await member();
    const other = await otherDevice(web);
    await web.putScope('scope-a', [device, other]);
    await web.putScope('scope-b', [device]);
    await web.append('shred', { scopeId: 'scope-b' });
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    // A policy update leaves only the device; another leaves the device and a member removed later.
    await web.putScope('scope-c', [device], { categories: ['task-output'] });
    await web.append('scope-policy', { scopeId: 'scope-c', categories: ['task-output'], members: [device.memberId] });
    await web.putScope('scope-d', [device, helper.member], { categories: ['task-output'] });
    await web.append('scope-policy', { scopeId: 'scope-d', categories: ['task-output'], members: [device.memberId, helper.member.memberId].sort() });
    await web.append('remove', { memberId: helper.member.memberId });
    await keyring.catchUp();
    expect(await keyring.sealingKey('scope-a', 1)).toBeUndefined();
    expect(await keyring.sealingKey('scope-b', 1)).toBeUndefined();
    expect(await keyring.sealingKey('scope-c', 1)).toBeUndefined();
    expect(await keyring.sealingKey('scope-d', 1)).toBeUndefined();
    expect(logs.join('\n')).toContain('scope "scope-d" has no current member but this device; it is not rotated');
    expect(server.e2ee.devicePuts).toHaveLength(0);
  });
  it('does not seal at a new epoch that a scope member add made stale while its packages were put', async () => {
    const { server, web, device, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackagePuts = new Promise<void>((resolve) => { release = resolve; });
    const sealing = keyring.sealingKey('scope-a', 1);
    while (server.e2ee.devicePuts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const members = [device.memberId, web.member.memberId, helper.member.memberId].sort();
    await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input', 'task-output'], members });
    await keyring.catchUp();
    release();
    expect(await sealing).toBeUndefined();
    server.e2ee.holdPackagePuts = undefined;
    const next = (await keyring.sealingKey('scope-a', 1))!;
    expect(next.epoch).toBe(3);
    expect(await openStored(server.e2ee, device, 'scope-a', 3, helper.member.memberId, helper.keys.kem)).toEqual(next.scopeKey);
  });

  it('does not seal at a new epoch that a member KEM rotation made stale while its packages were put', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackagePuts = new Promise<void>((resolve) => { release = resolve; });
    const sealing = keyring.sealingKey('scope-a', 1);
    while (server.e2ee.devicePuts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const kem = (await openMemberKeyRecord(await generateMemberKeyRecord({ tenantId: 'tenant-test' })))!.kem;
    const kemEpoch = web.member.kemEpoch + 1;
    const rotated = await createMemberKeyBundle({
      signingPublicJwk: web.keys.signing.publicJwk, signingPrivateKey: web.keys.signing.privateKey, kemPublicJwk: kem.publicJwk, kemEpoch,
    });
    await web.append('rotate', { memberId: web.member.memberId, kemPublicJwk: rotated.kemPublicJwk, kemEpoch, kemSig: rotated.kemSig });
    await keyring.catchUp();
    release();
    expect(await sealing).toBeUndefined();
    server.e2ee.holdPackagePuts = undefined;
    const next = (await keyring.sealingKey('scope-a', 1))!;
    expect(next.epoch).toBe(3);
    expect(await openStored(server.e2ee, device, 'scope-a', 3, web.member.memberId, kem)).toEqual(next.scopeKey);
    await expect(openStored(server.e2ee, device, 'scope-a', 3, web.member.memberId, web.keys.kem)).rejects.toThrow(/does not open/u);
  });
  it('rotates above an epoch whose put conflicted with another client that left this device out', async () => {
    const { server, web, device, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    // Another client put epoch 2 for itself only, so the device's read of epoch 2 is empty.
    server.e2ee.clientPutPackages(await web.sealPackage('scope-a', web.member, new Uint8Array(32).fill(5), 2));
    expect(await keyring.sealingKey('scope-a', 1)).toBeUndefined();
    expect(logs.join('\n')).toContain('the Host holds epoch 2 of scope "scope-a" under another key');
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(3);
    expect(server.e2ee.devicePuts.map((put) => put[0]!.epoch)).toEqual([2, 3]);
  });
  it('reads four epochs per rotation and fails closed when the Host holds a package at the top one', async () => {
    const { server, web, device, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    const reads = server.e2ee.packageReads;
    server.e2ee.packageResponse = [{}];
    expect(await keyring.sealingKey('scope-a', 1)).toBeUndefined();
    expect(server.e2ee.packageReads - reads).toBe(4);
    expect(logs.join('\n')).toContain('the Host holds epoch 5 of scope "scope-a", beyond the epochs this device checks');
    // The next decision reads the four epochs above.
    expect(await keyring.sealingKey('scope-a', 1)).toBeUndefined();
    expect(server.e2ee.packageReads - reads).toBe(8);
    expect(logs.join('\n')).toContain('the Host holds epoch 9 of scope "scope-a"');
    server.e2ee.packageResponse = undefined;
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(10);
    expect(server.e2ee.devicePuts.map((put) => put[0]!.epoch)).toEqual([10]);
  });

  it('cuts off a hung key package put, so the next seal of the scope rotates again', async () => {
    const { server, web, device, keyring } = await member({ requestTimeoutMs: 50 });
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackagePuts = new Promise<void>((resolve) => { release = resolve; });
    try {
      await expect(keyring.sealingKey('scope-a', 1)).rejects.toMatchObject({ name: 'TimeoutError' });
      server.e2ee.holdPackagePuts = undefined;
      expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(2);
    } finally {
      release();
    }
  });
});

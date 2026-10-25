/**
 * #654 E2d-2 to E2d-5: the member keyring. It catches the chain up from the verified
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
import { TENANT_ID_MAX_LENGTH } from '@byok-sdk/core';
import { E2EE_SCOPE_ID_MAX_LENGTH, E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX, E2EE_SCOPE_KEY_PACKAGE_PUT_MAX } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthManager } from '../daemon/auth-manager';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { DeviceMemberRecords } from '../daemon/device-member-custody';
import { enrollDeviceMember, resumeDeviceMember } from '../daemon/device-member';
import { StoredDeviceProofSigner } from '../daemon/device-proof-signer';
import { DeviceMemberKeyring } from '../daemon/e2ee-keyring';
import {
  E2eeMemberClient, MEMBER_CHAIN_PAGE_MAX_BYTES, MEMBER_OBJECT_MAX_BYTES, MEMBER_PACKAGE_PAGE_MAX_BYTES,
} from '../daemon/e2ee-member-client';
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
async function member(keyringOptions: { readonly requestTimeoutMs?: number; readonly kemRotation?: () => boolean } = {}) {
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
  const resume = () => resumeDeviceMember({ ...options, signal: new AbortController().signal, minDelayMs: 5, maxDelayMs: 20 });
  /** A new run of the same member: its session from custody, and a new keyring. */
  const restart = async () => new DeviceMemberKeyring((await resume())!, { ...options, ...keyringOptions });
  const session = (await resume())!;
  return { server: server!, web, device, custody, logs, options, session, keyring: new DeviceMemberKeyring(session, { ...options, ...keyringOptions }), restart, resume };
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

  it('refuses a page of own key packages out of epoch order, past one page, or with no scope head or one below its packages, as final', async () => {
    const { server, web, device, options } = await member();
    await web.putScope('scope-a', [device]);
    const bodies = [
      [{ packages: [{ epoch: 2 }, { epoch: 2 }], scopeHeadEpoch: 2 }, 'packages out of epoch order'],
      [{ packages: [{ epoch: 0 }], scopeHeadEpoch: 1 }, 'packages out of epoch order'],
      [{ packages: Array.from({ length: E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX + 1 }, (_, index) => ({ epoch: index + 1 })), scopeHeadEpoch: 17 }, 'no package list of at most one page'],
      [{ packages: [], scopeHeadEpoch: 0 }, 'no scope head'],
      [{ packages: [] }, 'no scope head'],
      [{ packages: [{ epoch: 1 }], scopeHeadEpoch: null }, 'a scope head below its packages'],
      [{ packages: [{ epoch: 3 }], scopeHeadEpoch: 2 }, 'a scope head below its packages'],
    ] as const;
    for (const [body, why] of bodies) {
      server.e2ee.pageResponse = body;
      await expect(options.client.readOwnKeyPackages('scope-a', 0)).rejects.toMatchObject({
        name: 'E2eeMemberClientError', final: true, message: `key package page read returned ${why}`,
      });
    }
    server.e2ee.pageResponse = undefined;
    const page = await options.client.readOwnKeyPackages('scope-a', 0);
    expect([...page.packages.keys()]).toEqual([1]);
    expect(page.scopeHeadEpoch).toBe(1);
  });

  it('reads a full page of packages whose ids are the longest the Host allows, all escaped, and refuses a larger page body as final', async () => {
    const { server, web, device, options } = await member();
    await web.putScope('scope-a', [device]);
    const pkg = await web.sealPackage('scope-a', device, new Uint8Array(32).fill(3));
    // Each package repeats its ids; a control character is escaped as `\uXXXX`, six bytes per unit.
    const packages = Array.from({ length: E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX }, (_, index) => ({
      ...pkg, epoch: index + 1, tenantId: '\u0001'.repeat(TENANT_ID_MAX_LENGTH), scopeId: '\u0001'.repeat(E2EE_SCOPE_ID_MAX_LENGTH),
    }));
    server.e2ee.pageResponse = { packages, scopeHeadEpoch: E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX };
    expect(Buffer.byteLength(JSON.stringify(server.e2ee.pageResponse))).toBeGreaterThan(64 * 1024);
    const page = await options.client.readOwnKeyPackages('scope-a', 0);
    expect(page.packages.size).toBe(E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX);
    server.e2ee.pageResponse = { packages: [{ epoch: 1, pad: 'x'.repeat(MEMBER_PACKAGE_PAGE_MAX_BYTES) }], scopeHeadEpoch: 1 };
    await expect(options.client.readOwnKeyPackages('scope-a', 0)).rejects.toMatchObject({
      name: 'E2eeMemberClientError', final: true, message: `key package page read returned a body larger than ${MEMBER_PACKAGE_PAGE_MAX_BYTES} bytes`,
    });
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
    recipient: { memberId: recipient, kemPublicJwk: kem.publicJwk, kemPrivateKey: kem.privateKey, kemEpoch: kem.epoch },
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

  it.each([200, 503] as const)('zeroes a key a notice cached at the new epoch while the second put answers %i, but never the new key or a copy a seal holds', async (status) => {
    const { server, web, device, keyring } = await member();
    const clients = await Promise.all(Array.from({ length: E2EE_SCOPE_KEY_PACKAGE_PUT_MAX }, () => stranger()));
    for (const client of clients) await web.append('add', { member: client.member });
    await web.putScope('scope-a', [device, ...clients.map((client) => client.member)]);
    await keyring.catchUp();
    // While the second put is in flight, the notice of this device's package from the first put caches the epoch's key, and a seal copies it.
    let cached!: Uint8Array;
    let copy: Uint8Array | undefined;
    const original = server.e2ee.handle.bind(server.e2ee);
    let posts = 0;
    server.e2ee.handle = async (req, res, url) => {
      if (req.method === 'POST' && url.pathname.endsWith('/key-packages') && ++posts === 2) {
        const fetched = await keyring.fetch('scope-a', 2);
        if (fetched.ok) cached = fetched.key.scopeKey;
        copy = await keyring.openingKey({ id: 'scope-a', epoch: 2 });
        if (status === 503) {
          res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unavailable' }));
          return true;
        }
      }
      return original(req, res, url);
    };
    const sealing = keyring.sealingKey('scope-a', 1);
    if (status === 503) {
      await expect(sealing).rejects.toThrow(/HTTP 503/u);
      expect(keyring.cached('scope-a', 2)).toBeUndefined();
    } else {
      const key = (await sealing)!;
      expect(key.epoch).toBe(2);
      expect(key.scopeKey).toEqual(await openStored(server.e2ee, device, 'scope-a', 2, device.memberId, keyring.session!.keys.kem));
      expect(keyring.cached('scope-a', 2)!.scopeKey).not.toBe(cached);
    }
    expect(posts).toBe(2);
    expect(cached.every((byte) => byte === 0)).toBe(true);
    expect(copy).toEqual(await openStored(server.e2ee, device, 'scope-a', 2, device.memberId, keyring.session!.keys.kem));
    expect(copy!.some((byte) => byte !== 0)).toBe(true);
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

  it('zeroes a key cached at the new epoch when the Host refuses the put as a conflict, and fetches it again on the next open', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackagePuts = new Promise<void>((resolve) => { release = resolve; });
    const sealing = keyring.sealingKey('scope-a', 1);
    while (server.e2ee.devicePuts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const other = new Uint8Array(32).fill(5);
    server.e2ee.clientPutPackages(await web.sealPackage('scope-a', device, other, 2));
    // The notice of the other client's package caches its key while the device's put is held.
    const fetched = await keyring.fetch('scope-a', 2);
    if (!fetched.ok) throw new Error(fetched.reason);
    expect(fetched.key.scopeKey).toEqual(other);
    release();
    expect(await sealing).toBeUndefined();
    expect(fetched.key.scopeKey.every((byte) => byte === 0)).toBe(true);
    expect(keyring.cached('scope-a', 2)).toBeUndefined();
    server.e2ee.holdPackagePuts = undefined;
    expect(await keyring.openingKey({ id: 'scope-a', epoch: 2 })).toEqual(other);
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

  it('rotates again after a scope member add, even when later content at the rotated epoch moved its point past the add', async () => {
    const { server, web, device, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(2);
    const members = [device.memberId, web.member.memberId, helper.member.memberId].sort();
    await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input', 'task-output'], members });
    await keyring.catchUp();
    // The web client seals at epoch 2 after the add: the epoch's point moves past it.
    expect(await keyring.acceptHeader(header('scope-a', 2, web.head!, web.member.memberId))).toBe(true);
    const next = (await keyring.sealingKey('scope-a', 1))!;
    expect(next.epoch).toBe(3);
    expect(await openStored(server.e2ee, device, 'scope-a', 3, helper.member.memberId, helper.keys.kem)).toEqual(next.scopeKey);
  });

  it('does not seal at a new epoch whose put the Host refuses after a member KEM rotation, and wraps the epoch to the new KEM key next', async () => {
    const { server, web, device, logs, keyring } = await member();
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
    expect(logs.join('\n')).toContain('the Host holds a newer KEM key of a member of scope "scope-a"; output is not sealed');
    expect(server.e2ee.packages.filter((pkg) => pkg.epoch === 2)).toEqual([]);
    expect(keyring.cached('scope-a', 2)).toBeUndefined();
    server.e2ee.holdPackagePuts = undefined;
    const next = (await keyring.sealingKey('scope-a', 1))!;
    expect(next.epoch).toBe(2);
    expect(await openStored(server.e2ee, device, 'scope-a', 2, web.member.memberId, { ...kem, epoch: kemEpoch })).toEqual(next.scopeKey);
    await expect(openStored(server.e2ee, device, 'scope-a', 2, web.member.memberId, { ...web.keys.kem, epoch: kemEpoch })).rejects.toThrow(/does not open/u);
  });
  it('rotates above the scope head, where the Host holds no package of this member', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    // Another client put epoch 2 for itself only.
    server.e2ee.clientPutPackages(await web.sealPackage('scope-a', web.member, new Uint8Array(32).fill(5), 2));
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(3);
    expect(server.e2ee.devicePuts.map((put) => put[0]!.epoch)).toEqual([3]);
  });

  it('rotates above an epoch whose put conflicted with another client that left this device out', async () => {
    const { server, web, device, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    // Another client puts epoch 2 for itself only, after the device read the scope head.
    const other = await web.sealPackage('scope-a', web.member, new Uint8Array(32).fill(5), 2);
    const handle = server.e2ee.handle.bind(server.e2ee);
    let landed = false;
    server.e2ee.handle = async (req, res, url) => {
      if (!landed && req.method === 'POST' && url.pathname.endsWith('/key-packages')) landed = server.e2ee.clientPutPackages(other);
      return handle(req, res, url);
    };
    expect(await keyring.sealingKey('scope-a', 1)).toBeUndefined();
    expect(landed).toBe(true);
    expect(logs.join('\n')).toContain('the Host holds epoch 2 of scope "scope-a" under another key');
    // A head read that lags the conflict: the device still rotates above the epoch it found taken.
    server.e2ee.pageResponse = { packages: [], scopeHeadEpoch: 1 };
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(3);
    expect(server.e2ee.devicePuts.map((put) => put[0]!.epoch)).toEqual([2, 3]);
  });
  it('reads the scope head in one page read per rotation and rotates to the epoch after it', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    const reads = server.e2ee.pageReads;
    server.e2ee.pageResponse = { packages: [], scopeHeadEpoch: 9 };
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(10);
    expect(server.e2ee.pageReads - reads).toBe(1);
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

  it('checks freshness again after the key read caught up past a remove of a scope member', async () => {
    const { web, device, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device, helper.member]);
    await keyring.catchUp();
    expect(await keyring.acceptHeader(header('scope-a', 1, web.head!, web.member.memberId))).toBe(true);
    // The key is not cached, so the key read catches up, and the remove arrives only there.
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
    await web.append('remove', { memberId: helper.member.memberId });
    expect(await keyring.sealingKey('scope-a', 1)).toBeUndefined();
    expect(keyring.session!.state.head).toEqual(web.head);
  });

  it('copies the key where the opening read takes it, so a catch-up before the read resumes cannot zero it', async () => {
    const { web, device, keyring } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    let shredded = false;
    const shred = async (): Promise<void> => {
      if (shredded) return;
      shredded = true;
      await web.append('shred', { scopeId: 'scope-a' });
      await keyring.catchUp();
    };
    // A read that takes the key through the public fetch gets the cached
    // bytes; this catch-up zeroes them before that read resumes.
    const fetch = keyring.fetch.bind(keyring);
    vi.spyOn(keyring, 'fetch').mockImplementation(async (...args) => {
      const result = await fetch(...args);
      await shred();
      return result;
    });
    const key = await keyring.openingKey({ id: 'scope-a', epoch: 1 });
    await shred();
    expect(keyring.cached('scope-a', 1)).toBeUndefined();
    expect(key).toEqual(scopeKey);
    expect(key!.some((byte) => byte !== 0)).toBe(true);
  });

  it('retires without onLost, zeroing its keys, and hands only on-chain points of the same member to the next run', async () => {
    const { web, device, options, session } = await member();
    let lost = 0;
    const first = new DeviceMemberKeyring(session, { ...options, onLost: () => { lost += 1; } });
    const scopeKey = await web.putScope('scope-a', [device]);
    await first.catchUp();
    expect(await first.acceptHeader(header('scope-a', 1, web.head!, web.member.memberId))).toBe(true);
    const fetched = await first.fetch('scope-a', 1);
    if (!fetched.ok) throw new Error(fetched.reason);

    const carried = first.retire()!;
    expect(lost).toBe(0);
    expect(first.session).toBeUndefined();
    expect(fetched.key.scopeKey.every((byte) => byte === 0)).toBe(true);
    expect(await first.sealingKey('scope-a', 1)).toBeUndefined();
    expect(carried.points.get('scope-a')?.get(1)).toEqual(web.head);

    // A next run whose verified chain has no such scope yet seals nothing for it.
    const next = new DeviceMemberKeyring(session, { ...options, carried });
    expect(await next.sealingKey('scope-a', 1)).toBeUndefined();
    const resumed = new DeviceMemberKeyring(next.session!, options);
    await resumed.catchUp();
    const current = new DeviceMemberKeyring(resumed.session!, { ...options, carried });
    expect(await current.sealingKey('scope-a', 1)).toEqual({ scopeKey, epoch: 1, sender: device.memberId, chainHead: web.head });

    // A point that is not kept leaves no fresh epoch, so the device rotates past epoch 1 (E2d-4).
    const forged = { ...carried, points: new Map([['scope-a', new Map([[1, { ...web.head!, hash: `sha256:${'0'.repeat(64)}` }]])]]) };
    expect(await new DeviceMemberKeyring(resumed.session!, { ...options, carried: forged }).sealingKey('scope-a', 1)).toMatchObject({ epoch: 2 });
    const otherMember = { ...carried, memberId: web.member.memberId };
    expect(await new DeviceMemberKeyring(resumed.session!, { ...options, carried: otherMember }).sealingKey('scope-a', 1)).toMatchObject({ epoch: 3 });
  });

  it('hands the next run the seq a rotated epoch was wrapped at, so a member KEM rotation after it still makes the epoch stale', async () => {
    const { web, device, options, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(2);
    const session = keyring.session!;
    const carried = keyring.retire()!;
    const kem = (await openMemberKeyRecord(await generateMemberKeyRecord({ tenantId: 'tenant-test' })))!.kem;
    const kemEpoch = web.member.kemEpoch + 1;
    const rotated = await createMemberKeyBundle({
      signingPublicJwk: web.keys.signing.publicJwk, signingPrivateKey: web.keys.signing.privateKey, kemPublicJwk: kem.publicJwk, kemEpoch,
    });
    await web.append('rotate', { memberId: web.member.memberId, kemPublicJwk: rotated.kemPublicJwk, kemEpoch, kemSig: rotated.kemSig });
    const resumed = new DeviceMemberKeyring(session, options);
    await resumed.catchUp();
    // The carried point of epoch 2 is on the chain, but its packages name the old KEM key.
    expect((await new DeviceMemberKeyring(resumed.session!, { ...options, carried }).sealingKey('scope-a', 1))?.epoch).toBe(3);
  });

  it('aborts a rotation in flight at retire, so it keeps no key', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackagePuts = new Promise<void>((resolve) => { release = resolve; });
    try {
      const sealing = keyring.sealingKey('scope-a', 1);
      while (server.e2ee.devicePuts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      const carried = keyring.retire()!;
      await expect(sealing).rejects.toMatchObject({ name: 'AbortError' });
      expect(carried.points.get('scope-a')).toBeUndefined();
      expect(keyring.cached('scope-a', 2)).toBeUndefined();
    } finally {
      release();
      server.e2ee.holdPackagePuts = undefined;
    }
  });

  it('rotates past a carried point once a scope member is removed between the runs', async () => {
    const { server, web, device, options, session } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device, helper.member]);
    const first = new DeviceMemberKeyring(session, options);
    await first.catchUp();
    expect(await first.acceptHeader(header('scope-a', 1, web.head!, web.member.memberId))).toBe(true);
    const carried = first.retire()!;
    expect(carried.points.get('scope-a')?.get(1)).toEqual(web.head);

    // Control: before the remove, the next run keeps the carried point, so it seals at epoch 1 and puts nothing.
    const control = new DeviceMemberKeyring(session, options);
    await control.catchUp();
    expect(await new DeviceMemberKeyring(control.session!, { ...options, carried }).sealingKey('scope-a', 1)).toMatchObject({ epoch: 1 });
    expect(server.e2ee.devicePuts).toHaveLength(0);

    await web.append('remove', { memberId: helper.member.memberId });
    const resumed = new DeviceMemberKeyring(session, options);
    await resumed.catchUp();
    const next = new DeviceMemberKeyring(resumed.session!, { ...options, carried });
    // The carried epoch 1 is stale, so the device rotates past it instead of sealing at it.
    expect(await next.sealingKey('scope-a', 1)).toMatchObject({ epoch: 2, sender: device.memberId });
    expect(server.e2ee.devicePuts).toHaveLength(1);
    // The removed member is no recipient of the new epoch, so it cannot open new content.
    const recipients = server.e2ee.devicePuts[0]!.map((pkg) => pkg.recipient);
    expect(recipients.sort()).toEqual([device.memberId, web.member.memberId].sort());
    expect(recipients).not.toContain(helper.member.memberId);
  });

  it.each(['tenantId', 'deviceId'] as const)('rotates past a carried point of another %s', async (field) => {
    const { server, web, device, options, session } = await member();
    await web.putScope('scope-a', [device]);
    const first = new DeviceMemberKeyring(session, options);
    await first.catchUp();
    expect(await first.acceptHeader(header('scope-a', 1, web.head!, web.member.memberId))).toBe(true);
    const carried = first.retire()!;
    const resumed = new DeviceMemberKeyring(session, options);
    await resumed.catchUp();

    // Control: the unmodified carry keeps the epoch-1 point, so the next run seals at epoch 1 and puts nothing.
    expect(await new DeviceMemberKeyring(resumed.session!, { ...options, carried }).sealingKey('scope-a', 1)).toMatchObject({ epoch: 1 });
    expect(server.e2ee.devicePuts).toHaveLength(0);

    // A carry of another tenant or device is not kept: no fresh epoch, so the device rotates past epoch 1.
    expect(await new DeviceMemberKeyring(resumed.session!, { ...options, carried: { ...carried, [field]: 'other' } }).sealingKey('scope-a', 1)).toMatchObject({ epoch: 2 });
    expect(server.e2ee.devicePuts).toHaveLength(1);
  });
});

function stored(custody: InMemoryDeviceMemberCustody): { kemEpoch: number; nextKem?: unknown } {
  return JSON.parse(custody.entries.get('member-keys')!) as { kemEpoch: number; nextKem?: unknown };
}

describe('device member KEM rotation (E2d-5)', () => {
  it('appends its rotate entry, re-wraps and reads back every own package, then drops the old key', async () => {
    const { server, web, device, custody, logs, keyring, restart } = await member();
    const first = await web.putScope('scope-a', [device]);
    const other = await web.putScope('scope-b', [device], { epoch: 2 });
    await keyring.catchUp();
    const rotated = (await keyring.sealingKey('scope-a', 1))!;
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });

    expect(server.e2ee.deviceAppends).toHaveLength(1);
    expect(server.e2ee.deviceAppends[0]).toMatchObject([{ op: 'rotate', signer: device.memberId, subject: { memberId: device.memberId, kemEpoch: 2 } }]);
    const self = keyring.session!.state.members.get(device.memberId)!;
    expect(self.kemEpoch).toBe(2);
    expect(self.kemPublicJwk).toEqual(keyring.session!.keys.kem.publicJwk);
    expect(keyring.session!.keys.nextKem).toBeUndefined();
    expect(stored(custody)).toMatchObject({ kemEpoch: 2 });
    expect(stored(custody).nextKem).toBeUndefined();
    const own = server.e2ee.packages.filter((pkg) => pkg.recipient === device.memberId);
    expect(own.map((pkg) => [pkg.scopeId, pkg.epoch, pkg.sender])).toEqual(expect.arrayContaining([
      ['scope-a', 1, device.memberId], ['scope-a', 2, device.memberId], ['scope-b', 2, device.memberId],
    ]));
    expect(logs.at(-1)).toContain('rotated the member KEM key to epoch 2');

    // A new run opens every package with the new key only.
    const next = await restart();
    expect(await next.fetch('scope-a', 1)).toMatchObject({ ok: true, key: { scopeKey: first, sender: device.memberId } });
    expect(await next.fetch('scope-a', 2)).toMatchObject({ ok: true, key: { scopeKey: rotated.scopeKey } });
    expect(await next.fetch('scope-b', 2)).toMatchObject({ ok: true, key: { scopeKey: other } });
  });

  it('re-wraps only packages it accepts now, and never re-signs one from a removed member or an outsider', async () => {
    const { server, web, device, logs, keyring, restart } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    const scopeKey = await web.putScope('scope-a', [device, helper.member]);
    const removed = await helper.sealPackage('scope-a', device, new Uint8Array(32).fill(6), 2);
    server.e2ee.clientPutPackages(removed);
    await web.append('remove', { memberId: helper.member.memberId });
    const outsider = await (await stranger()).sealPackage('scope-a', device, new Uint8Array(32).fill(8), 3);
    server.e2ee.clientPutPackages(outsider);
    expect(await keyring.fetch('scope-a', 2)).toEqual({ ok: false, reason: 'key_package_sender_invalid' });

    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(server.e2ee.packages).toContainEqual(removed);
    expect(server.e2ee.packages).toContainEqual(outsider);
    expect(logs.join('\n')).toContain('is not re-wrapped: its sender is not a current member of the scope policy');
    const next = await restart();
    expect(await next.fetch('scope-a', 1)).toMatchObject({ ok: true, key: { scopeKey, sender: device.memberId } });
    expect(await next.fetch('scope-a', 2)).toEqual({ ok: false, reason: 'key_package_sender_invalid' });
  });

  it('keeps the next key when a catch-up was saving its head while the rotation stored it', async () => {
    const { server, web, device, custody, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    server.e2ee.dropPackagePuts = true;
    /** Hold the first write of one entry until released. */
    const gate = (entry: string) => {
      let hit!: () => void;
      let release!: () => void;
      return { entry, used: false, reached: new Promise<void>((resolve) => { hit = resolve; }), hit: () => hit(), wait: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
    };
    const gates = [gate('member-keys'), gate('member-state')];
    const replace = custody.replace.bind(custody);
    custody.replace = async (entry: string, value: string) => {
      const held = gates.find((candidate) => candidate.entry === entry && !candidate.used);
      if (held !== undefined) {
        held.used = true;
        held.hit();
        await held.wait;
      }
      await replace(entry, value);
    };
    const rotating = keyring.rotateKem();
    await gates[0]!.reached;
    await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input', 'task-output'], members: [web.member.memberId, device.memberId].sort() });
    const catching = keyring.catchUp();
    await gates[1]!.reached;
    gates[0]!.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    gates[1]!.release();
    await catching;
    expect(await rotating).toEqual({ ok: false, reason: 'rewrap_unverified' });
    expect(keyring.session!.keys.nextKem?.epoch).toBe(2);
  });

  it('resumes after a failed put without a second rotate entry, and opens new-key packages meanwhile', async () => {
    const { server, web, device, custody, keyring } = await member();
    await web.putScope('scope-a', [device]);
    server.e2ee.failPackagePuts = 1;
    await expect(keyring.rotateKem()).rejects.toThrow(/HTTP 503/u);
    expect(stored(custody).nextKem).toBeDefined();
    const pending = keyring.session!.state.members.get(device.memberId)!;
    expect(pending.kemEpoch).toBe(2);

    // A client that saw the rotate wraps to the new key; the old key still opens the old package.
    await web.follow();
    await web.append('scope-policy', { scopeId: 'scope-c', categories: ['task-input'], members: [web.member.memberId, device.memberId].sort() });
    const fresh = new Uint8Array(32).fill(4);
    server.e2ee.clientPutPackages(await web.sealPackage('scope-c', pending, fresh));
    expect(await keyring.fetch('scope-c', 1)).toMatchObject({ ok: true, key: { scopeKey: fresh } });
    expect((await keyring.fetch('scope-a', 1)).ok).toBe(true);

    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(server.e2ee.deviceAppends).toHaveLength(1);
    expect(stored(custody).nextKem).toBeUndefined();
  });

  it('keeps the old key when a re-wrapped package does not read back', async () => {
    const { server, web, device, custody, keyring, restart } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    server.e2ee.dropPackagePuts = true;
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'rewrap_unverified' });
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
    expect(await (await restart()).fetch('scope-a', 1)).toMatchObject({ ok: true, key: { scopeKey } });
  });

  it('keeps the old key when the Host acknowledges a re-wrap and then reads back no package', async () => {
    const { server, web, device, custody, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    const original = server.e2ee.handle.bind(server.e2ee);
    server.e2ee.handle = async (req, res, url) => {
      if (req.method === 'POST' && url.pathname.endsWith('/key-packages')) {
        server.e2ee.withholdPages = () => true;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stored: 1, skippedDeviceIds: [] }));
        return true;
      }
      return original(req, res, url);
    };
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'rewrap_unverified' });
    expect(logs.join('\n')).toContain('epoch 1 of scope "scope-a" was re-wrapped but no key package reads back');
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
  });

  it('does not re-sign a package whose sender a catch-up removed while the packages were read', async () => {
    const { server, web, device, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device, helper.member]);
    const removed = await helper.sealPackage('scope-a', device, new Uint8Array(32).fill(6), 2);
    server.e2ee.clientPutPackages(removed);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackageReads = new Promise<void>((resolve) => { release = resolve; });
    const reads = server.e2ee.pageReads;
    const rotating = keyring.rotateKem();
    while (server.e2ee.pageReads === reads) await new Promise((resolve) => setTimeout(resolve, 5));
    await web.follow();
    await web.append('remove', { memberId: helper.member.memberId });
    await keyring.catchUp();
    release();
    expect(await rotating).toEqual({ ok: true, epoch: 2 });
    expect(server.e2ee.packages).toContainEqual(removed);
    expect(server.e2ee.devicePuts.flat().map((pkg) => pkg.epoch)).toEqual([1]);
  });

  it('never drops the old key in a run retired after its last read-back', async () => {
    const { web, device, custody, options, keyring, restart } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    const read = options.client.readOwnKeyPackages.bind(options.client);
    let answered = 0;
    // Three passes read the one page of the one scope: the scan, the scope's read-back and the final check. The run retires once the last read answered.
    vi.spyOn(options.client, 'readOwnKeyPackages').mockImplementation(async (scopeId, afterEpoch, signal) => {
      const page = await read(scopeId, afterEpoch, signal);
      if (++answered === 3) keyring.retire();
      return page;
    });
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'member_lost' });
    expect(answered).toBe(3);
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
    vi.restoreAllMocks();
    expect(await (await restart()).fetch('scope-a', 1)).toMatchObject({ ok: true, key: { scopeKey } });
  });

  it('starts no run whose custody lacks the KEM key the chain names for this device', async () => {
    const { web, device, custody, logs, keyring, resume } = await member();
    await web.putScope('scope-a', [device]);
    const before = custody.entries.get('member-keys')!;
    expect((await keyring.rotateKem()).ok).toBe(true);
    custody.entries.set('member-keys', before);
    expect(await resume()).toBeUndefined();
    expect(logs.at(-1)).toContain('do not hold the KEM key the member chain names for this device');
  });

  it('reads at most 256 full pages of a scope, and keeps the old key when the Host serves more', async () => {
    const { server, web, device, custody, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    const handle = server.e2ee.handle.bind(server.e2ee);
    let pages = 0;
    server.e2ee.handle = async (req, res, url) => {
      const after = url.searchParams.get('afterEpoch');
      if (req.method !== 'GET' || after === null) return handle(req, res, url);
      pages += 1;
      // A Host that never ends the list: each page is full.
      const packages = Array.from({ length: E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX }, (_, index) => ({ epoch: Number(after) + 1 + index }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ packages, scopeHeadEpoch: packages.at(-1)!.epoch }));
      return true;
    };
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'scope_epochs_exceeded' });
    expect(pages).toBe(257);
    expect(logs.join('\n')).toContain('scope "scope-a" holds more than the 4096 key packages a KEM rotation reads');
    expect(server.e2ee.devicePuts).toHaveLength(0);
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
  });

  it('re-wraps own packages across pages and past epoch 256 (B1)', async () => {
    const { server, web, device, custody, keyring, restart } = await member();
    const scopeKey = await web.putScope('scope-a', [device], { epoch: 300 });
    for (let epoch = 1; epoch <= E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX; epoch += 1) {
      server.e2ee.clientPutPackages(await web.sealPackage('scope-a', device, new Uint8Array(32).fill(epoch), epoch));
    }
    expect((await keyring.fetch('scope-a', 300)).ok).toBe(true);
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(server.e2ee.devicePuts.flat().map((pkg) => pkg.epoch)).toEqual([...Array.from({ length: E2EE_SCOPE_KEY_PACKAGE_PAGE_MAX }, (_, index) => index + 1), 300]);
    expect(stored(custody).nextKem).toBeUndefined();
    expect(await (await restart()).fetch('scope-a', 300)).toMatchObject({ ok: true, key: { scopeKey, sender: device.memberId } });
  });

  it('after a restart, re-wraps own packages that start above the epochs the run knows', async () => {
    const { server, web, device, custody, restart } = await member();
    const scopeKey = await web.putScope('scope-a', [device], { epoch: 7 });
    const keyring = await restart();
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(server.e2ee.devicePuts.flat().map((pkg) => pkg.epoch)).toEqual([7]);
    expect(stored(custody).nextKem).toBeUndefined();
    expect(await (await restart()).fetch('scope-a', 7)).toMatchObject({ ok: true, key: { scopeKey, sender: device.memberId } });
  });

  it('cuts off a hung rotate append, and keeps the old key', async () => {
    const { server, web, device, custody, keyring } = await member({ requestTimeoutMs: 50 });
    await web.putScope('scope-a', [device]);
    let release!: () => void;
    server.e2ee.holdChainAppends = new Promise<void>((resolve) => { release = resolve; });
    try {
      await expect(keyring.rotateKem()).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(server.e2ee.devicePuts).toHaveLength(0);
      expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
    } finally {
      release();
    }
  });

  it('cuts off a hung re-wrap put, and keeps the old key', async () => {
    // Each of the 256 scan reads before the put has its own timeout too, so it is long enough that none of them cuts off.
    const { server, web, device, custody, keyring } = await member({ requestTimeoutMs: 1000 });
    await web.putScope('scope-a', [device]);
    let release!: () => void;
    server.e2ee.holdPackagePuts = new Promise<void>((resolve) => { release = resolve; });
    try {
      await expect(keyring.rotateKem()).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(server.e2ee.devicePuts).toHaveLength(1);
      expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
    } finally {
      release();
    }
  });

  it('finishes when the Host refuses a held-back old-key put that lands after the read-back and before the final check', async () => {
    const { server, web, device, custody, keyring, restart } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    const original = server.e2ee.packages.find((pkg) => pkg.recipient === device.memberId && pkg.scopeId === 'scope-a' && pkg.epoch === 1)!;
    const handle = server.e2ee.handle.bind(server.e2ee);
    let reads = 0;
    let landed: boolean | undefined;
    server.e2ee.handle = async (req, res, url) => {
      if (req.method === 'GET' && url.searchParams.has('afterEpoch')) {
        reads += 1;
        // The page reads are the scan, the scope's read-back and the final check: a held-back old-key put lands before the last.
        if (reads === 3) landed = server.e2ee.clientPutPackages(original);
      }
      return handle(req, res, url);
    };
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(reads).toBe(3);
    expect(landed).toBe(false);
    expect(server.e2ee.devicePuts.flat().map((pkg) => pkg.epoch)).toEqual([1]);
    expect(stored(custody).nextKem).toBeUndefined();
    expect(await (await restart()).fetch('scope-a', 1)).toMatchObject({ ok: true, key: { scopeKey, sender: device.memberId } });
  });

  it('finishes when the Host refuses an old-key package from a client that has not seen the rotate, put after the scan', async () => {
    const { server, web, device, custody, keyring } = await member();
    await web.putScope('scope-a', [device]);
    // `device` is the bundle from before the rotation, so this package is wrapped to the old key.
    const late = await web.sealPackage('scope-a', device, new Uint8Array(32).fill(9), 2);
    const handle = server.e2ee.handle.bind(server.e2ee);
    let landed: boolean | undefined;
    server.e2ee.handle = async (req, res, url) => {
      if (landed === undefined && req.method === 'POST' && url.pathname.endsWith('/key-packages')) landed = server.e2ee.clientPutPackages(late);
      return handle(req, res, url);
    };
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(landed).toBe(false);
    expect(server.e2ee.packages.filter((pkg) => pkg.epoch === 2)).toEqual([]);
    expect(stored(custody).nextKem).toBeUndefined();
  });

  it('finishes when the Host refuses an old-key package at a new epoch of a scope during a later scope\'s put', async () => {
    const { server, web, device, custody, keyring, restart } = await member();
    await web.putScope('scope-a', [device]);
    await web.putScope('scope-b', [device]);
    // `device` is the bundle from before the rotation, so this package is wrapped to the old key.
    const lateKey = new Uint8Array(32).fill(9);
    const late = await web.sealPackage('scope-a', device, lateKey, 2);
    const handle = server.e2ee.handle.bind(server.e2ee);
    let puts = 0;
    let landed: boolean | undefined;
    server.e2ee.handle = async (req, res, url) => {
      // The first put is scope-a's re-wrap, after which its read-back passed; the second is scope-b's.
      if (req.method === 'POST' && url.pathname.endsWith('/key-packages') && ++puts === 2) landed = server.e2ee.clientPutPackages(late);
      return handle(req, res, url);
    };
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(puts).toBe(2);
    expect(landed).toBe(false);
    expect(server.e2ee.devicePuts.map((put) => put[0]!.scopeId)).toEqual(['scope-a', 'scope-b']);
    expect(stored(custody).nextKem).toBeUndefined();
    expect(await (await restart()).fetch('scope-a', 2)).toEqual({ ok: false, reason: 'key_package_missing' });
  });

  it('keeps the old key when a scope created during the rotation holds an old-key package put before the rotate', async () => {
    const { server, web, device, custody, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    // A client wraps scope-c's key to the old key before the rotate, and appends its policy only during the rotation.
    server.e2ee.clientPutPackages(await web.sealPackage('scope-c', device, new Uint8Array(32).fill(3)));
    const handle = server.e2ee.handle.bind(server.e2ee);
    let created = false;
    server.e2ee.handle = async (req, res, url) => {
      if (!created && req.method === 'POST' && url.pathname.endsWith('/key-packages')) {
        created = true;
        await web.follow();
        await web.append('scope-policy', { scopeId: 'scope-c', categories: ['task-input', 'task-output'], members: [web.member.memberId, device.memberId].sort() });
      }
      return handle(req, res, url);
    };
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'rewrap_unverified' });
    expect(created).toBe(true);
    expect(logs.join('\n')).toContain('epoch 1 of scope "scope-c" holds a key package that opens only with the old KEM key');
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
  });

  it('keeps the old key when the Host reads no package at an epoch whose key it holds', async () => {
    const { server, web, device, custody, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    expect((await keyring.fetch('scope-a', 1)).ok).toBe(true);
    server.e2ee.withholdPages = (pkg) => pkg.epoch === 1;
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'key_package_missing' });
    expect(logs.join('\n')).toContain('epoch 1 of scope "scope-a" is held but its key package was not read');
    expect(server.e2ee.devicePuts).toHaveLength(0);
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
  });

  it('keeps the old key when the Host reads no package at an epoch with a freshness point and no key', async () => {
    const { server, web, device, custody, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    expect(await keyring.acceptHeader(header('scope-a', 1, web.head!, web.member.memberId))).toBe(true);
    server.e2ee.withholdPages = (pkg) => pkg.epoch === 1;
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'key_package_missing' });
    expect(logs.join('\n')).toContain('epoch 1 of scope "scope-a" is held but its key package was not read');
    expect(server.e2ee.devicePuts).toHaveLength(0);
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
  });

  it('keeps the old key when a scope that was not usable at the start becomes usable during the rotation with an old-key package', async () => {
    const { server, web, device, custody, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    // scope-c held the device once; its policy dropped it, so the scope is not usable when the rotation starts.
    await web.putScope('scope-c', [device]);
    await web.append('scope-policy', { scopeId: 'scope-c', categories: ['task-input', 'task-output'], members: [web.member.memberId] });
    const handle = server.e2ee.handle.bind(server.e2ee);
    let added = false;
    server.e2ee.handle = async (req, res, url) => {
      if (!added && req.method === 'POST' && url.pathname.endsWith('/key-packages')) {
        added = true;
        // The policy adds the device back; its package of epoch 1 still opens only with the old key.
        await web.follow();
        await web.append('scope-policy', { scopeId: 'scope-c', categories: ['task-input', 'task-output'], members: [web.member.memberId, device.memberId].sort() });
      }
      return handle(req, res, url);
    };
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'rewrap_unverified' });
    expect(added).toBe(true);
    expect(server.e2ee.devicePuts.map((put) => put[0]!.scopeId)).toEqual(['scope-a']);
    expect(logs.join('\n')).toContain('epoch 1 of scope "scope-c" holds a key package that opens only with the old KEM key');
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
  });

  it('keeps the old key when a policy accepts again, during the rotation, the sender of an old-key package that a re-wrapped scope skipped', async () => {
    const { server, web, device, custody, logs, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-c', [device, helper.member]);
    server.e2ee.clientPutPackages(await helper.sealPackage('scope-c', device, new Uint8Array(32).fill(6), 2));
    await web.append('scope-policy', { scopeId: 'scope-c', categories: ['task-input', 'task-output'], members: [web.member.memberId, device.memberId].sort() });
    await web.putScope('scope-a', [device]);
    const handle = server.e2ee.handle.bind(server.e2ee);
    let puts = 0;
    server.e2ee.handle = async (req, res, url) => {
      // The first put is scope-c's re-wrap, which skipped the helper's package; the second is scope-a's.
      if (req.method === 'POST' && url.pathname.endsWith('/key-packages') && ++puts === 2) {
        await web.follow();
        const members = [web.member.memberId, device.memberId, helper.member.memberId].sort();
        await web.append('scope-policy', { scopeId: 'scope-c', categories: ['task-input', 'task-output'], members });
      }
      return handle(req, res, url);
    };
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'rewrap_unverified' });
    expect(server.e2ee.devicePuts.map((put) => put[0]!.scopeId)).toEqual(['scope-c', 'scope-a']);
    expect(logs.join('\n')).toContain('epoch 2 of scope "scope-c" holds a key package that opens only with the old KEM key');
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
  });

  it.each(['a fetched key', 'a freshness point'] as const)('keeps the old key when the final read-back reads no package at an epoch that gained %s during the rotation', async (gained) => {
    const { server, web, device, custody, logs, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await web.putScope('scope-b', [device]);
    const handle = server.e2ee.handle.bind(server.e2ee);
    let puts = 0;
    server.e2ee.handle = async (req, res, url) => {
      // The first put is scope-a's re-wrap, after which its read-back passed; the second is scope-b's.
      if (req.method === 'POST' && url.pathname.endsWith('/key-packages') && ++puts === 2) {
        await web.follow();
        if (gained === 'a fetched key') {
          // A client that walked the rotate wraps a new epoch of scope-a to the next key, and the device opens it.
          const next = keyring.session!.state.members.get(device.memberId)!;
          server.e2ee.clientPutPackages(await web.sealPackage('scope-a', next, new Uint8Array(32).fill(4), 2));
          expect((await keyring.fetch('scope-a', 2)).ok).toBe(true);
        } else {
          expect(await keyring.acceptHeader(header('scope-a', 2, web.head!, web.member.memberId))).toBe(true);
        }
        server.e2ee.withholdPages = (pkg) => pkg.scopeId === 'scope-a' && pkg.epoch === 2;
      }
      return handle(req, res, url);
    };
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'key_package_missing' });
    expect(puts).toBe(2);
    expect(logs.join('\n')).toContain('epoch 2 of scope "scope-a" is held but its key package was not read');
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
  });

  it('finishes when an epoch with a freshness point holds a package from a sender that was removed since', async () => {
    const { server, web, device, custody, keyring } = await member();
    const helper = await stranger();
    await web.append('add', { member: helper.member });
    await web.putScope('scope-a', [device, helper.member]);
    const removed = await helper.sealPackage('scope-a', device, new Uint8Array(32).fill(6), 2);
    server.e2ee.clientPutPackages(removed);
    expect(await keyring.acceptHeader(header('scope-a', 2, web.head!, helper.member.memberId))).toBe(true);
    await web.append('remove', { memberId: helper.member.memberId });
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(server.e2ee.packages).toContainEqual(removed);
    expect(stored(custody).nextKem).toBeUndefined();
  });

  it('opens a package that a concurrent KEM rotation re-wrapped while the fetch read it', async () => {
    const { server, web, device, logs, keyring } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    let release!: () => void;
    server.e2ee.holdPackageReads = new Promise<void>((resolve) => { release = resolve; });
    const reads = server.e2ee.packageReads;
    const opening = keyring.openingKey({ id: 'scope-a', epoch: 1 });
    while (server.e2ee.packageReads === reads) await new Promise((resolve) => setTimeout(resolve, 5));
    // Only the fetch's read stays held; the rotation reads and re-wraps the package.
    server.e2ee.holdPackageReads = undefined;
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    const own = server.e2ee.packages.find((pkg) => pkg.scopeId === 'scope-a' && pkg.epoch === 1 && pkg.recipient === device.memberId);
    expect(own?.sender).toBe(device.memberId);
    release();
    expect(await opening).toEqual(scopeKey);
    expect(logs.join('\n')).not.toContain('no scope key');
  });

  it('opens a package read before a concurrent KEM rotation re-wrapped it and answered after the rotation finished', async () => {
    const { server, web, device, logs, keyring } = await member();
    const scopeKey = await web.putScope('scope-a', [device]);
    await keyring.catchUp();
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // The fetch's read takes the Host state before the re-wrap and answers after the rotation.
    const original = server.e2ee.handle.bind(server.e2ee);
    let first = true;
    server.e2ee.handle = async (req, res, url) => {
      if (!first || req.method !== 'GET' || !url.pathname.endsWith('/key-packages')) return original(req, res, url);
      first = false;
      const snapshot = server.e2ee.packages.filter((pkg) => pkg.scopeId === 'scope-a' && pkg.epoch === 1 && pkg.recipient === device.memberId);
      reached();
      await held;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ packages: snapshot }));
      return true;
    };
    const opening = keyring.openingKey({ id: 'scope-a', epoch: 1 });
    await reading;
    expect(await keyring.rotateKem()).toEqual({ ok: true, epoch: 2 });
    expect(keyring.session!.keys.nextKem).toBeUndefined();
    release();
    expect(await opening).toEqual(scopeKey);
    expect(logs.join('\n')).not.toContain('no scope key');
  });

  it('shares one rotation between concurrent calls, and refuses one after the member is lost', async () => {
    const { server, web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    const [left, right] = await Promise.all([keyring.rotateKem(), keyring.rotateKem()]);
    expect(left).toEqual({ ok: true, epoch: 2 });
    expect(right).toEqual(left);
    expect(server.e2ee.deviceAppends).toHaveLength(1);

    await web.follow();
    await web.append('remove', { memberId: device.memberId });
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'member_lost' });
  });
});

describe('device member KEM rotation after a shred (E5b-2)', () => {
  /** Wait until the custody holds `kemEpoch` with no rotation left. */
  async function rotated(custody: InMemoryDeviceMemberCustody, kemEpoch: number): Promise<void> {
    await vi.waitFor(() => {
      expect(stored(custody).kemEpoch).toBe(kemEpoch);
      expect(stored(custody).nextKem).toBeUndefined();
    }, 5_000);
  }

  it('rotates once in the background after a catch-up applies shreds of scopes that held this member', async () => {
    const { server, web, device, custody, logs, keyring } = await member({ kemRotation: () => true });
    await web.putScope('scope-a', [device]);
    await web.putScope('scope-b', [device]);
    await keyring.catchUp();
    expect(server.e2ee.deviceAppends).toHaveLength(0);
    await web.append('shred', { scopeId: 'scope-a' });
    await web.append('shred', { scopeId: 'scope-b' });
    await keyring.catchUp();
    await rotated(custody, 2);
    expect(server.e2ee.deviceAppends).toHaveLength(1);
    expect(logs).toContain('rotated the member KEM key to epoch 2');
    await keyring.catchUp();
    keyring.checkKemRotation();
    expect(server.e2ee.deviceAppends).toHaveLength(1);
  });

  it('does not rotate after a shred of a scope that never held this member, or where the Host lacks the KEM epoch rules', async () => {
    let declared = true;
    const { web, device, keyring } = await member({ kemRotation: () => declared });
    const rotate = vi.spyOn(keyring, 'rotateKem');
    await web.putScope('scope-x', []);
    await web.append('shred', { scopeId: 'scope-x' });
    await keyring.catchUp();
    expect(rotate).not.toHaveBeenCalled();
    declared = false;
    await web.putScope('scope-a', [device]);
    await web.append('shred', { scopeId: 'scope-a' });
    await keyring.catchUp();
    keyring.checkKemRotation();
    expect(rotate).not.toHaveBeenCalled();
    declared = true;
    keyring.checkKemRotation();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(await rotate.mock.results[0]!.value).toEqual({ ok: true, epoch: 2 });
  });

  it('does not retry a failed rotation in the same run, rotates again after the next shred, and once more when that retry resumed the key the shredded scope was wrapped to', async () => {
    const { server, web, device, custody, logs, keyring } = await member({ kemRotation: () => true });
    await web.putScope('scope-a', [device]);
    await web.putScope('scope-b', [device]);
    const rotate = vi.spyOn(keyring, 'rotateKem');
    server.e2ee.dropPackagePuts = true;
    await web.append('shred', { scopeId: 'scope-b' });
    await keyring.catchUp();
    await vi.waitFor(() => expect(logs).toContain('the KEM rotation to epoch 2 stopped (rewrap_unverified); the old key stays'), 5_000);
    await keyring.catchUp();
    keyring.checkKemRotation();
    expect(rotate).toHaveBeenCalledTimes(1);
    server.e2ee.dropPackagePuts = false;
    const pending = (stored(custody).nextKem as { readonly epoch: number; readonly jwk: { readonly d: string } });
    expect(pending.epoch).toBe(2);
    await web.follow();
    // The failed run's rotate is on the chain, so scope-c is wrapped to the epoch-2 key that the retry resumes.
    const registered = keyring.session!.state.members.get(device.memberId)!;
    expect(registered.kemEpoch).toBe(2);
    await web.putScope('scope-c', [registered]);
    await web.append('shred', { scopeId: 'scope-c' });
    const shredSeq = web.head!.seq;
    await keyring.catchUp();
    await rotated(custody, 3);
    expect(rotate).toHaveBeenCalledTimes(3);
    expect(logs).toContain('rotated the member KEM key to epoch 2');
    expect(logs).toContain('rotated the member KEM key to epoch 3');
    const appends = server.e2ee.deviceAppends as { readonly seq: number; readonly op: string; readonly subject: { readonly kemEpoch: number } }[][];
    expect(appends.map(([entry]) => [entry!.op, entry!.subject.kemEpoch])).toEqual([['rotate', 2], ['rotate', 3]]);
    expect(appends[1]![0]!.seq).toBeGreaterThan(shredSeq);
    expect(custody.entries.get('member-keys')).not.toContain(pending.jwk.d);
    // Its own new rotate entry is above every shred, so nothing more is owed.
    await keyring.catchUp();
    keyring.checkKemRotation();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rotate).toHaveBeenCalledTimes(3);
    expect(server.e2ee.deviceAppends).toHaveLength(2);
  });

  it('resumes an unfinished rotation of the custody when the daemon asks, once the Host declares the KEM epoch rules', async () => {
    let declared = false;
    const { server, web, device, custody, keyring, restart } = await member({ kemRotation: () => declared });
    await web.putScope('scope-a', [device]);
    server.e2ee.dropPackagePuts = true;
    expect(await keyring.rotateKem()).toEqual({ ok: false, reason: 'rewrap_unverified' });
    keyring.retire();
    server.e2ee.dropPackagePuts = false;
    const next = await restart();
    next.checkKemRotation();
    expect(stored(custody)).toMatchObject({ kemEpoch: 1, nextKem: { epoch: 2 } });
    declared = true;
    next.checkKemRotation();
    await rotated(custody, 2);
    expect(server.e2ee.deviceAppends).toHaveLength(1);
  });

  it('drops the freshness points and rotated epochs of a shredded scope', async () => {
    const { web, device, keyring } = await member();
    await web.putScope('scope-a', [device]);
    await web.putScope('scope-b', [device]);
    await keyring.catchUp();
    expect((await keyring.sealingKey('scope-a', 1))?.epoch).toBe(2);
    expect(await keyring.acceptHeader(header('scope-b', 1, web.head!, web.member.memberId))).toBe(true);
    await web.append('shred', { scopeId: 'scope-a' });
    await keyring.catchUp();
    const retired = keyring.retire()!;
    expect([...retired.points.keys()]).toEqual(['scope-b']);
    expect(retired.rotated.size).toBe(0);
  });
});

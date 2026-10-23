import {
  deriveMemberId,
  generateScopeKey,
  openScopeKeyPackage,
  sealScopeKeyPackage,
  signMemberChainEntry,
  verifyMemberChainEntry,
} from '@byok-sdk/core/sealed-payload';
import { describe, expect, it } from 'vitest';

import { DEVICE_MEMBER_SECRET_NAME, DeviceMemberKeyStore, type DeviceMemberKeys } from './device-member-key';
import { DEVICE_SEALING_SECRET_NAME, DeviceSealingKeyStore } from './device-sealing-key';
import { InMemorySecretStore } from './secret-store';
import { assertSecretName } from './secret-name';

const ENROLLMENT = { tenantId: 'tenant-1', deviceId: 'device-1' };
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

interface StoredJwk { x: string; y: string; d: string }
interface StoredRecord { signingJwk: StoredJwk; kemEpoch: number; kemJwk: StoredJwk; nextKem?: { epoch: number; jwk: StoredJwk } }

async function storedRecord(secrets: InMemorySecretStore): Promise<StoredRecord> {
  return JSON.parse((await secrets.get(DEVICE_MEMBER_SECRET_NAME))!);
}

/** Records every value written, so a test can check what each caller got against one real write. */
class RecordingSecretStore extends InMemorySecretStore {
  readonly writes: StoredRecord[] = [];

  override async set(name: string, secret: string): Promise<void> {
    await super.set(name, secret);
    this.writes.push(JSON.parse(secret));
  }
}

function expectFromOneWrite(keys: DeviceMemberKeys, writes: readonly StoredRecord[]): void {
  const write = writes.find((record) =>
    record.signingJwk.x === keys.signing.publicJwk.x
    && record.kemJwk.x === keys.kem.publicJwk.x
    && record.nextKem?.jwk.x === keys.nextKem?.publicJwk.x);
  expect(write, 'every key a caller gets comes from one write').toBeDefined();
  expect(write!.kemEpoch).toBe(keys.kem.epoch);
}

describe('DeviceMemberKeyStore', () => {
  it('uses one secret name the shared rule accepts, apart from the provider sealing key (D12)', () => {
    expect(DEVICE_MEMBER_SECRET_NAME).toBe('device-member-p256-v1');
    expect(assertSecretName(DEVICE_MEMBER_SECRET_NAME)).toBe(DEVICE_MEMBER_SECRET_NAME);
    expect(DEVICE_MEMBER_SECRET_NAME).not.toBe(DEVICE_SEALING_SECRET_NAME);
  });

  it('creates once, persists in the credential store, and loads the same keys afterwards', async () => {
    const secrets = new InMemorySecretStore();
    const created = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    expect(created.enrollment).toEqual(ENROLLMENT);
    expect(created.kem.epoch).toBe(1);
    expect(created.signing.privateKey.extractable).toBe(false);
    expect(created.kem.privateKey.extractable).toBe(false);
    expect(Object.keys(created.signing.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(created.kem.publicJwk).not.toEqual(created.signing.publicJwk);
    const stored = await secrets.get(DEVICE_MEMBER_SECRET_NAME);
    expect(stored).toBeDefined();
    expect(stored).not.toMatch(/[\r\n]/u);

    const loaded = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    expect(loaded.signing.publicJwk).toEqual(created.signing.publicJwk);
    expect(loaded.kem.publicJwk).toEqual(created.kem.publicJwk);
    expect(loaded.kem.epoch).toBe(1);
    await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBe(stored);
  });

  it('gives a stable member id under the core rule, and a new one for a new enrollment', async () => {
    // The store does not compute the id. The one rule is deriveMemberId in
    // @byok-sdk/core/sealed-payload; the daemon applies it to signing.publicJwk.
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const created = await store.loadOrCreate(ENROLLMENT);
    const memberId = await deriveMemberId(created.signing.publicJwk);
    expect(memberId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const begun = await store.beginKemRotation(ENROLLMENT);
    const finished = await store.finishKemRotation(ENROLLMENT, begun.nextKem!.epoch);
    const reloaded = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    for (const keys of [begun, finished, reloaded]) {
      await expect(deriveMemberId(keys.signing.publicJwk)).resolves.toBe(memberId);
    }
    const repaired = await store.loadOrCreate({ tenantId: 'tenant-1', deviceId: 'device-2' });
    await expect(deriveMemberId(repaired.signing.publicJwk)).resolves.not.toBe(memberId);
  });

  it('does not touch the provider sealing key entry', async () => {
    const secrets = new InMemorySecretStore();
    const sealing = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    const before = await secrets.get(DEVICE_SEALING_SECRET_NAME);
    const member = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    const begun = await new DeviceMemberKeyStore({ secretStore: secrets }).beginKemRotation(ENROLLMENT);
    await new DeviceMemberKeyStore({ secretStore: secrets }).finishKemRotation(ENROLLMENT, begun.nextKem!.epoch);
    await expect(secrets.get(DEVICE_SEALING_SECRET_NAME)).resolves.toBe(before);
    expect(member.kem.publicJwk).not.toEqual(sealing.publicJwk);
  });

  it('signs member chain entries and opens scope key packages sealed to it', async () => {
    const device = await new DeviceMemberKeyStore({ secretStore: new InMemorySecretStore() }).loadOrCreate(ENROLLMENT);
    const memberId = await deriveMemberId(device.signing.publicJwk);
    const entry = await signMemberChainEntry(
      { v: 1, tenantId: 'tenant-1', seq: 1, prev: null, op: 'add', subject: { member: memberId }, signer: memberId },
      device.signing,
    );
    await expect(verifyMemberChainEntry(entry, device.signing.publicJwk)).resolves.toMatchObject({ ok: true });

    const sender = await new DeviceMemberKeyStore({ secretStore: new InMemorySecretStore() }).loadOrCreate({
      tenantId: 'tenant-1',
      deviceId: 'device-2',
    });
    const scopeKey = generateScopeKey();
    const pkg = await sealScopeKeyPackage({
      scopeKey,
      tenantId: 'tenant-1',
      scopeId: 'scope-1',
      epoch: 1,
      recipient: { memberId, kemPublicJwk: device.kem.publicJwk },
      sender: { signingPublicJwk: sender.signing.publicJwk, signingPrivateKey: sender.signing.privateKey },
    });
    const opened = await openScopeKeyPackage({
      package: pkg,
      expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 },
      recipient: { memberId, kemPublicJwk: device.kem.publicJwk, kemPrivateKey: device.kem.privateKey },
      senderSigningPublicJwk: sender.signing.publicJwk,
    });
    expect(opened).toMatchObject({ ok: true });
    expect(opened.ok && Array.from(opened.scopeKey)).toEqual(Array.from(scopeKey));
  });

  it('begins a KEM rotation beside the current key and keeps the member id (§7.5)', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    expect(first.nextKem).toBeUndefined();
    const before = await storedRecord(secrets);

    const begun = await store.beginKemRotation(ENROLLMENT);
    expect(begun.signing.publicJwk).toEqual(first.signing.publicJwk);
    expect(begun.kem.epoch).toBe(1);
    expect(begun.kem.publicJwk).toEqual(first.kem.publicJwk);
    expect(begun.nextKem?.epoch).toBe(2);
    expect(begun.nextKem?.publicJwk).not.toEqual(first.kem.publicJwk);
    expect(begun.nextKem?.privateKey.extractable).toBe(false);
    const after = await storedRecord(secrets);
    expect(after.signingJwk).toEqual(before.signingJwk);
    expect(after.kemJwk).toEqual(before.kemJwk);
  });

  it('resumes a pending rotation after a restart and generates no other key', async () => {
    const secrets = new InMemorySecretStore();
    await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    const begun = await new DeviceMemberKeyStore({ secretStore: secrets }).beginKemRotation(ENROLLMENT);
    const stored = await secrets.get(DEVICE_MEMBER_SECRET_NAME);

    // A new process: the old and the next key are both still there.
    const reloaded = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    expect(reloaded.kem.publicJwk).toEqual(begun.kem.publicJwk);
    expect(reloaded.nextKem?.publicJwk).toEqual(begun.nextKem?.publicJwk);
    const resumed = await new DeviceMemberKeyStore({ secretStore: secrets }).beginKemRotation(ENROLLMENT);
    expect(resumed.nextKem?.publicJwk).toEqual(begun.nextKem?.publicJwk);
    await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBe(stored);
  });

  it('keeps the old KEM key able to open old packages until the rotation finishes', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const device = await store.loadOrCreate(ENROLLMENT);
    const memberId = await deriveMemberId(device.signing.publicJwk);
    const sender = await new DeviceMemberKeyStore({ secretStore: new InMemorySecretStore() }).loadOrCreate({
      tenantId: 'tenant-1',
      deviceId: 'device-2',
    });
    const seal = (kemPublicJwk: DeviceMemberKeys['kem']['publicJwk'], epoch: number) =>
      sealScopeKeyPackage({
        scopeKey: generateScopeKey(),
        tenantId: 'tenant-1',
        scopeId: 'scope-1',
        epoch,
        recipient: { memberId, kemPublicJwk },
        sender: { signingPublicJwk: sender.signing.publicJwk, signingPrivateKey: sender.signing.privateKey },
      });
    const open = (pkg: unknown, kem: DeviceMemberKeys['kem'], epoch: number) =>
      openScopeKeyPackage({
        package: pkg,
        expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch },
        recipient: { memberId, kemPublicJwk: kem.publicJwk, kemPrivateKey: kem.privateKey },
        senderSigningPublicJwk: sender.signing.publicJwk,
      });
    const oldPackage = await seal(device.kem.publicJwk, 1);

    const begun = await new DeviceMemberKeyStore({ secretStore: secrets }).beginKemRotation(ENROLLMENT);
    await expect(open(oldPackage, begun.kem, 1)).resolves.toMatchObject({ ok: true });
    const newPackage = await seal(begun.nextKem!.publicJwk, 2);
    await expect(open(newPackage, begun.nextKem!, 2)).resolves.toMatchObject({ ok: true });
  });

  it('finishes a rotation: the next key becomes current and the old private key is deleted', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    const before = await storedRecord(secrets);
    const begun = await store.beginKemRotation(ENROLLMENT);

    const finished = await store.finishKemRotation(ENROLLMENT, 2);
    expect(finished.signing.publicJwk).toEqual(first.signing.publicJwk);
    expect(finished.kem.epoch).toBe(2);
    expect(finished.kem.publicJwk).toEqual(begun.nextKem?.publicJwk);
    expect(finished.nextKem).toBeUndefined();
    const after = await storedRecord(secrets);
    expect(after.signingJwk).toEqual(before.signingJwk);
    expect(after.nextKem).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain(before.kemJwk.d);

    // A repeat call is a no-op; the next rotation goes to epoch 3.
    const stored = await secrets.get(DEVICE_MEMBER_SECRET_NAME);
    await expect(store.finishKemRotation(ENROLLMENT, 2)).resolves.toMatchObject({ kem: { epoch: 2 } });
    await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBe(stored);
    await expect(store.beginKemRotation(ENROLLMENT)).resolves.toMatchObject({ kem: { epoch: 2 }, nextKem: { epoch: 3 } });
  });

  it('refuses to finish a rotation that is not pending and changes nothing', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    await expect(store.finishKemRotation(ENROLLMENT, 1)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_ROTATION_MISMATCH' });
    await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBeUndefined();

    await store.loadOrCreate(ENROLLMENT);
    const idle = await secrets.get(DEVICE_MEMBER_SECRET_NAME);
    await expect(store.finishKemRotation(ENROLLMENT, 2)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_ROTATION_MISMATCH' });
    await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBe(idle);

    await store.beginKemRotation(ENROLLMENT);
    const pending = await secrets.get(DEVICE_MEMBER_SECRET_NAME);
    for (const epoch of [1, 3]) {
      await expect(store.finishKemRotation(ENROLLMENT, epoch)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_ROTATION_MISMATCH' });
    }
    await expect(store.finishKemRotation({ tenantId: 'tenant-1', deviceId: 'device-2' }, 2)).rejects.toMatchObject({
      code: 'DEVICE_MEMBER_KEY_ROTATION_MISMATCH',
    });
    await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBe(pending);
  });

  it('makes a new member for a new enrollment: new signing key, new KEM key at epoch 1', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    await store.beginKemRotation(ENROLLMENT);

    const repaired = await store.loadOrCreate({ tenantId: 'tenant-1', deviceId: 'device-2' });
    expect(repaired.signing.publicJwk).not.toEqual(first.signing.publicJwk);
    expect(repaired.enrollment).toEqual({ tenantId: 'tenant-1', deviceId: 'device-2' });
    expect(repaired.kem.epoch).toBe(1);
    expect(repaired.kem.publicJwk).not.toEqual(first.kem.publicJwk);
    expect(repaired.nextKem).toBeUndefined();

    const rotatedForNew = await store.beginKemRotation({ tenantId: 'tenant-2', deviceId: 'device-3' });
    expect(rotatedForNew.kem.epoch).toBe(1);
    expect(rotatedForNew.nextKem?.epoch).toBe(2);
    expect(rotatedForNew.signing.publicJwk).not.toEqual(repaired.signing.publicJwk);
  });

  it('gives each concurrent caller a signing key and a KEM key from one write', async () => {
    const secrets = new RecordingSecretStore();
    const created = await Promise.all([1, 2, 3].map(() => new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT)));
    const rotated = await Promise.all([1, 2, 3].map(() => new DeviceMemberKeyStore({ secretStore: secrets }).beginKemRotation(ENROLLMENT)));
    expect(secrets.writes.length).toBeGreaterThan(1);
    for (const keys of [...created, ...rotated]) expectFromOneWrite(keys, secrets.writes);
  });

  it('fails closed on a malformed stored record and never regenerates it', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const valid = await (async () => {
      await store.loadOrCreate(ENROLLMENT);
      return storedRecord(secrets);
    })();
    for (const bad of [
      'not json',
      JSON.stringify({ v: 1 }),
      JSON.stringify({ ...valid, v: 2 }),
      JSON.stringify({ ...valid, kemEpoch: 0 }),
      JSON.stringify({ ...valid, kemJwk: undefined }),
      JSON.stringify({ ...valid, extra: true }),
      // A pending rotation must be exactly one epoch ahead.
      JSON.stringify({ ...valid, nextKem: { epoch: valid.kemEpoch + 2, jwk: valid.kemJwk } }),
      JSON.stringify({ ...valid, nextKem: { epoch: valid.kemEpoch, jwk: valid.kemJwk } }),
    ]) {
      await secrets.set(DEVICE_MEMBER_SECRET_NAME, bad);
      await expect(store.loadOrCreate(ENROLLMENT)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_INVALID' });
      await expect(store.beginKemRotation(ENROLLMENT)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_INVALID' });
      await expect(store.finishKemRotation(ENROLLMENT, 2)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_INVALID' });
      await expect(store.loadOrCreate({ tenantId: 'tenant-1', deviceId: 'device-2' })).rejects.toMatchObject({
        code: 'DEVICE_MEMBER_KEY_INVALID',
      });
      await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBe(bad);
    }
  });

  it('fails closed on a private scalar in noncanonical base64url', async () => {
    for (const key of ['signingJwk', 'kemJwk'] as const) {
      const secrets = new InMemorySecretStore();
      const store = new DeviceMemberKeyStore({ secretStore: secrets });
      await store.loadOrCreate(ENROLLMENT);
      const record = await storedRecord(secrets);
      const { d } = record[key];
      // 32 bytes leave the 2 low bits of the last character unused; setting one
      // keeps the bytes a lenient decoder returns, but is not the canonical text.
      const noncanonical = d.slice(0, -1) + BASE64URL_ALPHABET[BASE64URL_ALPHABET.indexOf(d.at(-1)!) ^ 1];
      expect(Buffer.from(noncanonical, 'base64url').equals(Buffer.from(d, 'base64url'))).toBe(true);
      const tampered = JSON.stringify({ ...record, [key]: { ...record[key], d: noncanonical } });
      await secrets.set(DEVICE_MEMBER_SECRET_NAME, tampered);
      await expect(store.loadOrCreate(ENROLLMENT)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_INVALID' });
      await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBe(tampered);
    }
  });

  it('fails closed when a private scalar does not belong to the stored public point', async () => {
    for (const key of ['signingJwk', 'kemJwk'] as const) {
      const secrets = new InMemorySecretStore();
      const store = new DeviceMemberKeyStore({ secretStore: secrets });
      await store.loadOrCreate(ENROLLMENT);
      const other = new InMemorySecretStore();
      await new DeviceMemberKeyStore({ secretStore: other }).loadOrCreate(ENROLLMENT);
      const record = await storedRecord(secrets);
      const otherRecord = await storedRecord(other);
      const mixed = JSON.stringify({ ...record, [key]: { ...record[key], d: otherRecord[key].d } });
      await secrets.set(DEVICE_MEMBER_SECRET_NAME, mixed);
      await expect(store.loadOrCreate(ENROLLMENT)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_INVALID' });
      await expect(secrets.get(DEVICE_MEMBER_SECRET_NAME)).resolves.toBe(mixed);
    }
  });
});

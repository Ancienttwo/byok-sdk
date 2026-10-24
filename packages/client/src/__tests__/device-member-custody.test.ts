/**
 * #654 E2d-1: the device member entries (owner §50a D, 10b). The OS backend
 * uses the enrollment's provider with its own entry names; the key store
 * creates a member once, reloads it, refuses a tampered record, and keeps
 * the stored keys after a write.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { createMemberKeyBundle, deriveMemberId, encodePairingVerificationSecret, generatePairingVerificationSecret } from '@byok-sdk/core/sealed-payload';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceCredentialStore, type DeviceCommandRunner } from '../daemon/device-credential-store';
import {
  DeviceMemberCustodyError,
  DeviceMemberRecords,
  OsDeviceMemberCustody,
  type DeviceMemberEntry,
} from '../daemon/device-member-custody';
import { InMemoryDeviceMemberCustody } from './fixtures/credential-backend';

const DEVICE = { tenantId: 'tenant-a', deviceId: 'device-1' };

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A Linux Secret Service stand-in keyed by the account attribute. */
function linuxProvider() {
  const entries = new Map<string, string>();
  const calls: Array<readonly string[]> = [];
  const run: DeviceCommandRunner = async (_executable, args, stdin) => {
    calls.push(args);
    const account = args[args.indexOf('account') + 1]!;
    if (args[0] === 'lookup') {
      const value = entries.get(account);
      return value === undefined ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: `${value}\n`, stderr: '' };
    }
    if (args[0] === 'clear') entries.delete(account);
    else entries.set(account, stdin!);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { entries, calls, custody: new OsDeviceMemberCustody({ storeDir: testScratchRoot(), productId: 'member-custody-test', platform: 'linux', commandRunner: run }) };
}

describe('OsDeviceMemberCustody', () => {
  it('keeps each member entry under its own account of the product service, encoded and labeled', async () => {
    const { entries, calls, custody } = linuxProvider();
    const names: DeviceMemberEntry[] = ['member-keys', 'pairing-verification', 'member-state'];
    for (const name of names) await custody.replace(name, `value of ${name}`);
    expect([...entries.keys()].sort()).toEqual(['device-member-p256-v1', 'device-member-pairing-v1', 'device-member-state-v1']);
    expect([...entries.values()].join('\n')).not.toContain('value of');
    expect(calls.map((args) => args[1])).toEqual(['--label=BYOK device member keys', '--label=BYOK device pairing verification', '--label=BYOK device member state']);
    // The same service as the device enrollment entry.
    expect(new Set(calls.map((args) => args[args.indexOf('service') + 1])).size).toBe(1);
    for (const name of names) expect(await custody.read(name)).toBe(`value of ${name}`);
    await custody.delete('member-state');
    expect(await custody.read('member-state')).toBeUndefined();
  });

  it('deletes an absent Linux entry, and still reports a provider failure', async () => {
    const run = (stderr: string): DeviceCommandRunner => async () => ({ exitCode: 1, stdout: '', stderr });
    const custody = (stderr: string) => new OsDeviceMemberCustody({ storeDir: testScratchRoot(), productId: 'member-custody-test', platform: 'linux', commandRunner: run(stderr) });
    await expect(custody('').delete('member-state')).resolves.toBeUndefined();
    await expect(custody('Cannot autolaunch D-Bus').delete('member-state')).rejects.toThrow(/could not clear/u);
  });

  it('gives each Windows entry its own target, apart from the enrollment target', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const targets: string[] = [];
    const run: DeviceCommandRunner = async (executable, _args, stdin) => {
      if (path.win32.basename(executable).toLowerCase() === 'powershell.exe') return { exitCode: 0, stdout: '', stderr: '' };
      targets.push(Buffer.from((stdin ?? '').split('\n')[1]!, 'base64').toString('utf8'));
      return { exitCode: 44, stdout: '', stderr: '' };
    };
    const options = { storeDir: testScratchRoot(), productId: 'member-custody-test', platform: 'win32' as const, commandRunner: run };
    await new DeviceCredentialStore(options).read();
    const custody = new OsDeviceMemberCustody(options);
    for (const name of ['member-keys', 'pairing-verification', 'member-state'] as const) await custody.delete(name);
    const [enrollment, ...members] = targets;
    expect(enrollment).toMatch(/^com\.byok\.client\.device\.[0-9a-f]{64}$/u);
    expect(members).toEqual([`${enrollment}/device-member-p256-v1`, `${enrollment}/device-member-pairing-v1`, `${enrollment}/device-member-state-v1`]);
  });

  it('refuses an entry this client did not write', async () => {
    const { entries, custody } = linuxProvider();
    entries.set('device-member-p256-v1', 'foreign');
    await expect(custody.read('member-keys')).rejects.toBeInstanceOf(DeviceMemberCustodyError);
  });

  it('honors an explicit macOS keychain on every entry', async () => {
    const calls: Array<readonly string[]> = [];
    const run: DeviceCommandRunner = async (_executable, args, stdin) => {
      calls.push(stdin === undefined ? args : [stdin]);
      return { exitCode: 44, stdout: '', stderr: '' };
    };
    const custody = new OsDeviceMemberCustody({
      storeDir: testScratchRoot(), productId: 'member-custody-test', platform: 'darwin', commandRunner: run, macosKeychainPath: '/Users/test/byok.keychain',
    });
    expect(await custody.read('member-state')).toBeUndefined();
    await custody.delete('member-keys');
    expect(calls.map((args) => args.join(' '))).toEqual([
      expect.stringMatching(/^find-generic-password -a device-member-state-v1 .* -w \/Users\/test\/byok\.keychain$/u),
      expect.stringMatching(/^delete-generic-password -a device-member-p256-v1 .* \/Users\/test\/byok\.keychain$/u),
    ]);
  });
});

describe('DeviceMemberKeyStore', () => {
  it('creates a member once and loads the same keys afterwards', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    expect(await records.keys.load(DEVICE)).toBeUndefined();
    const created = await records.keys.loadOrCreate(DEVICE);
    const stored = custody.entries.get('member-keys');
    expect(created.binding).toEqual(DEVICE);
    expect(created.signing.privateKey.extractable).toBe(false);
    expect(created.kem.privateKey.extractable).toBe(false);
    const reloaded = await new DeviceMemberRecords(custody).keys.loadOrCreate(DEVICE);
    expect(reloaded.signing.publicJwk).toEqual(created.signing.publicJwk);
    expect(reloaded.kem.publicJwk).toEqual(created.kem.publicJwk);
    expect(custody.entries.get('member-keys')).toBe(stored);
  });

  it('gives a new enrollment a new member and loads nothing for another binding', async () => {
    const records = new DeviceMemberRecords(new InMemoryDeviceMemberCustody());
    const first = await records.keys.loadOrCreate(DEVICE);
    const next = await records.keys.loadOrCreate({ tenantId: 'tenant-a', deviceId: 'device-2' });
    expect(await deriveMemberId(next.signing.publicJwk)).not.toBe(await deriveMemberId(first.signing.publicJwk));
    expect(await records.keys.load(DEVICE)).toBeUndefined();
  });

  it('refuses a tampered record and never replaces it', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    await records.keys.loadOrCreate(DEVICE);
    const record = JSON.parse(custody.entries.get('member-keys')!) as { signingJwk: { d: string } };
    const other = JSON.parse((await (async () => {
      const spare = new InMemoryDeviceMemberCustody();
      await new DeviceMemberRecords(spare).keys.loadOrCreate(DEVICE);
      return spare.entries.get('member-keys')!;
    })())) as { signingJwk: { d: string } };
    const tampered = custody.entries.get('member-keys')!.replace(record.signingJwk.d, other.signingJwk.d);
    custody.entries.set('member-keys', tampered);
    await expect(records.keys.load(DEVICE)).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    await expect(records.keys.loadOrCreate(DEVICE)).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    expect(custody.entries.get('member-keys')).toBe(tampered);
  });

  it('returns the stored keys when another writer replaced the entry during a create', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const winner = new InMemoryDeviceMemberCustody();
    const winning = await new DeviceMemberRecords(winner).keys.loadOrCreate(DEVICE);
    const racing = Object.assign(Object.create(custody) as InMemoryDeviceMemberCustody, {
      replace: async (entry: string, value: string) => {
        await custody.replace(entry, value);
        custody.entries.set(entry, winner.entries.get(entry)!);
      },
    });
    const created = await new DeviceMemberRecords(racing).keys.loadOrCreate(DEVICE);
    expect(created.signing.publicJwk).toEqual(winning.signing.publicJwk);
  });
});

describe('DeviceMemberKeyStore KEM rotation (E2d-5, the keys tests that #841 removed)', () => {
  it('begins a KEM rotation beside the current key and keeps the member id (§7.5)', async () => {
    const records = new DeviceMemberRecords(new InMemoryDeviceMemberCustody());
    const created = await records.keys.loadOrCreate(DEVICE);
    expect(created.nextKem).toBeUndefined();
    const begun = await records.keys.beginKemRotation(DEVICE);
    expect(begun.kem).toMatchObject({ epoch: 1, publicJwk: created.kem.publicJwk });
    expect(begun.nextKem?.epoch).toBe(2);
    expect(begun.nextKem?.publicJwk).not.toEqual(created.kem.publicJwk);
    expect(await deriveMemberId(begun.signing.publicJwk)).toBe(await deriveMemberId(created.signing.publicJwk));
  });

  it('resumes a pending rotation after a restart and generates no other key', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    await new DeviceMemberRecords(custody).keys.loadOrCreate(DEVICE);
    const begun = await new DeviceMemberRecords(custody).keys.beginKemRotation(DEVICE);
    const stored = custody.entries.get('member-keys');
    const resumed = new DeviceMemberRecords(custody);
    expect((await resumed.keys.load(DEVICE))?.nextKem?.publicJwk).toEqual(begun.nextKem!.publicJwk);
    expect((await resumed.keys.beginKemRotation(DEVICE)).nextKem?.publicJwk).toEqual(begun.nextKem!.publicJwk);
    expect(custody.entries.get('member-keys')).toBe(stored);
  });

  it('finishes a rotation: the next key becomes current, the old private key is gone, and a repeat changes nothing', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    await records.keys.loadOrCreate(DEVICE);
    const oldScalar = (JSON.parse(custody.entries.get('member-keys')!) as { kemJwk: { d: string } }).kemJwk.d;
    const begun = await records.keys.beginKemRotation(DEVICE);
    const finished = await records.keys.finishKemRotation(DEVICE, 2);
    expect(finished.nextKem).toBeUndefined();
    expect(finished.kem).toMatchObject({ epoch: 2, publicJwk: begun.nextKem!.publicJwk });
    expect(custody.entries.get('member-keys')).not.toContain(oldScalar);
    const stored = custody.entries.get('member-keys');
    expect((await records.keys.finishKemRotation(DEVICE, 2)).kem.epoch).toBe(2);
    expect(custody.entries.get('member-keys')).toBe(stored);
    expect((await records.keys.beginKemRotation(DEVICE)).nextKem?.epoch).toBe(3);
  });

  it('refuses to finish a rotation that is not pending and changes nothing', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    await expect(records.keys.finishKemRotation(DEVICE, 2)).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    expect(custody.entries.has('member-keys')).toBe(false);
    await records.keys.loadOrCreate(DEVICE);
    const unrotated = custody.entries.get('member-keys');
    await expect(records.keys.finishKemRotation(DEVICE, 2)).rejects.toThrow(/cannot finish a KEM rotation to epoch 2/u);
    expect(custody.entries.get('member-keys')).toBe(unrotated);
    await records.keys.beginKemRotation(DEVICE);
    const pending = custody.entries.get('member-keys');
    await expect(records.keys.finishKemRotation(DEVICE, 3)).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    await expect(records.keys.finishKemRotation({ tenantId: 'tenant-a', deviceId: 'device-2' }, 2)).rejects.toThrow(/no device member keys of this enrollment/u);
    await expect(records.keys.beginKemRotation({ tenantId: 'tenant-a', deviceId: 'device-2' })).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    expect(custody.entries.get('member-keys')).toBe(pending);
  });

  it('refuses a record whose pending key was tampered with, and never replaces it', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    await records.keys.loadOrCreate(DEVICE);
    await records.keys.beginKemRotation(DEVICE);
    const record = JSON.parse(custody.entries.get('member-keys')!) as { kemJwk: { d: string }; nextKem: { jwk: { d: string } } };
    const tampered = custody.entries.get('member-keys')!.replace(record.nextKem.jwk.d, record.kemJwk.d);
    custody.entries.set('member-keys', tampered);
    await expect(records.keys.load(DEVICE)).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    await expect(records.keys.beginKemRotation(DEVICE)).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    await expect(records.keys.finishKemRotation(DEVICE, 2)).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    expect(custody.entries.get('member-keys')).toBe(tampered);
  });

  it('keeps the last write of two concurrent writers, and every later begin resumes it', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    await records.keys.loadOrCreate(DEVICE);
    const begun = await Promise.all([records.keys.beginKemRotation(DEVICE), new DeviceMemberRecords(custody).keys.beginKemRotation(DEVICE)]);
    const stored = (await records.keys.load(DEVICE))!.nextKem!.publicJwk;
    expect(begun.map((keys) => keys.nextKem!.publicJwk)).toContainEqual(stored);
    expect((await records.keys.beginKemRotation(DEVICE)).nextKem!.publicJwk).toEqual(stored);
  });

  it('fits a pending rotation in the OS entry bound', async () => {
    const memory = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(memory);
    await records.keys.loadOrCreate({ tenantId: 't'.repeat(64), deviceId: 'd'.repeat(64) });
    await records.keys.beginKemRotation({ tenantId: 't'.repeat(64), deviceId: 'd'.repeat(64) });
    const { custody } = linuxProvider();
    await custody.replace('member-keys', memory.entries.get('member-keys')!);
    expect(await custody.read('member-keys')).toBe(memory.entries.get('member-keys'));
  });
});

describe('DeviceMemberRecords', () => {
  it('round-trips the pending pv and refuses a malformed one', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    const pv = encodePairingVerificationSecret(generatePairingVerificationSecret());
    await records.savePending({ ...DEVICE, pv, deadline: 1_000 });
    expect(await records.readPending()).toEqual({ ...DEVICE, pv, deadline: 1_000 });
    custody.entries.set('pairing-verification', JSON.stringify({ v: 1, ...DEVICE, pv: 'short', deadline: 1_000 }));
    await expect(records.readPending()).rejects.toBeInstanceOf(DeviceMemberCustodyError);
  });

  it('refuses a member state whose bundle names another device, or an anchor without a head', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    // A bundle that parses, so each refusal below is the rule it names.
    const keys = await records.keys.loadOrCreate(DEVICE);
    const member = await createMemberKeyBundle({
      signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey,
      kemPublicJwk: keys.kem.publicJwk, kemEpoch: keys.kem.epoch, deviceId: DEVICE.deviceId,
    });
    const anchor = { approverSigningPublicJwk: keys.signing.publicJwk, entry: { seq: 1, hash: `sha256:${'0'.repeat(64)}` } };
    custody.entries.set('member-state', JSON.stringify({ v: 1, ...DEVICE, member, anchor, head: anchor.entry }));
    expect((await records.readState())?.anchor).toEqual(anchor);
    custody.entries.set('member-state', JSON.stringify({ v: 1, ...DEVICE, deviceId: 'device-2', member }));
    await expect(records.readState()).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    custody.entries.set('member-state', JSON.stringify({ v: 1, ...DEVICE, member, anchor }));
    await expect(records.readState()).rejects.toBeInstanceOf(DeviceMemberCustodyError);
  });

  it('throws when the provider reports a deletion it did not make (#861 L1)', async () => {
    class KeepsEntries extends InMemoryDeviceMemberCustody {
      override async delete(): Promise<void> {}
    }
    const custody = new KeepsEntries();
    const records = new DeviceMemberRecords(custody);
    await records.savePending({ ...DEVICE, pv: encodePairingVerificationSecret(generatePairingVerificationSecret()), deadline: 1 });
    await expect(records.deletePending()).rejects.toThrow('the member entry pairing-verification, but it remains');
    await expect(records.clear()).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    await records.keys.loadOrCreate(DEVICE);
    custody.entries.delete('pairing-verification');
    await expect(records.clear()).rejects.toThrow('the member entry member-keys, but it remains');
  });

  it('clears all three entries', async () => {
    const custody = new InMemoryDeviceMemberCustody();
    const records = new DeviceMemberRecords(custody);
    await records.keys.loadOrCreate(DEVICE);
    await records.savePending({ ...DEVICE, pv: encodePairingVerificationSecret(generatePairingVerificationSecret()), deadline: 1 });
    custody.entries.set('member-state', '{}');
    await records.clear();
    expect(custody.entries.size).toBe(0);
  });
});

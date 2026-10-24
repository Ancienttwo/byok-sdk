/**
 * #654 E2d-1: the device member entries (owner §50a D, 10b). The OS backend
 * uses the enrollment's provider with its own entry names; the key store
 * creates a member once, reloads it, refuses a tampered record, and keeps
 * the stored keys after a write.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { deriveMemberId, encodePairingVerificationSecret, generatePairingVerificationSecret } from '@byok-sdk/core/sealed-payload';
import { describe, expect, it } from 'vitest';
import type { DeviceCommandRunner } from '../daemon/device-credential-store';
import {
  DeviceMemberCustodyError,
  DeviceMemberRecords,
  OsDeviceMemberCustody,
  type DeviceMemberEntry,
} from '../daemon/device-member-custody';
import { InMemoryDeviceMemberCustody } from './fixtures/credential-backend';

const DEVICE = { tenantId: 'tenant-a', deviceId: 'device-1' };

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
    custody.entries.set('member-state', JSON.stringify({ v: 1, ...DEVICE, member: { v: 1 } }));
    await expect(records.readState()).rejects.toBeInstanceOf(DeviceMemberCustodyError);
    custody.entries.set('member-state', JSON.stringify({ v: 1, ...DEVICE, member: {}, anchor: {} }));
    await expect(records.readState()).rejects.toBeInstanceOf(DeviceMemberCustodyError);
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

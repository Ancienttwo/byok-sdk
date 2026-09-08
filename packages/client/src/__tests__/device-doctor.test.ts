import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnoseDevice, repairDeviceEnrollmentMetadata, DeviceMetadataRepairError, type DaemonConfig } from '../index';
import { DeviceStore, type DeviceRecord } from '../daemon/store';
import { AuthManager } from '../daemon/auth-manager';
import { acquireDaemonOwner } from '../daemon/daemon-owner';
import { connectControlClient } from '../bin/control-client';
import { runDoctorCommand } from '../bin/commands/doctor';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

vi.mock('../bin/control-client', () => ({ connectControlClient: vi.fn() }));

let root: string;
let config: DaemonConfig;
let store: DeviceStore;
const target = { confirmed: true as const, expectedDeviceId: 'device-a', expectedTenantId: 'tenant-a' };
const authority: DeviceRecord = {
  deviceId: 'device-a', tenantId: 'tenant-a', devicePublicKey: 'public-key-a',
  accessToken: 'secret-token-marker', expiresAt: '2099-01-01T00:00:00.000Z', devicePrivateKeyPem: 'secret-private-key-marker',
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-device-doctor-'));
  config = {
    productId: 'doctor-test', productName: 'Doctor test', localAgentRelease: { version: '0.0.0-test' },
    storeDir: root, workspaceRoot: root, serverUrl: 'https://unused.invalid',
  };
  store = new DeviceStore(root, undefined, config.productId);
  vi.mocked(connectControlClient).mockReset();
  vi.mocked(connectControlClient).mockResolvedValue({ ok: false, reason: 'offline' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network must not be used'); }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

async function seed(): Promise<void> { await store.credentials.replace(authority); }
async function bytes(): Promise<string> { return fs.readFile(path.join(root, 'device.json'), 'utf8'); }

describe('public enrollment metadata repair', () => {
  it('restores missing metadata, reads it back, and repeats without rewriting or exposing credentials', async () => {
    await seed();
    const writeSecret = vi.spyOn(store.credentials, 'replace');
    const result = await repairDeviceEnrollmentMetadata(config, target);
    expect(result).toEqual({ action: 'restore-enrollment-metadata', scope: 'device', status: 'repaired' });
    expect(JSON.parse(await bytes())).toEqual({ deviceId: 'device-a', tenantId: 'tenant-a', devicePublicKey: 'public-key-a' });
    const before = await fs.stat(path.join(root, 'device.json'));
    expect(await repairDeviceEnrollmentMetadata(config, target)).toMatchObject({ status: 'not-needed' });
    const after = await fs.stat(path.join(root, 'device.json'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(writeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result) + await bytes()).not.toMatch(/secret-token-marker|secret-private-key-marker/);
  });

  it('restores valid stale metadata using the same primitive as startup', async () => {
    await seed();
    await store.save({ deviceId: 'old-device', tenantId: 'old-tenant', devicePublicKey: 'old-key' });
    expect(await repairDeviceEnrollmentMetadata(config, target)).toMatchObject({ status: 'repaired' });
    const restored = await bytes();
    await fs.unlink(path.join(root, 'device.json'));
    const auth = new AuthManager({ serverUrl: config.serverUrl, store });
    expect(await auth.readCurrent()).toEqual(authority);
    expect(await bytes()).toBe(restored);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { confirmed: false, expectedDeviceId: 'device-a', expectedTenantId: 'tenant-a' },
    { confirmed: true, expectedDeviceId: '', expectedTenantId: 'tenant-a' },
    { confirmed: true, expectedDeviceId: 'device-a', expectedTenantId: '' },
  ])('rejects invalid consent/target before any control or credential access: %j', async (input) => {
    const read = vi.spyOn(store.credentials, 'read');
    await expect(repairDeviceEnrollmentMetadata(config, input as typeof target)).rejects.toBeInstanceOf(DeviceMetadataRepairError);
    expect(connectControlClient).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(['expectedDeviceId', 'expectedTenantId'] as const)('rejects mismatch of %s without changing metadata', async (key) => {
    await seed();
    await store.save({ deviceId: 'old-device', tenantId: 'old-tenant', devicePublicKey: 'old-key' });
    const before = await bytes();
    await expect(repairDeviceEnrollmentMetadata(config, { ...target, [key]: 'wrong' })).rejects.toMatchObject({ code: 'target-mismatch' });
    expect(await bytes()).toBe(before);
  });

  it('refuses missing authority even when metadata exists', async () => {
    await store.save({ deviceId: 'device-a', tenantId: 'tenant-a', devicePublicKey: 'public-key-a' });
    const before = await bytes();
    await expect(repairDeviceEnrollmentMetadata(config, target)).rejects.toMatchObject({ code: 'authority-missing' });
    expect(await bytes()).toBe(before);
  });

  it.each(['{broken', JSON.stringify(authority)])('preserves malformed/legacy projection byte-for-byte', async (raw) => {
    await seed();
    await fs.writeFile(path.join(root, 'device.json'), raw);
    const read = vi.spyOn(store.credentials, 'read');
    await expect(repairDeviceEnrollmentMetadata(config, target)).rejects.toMatchObject({ code: 'projection-unavailable' });
    expect(await bytes()).toBe(raw);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses symlink metadata and leaves its target untouched', async () => {
    await seed();
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, JSON.stringify(authority));
    await fs.symlink(outside, path.join(root, 'device.json'));
    await expect(repairDeviceEnrollmentMetadata(config, target)).rejects.toMatchObject({ code: 'projection-unavailable' });
    expect(await fs.readFile(outside, 'utf8')).toBe(JSON.stringify(authority));
    expect((await fs.lstat(path.join(root, 'device.json'))).isSymbolicLink()).toBe(true);
  });

  it('refuses a live owner even though control is offline; releases ownership after failure', async () => {
    await seed();
    const owner = await acquireDaemonOwner(root, 'daemon');
    try {
      await expect(repairDeviceEnrollmentMetadata(config, target)).rejects.toMatchObject({ code: 'store-busy' });
      expect(await store.load()).toBeUndefined();
    } finally { await owner.release(); }
    expect(await repairDeviceEnrollmentMetadata(config, target)).toMatchObject({ status: 'repaired' });
  });

  it('refuses reachable control and closes the connection', async () => {
    const close = vi.fn();
    vi.mocked(connectControlClient).mockResolvedValue({ ok: true, client: { close } as never });
    await expect(repairDeviceEnrollmentMetadata(config, target)).rejects.toMatchObject({ code: 'daemon-running' });
    expect(close).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('redacts authority errors and releases the owner before a later attempt', async () => {
    await seed();
    const read = vi.spyOn(store.credentials, 'read').mockRejectedValueOnce(new Error('secret-token-marker /private/path'));
    const error = await repairDeviceEnrollmentMetadata(config, target).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'authority-unavailable' });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/secret-token-marker|private\/path/);
    expect(error).not.toHaveProperty('cause');
    read.mockRestore();
    expect(await repairDeviceEnrollmentMetadata(config, target)).toMatchObject({ status: 'repaired' });
  });

  it('does not report success when projection publication fails', async () => {
    await seed();
    vi.spyOn(DeviceStore.prototype, 'save').mockRejectedValueOnce(new Error('secret-private-key-marker'));
    await expect(repairDeviceEnrollmentMetadata(config, target)).rejects.toMatchObject({ code: 'repair-failed' });
    expect(await store.load()).toBeUndefined();
  });
});

describe('public diagnostics and CLI consumers', () => {
  it('uses the embedded host adapter, stays read-only, and does not open OS credentials', async () => {
    const adapter = new StubRuntimeAdapter();
    const detect = vi.spyOn(adapter, 'detect').mockResolvedValue({ kind: 'not-executable' });
    const read = vi.spyOn(store.credentials, 'read');
    const report = await diagnoseDevice(config, { adapters: [adapter] });
    expect(report.runtimes).toMatchObject([{ present: false, outcome: 'not-executable' }]);
    expect(detect).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('CLI named repair uses the same public action and emits only a repair receipt', async () => {
    await seed();
    const lines: string[] = [];
    await runDoctorCommand(config, {
      repair: 'restore-enrollment-metadata', confirmed: true, expectedDeviceId: 'device-a', expectedTenantId: 'tenant-a',
      json: true, log: (line) => lines.push(line),
    });
    expect(JSON.parse(lines.join(''))).toEqual({ repair: { action: 'restore-enrollment-metadata', scope: 'device', status: 'repaired' } });
  });

  it('checks post-write metadata rather than claiming success on a silent save failure', async () => {
    await seed();
    vi.spyOn(DeviceStore.prototype, 'save').mockResolvedValueOnce(undefined);
    await expect(repairDeviceEnrollmentMetadata(config, target)).rejects.toMatchObject({ code: 'repair-failed' });
  });

  it('packaged CLI routes the named action and refuses missing confirmation before credential access', async () => {
    const configPath = path.join(root, 'agent.json');
    const { localAgentRelease: _release, ...cliConfig } = config;
    await fs.writeFile(configPath, JSON.stringify(cliConfig));
    const command = spawnSync(process.execPath, [
      path.resolve('dist/bin/byok-agent.js'), 'doctor', '--repair', 'restore-enrollment-metadata',
      '--expected-device-id', 'device-a', '--expected-tenant-id', 'tenant-a', '--json', '--config', configPath,
    ], { encoding: 'utf8', env: { ...process.env, BYOK_TEST_DEVICE_CREDENTIAL_STORE: '1' }, timeout: 10_000 });
    expect(command.status).toBe(1);
    expect(command.stderr).toContain('Explicit confirmation');
    expect(JSON.parse(command.stdout)).toMatchObject({ repair: { status: 'failed', code: 'confirmation-required' } });
    expect(await fs.readdir(root)).toEqual(['agent.json']);
  });

  it.each([
    { repair: '' }, { repair: 'everything' }, { repair: 'restore-enrollment-metadata', fix: true },
    { expectedDeviceId: 'device-a' },
  ])('rejects conflicting/unsupported CLI actions before mutation: %j', async (options) => {
    await expect(runDoctorCommand(config, { ...options, confirmed: true })).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
  });
});

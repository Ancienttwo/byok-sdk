import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceStore, type DeviceRecord } from '../daemon/store';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const record: DeviceRecord = {
  deviceId: 'device-1',
  accessToken: 'token-1',
  expiresAt: '2026-01-01T00:00:00.000Z',
  devicePrivateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  devicePublicKey: 'pubkey-base64url',
};

/**
 * `DeviceStore.save` now goes through `atomicWriteFile` (see
 * `util/atomic-write.ts`) instead of a plain `fs.writeFile` + explicit
 * `chmod`. `daemon-auth.test.ts` already covers the end-to-end
 * pair()-writes-device.json-0600 path through `AuthManager`; these tests
 * exercise `DeviceStore` directly, in isolation, including the
 * mode-preserved-across-a-replace property the atomic rename depends on.
 */
describe('DeviceStore (atomic write path)', () => {
  let storeDir: string;

  afterEach(async () => {
    if (storeDir) await fs.rm(storeDir, { recursive: true, force: true });
  });

  it('round-trips a DeviceRecord through save()/load()', async () => {
    storeDir = await tmpDir('byok-device-store-');
    const store = new DeviceStore(storeDir);

    expect(await store.load()).toBeUndefined();

    await store.save(record);
    expect(await store.load()).toEqual(record);
  });

  it('persists device.json at 0600, including when a previous file existed with a different mode', async () => {
    storeDir = await tmpDir('byok-device-store-');
    const filePath = path.join(storeDir, 'device.json');
    // Simulate a pre-existing, permissively-moded file (e.g. left over from
    // before 0600 was load-bearing, or created under a permissive umask).
    // A plain `fs.writeFile({ mode: 0o600 })` would not have fixed this
    // retroactively, since `mode` on `open()` only governs permissions at
    // creation time.
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(filePath, '{}', { mode: 0o644 });

    const store = new DeviceStore(storeDir);
    await store.save(record);

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual(record);
  });

  it('M4 Fix 3: a pre-existing storeDir with a permissive mode gets tightened to 0700 on save() (mirrors bin/audit-log.ts\'s identical fix for its own storeDir)', async () => {
    const parent = await tmpDir('byok-device-store-mode-parent-');
    storeDir = path.join(parent, 'permissive-store');
    // Simulate a pre-existing, permissively-moded storeDir (predates this
    // fix, or created by something else under a looser umask). `mkdir`'s own
    // `mode` argument only governs permissions at CREATION time, so the
    // pre-fix `fs.mkdir(dir, { recursive: true, mode: 0o700 })` alone never
    // retroactively tightened an already-existing, looser-moded directory —
    // only `audit-log.ts`'s own defensive `fs.chmod` (per-append) did, for
    // device.json's storeDir as a side effect. This is that same fix,
    // applied directly in `DeviceStore.save()` itself.
    await fs.mkdir(storeDir, { mode: 0o755 });
    const before = await fs.stat(storeDir);
    expect(before.mode & 0o777).toBe(0o755);

    const store = new DeviceStore(storeDir);
    await store.save(record);

    const after = await fs.stat(storeDir);
    expect(after.mode & 0o777).toBe(0o700);
    expect(await store.load()).toEqual(record);
  });

  it('leaves no leftover atomic-write temp file behind after save()', async () => {
    storeDir = await tmpDir('byok-device-store-');
    const store = new DeviceStore(storeDir);

    await store.save(record);

    const entries = await fs.readdir(storeDir);
    expect(entries).toEqual(['device.json']);
  });

  it('clear() removes device.json so a subsequent load() sees undefined again', async () => {
    storeDir = await tmpDir('byok-device-store-');
    const store = new DeviceStore(storeDir);

    await store.save(record);
    expect(await store.load()).toEqual(record);

    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
});

import { testScratchRoot } from './fixtures/execution-scratch';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createTestKeychain } from '../../../../scripts/testing/macos-keychain.mjs';
import { DeviceCredentialStore, OsCredentialEntry } from '../daemon/device-credential-store';
import { DeviceMemberRecords, OsDeviceMemberCustody } from '../daemon/device-member-custody';

const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawned.count += 1;
      return actual.spawn(...args);
    },
  };
});

const nativeWindowsSmoke =
  process.platform === 'win32' && process.env.BYOK_NATIVE_WINDOWS_CREDENTIAL_SMOKE === '1';

it.runIf(process.platform === 'darwin')('real macOS credentials survive fresh readers only in their explicit test keychain', async () => {
  const keychain = await createTestKeychain();
  const storeDir = await mkdtemp(path.join(os.tmpdir(), 'byok-native-device-'));
  const options = { productId: 'isolated-native-custody', storeDir, macosKeychainPath: keychain.path };
  const record = { deviceId: 'device', tenantId: 'tenant', devicePublicKey: 'public',
    accessToken: 'synthetic-test-token', expiresAt: '2030-01-01T00:00:00.000Z', devicePrivateKeyPem: 'synthetic-private' };
  try {
    const store = new DeviceCredentialStore(options);
    expect(await store.read()).toBeUndefined();
    await store.replace(record);
    expect(await new DeviceCredentialStore(options).read()).toEqual(record);
    expect(await new DeviceCredentialStore(options).clear()).toBe(true);
    expect(await store.read()).toBeUndefined();
  } finally {
    await keychain.dispose();
    await rm(storeDir, { recursive: true, force: true });
  }
});

const WARM_CALLS = 13;
const TIMING_RUNS = 10;
const TEST_TIMEOUT_MS = 120_000;

const record = {
  deviceId: 'device-native-windows-ci',
  tenantId: 'tenant-native-windows-ci',
  devicePublicKey: 'fixture-public-key',
  accessToken: 'fixture-access-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  devicePrivateKeyPem: 'fixture-private-key',
} as const;

function uniqueProductId(label: string): string {
  return `windows-credential-native-${label}-${process.pid}-${Date.now()}`;
}

function memberRecords(productId: string, storeDir: string): { custody: OsDeviceMemberCustody; records: DeviceMemberRecords } {
  const custody = new OsDeviceMemberCustody({ productId, storeDir });
  return { custody, records: new DeviceMemberRecords(custody) };
}

/** The 13 native calls of one pairing: clear the member, stage and commit the enrollment, write the member entries. */
async function pairingSequence(productId: string, storeDir: string): Promise<void> {
  const { custody, records } = memberRecords(productId, storeDir);
  const store = new DeviceCredentialStore({ productId, storeDir });
  await records.clear();
  await store.saveFirstPairingAttempt({ kind: 'first-pairing-attempt-v1', deviceName: 'native', devicePublicKey: record.devicePublicKey, devicePrivateKeyPem: record.devicePrivateKeyPem });
  await store.replace(record);
  await custody.replace('member-keys', 'keys');
  await custody.replace('pairing-verification', 'pending');
  await custody.replace('member-state', 'state');
}

async function clearPairing(productId: string, storeDir: string): Promise<void> {
  await new DeviceCredentialStore({ productId, storeDir }).clear();
  await memberRecords(productId, storeDir).records.clear();
}

/**
 * A reader and writer that shares nothing with production: its own CREDENTIALW
 * declaration in C#, in its own process. It proves the bytes on both sides.
 */
const INDEPENDENT_CREDENTIAL_TOOL = String.raw`
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -ErrorAction Stop -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class IndependentCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct C { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public UInt64 LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool R(string t, UInt32 ty, UInt32 f, out IntPtr p);
 [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool W(ref C c, UInt32 f);
 [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr p);
 public static string Read(string t) { IntPtr p; if(!R(t,1,0,out p)) throw new Exception("read " + Marshal.GetLastWin32Error()); C c=(C)Marshal.PtrToStructure(p,typeof(C)); byte[] b=new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob,b,0,b.Length); CredFree(p); return String.Join("\n", new string[] { c.Type.ToString(), c.Persist.ToString(), c.TargetName, c.UserName, Convert.ToBase64String(b) }); }
 public static void Write(string t, string u, byte[] b) { IntPtr p=Marshal.AllocHGlobal(b.Length); Marshal.Copy(b,0,p,b.Length); C c=new C { Type=1, TargetName=t, CredentialBlobSize=(UInt32)b.Length, CredentialBlob=p, Persist=2, UserName=u }; bool ok=W(ref c,0); int code=Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(p); if(!ok) throw new Exception("write " + code); }
}
"@
if ($request.value) { [IndependentCredential]::Write($request.target, $request.account, [Convert]::FromBase64String($request.value)) }
else { [Console]::Out.Write([IndependentCredential]::Read($request.target)) }
`;

function independentTool(request: { target: string; account?: string; value?: string }): string {
  const powershell = path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(INDEPENDENT_CREDENTIAL_TOOL, 'utf16le').toString('base64')], {
    input: JSON.stringify(request), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

describe.skipIf(!nativeWindowsSmoke)('Windows Credential Manager native smoke', () => {
  it('round-trips the enrollment and each member entry through fresh instances', async () => {
    const storeDir = testScratchRoot();
    const productId = uniqueProductId('round-trip');
    try {
      expect(await new DeviceCredentialStore({ productId, storeDir }).read()).toBeUndefined();
      await new DeviceCredentialStore({ productId, storeDir }).replace(record);
      expect(await new DeviceCredentialStore({ productId, storeDir }).read()).toEqual(record);
      expect(await new DeviceCredentialStore({ productId, storeDir }).clear()).toBe(true);
      expect(await new DeviceCredentialStore({ productId, storeDir }).read()).toBeUndefined();

      for (const entry of ['member-keys', 'pairing-verification', 'member-state'] as const) {
        expect(await memberRecords(productId, storeDir).custody.read(entry)).toBeUndefined();
        await memberRecords(productId, storeDir).custody.replace(entry, `value of ${entry}`);
        expect(await memberRecords(productId, storeDir).custody.read(entry)).toBe(`value of ${entry}`);
        await memberRecords(productId, storeDir).custody.delete(entry);
        expect(await memberRecords(productId, storeDir).custody.read(entry)).toBeUndefined();
      }
    } finally {
      await clearPairing(productId, storeDir);
    }
  }, TEST_TIMEOUT_MS);

  it('keeps the entry bytes an independent Win32 reader and writer agree on', async () => {
    const storeDir = testScratchRoot();
    const productId = uniqueProductId('format');
    const account = 'device-enrollment';
    const entry = new OsCredentialEntry({ productId, storeDir, account, label: 'format', subject: 'format' });
    const target = `com.byok.client.device.${createHash('sha256').update(productId, 'utf8').digest('hex')}`;
    const value = 'byok-账户-value';
    try {
      await entry.replace(value);
      expect(independentTool({ target }).split('\n')).toEqual(['1', '2', target, account, Buffer.from(value, 'utf8').toString('base64')]);

      const written = `${value}-independent`;
      independentTool({ target, account, value: Buffer.from(written, 'utf8').toString('base64') });
      expect(await entry.read()).toBe(written);
    } finally {
      await entry.delete();
    }
  }, TEST_TIMEOUT_MS);

  it('runs a pairing sequence with no child process and no file', async () => {
    const storeDir = testScratchRoot();
    const productId = uniqueProductId('no-disk');
    const listing = async (): Promise<string[][]> => [await readdir(os.tmpdir()), await readdir(storeDir)];
    const before = await listing();
    const spawnedBefore = spawned.count;
    try {
      await pairingSequence(productId, storeDir);
      expect(spawned.count).toBe(spawnedBefore);
      expect(await listing()).toEqual(before);
    } finally {
      await clearPairing(productId, storeDir);
    }
  }, TEST_TIMEOUT_MS);

  it('reads the last error of an async call in its callback', async () => {
    const options = { productId: uniqueProductId('last-error'), storeDir: testScratchRoot(), label: 'last error', subject: 'last error' };
    const missing = new OsCredentialEntry({ ...options, account: 'missing' });
    await expect(missing.read()).resolves.toBeUndefined();
    await expect(missing.delete()).resolves.toBeUndefined();
    const oversized = new OsCredentialEntry({ ...options, account: 'x'.repeat(40_000) });
    // RPC_S_INVALID_BOUND: an oversized target fails in the credential service's RPC layer.
    await expect(oversized.read()).rejects.toThrow('(win32=1734)');
    await expect(oversized.replace('value')).rejects.toThrow('(win32=1734)');
  }, TEST_TIMEOUT_MS);

  it('meets the first-call, warm-call and pairing time bounds', async () => {
    const scratch = testScratchRoot();
    const client = pathToFileURL(path.resolve('dist/index.js')).href;
    const script = path.join(await mkdtemp(path.join(scratch, 'timing-')), 'first-call.mjs');
    await writeFile(script, `import { readDeviceEnrollmentStatus } from ${JSON.stringify(client)};
const startedAt = performance.now();
await readDeviceEnrollmentStatus({ productId: process.argv[2], storeDir: process.argv[3] });
process.stdout.write(String(performance.now() - startedAt));
`);
    const first = Array.from({ length: TIMING_RUNS }, () => Number(execFileSync(process.execPath, [script, uniqueProductId('first'), scratch], { encoding: 'utf8' })));

    const productId = uniqueProductId('warm');
    const entry = new OsCredentialEntry({ productId, storeDir: scratch, account: 'warm', label: 'warm', subject: 'warm' });
    const warm: number[] = [];
    const pairing: number[] = [];
    try {
      await entry.read();
      for (let run = 0; run < TIMING_RUNS; run += 1) {
        for (let call = 0; call < WARM_CALLS; call += 1) {
          const startedAt = performance.now();
          await entry.read();
          warm.push(performance.now() - startedAt);
        }
        const startedAt = performance.now();
        await pairingSequence(productId, scratch);
        pairing.push(performance.now() - startedAt);
        await clearPairing(productId, scratch);
      }
    } finally {
      await clearPairing(productId, scratch);
    }

    const rounded = (samples: readonly number[]): string => samples.map((sample) => sample.toFixed(1)).join(',');
    console.info(`windows-credential-native first_call_ms=${rounded(first)}`);
    console.info(`windows-credential-native warm_p95_ms=${percentile95(warm).toFixed(1)} warm_max_ms=${Math.max(...warm).toFixed(1)}`);
    console.info(`windows-credential-native pairing_13_calls_ms=${rounded(pairing)}`);
    expect(Math.max(...first)).toBeLessThanOrEqual(2_000);
    expect(percentile95(warm)).toBeLessThanOrEqual(100);
    expect(Math.max(...pairing)).toBeLessThanOrEqual(1_000);
  }, TEST_TIMEOUT_MS);
});

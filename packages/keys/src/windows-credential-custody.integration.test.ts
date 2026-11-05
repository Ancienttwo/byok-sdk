/**
 * SDK Windows v1 gate (plan A11): sealed provisioning against the REAL
 * Windows Credential Manager, run by the CI `windows-latest` and
 * `windows-2022` legs as the runner's own user (same-user convention: the
 * daemon that applies a provisioning request and the launcher that reads the
 * key run as one user).
 *
 * Enabled only with `BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER=1`; setting the flag
 * off win32 is a hard failure, never a skip. Every entry is written under a
 * unique service prefix and removed afterwards.
 */
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { DEVICE_SEALING_SECRET_NAME, DeviceSealingKeyStore } from './device-sealing-key';
import { DEVICE, NOW, PROFILE_REF, TENANT, configureRequest, deleteRequest, placedIdentity, replaceSecretRequest } from './fixtures/provisioning-requests';
import { readProviderCustodySnapshot } from './pi-provider-launcher-core';
import { exactProviderProfileBinding } from './provider-profile-binding';
import { applySealedProviderProvisioning } from './sealed-provisioning';
import { modelProviderSecretName } from './secret-store';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { runCommand } from './command-runner';
import { WindowsCredentialManagerSecretStore } from './windows-credential-manager';

const ENABLED = process.env.BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER === '1';
/** The independent probes below start PowerShell and compile; the store itself takes milliseconds. */
const REAL_BACKEND_TIMEOUT_MS = 60_000;
if (ENABLED && process.platform !== 'win32') {
  throw new Error('BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER=1 requires win32; refusing to skip');
}

const prefix = `com.byok.keys.ci-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const directory = ENABLED ? mkdtempSync(join(tmpdir(), 'byok-keys-wincred-')) : '';

describe.skipIf(!ENABLED)('sealed provisioning on Windows Credential Manager', () => {
  const secrets = new WindowsCredentialManagerSecretStore({ servicePrefix: prefix });

  afterAll(async () => {
    try {
      await secrets.delete(DEVICE_SEALING_SECRET_NAME);
      await secrets.delete(modelProviderSecretName(PROFILE_REF));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, REAL_BACKEND_TIMEOUT_MS);

  it('reports an absent credential as absent (read) and as false (delete)', async () => {
    await expect(secrets.get('model-absent-probe-api-key')).resolves.toBeUndefined();
    await expect(secrets.delete('model-absent-probe-api-key')).resolves.toBe(false);
  }, REAL_BACKEND_TIMEOUT_MS);

  it('reads the Win32 error of a failed call from the async callback', async () => {
    const tooLong = new WindowsCredentialManagerSecretStore({ servicePrefix: `${prefix}-${'a'.repeat(33_000)}` });
    // Both calls fail in the RPC to lsass with RPC_S_INVALID_BOUND.
    await expect(tooLong.get('model-absent-probe-api-key')).rejects.toThrow('win32=1734');
    await expect(tooLong.set('model-absent-probe-api-key', 'sk-wincred-too-long')).rejects.toThrow('win32=1734');
  }, REAL_BACKEND_TIMEOUT_MS);

  /**
   * The entry format every earlier release wrote, through the C# bridge those
   * releases used. Independent of the store under test: the script (and the
   * target inside it) travels as UTF-16LE base64 on the command line.
   */
  async function independentEntry(operation: string): Promise<string> {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace ByokEntryProbe {
  public static class Native {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public UInt32 Flags;
      public UInt32 Type;
      [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
      [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public UInt32 CredentialBlobSize;
      public IntPtr CredentialBlob;
      public UInt32 Persist;
      public UInt32 AttributeCount;
      public IntPtr Attributes;
      [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
      [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }
    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref Credential credential, UInt32 flags);
    [DllImport("Advapi32.dll", SetLastError = false)]
    private static extern void CredFree(IntPtr buffer);
    public static string Read(string target) {
      IntPtr pointer;
      if (!CredRead(target, 1, 0, out pointer)) return "win32=" + Marshal.GetLastWin32Error();
      try {
        Credential entry = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
        byte[] blob = new byte[entry.CredentialBlobSize];
        if (blob.Length > 0) Marshal.Copy(entry.CredentialBlob, blob, 0, blob.Length);
        return String.Join("|", entry.Flags, entry.Type, entry.Persist, entry.AttributeCount, entry.Comment, entry.TargetAlias, Convert.ToBase64String(Encoding.UTF8.GetBytes(entry.UserName)), Convert.ToBase64String(blob));
      } finally {
        CredFree(pointer);
      }
    }
    public static string Write(string target, string username, string secret) {
      byte[] bytes = Encoding.UTF8.GetBytes(secret);
      IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
      try {
        Marshal.Copy(bytes, 0, blob, bytes.Length);
        Credential entry = new Credential {
          Type = 1, TargetName = target, CredentialBlobSize = (UInt32)bytes.Length,
          CredentialBlob = blob, Persist = 2, UserName = username
        };
        return CredWrite(ref entry, 0) ? "written" : "win32=" + Marshal.GetLastWin32Error();
      } finally {
        Marshal.FreeHGlobal(blob);
      }
    }
  }
}
"@
[Console]::Out.Write([ByokEntryProbe.Native]::${operation})
`;
    const result = await runCommand('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const readIndependently = (target: string) => {
    expect(target).not.toContain("'");
    return independentEntry(`Read('${target}')`);
  };

  it('writes and reads the same entry bytes as every earlier release', async () => {
    const name = 'model-format-probe-api-key';
    const secret = 'sk-wincred-format-余额';
    const target = `${prefix}.${name}`;
    try {
      await secrets.set(name, secret);
      await expect(readIndependently(target)).resolves.toBe(
        `0|1|2|0|||${base64('local-device')}|${base64(secret)}`,
      );
      await secrets.delete(name);
      await expect(independentEntry(`Write('${target}', 'local-device', 'sk-wincred-format-earlier')`)).resolves.toBe('written');
      await expect(secrets.get(name)).resolves.toBe('sk-wincred-format-earlier');
    } finally {
      await secrets.delete(name);
    }
  }, REAL_BACKEND_TIMEOUT_MS);

  it('applies concurrent writes in call order', async () => {
    const name = 'model-queue-probe-api-key';
    try {
      await Promise.all(Array.from({ length: 8 }, (_, index) => secrets.set(name, `sk-wincred-queue-${index}`)));
      await expect(secrets.get(name)).resolves.toBe('sk-wincred-queue-7');
    } finally {
      await secrets.delete(name);
    }
  }, REAL_BACKEND_TIMEOUT_MS);

  it('keeps non-ASCII targets and accounts distinct', async () => {
    // A set/get round trip through one store would pass even with garbled but
    // distinct strings, so the proof is the target as Credential Manager holds
    // it: read back independently, it must exist under the real Unicode string.
    const name = 'model-unicode-probe-api-key';
    const firstPrefix = `${prefix}-账`;
    const secondPrefix = `${prefix}-户`;
    const first = new WindowsCredentialManagerSecretStore({ servicePrefix: firstPrefix, account: 'local-账' });
    const second = new WindowsCredentialManagerSecretStore({ servicePrefix: secondPrefix, account: 'local-户' });
    try {
      await first.set(name, 'sk-wincred-unicode-first');
      await expect(readIndependently(`${firstPrefix}.${name}`)).resolves.toContain(`|${base64('local-账')}|`);
      await expect(readIndependently(`${secondPrefix}.${name}`)).resolves.toBe('win32=1168');
      await second.set(name, 'sk-wincred-unicode-second');
      await expect(readIndependently(`${secondPrefix}.${name}`)).resolves.toContain(`|${base64('local-户')}|`);
      await expect(first.get(name)).resolves.toBe('sk-wincred-unicode-first');
      await expect(second.get(name)).resolves.toBe('sk-wincred-unicode-second');
    } finally {
      await first.delete(name).catch(() => false);
      await second.delete(name).catch(() => false);
    }
  }, REAL_BACKEND_TIMEOUT_MS);

  it('creates the sealing key, applies configure/replace/delete, and the launcher reads only consistent pairs', async () => {
    await expect(secrets.available()).resolves.toBe(true);
    const enrollment = { tenantId: TENANT, deviceId: DEVICE };
    const sealingKey = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(enrollment);
    const reloaded = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(enrollment);
    expect(reloaded.keyId).toBe(sealingKey.keyId);

    const profileStore = new SqliteProviderProfileStore({ path: join(directory, 'provider-profile.sqlite') });
    const apply = (request: unknown) => applySealedProviderProvisioning({
      request, profileStore, secretStore: secrets, sealingKey,
      resolveProfileRef: () => PROFILE_REF, readIdentity: async () => placedIdentity(), now: () => new Date(NOW),
    });
    const expected = async () => {
      const binding = exactProviderProfileBinding((await profileStore.get(PROFILE_REF))!, []);
      return { profileRef: binding.profileRef, profileRevision: binding.profileRevision, profileHash: binding.profileHash };
    };

    expect(await apply(await configureRequest(sealingKey, 'sk-wincred-canary-first', { requestId: 'w1', generation: 1 })))
      .toMatchObject({ outcome: 'applied', secretConfigured: true });
    const profile = (await profileStore.get(PROFILE_REF))!;
    const spawned = vi.spyOn(ChildProcess.prototype as unknown as { spawn(): void }, 'spawn');
    await expect(readProviderCustodySnapshot({ profiles: profileStore, profile, createSecretStore: () => secrets }))
      .resolves.toBe('sk-wincred-canary-first');
    expect(spawned).not.toHaveBeenCalled();
    await runCommand(process.execPath, ['-e', '']);
    expect(spawned).toHaveBeenCalledTimes(1);
    spawned.mockRestore();

    expect(await apply(await replaceSecretRequest(sealingKey, 'sk-wincred-canary-second', { requestId: 'w2', generation: 2, expected: await expected() })))
      .toMatchObject({ outcome: 'applied' });
    await expect(readProviderCustodySnapshot({ profiles: profileStore, profile, createSecretStore: () => secrets }))
      .resolves.toBe('sk-wincred-canary-second');

    expect(await apply(await deleteRequest({ requestId: 'w3', generation: 3, expected: await expected() })))
      .toMatchObject({ outcome: 'applied', secretConfigured: false });
    await expect(secrets.has(modelProviderSecretName(PROFILE_REF))).resolves.toBe(false);
    await profileStore.close();
  }, REAL_BACKEND_TIMEOUT_MS);
});

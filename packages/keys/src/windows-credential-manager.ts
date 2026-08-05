import { type CommandResult, type CommandRunner, runCommand } from './command-runner';
import { ByokKeysError } from './errors';
import { assertSecretName, assertSecretNamespace } from './secret-name';
import {
  DEFAULT_SECRET_SERVICE_PREFIX,
  type SecretStore,
  decodeStrictBase64Utf8,
} from './secret-store';

/** The script exits 44 for "no such credential", matching `security`'s code. */
const CREDENTIAL_NOT_FOUND = 44;

/**
 * PowerShell bridge to the Win32 credential API, ported from
 * `aip-main-open@c6a5385` `apps/local-agent/src/index.ts:294-408`.
 *
 * It is passed as `-EncodedCommand` (UTF-16LE base64) so no part of it can be
 * mangled by shell quoting, and the request — including the secret — travels on
 * stdin rather than argv, keeping credentials out of process listings. The
 * generated C# type lives in namespace `Byok`; the source used its own vendor
 * name, and the identifier has no wire or storage surface, so renaming it costs
 * nothing at K4.
 */
const WINDOWS_CREDENTIAL_MANAGER_SCRIPT_BASE64 = Buffer.from(
  String.raw`
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace Byok {
  public static class CredentialManager {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
      public UInt32 Flags;
      public UInt32 Type;
      [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
      [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
      public FILETIME LastWritten;
      public UInt32 CredentialBlobSize;
      public IntPtr CredentialBlob;
      public UInt32 Persist;
      public UInt32 AttributeCount;
      public IntPtr Attributes;
      [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
      [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref Credential credential, UInt32 flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("Advapi32.dll", SetLastError = false)]
    private static extern void CredFree(IntPtr buffer);

    public static void Write(string target, string username, byte[] secret) {
      IntPtr blob = IntPtr.Zero;
      try {
        blob = Marshal.AllocHGlobal(secret.Length);
        Marshal.Copy(secret, 0, blob, secret.Length);
        Credential credential = new Credential {
          Type = 1,
          TargetName = target,
          CredentialBlobSize = (UInt32)secret.Length,
          CredentialBlob = blob,
          Persist = 2,
          UserName = username
        };
        if (!CredWrite(ref credential, 0)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
      } finally {
        if (blob != IntPtr.Zero) {
          Marshal.Copy(new byte[secret.Length], 0, blob, secret.Length);
          Marshal.FreeHGlobal(blob);
        }
      }
    }

    public static byte[] Read(string target) {
      IntPtr pointer;
      if (!CredRead(target, 1, 0, out pointer)) {
        int error = Marshal.GetLastWin32Error();
        if (error == 1168) return null;
        throw new Win32Exception(error);
      }
      try {
        Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
        byte[] secret = new byte[credential.CredentialBlobSize];
        if (secret.Length > 0) Marshal.Copy(credential.CredentialBlob, secret, 0, secret.Length);
        return secret;
      } finally {
        CredFree(pointer);
      }
    }

    public static bool Delete(string target) {
      if (CredDelete(target, 1, 0)) return true;
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return false;
      throw new Win32Exception(error);
    }
  }
}
"@

try {
  $request = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
  if ($request.operation -eq "set") {
    [Byok.CredentialManager]::Write(
      [string]$request.target,
      [string]$request.username,
      [Convert]::FromBase64String([string]$request.secret_base64)
    )
    exit 0
  }
  if ($request.operation -eq "get") {
    $secret = [Byok.CredentialManager]::Read([string]$request.target)
    if ($null -eq $secret) { exit 44 }
    [Console]::Out.Write([Convert]::ToBase64String($secret))
    exit 0
  }
  if ($request.operation -eq "delete") {
    if ([Byok.CredentialManager]::Delete([string]$request.target)) { exit 0 }
    exit 44
  }
  exit 2
} catch {
  [Console]::Error.Write("credential operation failed")
  exit 1
}
`,
  'utf16le',
).toString('base64');

export interface WindowsCredentialManagerSecretStoreOptions {
  account?: string;
  commandRunner?: CommandRunner;
  platform?: NodeJS.Platform;
  servicePrefix?: string;
}

/**
 * Windows Credential Manager backend (`index.ts:568-712`).
 *
 * As on macOS there is no plaintext fallback — off win32 every operation throws
 * `CREDENTIAL_MANAGER_UNAVAILABLE`.
 */
export class WindowsCredentialManagerSecretStore<TName extends string = string>
  implements SecretStore<TName>
{
  readonly providerLabel = 'Windows Credential Manager';
  readonly #account: string;
  readonly #commandRunner: CommandRunner;
  readonly #platform: NodeJS.Platform;
  readonly #servicePrefix: string;

  constructor(options: WindowsCredentialManagerSecretStoreOptions = {}) {
    this.#account = options.account ?? 'local-device';
    this.#commandRunner = options.commandRunner ?? runCommand;
    this.#platform = options.platform ?? process.platform;
    this.#servicePrefix = options.servicePrefix ?? DEFAULT_SECRET_SERVICE_PREFIX;
  }

  async available(): Promise<boolean> {
    if (this.#platform !== 'win32') return false;
    const result = await this.#commandRunner('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$PSVersionTable.PSVersion.Major',
    ]);
    return result.exitCode === 0;
  }

  /**
   * Delete, then read back. The source verifies rather than trusting the
   * delete's exit code (`index.ts:651-679`): a credential that survives a
   * "successful" delete is a security failure, so it is reported as one instead
   * of being returned as `true`.
   */
  async delete(name: TName): Promise<boolean> {
    const target = this.#service(name);
    this.#assertWindows();
    const result = await this.#invoke({
      operation: 'delete',
      target,
      username: this.#account,
    });
    if (result.exitCode === CREDENTIAL_NOT_FOUND) return false;
    if (result.exitCode !== 0) {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_DELETE_FAILED',
        'Windows Credential Manager could not delete the requested secret',
      );
    }
    const verification = await this.#invoke({
      operation: 'get',
      target,
      username: this.#account,
    });
    if (verification.exitCode === CREDENTIAL_NOT_FOUND) return true;
    if (verification.exitCode !== 0) {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_DELETE_FAILED',
        'Windows Credential Manager could not verify secret deletion',
      );
    }
    throw new ByokKeysError(
      'CREDENTIAL_MANAGER_DELETE_FAILED',
      'Windows Credential Manager reported deletion but the secret remains',
    );
  }

  async get(name: TName): Promise<string | undefined> {
    const target = this.#service(name);
    this.#assertWindows();
    const result = await this.#invoke({
      operation: 'get',
      target,
      username: this.#account,
    });
    if (result.exitCode === CREDENTIAL_NOT_FOUND) return undefined;
    if (result.exitCode !== 0) {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_READ_FAILED',
        'Windows Credential Manager could not read the requested secret',
      );
    }
    // The source wrapped this decode in try/catch, but `Buffer.from` never
    // throws on bad input -- it silently drops the offending characters, so
    // that branch was unreachable. The strict decoder makes it real.
    const secret = decodeStrictBase64Utf8(result.stdout.trim());
    if (secret === undefined || secret.length === 0) {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_READ_FAILED',
        'Windows Credential Manager returned an invalid secret',
      );
    }
    return secret;
  }

  async has(name: TName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  scope(namespace: string): SecretStore<TName> {
    return new WindowsCredentialManagerSecretStore<TName>({
      account: this.#account,
      commandRunner: this.#commandRunner,
      platform: this.#platform,
      servicePrefix: `${this.#servicePrefix}.scope.${assertSecretNamespace(namespace)}`,
    });
  }

  async set(name: TName, secret: string): Promise<void> {
    const target = this.#service(name);
    this.#assertWindows();
    assertWindowsCredentialSecret(secret);
    const result = await this.#invoke({
      operation: 'set',
      secret_base64: Buffer.from(secret, 'utf8').toString('base64'),
      target,
      username: this.#account,
    });
    if (result.exitCode !== 0) {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_WRITE_FAILED',
        'Windows Credential Manager could not store the requested secret',
      );
    }
  }

  #assertWindows(): void {
    if (this.#platform !== 'win32') {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_UNAVAILABLE',
        'Windows Credential Manager is required; plaintext fallback is disabled',
      );
    }
  }

  async #invoke(request: {
    operation: 'delete' | 'get' | 'set';
    secret_base64?: string;
    target: string;
    username: string;
  }): Promise<CommandResult> {
    return this.#commandRunner(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        WINDOWS_CREDENTIAL_MANAGER_SCRIPT_BASE64,
      ],
      JSON.stringify(request),
    );
  }

  #service(name: TName): string {
    return `${this.#servicePrefix}.${assertSecretName(name)}`;
  }
}

/**
 * `index.ts:2529-2543`. The ceiling is measured in UTF-8 bytes because that is
 * what `CredentialBlobSize` counts; a character-based check would let a
 * multi-byte secret overrun it.
 */
function assertWindowsCredentialSecret(secret: string): void {
  const bytes = Buffer.byteLength(secret, 'utf8');
  if (secret.length === 0 || bytes > 2_560 || /[\u0000\r\n]/u.test(secret)) {
    throw new ByokKeysError(
      'CREDENTIAL_MANAGER_SECRET_INVALID',
      'Secret must contain 1 to 2560 UTF-8 bytes without newline characters',
    );
  }
}

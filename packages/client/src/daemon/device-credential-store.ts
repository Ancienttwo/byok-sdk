import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTenantId } from '@byok-sdk/core';

/** Secret fields inside the internal complete enrollment authority. */
export interface DeviceCredentials {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly devicePrivateKeyPem: string;
}

/** Non-secret deterministic projection of the authenticated enrollment. */
export interface DeviceMetadata {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly devicePublicKey: string;
}

/**
 * The single local enrollment authority. Keeping identity and credential
 * bytes in one OS-managed entry prevents a crash from composing a token/key
 * from one pairing response with metadata from another.
 */
export type DeviceRecord = DeviceMetadata & DeviceCredentials;

export interface DeviceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type DeviceCommandRunner = (
  executable: string,
  args: readonly string[],
  stdin?: string,
) => Promise<DeviceCommandResult>;

const ENTRY_ACCOUNT = 'device-enrollment';
const ENCODED_PREFIX = 'byok-device-credential-v1:';
const NOT_FOUND = 44;
const WINDOWS_BRIDGE_DIRECTORY_PREFIX = 'byok-device-credential-';
const WINDOWS_BRIDGE_STALE_MS = 24 * 60 * 60 * 1_000;

function providerDiagnostic(stderr: string): string {
  const match = /credential operation failed \((win32=\d{1,10}|hresult=-?\d{1,11}|stage=\d{1,2},kind=\d{1,2},hresult=-?\d{1,11})\)/u.exec(stderr);
  return match === null ? '' : ` (${match[1]})`;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function scavengeStaleWindowsBridges(): Promise<void> {
  const temporaryRoot = os.tmpdir();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(temporaryRoot, { withFileTypes: true });
  } catch {
    throw new DeviceCredentialStoreError('temporary Windows credential bridge root is unavailable');
  }

  const staleBefore = Date.now() - WINDOWS_BRIDGE_STALE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WINDOWS_BRIDGE_DIRECTORY_PREFIX)) continue;
    const candidate = path.join(temporaryRoot, entry.name);
    try {
      const info = await fs.lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs >= staleBefore) continue;
      await fs.rm(candidate, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      throw new DeviceCredentialStoreError('stale Windows credential bridge cleanup failed');
    }
  }
}

/** Typed unavailability; callers must surface re-pair/operational failure, never write a file fallback. */
export class DeviceCredentialStoreUnavailableError extends Error {
  constructor(message = 'no supported operating-system credential provider is available') {
    super(message);
    this.name = 'DeviceCredentialStoreUnavailableError';
  }
}

export class DeviceCredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceCredentialStoreError';
  }
}

function assertRecord(value: unknown): asserts value is DeviceRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Partial<DeviceRecord>).deviceId !== 'string' ||
    !isTenantId((value as Partial<DeviceRecord>).tenantId) ||
    typeof (value as Partial<DeviceRecord>).devicePublicKey !== 'string' ||
    typeof (value as Partial<DeviceCredentials>).accessToken !== 'string' ||
    typeof (value as Partial<DeviceCredentials>).expiresAt !== 'string' ||
    typeof (value as Partial<DeviceCredentials>).devicePrivateKeyPem !== 'string'
  ) {
    throw new DeviceCredentialStoreError('OS credential entry has an invalid device credential shape');
  }
  const credential = value as DeviceRecord;
  if (
    credential.deviceId.length === 0 ||
    credential.devicePublicKey.length === 0 ||
    credential.accessToken.length === 0 ||
    credential.expiresAt.length === 0 ||
    credential.devicePrivateKeyPem.length === 0
  ) {
    throw new DeviceCredentialStoreError('OS credential entry has an incomplete device credential');
  }
}

function encode(record: DeviceRecord): string {
  assertRecord(record);
  const encoded = Buffer.from(JSON.stringify(record), 'utf8').toString('base64');
  const value = `${ENCODED_PREFIX}${encoded}`;
  // Windows generic-credential blobs are limited; do not silently truncate a
  // bearer/key authority into a different credential.
  if (Buffer.byteLength(value, 'utf8') > 2_400) {
    throw new DeviceCredentialStoreError('device credential exceeds the OS credential entry bound');
  }
  return value;
}

function decode(value: string): DeviceRecord {
  if (!value.startsWith(ENCODED_PREFIX)) {
    throw new DeviceCredentialStoreError('OS credential entry is not owned by this client credential store');
  }
  const encoded = value.slice(ENCODED_PREFIX.length);
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new DeviceCredentialStoreError('OS credential entry is not strict base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new DeviceCredentialStoreError('OS credential entry is not canonical base64');
  }
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw, 'utf8').equals(bytes)) {
    throw new DeviceCredentialStoreError('OS credential entry is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeviceCredentialStoreError('OS credential entry is not valid JSON');
  }
  assertRecord(parsed);
  return Object.freeze({
    deviceId: parsed.deviceId,
    tenantId: parsed.tenantId,
    devicePublicKey: parsed.devicePublicKey,
    accessToken: parsed.accessToken,
    expiresAt: parsed.expiresAt,
    devicePrivateKeyPem: parsed.devicePrivateKeyPem,
  });
}

function serviceFor(productId: string): string {
  if (typeof productId !== 'string' || productId.length === 0 || /[\u0000\r\n]/u.test(productId)) {
    throw new DeviceCredentialStoreError('productId must be a non-empty single-line string');
  }
  return `com.byok.client.device.${createHash('sha256').update(productId, 'utf8').digest('hex')}`;
}

function quoteInteractive(value: string): string {
  if (/[\u0000\r\n]/u.test(value)) throw new DeviceCredentialStoreError('credential command argument is invalid');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export interface DeviceCredentialStoreOptions {
  readonly productId: string;
  readonly platform?: NodeJS.Platform;
  readonly commandRunner?: DeviceCommandRunner;
}

/**
 * Internal OS-backed authority for the bearer token and device private key.
 * The constructor deliberately accepts no path or backend selector: real
 * callers get the platform provider; tests import this internal module and
 * inject a double directly.
 */
export class DeviceCredentialStore {
  readonly #service: string;
  readonly #platform: NodeJS.Platform;
  readonly #run: DeviceCommandRunner;

  constructor(options: DeviceCredentialStoreOptions) {
    this.#service = serviceFor(options.productId);
    this.#platform = options.platform ?? process.platform;
    this.#run = options.commandRunner ?? runDeviceCommand;
  }

  async read(): Promise<DeviceRecord | undefined> {
    const result = await this.#invoke('read');
    if (
      result.exitCode === NOT_FOUND ||
      (this.#platform === 'linux' && result.exitCode === 1 && result.stderr.trim().length === 0)
    ) return undefined;
    if (result.exitCode === 127) throw new DeviceCredentialStoreUnavailableError();
    if (result.exitCode !== 0) {
      throw new DeviceCredentialStoreError(
        `operating-system credential provider could not read device credentials${providerDiagnostic(result.stderr)}`,
      );
    }
    return decode(result.stdout.trimEnd());
  }

  async replace(record: DeviceRecord): Promise<void> {
    const encoded = encode(record);
    const result = await this.#invoke('replace', encoded);
    if (result.exitCode === 127) throw new DeviceCredentialStoreUnavailableError();
    if (result.exitCode !== 0) {
      throw new DeviceCredentialStoreError(
        `operating-system credential provider could not replace device credentials${providerDiagnostic(result.stderr)}`,
      );
    }
  }

  /** Returns true only after the sole secret authority is confirmed absent. */
  async clear(): Promise<boolean> {
    const before = await this.read();
    if (before === undefined) return false;
    const result = await this.#invoke('clear');
    if (result.exitCode === 127) throw new DeviceCredentialStoreUnavailableError();
    if (result.exitCode !== 0 && result.exitCode !== NOT_FOUND) {
      throw new DeviceCredentialStoreError(
        `operating-system credential provider could not clear device credentials${providerDiagnostic(result.stderr)}`,
      );
    }
    if ((await this.read()) !== undefined) {
      throw new DeviceCredentialStoreError('operating-system credential provider reported deletion but device credentials remain');
    }
    return true;
  }

  async #invoke(operation: 'read' | 'replace' | 'clear', encoded?: string): Promise<DeviceCommandResult> {
    switch (this.#platform) {
      case 'darwin':
        return this.#macos(operation, encoded);
      case 'win32':
        return this.#windows(operation, encoded);
      case 'linux':
        return this.#linux(operation, encoded);
      default:
        throw new DeviceCredentialStoreUnavailableError(`no operating-system credential provider is supported on ${this.#platform}`);
    }
  }

  #macos(operation: 'read' | 'replace' | 'clear', encoded?: string): Promise<DeviceCommandResult> {
    if (operation === 'read') return this.#run('/usr/bin/security', ['find-generic-password', '-a', ENTRY_ACCOUNT, '-s', this.#service, '-w']);
    if (operation === 'clear') return this.#run('/usr/bin/security', ['delete-generic-password', '-a', ENTRY_ACCOUNT, '-s', this.#service]);
    const command = [
      'add-generic-password', '-U', '-a', quoteInteractive(ENTRY_ACCOUNT), '-s', quoteInteractive(this.#service), '-w', quoteInteractive(encoded!),
    ].join(' ');
    return this.#run('/usr/bin/security', ['-i'], `${command}\n`);
  }

  #linux(operation: 'read' | 'replace' | 'clear', encoded?: string): Promise<DeviceCommandResult> {
    const attrs = ['service', this.#service, 'account', ENTRY_ACCOUNT];
    if (operation === 'read') return this.#run('secret-tool', ['lookup', ...attrs]);
    if (operation === 'clear') return this.#run('secret-tool', ['clear', ...attrs]);
    return this.#run('secret-tool', ['store', '--label=BYOK device enrollment', ...attrs], encoded);
  }

  async #windows(operation: 'read' | 'replace' | 'clear', encoded?: string): Promise<DeviceCommandResult> {
    await scavengeStaleWindowsBridges();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), WINDOWS_BRIDGE_DIRECTORY_PREFIX));
    const executable = path.join(directory, 'credential-bridge.exe');
    const request = [
      operation,
      Buffer.from(this.#service, 'utf8').toString('base64'),
      Buffer.from(ENTRY_ACCOUNT, 'utf8').toString('base64'),
      encoded === undefined ? '' : Buffer.from(encoded, 'utf8').toString('base64'),
    ].join('\n');
    let result: DeviceCommandResult | undefined;
    let cleanupFailed = false;

    try {
      const compiler = await this.#run(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_CREDENTIAL_COMPILER_SCRIPT],
        executable,
      );
      result = compiler.exitCode === 0
        ? await this.#run(executable, [], request)
        : { exitCode: compiler.exitCode, stdout: '', stderr: compiler.stderr };
    } finally {
      try {
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        cleanupFailed = true;
      }
    }

    if (cleanupFailed) {
      throw new DeviceCredentialStoreError('temporary Windows credential bridge cleanup failed');
    }
    if (result === undefined) {
      throw new DeviceCredentialStoreError('Windows credential bridge did not produce a result');
    }
    return result;
  }
}

/** Test-only double; it is intentionally internal and never selected by a production config. */
export class InMemoryDeviceCredentialStore {
  #record: DeviceRecord | undefined;

  async read(): Promise<DeviceRecord | undefined> {
    return this.#record === undefined ? undefined : Object.freeze({ ...this.#record });
  }

  async replace(record: DeviceRecord): Promise<void> {
    assertRecord(record);
    this.#record = Object.freeze({ ...record });
  }

  async clear(): Promise<boolean> {
    const had = this.#record !== undefined;
    this.#record = undefined;
    return had;
  }
}

export async function runDeviceCommand(executable: string, args: readonly string[], stdin?: string): Promise<DeviceCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', () => resolve({ exitCode: 127, stdout: '', stderr: 'command unavailable' }));
    child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

// PowerShell only compiles this static, non-secret console executable. The
// executable itself owns Credential Manager result bytes and process exit.
const WINDOWS_CREDENTIAL_COMPILER_SCRIPT = Buffer.from(String.raw`
$assembly=[Console]::In.ReadToEnd()
try {
Add-Type -OutputAssembly $assembly -OutputType ConsoleApplication -ErrorAction Stop -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes; using System.Text;
public static class ByokDeviceCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct C { public UInt32 Flags; public UInt32 Type; [MarshalAs(UnmanagedType.LPWStr)] public string TargetName; [MarshalAs(UnmanagedType.LPWStr)] public string Comment; public FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias; [MarshalAs(UnmanagedType.LPWStr)] public string UserName; }
 [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool W(ref C c, UInt32 f);
 [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool R(string t, UInt32 ty, UInt32 f, out IntPtr p);
 [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool D(string t, UInt32 ty, UInt32 f);
 [DllImport("Advapi32.dll")] private static extern void CredFree(IntPtr p);
 private static int Set(string t,string u,byte[] b) { IntPtr p=IntPtr.Zero; try { p=Marshal.AllocHGlobal(b.Length); Marshal.Copy(b,0,p,b.Length); C c=new C { Type=1,TargetName=t,CredentialBlobSize=(UInt32)b.Length,CredentialBlob=p,Persist=2,UserName=u}; if(!W(ref c,0)) return Marshal.GetLastWin32Error(); return 0; } finally { if(p!=IntPtr.Zero) { Marshal.Copy(new byte[b.Length],0,p,b.Length); Marshal.FreeHGlobal(p); } } }
 private static int Kind(Exception e) { if(e is DllNotFoundException)return 1;if(e is EntryPointNotFoundException)return 2;if(e is BadImageFormatException)return 3;if(e is MarshalDirectiveException)return 4;if(e is SEHException)return 5;if(e is AccessViolationException)return 6;if(e is TypeInitializationException)return 7;if(e is TypeLoadException)return 8;if(e is InvalidCastException)return 9;if(e is ArgumentException)return 10;if(e is InvalidOperationException)return 11;if(e.GetType()==typeof(SystemException))return 12;if(e is SystemException)return 13;return 99; }
 private static int Failure(int stage,Exception e) { Console.Error.Write("credential operation failed (stage="+stage+",kind="+Kind(e)+",hresult="+e.HResult+")"); return -1; }
 private static int Get(string t) { IntPtr p=IntPtr.Zero; bool found; try { found=R(t,1,0,out p); } catch(Exception e) { return Failure(1,e); } if(!found) return Marshal.GetLastWin32Error(); int code=0; try { C c=(C)Marshal.PtrToStructure(p,typeof(C)); byte[] b=new byte[c.CredentialBlobSize]; if(b.Length>0) { Marshal.Copy(c.CredentialBlob,b,0,b.Length); using(var output=Console.OpenStandardOutput()) { output.Write(b,0,b.Length); output.Flush(); } } } catch(Exception e) { code=Failure(2,e); } try { CredFree(p); } catch(Exception e) { return Failure(3,e); } return code; }
 private static int Delete(string t) { if(D(t,1,0)) return 0; return Marshal.GetLastWin32Error(); }
 private static int ExitFor(int code,bool missingIsAbsent) { if(code==0)return 0;if(missingIsAbsent&&code==1168)return 44;if(code<0)return 1;Console.Error.Write("credential operation failed (win32="+code+")");return 1; }
 private static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
 public static int Main() { int stage=1;byte[] secret=null;try { string[] fields=Console.In.ReadToEnd().Split(new[]{'\n'},StringSplitOptions.None);if(fields.Length!=4)return 2;string operation=fields[0];string target=Decode(fields[1]);string username=Decode(fields[2]);if(target.Length==0||username.Length==0)return 2;if(operation=="replace") { stage=2;secret=Convert.FromBase64String(fields[3]);stage=3;return ExitFor(Set(target,username,secret),false); } if(operation=="read") { stage=4;return ExitFor(Get(target),true); } if(operation=="clear") { stage=6;return ExitFor(Delete(target),true); } return 2; } catch(Exception e) { Failure(stage,e);return 1; } finally { if(secret!=null)Array.Clear(secret,0,secret.Length); } }
}
"@
if(Test-Path -LiteralPath $assembly -PathType Leaf){exit 0}
} catch {}
exit 1
`, 'utf16le').toString('base64');

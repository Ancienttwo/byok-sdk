import { createDaemonScratch } from './retention/scratch';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
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

/**
 * The one durable authority allowed before a first pairing response is
 * received. It keeps the generated key immutable across a lost response, so
 * an exact server-side retry can prove the same public-key binding.
 */
export interface FirstPairingAttempt {
  readonly kind: 'first-pairing-attempt-v1';
  readonly deviceName: string;
  readonly devicePublicKey: string;
  readonly devicePrivateKeyPem: string;
  readonly machineId?: string;
}

type DeviceCredentialAuthority = DeviceRecord | FirstPairingAttempt;

export interface DeviceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one provider command. On `signal` abort the runner kills the child and
 * rejects at once, without waiting for its pipes to close.
 */
export type DeviceCommandRunner = (
  executable: string,
  args: readonly string[],
  stdin?: string,
  signal?: AbortSignal,
) => Promise<DeviceCommandResult>;

const ENTRY_ACCOUNT = 'device-enrollment';
const ENCODED_PREFIX = 'byok-device-credential-v1:';
/** The Windows generic-credential blob bound, kept on every OS entry of this product. */
export const OS_CREDENTIAL_ENTRY_MAX_BYTES = 2_400;
const NOT_FOUND = 44;
/**
 * Deadline for one provider command. A locked keychain, a provider dialog
 * that a LaunchAgent cannot show, or a waiting gnome-keyring otherwise hangs
 * the command, and with it every auth caller and daemon shutdown (#1117).
 */
const OS_CREDENTIAL_COMMAND_DEADLINE_MS = 15_000;
/**
 * The Windows bridge compile (PowerShell 5.1 `Add-Type`) is the one slow
 * command: the native probe measured median 3.6 s, max 9 s, and two runs
 * past 20 s on a cold job (device-credential-store.native.test.ts).
 */
const WINDOWS_CREDENTIAL_COMPILE_DEADLINE_MS = 60_000;

function providerDiagnostic(stderr: string): string {
  const match = /credential operation failed \((win32=\d{1,10}|hresult=-?\d{1,11}|stage=\d{1,2},kind=\d{1,2},hresult=-?\d{1,11})\)/u.exec(stderr);
  return match === null ? '' : ` (${match[1]})`;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    throw new DeviceCredentialStoreError('Windows system root is unavailable');
  }
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
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

/** macOS refused an operation that requires unavailable user interaction. */
export class DeviceCredentialInteractionRequiredError extends DeviceCredentialStoreError {
  constructor() {
    super('macOS keychain requires user interaction; configure an explicitly unlocked keychain for non-interactive credential custody');
    this.name = 'DeviceCredentialInteractionRequiredError';
  }
}

/**
 * A provider command ended before it answered: it exceeded its deadline, or
 * the caller cancelled it (daemon shutdown). The child process was killed.
 * Nothing was learned about the entry, so the caller keeps its prior state.
 */
export class DeviceCredentialCommandAbortedError extends DeviceCredentialStoreError {
  constructor(readonly reason: 'deadline' | 'cancelled') {
    super(
      reason === 'deadline'
        ? 'operating-system credential provider did not answer before its deadline; the keychain may be locked or waiting for a prompt: unlock it, then retry'
        : 'operating-system credential command was cancelled',
    );
    this.name = 'DeviceCredentialCommandAbortedError';
  }
}

/**
 * Complete enrollment custody. An injected implementation owns secret storage
 * and its lifetime. `signal` cancels the operation (daemon shutdown); an
 * implementation must stop and reject once it aborts.
 */
export interface DeviceCredentialBackend {
  read(signal?: AbortSignal): Promise<DeviceRecord | undefined>;
  readFirstPairingAttempt(signal?: AbortSignal): Promise<FirstPairingAttempt | undefined>;
  saveFirstPairingAttempt(attempt: FirstPairingAttempt, signal?: AbortSignal): Promise<void>;
  replace(record: DeviceRecord, signal?: AbortSignal): Promise<void>;
  clear(signal?: AbortSignal): Promise<boolean>;
}

export interface DeviceCredentialConfig {
  /** Explicit macOS keychain file; omitted uses the operating system's default keychain. */
  readonly macosKeychainPath?: string;
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

function isFirstPairingAttempt(value: DeviceCredentialAuthority): value is FirstPairingAttempt {
  return 'kind' in value && value.kind === 'first-pairing-attempt-v1';
}

function assertFirstPairingAttempt(value: unknown): asserts value is FirstPairingAttempt {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Partial<FirstPairingAttempt>).kind !== 'first-pairing-attempt-v1' ||
    typeof (value as Partial<FirstPairingAttempt>).deviceName !== 'string' ||
    typeof (value as Partial<FirstPairingAttempt>).devicePublicKey !== 'string' ||
    typeof (value as Partial<FirstPairingAttempt>).devicePrivateKeyPem !== 'string' ||
    ((value as Partial<FirstPairingAttempt>).machineId !== undefined &&
      typeof (value as Partial<FirstPairingAttempt>).machineId !== 'string') ||
    (value as FirstPairingAttempt).deviceName.length === 0 ||
    (value as FirstPairingAttempt).devicePublicKey.length === 0 ||
    (value as FirstPairingAttempt).devicePrivateKeyPem.length === 0
  ) {
    throw new DeviceCredentialStoreError('OS credential entry has an invalid first-pairing attempt shape');
  }
}

function encode(authority: DeviceCredentialAuthority): string {
  if (isFirstPairingAttempt(authority)) assertFirstPairingAttempt(authority);
  else assertRecord(authority);
  const encoded = Buffer.from(JSON.stringify(authority), 'utf8').toString('base64');
  const value = `${ENCODED_PREFIX}${encoded}`;
  // Windows generic-credential blobs are limited; do not silently truncate a
  // bearer/key authority into a different credential.
  if (Buffer.byteLength(value, 'utf8') > OS_CREDENTIAL_ENTRY_MAX_BYTES) {
    throw new DeviceCredentialStoreError('device credential exceeds the OS credential entry bound');
  }
  return value;
}

function decode(value: string): DeviceCredentialAuthority {
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
  if (typeof parsed === 'object' && parsed !== null && (parsed as Partial<FirstPairingAttempt>).kind === 'first-pairing-attempt-v1') {
    assertFirstPairingAttempt(parsed);
    return Object.freeze({
      kind: parsed.kind,
      deviceName: parsed.deviceName,
      devicePublicKey: parsed.devicePublicKey,
      devicePrivateKeyPem: parsed.devicePrivateKeyPem,
      ...(parsed.machineId === undefined ? {} : { machineId: parsed.machineId }),
    });
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

export interface OsCredentialEntryOptions extends DeviceCredentialConfig {
  readonly storeDir: string;
  readonly productId: string;
  readonly platform?: NodeJS.Platform;
  readonly commandRunner?: DeviceCommandRunner;
  /** Internal test seam for the per-command deadline; production uses the fixed bound. */
  readonly commandDeadlineMs?: number;
}

/**
 * One named entry of this product's OS credential provider: the macOS
 * keychain, the Windows Credential Manager or the Linux Secret Service. It
 * moves raw strings; each owner encodes and checks its own value. An explicit
 * macOS keychain selects custody within that provider, without a file
 * fallback.
 */
export class OsCredentialEntry {
  readonly #storeDir: string;
  readonly #service: string;
  readonly #account: string;
  readonly #windowsTarget: string;
  readonly #label: string;
  /** What the entry holds, for error messages. */
  readonly #subject: string;
  readonly #platform: NodeJS.Platform;
  readonly #run: DeviceCommandRunner;
  readonly #commandDeadlineMs: number;
  readonly #macosKeychainPath: string | undefined;

  constructor(options: OsCredentialEntryOptions & { readonly account: string; readonly label: string; readonly subject: string }) {
    this.#storeDir = options.storeDir;
    this.#service = serviceFor(options.productId);
    this.#account = options.account;
    // Windows keys a generic credential by its target name alone. The
    // enrollment keeps the service as its target; every other entry gets
    // its own target, or it would replace and delete the enrollment.
    this.#windowsTarget = options.account === ENTRY_ACCOUNT ? this.#service : `${this.#service}/${options.account}`;
    this.#label = options.label;
    this.#subject = options.subject;
    this.#platform = options.platform ?? process.platform;
    const keychainPath = options.macosKeychainPath;
    if (keychainPath !== undefined && (
      this.#platform !== 'darwin' || typeof keychainPath !== 'string' ||
      !path.posix.isAbsolute(keychainPath) || /[\u0000\r\n]/u.test(keychainPath)
    )) {
      throw new DeviceCredentialStoreError('macosKeychainPath must be an absolute single-line macOS keychain path on darwin');
    }
    this.#macosKeychainPath = keychainPath;
    this.#run = options.commandRunner ?? runDeviceCommand;
    this.#commandDeadlineMs = options.commandDeadlineMs ?? OS_CREDENTIAL_COMMAND_DEADLINE_MS;
  }

  /** The stored value, or `undefined` when the entry is absent. */
  async read(signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.#invoke('read', undefined, signal);
    this.#checkInteraction(result);
    if (this.#absent(result)) return undefined;
    if (result.exitCode === 127) throw new DeviceCredentialStoreUnavailableError();
    if (result.exitCode !== 0) {
      throw new DeviceCredentialStoreError(
        `operating-system credential provider could not read ${this.#subject}${providerDiagnostic(result.stderr)}`,
      );
    }
    return result.stdout.trimEnd();
  }

  async replace(value: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#invoke('replace', value, signal);
    this.#checkInteraction(result);
    if (result.exitCode === 127) throw new DeviceCredentialStoreUnavailableError();
    if (result.exitCode !== 0) {
      throw new DeviceCredentialStoreError(
        `operating-system credential provider could not replace ${this.#subject}${providerDiagnostic(result.stderr)}`,
      );
    }
  }

  /** Delete the entry. An absent entry is already deleted. */
  async delete(signal?: AbortSignal): Promise<void> {
    const result = await this.#invoke('clear', undefined, signal);
    this.#checkInteraction(result);
    if (result.exitCode === 127) throw new DeviceCredentialStoreUnavailableError();
    if (result.exitCode !== 0 && !this.#absent(result)) {
      throw new DeviceCredentialStoreError(
        `operating-system credential provider could not clear ${this.#subject}${providerDiagnostic(result.stderr)}`,
      );
    }
  }

  async #invoke(operation: 'read' | 'replace' | 'clear', encoded: string | undefined, signal: AbortSignal | undefined): Promise<DeviceCommandResult> {
    switch (this.#platform) {
      case 'darwin':
        return this.#macos(operation, encoded, signal);
      case 'win32':
        return this.#windows(operation, encoded, signal);
      case 'linux':
        return this.#linux(operation, encoded, signal);
      default:
        throw new DeviceCredentialStoreUnavailableError(`no operating-system credential provider is supported on ${this.#platform}`);
    }
  }

  /** `secret-tool` exits 1 with no message when nothing matched, on lookup and on clear. */
  #absent(result: DeviceCommandResult): boolean {
    return result.exitCode === NOT_FOUND || (this.#platform === 'linux' && result.exitCode === 1 && result.stderr.trim().length === 0);
  }

  /** Every provider command runs here, under its deadline and the caller's cancellation. */
  async #command(
    executable: string,
    args: readonly string[],
    stdin: string | undefined,
    signal: AbortSignal | undefined,
    deadlineMs = this.#commandDeadlineMs,
  ): Promise<DeviceCommandResult> {
    const deadline = AbortSignal.timeout(deadlineMs);
    const bounded = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
    if (bounded.aborted) throw new DeviceCredentialCommandAbortedError(deadline.aborted ? 'deadline' : 'cancelled');
    try {
      return await this.#run(executable, args, stdin, bounded);
    } catch (error) {
      if (bounded.aborted) throw new DeviceCredentialCommandAbortedError(deadline.aborted ? 'deadline' : 'cancelled');
      throw error;
    }
  }

  #checkInteraction(result: DeviceCommandResult): void {
    if (this.#platform === 'darwin' && result.exitCode === 36) {
      throw new DeviceCredentialInteractionRequiredError();
    }
  }

  #macos(operation: 'read' | 'replace' | 'clear', encoded: string | undefined, signal: AbortSignal | undefined): Promise<DeviceCommandResult> {
    const keychain = this.#macosKeychainPath === undefined ? [] : [this.#macosKeychainPath];
    if (operation === 'read') return this.#command('/usr/bin/security', ['find-generic-password', '-a', this.#account, '-s', this.#service, '-w', ...keychain], undefined, signal);
    if (operation === 'clear') return this.#command('/usr/bin/security', ['delete-generic-password', '-a', this.#account, '-s', this.#service, ...keychain], undefined, signal);
    const command = [
      'add-generic-password', '-U', '-a', quoteInteractive(this.#account), '-s', quoteInteractive(this.#service), '-w', quoteInteractive(encoded!),
      ...keychain.map(quoteInteractive),
    ].join(' ');
    return this.#command('/usr/bin/security', ['-i'], `${command}\n`, signal);
  }

  #linux(operation: 'read' | 'replace' | 'clear', encoded: string | undefined, signal: AbortSignal | undefined): Promise<DeviceCommandResult> {
    const attrs = ['service', this.#service, 'account', this.#account];
    if (operation === 'read') return this.#command('secret-tool', ['lookup', ...attrs], undefined, signal);
    if (operation === 'clear') return this.#command('secret-tool', ['clear', ...attrs], undefined, signal);
    return this.#command('secret-tool', ['store', `--label=${this.#label}`, ...attrs], encoded, signal);
  }

  async #windows(operation: 'read' | 'replace' | 'clear', encoded: string | undefined, signal: AbortSignal | undefined): Promise<DeviceCommandResult> {
    const directory = await createDaemonScratch(this.#storeDir, 'credential');
    const executable = path.join(directory, 'credential-bridge.exe');
    const request = [
      operation,
      Buffer.from(this.#windowsTarget, 'utf8').toString('base64'),
      Buffer.from(this.#account, 'utf8').toString('base64'),
      encoded === undefined ? '' : Buffer.from(encoded, 'utf8').toString('base64'),
    ].join('\n');
    let result: DeviceCommandResult | undefined;
    let cleanupFailed = false;

    try {
      const compiler = await this.#command(
        windowsPowerShellExecutable(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_CREDENTIAL_COMPILER_SCRIPT],
        executable,
        signal,
        WINDOWS_CREDENTIAL_COMPILE_DEADLINE_MS,
      );
      result = compiler.exitCode === 0
        ? await this.#command(executable, [], request, signal)
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

/**
 * Internal OS-backed authority for the bearer token and device private key,
 * in the entry `device-enrollment`.
 */
export class DeviceCredentialStore implements DeviceCredentialBackend {
  readonly #entry: OsCredentialEntry;

  constructor(options: OsCredentialEntryOptions) {
    this.#entry = new OsCredentialEntry({
      ...options, account: ENTRY_ACCOUNT, label: 'BYOK device enrollment', subject: 'device credentials',
    });
  }

  async read(signal?: AbortSignal): Promise<DeviceRecord | undefined> {
    const authority = await this.#readAuthority(signal);
    return authority === undefined || isFirstPairingAttempt(authority) ? undefined : authority;
  }

  async readFirstPairingAttempt(signal?: AbortSignal): Promise<FirstPairingAttempt | undefined> {
    const authority = await this.#readAuthority(signal);
    return authority !== undefined && isFirstPairingAttempt(authority) ? authority : undefined;
  }

  async saveFirstPairingAttempt(attempt: FirstPairingAttempt, signal?: AbortSignal): Promise<void> {
    assertFirstPairingAttempt(attempt);
    await this.#entry.replace(encode(attempt), signal);
  }

  async #readAuthority(signal: AbortSignal | undefined): Promise<DeviceCredentialAuthority | undefined> {
    const raw = await this.#entry.read(signal);
    return raw === undefined ? undefined : decode(raw);
  }

  async replace(record: DeviceRecord, signal?: AbortSignal): Promise<void> {
    await this.#entry.replace(encode(record), signal);
  }

  /** Returns true only after the sole secret authority is confirmed absent. */
  async clear(signal?: AbortSignal): Promise<boolean> {
    const before = await this.#readAuthority(signal);
    if (before === undefined) return false;
    await this.#entry.delete(signal);
    if ((await this.#readAuthority(signal)) !== undefined) {
      throw new DeviceCredentialStoreError('operating-system credential provider reported deletion but device credentials remain');
    }
    return true;
  }
}

export async function runDeviceCommand(
  executable: string,
  args: readonly string[],
  stdin?: string,
  signal?: AbortSignal,
): Promise<DeviceCommandResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      finish();
    };
    // Reject on abort itself, not on 'close': a grandchild that inherited the
    // pipes can hold them open after the child is killed.
    const onAbort = (): void => {
      child.kill('SIGKILL');
      settle(() => reject(signal!.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    // A killed child can no longer read stdin; its EPIPE is not a result.
    child.stdin.on('error', () => {});
    child.once('error', () => settle(() => resolve({ exitCode: 127, stdout: '', stderr: 'command unavailable' })));
    child.once('close', (code) => settle(() => resolve({ exitCode: code ?? 1, stdout, stderr })));
    child.stdin.end(stdin);
  });
}

// PowerShell only compiles this static, non-secret console executable. The
// executable itself owns Credential Manager result bytes and process exit. The
// output path arrives on stdin and is decoded as UTF-8 explicitly, independent
// of the console code page, so a non-ASCII temp directory reaches Add-Type
// unchanged.
const WINDOWS_CREDENTIAL_COMPILER_SCRIPT = Buffer.from(String.raw`
$assembly=[System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false, $true)).ReadToEnd()
try {
Add-Type -OutputAssembly $assembly -OutputType ConsoleApplication -ErrorAction Stop -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class ByokDeviceCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct C { public UInt32 Flags; public UInt32 Type; [MarshalAs(UnmanagedType.LPWStr)] public string TargetName; [MarshalAs(UnmanagedType.LPWStr)] public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias; [MarshalAs(UnmanagedType.LPWStr)] public string UserName; }
 [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool W(ref C c, UInt32 f);
 [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool R(string t, UInt32 ty, UInt32 f, out IntPtr p);
 [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool D(string t, UInt32 ty, UInt32 f);
 [DllImport("Advapi32.dll")] private static extern void CredFree(IntPtr p);
 private static int Set(string t,string u,byte[] b) { IntPtr p=IntPtr.Zero; try { p=Marshal.AllocHGlobal(b.Length); Marshal.Copy(b,0,p,b.Length); C c=new C { Type=1,TargetName=t,CredentialBlobSize=(UInt32)b.Length,CredentialBlob=p,Persist=2,UserName=u}; if(!W(ref c,0)) return Marshal.GetLastWin32Error(); return 0; } finally { if(p!=IntPtr.Zero) { Marshal.Copy(new byte[b.Length],0,p,b.Length); Marshal.FreeHGlobal(p); } } }
 private static int Kind(Exception e) { if(e is DllNotFoundException)return 1;if(e is EntryPointNotFoundException)return 2;if(e is BadImageFormatException)return 3;if(e is MarshalDirectiveException)return 4;if(e is SEHException)return 5;if(e is AccessViolationException)return 6;if(e is TypeInitializationException)return 7;if(e is TypeLoadException)return 8;if(e is InvalidCastException)return 9;if(e is ArgumentException)return 10;if(e is InvalidOperationException)return 11;if(e.GetType()==typeof(SystemException))return 12;if(e is SystemException)return 13;return 99; }
 private static int Failure(int stage,Exception e) { Console.Error.Write("credential operation failed (stage="+stage+",kind="+Kind(e)+",hresult="+e.HResult+")"); return -1; }
 private static int InputFailure(int kind) { Console.Error.Write("credential operation failed (stage=0,kind="+kind+",hresult=0)"); return 2; }
 private static int Get(string t) { IntPtr p=IntPtr.Zero; bool found; try { found=R(t,1,0,out p); } catch(Exception e) { return Failure(1,e); } if(!found) return Marshal.GetLastWin32Error(); int code=0; try { C c=(C)Marshal.PtrToStructure(p,typeof(C)); byte[] b=new byte[c.CredentialBlobSize]; if(b.Length>0) { Marshal.Copy(c.CredentialBlob,b,0,b.Length); using(var output=Console.OpenStandardOutput()) { output.Write(b,0,b.Length); output.Flush(); } } } catch(Exception e) { code=Failure(2,e); } try { CredFree(p); } catch(Exception e) { return Failure(3,e); } return code; }
 private static int Delete(string t) { if(D(t,1,0)) return 0; return Marshal.GetLastWin32Error(); }
 private static int ExitFor(int code,bool missingIsAbsent) { if(code==0)return 0;if(missingIsAbsent&&code==1168)return 44;if(code<0)return 1;Console.Error.Write("credential operation failed (win32="+code+")");return 1; }
 private static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
 public static int Main() { int stage=1;byte[] secret=null;try { string[] fields=Console.In.ReadToEnd().Split(new[]{'\n'},StringSplitOptions.None);if(fields.Length!=4)return InputFailure(fields.Length<100?fields.Length:99);string operation=fields[0];string target=Decode(fields[1]);string username=Decode(fields[2]);if(target.Length==0||username.Length==0)return InputFailure(20);if(operation=="replace") { stage=2;secret=Convert.FromBase64String(fields[3]);stage=3;return ExitFor(Set(target,username,secret),false); } if(operation=="read") { stage=4;return ExitFor(Get(target),true); } if(operation=="clear") { stage=6;return ExitFor(Delete(target),true); } return InputFailure(21); } catch(Exception e) { Failure(stage,e);return 1; } finally { if(secret!=null)Array.Clear(secret,0,secret.Length); } }
}
"@
if(Test-Path -LiteralPath $assembly -PathType Leaf){exit 0}
[Console]::Error.Write("credential operation failed (stage=8,kind=2,hresult=0)")
} catch {
$compilerCode=99
$errorNumber=[string]$_.TargetObject.ErrorNumber
if($errorNumber -match '\ACS([0-9]{4})\z'){$compilerCode=[Convert]::ToInt32($Matches[1])}
[Console]::Error.Write("credential operation failed (stage=8,kind=3,hresult="+$compilerCode+")")
}
exit 1
`, 'utf16le').toString('base64');

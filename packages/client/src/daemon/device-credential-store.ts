import { systemExecutable } from '../util/system-tool';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { isTenantId } from '@byok-sdk/core';
import {
  deleteWin32Credential,
  enqueueWin32CredentialCall,
  loadWin32CredentialBindings,
  readWin32Credential,
  writeWin32Credential,
  type Win32CredentialBindings,
} from './win32-credential-api';

/** Secret fields inside the internal complete enrollment authority. */
export interface DeviceCredentials {
  readonly accessToken: string;
  /**
   * Device-local expiry of `accessToken` (#1114): this device's receipt time
   * plus the server's relative `expiresIn`. It is compared only with this
   * device's clock, never with a server timestamp.
   */
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

interface ReplacementPairingAttempt {
  readonly kind: 'replacement-pairing-attempt-v1';
  readonly record: DeviceRecord;
  readonly attempt: FirstPairingAttempt;
}

type DeviceCredentialAuthority = DeviceRecord | FirstPairingAttempt | ReplacementPairingAttempt;

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
const WIN32_ERROR_NOT_FOUND = 1168;
/**
 * Deadline for one provider command. A locked keychain, a provider dialog
 * that a LaunchAgent cannot show, or a waiting gnome-keyring otherwise hangs
 * the command, and with it every auth caller and daemon shutdown (#1117).
 */
const OS_CREDENTIAL_COMMAND_DEADLINE_MS = 15_000;

function providerDiagnostic(stderr: string): string {
  const match = /credential operation failed \((win32=\d{1,10})\)/u.exec(stderr);
  return match === null ? '' : ` (${match[1]})`;
}

function windowsResult(code: number, stdout: string, missingIsAbsent: boolean): DeviceCommandResult {
  if (code === 0) return { exitCode: 0, stdout, stderr: '' };
  if (missingIsAbsent && code === WIN32_ERROR_NOT_FOUND) return { exitCode: NOT_FOUND, stdout: '', stderr: '' };
  return { exitCode: 1, stdout: '', stderr: `credential operation failed (win32=${code})` };
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
 * the caller cancelled it (daemon shutdown). A child process was killed; a
 * Windows native call runs on to its own return. Either way the outcome is
 * unknown, so the caller keeps its prior state and does not replay the write.
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
 * Staging an attempt preserves the current enrollment returned by `read()`.
 * `replace()` retains that attempt when renewing the same deviceId, tenantId
 * and devicePublicKey; a different authenticated enrollment promotes the
 * replacement and discards the attempt. `clear()` removes both authorities.
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
    'kind' in value ||
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

function isReplacementPairingAttempt(value: DeviceCredentialAuthority): value is ReplacementPairingAttempt {
  return 'kind' in value && value.kind === 'replacement-pairing-attempt-v1';
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

function assertReplacementPairingAttempt(value: unknown): asserts value is ReplacementPairingAttempt {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    (value as Partial<ReplacementPairingAttempt>).kind !== 'replacement-pairing-attempt-v1'
  ) {
    throw new DeviceCredentialStoreError('OS credential entry has an invalid replacement-pairing attempt shape');
  }
  assertRecord((value as Partial<ReplacementPairingAttempt>).record);
  assertFirstPairingAttempt((value as Partial<ReplacementPairingAttempt>).attempt);
}

function freezeRecord(record: DeviceRecord): DeviceRecord {
  return Object.freeze({
    deviceId: record.deviceId,
    tenantId: record.tenantId,
    devicePublicKey: record.devicePublicKey,
    accessToken: record.accessToken,
    expiresAt: record.expiresAt,
    devicePrivateKeyPem: record.devicePrivateKeyPem,
  });
}

function freezeAttempt(attempt: FirstPairingAttempt): FirstPairingAttempt {
  return Object.freeze({
    kind: attempt.kind,
    deviceName: attempt.deviceName,
    devicePublicKey: attempt.devicePublicKey,
    devicePrivateKeyPem: attempt.devicePrivateKeyPem,
    ...(attempt.machineId === undefined ? {} : { machineId: attempt.machineId }),
  });
}

function encode(authority: DeviceCredentialAuthority): string {
  if (isReplacementPairingAttempt(authority)) assertReplacementPairingAttempt(authority);
  else if (isFirstPairingAttempt(authority)) assertFirstPairingAttempt(authority);
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
    return freezeAttempt(parsed);
  }
  if (typeof parsed === 'object' && parsed !== null && (parsed as Partial<ReplacementPairingAttempt>).kind === 'replacement-pairing-attempt-v1') {
    assertReplacementPairingAttempt(parsed);
    return Object.freeze({ kind: parsed.kind, record: freezeRecord(parsed.record), attempt: freezeAttempt(parsed.attempt) });
  }
  assertRecord(parsed);
  return freezeRecord(parsed);
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
  /** Absolute SDK native asset directory of a packaged Windows Host (`DaemonConfig.nativeAssetRoot`). */
  readonly nativeAssetRoot?: string;
  /** Internal test seam; production binds advapi32 through koffi on first use. */
  readonly windowsCredentialBindings?: Win32CredentialBindings;
}

/**
 * One named entry of this product's OS credential provider: the macOS
 * keychain, the Windows Credential Manager or the Linux Secret Service. It
 * moves raw strings; each owner encodes and checks its own value. An explicit
 * macOS keychain selects custody within that provider, without a file
 * fallback.
 */
export class OsCredentialEntry {
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
  readonly #nativeAssetRoot: string | undefined;
  readonly #windowsBindings: Win32CredentialBindings | undefined;

  constructor(options: OsCredentialEntryOptions & { readonly account: string; readonly label: string; readonly subject: string }) {
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
    this.#nativeAssetRoot = options.nativeAssetRoot;
    this.#windowsBindings = options.windowsCredentialBindings;
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

  /** Every provider operation runs here, under its deadline and the caller's cancellation. */
  async #bounded(signal: AbortSignal | undefined, operation: (bounded: AbortSignal) => Promise<DeviceCommandResult>): Promise<DeviceCommandResult> {
    const deadline = AbortSignal.timeout(this.#commandDeadlineMs);
    const bounded = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
    if (bounded.aborted) throw new DeviceCredentialCommandAbortedError(deadline.aborted ? 'deadline' : 'cancelled');
    try {
      return await operation(bounded);
    } catch (error) {
      if (bounded.aborted) throw new DeviceCredentialCommandAbortedError(deadline.aborted ? 'deadline' : 'cancelled');
      throw error;
    }
  }

  #command(executable: string, args: readonly string[], stdin: string | undefined, signal: AbortSignal | undefined): Promise<DeviceCommandResult> {
    return this.#bounded(signal, (bounded) => this.#run(executable, args, stdin, bounded));
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

  #windows(operation: 'read' | 'replace' | 'clear', encoded: string | undefined, signal: AbortSignal | undefined): Promise<DeviceCommandResult> {
    return this.#bounded(signal, (bounded) => enqueueWin32CredentialCall(async () => {
      const bindings = await this.#windowsCredentialBindings();
      if (operation === 'read') {
        const { code, value } = await readWin32Credential(bindings, this.#windowsTarget);
        return windowsResult(code, value ?? '', true);
      }
      if (operation === 'clear') return windowsResult(await deleteWin32Credential(bindings, this.#windowsTarget), '', true);
      return windowsResult(await writeWin32Credential(bindings, this.#windowsTarget, this.#account, encoded!), '', false);
    }, bounded));
  }

  async #windowsCredentialBindings(): Promise<Win32CredentialBindings> {
    if (this.#windowsBindings !== undefined) return this.#windowsBindings;
    try {
      return await loadWin32CredentialBindings(this.#nativeAssetRoot);
    } catch {
      throw new DeviceCredentialStoreUnavailableError(this.#nativeAssetRoot === undefined
        ? 'Windows Credential Manager requires the koffi optional dependency, which could not be loaded'
        : 'Windows Credential Manager requires valid SDK native assets at the configured root');
    }
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
    if (authority === undefined || isFirstPairingAttempt(authority)) return undefined;
    return isReplacementPairingAttempt(authority) ? authority.record : authority;
  }

  async readFirstPairingAttempt(signal?: AbortSignal): Promise<FirstPairingAttempt | undefined> {
    const authority = await this.#readAuthority(signal);
    if (authority === undefined) return undefined;
    if (isReplacementPairingAttempt(authority)) return authority.attempt;
    return isFirstPairingAttempt(authority) ? authority : undefined;
  }

  async saveFirstPairingAttempt(attempt: FirstPairingAttempt, signal?: AbortSignal): Promise<void> {
    assertFirstPairingAttempt(attempt);
    const authority = await this.#readAuthority(signal);
    const record = authority === undefined || isFirstPairingAttempt(authority)
      ? undefined : isReplacementPairingAttempt(authority) ? authority.record : authority;
    await this.#entry.replace(encode(record === undefined
      ? attempt : { kind: 'replacement-pairing-attempt-v1', record, attempt }), signal);
  }

  async #readAuthority(signal: AbortSignal | undefined): Promise<DeviceCredentialAuthority | undefined> {
    const raw = await this.#entry.read(signal);
    return raw === undefined ? undefined : decode(raw);
  }

  async replace(record: DeviceRecord, signal?: AbortSignal): Promise<void> {
    const encoded = encode(record);
    const authority = await this.#readAuthority(signal);
    // Token renewal belongs to the current enrollment, while a different
    // authenticated binding commits the replacement and consumes its attempt.
    const retainAttempt = authority !== undefined && isReplacementPairingAttempt(authority) &&
      authority.record.deviceId === record.deviceId && authority.record.tenantId === record.tenantId &&
      authority.record.devicePublicKey === record.devicePublicKey;
    await this.#entry.replace(retainAttempt
      ? encode({ kind: 'replacement-pairing-attempt-v1', record, attempt: authority.attempt }) : encoded, signal);
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
    // A system tool without its trusted location is as unavailable as one that cannot spawn (#1304).
    let file: string;
    try {
      file = systemExecutable(executable);
    } catch {
      resolve({ exitCode: 127, stdout: '', stderr: 'command unavailable' });
      return;
    }
    const child = spawn(file, [...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
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

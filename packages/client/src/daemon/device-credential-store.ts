import { assertNoNulSpawnInput, spawnStartError } from '@byok-sdk/core/system-tool';
import { runDeviceCommand, type DeviceCommandResult, type DeviceCommandRunner } from '../util/system-command.js';
import { createHash, createPrivateKey } from 'node:crypto';
import * as path from 'node:path';
import { isTenantId } from '@byok-sdk/core';
import { isPairingText, PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH, PAIR_RESPONSE_DEVICE_ID_MAX_LENGTH } from '@byok-sdk/protocol';
import { publicKeyOfPrivateKeyPem } from './device-keys.js';
import {
  deleteWin32Credential,
  enqueueWin32CredentialCall,
  loadWin32CredentialBindings,
  readWin32Credential,
  writeWin32Credential,
  type Win32CredentialBindings,
} from './win32-credential-api.js';

/**
 * The secret of the enrollment authority. No access token is persisted: the
 * daemon exchanges one with this key when it first needs it and after a 401,
 * and keeps it in memory (#2045).
 */
export interface DeviceCredentials {
  readonly devicePrivateKeyPem: string;
}

/** Non-secret deterministic projection of the authenticated enrollment. */
export interface DeviceMetadata {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly devicePublicKey: string;
}

/**
 * The single local enrollment authority. Keeping identity and key in one
 * OS-managed entry prevents a crash from composing a key from one pairing
 * response with metadata from another.
 */
export type DeviceRecord = DeviceMetadata & DeviceCredentials;

/**
 * One pairing, staged before its request is sent (#2045). Every pairing
 * stages one, including a re-pair of this store's own enrollment. It keeps
 * the request immutable across a lost response, so an exact retry with the
 * same code (#1767) proves the same binding, and it is what a pairing
 * compares under the enrollment gate to know it still owns the slot.
 */
export interface PairingAttempt {
  readonly kind: 'pairing-attempt-v2';
  /** Random, minted when the attempt is staged. */
  readonly attemptId: string;
  /** `pairingCodeDigest` of the code this attempt sends; a retry with the same code resumes the attempt. */
  readonly codeDigest: string;
  /** `DeviceStore.identity` of the store that staged the attempt. */
  readonly storeIdentity: string;
  /** `isPairingText` within `PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH`. */
  readonly deviceName: string;
  /** Lowercase hex SHA-256, as `PairRequest.machineId`. */
  readonly machineId?: string;
  /** Its public key is derived, never stored. */
  readonly devicePrivateKeyPem: string;
  /** The `PairRequest` fence: `pairDeviceDigest` of the slot's enrollment when staged, or `null`. */
  readonly expectedDeviceDigest: string | null;
}

interface EnrollmentWithAttempt {
  readonly kind: 'enrollment-with-attempt-v2';
  readonly record: DeviceRecord;
  readonly attempt: PairingAttempt;
}

type DeviceCredentialAuthority = DeviceRecord | PairingAttempt | EnrollmentWithAttempt;

const ENTRY_ACCOUNT = 'device-enrollment';
const ENCODED_PREFIX = 'byok-device-credential-v2:';
/** The wire v6 entry format. Its credentials are void on a v7 cloud, and it is recognized by this prefix alone. */
const LEGACY_ENCODED_PREFIX = 'byok-device-credential-v1:';
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

/**
 * Typed unavailability; callers must surface re-pair/operational failure, never write a file fallback.
 * Provider start failures retain only a sanitized error with a trusted string code as cause.
 */
export class DeviceCredentialStoreUnavailableError extends Error {
  constructor(message = 'no supported operating-system credential provider is available', options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeviceCredentialStoreUnavailableError';
  }
}

export class DeviceCredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceCredentialStoreError';
  }
}

/**
 * The OS entry holds a wire v6 enrollment or attempt. It is recognized by its
 * format version alone; nothing in it is decoded, including its private key.
 * Its credentials are void on a v7 cloud: `clear()` deletes the entry, and
 * the store pairs as a first pairing.
 */
export class DeviceCredentialLegacyEntryError extends DeviceCredentialStoreError {
  constructor() {
    super('OS credential entry holds a wire v6 device enrollment; pair again');
    this.name = 'DeviceCredentialLegacyEntryError';
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
 * Complete enrollment custody: one slot holding an enrollment, a staged
 * pairing attempt, or both. An injected implementation owns secret storage
 * and its lifetime. `signal` cancels the operation (daemon shutdown); an
 * implementation must stop and reject once it aborts.
 * Staging an attempt replaces any staged attempt and preserves the current
 * enrollment returned by `read()`. `replace()` promotes a pairing: it writes
 * the new enrollment and discards the staged attempt. `clear()` removes both.
 * An attempt is kept with every field.
 * An error it throws reaches the Host unchanged, as the `cause` of a public
 * error such as `DeviceEnrollmentClearError`, so it must not carry a secret.
 */
export interface DeviceCredentialBackend {
  read(signal?: AbortSignal): Promise<DeviceRecord | undefined>;
  readPairingAttempt(signal?: AbortSignal): Promise<PairingAttempt | undefined>;
  savePairingAttempt(attempt: PairingAttempt, signal?: AbortSignal): Promise<void>;
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
    typeof (value as Partial<DeviceCredentials>).devicePrivateKeyPem !== 'string'
  ) {
    throw new DeviceCredentialStoreError('OS credential entry has an invalid device credential shape');
  }
  const credential = value as DeviceRecord;
  if (
    !isPairingText(credential.deviceId, PAIR_RESPONSE_DEVICE_ID_MAX_LENGTH) ||
    credential.devicePublicKey.length === 0 ||
    credential.devicePrivateKeyPem.length === 0
  ) {
    throw new DeviceCredentialStoreError('OS credential entry has an incomplete device credential');
  }
}

function isPairingAttempt(value: DeviceCredentialAuthority): value is PairingAttempt {
  return 'kind' in value && value.kind === 'pairing-attempt-v2';
}

function isEnrollmentWithAttempt(value: DeviceCredentialAuthority): value is EnrollmentWithAttempt {
  return 'kind' in value && value.kind === 'enrollment-with-attempt-v2';
}

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/u;

function assertPairingAttempt(value: unknown): asserts value is PairingAttempt {
  const attempt = value as Partial<PairingAttempt>;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    attempt.kind !== 'pairing-attempt-v2' ||
    typeof attempt.attemptId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(attempt.attemptId) ||
    typeof attempt.codeDigest !== 'string' || !BASE64URL_43.test(attempt.codeDigest) ||
    typeof attempt.storeIdentity !== 'string' || !/^[0-9a-f]{64}$/u.test(attempt.storeIdentity) ||
    typeof attempt.deviceName !== 'string' ||
    typeof attempt.devicePrivateKeyPem !== 'string' ||
    (attempt.machineId !== undefined && (typeof attempt.machineId !== 'string' || !/^[0-9a-f]{64}$/u.test(attempt.machineId))) ||
    (attempt.expectedDeviceDigest !== null && (typeof attempt.expectedDeviceDigest !== 'string' || !BASE64URL_43.test(attempt.expectedDeviceDigest))) ||
    !isPairingText(attempt.deviceName, PAIR_REQUEST_DEVICE_NAME_MAX_LENGTH) ||
    attempt.devicePrivateKeyPem.length === 0
  ) {
    throw new DeviceCredentialStoreError('OS credential entry has an invalid pairing attempt shape');
  }
}

function assertEnrollmentWithAttempt(value: unknown): asserts value is EnrollmentWithAttempt {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    (value as Partial<EnrollmentWithAttempt>).kind !== 'enrollment-with-attempt-v2'
  ) {
    throw new DeviceCredentialStoreError('OS credential entry has an invalid enrollment-with-attempt shape');
  }
  assertRecord((value as Partial<EnrollmentWithAttempt>).record);
  assertPairingAttempt((value as Partial<EnrollmentWithAttempt>).attempt);
}

function freezeRecord(record: DeviceRecord): DeviceRecord {
  return Object.freeze({
    deviceId: record.deviceId,
    tenantId: record.tenantId,
    devicePublicKey: record.devicePublicKey,
    devicePrivateKeyPem: record.devicePrivateKeyPem,
  });
}

function freezeAttempt(attempt: PairingAttempt): PairingAttempt {
  return Object.freeze({
    kind: attempt.kind,
    attemptId: attempt.attemptId,
    codeDigest: attempt.codeDigest,
    storeIdentity: attempt.storeIdentity,
    deviceName: attempt.deviceName,
    ...(attempt.machineId === undefined ? {} : { machineId: attempt.machineId }),
    devicePrivateKeyPem: attempt.devicePrivateKeyPem,
    expectedDeviceDigest: attempt.expectedDeviceDigest,
  });
}

/** PKCS8 DER of an Ed25519 private key, before its 32-byte seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The entry stores each key as its 32-byte seed and no public key: both the
 * PEM and the public key are deterministic projections of the seed.
 */
function seedOf(devicePrivateKeyPem: string): string {
  let der: Buffer;
  try {
    der = createPrivateKey(devicePrivateKeyPem).export({ format: 'der', type: 'pkcs8' });
  } catch {
    throw new DeviceCredentialStoreError('device private key is not an Ed25519 key');
  }
  if (der.length !== 48 || !der.subarray(0, 16).equals(ED25519_PKCS8_PREFIX)) {
    throw new DeviceCredentialStoreError('device private key is not an Ed25519 key');
  }
  return der.subarray(16).toString('base64url');
}

function privateKeyPemOf(seed: unknown): string {
  if (typeof seed !== 'string' || !BASE64URL_43.test(seed)) throw new DeviceCredentialStoreError('OS credential entry has an invalid device key');
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed, 'base64url')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }) as string;
}

function storedRecord(record: DeviceRecord): object {
  const deviceKey = seedOf(record.devicePrivateKeyPem);
  if (publicKeyOfPrivateKeyPem(record.devicePrivateKeyPem) !== record.devicePublicKey) {
    throw new DeviceCredentialStoreError('device public key does not match its private key');
  }
  return { deviceId: record.deviceId, tenantId: record.tenantId, deviceKey };
}

function storedAttempt(attempt: PairingAttempt): object {
  const { devicePrivateKeyPem, ...fields } = freezeAttempt(attempt);
  return { ...fields, deviceKey: seedOf(devicePrivateKeyPem) };
}

/** The asserts below check every field; a stored value that is not an object has no `deviceKey`. */
function recordOfStored(value: unknown): DeviceRecord {
  const { deviceKey, ...fields } = Object(value) as Record<string, unknown>;
  const devicePrivateKeyPem = privateKeyPemOf(deviceKey);
  const record = { ...fields, devicePublicKey: publicKeyOfPrivateKeyPem(devicePrivateKeyPem), devicePrivateKeyPem };
  assertRecord(record);
  return freezeRecord(record);
}

function attemptOfStored(value: unknown): PairingAttempt {
  const { deviceKey, ...fields } = Object(value) as Record<string, unknown>;
  const attempt = { ...fields, devicePrivateKeyPem: privateKeyPemOf(deviceKey) };
  assertPairingAttempt(attempt);
  return freezeAttempt(attempt);
}

function encode(authority: DeviceCredentialAuthority): string {
  let stored: object;
  if (isEnrollmentWithAttempt(authority)) {
    assertEnrollmentWithAttempt(authority);
    stored = { kind: authority.kind, record: storedRecord(authority.record), attempt: storedAttempt(authority.attempt) };
  } else if (isPairingAttempt(authority)) {
    assertPairingAttempt(authority);
    stored = storedAttempt(authority);
  } else {
    assertRecord(authority);
    stored = storedRecord(authority);
  }
  const encoded = Buffer.from(JSON.stringify(stored), 'utf8').toString('base64');
  const value = `${ENCODED_PREFIX}${encoded}`;
  // The field bounds are a wire contract; this check on the encoded value is
  // what guarantees the entry fits. Windows generic-credential blobs are
  // limited, and a key authority is never truncated into a different one.
  if (Buffer.byteLength(value, 'utf8') > OS_CREDENTIAL_ENTRY_MAX_BYTES) {
    throw new DeviceCredentialStoreError('device credential exceeds the OS credential entry bound');
  }
  return value;
}

/**
 * The entry `replace(record)` writes: every field validated, encoded and
 * within {@link OS_CREDENTIAL_ENTRY_MAX_BYTES}, or a
 * {@link DeviceCredentialStoreError}. A pairing calls it before it writes
 * anything, whichever backend holds the enrollment.
 */
export function encodeEnrollmentEntry(record: DeviceRecord): string {
  return encode(record);
}

function decode(value: string): DeviceCredentialAuthority {
  if (value.startsWith(LEGACY_ENCODED_PREFIX)) throw new DeviceCredentialLegacyEntryError();
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
  if (typeof parsed === 'object' && parsed !== null && (parsed as Partial<PairingAttempt>).kind === 'pairing-attempt-v2') {
    return attemptOfStored(parsed);
  }
  if (typeof parsed === 'object' && parsed !== null && (parsed as Partial<EnrollmentWithAttempt>).kind === 'enrollment-with-attempt-v2') {
    const { record, attempt } = parsed as { record?: unknown; attempt?: unknown };
    return Object.freeze({ kind: 'enrollment-with-attempt-v2', record: recordOfStored(record), attempt: attemptOfStored(attempt) });
  }
  return recordOfStored(parsed);
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
    return this.#bounded(signal, async bounded => {
      // Invalid input is not provider unavailability; keep the slot-only preflight error.
      assertNoNulSpawnInput(executable, args, process.env);
      try { return await this.#run(executable, args, stdin, bounded); }
      catch (error) { throw new DeviceCredentialStoreUnavailableError(undefined, { cause: spawnStartError(error) }); }
    });
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
 * Internal OS-backed authority for the device enrollment and private key, in
 * the entry `device-enrollment`.
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
    if (authority === undefined || isPairingAttempt(authority)) return undefined;
    return isEnrollmentWithAttempt(authority) ? authority.record : authority;
  }

  async readPairingAttempt(signal?: AbortSignal): Promise<PairingAttempt | undefined> {
    const authority = await this.#readAuthority(signal);
    if (authority === undefined) return undefined;
    if (isEnrollmentWithAttempt(authority)) return authority.attempt;
    return isPairingAttempt(authority) ? authority : undefined;
  }

  async savePairingAttempt(attempt: PairingAttempt, signal?: AbortSignal): Promise<void> {
    assertPairingAttempt(attempt);
    const record = await this.read(signal);
    await this.#entry.replace(encode(record === undefined
      ? attempt : { kind: 'enrollment-with-attempt-v2', record, attempt }), signal);
  }

  async #readAuthority(signal: AbortSignal | undefined): Promise<DeviceCredentialAuthority | undefined> {
    const raw = await this.#entry.read(signal);
    return raw === undefined ? undefined : decode(raw);
  }

  async replace(record: DeviceRecord, signal?: AbortSignal): Promise<void> {
    const encoded = encodeEnrollmentEntry(record);
    // An entry this store cannot decode is refused, never overwritten.
    await this.#readAuthority(signal);
    await this.#entry.replace(encoded, signal);
  }

  /**
   * Returns true only after the sole secret authority is confirmed absent. A
   * wire v6 entry is deleted unread. The caller holds the enrollment gate, so
   * no v7 write lands between the read and the deletion.
   */
  async clear(signal?: AbortSignal): Promise<boolean> {
    const before = await this.#entry.read(signal);
    if (before === undefined) return false;
    if (!before.startsWith(LEGACY_ENCODED_PREFIX)) decode(before);
    await this.#entry.delete(signal);
    if ((await this.#entry.read(signal)) !== undefined) {
      throw new DeviceCredentialStoreError('operating-system credential provider reported deletion but device credentials remain');
    }
    return true;
  }
}


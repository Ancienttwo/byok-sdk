import path from 'node:path';

import { type CommandRunner, runCommand } from './command-runner.js';
import { assertNoNulSpawnInput, spawnStartError } from '@byok-sdk/core/system-tool';
import { ByokKeysError } from './errors.js';
import { assertSecretName, assertSecretNamespace } from './secret-name.js';
import {
  DEFAULT_SECRET_SERVICE_PREFIX,
  type SecretStore,
  decodeStrictBase64Utf8,
} from './secret-store.js';

/**
 * Marker written in front of every stored value so a read can tell a value this
 * package wrote from anything else already sitting at the same service name.
 * Injectable, so K4's aip-main-open swap passes `aiphabee-b64-v1:` and stays
 * byte-compatible with existing installs (source: `index.ts:246`).
 */
export const DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX = 'byok-b64-v1:';

/** `security` exits 44 for "the item does not exist". */
const SECURITY_ITEM_NOT_FOUND = 44;

export interface MacOsKeychainSecretStoreOptions {
  /** Keychain account field; entries are addressed by (account, service). */
  account?: string;
  commandRunner?: CommandRunner;
  /** Explicit macOS keychain file; omitted means the user default keychain. */
  keychainPath?: string;
  platform?: NodeJS.Platform;
  servicePrefix?: string;
  storagePrefix?: string;
}

/**
 * macOS Keychain backend, driving `/usr/bin/security`
 * (`aip-main-open@c6a5385` `apps/local-agent/src/index.ts:412-533`).
 *
 * There is deliberately no plaintext fallback: on a non-darwin platform every
 * operation throws `KEYCHAIN_UNAVAILABLE` rather than degrading to a file.
 */
export class MacOsKeychainSecretStore<TName extends string = string>
  implements SecretStore<TName>
{
  readonly providerLabel = 'macOS Keychain';
  readonly #account: string;
  readonly #commandRunner: CommandRunner;
  readonly #keychainPath: string | undefined;
  readonly #platform: NodeJS.Platform;
  readonly #servicePrefix: string;
  readonly #storagePrefix: string;

  constructor(options: MacOsKeychainSecretStoreOptions = {}) {
    this.#account = options.account ?? 'local-device';
    this.#commandRunner = options.commandRunner ?? runCommand;
    this.#keychainPath = assertKeychainPath(options.keychainPath);
    this.#platform = options.platform ?? process.platform;
    this.#servicePrefix = options.servicePrefix ?? DEFAULT_SECRET_SERVICE_PREFIX;
    this.#storagePrefix =
      options.storagePrefix ?? DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX;
  }

  async available(): Promise<boolean> {
    if (this.#platform !== 'darwin') return false;
    try {
      const result = await this.#commandRunner('/usr/bin/security', [
        ...(this.#keychainPath === undefined
          ? ['default-keychain', '-d', 'user']
          : ['show-keychain-info', this.#keychainPath]),
      ]);
      return result.exitCode === 0;
    } catch {
      // Availability is a boolean probe, including when its input is invalid.
      return false;
    }
  }

  async delete(name: TName): Promise<boolean> {
    const service = this.#service(name);
    this.#assertMacOs();
    const stored = await this.#readStored(service);
    if (stored === undefined) return false;
    const result = await this.#invoke('DELETE', [
      'delete-generic-password',
      '-a',
      this.#account,
      '-s',
      service,
      ...(this.#keychainPath === undefined ? [] : [this.#keychainPath]),
    ]);
    if (result.exitCode === SECURITY_ITEM_NOT_FOUND) return false;
    if (result.exitCode !== 0) {
      throw new ByokKeysError(
        'KEYCHAIN_DELETE_FAILED',
        'macOS Keychain could not delete the requested secret',
      );
    }
    return true;
  }

  async get(name: TName): Promise<string | undefined> {
    const service = this.#service(name);
    this.#assertMacOs();
    const stored = await this.#readStored(service);
    return stored === undefined ? undefined : this.#decode(stored);
  }

  async #readStored(service: string): Promise<string | undefined> {
    const result = await this.#invoke('READ', [
      'find-generic-password',
      '-a',
      this.#account,
      '-s',
      service,
      '-w',
      ...(this.#keychainPath === undefined ? [] : [this.#keychainPath]),
    ]);
    if (result.exitCode === SECURITY_ITEM_NOT_FOUND) return undefined;
    if (result.exitCode !== 0) {
      throw new ByokKeysError(
        'KEYCHAIN_READ_FAILED',
        'macOS Keychain could not read the requested secret',
      );
    }
    const stored = result.stdout.replace(/\r?\n$/u, '');
    if (!stored.startsWith(this.#storagePrefix)) throw new ByokKeysError('KEYCHAIN_LEGACY', 'Legacy Keychain entry');
    return stored;
  }

  async has(name: TName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  scope(namespace: string): SecretStore<TName> {
    return new MacOsKeychainSecretStore<TName>({
      account: this.#account,
      commandRunner: this.#commandRunner,
      keychainPath: this.#keychainPath,
      platform: this.#platform,
      servicePrefix: `${this.#servicePrefix}.scope.${assertSecretNamespace(namespace)}`,
      storagePrefix: this.#storagePrefix,
    });
  }

  async set(name: TName, secret: string): Promise<void> {
    const service = this.#service(name);
    this.#assertMacOs();
    if (
      secret.length === 0 ||
      secret.length > 16_384 ||
      /[\u0000\r\n]/u.test(secret)
    ) {
      throw new ByokKeysError(
        'KEYCHAIN_SECRET_INVALID',
        'Secret must contain 1 to 16384 non-newline characters',
      );
    }
    // `security add-generic-password -w` opens /dev/tty when no password
    // argument is supplied, even if the child has a piped stdin. Interactive
    // mode accepts the complete command through stdin, keeping the encoded
    // secret out of argv/process listings and avoiding an unattended prompt.
    const storedSecret = `${this.#storagePrefix}${Buffer.from(secret, 'utf8').toString('base64')}`;
    const command = [
      'add-generic-password',
      '-U',
      '-a',
      quoteSecurityInteractiveArgument(this.#account),
      '-s',
      quoteSecurityInteractiveArgument(service),
      '-w',
      quoteSecurityInteractiveArgument(storedSecret),
      ...(this.#keychainPath === undefined
        ? []
        : [quoteSecurityInteractiveArgument(this.#keychainPath)]),
    ].join(' ');
    const result = await this.#invoke(
      'WRITE',
      ['-i'],
      `${command}\n`,
    );
    if (result.exitCode !== 0) {
      throw new ByokKeysError(
        'KEYCHAIN_WRITE_FAILED',
        'macOS Keychain could not store the requested secret',
      );
    }
  }

  async #invoke(operation: 'READ' | 'DELETE' | 'WRITE', args: string[], stdin?: string) {
    // Refuse caller input before translating runner failures into provider availability.
    assertNoNulSpawnInput('/usr/bin/security', args, process.env);
    try { return await this.#commandRunner('/usr/bin/security', args, stdin); }
    catch (error) {
      const input = error instanceof Error && error.name === 'CommandInputError';
      const cause = spawnStartError(error);
      if (input) {
        cause.name = 'CommandInputError';
        cause.message = `command input failed: ${cause.code ?? 'unknown'}`;
      }
      throw new ByokKeysError(
        input ? `KEYCHAIN_${operation}_FAILED` : 'KEYCHAIN_UNAVAILABLE',
        input ? 'macOS Keychain command input failed' : 'macOS Keychain is unavailable',
        { cause },
      );
    }
  }

  #assertMacOs(): void {
    if (this.#platform !== 'darwin') {
      throw new ByokKeysError(
        'KEYCHAIN_UNAVAILABLE',
        'macOS Keychain is required; plaintext fallback is disabled',
      );
    }
  }

  /** Decode only values whose storage prefix was checked by #readStored. */
  #decode(storedSecret: string): string {
    const decoded = decodeStrictBase64Utf8(
      storedSecret.slice(this.#storagePrefix.length),
    );
    if (decoded === undefined || decoded.length === 0) {
      throw new ByokKeysError(
        'KEYCHAIN_SECRET_CORRUPTED',
        'Corrupt macOS Keychain secret',
      );
    }
    return decoded;
  }

  #service(name: TName): string {
    return `${this.#servicePrefix}.${assertSecretName(name)}`;
  }
}

/**
 * Quote a value for `security -i`'s interactive parser (`index.ts:547-557`).
 * Null and newline characters cannot be quoted safely — a newline would end the
 * command line and let the remainder be parsed as a second command — so they are
 * rejected rather than escaped.
 */
function quoteSecurityInteractiveArgument(value: string): string {
  if (/[\u0000\r\n]/u.test(value)) {
    throw new ByokKeysError(
      'KEYCHAIN_ARGUMENT_INVALID',
      'macOS Keychain arguments cannot contain null or newline characters',
    );
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function assertKeychainPath(keychainPath: string | undefined): string | undefined {
  if (keychainPath === undefined) return undefined;
  if (
    keychainPath.length === 0 ||
    !path.posix.isAbsolute(keychainPath) ||
    /[\u0000\r\n]/u.test(keychainPath)
  ) {
    throw new ByokKeysError(
      'KEYCHAIN_ARGUMENT_INVALID',
      'macOS keychain path must be a non-empty absolute single-line path',
    );
  }
  return keychainPath;
}

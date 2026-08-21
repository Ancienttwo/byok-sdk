import path from 'node:path';

import { type CommandRunner, runCommand } from './command-runner';
import { ByokKeysError } from './errors';
import { assertSecretName, assertSecretNamespace } from './secret-name';
import {
  DEFAULT_SECRET_SERVICE_PREFIX,
  type SecretStore,
  decodeStrictBase64Utf8,
} from './secret-store';

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
  /**
   * Return a stored value that lacks {@link MacOsKeychainSecretStoreOptions.storagePrefix}
   * instead of throwing. Defaults to `false`.
   *
   * The source returned such values unconditionally
   * (`decodeMacOsKeychainSecret`, `index.ts:536-545`), which meant any
   * unrelated item at the same service name was handed back as if this package
   * had written it. Reading is fail-closed here, and the tolerant behavior is
   * demoted to something a caller must ask for by name — it exists only for a
   * migration that has read an unprefixed value it already knows it wrote.
   */
  allowUnprefixedRead?: boolean;
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
  readonly #allowUnprefixedRead: boolean;
  readonly #commandRunner: CommandRunner;
  readonly #keychainPath: string | undefined;
  readonly #platform: NodeJS.Platform;
  readonly #servicePrefix: string;
  readonly #storagePrefix: string;

  constructor(options: MacOsKeychainSecretStoreOptions = {}) {
    this.#account = options.account ?? 'local-device';
    this.#allowUnprefixedRead = options.allowUnprefixedRead ?? false;
    this.#commandRunner = options.commandRunner ?? runCommand;
    this.#keychainPath = assertKeychainPath(options.keychainPath);
    this.#platform = options.platform ?? process.platform;
    this.#servicePrefix = options.servicePrefix ?? DEFAULT_SECRET_SERVICE_PREFIX;
    this.#storagePrefix =
      options.storagePrefix ?? DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX;
  }

  async available(): Promise<boolean> {
    if (this.#platform !== 'darwin') return false;
    const result = await this.#commandRunner('/usr/bin/security', [
      ...(this.#keychainPath === undefined
        ? ['default-keychain', '-d', 'user']
        : ['show-keychain-info', this.#keychainPath]),
    ]);
    return result.exitCode === 0;
  }

  async delete(name: TName): Promise<boolean> {
    const service = this.#service(name);
    this.#assertMacOs();
    const result = await this.#commandRunner('/usr/bin/security', [
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
    const result = await this.#commandRunner('/usr/bin/security', [
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
    return this.#decode(result.stdout.replace(/\r?\n$/u, ''));
  }

  async has(name: TName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  scope(namespace: string): SecretStore<TName> {
    return new MacOsKeychainSecretStore<TName>({
      account: this.#account,
      allowUnprefixedRead: this.#allowUnprefixedRead,
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
    const result = await this.#commandRunner(
      '/usr/bin/security',
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

  #assertMacOs(): void {
    if (this.#platform !== 'darwin') {
      throw new ByokKeysError(
        'KEYCHAIN_UNAVAILABLE',
        'macOS Keychain is required; plaintext fallback is disabled',
      );
    }
  }

  /**
   * Fail-closed inverse of the storage encoding. The error message never
   * echoes the undecodable value — it may still be somebody's live credential.
   */
  #decode(storedSecret: string): string {
    if (!storedSecret.startsWith(this.#storagePrefix)) {
      if (this.#allowUnprefixedRead) return storedSecret;
      throw new ByokKeysError(
        'KEYCHAIN_SECRET_DECODE_FAILED',
        'macOS Keychain returned a value without this store\'s storage prefix',
      );
    }
    const decoded = decodeStrictBase64Utf8(
      storedSecret.slice(this.#storagePrefix.length),
    );
    if (decoded === undefined || decoded.length === 0) {
      throw new ByokKeysError(
        'KEYCHAIN_SECRET_DECODE_FAILED',
        'macOS Keychain returned a secret that is not valid base64-encoded UTF-8',
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

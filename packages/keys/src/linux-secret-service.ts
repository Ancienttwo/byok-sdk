import { resolveSystemTool } from '@byok-sdk/core/system-tool';

import { type CommandResult, type CommandRunner, runCommand } from './command-runner.js';
import { ByokKeysError } from './errors.js';
import { DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX } from './macos-keychain.js';
import { assertSecretName, assertSecretNamespace } from './secret-name.js';
import {
  assertSharedSecretValue,
  DEFAULT_SECRET_SERVICE_PREFIX,
  decodeStrictBase64Utf8,
  type SecretStore,
} from './secret-store.js';

export interface LinuxSecretServiceSecretStoreOptions {
  account?: string;
  commandRunner?: CommandRunner;
  platform?: NodeJS.Platform;
  servicePrefix?: string;
  storagePrefix?: string;
}

const systemRunner: CommandRunner = (command, args, stdin) =>
  runCommand(resolveSystemTool(command), args, stdin);

// libsecret 0.21.7 read_password_stdin truncates beyond this byte limit:
// https://github.com/GNOME/libsecret/blob/0.21.7/tool/secret-tool.c#L228-L264
const LIBSECRET_STDIN_MAX_BYTES = 8192;

/** Linux Secret Service through the trusted system secret-tool; no plaintext fallback. */
export class LinuxSecretServiceSecretStore<TName extends string = string>
  implements SecretStore<TName>
{
  readonly providerLabel = 'Linux Secret Service';
  readonly #account: string;
  readonly #commandRunner: CommandRunner;
  readonly #platform: NodeJS.Platform;
  readonly #servicePrefix: string;
  readonly #storagePrefix: string;

  constructor(options: LinuxSecretServiceSecretStoreOptions = {}) {
    this.#account = options.account ?? 'local-device';
    this.#commandRunner = options.commandRunner ?? systemRunner;
    this.#platform = options.platform ?? process.platform;
    this.#servicePrefix = options.servicePrefix ?? DEFAULT_SECRET_SERVICE_PREFIX;
    this.#storagePrefix = options.storagePrefix ?? DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX;
  }

  async available(): Promise<boolean> {
    try {
      await this.#invoke('lookup', 'availability-probe');
      return true;
    } catch {
      return false;
    }
  }

  async delete(name: TName): Promise<boolean> {
    return (await this.#invoke('clear', name)).exitCode === 0;
  }

  async get(name: TName): Promise<string | undefined> {
    const result = await this.#invoke('lookup', name);
    if (result.exitCode === 1) return undefined;
    const stored = result.stdout.replace(/\r?\n$/u, '');
    const decoded = stored.startsWith(this.#storagePrefix)
      ? decodeStrictBase64Utf8(stored.slice(this.#storagePrefix.length))
      : undefined;
    if (decoded === undefined || decoded.length === 0) {
      throw new ByokKeysError(
        'KEYCHAIN_SECRET_DECODE_FAILED',
        'Linux Secret Service returned an invalid encoded secret',
      );
    }
    return decoded;
  }

  async has(name: TName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  scope(namespace: string): SecretStore<TName> {
    return new LinuxSecretServiceSecretStore<TName>({
      account: this.#account,
      commandRunner: this.#commandRunner,
      platform: this.#platform,
      servicePrefix: `${this.#servicePrefix}.scope.${assertSecretNamespace(namespace)}`,
      storagePrefix: this.#storagePrefix,
    });
  }

  async set(name: TName, secret: string): Promise<void> {
    assertSharedSecretValue(secret);
    const stored = `${this.#storagePrefix}${Buffer.from(secret, 'utf8').toString('base64')}`;
    if (Buffer.byteLength(stored, 'utf8') > LIBSECRET_STDIN_MAX_BYTES) {
      throw new ByokKeysError(
        'KEYCHAIN_SECRET_INVALID',
        `Encoded secret exceeds the ${LIBSECRET_STDIN_MAX_BYTES}-byte Secret Service input limit`,
      );
    }
    await this.#invoke('store', name, stored);
  }

  async #invoke(operation: 'lookup' | 'clear' | 'store', name: string, stdin?: string): Promise<CommandResult> {
    const service = `${this.#servicePrefix}.${assertSecretName(name)}`;
    const unavailable = () => new ByokKeysError(
      'KEYCHAIN_UNAVAILABLE',
      'Linux Secret Service is unavailable; install secret-tool and unlock a keyring on the session D-Bus',
    );
    if (this.#platform !== 'linux') throw unavailable();
    let result: CommandResult;
    try {
      result = await this.#commandRunner('secret-tool', [
        operation,
        ...(operation === 'store' ? [`--label=${service}`] : []),
        'service', service, 'account', this.#account,
      ], stdin);
    } catch {
      // The runner error and tool output can contain credential bytes. Neither is attached.
      throw unavailable();
    }
    // secret-tool's empty exit 1 is absence only for lookup and clear, never store.
    const absent = operation !== 'store' && result.exitCode === 1
      && result.stdout === '' && result.stderr === '';
    if (result.exitCode !== 0 && !absent) throw unavailable();
    return result;
  }
}

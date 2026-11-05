import { ByokKeysError } from './errors';
import { assertSecretName, assertSecretNamespace } from './secret-name';
import { DEFAULT_SECRET_SERVICE_PREFIX, type SecretStore } from './secret-store';

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;
const ERROR_NOT_FOUND = 1168;
const NATIVE_CALL_DEADLINE_MS = 15_000;

type NativeOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'absent'; detail: string }
  | { kind: 'failed'; detail: string };

/** Begins one native call; `finish` runs when the OS call has returned, however late. */
type NativeCall<T> = (finish: (outcome: NativeOutcome<T>) => void) => void;

type NativeCallback = (error: unknown, succeeded: number) => void;
interface NativeFunction {
  (...args: unknown[]): unknown;
  async(...args: unknown[]): void;
}
/** Structural view of koffi, satisfied by the npm module and by the SDK native asset. */
interface KoffiModule {
  decode(value: unknown, type: unknown, length?: number): unknown;
  load(path: string): { func(convention: string, name: string, result: unknown, args: unknown[]): NativeFunction };
  out(type: unknown): unknown;
  pointer(type: unknown): unknown;
  struct(definition: Record<string, unknown>): unknown;
}

interface CredentialBindings {
  credDelete: NativeFunction;
  credFree: NativeFunction;
  credRead: NativeFunction;
  credWrite: NativeFunction;
  credential: unknown;
  koffi: KoffiModule;
  lastError: NativeFunction;
}

const cachedBindings = new WeakMap<object, CredentialBindings>();

function credentialBindings(koffi: KoffiModule): CredentialBindings {
  let bindings = cachedBindings.get(koffi);
  if (bindings === undefined) {
    // Anonymous on purpose: koffi names are global to the module, and a process
    // that also runs @byok-sdk/client binds this struct on the same module.
    const credential = koffi.struct({
      Flags: 'uint32_t',
      Type: 'uint32_t',
      TargetName: 'str16',
      Comment: 'str16',
      LastWritten: koffi.struct({ dwLowDateTime: 'uint32_t', dwHighDateTime: 'uint32_t' }),
      CredentialBlobSize: 'uint32_t',
      CredentialBlob: 'void *',
      Persist: 'uint32_t',
      AttributeCount: 'uint32_t',
      Attributes: 'void *',
      TargetAlias: 'str16',
      UserName: 'str16',
    });
    const advapi32 = koffi.load('advapi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    bindings = {
      credDelete: advapi32.func('__stdcall', 'CredDeleteW', 'int', ['str16', 'uint32_t', 'uint32_t']),
      credFree: advapi32.func('__stdcall', 'CredFree', 'void', ['void *']),
      credRead: advapi32.func('__stdcall', 'CredReadW', 'int', ['str16', 'uint32_t', 'uint32_t', koffi.out(koffi.pointer('void *'))]),
      credWrite: advapi32.func('__stdcall', 'CredWriteW', 'int', [koffi.pointer(credential), 'uint32_t']),
      credential,
      koffi,
      lastError: kernel32.func('__stdcall', 'GetLastError', 'uint32_t', []),
    };
    cachedBindings.set(koffi, bindings);
  }
  return bindings;
}

/**
 * koffi restores a worker thread's last error only while that call's async
 * callback runs, so this must be called from inside the callback.
 */
function callOutcome(bindings: CredentialBindings, error: unknown, succeeded: number): NativeOutcome<true> {
  if (error !== null && error !== undefined) return { kind: 'failed', detail: 'native call failed' };
  if (succeeded !== 0) return { kind: 'ok', value: true };
  const win32 = bindings.lastError() as number;
  return { kind: win32 === ERROR_NOT_FOUND ? 'absent' : 'failed', detail: `win32=${win32}` };
}

/** `undefined` for an empty blob or one that is not valid UTF-8. */
function secretOfEntry({ credential, koffi }: CredentialBindings, pointer: unknown): string | undefined {
  const entry = koffi.decode(pointer, credential) as { CredentialBlob: unknown; CredentialBlobSize: number };
  if (entry.CredentialBlobSize === 0) return undefined;
  const copy = koffi.decode(entry.CredentialBlob, 'uint8_t', entry.CredentialBlobSize) as Uint8Array;
  const bytes = Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
  const text = bytes.toString('utf8');
  const valid = Buffer.from(text, 'utf8').equals(bytes);
  bytes.fill(0);
  return valid ? text : undefined;
}

function readCredential(bindings: CredentialBindings, target: string): NativeCall<string | undefined> {
  return (finish) => {
    const pointer: [unknown] = [null];
    const callback: NativeCallback = (error, succeeded) => {
      const outcome = callOutcome(bindings, error, succeeded);
      if (outcome.kind !== 'ok') {
        finish(outcome);
        return;
      }
      let read: NativeOutcome<string | undefined>;
      try {
        read = { kind: 'ok', value: secretOfEntry(bindings, pointer[0]) };
      } catch {
        read = { kind: 'failed', detail: 'entry decode failed' };
      } finally {
        bindings.credFree(pointer[0]);
      }
      finish(read);
    };
    bindings.credRead.async(target, CRED_TYPE_GENERIC, 0, pointer, callback);
  };
}

/** The buffer is made here so a call that expires in the queue never holds the secret. */
function writeCredential(bindings: CredentialBindings, target: string, username: string, secret: string): NativeCall<true> {
  return (finish) => {
    const blob = Buffer.from(secret, 'utf8');
    const callback: NativeCallback = (error, succeeded) => {
      const outcome = callOutcome(bindings, error, succeeded);
      blob.fill(0);
      finish(outcome);
    };
    try {
      bindings.credWrite.async({
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target,
        Comment: null,
        LastWritten: { dwLowDateTime: 0, dwHighDateTime: 0 },
        CredentialBlobSize: blob.length,
        CredentialBlob: blob,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: null,
        TargetAlias: null,
        UserName: username,
      }, 0, callback);
    } catch (error) {
      blob.fill(0);
      throw error;
    }
  };
}

function deleteCredential(bindings: CredentialBindings, target: string): NativeCall<true> {
  return (finish) => {
    const callback: NativeCallback = (error, succeeded) => finish(callOutcome(bindings, error, succeeded));
    bindings.credDelete.async(target, CRED_TYPE_GENERIC, 0, callback);
  };
}

let nativeQueue: Promise<void> = Promise.resolve();

/**
 * One native call at a time, in arrival order, across every store in this
 * module. A native call cannot be cancelled, so a caller that hits its deadline
 * leaves the call running: the queue stays held until the OS returns, which
 * keeps a late write from landing after a newer one and bounds stuck calls to
 * one thread. Time spent waiting counts toward the caller's own deadline, and a
 * call that expires while waiting never reaches the OS. After a deadline the
 * outcome of a write or delete is unknown; it is reported, never replayed.
 */
async function runNativeCall<T>(call: NativeCall<T>): Promise<NativeOutcome<T>> {
  return new Promise((resolve) => {
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      resolve({ kind: 'failed', detail: `deadline=${NATIVE_CALL_DEADLINE_MS}ms` });
    }, NATIVE_CALL_DEADLINE_MS);
    nativeQueue = nativeQueue.then(() => new Promise<void>((release) => {
      if (expired) {
        release();
        return;
      }
      const finish = (outcome: NativeOutcome<T>) => {
        clearTimeout(deadline);
        release();
        resolve(outcome);
      };
      try {
        call(finish);
      } catch {
        finish({ kind: 'failed', detail: 'native call failed' });
      }
    }));
  });
}

export interface WindowsCredentialManagerSecretStoreOptions {
  account?: string;
  /**
   * The koffi module to call Credential Manager through, for a packaged Host
   * that loads it with `loadSdkKoffiAsset` from `@byok-sdk/client/packaging`.
   * Defaults to `import('koffi')`.
   */
  koffi?: unknown;
  platform?: NodeJS.Platform;
  servicePrefix?: string;
}

/**
 * Windows Credential Manager backend (`index.ts:568-712`), called in process
 * through koffi. Entries are generic credentials with `Persist` 2 and the secret
 * as UTF-8 bytes.
 *
 * As on macOS there is no plaintext fallback — off win32 every operation throws
 * `CREDENTIAL_MANAGER_UNAVAILABLE`.
 */
export class WindowsCredentialManagerSecretStore<TName extends string = string>
  implements SecretStore<TName>
{
  readonly providerLabel = 'Windows Credential Manager';
  readonly #account: string;
  readonly #koffi: unknown;
  readonly #platform: NodeJS.Platform;
  readonly #servicePrefix: string;

  constructor(options: WindowsCredentialManagerSecretStoreOptions = {}) {
    this.#account = options.account ?? 'local-device';
    this.#koffi = options.koffi;
    this.#platform = options.platform ?? process.platform;
    this.#servicePrefix = options.servicePrefix ?? DEFAULT_SECRET_SERVICE_PREFIX;
  }

  async available(): Promise<boolean> {
    if (this.#platform !== 'win32') return false;
    try {
      await this.#bindings();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete, then read back. The source verifies rather than trusting the
   * delete's result (`index.ts:651-679`): a credential that survives a
   * "successful" delete is a security failure, so it is reported as one instead
   * of being returned as `true`.
   */
  async delete(name: TName): Promise<boolean> {
    const target = this.#service(name);
    this.#assertWindows();
    const bindings = await this.#bindings();
    const result = await runNativeCall(deleteCredential(bindings, target));
    if (result.kind === 'absent') return false;
    if (result.kind === 'failed') {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_DELETE_FAILED',
        `Windows Credential Manager could not delete the requested secret (${result.detail})`,
      );
    }
    const verification = await runNativeCall(readCredential(bindings, target));
    if (verification.kind === 'absent') return true;
    if (verification.kind === 'failed') {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_DELETE_FAILED',
        `Windows Credential Manager could not verify secret deletion (${verification.detail})`,
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
    const result = await runNativeCall(readCredential(await this.#bindings(), target));
    if (result.kind === 'absent') return undefined;
    if (result.kind === 'failed') {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_READ_FAILED',
        `Windows Credential Manager could not read the requested secret (${result.detail})`,
      );
    }
    if (result.value === undefined) {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_READ_FAILED',
        'Windows Credential Manager returned an invalid secret',
      );
    }
    return result.value;
  }

  async has(name: TName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  scope(namespace: string): SecretStore<TName> {
    return new WindowsCredentialManagerSecretStore<TName>({
      account: this.#account,
      koffi: this.#koffi,
      platform: this.#platform,
      servicePrefix: `${this.#servicePrefix}.scope.${assertSecretNamespace(namespace)}`,
    });
  }

  async set(name: TName, secret: string): Promise<void> {
    const target = this.#service(name);
    this.#assertWindows();
    assertWindowsCredentialSecret(secret);
    const result = await runNativeCall(writeCredential(await this.#bindings(), target, this.#account, secret));
    if (result.kind !== 'ok') {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_WRITE_FAILED',
        `Windows Credential Manager could not store the requested secret (${result.detail})`,
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

  async #bindings(): Promise<CredentialBindings> {
    try {
      const koffi = this.#koffi ?? (await import('koffi')).default;
      return credentialBindings(koffi as KoffiModule);
    } catch (cause) {
      throw new ByokKeysError(
        'CREDENTIAL_MANAGER_UNAVAILABLE',
        'Windows Credential Manager could not be loaded; plaintext fallback is disabled',
        { cause },
      );
    }
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

import { loadKoffi } from '../adapters/win32-job-object.js';

/**
 * Windows Credential Manager through advapi32, in this process.
 *
 * koffi runs each call on a libuv worker thread, so a stuck `lsass` costs a
 * thread and not the event loop. A native call cannot be killed: a caller that
 * gives up leaves it running, and the outcome stays unknown. The FIFO below
 * keeps that to one thread and stops a late write from landing after a newer
 * one. Secrets stay in this process and never reach a file, argv or a child.
 */

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;

/** `CREDENTIALW` as written; the unnamed fields are NULL or zero. */
export interface Win32CredentialWrite {
  readonly Type: number;
  readonly TargetName: string;
  readonly CredentialBlobSize: number;
  readonly CredentialBlob: Buffer;
  readonly Persist: number;
  readonly UserName: string;
}

/** Completion of one worker-thread call: `succeeded` is the Win32 `BOOL`. */
export type Win32CredentialCallback = (error: unknown, succeeded: number) => void;

/**
 * The advapi32 calls this module needs. An interface, so a test can hold a
 * call open from POSIX and observe what a late return does.
 */
export interface Win32CredentialBindings {
  /** `BOOL CredReadW(LPCWSTR, DWORD, DWORD, PCREDENTIALW *)`, on a worker thread. */
  credRead(target: string, type: number, flags: number, credential: [bigint | null], done: Win32CredentialCallback): void;
  /** `BOOL CredWriteW(PCREDENTIALW, DWORD)`, on a worker thread. */
  credWrite(credential: Win32CredentialWrite, flags: number, done: Win32CredentialCallback): void;
  /** `BOOL CredDeleteW(LPCWSTR, DWORD, DWORD)`, on a worker thread. */
  credDelete(target: string, type: number, flags: number, done: Win32CredentialCallback): void;
  /** `void CredFree(PVOID)`. */
  credFree(credential: bigint): void;
  /** `DWORD GetLastError()`. Only valid inside a completion callback, where koffi restores the worker's value. */
  getLastError(): number;
  /** A copy of the credential's blob bytes. */
  readBlob(credential: bigint): Buffer;
}

interface KoffiFunction {
  (...args: never[]): unknown;
  async(...args: unknown[]): void;
}
interface KoffiModule {
  load(path: string): { func(convention: string, name: string, result: unknown, args: unknown[]): KoffiFunction };
  struct(fields: Record<string, unknown>): unknown;
  pointer(type: unknown, count?: number): unknown;
  out(type: unknown): unknown;
  decode(pointer: bigint, type: unknown, length?: number): unknown;
}

const cachedBindings = new WeakMap<object, Win32CredentialBindings>();

function bindCredentialApi(koffi: KoffiModule): Win32CredentialBindings {
  const advapi32 = koffi.load('advapi32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const CREDENTIALW = koffi.struct({
    Flags: 'uint32_t', Type: 'uint32_t', TargetName: 'str16', Comment: 'str16',
    LastWrittenLow: 'uint32_t', LastWrittenHigh: 'uint32_t',
    CredentialBlobSize: 'uint32_t', CredentialBlob: 'void *', Persist: 'uint32_t',
    AttributeCount: 'uint32_t', Attributes: 'void *', TargetAlias: 'str16', UserName: 'str16',
  });
  const read = advapi32.func('__stdcall', 'CredReadW', 'int', ['str16', 'uint32_t', 'uint32_t', koffi.out(koffi.pointer('void', 2))]);
  const write = advapi32.func('__stdcall', 'CredWriteW', 'int', [koffi.pointer(CREDENTIALW), 'uint32_t']);
  const remove = advapi32.func('__stdcall', 'CredDeleteW', 'int', ['str16', 'uint32_t', 'uint32_t']);
  const free = advapi32.func('__stdcall', 'CredFree', 'void', ['void *']) as unknown as (credential: bigint) => void;
  const lastError = kernel32.func('__stdcall', 'GetLastError', 'uint32_t', []) as unknown as () => number;
  return {
    credRead: (...args) => read.async(...args),
    credWrite: (...args) => write.async(...args),
    credDelete: (...args) => remove.async(...args),
    credFree: free,
    getLastError: lastError,
    readBlob(credential) {
      const { CredentialBlobSize, CredentialBlob } = koffi.decode(credential, CREDENTIALW) as { CredentialBlobSize: number; CredentialBlob: bigint };
      if (CredentialBlobSize === 0) return Buffer.alloc(0);
      const decoded = koffi.decode(CredentialBlob, 'uint8_t', CredentialBlobSize) as Uint8Array;
      const copy = Buffer.from(decoded);
      decoded.fill(0);
      return copy;
    },
  };
}

/** The bindings of the koffi at `nativeAssetRoot`, or of the installed optional dependency. koffi loads on first use. */
export async function loadWin32CredentialBindings(nativeAssetRoot: string | undefined): Promise<Win32CredentialBindings> {
  const koffi = await loadKoffi(nativeAssetRoot) as KoffiModule;
  let bindings = cachedBindings.get(koffi);
  if (bindings === undefined) {
    bindings = bindCredentialApi(koffi);
    cachedBindings.set(koffi, bindings);
  }
  return bindings;
}

let lastCall: Promise<unknown> = Promise.resolve();

/**
 * Run one native credential call after every earlier one has really returned.
 * `signal` starts counting before the wait, so the wait spends the caller's own
 * deadline. A caller that aborts is released at once: its call is skipped if it
 * has not started, and otherwise holds its place until the native return.
 */
export function enqueueWin32CredentialCall<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const turn = lastCall.then(() => {
    signal.throwIfAborted();
    return call();
  });
  lastCall = turn.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void turn.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Settles with 0, or with the call's Win32 error read in its own completion callback. */
function completion(bindings: Win32CredentialBindings, start: (done: Win32CredentialCallback) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    start((error, succeeded) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve(succeeded === 0 ? bindings.getLastError() : 0);
    });
  });
}

/** The entry's blob, or the Win32 error. The native buffer is freed even when nobody waits for the result. */
export async function readWin32Credential(bindings: Win32CredentialBindings, target: string): Promise<{ readonly code: number; readonly value?: string }> {
  const credential: [bigint | null] = [null];
  const code = await completion(bindings, (done) => bindings.credRead(target, CRED_TYPE_GENERIC, 0, credential, done));
  if (code !== 0) return { code };
  try {
    const blob = bindings.readBlob(credential[0]!);
    try {
      return { code, value: blob.toString('utf8') };
    } finally {
      blob.fill(0);
    }
  } finally {
    bindings.credFree(credential[0]!);
  }
}

/** Write the entry, and clear `value`'s bytes once the native call has returned. */
export async function writeWin32Credential(bindings: Win32CredentialBindings, target: string, userName: string, value: string): Promise<number> {
  const blob = Buffer.from(value, 'utf8');
  try {
    return await completion(bindings, (done) => bindings.credWrite({
      Type: CRED_TYPE_GENERIC, TargetName: target, CredentialBlobSize: blob.length, CredentialBlob: blob,
      Persist: CRED_PERSIST_LOCAL_MACHINE, UserName: userName,
    }, 0, done));
  } finally {
    blob.fill(0);
  }
}

export function deleteWin32Credential(bindings: Win32CredentialBindings, target: string): Promise<number> {
  return completion(bindings, (done) => bindings.credDelete(target, CRED_TYPE_GENERIC, 0, done));
}

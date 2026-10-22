import { loadSdkKoffiAsset } from '../../sdk-native-assets-runtime';

/**
 * Windows client for the Hermes gateway control pipe, through kernel32.
 *
 * Node's `net` client cannot dial this pipe safely: libuv opens a pipe without
 * `SECURITY_SQOS_PRESENT`, so the server may impersonate the client. The pipe
 * name is in one machine-wide namespace, and a process of another account
 * that creates the name first would get this process's token. This client
 * opens the pipe at the identification level, as Hermes's own client does
 * (`query_runtime_control` in `gateway/runtime_bootstrap_windows.py`). It
 * reads the server pid from the kernel, and it writes only to a server the
 * caller owns: a server that never reads cannot block this synchronous handle.
 *
 * POSIX never loads this module; `koffi` is imported only on first use.
 */

const GENERIC_READ_WRITE = 0xC0000000;
const OPEN_EXISTING = 3;
/** SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the server may identify this client, never act as it. */
const SQOS_IDENTIFICATION = 0x00100000 | 0x00010000;
const INVALID_HANDLE = -1;
const POLL_MS = 10;
const MAX_ANSWER_BYTES = 256 * 1024;

type Handle = number;
type Out = [number];
interface PipeBindings {
  createFile(name: string, access: number, share: number, security: null, disposition: number, flags: number, template: null): Handle;
  serverPid(pipe: Handle, pid: Out): number;
  write(file: Handle, data: Buffer, size: number, written: Out, overlapped: null): number;
  peek(pipe: Handle, buffer: null, size: number, read: null, available: Out, left: null): number;
  read(file: Handle, data: Buffer, size: number, read: Out, overlapped: null): number;
  close(handle: Handle): number;
}
interface KoffiModule {
  load(path: string): { func(convention: string, name: string, result: unknown, args: unknown[]): (...args: never[]) => unknown };
  out(type: unknown): unknown;
  pointer(type: string): unknown;
}

const cached = new Map<string, Promise<PipeBindings>>();

async function loadPipeBindings(nativeAssetRoot: string | undefined): Promise<PipeBindings> {
  const imported = nativeAssetRoot === undefined
    ? (await import('koffi')) as unknown as { default?: KoffiModule }
    : loadSdkKoffiAsset(nativeAssetRoot) as { default?: KoffiModule };
  const koffi = (imported.default ?? imported) as KoffiModule;
  const kernel32 = koffi.load('kernel32.dll');
  const dword = koffi.out(koffi.pointer('uint32_t'));
  const bind = (name: string, result: unknown, args: unknown[]): never => kernel32.func('__stdcall', name, result, args) as never;
  return {
    createFile: bind('CreateFileW', 'intptr_t', ['str16', 'uint32_t', 'uint32_t', 'void *', 'uint32_t', 'uint32_t', 'void *']),
    serverPid: bind('GetNamedPipeServerProcessId', 'int', ['intptr_t', dword]),
    write: bind('WriteFile', 'int', ['intptr_t', 'void *', 'uint32_t', dword, 'void *']),
    peek: bind('PeekNamedPipe', 'int', ['intptr_t', 'void *', 'uint32_t', 'void *', dword, 'void *']),
    read: bind('ReadFile', 'int', ['intptr_t', 'void *', 'uint32_t', dword, 'void *']),
    close: bind('CloseHandle', 'int', ['intptr_t']),
  };
}

function bindings(nativeAssetRoot: string | undefined): Promise<PipeBindings> {
  const key = nativeAssetRoot ?? '';
  let loading = cached.get(key);
  if (loading === undefined) {
    loading = loadPipeBindings(nativeAssetRoot);
    loading.catch(() => cached.delete(key));
    cached.set(key, loading);
  }
  return loading;
}

export interface HermesPipeAnswer {
  /** The pid of the process that serves the pipe, from the kernel. */
  readonly serverPid: number;
  /** The first answer line. Absent when nothing was written or no full line arrived by the deadline. */
  readonly line?: string;
}

/**
 * One request/answer exchange on the pipe `name`. Undefined: no server could
 * be opened. The request is written only when `owned(serverPid)` is true.
 */
export async function exchangeHermesPipe(
  name: string,
  request: string,
  owned: (serverPid: number) => boolean,
  deadline: number,
  nativeAssetRoot?: string,
): Promise<HermesPipeAnswer | undefined> {
  const api = await bindings(nativeAssetRoot);
  const pipe = api.createFile(name, GENERIC_READ_WRITE, 0, null, OPEN_EXISTING, SQOS_IDENTIFICATION, null);
  if (pipe === INVALID_HANDLE || pipe === 0) return undefined;
  try {
    const pid: Out = [0];
    if (api.serverPid(pipe, pid) === 0) return undefined;
    const serverPid = pid[0];
    if (!owned(serverPid)) return { serverPid };
    const bytes = Buffer.from(request, 'utf8');
    const written: Out = [0];
    if (api.write(pipe, bytes, bytes.length, written, null) === 0 || written[0] !== bytes.length) return { serverPid };
    const chunks: Buffer[] = [];
    let size = 0;
    while (Date.now() < deadline && size <= MAX_ANSWER_BYTES) {
      const available: Out = [0];
      // Fails once the server has closed its end.
      if (api.peek(pipe, null, 0, null, available, null) === 0) break;
      if (available[0] === 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      const chunk = Buffer.alloc(available[0]);
      const read: Out = [0];
      if (api.read(pipe, chunk, chunk.length, read, null) === 0) break;
      chunks.push(chunk.subarray(0, read[0]));
      size += read[0];
      const text = Buffer.concat(chunks).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline !== -1) return { serverPid, line: text.slice(0, newline) };
    }
    return { serverPid };
  } finally {
    api.close(pipe);
  }
}

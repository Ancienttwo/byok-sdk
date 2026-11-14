import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

import type { AgentHomeLease } from '../agent-home.js';
import type { AgentMemoryHelperIdentity } from './agent-memory-fs-helper.js';
import { verifyAgentMemoryFilesystemHelper } from '../util/agent-memory-helper-release.js';
import { agentMemoryHelperTimeout, isAgentMemoryHelperTimeout, agentMemoryHelperCancellation, isAgentMemoryHelperCancellation, HELPER_PROBE_TIMEOUT_MS } from './agent-memory-helper-probe.js';
import { AgentMemoryIoError, AgentMemoryRevisionConflictError } from './agent-memory.js';
import type { AgentMemoryFileObservation, AgentMemoryFilesystem, AgentMemoryFilesystemFileState, AgentMemoryRestoreCleanup, AgentMemoryRestoreRecord, AgentMemoryWalk, AgentMemoryWalkEntry } from './agent-memory-filesystem.js';
import { AgentMemoryError } from '@byok-sdk/protocol/agent-memory';

export const AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL = 4;
export const AGENT_MEMORY_FILESYSTEM_HELPER_VERSION = '4';
const HELPER_REQUEST_TIMEOUT_MS = 10_000;
const HELPER_MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const HELPER_MAX_CONTENT_BYTES = 1 * 1024 * 1024;
const HELPER_MAX_STDERR_BYTES = 4 * 1024;
/** The helper's codes that say an operation did not complete, as opposed to refusing what it found. */
const HELPER_IO_FAILURE_CODES: ReadonlySet<string> = new Set(['io_failure', 'file_changed']);

interface HelperSuccess {
  readonly id: string;
  readonly ok: true;
  readonly protocol: typeof AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL;
  readonly result: Record<string, unknown>;
}
interface HelperFailure {
  readonly id: string;
  readonly ok: false;
  readonly protocol: typeof AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL;
  readonly error: { readonly code: string; readonly message: string; readonly actualRevision?: string };
}
type HelperResponse = HelperSuccess | HelperFailure;
type Pending = { readonly resolve: (response: HelperSuccess) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout };
class HelperRevisionConflict extends Error {
  constructor(readonly actualRevision: string) { super('helper revision conflict'); }
}

function safeHelperPath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000\r\n]/u.test(value)) {
    throw new AgentMemoryError('Agent memory filesystem helper must be an explicit absolute executable path');
  }
  return path.resolve(value);
}

function helperPlatformSupported(): boolean {
  // Linux retains its existing native descriptor backend. The external process
  // authority is admitted for macOS and for Windows x64, which has an SDK
  // release target. Windows has no OS-crash or power-loss proof, so its intent
  // backend does not claim the strict barrier and intents stay unadvertised.
  return process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64');
}

export function isAgentMemoryFilesystemHelperSupported(): boolean {
  return helperPlatformSupported();
}

function unsigned(value: bigint, bits: 32 | 64): string {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << BigInt(bits))) {
    throw new AgentMemoryError('Agent memory filesystem helper root identity is invalid');
  }
  return value.toString(10);
}

/** Serialization is not platform admission or a durability proof. */
export function agentMemoryHelperIdentity(home: AgentHomeLease['homeIdentity'], platform: NodeJS.Platform): AgentMemoryHelperIdentity {
  if (platform === 'win32') {
    return Object.freeze({ kind: 'windows', volumeSerial: unsigned(home.dev, 32), fileIndex: unsigned(home.ino, 64) });
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new AgentMemoryError('Agent memory filesystem helper identity is not supported on this platform');
  }
  return Object.freeze({ kind: 'unix', dev: unsigned(home.dev, 64), ino: unsigned(home.ino, 64) });
}

export function agentMemoryHelperIdentityMatches(value: unknown, expected: AgentMemoryHelperIdentity): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const entries = Object.entries(expected);
  return Object.keys(actual).length === entries.length && entries.every(([key, entry]) => actual[key] === entry);
}

function responseRecord(value: unknown): HelperResponse | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.protocol !== AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL || typeof record.ok !== 'boolean') return undefined;
  if (record.ok) {
    if (record.result === null || typeof record.result !== 'object' || Array.isArray(record.result)) return undefined;
    // SAFETY: the checks above validate every success field, including the result object.
    return record as unknown as HelperSuccess;
  }
  if (record.error === null || typeof record.error !== 'object' || Array.isArray(record.error)) return undefined;
  const error = record.error as Record<string, unknown>;
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || (error.actualRevision !== undefined && typeof error.actualRevision !== 'string')) return undefined;
  // SAFETY: the checks above validate the failure envelope and every error field.
  return record as unknown as HelperFailure;
}

function walkEntry(value: unknown): value is AgentMemoryWalkEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string' && (entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'opaque-directory' || entry.kind === 'other');
}

function boundedFileState(result: Record<string, unknown>, maxBytes: number): AgentMemoryFilesystemFileState {
  let content: string;
  try {
    if (typeof result.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}|[A-Za-z0-9+/]{3})?$/u.test(result.contentBase64)) {
      throw new Error('invalid base64');
    }
    content = Buffer.from(result.contentBase64, 'base64').toString('utf8');
  } catch {
    throw new AgentMemoryError('Agent memory filesystem helper returned an invalid file state');
  }
  if (
    typeof result.exists !== 'boolean' ||
    typeof result.revision !== 'string' ||
    typeof result.byteCount !== 'number' ||
    !Number.isSafeInteger(result.byteCount) ||
    result.byteCount < 0 ||
    result.byteCount > maxBytes ||
    Buffer.byteLength(content, 'utf8') !== result.byteCount ||
    !/^sha256:[a-f0-9]{64}$/u.test(result.revision)
  ) {
    throw new AgentMemoryError('Agent memory filesystem helper returned an invalid file state');
  }
  return Object.freeze({ exists: result.exists, content, revision: result.revision, byteCount: result.byteCount });
}

function encodeReplaceContent(content: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > HELPER_MAX_CONTENT_BYTES) {
    throw new AgentMemoryError('Agent memory filesystem helper requested an invalid byte limit');
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > maxBytes) {
    throw new AgentMemoryError('Agent memory filesystem helper replacement exceeds its requested byte limit');
  }
  // The private protocol intentionally uses unpadded standard base64. It
  // keeps arbitrary UTF-8 bytes below the bounded JSON-lines transport limit.
  return bytes.toString('base64').replace(/=+$/u, '');
}

type RootBarrier = { promise: Promise<void>; controller: AbortController; waiters: number; settled: boolean };
const rootBarriers = new Map<string, RootBarrier>();
const ROOT_BARRIER_CAUSES: ReadonlySet<string> = new Set([
  'root_barrier_invalid_input', 'root_barrier_noncanonical', 'root_barrier_unsupported',
  'root_barrier_open_failed', 'root_barrier_metadata_failed', 'root_barrier_volume_failed',
  'root_barrier_sync_failed', 'root_barrier_close_failed', 'root_barrier_changed',
  'root_barrier_process_failed',
]);

function helperCancelled(): Error {
  return agentMemoryHelperCancellation(new AgentMemoryIoError('Agent memory filesystem helper probe cancelled'));
}

function startRootBarrier(helperBin: string, root: string): RootBarrier {
  const controller = new AbortController();
  const entry: RootBarrier = { controller, waiters: 0, settled: false, promise: (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(helperBin, ['root-barrier'], {
          shell: false, windowsHide: true, env: Object.freeze({}),
          timeout: HELPER_PROBE_TIMEOUT_MS, signal: controller.signal, killSignal: 'SIGKILL', maxBuffer: HELPER_MAX_STDERR_BYTES,
        }, (error, _stdout, stderr) => {
          if (controller.signal.aborted) reject(helperCancelled());
          else if (error?.killed && !stderr.trim()) reject(agentMemoryHelperTimeout(new AgentMemoryIoError('Agent memory hostStorageRoot probe timed out')));
          else if (error) reject(stderr.trim()); else resolve();
        });
        child.stdin!.on('error', () => reject('root_barrier_process_failed'));
        child.stdin!.end(JSON.stringify({ root }));
      });
    } catch (cause) {
      if (isAgentMemoryHelperTimeout(cause) || isAgentMemoryHelperCancellation(cause)) throw cause;
      const code = typeof cause === 'string' && ROOT_BARRIER_CAUSES.has(cause) ? cause : 'root_barrier_process_failed';
      throw Object.assign(new AgentMemoryIoError(`Agent memory hostStorageRoot durability barrier failed (${code}); helper open refused`), { cause: code });
    }
  })().catch(error => {
    if (rootBarriers.get(root) === entry) rootBarriers.delete(root);
    throw error;
  }).finally(() => { entry.settled = true; }) };
  return entry;
}

async function initializeHostStorageRoot(helperBin: string, root: string, timeout: number, signal?: AbortSignal): Promise<void> {
  if (process.platform === 'win32') return;
  if (signal?.aborted) throw helperCancelled();
  let entry = rootBarriers.get(root);
  if (entry === undefined) {
    entry = startRootBarrier(helperBin, root);
    rootBarriers.set(root, entry);
  }
  entry.waiters++;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error === undefined) resolve(); else reject(error);
      };
      const abort = () => finish(helperCancelled());
      const timer = setTimeout(() => finish(agentMemoryHelperTimeout(new AgentMemoryIoError('Agent memory hostStorageRoot probe timed out'))), timeout);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      entry!.promise.then(() => finish(), error => finish(error));
      if (signal?.aborted) abort();
    });
  } finally {
    entry.waiters--;
    // A caller owns only its wait. The shared process ends when its last waiter
    // leaves, or its own 60 s deadline expires. Successful barriers stay cached.
    if (entry.waiters === 0 && !entry.settled) {
      if (rootBarriers.get(root) === entry) rootBarriers.delete(root);
      entry.controller.abort();
    }
  }
}

type HelperOpenOptions = Readonly<{ timeout?: number; signal?: AbortSignal }>;
type ProbeLifetime = Readonly<{ deadline: number; signal?: AbortSignal }>;

class AgentMemoryFilesystemHelperClient implements AgentMemoryFilesystem {
  private readonly pending = new Map<string, Pending>();
  private stdoutBuffer = Buffer.alloc(0);
  private sequence = 0;
  private stderrBytes = 0;
  private closed = false;
  private fatalError: Error | undefined;
  private readonly exited: Promise<void>;
  private closing: Promise<void> | undefined;

  private readonly abort = () => this.fail(helperCancelled(), 'SIGKILL');

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly probe?: ProbeLifetime) {
    this.exited = new Promise(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    child.stdout.on('data', (chunk: Buffer | string) => this.handleStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      if (this.stderrBytes > HELPER_MAX_STDERR_BYTES) this.fail(new AgentMemoryError('Agent memory filesystem helper exceeded bounded stderr'));
    });
    child.stdin.on('error', () => this.fail(new AgentMemoryError('Agent memory filesystem helper request could not be written')));
    child.once('error', () => this.fail(new AgentMemoryError('Agent memory filesystem helper could not be started')));
    child.once('exit', (code, signal) => {
      if (!this.closed || code !== 0) this.fail(new AgentMemoryIoError(`Agent memory filesystem helper exited unexpectedly (${code ?? signal ?? 'unknown'})`));
    });
    probe?.signal?.addEventListener('abort', this.abort, { once: true });
    if (probe?.signal?.aborted) this.abort();
  }

  static async open(input: Readonly<{ helperBin: string; assetRoot?: string | undefined; canonicalHome: string; ancestorRoot: string; homeIdentity: AgentHomeLease['homeIdentity'] }>, options: HelperOpenOptions): Promise<AgentMemoryFilesystemHelperClient> {
    if (!helperPlatformSupported()) throw new AgentMemoryError('Agent memory filesystem helper is not admitted on this platform');
    if (typeof input.ancestorRoot !== 'string' || !path.isAbsolute(input.ancestorRoot) || /[\u0000\r\n]/u.test(input.ancestorRoot)) {
      throw new AgentMemoryError('Agent memory filesystem helper requires an explicit absolute ancestor root');
    }
    const helperBin = verifyAgentMemoryFilesystemHelper(safeHelperPath(input.helperBin), input.assetRoot);
    const expected = agentMemoryHelperIdentity(input.homeIdentity, process.platform);
    const probe = options.timeout === undefined ? undefined : { deadline: performance.now() + options.timeout, ...(options.signal === undefined ? {} : { signal: options.signal }) };
    const signal = options.signal;
    const budget = probe === undefined ? HELPER_REQUEST_TIMEOUT_MS : Math.max(1, Math.ceil(probe.deadline - performance.now()));
    await initializeHostStorageRoot(helperBin, input.ancestorRoot, budget, signal);
    signal?.throwIfAborted();
    const child = spawn(helperBin, ['serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: Object.freeze({}),
    });
    const client = new AgentMemoryFilesystemHelperClient(child, probe);
    try {
      signal?.throwIfAborted();
      const result = await client.requestInternal('open', {
        root: path.resolve(input.canonicalHome),
        ancestorRoot: input.ancestorRoot,
        expectedIdentity: expected,
      }, probe === undefined ? HELPER_REQUEST_TIMEOUT_MS : Math.max(1, probe.deadline - performance.now()));
      if (result.helperVersion !== AGENT_MEMORY_FILESYSTEM_HELPER_VERSION) throw new AgentMemoryError('Agent memory filesystem helper version mismatch');
      if (!agentMemoryHelperIdentityMatches(result.identity, expected)) throw new AgentMemoryError('Agent memory filesystem helper root identity mismatch');
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async read(relativePath: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    return boundedFileState(await this.request('read', { path: relativePath, maxBytes }), maxBytes);
  }

  async replace(relativePath: string, expectedRevision: string, content: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState> {
    try {
      const contentBase64 = encodeReplaceContent(content, maxBytes);
      return boundedFileState(await this.request('replace', { path: relativePath, expectedRevision, contentBase64, maxBytes }), maxBytes);
    } catch (error) {
      if (error instanceof HelperRevisionConflict) throw new AgentMemoryRevisionConflictError(expectedRevision, error.actualRevision);
      throw error;
    }
  }

  async delete(relativePath: string, expectedRevision: string): Promise<void> {
    try {
      await this.request('delete', { path: relativePath, expectedRevision });
    } catch (error) {
      if (error instanceof HelperRevisionConflict) throw new AgentMemoryRevisionConflictError(expectedRevision, error.actualRevision);
      throw error;
    }
  }

  async observe(relativePath: string): Promise<AgentMemoryFileObservation> {
    const result = await this.request('observe', { path: relativePath });
    if (typeof result.exists !== 'boolean' || typeof result.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(result.revision)) {
      throw new AgentMemoryError('Agent memory filesystem helper returned an invalid observation');
    }
    return Object.freeze({ exists: result.exists, revision: result.revision });
  }

  async cleanupForRestore(record: AgentMemoryRestoreRecord): Promise<AgentMemoryRestoreCleanup> {
    const result = await this.request('cleanup', { files: record.files, entries: record.entries });
    if (typeof result.deleted !== 'number' || !Number.isSafeInteger(result.deleted) || result.deleted < 0) {
      throw new AgentMemoryError('Agent memory filesystem helper returned an invalid cleanup result');
    }
    return Object.freeze({ deleted: result.deleted });
  }

  async append(relativePath: string, content: string, maxBytes: number): Promise<void> {
    await this.request('append', { path: relativePath, content, maxBytes });
  }

  async walk(relativePath: string, maxEntries: number): Promise<AgentMemoryWalk> {
    const result = await this.request('walk', { path: relativePath, maxEntries });
    if (
      !Array.isArray(result.paths) || result.paths.length > maxEntries || result.paths.some((candidate) => typeof candidate !== 'string') ||
      !Array.isArray(result.entries) || result.entries.length > maxEntries || !result.entries.every(walkEntry)
    ) {
      throw new AgentMemoryError('Agent memory filesystem helper returned an invalid walk result');
    }
    return Object.freeze({ paths: Object.freeze([...result.paths] as string[]), entries: Object.freeze(result.entries.map((entry: AgentMemoryWalkEntry) => Object.freeze({ path: entry.path, kind: entry.kind }))) });
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = this.closeAndWait();
    return this.closing;
  }

  private async closeAndWait(): Promise<void> {
    try {
      if (this.child.exitCode === null && this.child.signalCode === null && this.fatalError === undefined) await this.requestInternal('close', {}, this.probe === undefined ? HELPER_REQUEST_TIMEOUT_MS : Math.max(1, this.probe.deadline - performance.now()));
    } finally {
      this.child.stdin.end();
      if (this.child.exitCode === null && this.child.signalCode === null) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([this.exited, new Promise<void>(resolve => {
            timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1_000);
          })]);
          await this.exited;
        } finally { if (timer !== undefined) clearTimeout(timer); }
      }
      this.rejectPending(new AgentMemoryError('Agent memory filesystem helper is closed'));
      this.probe?.signal?.removeEventListener('abort', this.abort);
    }
  }

  private request(op: string, fields: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new AgentMemoryError('Agent memory filesystem helper is closed'));
    return this.requestInternal(op, fields);
  }

  private requestInternal(op: string, fields: Readonly<Record<string, unknown>>, timeout = HELPER_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    const id = `m${++this.sequence}`;
    let line: string;
    try {
      line = `${JSON.stringify({ id, protocol: AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL, op, ...fields })}\n`;
    } catch {
      return Promise.reject(new AgentMemoryError('Agent memory filesystem helper request could not be encoded'));
    }
    if (Buffer.byteLength(line, 'utf8') > HELPER_MAX_JSON_LINE_BYTES) {
      return Promise.reject(new AgentMemoryError('Agent memory filesystem helper request exceeded bounded stdin'));
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = agentMemoryHelperTimeout(new AgentMemoryIoError('Agent memory filesystem helper request timed out'));
        reject(error);
        this.fail(error, this.probe === undefined ? 'SIGTERM' : 'SIGKILL');
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve: (response) => resolve(response.result), reject, timer });
      this.child.stdin.write(line, (error) => {
        if (!error) return;
        const item = this.pending.get(id);
        if (item === undefined) return;
        clearTimeout(item.timer);
        this.pending.delete(id);
        item.reject(new AgentMemoryError('Agent memory filesystem helper request could not be written'));
      });
    });
  }

  private handleStdoutChunk(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && this.fatalError === undefined) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (this.stdoutBuffer.length + segment.length > HELPER_MAX_JSON_LINE_BYTES) {
        this.fail(new AgentMemoryError('Agent memory filesystem helper exceeded bounded stdout'));
        return;
      }
      this.stdoutBuffer = this.stdoutBuffer.length === 0 ? Buffer.from(segment) : Buffer.concat([this.stdoutBuffer, segment]);
      if (newline === -1) return;
      const line = this.stdoutBuffer;
      this.stdoutBuffer = Buffer.alloc(0);
      this.handleLine(line);
      offset = newline + 1;
    }
  }

  private handleLine(line: Buffer): void {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { this.fail(new AgentMemoryError('Agent memory filesystem helper returned malformed JSON')); return; }
    const response = responseRecord(parsed);
    if (response === undefined) { this.fail(new AgentMemoryError('Agent memory filesystem helper returned an invalid response')); return; }
    const item = this.pending.get(response.id);
    if (item === undefined) { this.fail(new AgentMemoryError('Agent memory filesystem helper returned an unsolicited response')); return; }
    clearTimeout(item.timer);
    this.pending.delete(response.id);
    if (response.ok) { item.resolve(response); return; }
    if (response.error.code === 'revision_conflict' && typeof response.error.actualRevision === 'string') {
      item.reject(new HelperRevisionConflict(response.error.actualRevision));
      return;
    }
    const instruction = response.error.code === 'ancestor_volume_mismatch' ? '. Put the agents directory on the same volume as hostStorageRoot.' : '';
    const rejected = `Agent memory filesystem helper rejected the operation: ${response.error.code}${instruction}`;
    item.reject(HELPER_IO_FAILURE_CODES.has(response.error.code) ? new AgentMemoryIoError(rejected) : new AgentMemoryError(rejected));
  }

  private fail(error: Error, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.fatalError !== undefined) return;
    this.fatalError = error;
    this.rejectPending(error);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}

export async function openAgentMemoryFilesystemHelperWithBudget(input: Readonly<{ helperBin: string; assetRoot?: string | undefined; canonicalHome: string; ancestorRoot: string; homeIdentity: AgentHomeLease['homeIdentity'] }>, options: HelperOpenOptions = {}): Promise<AgentMemoryFilesystem> {
  return AgentMemoryFilesystemHelperClient.open(input, options);
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

import type { AgentHomeLease } from '../agent-home';
import { AgentMemoryError, AgentMemoryRevisionConflictError } from './agent-memory';
import type { AgentMemoryFilesystem, AgentMemoryFilesystemFileState } from './agent-memory-filesystem';

export const AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL = 1;
export const AGENT_MEMORY_FILESYSTEM_HELPER_VERSION = '1';
const HELPER_REQUEST_TIMEOUT_MS = 10_000;
const HELPER_MAX_STDOUT_LINE_BYTES = 24 * 1024 * 1024;
const HELPER_MAX_STDERR_BYTES = 4 * 1024;

interface HelperSuccess {
  readonly id: string;
  readonly ok: true;
  readonly protocol: 1;
  readonly result: Record<string, unknown>;
}
interface HelperFailure {
  readonly id: string;
  readonly ok: false;
  readonly protocol: 1;
  readonly error: { readonly code: string; readonly message: string; readonly actualRevision?: string };
}
type HelperResponse = HelperSuccess | HelperFailure;
type Pending = { readonly resolve: (response: HelperSuccess) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout };
class HelperRevisionConflict extends Error {
  constructor(readonly actualRevision: string) { super('helper revision conflict'); }
}

function safeHelperPath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new AgentMemoryError('Agent memory filesystem helper must be an explicit absolute executable path');
  }
  return path.resolve(value);
}

function helperPlatformSupported(): boolean {
  // Windows remains closed until the native reparse/junction matrix is run on
  // a real Windows host. Linux retains its existing native descriptor backend;
  // the external process authority is admitted only for the proven macOS gap.
  return process.platform === 'darwin';
}

export function isAgentMemoryFilesystemHelperSupported(): boolean {
  return helperPlatformSupported();
}

function unixIdentity(homeIdentity: AgentHomeLease['homeIdentity']): Readonly<Record<string, string>> {
  return Object.freeze({ kind: 'unix', dev: homeIdentity.dev.toString(10), ino: homeIdentity.ino.toString(10) });
}

function responseRecord(value: unknown): HelperResponse | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.protocol !== AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL || typeof record.ok !== 'boolean') return undefined;
  if (record.ok) {
    if (record.result === null || typeof record.result !== 'object' || Array.isArray(record.result)) return undefined;
    return record as unknown as HelperSuccess;
  }
  if (record.error === null || typeof record.error !== 'object' || Array.isArray(record.error)) return undefined;
  const error = record.error as Record<string, unknown>;
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || (error.actualRevision !== undefined && typeof error.actualRevision !== 'string')) return undefined;
  return record as unknown as HelperFailure;
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

class AgentMemoryFilesystemHelperClient implements AgentMemoryFilesystem {
  private readonly pending = new Map<string, Pending>();
  private stdoutBuffer = Buffer.alloc(0);
  private sequence = 0;
  private stderrBytes = 0;
  private closed = false;
  private fatalError: Error | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer | string) => this.handleStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      if (this.stderrBytes > HELPER_MAX_STDERR_BYTES) this.fail(new AgentMemoryError('Agent memory filesystem helper exceeded bounded stderr'));
    });
    child.stdin.on('error', () => this.fail(new AgentMemoryError('Agent memory filesystem helper request could not be written')));
    child.once('error', () => this.fail(new AgentMemoryError('Agent memory filesystem helper could not be started')));
    child.once('exit', (code, signal) => {
      if (!this.closed || code !== 0) this.fail(new AgentMemoryError(`Agent memory filesystem helper exited unexpectedly (${code ?? signal ?? 'unknown'})`));
    });
  }

  static async open(input: Readonly<{ helperBin: string; canonicalHome: string; homeIdentity: AgentHomeLease['homeIdentity'] }>): Promise<AgentMemoryFilesystemHelperClient> {
    if (!helperPlatformSupported()) throw new AgentMemoryError('Agent memory filesystem helper is not admitted on this platform');
    const helperBin = safeHelperPath(input.helperBin);
    const child = spawn(helperBin, ['serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: Object.freeze({}),
    });
    const client = new AgentMemoryFilesystemHelperClient(child);
    try {
      const result = await client.request('open', {
        root: path.resolve(input.canonicalHome),
        expectedIdentity: unixIdentity(input.homeIdentity),
      });
      if (result.helperVersion !== AGENT_MEMORY_FILESYSTEM_HELPER_VERSION) throw new AgentMemoryError('Agent memory filesystem helper version mismatch');
      const identity = result.identity;
      if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) throw new AgentMemoryError('Agent memory filesystem helper omitted root identity');
      const actual = identity as Record<string, unknown>;
      const expected = unixIdentity(input.homeIdentity);
      if (actual.kind !== expected.kind || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new AgentMemoryError('Agent memory filesystem helper root identity mismatch');
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
      return boundedFileState(await this.request('replace', { path: relativePath, expectedRevision, content, maxBytes }), maxBytes);
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

  async append(relativePath: string, content: string, maxBytes: number): Promise<void> {
    await this.request('append', { path: relativePath, content, maxBytes });
  }

  async walk(relativePath: string, maxEntries: number): Promise<readonly string[]> {
    const result = await this.request('walk', { path: relativePath, maxEntries });
    if (!Array.isArray(result.paths) || result.paths.length > maxEntries || result.paths.some((candidate) => typeof candidate !== 'string')) {
      throw new AgentMemoryError('Agent memory filesystem helper returned an invalid walk result');
    }
    return Object.freeze([...result.paths] as string[]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.child.exitCode === null && this.child.signalCode === null && this.fatalError === undefined) await this.requestWhileClosing('close', {});
    } finally {
      this.child.stdin.end();
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
      this.rejectPending(new AgentMemoryError('Agent memory filesystem helper is closed'));
    }
  }

  private request(op: string, fields: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new AgentMemoryError('Agent memory filesystem helper is closed'));
    return this.requestInternal(op, fields);
  }

  private requestWhileClosing(op: string, fields: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.requestInternal(op, fields);
  }

  private requestInternal(op: string, fields: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    const id = `m${++this.sequence}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new AgentMemoryError('Agent memory filesystem helper request timed out');
        reject(error);
        this.fail(error);
      }, HELPER_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve: (response) => resolve(response.result), reject, timer });
      const line = `${JSON.stringify({ id, protocol: AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL, op, ...fields })}\n`;
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
      if (this.stdoutBuffer.length + segment.length > HELPER_MAX_STDOUT_LINE_BYTES) {
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
    item.reject(new AgentMemoryError(`Agent memory filesystem helper rejected the operation: ${response.error.code}`));
  }

  private fail(error: Error): void {
    if (this.fatalError !== undefined) return;
    this.fatalError = error;
    this.rejectPending(error);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}

export async function openAgentMemoryFilesystemHelper(input: Readonly<{ helperBin: string; canonicalHome: string; homeIdentity: AgentHomeLease['homeIdentity'] }>): Promise<AgentMemoryFilesystem> {
  return AgentMemoryFilesystemHelperClient.open(input);
}

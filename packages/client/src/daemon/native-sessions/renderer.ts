import path from 'node:path';
import { parseSessionEntries, sessionFileName, type AgentSessionHandoff } from '../agent-session-handoff-store';
import { isAgentSessionLedgerName, piSessionRefFromFileName } from '../retention/session-ledgers';
import { argumentSummary, redactSummary } from './summary';

const RECORD_BYTES = 256 * 1024;
const TAIL_BYTES = 8 * 1024 * 1024;
const READ_BYTES = 32 * 1024 * 1024;
const OUTPUT_BYTES = 64 * 1024;
const MAX_CALLS = 2000;

export interface NativeSessionFile {
  readonly size: number;
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Read-only IO; implementations must honor the signal and never create missing paths. */
export interface NativeSessionsIO {
  lstat(file: string, signal: AbortSignal): Promise<{ readonly kind: 'directory' | 'file' | 'symlink' | 'other' }>;
  realpath(file: string, signal: AbortSignal): Promise<string>;
  list(directory: string, signal: AbortSignal): AsyncIterable<string>;
  open(file: string, signal: AbortSignal): Promise<NativeSessionFile>;
}

type Detail = 'aborted' | 'deadline' | 'ledger_limit' | 'read_limit' | 'session_directory'
  | 'ledger_unreadable' | 'session_unreadable' | 'secret_detected';

export class NativeSessionsUnavailableError extends Error {
  readonly retryable = false;
  constructor(readonly detail: Detail) {
    super(`native_sessions_unavailable: ${detail}`);
    this.name = 'NativeSessionsUnavailableError';
  }
}

export interface NativeSessionsInput {
  readonly home: string;
  readonly sessionDir: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly signal: AbortSignal;
  /** Absolute startup deadline in epoch milliseconds; rendering also has its own 10 s cap. */
  readonly deadlineMs: number;
  readonly io: NativeSessionsIO;
}

interface Projection { tool: string; arguments?: Record<string, string>; result: 'ok' | 'error' | 'none' }
interface Call { at: number; order: number; id: string; projection: Projection; bytes: number }
export interface NativeSessionsCounts {
  ledgers: number; files: number; skippedFiles: number; skippedRecords: number;
  calls: number; omittedCalls: number; bytesRead: number;
  skippedFilesByReason: Partial<Record<SkipReason, number>>;
}
export interface NativeSessionsOutput { readonly jsonLine: string; readonly counts: Readonly<NativeSessionsCounts> }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const within = (directory: string, file: string): boolean => {
  const relative = path.relative(directory, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** A bounded, chronological candidate buffer; invalid files never publish their candidates. */
class Calls {
  readonly entries: Call[] = [];
  omitted = 0;
  private bytes = 0;
  add(call: Call): void {
    let low = 0, high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1, other = this.entries[mid]!;
      if (other.at < call.at || (other.at === call.at && other.order < call.order)) low = mid + 1;
      else high = mid;
    }
    this.entries.splice(low, 0, call);
    this.bytes += call.bytes;
    this.trim();
  }
  result(id: string, result: 'ok' | 'error'): void {
    const call = this.entries.find(candidate => candidate.id === id);
    if (!call) return;
    this.bytes -= call.bytes;
    call.projection.result = result;
    call.bytes = Buffer.byteLength(JSON.stringify(call.projection));
    this.bytes += call.bytes;
    this.trim();
  }
  trim(): void {
    const overhead = () => Buffer.byteLength(JSON.stringify({ calls: [], omittedCalls: this.omitted })) + Math.max(0, this.entries.length - 1);
    while (this.entries.length > MAX_CALLS || this.bytes + overhead() > OUTPUT_BYTES) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.bytes -= removed.bytes;
      this.omitted++;
    }
  }
}

type SkipReason = 'bad_line' | 'oversized_record' | 'unknown_version' | 'id_mismatch' | 'cwd_mismatch' | 'ledger_mismatch' | 'ambiguous_session' | 'session_missing';
class SkipFile extends Error {
  constructor(readonly reason: SkipReason = 'bad_line') { super(reason); }
}
const missing = (error: unknown): boolean => record(error) && error.code === 'ENOENT';

/** No writes, runtime launches, model calls or global cursor. All external reads are injected. */
export async function renderNativeSessions(input: NativeSessionsInput): Promise<NativeSessionsOutput> {
  if (input.signal.aborted) throw new NativeSessionsUnavailableError('aborted');
  const budgetMs = Math.min(10_000, input.deadlineMs - Date.now());
  if (!(budgetMs > 0)) throw new NativeSessionsUnavailableError('deadline');
  const controller = new AbortController();
  const abort = () => controller.abort(new NativeSessionsUnavailableError('aborted'));
  input.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new NativeSessionsUnavailableError('deadline')), budgetMs);
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([render(input, controller.signal, Date.now() + budgetMs), interrupted]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function render(input: NativeSessionsInput, signal: AbortSignal, deadlineMs: number): Promise<NativeSessionsOutput> {
  const counts: NativeSessionsCounts = { ledgers: 0, files: 0, skippedFiles: 0, skippedRecords: 0, calls: 0, omittedCalls: 0, bytesRead: 0, skippedFilesByReason: {} };
  const skipped = (error: SkipFile) => {
    counts.skippedFiles++;
    counts.skippedFilesByReason[error.reason] = (counts.skippedFilesByReason[error.reason] ?? 0) + 1;
  };
  const check = () => {
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= deadlineMs) throw new NativeSessionsUnavailableError('deadline');
  };
  async function io<T>(detail: Detail, action: () => Promise<T>): Promise<T> {
    check();
    try { const value = await action(); check(); return value; }
    catch (error) {
      check();
      if (detail === 'session_unreadable' && missing(error)) throw new SkipFile('session_missing');
      if (error instanceof NativeSessionsUnavailableError) throw error;
      throw new NativeSessionsUnavailableError(detail);
    }
  }
  async function read(file: NativeSessionFile, offset: number, length: number): Promise<Uint8Array> {
    check();
    const allowed = Math.min(length, READ_BYTES - counts.bytesRead);
    if (allowed <= 0) throw new NativeSessionsUnavailableError('read_limit');
    const bytes = await file.read(offset, allowed, signal);
    check();
    counts.bytesRead += bytes.byteLength;
    if (counts.bytesRead > READ_BYTES) throw new NativeSessionsUnavailableError('read_limit');
    return bytes;
  }
  async function* lines(file: NativeSessionFile, start: number, discardFirst: boolean, firstOnly = false): AsyncGenerator<string | undefined> {
    const pending = Buffer.allocUnsafe(RECORD_BYTES);
    let used = 0, discard = discardFirst;
    for (let offset = start; offset < file.size;) {
      const chunk = await read(file, offset, Math.min(4096, file.size - offset, firstOnly ? RECORD_BYTES - used + 1 : Infinity));
      if (chunk.length === 0) throw new SkipFile();
      offset += chunk.length;
      for (const byte of chunk) {
        if (byte === 10) {
          if (!discard) yield pending.subarray(0, used).toString('utf8');
          if (firstOnly) return;
          used = 0; discard = false;
        } else {
          if (used === RECORD_BYTES) { yield undefined; return; }
          if (!discard) pending[used] = byte;
          used++;
        }
      }
    }
    if (!discard && used > 0) yield pending.subarray(0, used).toString('utf8');
  }
  async function withFile<T>(filePath: string, root: string, detail: Detail, action: (file: NativeSessionFile) => Promise<T>): Promise<T> {
    const canonical = await io(detail, () => input.io.realpath(filePath, signal));
    if (!within(root, canonical)) throw new NativeSessionsUnavailableError(detail);
    let file: NativeSessionFile;
    try { file = await input.io.open(canonical, signal); }
    catch (error) {
      check();
      if (detail === 'session_unreadable' && missing(error)) throw new SkipFile('session_missing');
      throw new NativeSessionsUnavailableError(detail);
    }
    try { check(); return await action(file); }
    catch (error) {
      if (error instanceof SkipFile || error instanceof NativeSessionsUnavailableError) throw error;
      check(); throw new NativeSessionsUnavailableError(detail);
    } finally {
      // A handle delivered after cancellation still belongs to this reader.
      try { await file.close(); }
      catch { check(); throw new NativeSessionsUnavailableError(detail); }
    }
  }
  async function list(directory: string, detail: Detail, include: (name: string) => boolean): Promise<string[] | undefined> {
    const names: string[] = [];
    try {
      for await (const name of input.io.list(directory, signal)) {
        check();
        if (!include(name)) continue;
        names.push(name);
        if (detail === 'ledger_unreadable' && isAgentSessionLedgerName(name)) {
          if (++counts.ledgers > 512) throw new NativeSessionsUnavailableError('ledger_limit');
        }
      }
    } catch (error) {
      check(); if (error instanceof NativeSessionsUnavailableError) throw error;
      if (missing(error)) return undefined;
      throw new NativeSessionsUnavailableError(detail);
    }
    return names;
  }
  const home = await io('ledger_unreadable', () => input.io.realpath(input.home, signal));
  const empty = (): NativeSessionsOutput => ({ jsonLine: JSON.stringify({ calls: [], omittedCalls: 0 }), counts: Object.freeze(counts) });
  try {
    for (const directory of [path.join(home, '.byok'), path.join(home, '.byok/runtime-sessions')]) {
      check();
      if ((await input.io.lstat(directory, signal)).kind !== 'directory') throw new NativeSessionsUnavailableError('ledger_unreadable');
    }
  } catch (error) {
    check();
    if (missing(error)) return empty();
    throw new NativeSessionsUnavailableError('ledger_unreadable');
  }
  const ledgerDir = await io('ledger_unreadable', () => input.io.realpath(path.join(home, '.byok/runtime-sessions'), signal));
  if (!within(home, ledgerDir)) throw new NativeSessionsUnavailableError('ledger_unreadable');
  const ledgerNames = await list(ledgerDir, 'ledger_unreadable', isAgentSessionLedgerName);
  if (!ledgerNames) { counts.ledgers = 0; return empty(); }
  ledgerNames.sort();
  const ledgers: AgentSessionHandoff[] = [];
  const calls = new Calls();
  let order = 0;
  for (const name of ledgerNames) {
    check();
    try {
      const ledger = await withFile(path.join(ledgerDir, name), ledgerDir, 'ledger_unreadable', async file => {
        let latest: AgentSessionHandoff | undefined;
        const start = Math.max(0, file.size - TAIL_BYTES);
        for await (const line of lines(file, start, start > 0)) {
          if (line === undefined) { counts.skippedRecords++; throw new SkipFile('oversized_record'); }
          try {
            for (const entry of parseSessionEntries(line)) {
              if (sessionFileName(entry.runtimeId, entry.sessionRef) !== name) throw new SkipFile('ledger_mismatch');
              latest = entry;
            }
          } catch (error) { if (error instanceof SkipFile) throw error; throw new SkipFile(); }
        }
        if (!latest) throw new SkipFile();
        return latest;
      });
      if (ledger.runtimeId === 'pi') ledgers.push(ledger);
    } catch (error) {
      if (!(error instanceof SkipFile)) throw error;
      skipped(error);
    }
  }
  const wanted = new Set(ledgers.filter(ledger => !path.isAbsolute(ledger.sessionRef)).map(ledger => ledger.sessionRef));
  // Enumerate the directory even with no ledgers: an unusable sessionDir is a failure.
  // Keep at most two matches per wanted id; two suffice to reject ambiguity.
  const matched = new Map<string, number>();
  let sessionDir: string;
  try { check(); sessionDir = await input.io.realpath(input.sessionDir, signal); check(); }
  catch (error) {
    check();
    if (!missing(error)) throw new NativeSessionsUnavailableError('session_directory');
    for (const _ledger of ledgers) skipped(new SkipFile('session_missing'));
    return empty();
  }
  const sessionNames = await list(sessionDir, 'session_directory', name => {
    const id = piSessionRefFromFileName(name);
    if (!id || !wanted.has(id) || (matched.get(id) ?? 0) >= 2) return false;
    matched.set(id, (matched.get(id) ?? 0) + 1);
    return true;
  });
  if (!sessionNames) {
    for (const _ledger of ledgers) skipped(new SkipFile('session_missing'));
    return empty();
  }
  // Keep the ordinary daemon entry free of the Pi runtime until native input is read.
  const { CURRENT_SESSION_VERSION, SessionManager } = await io('session_unreadable', () => import('@earendil-works/pi-coding-agent'));
  for (const ledger of ledgers) {
    check();
    try {
      const id = path.isAbsolute(ledger.sessionRef) ? piSessionRefFromFileName(path.basename(ledger.sessionRef)) : ledger.sessionRef;
      const matches = path.isAbsolute(ledger.sessionRef) ? [ledger.sessionRef]
        : sessionNames.filter(candidate => piSessionRefFromFileName(candidate) === id).map(candidate => path.join(sessionDir, candidate));
      if (!id) throw new SkipFile('id_mismatch');
      if (matches.length > 1) throw new SkipFile('ambiguous_session');
      if (matches.length === 0) throw new SkipFile('session_missing');
      const local = await withFile(matches[0]!, sessionDir, 'session_unreadable', async file => {
        const validateHeader = (value: unknown): void => {
          if (!record(value) || value.type !== 'session') throw new SkipFile();
          if (value.version !== CURRENT_SESSION_VERSION) throw new SkipFile('unknown_version');
          if (value.id !== id) throw new SkipFile('id_mismatch');
          if (typeof value.cwd !== 'string' || value.cwd.length === 0 || SessionManager.inMemory(value.cwd).getCwd() !== ledger.cwd) throw new SkipFile('cwd_mismatch');
        };
        let foundHeader = false;
        for await (const line of lines(file, 0, false, true)) {
          if (line === undefined) { counts.skippedRecords++; throw new SkipFile('oversized_record'); }
          let value: unknown;
          try { value = JSON.parse(line); } catch { throw new SkipFile(); }
          validateHeader(value);
          foundHeader = true;
        }
        if (!foundHeader) throw new SkipFile();
        const buffer = new Calls();
        const start = Math.max(0, file.size - TAIL_BYTES);
        for await (const line of lines(file, start, start > 0)) {
          if (line === undefined) { counts.skippedRecords++; throw new SkipFile('oversized_record'); }
          if (!line.trim()) continue;
          let value: unknown;
          try { value = JSON.parse(line); } catch { throw new SkipFile(); }
          if (!record(value) || typeof value.type !== 'string') throw new SkipFile();
          if (value.type === 'session') validateHeader(value);
          if (value.type !== 'message') continue;
          if (!record(value.message) || typeof value.message.role !== 'string') throw new SkipFile();
          const message = value.message;
          if (message.role === 'toolResult') {
            if (typeof message.toolCallId !== 'string' || typeof message.isError !== 'boolean') throw new SkipFile();
            buffer.result(message.toolCallId, message.isError ? 'error' : 'ok');
          } else if (message.role === 'assistant') {
            if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp) || !Array.isArray(message.content)) throw new SkipFile();
            for (const part of message.content) {
              if (!record(part) || part.type !== 'toolCall') continue;
              if (typeof part.id !== 'string' || typeof part.name !== 'string' || !record(part.arguments)) throw new SkipFile();
              if (message.timestamp < input.window.fromMs || message.timestamp > input.window.toMs) continue;
              const summary = argumentSummary(part.name, part.arguments, home, ledger.cwd);
              const projection: Projection = { tool: part.name, ...(summary ? { arguments: summary } : {}), result: 'none' };
              buffer.add({ at: message.timestamp, order: order++, id: part.id, projection, bytes: Buffer.byteLength(JSON.stringify(projection)) });
            }
          }
        }
        return buffer;
      });
      counts.files++;
      calls.omitted += local.omitted;
      for (const call of local.entries) calls.add(call);
      calls.trim();
    } catch (error) {
      if (!(error instanceof SkipFile)) throw error;
      skipped(error);
    }
  }
  check();
  const jsonLine = JSON.stringify({ calls: calls.entries.map(call => call.projection), omittedCalls: calls.omitted });
  // Bash words are structurally allowlisted; only tool names and paths are scanned.
  const serialized = JSON.parse(jsonLine) as { calls: Projection[] };
  if (serialized.calls.some(call => [call.tool, call.arguments?.path ?? ''].some(text => redactSummary(text) !== text))) {
    throw new NativeSessionsUnavailableError('secret_detected');
  }
  counts.calls = calls.entries.length;
  counts.omittedCalls = calls.omitted;
  return { jsonLine, counts: Object.freeze(counts) };
}

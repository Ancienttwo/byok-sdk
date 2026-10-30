import { closeSync, fstatSync, mkdirSync, openSync, promises as fsp, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * The daemon log `byok-agent start --service` writes itself (#1097): its
 * record lines and diagnostics. Rotated by size; `maxFiles` counts the
 * active file and its rotated copies (`daemon.log.1` is the newest copy).
 */
export const DAEMON_LOG_FILENAME = 'daemon.log';
export const DAEMON_LOG_LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxFiles: 5 });

/**
 * The service manager's stdout/stderr redirect (launchd `StandardOutPath`,
 * systemd `append:`). Once {@link routeProcessOutputToDaemonLog} runs only a
 * fatal error Node writes to fd 2 itself still lands there, and each service
 * start rotates a file over this size to one `.1` copy. WinSW rolls its own redirect by the same limit
 * (`roll-by-size`).
 */
export const SERVICE_REDIRECT_STDOUT_FILENAME = 'service-stdout.log';
export const SERVICE_REDIRECT_STDERR_FILENAME = 'service-stderr.log';
export const SERVICE_REDIRECT_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, maxFiles: 2 });

export interface DaemonLogOptions {
  /** `resolveHostLayout(...).logDir`; created if missing. */
  logDir: string;
  maxBytes?: number;
  maxFiles?: number;
}

export interface DaemonLog {
  /** The active file. */
  readonly path: string;
  /** Appends one line (a trailing newline is added). Rotates first when the line would cross `maxBytes`. */
  write(line: string): void;
  close(): void;
}

function rotate(file: string, maxFiles: number): void {
  rmSync(`${file}.${maxFiles - 1}`, { force: true });
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    try { renameSync(`${file}.${index}`, `${file}.${index + 1}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (maxFiles > 1) renameSync(file, `${file}.1`);
  else rmSync(file, { force: true });
}

function limit(value: number | undefined, fallback: number, minimum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}`);
  return resolved;
}

function openRotatingFile(options: DaemonLogOptions): { path: string; append(bytes: Uint8Array): void; close(): void } {
  const maxBytes = limit(options.maxBytes, DAEMON_LOG_LIMITS.maxBytes, 1, 'maxBytes');
  const maxFiles = limit(options.maxFiles, DAEMON_LOG_LIMITS.maxFiles, 1, 'maxFiles');
  const file = path.join(options.logDir, DAEMON_LOG_FILENAME);
  mkdirSync(options.logDir, { recursive: true, mode: 0o700 });
  let fd = openSync(file, 'a', 0o600);
  let size = fstatSync(fd).size;
  return {
    path: file,
    append(bytes: Uint8Array): void {
      if (size > 0 && size + bytes.length > maxBytes) {
        closeSync(fd);
        rotate(file, maxFiles);
        fd = openSync(file, 'a', 0o600);
        size = 0;
      }
      writeSync(fd, bytes);
      size += bytes.length;
    },
    close(): void {
      closeSync(fd);
    },
  };
}

/**
 * Opens the daemon log in `logDir`. Writes are synchronous so lines keep
 * their order and survive a crash right after them. A single line longer
 * than `maxBytes` is still written whole, into a fresh file.
 */
export function openDaemonLog(options: DaemonLogOptions): DaemonLog {
  const file = openRotatingFile(options);
  return {
    path: file.path,
    write: (line: string): void => file.append(Buffer.from(`${line}\n`, 'utf8')),
    close: file.close,
  };
}

type StreamWrite = typeof process.stdout.write;

/**
 * Routes everything this process writes to `process.stdout` and
 * `process.stderr` (every `console.*` call included) into the daemon log
 * until `close()`, so no runtime path can grow the service manager's
 * redirect while the daemon runs (#1097). Only output Node writes to fd 2
 * itself, such as a fatal error, still reaches the redirect, once per
 * process; {@link boundServiceRedirectLogs} bounds it at the next start.
 * Child processes are spawned with piped stdio and never share fd 1 or 2.
 */
export function routeProcessOutputToDaemonLog(options: DaemonLogOptions): { readonly path: string; close(): void } {
  const file = openRotatingFile(options);
  const streams = [process.stdout, process.stderr] as const;
  const originals = streams.map((stream) => stream.write);
  const write = function (this: unknown, chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    const done = typeof encoding === 'function' ? encoding : callback;
    file.append(typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk);
    if (done) process.nextTick(done);
    return true;
  } as StreamWrite;
  for (const stream of streams) stream.write = write;
  return {
    path: file.path,
    close(): void {
      streams.forEach((stream, index) => { stream.write = originals[index]!; });
      file.close();
    },
  };
}

/**
 * Bounds the service manager's redirect files at service start: each file
 * over {@link SERVICE_REDIRECT_LIMITS}.maxBytes becomes its single `.1` copy.
 * The manager reopens the path on the next spawn.
 */
export function boundServiceRedirectLogs(logDir: string): void {
  for (const name of [SERVICE_REDIRECT_STDOUT_FILENAME, SERVICE_REDIRECT_STDERR_FILENAME]) {
    const file = path.join(logDir, name);
    let size: number;
    try { size = statSync(file).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (size > SERVICE_REDIRECT_LIMITS.maxBytes) rotate(file, SERVICE_REDIRECT_LIMITS.maxFiles);
  }
}

/** At most this many log files are listed; the rest only count toward `truncated`. */
const MAX_REPORTED_LOG_FILES = 32;

export interface ServiceLogReport {
  /** The inspected log directory. */
  dir: string;
  status: 'present' | 'missing' | 'unavailable';
  totalBytes: number;
  /** `daemon`: the daemon log and its rotated copies. `service-manager`: the launchd/systemd/WinSW redirect files. */
  files: Array<{ name: string; kind: 'daemon' | 'service-manager'; sizeBytes: number }>;
  truncated: boolean;
}

/** Location and size of every regular file in `logDir` (#1097: `status` and `doctor` report them). Read-only. */
export async function inspectServiceLogs(logDir: string): Promise<ServiceLogReport> {
  let names: string[];
  try {
    names = (await fsp.readdir(logDir)).sort();
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
    return { dir: logDir, status, totalBytes: 0, files: [], truncated: false };
  }
  const files: ServiceLogReport['files'] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const name of names) {
    if (!name.includes('.log')) continue;
    let stat;
    try { stat = await fsp.lstat(path.join(logDir, name)); }
    catch { continue; }
    if (!stat.isFile()) continue;
    totalBytes += stat.size;
    if (files.length >= MAX_REPORTED_LOG_FILES) { truncated = true; continue; }
    files.push({ name, kind: name.startsWith(DAEMON_LOG_FILENAME) ? 'daemon' : 'service-manager', sizeBytes: stat.size });
  }
  return { dir: logDir, status: 'present', totalBytes, files, truncated };
}

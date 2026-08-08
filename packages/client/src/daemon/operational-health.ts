import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir } from '../util/secure-dir';

export type OperationalHealthState = 'healthy' | 'degraded' | 'recovering';
export type OperationalFailureSource = 'reconnect' | 'upload' | 'maintenance' | 'lifecycle';

interface FailureEvent {
  at: string;
  source: OperationalFailureSource;
}

export interface OperationalCrashRecord {
  detectedAt: string;
  previousRunStartedAt: string;
}

interface RunMarker {
  id: string;
  startedAt: string;
  pid: number;
}

interface HealthFileV1 {
  version: 1;
  state: OperationalHealthState;
  failures: FailureEvent[];
  crashes: OperationalCrashRecord[];
  currentRun?: RunMarker;
}

export const OPERATIONAL_HEALTH_FILENAME = 'operational-health.json';
export const MAX_OPERATIONAL_HEALTH_FILE_BYTES = 1024 * 1024;

export type OperationalHealthFileInspection =
  | { status: 'missing' }
  | {
      status: 'valid';
      sizeBytes: number;
      state: OperationalHealthState;
      failureCount: number;
      crashCount: number;
      currentRunStartedAt?: string;
      lastCrashAt?: string;
    }
  | { status: 'corrupt'; sizeBytes: number; reason: string }
  | { status: 'unavailable'; sizeBytes?: number; reason: string };

export type OperationalHealthSnapshot =
  | {
      availability: 'available';
      state: OperationalHealthState;
      failureCount: number;
      windowMs: number;
      failureThreshold: number;
      crashCount: number;
      lastCrashAt?: string;
      currentRunStartedAt?: string;
    }
  | { availability: 'unavailable'; reason: string };

export interface OperationalHealthOptions {
  windowMs?: number;
  failureThreshold?: number;
  maxFailures?: number;
  maxCrashes?: number;
  clock?: () => Date;
  runId?: () => string;
  pid?: number;
}

export class OperationalHealthTracker {
  readonly #filePath: string;
  readonly #windowMs: number;
  readonly #failureThreshold: number;
  readonly #maxFailures: number;
  readonly #maxCrashes: number;
  readonly #clock: () => Date;
  readonly #runId: () => string;
  readonly #pid: number;
  #state: HealthFileV1 | undefined;
  #unavailableReason: string | undefined;
  #writeTail: Promise<void> = Promise.resolve();
  #started = false;

  constructor(storeDir: string, options: OperationalHealthOptions = {}) {
    this.#filePath = path.join(storeDir, OPERATIONAL_HEALTH_FILENAME);
    this.#windowMs = options.windowMs ?? 60_000;
    this.#failureThreshold = options.failureThreshold ?? 3;
    this.#maxFailures = options.maxFailures ?? 128;
    this.#maxCrashes = options.maxCrashes ?? 20;
    this.#clock = options.clock ?? (() => new Date());
    this.#runId = options.runId ?? randomUUID;
    this.#pid = options.pid ?? process.pid;
    if (!Number.isSafeInteger(this.#windowMs) || this.#windowMs <= 0) throw new Error('health windowMs must be positive');
    if (!Number.isSafeInteger(this.#failureThreshold) || this.#failureThreshold <= 0) throw new Error('health failureThreshold must be positive');
    if (!Number.isSafeInteger(this.#maxFailures) || this.#maxFailures <= 0) throw new Error('health maxFailures must be positive');
    if (!Number.isSafeInteger(this.#maxCrashes) || this.#maxCrashes <= 0) throw new Error('health maxCrashes must be positive');
    if (this.#maxFailures < this.#failureThreshold) throw new Error('health maxFailures must cover failureThreshold');
  }

  async startRun(): Promise<OperationalHealthSnapshot> {
    if (this.#started) return this.snapshot();
    this.#started = true;
    const now = this.#clock();
    let loaded: HealthFileV1;
    try {
      loaded = await this.#load();
    } catch (err) {
      this.#unavailableReason = err instanceof Error ? err.message : String(err);
      return this.snapshot();
    }
    this.#state = loaded;
    this.#prune(now);
    // The load boundary enforces the same bounded-history invariant as the
    // writer. A shape-valid file produced by an older/manual writer must not
    // bypass the configured memory/disk bound simply because no new event is
    // appended during this run.
    loaded.failures = loaded.failures.slice(-this.#maxFailures);
    loaded.crashes = loaded.crashes.slice(-this.#maxCrashes);
    if (loaded.failures.length >= this.#failureThreshold) loaded.state = 'degraded';
    if (loaded.currentRun) {
      loaded.crashes.push({ detectedAt: now.toISOString(), previousRunStartedAt: loaded.currentRun.startedAt });
      loaded.crashes = loaded.crashes.slice(-this.#maxCrashes);
    }
    loaded.currentRun = { id: this.#runId(), startedAt: now.toISOString(), pid: this.#pid };
    await this.#persist();
    return this.snapshot();
  }

  async recordFailure(source: OperationalFailureSource): Promise<void> {
    if (!this.#state || this.#unavailableReason) return;
    const now = this.#clock();
    this.#prune(now);
    this.#state.failures.push({ at: now.toISOString(), source });
    this.#state.failures = this.#state.failures.slice(-this.#maxFailures);
    if (this.#state.failures.length >= this.#failureThreshold || this.#state.state === 'recovering') {
      this.#state.state = 'degraded';
    }
    await this.#persist();
  }

  async recordSuccess(_source: OperationalFailureSource): Promise<void> {
    if (!this.#state || this.#unavailableReason) return;
    const now = this.#clock();
    this.#prune(now);
    if (this.#state.state === 'healthy') return;
    if (this.#state.state === 'degraded') {
      this.#state.state = 'recovering';
    } else if (this.#state.state === 'recovering' && this.#state.failures.length < this.#failureThreshold) {
      this.#state.state = 'healthy';
    } else {
      return;
    }
    await this.#persist();
  }

  async markCleanStop(): Promise<void> {
    if (!this.#state || this.#unavailableReason || !this.#started) return;
    this.#state.currentRun = undefined;
    await this.#persist();
    this.#started = false;
  }

  snapshot(): OperationalHealthSnapshot {
    if (this.#unavailableReason) return { availability: 'unavailable', reason: this.#unavailableReason };
    if (!this.#state) return { availability: 'unavailable', reason: 'operational health has not been loaded' };
    this.#prune(this.#clock());
    return {
      availability: 'available',
      state: this.#state.state,
      failureCount: this.#state.failures.length,
      windowMs: this.#windowMs,
      failureThreshold: this.#failureThreshold,
      crashCount: this.#state.crashes.length,
      ...(this.#state.crashes.at(-1) ? { lastCrashAt: this.#state.crashes.at(-1)!.detectedAt } : {}),
      ...(this.#state.currentRun ? { currentRunStartedAt: this.#state.currentRun.startedAt } : {}),
    };
  }

  async #load(): Promise<HealthFileV1> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, state: 'healthy', failures: [], crashes: [] };
      }
      throw new Error('operational health state could not be read');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('operational health state is corrupt JSON');
    }
    if (!isHealthFile(parsed)) throw new Error('operational health state has an invalid shape');
    return parsed;
  }

  #prune(now: Date): void {
    if (!this.#state) return;
    const nowMs = now.getTime();
    const cutoff = nowMs - this.#windowMs;
    // A wall-clock rollback must not turn a bounded 60-second budget into an
    // hour-long degradation. Events dated after the clock we are evaluating
    // are outside this window just as surely as events older than the cutoff;
    // discard them instead of retaining them until wall time catches up.
    this.#state.failures = this.#state.failures.filter((event) => {
      const eventMs = Date.parse(event.at);
      return eventMs >= cutoff && eventMs <= nowMs;
    });
    // Entering `recovering` already required a real successful outcome. Once
    // the failures that caused degradation leave the window, the budget is
    // healthy again even if an otherwise-idle daemon has no second outcome to
    // report. The in-memory transition is persisted by the next state write
    // (including clean stop); a restart also prunes before writing its marker.
    if (this.#state.state === 'recovering' && this.#state.failures.length < this.#failureThreshold) {
      this.#state.state = 'healthy';
    }
  }

  async #persist(): Promise<void> {
    if (!this.#state) return;
    const body = JSON.stringify(this.#state, null, 2);
    this.#writeTail = this.#writeTail.then(async () => {
      await ensureSecureDir(path.dirname(this.#filePath));
      await atomicWriteFile(this.#filePath, body, { mode: 0o600, fsync: true });
    });
    try {
      await this.#writeTail;
    } catch (err) {
      this.#unavailableReason = 'operational health state could not be persisted';
      throw err;
    }
  }
}

/**
 * Read-only S7-b inspection seam. Unlike `OperationalHealthTracker.startRun`,
 * this never writes a run marker, prunes history, or repairs malformed bytes;
 * doctor can therefore report on an offline daemon without changing the very
 * evidence it is inspecting.
 */
async function inspectOperationalHealthHandle(
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<Exclude<OperationalHealthFileInspection, { status: 'missing' }>> {
  let before: import('node:fs').BigIntStats;
  try {
    before = await handle.stat({ bigint: true });
  } catch {
    return { status: 'unavailable', reason: 'operational health state could not be inspected' };
  }
  const sizeBytes = Number(before.size);
  if (!before.isFile()) {
    return { status: 'unavailable', sizeBytes, reason: 'operational health state is not a regular file' };
  }
  if (sizeBytes > MAX_OPERATIONAL_HEALTH_FILE_BYTES) {
    return { status: 'corrupt', sizeBytes, reason: 'operational health state exceeds the 1 MiB inspection limit' };
  }
  let raw: string;
  try {
    const buffer = Buffer.alloc(sizeBytes);
    const { bytesRead } = await handle.read(buffer, 0, sizeBytes, 0);
    const after = await handle.stat({ bigint: true });
    if (
      bytesRead !== sizeBytes ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return { status: 'unavailable', sizeBytes: Number(after.size), reason: 'operational health state changed during inspection' };
    }
    raw = buffer.toString('utf8');
  } catch {
    return { status: 'unavailable', sizeBytes, reason: 'operational health state could not be read' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', sizeBytes, reason: 'operational health state is corrupt JSON' };
  }
  if (!isHealthFile(parsed)) {
    return { status: 'corrupt', sizeBytes, reason: 'operational health state has an invalid shape' };
  }
  return {
    status: 'valid',
    sizeBytes,
    state: parsed.state,
    failureCount: parsed.failures.length,
    crashCount: parsed.crashes.length,
    ...(parsed.currentRun ? { currentRunStartedAt: new Date(Date.parse(parsed.currentRun.startedAt)).toISOString() } : {}),
    ...(parsed.crashes.at(-1)
      ? { lastCrashAt: new Date(Date.parse(parsed.crashes.at(-1)!.detectedAt)).toISOString() }
      : {}),
  };
}

/**
 * Open read-only/non-blocking/no-follow before inspecting. The flags make a
 * raced FIFO or symlink fail closed instead of hanging doctor indefinitely or
 * following bytes outside the store.
 */
export async function inspectOperationalHealthFile(storeDir: string): Promise<OperationalHealthFileInspection> {
  const filePath = path.join(storeDir, OPERATIONAL_HEALTH_FILENAME);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'unavailable', reason: 'operational health state could not be opened safely' };
  }
  try {
    return await inspectOperationalHealthHandle(handle);
  } finally {
    await handle.close();
  }
}

export { inspectOperationalHealthHandle };

function isHealthFile(value: unknown): value is HealthFileV1 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HealthFileV1>;
  if (candidate.version !== 1 || !['healthy', 'degraded', 'recovering'].includes(String(candidate.state))) return false;
  if (!Array.isArray(candidate.failures) || !candidate.failures.every(isFailureEvent)) return false;
  if (!Array.isArray(candidate.crashes) || !candidate.crashes.every(isCrashRecord)) return false;
  if (candidate.currentRun !== undefined && !isRunMarker(candidate.currentRun)) return false;
  return true;
}

function isFailureEvent(value: unknown): value is FailureEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<FailureEvent>;
  return typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) && ['reconnect', 'upload', 'maintenance', 'lifecycle'].includes(String(event.source));
}

function isCrashRecord(value: unknown): value is OperationalCrashRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<OperationalCrashRecord>;
  return typeof record.detectedAt === 'string' && Number.isFinite(Date.parse(record.detectedAt)) && typeof record.previousRunStartedAt === 'string' && Number.isFinite(Date.parse(record.previousRunStartedAt));
}

function isRunMarker(value: unknown): value is RunMarker {
  if (typeof value !== 'object' || value === null) return false;
  const marker = value as Partial<RunMarker>;
  return typeof marker.id === 'string' && typeof marker.startedAt === 'string' && Number.isFinite(Date.parse(marker.startedAt)) && typeof marker.pid === 'number' && Number.isSafeInteger(marker.pid);
}

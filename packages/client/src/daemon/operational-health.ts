import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
    this.#filePath = path.join(storeDir, 'operational-health.json');
    this.#windowMs = options.windowMs ?? 60_000;
    this.#failureThreshold = options.failureThreshold ?? 3;
    this.#maxFailures = options.maxFailures ?? 128;
    this.#maxCrashes = options.maxCrashes ?? 20;
    this.#clock = options.clock ?? (() => new Date());
    this.#runId = options.runId ?? randomUUID;
    this.#pid = options.pid ?? process.pid;
    if (!Number.isSafeInteger(this.#windowMs) || this.#windowMs <= 0) throw new Error('health windowMs must be positive');
    if (!Number.isSafeInteger(this.#failureThreshold) || this.#failureThreshold <= 0) throw new Error('health failureThreshold must be positive');
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
    const cutoff = now.getTime() - this.#windowMs;
    this.#state.failures = this.#state.failures.filter((event) => Date.parse(event.at) >= cutoff);
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

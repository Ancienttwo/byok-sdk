import { PASS_INSPECTIONS, runtimeReclaimedBytes } from './runtime-accounting';
import type { ResolvedStorageConfig } from './config';
import { EXPIRING_CLASS_IDS, PROTECTED_CLASS_IDS, type ClassUsage, type RetentionClassId, type RetentionTrigger, type SweepBudget, type SweepReport, RetentionRegistry } from './registry';
import { StoragePressure } from './pressure';

export interface RetentionTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface RetentionSnapshot {
  readonly measuredAt: string | null;
  readonly usedBytes: number;
  readonly freeBytes: number | null;
  readonly classes: readonly ClassUsage[];
  readonly lastSweep: SweepReport | null;
}
export function unmeasuredRetentionSnapshot(): RetentionSnapshot {
  return { measuredAt: null, usedBytes: 0, freeBytes: null, lastSweep: null,
    classes: [...EXPIRING_CLASS_IDS, ...PROTECTED_CLASS_IDS].map(classId => ({ classId,
      protected: PROTECTED_CLASS_IDS.includes(classId as typeof PROTECTED_CLASS_IDS[number]), measured: false, truncated: false, bytes: 0, entries: 0, oldestAgeMs: null })) };
}
export interface RetentionSweeperOptions {
  readonly config: ResolvedStorageConfig;
  readonly registry: RetentionRegistry;
  readonly pressure: StoragePressure;
  readonly freeBytes: () => Promise<number>;
  readonly clock?: () => Date;
  readonly timers?: RetentionTimers;
  readonly jitter: (sequence: number, baseMs: number) => number;
  readonly onSweep?: (report: SweepReport) => void;
  readonly onFailure?: (trigger: RetentionTrigger, classId: RetentionClassId, code: string) => void;
}

/** All maintenance has this one lifecycle owner, including daemons without a journal. */
export class RetentionSweeper {
  private timer: unknown;
  private running?: Promise<SweepReport>;
  private stopped = true;
  private sequence = 0;
  private readonly clock: () => Date;
  private readonly timers: RetentionTimers;
  private status: RetentionSnapshot;
  constructor(private readonly options: RetentionSweeperOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.timers = options.timers ?? {
      setTimeout: (handler, ms) => { const timer = setTimeout(handler, ms); timer.unref?.(); return timer; },
      clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
    };
    this.status = unmeasuredRetentionSnapshot();
  }
  snapshot(): RetentionSnapshot { return this.status; }
  runPass(trigger: RetentionTrigger): Promise<SweepReport> {
    if (this.running !== undefined) return this.running;
    const attempt = this.pass(trigger);
    this.running = attempt;
    void attempt.then(() => { if (this.running === attempt) this.running = undefined; }, () => { if (this.running === attempt) this.running = undefined; });
    return attempt;
  }
  private async pass(trigger: RetentionTrigger): Promise<SweepReport> {
    const started = performance.now(), now = this.clock();
    let deleted = 0, bytesReclaimed = 0, failures = 0, truncated = false, inspections = 0;
    const budget: SweepBudget = {
      trigger, now,
      available: () => {
        const allowed = ++inspections <= PASS_INSPECTIONS && deleted < this.options.config.maxDeletionsPerPass && performance.now() - started < this.options.config.maxPassDurationMs;
        if (!allowed) truncated = true;
        return allowed;
      },
      remaining: () => this.options.config.maxDeletionsPerPass - deleted,
      removed: bytes => { deleted++; bytesReclaimed += bytes; },
      truncate: () => { truncated = true; },
    };
    const { registry, pressure } = this.options;
    let classes = this.status.classes, freeBytes = this.status.freeBytes;
    let measuredAt = this.status.measuredAt;
    let startupFailure: unknown;
    // Secret-bearing SDK residue is a startup prerequisite, even if measurement is slow.
    if (trigger === 'startup') {
      try { await registry.sweep('exec-sdk', budget); }
      catch (error) { startupFailure = error; failures++; this.options.onFailure?.(trigger, 'exec-sdk', 'sweep_failed'); }
    }
    // Decide pressure from this pass's measurement before any durable cleanup.
    try {
      const measured = await registry.measure();
      const free = await this.options.freeBytes();
      if (!Number.isSafeInteger(free) || free < 0) throw new Error('invalid free-space measurement');
      classes = measured; freeBytes = free; measuredAt = now.toISOString();
      pressure.update(classes.reduce((sum, entry) => sum + entry.bytes, 0), free);
    } catch (error) {
      failures++;
      this.options.onFailure?.(trigger, 'store-authority', 'measurement_failed');
      if (this.options.config.budget !== undefined) {
        pressure.noteAckCriticalFailure('storage measurement unavailable');
        if (trigger === 'startup') startupFailure = error;
      }
    }
    if (startupFailure === undefined) {
      try { await registry.prepare(budget, pressure.state !== 'normal'); }
      catch { failures++; this.options.onFailure?.(trigger, 'confirmed-journal', 'sweep_failed'); }
    }
    for (const id of EXPIRING_CLASS_IDS) {
      if (startupFailure !== undefined) break;
      if (trigger === 'startup' && id === 'exec-sdk') continue;
      if (pressure.state !== 'normal' && ['confirmed-journal', 'reader-run', 'home-temp', 'skill-pack-old'].includes(id)) continue;
      if (!budget.available()) break;
      try { await registry.sweep(id, budget); }
      catch (error) {
        failures++;
        this.options.onFailure?.(trigger, id, 'sweep_failed');
        if (trigger === 'startup' && id === 'exec-sdk') { startupFailure = error; break; }
      }
    }
    bytesReclaimed += runtimeReclaimedBytes.get(budget) ?? 0;
    runtimeReclaimedBytes.delete(budget);
    const report: SweepReport = { trigger, at: now.toISOString(), deleted, bytesReclaimed, failures, truncated, durationMs: performance.now() - started };
    this.status = { measuredAt, usedBytes: classes.reduce((sum, entry) => sum + entry.bytes, 0), freeBytes, classes, lastSweep: report };
    this.options.onSweep?.(report);
    if (startupFailure !== undefined) throw startupFailure;
    return report;
  }
  start(): void { this.stopped = false; this.arm(); }
  private arm(): void {
    if (this.stopped || this.timer !== undefined) return;
    const base = this.options.pressure.state === 'normal' ? this.options.config.sweepIntervalMs : this.options.config.pressureSweepIntervalMs;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      const trigger = this.options.pressure.state === 'normal' ? 'periodic' : 'pressure';
      void this.runPass(trigger).catch(() => undefined).finally(() => this.arm());
    }, this.options.jitter(this.sequence++, base));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
    await this.options.registry.close();
  }
}

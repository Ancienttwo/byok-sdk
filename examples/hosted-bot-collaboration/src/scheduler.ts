import type { Pool } from 'pg';
import { WAKE_HORIZON_MS } from '@byok-sdk/example-host-execution-core';
import { ROUTINE_LATE_AFTER_MS } from '@byok-sdk/example-bot-collaboration/routines';
import { DeviceBindingError } from './binding';
import { SUPPORTED_STORE_VERSIONS } from './ddl';
import { inSchema, type HostedCollaborationStore } from './store';

export interface SchedulerOptions {
  now?: () => number;
  /**
   * How often the deployment runs a pass. It must stay below the K8 late bound, or every slot would fire as `catch_up`
   * and its occurrence key would differ from L's. Default 5 s.
   */
  intervalMs?: number;
  /** The most fires and failures that one pass takes. A fenced row does not count. */
  batch?: number;
  /** How long a routine whose fire threw waits before the next try. The wait is kept in memory only. */
  backoffMs?: number;
}
/** A routine that a pass could not fire. `fenced`: its owner Bot's device has no active H binding, and nothing was written. */
export interface RoutineFailure { scope: string; routineId: string; error: unknown }
export interface SchedulerPass { fired: number; fenced: RoutineFailure[]; failed: RoutineFailure[] }

type DueRow = { scope: string; id: string; next_at: string; ordinal: string };
const DEFAULT_INTERVAL_MS = 5_000;

/**
 * The H routine scheduler (#793 D2f-3, scheduler note §2.2 and §2.6). H has no SDK wake, so a Host-owned pass over
 * `routine_due` fires each due slot through `HostedCollaborationStore.fire`, one transaction per routine. The store runs the
 * K4 and K8 routine rules; this class only finds due rows and reports what happened.
 */
export class HostedRoutineScheduler {
  readonly intervalMs: number;
  private readonly now: () => number;
  private readonly retryAt = new Map<string, number>();

  constructor(private readonly pool: Pool, private readonly store: HostedCollaborationStore, private readonly options: SchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1 || this.intervalMs >= ROUTINE_LATE_AFTER_MS) {
      throw new Error(`The routine pass interval must be at least 1 ms and below ${ROUTINE_LATE_AFTER_MS} ms`);
    }
  }

  /**
   * Run once when the scheduler starts, as K4 `recover`: each scope with an active routine that had no slot within the
   * horizon re-plans it, and each scope with a staged version checks the switch. One transaction per scope.
   */
  async start(): Promise<RoutineFailure[]> {
    const scopes = await this.scopes(`SELECT DISTINCT r.scope FROM routine r JOIN scope s ON s.scope = r.scope WHERE s.state_version = ANY($1::integer[])
      AND ((r.lifecycle = 'active' AND r.status = 'no_occurrence_within_horizon' AND r.pending IS NULL) OR r.pending IS NOT NULL) ORDER BY r.scope`, []);
    return this.plan(scopes, 'start');
  }

  /**
   * One pass: the schedule upkeep of the scopes with a `schedule_retrying` slot now within the horizon, then the fire of each
   * due routine in slot order. The rows are read in keyset pages, so fenced rows and backed-off rows cannot fill the batch.
   */
  async run(): Promise<SchedulerPass> {
    const now = this.now(), pass: SchedulerPass = { fired: 0, fenced: [], failed: [] };
    const retrying = await this.scopes(`SELECT DISTINCT r.scope FROM routine r JOIN scope s ON s.scope = r.scope WHERE s.state_version = ANY($1::integer[])
      AND r.status = 'schedule_retrying' AND r.next_at <= $2 ORDER BY r.scope`, [now + WAKE_HORIZON_MS]);
    pass.failed.push(...await this.plan(retrying, 'pass'));
    const batch = this.options.batch ?? 100;
    let cursor: [number, string, number] = [-1, '', -1], tried = 0;
    while (tried < batch) {
      const due = await inSchema(this.pool, this.store.schema, client => client.query<DueRow>(
        `SELECT r.scope, r.id, r.next_at::text, r.ordinal::text FROM routine r JOIN scope s ON s.scope = r.scope
          WHERE s.state_version = ANY($3::integer[]) AND r.lifecycle = 'active' AND r.next_at <= $1
          AND (r.next_at, r.scope, r.ordinal) > ($4, $5, $6) ORDER BY r.next_at, r.scope, r.ordinal LIMIT $2`,
        [now, batch, [...SUPPORTED_STORE_VERSIONS], ...cursor]), true);
      for (const row of due.rows) {
        cursor = [Number(row.next_at), row.scope, Number(row.ordinal)];
        if (tried >= batch) break;
        const scope = JSON.parse(row.scope) as string, routineId = JSON.parse(row.id) as string, retry = `${row.scope}\n${row.id}`;
        if ((this.retryAt.get(retry) ?? 0) > now) continue;
        try {
          if (await this.store.fire(scope, routineId, now) === 'fired') { pass.fired++; tried++; }
          this.retryAt.delete(retry);
        } catch (error) {
          if (error instanceof DeviceBindingError) { pass.fenced.push({ scope, routineId, error }); continue; }
          // A throw wrote nothing. The routine waits before its next try, so it cannot take every pass.
          pass.failed.push({ scope, routineId, error });
          this.retryAt.set(retry, now + (this.options.backoffMs ?? 60_000));
          tried++;
        }
      }
      if (due.rows.length < batch) break;
    }
    return pass;
  }

  private async scopes(text: string, values: unknown[]): Promise<string[]> {
    const found = await inSchema(this.pool, this.store.schema, client =>
      client.query<{ scope: string }>(text, [[...SUPPORTED_STORE_VERSIONS], ...values]), true);
    return found.rows.map(row => JSON.parse(row.scope) as string);
  }
  private async plan(scopes: string[], phase: 'start' | 'pass'): Promise<RoutineFailure[]> {
    const failed: RoutineFailure[] = [];
    for (const scope of scopes) {
      try { await this.store.planRoutines(scope, this.now(), phase); }
      catch (error) { failed.push({ scope, routineId: '', error }); }
    }
    return failed;
  }
}

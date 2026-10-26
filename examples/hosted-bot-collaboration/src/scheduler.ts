import type { Pool } from 'pg';
import { WAKE_HORIZON_MS } from '@byok-sdk/example-host-execution-core';
import { ROUTINE_LATE_AFTER_MS } from '@byok-sdk/example-bot-collaboration/routines';
import { DeviceBindingError, DeviceSwitchingError } from './binding';
import { SUPPORTED_STORE_VERSIONS } from './ddl';
import { inSchema, type HostedCollaborationStore } from './store';

export interface SchedulerOptions {
  now?: () => number;
  /**
   * How often the deployment runs a pass. H has no timer: the deployment reads `intervalMs` to time its `run()` calls, so
   * the constructor checks the value that timer uses. It must stay below the K8 late bound, or every slot would fire as
   * `catch_up` and its occurrence key would differ from L's. Default 5 s.
   */
  intervalMs?: number;
  /** The most fires that one pass takes. A fenced or failed row does not count: its backoff limits how often it runs. */
  batch?: number;
  /**
   * How long a fenced routine, or one whose fire threw, waits before the next try. The wait is `routine.retry_at`, so it
   * holds across scheduler instances and processes, and only for the slot it was set on.
   */
  backoffMs?: number;
  /**
   * Called once for each scope where this pass committed a fire, in the order of its first one, at the end of the pass
   * before it returns (#793 D2f-5). The Host syncs those scopes, so the steps that follow, such as a delegation verdict or a freeze, run at once. Work that threw or rolled back
   * reports nothing. A throw from the callback propagates.
   */
  changed?: (scope: string) => void;
}
/**
 * A routine that a pass could not fire. `fenced`: its owner Bot's device has no active H binding or is frozen for an owner
 * switch (#957), and nothing was written.
 */
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
    const scopes = await this.scopes(`SELECT DISTINCT r.scope FROM routine r JOIN scope s ON s.scope = r.scope WHERE s.state_version = ANY($1::integer[]) AND s.switch_export IS NULL
      AND ((r.lifecycle = 'active' AND r.status = 'no_occurrence_within_horizon' AND r.pending IS NULL) OR r.pending IS NOT NULL) ORDER BY r.scope`, []);
    return this.plan(scopes, 'start');
  }

  /**
   * One pass: the schedule upkeep of the scopes with a `schedule_retrying` slot now within the horizon, then the fire of each
   * due routine in slot order. The rows are read in keyset pages, so fenced rows and backed-off rows cannot fill the batch.
   * Each fire reads the clock, as K4 does when it consumes a wake. The pass time only selects the due rows.
   */
  async run(): Promise<SchedulerPass> {
    const now = this.now(), pass: SchedulerPass = { fired: 0, fenced: [], failed: [] }, changed = new Set<string>();
    const retrying = await this.scopes(`SELECT DISTINCT r.scope FROM routine r JOIN scope s ON s.scope = r.scope WHERE s.state_version = ANY($1::integer[]) AND s.switch_export IS NULL
      AND r.status = 'schedule_retrying' AND r.next_at <= $2 ORDER BY r.scope`, [now + WAKE_HORIZON_MS]);
    pass.failed.push(...await this.plan(retrying, 'pass'));
    const batch = this.options.batch ?? 100, backoffMs = this.options.backoffMs ?? 60_000;
    let cursor: [number, string, number] = [-1, '', -1];
    while (pass.fired < batch) {
      const due = await inSchema(this.pool, this.store.schema, client => client.query<DueRow>(
        `SELECT r.scope, r.id, r.next_at::text, r.ordinal::text FROM routine r JOIN scope s ON s.scope = r.scope
          WHERE s.state_version = ANY($3::integer[]) AND s.switch_export IS NULL AND r.lifecycle = 'active' AND r.next_at <= $1
          AND (r.retry_at IS NULL OR r.retry_at <= $1)
          AND (r.next_at, r.scope, r.ordinal) > ($4, $5, $6) ORDER BY r.next_at, r.scope, r.ordinal LIMIT $2`,
        [now, batch, [...SUPPORTED_STORE_VERSIONS], ...cursor]), true);
      for (const row of due.rows) {
        cursor = [Number(row.next_at), row.scope, Number(row.ordinal)];
        if (pass.fired >= batch) break;
        const scope = JSON.parse(row.scope) as string, routineId = JSON.parse(row.id) as string, at = this.now();
        let threw = false;
        try {
          if (await this.store.fire(scope, routineId, at) === 'fired') {
            pass.fired++;
            changed.add(scope);
          }
        } catch (error) {
          (error instanceof DeviceBindingError || error instanceof DeviceSwitchingError ? pass.fenced : pass.failed).push({ scope, routineId, error });
          threw = true;
        }
        // A throw wrote nothing. The routine keeps its old slot, which sorts ahead of healthy rows, so it waits before its
        // next try and does not run a transaction on every pass. Keyed on that slot: a write that moved it has cleared
        // `retry_at`, and this one then matches no row. It takes no scope lock, so the switch fence does not see it. It
        // takes a share lock on the scope row instead, scope before routine as every writer does: it waits for an export in
        // flight and reads the committed mark, so an exported scope gets no backoff (#975).
        if (threw) {
          await inSchema(this.pool, this.store.schema, async client => {
            const scope = await client.query<{ open: boolean }>('SELECT switch_export IS NULL AS open FROM scope WHERE scope = $1 FOR SHARE', [row.scope]);
            if (scope.rows[0]?.open) {
              await client.query('UPDATE routine SET retry_at = $4 WHERE scope = $1 AND id = $2 AND next_at = $3', [row.scope, row.id, Number(row.next_at), at + backoffMs]);
            }
          });
        }
      }
      if (due.rows.length < batch) break;
    }
    for (const scope of changed) this.options.changed?.(scope);
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

import type { Pool } from 'pg';
import { SUPPORTED_STORE_VERSIONS } from './ddl';
import { inSchema, type HostedCollaborationStore, type SyncResult } from './store';

export interface DueSchedulerOptions {
  /**
   * The deployment's sync of one scope at `now`, with its own sync options: `store.sync(scope, { ...options, now })`. It
   * returns the store's sync result, whose `dueAt` tells the pass whether the scope is still due.
   */
  sync: (scope: string, now: number) => Promise<SyncResult>;
  now?: () => number;
  /** The most syncs that one pass runs. A scope that waits out its backoff does not count. */
  batch?: number;
  /** How long a scope that is still due after its sync, or whose sync threw, waits before the next try. In memory only. */
  backoffMs?: number;
}
/** A scope whose sync threw. Nothing was written. */
export interface DueFailure { scope: string; error: unknown }
/** `stalled`: the scopes that were still due after their sync, because no H step clears what made them due. */
export interface DuePass { synced: number; stalled: string[]; failed: DueFailure[] }

type DueRow = { scope: string; due: string };

/**
 * The H due scheduler (#793 S4). Each store transaction writes `scope.due_at`, the earliest time that the K8 rule
 * `collaborationDue` gives for the state it commits. A pass syncs each scope whose time has come, in due order, so a
 * batch seal, a card expiry or a delegation timer runs without new input. The store runs the rules; this class only finds
 * due scopes and reports what happened.
 */
export class HostedDueScheduler {
  private readonly now: () => number;
  private readonly retryAt = new Map<string, number>();

  constructor(private readonly pool: Pool, private readonly store: HostedCollaborationStore, private readonly options: DueSchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * One pass over the due scopes, read in keyset pages, so backed-off scopes cannot fill the batch. Each sync reads the
   * clock, as a routine fire does. The pass time only selects the due scopes.
   */
  async run(): Promise<DuePass> {
    const now = this.now(), pass: DuePass = { synced: 0, stalled: [], failed: [] };
    // An expired wait has no effect, so a scope that stopped being due leaves the map within one backoff.
    for (const [retry, at] of this.retryAt) if (at <= now) this.retryAt.delete(retry);
    const batch = this.options.batch ?? 100, backoffMs = this.options.backoffMs ?? 60_000;
    let cursor: [number, string] = [-1, ''];
    while (pass.synced < batch) {
      const due = await inSchema(this.pool, this.store.schema, client => client.query<DueRow>(
        // The text form has its own name: an output column named `due_at` would make ORDER BY sort the text.
        `SELECT scope, due_at::text AS due FROM scope WHERE due_at <= $1 AND state_version = ANY($3::integer[])
          AND (due_at, scope) > ($4, $5) ORDER BY due_at, scope LIMIT $2`,
        [now, batch, [...SUPPORTED_STORE_VERSIONS], ...cursor]), true);
      for (const row of due.rows) {
        cursor = [Number(row.due), row.scope];
        if (pass.synced >= batch) break;
        const scope = JSON.parse(row.scope) as string, at = this.now();
        if ((this.retryAt.get(row.scope) ?? 0) > at) continue;
        try {
          const { dueAt } = await this.options.sync(scope, at);
          pass.synced++;
          if (dueAt !== null && dueAt <= at) {
            // The sync left the scope due, so every pass would sync it again and write nothing.
            pass.stalled.push(scope);
            this.retryAt.set(row.scope, at + backoffMs);
          } else this.retryAt.delete(row.scope);
        } catch (error) {
          pass.failed.push({ scope, error });
          this.retryAt.set(row.scope, at + backoffMs);
        }
      }
      if (due.rows.length < batch) break;
    }
    return pass;
  }
}

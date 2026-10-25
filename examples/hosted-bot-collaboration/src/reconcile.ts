import type { Pool, PoolClient } from 'pg';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { canonical, FrozenOfferMismatchError, sameFrozenOffer, type Conclusion, type FrozenInput, type FrozenSubmitPort,
  type Json } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { revisionOf, type OutboxIntent } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { SUPPORTED_STORE_VERSIONS } from './ddl';
import { deliverCancels } from './intents';
import { commitStored } from './retention';
import { storedKey } from './layout';
import { loadSlice, outcomeRoutinePorts, switchDueVersions, writeSlice } from './routines';
import { inSchema, lockScope, type Decision, type HostedCollaborationStore, type StorePorts } from './store';

/** The SDK calls of one tenant that the reconciliation uses, as L binds them to its `ByokServer` tasks. */
export interface HostedTaskPort extends Pick<FrozenSubmitPort, 'offer'> {
  attempt(taskId: string): Promise<TaskAttempt | undefined>;
  deviceTerminal(taskId: string): Promise<DeviceTerminal | undefined>;
  cancel(taskId: string, reason: string): Promise<unknown>;
}
/** The device terminal of a task and the attempt read after it. */
export interface TaskEvidence { terminal: DeviceTerminal; attempt: TaskAttempt }

export interface ReconcilerOptions {
  /** The SDK calls of the tenant that owns `scope`. */
  port: (scope: string) => HostedTaskPort;
  /** The Host clock. The terminal transaction reads it too; the store builds its command ports (#793 S9). */
  now?: () => number;
  /** The wait before the next readback of a row that has no terminal yet. */
  pollMs?: number;
  /** The most rows that one pass takes. */
  batch?: number;
  /**
   * Called once for each scope where this pass committed a conclusion or a first claim (`started`), in the order of its first
   * one, at the end of the pass before it returns (#793 D2f-5). The Host syncs those scopes, so the steps that follow, such as
   * a delegation verdict, a unit spend or a freeze, run at once, as L syncs after the drain that saw them. Work that threw or
   * rolled back reports nothing. A throw from the callback propagates.
   */
  changed?: (scope: string) => void;
}
/** A row whose reconciliation threw. The pass went on with the next row. */
export interface ReconcileFailure { scope: string; turnId: string; error: unknown }
export interface ReconcilePass { concluded: number; failed: ReconcileFailure[] }
type Row = { input: FrozenInput; waitUntil: number; cancelReason: 'expired' | 'cancelled' | null; concluded: boolean; started: boolean };

/**
 * Reads the SDK result of each tried intent and concludes it (#793 D2d), with the K4 rules of `reconcile` and `finish`.
 * Each SDK call runs outside the scope lock. Each write takes the lock and is fenced on `conclusion IS NULL`, so a
 * second reconciler or a replayed terminal changes nothing. H never retries a task: it keeps generation 0, because no
 * K8 wait window is longer than the first K4 retry delay (#793 D2d option A).
 */
export class HostedReconciler {
  private readonly now: () => number;
  constructor(private readonly pool: Pool, readonly schema: string, private readonly store: HostedCollaborationStore,
    private readonly options: ReconcilerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** One pass over the due rows. A row that throws gets its next readback later, and the pass goes on. */
  async run(): Promise<ReconcilePass> {
    // A scope of a store version this code does not support is left out before the limit, as in the submit scan.
    const due = await inSchema(this.pool, this.schema, client => client.query<{ scope: string; key: string }>(
      `SELECT i.scope, i.key FROM intent i JOIN scope s ON s.scope = i.scope
        WHERE s.state_version = ANY($3::integer[]) AND i.conclusion IS NULL AND i.submission <> 'reserved' AND i.reconcile_at <= $1
        ORDER BY i.reconcile_at, i.scope, i.key LIMIT $2`, [this.now(), this.options.batch ?? 100, [...SUPPORTED_STORE_VERSIONS]]), true);
    const pass: ReconcilePass = { concluded: 0, failed: [] }, changed = new Set<string>();
    for (const row of due.rows) {
      try {
        if (await this.reconcile(row.scope, row.key, () => changed.add(JSON.parse(row.scope) as string))) {
          pass.concluded++;
          changed.add(JSON.parse(row.scope) as string);
        }
      }
      catch (error) {
        pass.failed.push({ scope: JSON.parse(row.scope) as string, turnId: JSON.parse(row.key) as string, error });
        await this.later(row.scope, row.key).catch(() => undefined);
      }
    }
    for (const scope of changed) this.options.changed?.(scope);
    return pass;
  }

  /** K4 `reconcile` for one tried row. Returns true when the row concluded. */
  private async reconcile(scopeKey: string, key: string, started: () => void): Promise<boolean> {
    const row = await this.read(scopeKey, key);
    if (!row || row.concluded) return false;
    const port = this.options.port(JSON.parse(scopeKey) as string), task = row.input.taskId;
    // Verify the immutable input before accepting any later evidence.
    const offer = await port.offer(task);
    if (offer && !sameFrozenOffer(offer, row.input)) throw new FrozenOfferMismatchError();
    let terminal = await port.deviceTerminal(task);
    let cancelReason = row.cancelReason;
    // Only an earlier observed claim removes the waiting deadline, as in K4.
    if (!terminal && !cancelReason && !row.started && this.now() >= row.waitUntil) {
      const stored = await this.expire(scopeKey, key);
      if (stored === 'concluded') return false;
      cancelReason = stored;
    }
    // Read before the attempt: a submit lease that ended by then held no try that could still create an attempt.
    const attemptReadAt = this.now();
    let attempt = verified(row.input, await port.attempt(task));
    if (cancelReason && !terminal) {
      // No attempt: conclude, but only when no submit try held the row at the read. K4 serializes this with every submit;
      // H uses the lease.
      if (!attempt) return this.conclude(scopeKey, key, cancelReason, attemptReadAt);
      await port.cancel(task, cancelReason);
      attempt = verified(row.input, await port.attempt(task));
      if (!attempt) throw new Error('Attempt disappeared after cancellation');
      terminal = await port.deviceTerminal(task);
    }
    if (attempt && await this.record(scopeKey, key, attempt)) started();
    if (attempt?.status === 'cancelled' && !attempt.claimedRuntime && !attempt.ownerDeviceId && !terminal) {
      return this.conclude(scopeKey, key, cancelReason === 'expired' ? 'expired' : 'cancelled');
    }
    if (terminal) {
      if (terminal.envelope.task_id !== task) throw new Error('Terminal identity conflict');
      // Read the cancellation again after the terminal. A late success must not apply an outcome.
      attempt = verified(row.input, await port.attempt(task));
      if (!attempt) throw new Error('Device terminal has no attempt');
      return (await this.store.finish(JSON.parse(scopeKey) as string, JSON.parse(key) as string, { terminal, attempt }, this.now)) !== undefined;
    }
    await this.later(scopeKey, key);
    return false;
  }

  private async read(scopeKey: string, key: string): Promise<Row | undefined> {
    const found = await inSchema(this.pool, this.schema, client => client.query<{ input: FrozenInput; wait_until: string;
      cancel_reason: Row['cancelReason']; concluded: boolean; started: boolean }>(
      `SELECT input, wait_until::text, cancel_reason, conclusion IS NOT NULL AS concluded, started FROM intent WHERE scope = $1 AND key = $2`,
      [scopeKey, key]), true);
    const row = found.rows[0];
    return row && { input: row.input, waitUntil: Number(row.wait_until), cancelReason: row.cancel_reason, concluded: row.concluded, started: row.started };
  }

  /**
   * Under the scope lock, sets `cancel_reason = 'expired'` on a row with no reason and no observed claim. Returns the stored
   * reason; `null` when another pass has seen the claim since this pass read the row, so the row keeps waiting; or
   * `concluded`.
   */
  private expire(scopeKey: string, key: string): Promise<'expired' | 'cancelled' | null | 'concluded'> {
    return this.locked(scopeKey, async client => {
      const found = await client.query<{ cancel_reason: 'expired' | 'cancelled' | null; concluded: boolean; started: boolean }>(
        'SELECT cancel_reason, conclusion IS NOT NULL AS concluded, started FROM intent WHERE scope = $1 AND key = $2 FOR UPDATE', [scopeKey, key]);
      const row = found.rows[0];
      if (!row || row.concluded) return 'concluded';
      if (row.cancel_reason || row.started) return row.cancel_reason;
      await client.query(`UPDATE intent SET cancel_reason = 'expired' WHERE scope = $1 AND key = $2`, [scopeKey, key]);
      return 'expired';
    });
  }

  /** Stores the attempt, and the first claim. Returns true when this write committed the first claim. */
  private record(scopeKey: string, key: string, attempt: TaskAttempt): Promise<boolean> {
    const claimed = !!(attempt.claimedRuntime || attempt.ownerDeviceId);
    return this.locked(scopeKey, async client => {
      const before = (await client.query<{ started: boolean }>('SELECT started FROM intent WHERE scope = $1 AND key = $2 AND conclusion IS NULL',
        [scopeKey, key])).rows[0];
      await client.query(`UPDATE intent SET attempt = $3::json, started = started OR $4 WHERE scope = $1 AND key = $2 AND conclusion IS NULL`,
        [scopeKey, key, JSON.stringify(attempt), claimed]);
      return !!before && !before.started && claimed;
    });
  }

  /**
   * Concludes a row with no device terminal. With `attemptReadAt`, the row's submit lease must have ended by the time that
   * the attempt was read as absent, because a try in flight then could still create an attempt.
   */
  private conclude(scopeKey: string, key: string, conclusion: 'expired' | 'cancelled', attemptReadAt?: number): Promise<boolean> {
    return this.locked(scopeKey, async (client, now) => {
      const done = await client.query(`UPDATE intent SET conclusion = $3 WHERE scope = $1 AND key = $2 AND conclusion IS NULL
        AND ($4::bigint IS NULL OR next_at <= $4)`, [scopeKey, key, conclusion, attemptReadAt ?? null]);
      if (done.rowCount) {
        await switchDueVersions(client, scopeKey, now);
        return true;
      }
      await this.delay(client, scopeKey, key, now);
      return false;
    });
  }

  private later(scopeKey: string, key: string): Promise<void> {
    return this.locked(scopeKey, (client, now) => this.delay(client, scopeKey, key, now));
  }
  private async delay(client: PoolClient, scopeKey: string, key: string, now: number): Promise<void> {
    await client.query('UPDATE intent SET reconcile_at = $3 WHERE scope = $1 AND key = $2 AND conclusion IS NULL',
      [scopeKey, key, now + (this.options.pollMs ?? 30_000)]);
  }
  /** Runs `work` under the scope lock. The clock is read after the lock is taken. */
  private locked<T>(scopeKey: string, work: (client: PoolClient, now: number) => Promise<T>): Promise<T> {
    return inSchema(this.pool, this.schema, async client => {
      await lockScope(client, scopeKey);
      return work(client, this.now());
    });
  }
}

function verified(input: FrozenInput, attempt: TaskAttempt | undefined): TaskAttempt | undefined {
  if (attempt && (attempt.taskId !== input.taskId || attempt.deviceId !== input.deviceId
    || canonical(attempt.agentRef) !== canonical(input.payload.agentRef))) throw new Error('Attempt identity conflict');
  return attempt;
}

/**
 * K4 `finish` in the store's terminal transaction, under the scope lock. A concluded row changes nothing. A completed
 * task commits the K8 `outcome` command under the command id `taskId`, as L does, so a replayed terminal gets the first
 * result from the command record. Returns the conclusion that this transaction wrote.
 * The store owns the routine ports: the outcome's routine actions run the K4 rules on the scope's routines before the
 * conclusion, as K4 runs `applyOutcome` before `settle` (#793 D2f). Then a staged version that is due switches.
 */
export async function decideFinish(client: PoolClient, scope: string, turnId: string, state: CollaborationState,
  { terminal, attempt }: TaskEvidence, ports: StorePorts, channel: boolean): Promise<Decision<Conclusion | undefined>> {
  const scopeKey = storedKey(scope), key = storedKey(turnId);
  const found = await client.query<{ task_id: string; concluded: boolean }>(
    'SELECT task_id, conclusion IS NOT NULL AS concluded FROM intent WHERE scope = $1 AND key = $2', [scopeKey, key]);
  const row = found.rows[0];
  if (!row) throw new Error('Unknown intent');
  if (row.concluded) return { value: undefined, outbox: [] };
  const envelope = terminal.envelope;
  if (envelope.task_id !== row.task_id) throw new Error('Terminal identity conflict');
  let conclusion: Conclusion, outbox: OutboxIntent[] = [];
  const { manage, ...base } = ports, now = base.now();
  if (attempt.cancellation || envelope.type === 'task.cancelled') conclusion = 'cancelled';
  else if (envelope.type === 'task.complete') {
    // commitStored reads the committed intents before this row concludes, as L reads its ledger before the terminal transaction writes.
    const slice = await loadSlice(client, scopeKey), head = revisionOf(state);
    const result = await commitStored(client, scope, state, { scope, commandId: row.task_id,
      command: { kind: 'outcome', turnId, taskId: row.task_id, document: envelope.payload.document as Json } },
    { ...base, outcome: { manage: manage(row.task_id), ...outcomeRoutinePorts(slice, now, row.task_id) } }, channel);
    await writeSlice(client, scopeKey, slice);
    outbox = result.revision === head + 1 ? result.outbox : [];
    conclusion = 'succeeded';
  } else conclusion = envelope.type === 'task.decline' ? 'declined' : 'failed';
  await client.query('UPDATE intent SET terminal = $3::json, attempt = $4::json, conclusion = $5 WHERE scope = $1 AND key = $2',
    [scopeKey, key, JSON.stringify(terminal), JSON.stringify(attempt), conclusion]);
  // The Main Bot cancel that the outcome froze, delivered after this row concluded, as L runs core.cancel after its terminal
  // transaction (K8 host.ts pass). The version switch then sees a target that the delivery concluded (#793 D2f-5).
  await deliverCancels(client, scope, state, now);
  await switchDueVersions(client, scopeKey, now);
  return { value: conclusion, outbox, now };
}

import type { Pool, PoolClient } from 'pg';
import { agentKey, canonical, fifoHeads, queuedExpiry, submitFrozen, taskId,
  type ExecutionTemplate, type FrozenInput, type FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import { storedKey } from './layout';
import { inSchema, lockScope } from './store';

/** What a Turn freezes (#793 D2b). D2b-2 calls `freezeIntent` in the sync transaction of the Turn. */
export interface IntentFreeze { turnId: string; execution: ExecutionTemplate; waitUntil: number }

/**
 * Saves one intent with its frozen input and its stable task id, `taskId(turnId, 0)`. The caller holds the scope
 * lock. A second freeze of the same Turn with the same input changes nothing; another input throws.
 */
export async function freezeIntent(client: PoolClient, scope: string, freeze: IntentFreeze): Promise<FrozenInput> {
  const scopeKey = storedKey(scope), key = storedKey(freeze.turnId);
  const input: FrozenInput = { ...structuredClone(freeze.execution), taskId: taskId(freeze.turnId, 0) };
  const prior = await client.query<{ input: string; wait_until: string }>(
    'SELECT input::text AS input, wait_until::text FROM intent WHERE scope = $1 AND key = $2', [scopeKey, key]);
  if (prior.rows[0]) {
    if (canonical(JSON.parse(prior.rows[0].input)) !== canonical(input) || Number(prior.rows[0].wait_until) !== freeze.waitUntil) {
      throw new Error('Intent identity conflict');
    }
    return input;
  }
  await client.query(`INSERT INTO intent (scope, key, task_id, ordinal, agent, input, wait_until, submission)
    SELECT $1, $2, $3, coalesce(max(ordinal) + 1, 0), $4, $5::json, $6, 'reserved' FROM intent WHERE scope = $1`,
  [scopeKey, key, input.taskId, agentKey(scope, freeze.execution), JSON.stringify(input), freeze.waitUntil]);
  return input;
}

export interface SubmitterOptions {
  /** The SDK calls of the tenant that owns `scope`. */
  port: (scope: string) => FrozenSubmitPort;
  now?: () => number;
  /** How long a try holds a row. Keep each SDK call shorter than this. */
  leaseMs?: number;
  /** The wait after a failed try. */
  backoffMs?: number;
  /** The most rows that one pass takes. */
  batch?: number;
}
type Claim = { scopeKey: string; key: string; tries: number; input: FrozenInput; waitUntil: number };
/** A row whose try threw outside the SDK call, for example on an unknown store version. The pass went on. */
export interface SubmitFailure { scope: string; turnId: string; error: unknown }
export interface SubmitPass { tried: number; failed: SubmitFailure[] }

/**
 * Submits frozen intents (#793 D2b-1). It uses the K4 rules: the FIFO head, the queued expiry and `submitFrozen`.
 * Each try raises `tries` under the scope lock before any SDK call. A late write is fenced by that value, and a
 * delivered row never changes back. A tried row past `wait_until` is never submitted again: it gets
 * `cancel_reason = 'expired'` and no conclusion, because an attempt can still exist (D2d checks it).
 */
export class HostedSubmitter {
  private readonly now: () => number;
  constructor(private readonly pool: Pool, readonly schema: string, private readonly options: SubmitterOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * One pass over the due FIFO heads. A follower is never due, so it cannot fill the batch ahead of a head. A row
   * whose try throws is backed off when its scope can be locked, and the pass goes on with the next row.
   */
  async run(): Promise<SubmitPass> {
    const due = await inSchema(this.pool, this.schema, client => client.query<{ scope: string; key: string }>(
      `SELECT i.scope, i.key FROM intent i WHERE i.conclusion IS NULL AND i.submission <> 'delivered' AND i.cancel_reason IS NULL
        AND i.next_at <= $1 AND NOT EXISTS (SELECT 1 FROM intent o WHERE o.scope = i.scope AND o.agent = i.agent
          AND o.conclusion IS NULL AND o.ordinal < i.ordinal)
        ORDER BY i.next_at, i.scope, i.ordinal LIMIT $2`, [this.now(), this.options.batch ?? 100]), true);
    const pass: SubmitPass = { tried: 0, failed: [] };
    for (const row of due.rows) {
      try { if (await this.try(row.scope, row.key)) pass.tried++; }
      catch (error) {
        pass.failed.push({ scope: JSON.parse(row.scope) as string, turnId: JSON.parse(row.key) as string, error });
        // The backoff can fail too, for example when the scope has an unknown store version. Then nothing is written.
        await this.backOff(row.scope, row.key, error).catch(() => undefined);
      }
    }
    return pass;
  }

  /** Saves the error of a failed try and delays the row. It does not touch a row that another try holds. */
  private backOff(scopeKey: string, key: string, error: unknown): Promise<void> {
    return inSchema(this.pool, this.schema, async client => {
      await lockScope(client, scopeKey);
      const now = this.now();
      await client.query(`UPDATE intent SET last_error = $3, next_at = $5 WHERE scope = $1 AND key = $2 AND conclusion IS NULL
        AND submission <> 'delivered' AND cancel_reason IS NULL AND next_at <= $4`,
      [scopeKey, key, error instanceof Error ? error.message : String(error), now, now + (this.options.backoffMs ?? 30_000)]);
    });
  }

  private async try(scopeKey: string, key: string): Promise<boolean> {
    const claim = await this.claim(scopeKey, key);
    if (claim === 'skipped') return false;
    if (claim === 'expired') return true;
    const scope = JSON.parse(scopeKey) as string;
    let outcome: 'delivered' | 'stopped' | { error: unknown };
    try { outcome = await submitFrozen(this.options.port(scope), claim.input, () => this.now() < claim.waitUntil); }
    catch (error) { outcome = { error }; }
    await this.settleTry(claim, outcome);
    return true;
  }

  /** Step 1: under the scope lock, expire an untried row, or take the lease and raise `tries`. */
  private claim(scopeKey: string, key: string): Promise<Claim | 'skipped' | 'expired'> {
    return inSchema(this.pool, this.schema, async client => {
      await lockScope(client, scopeKey);
      const now = this.now();
      const found = await client.query<{ agent: string; ordinal: string; tries: number; wait_until: string; input: FrozenInput }>(
        `SELECT agent, ordinal::text, tries, wait_until::text, input FROM intent WHERE scope = $1 AND key = $2
          AND conclusion IS NULL AND submission <> 'delivered' AND cancel_reason IS NULL AND next_at <= $3 FOR UPDATE`, [scopeKey, key, now]);
      const row = found.rows[0];
      if (!row) return 'skipped';
      // The K4 head: the lowest open sequence of the agent. A delivered head still holds its queue.
      const open = await client.query<{ key: string; ordinal: string }>(
        'SELECT key, ordinal::text FROM intent WHERE scope = $1 AND agent = $2 AND conclusion IS NULL', [scopeKey, row.agent]);
      const [head] = fifoHeads(open.rows.map(other => ({ key: other.key, agent: row.agent, sequence: Number(other.ordinal) })));
      if (head?.key !== key) return 'skipped';
      const waitUntil = Number(row.wait_until);
      if (row.tries === 0) {
        const conclusion = queuedExpiry({ waitUntil }, now);
        if (conclusion) {
          await client.query('UPDATE intent SET conclusion = $3 WHERE scope = $1 AND key = $2', [scopeKey, key, conclusion]);
          return 'expired';
        }
      }
      const raised = await client.query<{ tries: number }>(`UPDATE intent SET submission = 'uncertain', tries = tries + 1, next_at = $3
        WHERE scope = $1 AND key = $2 RETURNING tries`, [scopeKey, key, now + (this.options.leaseMs ?? 60_000)]);
      return { scopeKey, key, tries: raised.rows[0]!.tries, input: row.input, waitUntil };
    });
  }

  /** Step 3: the late write of one try, fenced by its `tries` value. */
  private async settleTry(claim: Claim, outcome: 'delivered' | 'stopped' | { error: unknown }): Promise<void> {
    await inSchema(this.pool, this.schema, async client => {
      await lockScope(client, claim.scopeKey);
      const fence = `WHERE scope = $1 AND key = $2 AND tries = $3 AND submission <> 'delivered'`;
      const values = [claim.scopeKey, claim.key, claim.tries];
      if (outcome === 'delivered') await client.query(`UPDATE intent SET submission = 'delivered', last_error = NULL ${fence}`, values);
      else if (outcome === 'stopped') await client.query(`UPDATE intent SET cancel_reason = 'expired' ${fence}`, values);
      else {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        await client.query(`UPDATE intent SET last_error = $4, next_at = $5 ${fence}`,
          [...values, message, this.now() + (this.options.backoffMs ?? 30_000)]);
      }
    });
  }
}

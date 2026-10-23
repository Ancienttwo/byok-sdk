import type { Pool, PoolClient } from 'pg';
import { agentKey, canonical, fifoHeads, queuedExpiry, submitFrozen, taskId,
  type ExecutionTemplate, type FrozenInput, type FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import type { Turn } from '@byok-sdk/example-bot-collaboration/model';
import type { SyncFacts, SyncStep } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { SUPPORTED_STORE_VERSIONS } from './ddl';
import { storedKey } from './layout';
import { inSchema, lockScope } from './store';

/** What a Turn freezes: the `freeze` step input of the sync rule. `key` is the Turn id. */
export interface IntentFreeze { key: string; source: 'user' | 'bot'; waitUntil: number; execution: ExecutionTemplate }

/**
 * Saves one intent with its frozen input and its stable task id, `taskId(key, 0)`. The caller holds the scope lock.
 * A second freeze of the same Turn with the same identity changes nothing; another identity throws, as in K4 `enqueue`.
 */
export async function freezeIntent(client: PoolClient, scope: string, freeze: IntentFreeze): Promise<FrozenInput> {
  const scopeKey = storedKey(scope), key = storedKey(freeze.key);
  const input: FrozenInput = { ...structuredClone(freeze.execution), taskId: taskId(freeze.key, 0) };
  const prior = await client.query<{ source: string; input: string; wait_until: string }>(
    'SELECT source, input::text AS input, wait_until::text FROM intent WHERE scope = $1 AND key = $2', [scopeKey, key]);
  if (prior.rows[0]) {
    const row = prior.rows[0];
    if (row.source !== freeze.source || canonical(JSON.parse(row.input)) !== canonical(input) || Number(row.wait_until) !== freeze.waitUntil) {
      throw new Error('Intent identity conflict');
    }
    return input;
  }
  await client.query(`INSERT INTO intent (scope, key, task_id, ordinal, agent, source, input, wait_until, submission)
    SELECT $1, $2, $3, coalesce(max(ordinal) + 1, 0), $4, $5, $6::json, $7, 'reserved' FROM intent WHERE scope = $1`,
  [scopeKey, key, input.taskId, agentKey(scope, freeze.execution), freeze.source, JSON.stringify(input), freeze.waitUntil]);
  return input;
}

/** The frozen input of a task and the Turn that froze it. The input never changes after the freeze. */
export async function frozenIntent(client: PoolClient, scope: string, task: string): Promise<{ turnId: string; input: FrozenInput } | undefined> {
  const found = await client.query<{ key: string; input: FrozenInput }>('SELECT key, input FROM intent WHERE scope = $1 AND task_id = $2',
    [storedKey(scope), task]);
  const row = found.rows[0];
  return row && { turnId: JSON.parse(row.key) as string, input: row.input };
}

type IntentFact = NonNullable<ReturnType<SyncFacts['intent']>>;
/**
 * The sync rule facts of these Turns, read in the sync transaction. H records no execution start before D2d,
 * and retires no Turn id before D2g.
 */
export async function syncFacts(client: PoolClient, scope: string, turnIds: readonly string[]): Promise<SyncFacts> {
  const found = await client.query<{ key: string; task_id: string; conclusion: IntentFact['conclusion'] | null; cancel_reason: IntentFact['cancelReason'] | null }>(
    'SELECT key, task_id, conclusion, cancel_reason FROM intent WHERE scope = $1 AND key = ANY($2::text[])', [storedKey(scope), turnIds.map(storedKey)]);
  const facts = new Map(found.rows.map(row => [row.key, { taskId: row.task_id, ...(row.conclusion ? { conclusion: row.conclusion } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}) } satisfies IntentFact]));
  return { intent: turnId => facts.get(storedKey(turnId)), executionStarted: () => false, retired: () => undefined };
}

/** Writes the intent side of one sync step, as L writes it to K4. The caller holds the scope lock. */
export async function writeSyncStep(client: PoolClient, scope: string, turn: Turn, step: SyncStep<ExecutionTemplate>): Promise<void> {
  if (step.kind === 'freeze') await freezeIntent(client, scope, step.input);
  else if (step.kind === 'cancel') {
    await client.query(`UPDATE intent SET cancel_reason = 'cancelled' WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turn.id)]);
  } else if (step.kind === 'routine' || turn.source === 'routine') throw new Error('H has no routine Turns before #793 D2f');
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
    // The NOT EXISTS head filter must match K4 fifoHeads, which the claim checks again under the scope lock.
    // A scope of a store version this code does not support is left out before the limit: its rows cannot be
    // claimed or written, so they must not fill a pass ahead of the healthy scopes.
    const due = await inSchema(this.pool, this.schema, client => client.query<{ scope: string; key: string }>(
      `SELECT i.scope, i.key FROM intent i JOIN scope s ON s.scope = i.scope
        WHERE s.state_version = ANY($3::integer[]) AND i.conclusion IS NULL AND i.submission <> 'delivered' AND i.cancel_reason IS NULL
        AND i.next_at <= $1 AND NOT EXISTS (SELECT 1 FROM intent o WHERE o.scope = i.scope AND o.agent = i.agent
          AND o.conclusion IS NULL AND o.ordinal < i.ordinal)
        ORDER BY i.next_at, i.scope, i.ordinal LIMIT $2`, [this.now(), this.options.batch ?? 100, [...SUPPORTED_STORE_VERSIONS]]), true);
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
    try { outcome = await submitFrozen(this.options.port(scope), claim.input, () => this.mayStillSubmit(claim)); }
    catch (error) { outcome = { error }; }
    await this.settleTry(claim, outcome);
    return true;
  }

  /**
   * The K4 check right before the SDK call: the wait is open, and the row has no conclusion and no cancel reason.
   * It reads outside the scope lock, so a sync cancel after this read can still reach the SDK. D2d's attempt check
   * is the guard for that case.
   */
  private async mayStillSubmit(claim: Claim): Promise<boolean> {
    const found = await inSchema(this.pool, this.schema, client => client.query<{ open: boolean }>(
      'SELECT conclusion IS NULL AND cancel_reason IS NULL AS open FROM intent WHERE scope = $1 AND key = $2', [claim.scopeKey, claim.key]), true);
    // The clock is read after the round trip, so a read that crosses the deadline stops the submit.
    return found.rows[0]?.open === true && this.now() < claim.waitUntil;
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
      // A sync cancel during the try keeps its reason.
      else if (outcome === 'stopped') await client.query(`UPDATE intent SET cancel_reason = 'expired' ${fence} AND cancel_reason IS NULL`, values);
      else {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        await client.query(`UPDATE intent SET last_error = $4, next_at = $5 ${fence}`,
          [...values, message, this.now() + (this.options.backoffMs ?? 30_000)]);
      }
    });
  }
}

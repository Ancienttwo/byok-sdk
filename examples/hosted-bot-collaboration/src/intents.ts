import type { Pool, PoolClient } from 'pg';
import { agentKey, canonical, fifoHeads, hash, promoteOccurrence, queuedExpiry, RetiredIntentIdentityError, submitFrozen, taskId,
  type Conclusion, type ExecutionTemplate, type FrozenInput, type FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState, Turn } from '@byok-sdk/example-bot-collaboration/model';
import { concludeRoutineTurn, routineOccurrence } from '@byok-sdk/example-bot-collaboration/routines';
import type { IntentConclusions } from '@byok-sdk/example-bot-collaboration/delivery-routing';
import type { SeatFacts, settleDelegations, SyncFacts, SyncStep } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { activeBinding, DeviceBindingError, deviceRefusals } from './binding';
import { SUPPORTED_STORE_VERSIONS } from './ddl';
import { idOf, storedKey } from './layout';
import { retiredIntents, retiredTurns } from './retention';
import { switchDueVersions, type RoutineSlice } from './routines';
import { inSchema, lockScope } from './store';

/**
 * What a Turn freezes: the `freeze` step input of the sync rule, or a promoted routine occurrence. `key` is the Turn id.
 * A Host intent (#955) has its own key and the name of its handler.
 */
export interface IntentFreeze { key: string; source: 'user' | 'bot' | 'routine'; waitUntil: number; execution: ExecutionTemplate; handler?: string }
/** The K4 times of a promoted routine intent (#793 D2f): its retry bound, and `superseded` when a newer slot already exists. */
export interface RoutineTimes { retryUntil?: number; conclusion?: Conclusion }

/**
 * Saves one intent with its frozen input and its stable task id, `taskId(key, 0)`. The caller holds the scope lock.
 * A second freeze of the same Turn with the same identity changes nothing; another identity throws, as in K4 `enqueue`.
 * The handler is part of the identity, so a Turn never takes over a Host intent row, and a Host intent never a Turn's.
 * A Turn whose intent compaction retired throws `RetiredIntentIdentityError`, as K4 `enqueue` refuses a retired key (#793 S8).
 */
export async function freezeIntent(client: PoolClient, scope: string, freeze: IntentFreeze, routine: RoutineTimes = {}): Promise<FrozenInput> {
  // H never retries a task (#793 D2d option A), so it cannot honor a K4 retry policy. It refuses one instead of dropping it.
  if ((freeze as IntentFreeze & { retry?: unknown }).retry !== undefined) throw new Error('H intents have no retry policy');
  const scopeKey = storedKey(scope), key = storedKey(freeze.key);
  const input: FrozenInput = { ...structuredClone(freeze.execution), taskId: taskId(freeze.key, 0) };
  const prior = await client.query<{ source: string; handler: string | null; input: string; wait_until: string }>(
    'SELECT source, handler, input::text AS input, wait_until::text FROM intent WHERE scope = $1 AND key = $2', [scopeKey, key]);
  if (prior.rows[0]) {
    const row = prior.rows[0];
    if (row.source !== freeze.source || row.handler !== (freeze.handler ?? null) || canonical(JSON.parse(row.input)) !== canonical(input)
      || Number(row.wait_until) !== freeze.waitUntil) {
      throw new Error('Intent identity conflict');
    }
    return input;
  }
  if ((await retiredIntents(client, scopeKey, [freeze.key])).size) throw new RetiredIntentIdentityError();
  // A new intent can create execution, so its device must have an active H binding (#793 D2e).
  await activeBinding(client, scopeKey, freeze.execution.deviceId);
  await client.query(`INSERT INTO intent (scope, key, task_id, ordinal, agent, source, handler, input, wait_until, submission, retry_until, conclusion)
    SELECT $1, $2, $3, coalesce(max(ordinal) + 1, 0), $4, $5, $10, $6::json, $7, 'reserved', $8, $9 FROM intent WHERE scope = $1`,
  [scopeKey, key, input.taskId, agentKey(scope, freeze.execution), freeze.source, JSON.stringify(input), freeze.waitUntil,
    routine.retryUntil ?? null, routine.conclusion ?? null, freeze.handler ?? null]);
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
 * The intent facts of these Turns, read from the intent rows in the caller's transaction, the keys of the started rows, the
 * envelope type and decline code of each row's terminal, and the frozen device of each open row whose delivered offer no
 * device has claimed: K8 `intentFacts.offeredTo` (delegation.ts) in H's columns, where the stored SDK attempt is still
 * `offered`. The reconciliation writes that attempt, so this fact lags the SDK by up to its poll interval.
 */
async function loadIntentFacts(client: PoolClient, scope: string, turnIds: readonly string[]) {
  const found = await client.query<{ key: string; task_id: string; conclusion: IntentFact['conclusion'] | null;
    cancel_reason: IntentFact['cancelReason'] | null; started: boolean; terminal_type: string | null; decline_code: string | null;
    offered_to: string | null }>(
    `SELECT key, task_id, conclusion, cancel_reason, started, terminal->'envelope'->>'type' AS terminal_type,
      terminal->'envelope'->'payload'->>'code' AS decline_code,
      CASE WHEN conclusion IS NULL AND submission = 'delivered' AND NOT started AND attempt->>'status' = 'offered'
        THEN input->>'deviceId' END AS offered_to
      FROM intent WHERE scope = $1 AND key = ANY($2::text[])`,
    [storedKey(scope), turnIds.map(storedKey)]);
  const facts = new Map(found.rows.map(row => [row.key, { taskId: row.task_id, ...(row.conclusion ? { conclusion: row.conclusion } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}) } satisfies IntentFact]));
  return { intent: (turnId: string) => facts.get(storedKey(turnId)), started: new Set(found.rows.filter(row => row.started).map(row => row.key)),
    terminals: new Map(found.rows.flatMap(row => row.terminal_type === null ? [] : [[row.key, { type: row.terminal_type, code: row.decline_code }] as const])),
    offered: new Map(found.rows.flatMap(row => row.offered_to === null ? [] : [[row.key, row.offered_to] as const])) };
}
/**
 * The intent facts that a command reads (K8 `CommandPorts.intents`), as L reads its K4 intents in the commit transaction.
 * The caller holds the scope lock.
 */
export async function commandIntentFacts(client: PoolClient, scope: string, turnIds: readonly string[]): Promise<Pick<SyncFacts, 'intent'>> {
  const { intent } = await loadIntentFacts(client, scope, turnIds);
  return { intent };
}
/**
 * The K8 room seat facts (#793 S6), from the intent rows of the seat Turns, as K8 `advanceRooms` (rooms.ts) reads L's K4
 * intents: `admitted` when the seat Turn has an intent, `started` from the reconciliation's claim fact, and the conclusion.
 * The caller holds the scope lock.
 */
export async function seatFacts(client: PoolClient, scope: string, seatIds: readonly string[]): Promise<Record<string, SeatFacts>> {
  const { intent, started } = await loadIntentFacts(client, scope, seatIds);
  return Object.fromEntries(seatIds.map(id => {
    const row = intent(id);
    return [id, { admitted: row !== undefined, started: started.has(storedKey(id)), ...(row?.conclusion ? { conclusion: row.conclusion } : {}) }];
  }));
}
/**
 * The sync rule facts of these Turns, read in the sync transaction. `started` is the reconciliation's attempt fact
 * (D2d). `retired` reads the intent tombstones of compaction (S8) and the Turn tombstones of retention (D2g).
 * `deviceRefusal` (#956) reads the binding of each Bot's current device once, so the K8 step holds a Turn whose device a
 * freeze would refuse, and the rest of the scope syncs. The freeze still checks the binding as the last guard.
 */
export async function syncFacts(client: PoolClient, scope: string, turnIds: readonly string[], bots: CollaborationState['team']['bots']): Promise<SyncFacts> {
  const { intent, started } = await loadIntentFacts(client, scope, turnIds);
  // Retention retires Turn ids (#793 D2g). Compaction retires intents (#793 S8): a compacted intent comes first, as in L's sync.
  const retired = await retiredTurns(client, storedKey(scope), turnIds), compacted = await retiredIntents(client, storedKey(scope), turnIds);
  const devices = await deviceRefusals(client, storedKey(scope), [...new Set(Object.values(bots).map(bot => bot.execution.deviceId))]);
  return { intent, executionStarted: turnId => started.has(storedKey(turnId)),
    retired: turnId => compacted.has(turnId) ? 'result_retired' : retired.has(turnId) ? 'turn_retired' : undefined,
    deviceRefusal: botId => Object.hasOwn(bots, botId) ? devices.get(bots[botId]!.execution.deviceId) : undefined };
}

/**
 * K4 `cancel` of the open intent of Turn `turnId`, then the K4 drain's `queuedExpiry` for a row that no submit tried: the
 * claim runs under the same scope lock, so that row has no SDK call. A tried row keeps its cancel reason and waits for the
 * reconciliation to check its attempt. Returns true when the row concluded. The caller holds the scope lock.
 */
export async function cancelIntent(client: PoolClient, scope: string, turnId: string, now: number): Promise<boolean> {
  const [scopeKey, key] = [storedKey(scope), storedKey(turnId)];
  const found = await client.query<{ tries: number; wait_until: string; retry_until: string | null }>(`UPDATE intent SET cancel_reason = 'cancelled'
    WHERE scope = $1 AND key = $2 AND conclusion IS NULL RETURNING tries, wait_until::text, retry_until::text`, [scopeKey, key]);
  const row = found.rows[0];
  if (!row || row.tries > 0) return false;
  const conclusion = queuedExpiry({ cancelReason: 'cancelled', waitUntil: Number(row.wait_until),
    ...(row.retry_until === null ? {} : { retryUntil: Number(row.retry_until) }) }, now);
  await client.query('UPDATE intent SET conclusion = $3 WHERE scope = $1 AND key = $2', [scopeKey, key, conclusion]);
  return true;
}

/**
 * The intent conclusions that the K8 delivery rules read (#793 D2b-out-2), keyed by K4 `hash(turnId)` as L's ledger keys
 * its intents. The caller holds the scope lock.
 */
export async function intentConclusions(client: PoolClient, scope: string): Promise<IntentConclusions> {
  const rows = await client.query<{ key: string; conclusion: Conclusion | null }>('SELECT key, conclusion FROM intent WHERE scope = $1', [storedKey(scope)]);
  return { intents: Object.fromEntries(rows.rows.map(row => [hash(idOf(row.key)), row.conclusion === null ? {} : { conclusion: row.conclusion }])) };
}

/**
 * K8 `deliverCancels` (host.ts): the K4 cancel of the frozen target of each committed delegation cancel fact, then
 * `delivered`. L marks a fact delivered whatever K4 finds, and so does H. The caller holds the scope lock and writes
 * `state` in the same transaction. Returns true when it delivered a fact.
 */
export async function deliverCancels(client: PoolClient, scope: string, state: CollaborationState, now: number): Promise<boolean> {
  let delivered = false;
  for (const d of Object.values(state.delegations)) {
    if (!d.cancel || d.cancel.delivered) continue;
    await cancelIntent(client, scope, d.cancel.targetTurnId, now);
    d.cancel.delivered = true;
    delivered = true;
  }
  return delivered;
}

/**
 * The K4 facts that K8 `settleDelegations` (#793 D2f-5) and `observeDevices` (#793 S11) read, from the intent rows of these
 * Turns, as K8 `intentFacts` reads them from L's ledger. H keeps generation 0 only, so "any generation" is this row: it
 * started when the reconciliation saw a claim (`started`) or it has a terminal that is not a decline. The caller holds the
 * scope lock.
 */
export async function settleFacts(client: PoolClient, scope: string, turnIds: readonly string[]): Promise<SettleFacts> {
  const { intent, started, terminals, offered } = await loadIntentFacts(client, scope, turnIds);
  return {
    intent,
    started: turnId => {
      const terminal = terminals.get(storedKey(turnId));
      return started.has(storedKey(turnId)) || terminal !== undefined && terminal.type !== 'task.decline';
    },
    declineCode: turnId => {
      const terminal = terminals.get(storedKey(turnId));
      return terminal?.type === 'task.decline' ? terminal.code ?? undefined : undefined;
    },
    offeredTo: turnId => offered.get(storedKey(turnId)),
  };
}
type SettleFacts = Parameters<typeof settleDelegations>[1];

/**
 * Writes the intent side of one sync step, as L writes it to K4 (K8 commit.ts). A routine step and a routine Turn's `ended`
 * step run the K4 rules on `slice`, which the caller writes back after the last step. The caller holds the scope lock.
 * Returns true when the step changed an intent fact or an occurrence, so the sync runs its Turns again, as L drains again.
 */
export async function writeSyncStep(client: PoolClient, scope: string, turn: Turn, step: SyncStep<ExecutionTemplate>, slice: RoutineSlice,
  now: number): Promise<boolean> {
  if (step.kind === 'freeze') {
    await freezeIntent(client, scope, step.input);
    return true;
  }
  if (step.kind === 'routine') {
    // K4 times the intent from the occurrence record. The row takes the step's execution and those times, not the K4
    // retry policy, because H never retries (#793 D2d option A). The freeze checks the device binding (#793 D2e).
    const intent = promoteOccurrence(slice.state, scope, routineOccurrence(turn), step.execution);
    await freezeIntent(client, scope, { key: turn.id, source: 'routine', waitUntil: intent.waitUntil, execution: step.execution },
      { ...(intent.retryUntil === undefined ? {} : { retryUntil: intent.retryUntil }), ...(intent.conclusion ? { conclusion: intent.conclusion } : {}) });
    return true;
  }
  // A concluded occurrence can make a staged version due (K8 commit.ts:54).
  if (step.kind === 'ended') return turn.source === 'routine' && concludeRoutineTurn(slice.state, turn);
  // An untried row concludes now, and L drains again for it.
  if (step.kind === 'cancel') return cancelIntent(client, scope, turn.id, now);
  return false;
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
type Claim = { scopeKey: string; key: string; tries: number; input: FrozenInput; waitUntil: number; modeRevision: number };
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
    const open = await inSchema(this.pool, this.schema, async client => {
      const found = await client.query<{ open: boolean }>(
        'SELECT conclusion IS NULL AND cancel_reason IS NULL AS open FROM intent WHERE scope = $1 AND key = $2', [claim.scopeKey, claim.key]);
      if (found.rows[0]?.open !== true) return false;
      // The device binding must still be the one that the claim saw (#793 D2e). A change throws, so the try backs off
      // with the error; a stop would record an expiry.
      if (await activeBinding(client, claim.scopeKey, claim.input.deviceId) !== claim.modeRevision) {
        throw new DeviceBindingError(claim.input.deviceId, 'revision');
      }
      return true;
    }, true);
    // The clock is read after the round trip, so a read that crosses the deadline stops the submit.
    return open && this.now() < claim.waitUntil;
  }

  /** Step 1: under the scope lock, expire an untried row, or take the lease and raise `tries`. */
  private claim(scopeKey: string, key: string): Promise<Claim | 'skipped' | 'expired'> {
    return inSchema(this.pool, this.schema, async client => {
      await lockScope(client, scopeKey);
      const now = this.now();
      const found = await client.query<{ agent: string; ordinal: string; tries: number; wait_until: string; retry_until: string | null; input: FrozenInput }>(
        `SELECT agent, ordinal::text, tries, wait_until::text, retry_until::text, input FROM intent WHERE scope = $1 AND key = $2
          AND conclusion IS NULL AND submission <> 'delivered' AND cancel_reason IS NULL AND next_at <= $3 FOR UPDATE`, [scopeKey, key, now]);
      const row = found.rows[0];
      if (!row) return 'skipped';
      // The K4 head: the lowest open sequence of the agent. A delivered head still holds its queue.
      const open = await client.query<{ key: string; ordinal: string }>(
        'SELECT key, ordinal::text FROM intent WHERE scope = $1 AND agent = $2 AND conclusion IS NULL', [scopeKey, row.agent]);
      const [head] = fifoHeads(open.rows.map(other => ({ key: other.key, agent: row.agent, sequence: Number(other.ordinal) })));
      if (head?.key !== key) return 'skipped';
      const waitUntil = Number(row.wait_until);
      // K4 `begin`: an untried row stops at `wait_until`, or at `retry_until` when a newer routine slot ends its retries.
      // A tried row keeps its submit to `wait_until`, as K4 `submit` does not read `retryUntil`.
      if (row.tries === 0) {
        const conclusion = queuedExpiry({ waitUntil, ...(row.retry_until === null ? {} : { retryUntil: Number(row.retry_until) }) }, now);
        if (conclusion) {
          await client.query('UPDATE intent SET conclusion = $3 WHERE scope = $1 AND key = $2', [scopeKey, key, conclusion]);
          await switchDueVersions(client, scopeKey, now);
          return 'expired';
        }
      }
      // The try can create execution, so the device must have an active H binding (#793 D2e). A throw backs the row off.
      const modeRevision = await activeBinding(client, scopeKey, row.input.deviceId);
      const raised = await client.query<{ tries: number }>(`UPDATE intent SET submission = 'uncertain', tries = tries + 1, next_at = $3
        WHERE scope = $1 AND key = $2 RETURNING tries`, [scopeKey, key, now + (this.options.leaseMs ?? 60_000)]);
      return { scopeKey, key, tries: raised.rows[0]!.tries, input: row.input, waitUntil, modeRevision };
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

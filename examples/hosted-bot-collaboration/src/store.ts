import type { Pool, PoolClient } from 'pg';
import { canonical, occurrenceRun, type Conclusion, type ExecutionTemplate, type Json, type Routine } from '@byok-sdk/example-host-execution-core';
import { botRoutines, owned, routineTurn, updateDefinition, type BotRoutineInput } from '@byok-sdk/example-bot-collaboration/routines';
import { requireMain } from '@byok-sdk/example-bot-collaboration/team';
/** A K8 `update_routine` action. */
type UpdateRoutineAction = Parameters<typeof updateDefinition>[2];
import { stateOf, type CollaborationState, type Turn } from '@byok-sdk/example-bot-collaboration/model';
import { commitCommand, syncTurn, type Command, type CommandPorts, type SyncOptions, type SyncStep } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { revisionOf, type CommitRequest, type CommitResult, type OutboxIntent } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { activeBinding, bindDevice, revokeDevice } from './binding';
import { DDL, STORE_VERSION, SUPPORTED_STORE_VERSIONS } from './ddl';
import { cancelIntent, deliverCancels, syncFacts, writeSyncStep } from './intents';
import { decideMessage, messageCommandId, type AgentMessageInput, type MessageDecision } from './messages';
import { decideFinish, type TaskEvidence } from './reconcile';
import { commitStored, decideRetention } from './retention';
import { dueRoutine, hostedRoutineCommands, loadSlice, planSlice, recordDue, switchDueVersions, writeSlice } from './routines';
import type { RetentionInput, RetentionLimits, RetentionResult } from '@byok-sdk/example-bot-collaboration/retention';
import { assemble, entryGroup, split, storedKey, type EntityKind, type EntryKind, type Split } from './layout';

/** A stored scope row of a store version that this code does not support. Nothing was written. */
export class HostedStoreVersionError extends Error {
  constructor(readonly version: number) { super(`Unsupported hosted collaboration store version ${version}`); this.name = 'HostedStoreVersionError'; }
}
export type Publish = (id: string, value: Json) => void;
export type Decision<T> = { value: T; outbox: OutboxIntent[] };
type Decide<T> = (state: CollaborationState, publish: Publish, client: PoolClient) => Decision<T> | Promise<Decision<T>>;
type TurnHistory = NonNullable<SyncOptions<never>['history']>;
/**
 * The sync options of a scope. In history mode, `history` holds the rows of each Turn that may freeze, by Turn id.
 * The store reads the routines itself (#793 D2f).
 */
export type HostedSyncOptions = Omit<SyncOptions<never>, 'history' | 'routines'> & { history?: ReadonlyMap<string, TurnHistory> };
/**
 * Builds the command ports on the state of the open commit. `publish` writes a projection in the same commit. The store
 * reads the intent facts itself, under the scope lock (#793 D2f-4).
 */
export type PortsFactory = (state: CollaborationState, publish: Publish) => Omit<CommandPorts, 'intents'>;

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
const EMPTY_FRAME = split(stateOf({})).frame;

/**
 * The H store of the #739 D1 commit contract (#793 D2a): one Postgres transaction holds the state change,
 * the command record and the outbox rows. A commit locks its scope row first, so the commits of one scope
 * run one at a time. H has no K4 to deduplicate terminals and messages, so it records callbacks too.
 */
export class HostedCollaborationStore {
  constructor(private readonly pool: Pool, readonly schema: string) {
    if (!SCHEMA.test(schema)) throw new Error('Invalid hosted collaboration schema name');
  }

  /** Creates the schema and its tables when they are absent. */
  async migrate(): Promise<void> {
    await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hosted-collaboration:${this.schema}`]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await client.query(DDL);
    }, false);
  }

  /**
   * Runs one command through the commit contract. `scope` is the scope that the authenticated caller owns;
   * a request for another scope is a `scope_mismatch` conflict. A throw leaves every row unchanged.
   *
   * A new `cancel_turn` of a Turn with a frozen intent runs the K4 cancel in the same transaction, in L's order (K8
   * host.ts `cancelTurn`): the commit, the cancel of the intent, then the version switch check (#793 D2f-4). A new commit
   * that leaves a delegation cancel fact to deliver (`cancel_turn` of an open chain, `cancel_delegation`,
   * `abandon_delegation`) delivers it in the same transaction, as L `settleChain` does after its commit.
   */
  commit(scope: string, request: CommitRequest<Command>, ports: PortsFactory): Promise<CommitResult> {
    const key = storedKey(scope);
    return this.change(scope, request.commandId, async (state, publish, client) => {
      const head = revisionOf(state), base = ports(state, publish);
      const result = await commitStored(client, scope, state, request, base);
      // A new commit moves the head by 1. A replay returns its first result and writes nothing.
      if (result.revision !== head + 1) return { value: result, outbox: [] };
      const value = result.disposition.outcome === 'accepted'
        ? result.disposition.value as { target?: string; admitted?: boolean; deliver?: boolean } | undefined : undefined;
      if (request.command.kind === 'cancel_turn' && value?.admitted && value.target !== undefined) {
        const now = base.now();
        await cancelIntent(client, scope, value.target, now);
        await switchDueVersions(client, key, now);
      } else if (value?.deliver) await deliverCancels(client, scope, state, base.now());
      return { value: result, outbox: result.outbox };
    });
  }

  /** Changes a scope's state outside the commit contract, in one transaction. For seeds and fixtures. */
  async seed(scope: string, mutate: (state: CollaborationState) => void): Promise<void> {
    await this.change(scope, undefined, state => { mutate(state); return { value: undefined, outbox: [] }; });
  }

  /** The stored state of a scope, with every command record. A scope row of an unknown store version is refused. */
  async read(scope: string): Promise<CollaborationState> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      const head = await client.query<{ state_version: number; frame: string }>('SELECT state_version, frame::text AS frame FROM scope WHERE scope = $1', [key]);
      if (head.rows[0] && !SUPPORTED_STORE_VERSIONS.has(head.rows[0].state_version)) throw new HostedStoreVersionError(head.rows[0].state_version);
      const rows = await this.load(client, key, head.rows[0]?.frame ?? EMPTY_FRAME, undefined);
      return stateOf({ collaboration: assemble(rows) as unknown as Json });
    }, true);
  }

  /** Every stored row of a scope, in a fixed order, as text. */
  async dump(scope: string): Promise<string> {
    return this.transaction(async client => {
      const rows = [];
      for (const query of [
        'SELECT state_version, frame::text FROM scope WHERE scope = $1',
        'SELECT kind, key, ordinal::text, body::text FROM entity WHERE scope = $1 ORDER BY kind, key',
        'SELECT kind, owner, position::text, body::text FROM entry WHERE scope = $1 ORDER BY kind, owner, position',
        'SELECT key, ordinal::text, evidence, result::text, root FROM command WHERE scope = $1 ORDER BY key',
        'SELECT key, ordinal::text, kind, body::text FROM outbox WHERE scope = $1 ORDER BY key',
        `SELECT key, task_id, ordinal::text, agent, source, input::text, wait_until::text, submission, tries, next_at::text, last_error,
          cancel_reason, conclusion, started, attempt::text, terminal::text, reconcile_at::text, retry_until::text FROM intent WHERE scope = $1 ORDER BY key`,
        'SELECT device, ordinal::text, mode, mode_revision::text, revoked_at::text FROM device_binding WHERE scope = $1 ORDER BY device',
        'SELECT identity FROM retired_identity WHERE scope = $1 ORDER BY identity',
        'SELECT namespace, id, body::text, expires_at::text FROM archived_row WHERE scope = $1 ORDER BY namespace, id',
        `SELECT id, ordinal::text, definition::text, pending::text, lifecycle, status, next_at::text, calendar_errors::text FROM routine
          WHERE scope = $1 ORDER BY id`,
        `SELECT key, ordinal::text, routine_id, definition_version, trigger_kind, planned_at::text, recorded_at::text, next_at::text,
          execution_superseded, conclusion FROM occurrence WHERE scope = $1 ORDER BY key`,
      ]) rows.push((await client.query({ text: query, values: [storedKey(scope)], rowMode: 'array' })).rows);
      return JSON.stringify(rows);
    }, true);
  }

  /**
   * One Host sync of a scope (#793 D2b-2): the sync rule for each stored Turn, in insertion order, in one transaction
   * under the scope lock. It reads the intent facts in that transaction, and writes each step with the state and the
   * projections. Every frozen instruction lists the scope's Bot routines, in insertion order. A routine Turn joins the FIFO
   * as its occurrence intent, and a routine Turn that ends before that concludes its occurrence (#793 D2f). It writes no
   * command record and keeps the revision. A throw writes nothing.
   *
   * It runs to a fixed point, as the L pass drains again after a step that changed K4 (K8 host.ts pass): while a round
   * froze, promoted or concluded an intent or an occurrence, it reads the facts again and runs the Turns again. Each such
   * step happens once per intent or occurrence, so the rounds end.
   */
  sync(scope: string, options: HostedSyncOptions): Promise<void> {
    const key = storedKey(scope);
    return this.change(scope, undefined, async (state, publish, client) => {
      const published = new Set<string>();
      const slice = await loadSlice(client, key), routines = botRoutines(Object.values(slice.state.routines));
      let more = true;
      while (more) {
        const facts = await syncFacts(client, scope, Object.keys(state.turns));
        const steps: Array<[Turn, SyncStep<ExecutionTemplate>]> = [];
        for (const turn of Object.values(state.turns)) {
          const step = syncTurn(state, turn, facts, { ...options, routines, history: options.history?.get(turn.id) },
            (id, body) => { publish(id, body); published.add(id); });
          if (step) steps.push([turn, step]);
        }
        more = false;
        for (const [turn, step] of steps) more = await writeSyncStep(client, scope, turn, step, slice, options.now) || more;
      }
      await writeSlice(client, key, slice);
      await switchDueVersions(client, key, options.now);
      return { value: undefined, outbox: [...published].map(id => ({ kind: 'projection' as const, id })) };
    });
  }

  /**
   * Owner API for the Main Bot's own routines (#793 D2f), as L `updateRoutine` (K8 host.ts:462-467): stages the next version of
   * routine `action.routineId` of Bot `botId`. The authenticated command entry calls it. A refusal writes nothing.
   */
  updateRoutine(scope: string, botId: string, action: UpdateRoutineAction, now: number): Promise<void> {
    return this.routineCommand(scope, botId, now, commands => commands.update(updateDefinition(commands.list(), botId, action)));
  }
  /** Owner API, as L `setRoutineLifecycle` (K8 host.ts:456-461): pauses, resumes or completes a routine of the Main Bot `botId`. */
  setRoutineLifecycle(scope: string, botId: string, id: string, lifecycle: Routine['lifecycle'], now: number): Promise<void> {
    return this.routineCommand(scope, botId, now, commands => commands.lifecycle(owned(commands.list(), botId, id).definition.id, lifecycle));
  }
  private routineCommand(scope: string, botId: string, now: number, run: (commands: ReturnType<typeof hostedRoutineCommands>) => void): Promise<void> {
    const key = storedKey(scope);
    return this.change(scope, undefined, async (state, _publish, client) => {
      // H has no Host-wide Bot id, so the caller names the acting Bot. Only the Main Bot owns this API.
      requireMain(state.team, botId);
      const slice = await loadSlice(client, key);
      run(hostedRoutineCommands(slice, now));
      await writeSlice(client, key, slice);
      await switchDueVersions(client, key, now);
      return { value: undefined, outbox: [] };
    });
  }

  /**
   * Fires the due slot of routine `id` (#793 D2f-3, scheduler note §2.2), as K4 `consume` records an occurrence and runs its
   * hook in one transaction: the occurrence row, the routine's next slot, the supersede of its earlier untried intents and
   * the K8 routine Turn commit together, under the scope lock. The K8 `occurrence` command gets no record, as in L: the slot
   * is the replay guard. A routine that is not active, or whose slot is not due, is `skipped` with nothing written: another
   * pass fired it, or a command changed it.
   *
   * The fire can create execution, so the owner Bot's device must have an active H binding (#793 D2e), read from the state of
   * this transaction, as the sync builds the routine offer from it. Otherwise it throws `DeviceBindingError` and writes
   * nothing, and the slot stays due. The promotion checks the binding again. An archived owner Bot skips the fence: its
   * routine Turn creates no execution, because the sync ends it before any freeze, as L does. A revoke and an archive are both
   * final, so with the fence that slot could never fire.
   *
   * It runs no version switch: a fire leaves its new occurrence open, so K4 `versionSwitchDue` stays false for the routine.
   */
  fire(scope: string, id: string, now: number): Promise<'fired' | 'skipped'> {
    const key = storedKey(scope);
    return this.transaction(client => this.decideIn(client, key, undefined, async (state, publish) => {
      const slice = await loadSlice(client, key), routine = dueRoutine(slice, id, now);
      if (!routine) return { value: 'skipped' as const, outbox: [] };
      const owner = (routine.definition.hostOccurrence?.input as BotRoutineInput | undefined)?.owner;
      const bot = owner === undefined ? undefined : state.team.bots[owner];
      if (!bot) throw new Error('Routine owner Bot not found');
      if (!bot.archived) await activeBinding(client, key, bot.execution.deviceId);
      const occurrence = recordDue(slice, scope, routine, now);
      const run = occurrenceRun(routine, occurrence);
      const result = commitCommand(state, { scope, commandId: occurrence.key, command: { kind: 'occurrence', key: occurrence.key } },
        { scope, recordCallbacks: false }, { now: () => now, publish, occurrence: () => routineTurn(state, run) });
      await writeSlice(client, key, slice, occurrence.key);
      return { value: 'fired' as const, outbox: result.outbox };
    }), false);
  }

  /**
   * The schedule upkeep of the scope's routines (#793 D2f-3, scheduler note §2.6), under the scope lock. `start` re-plans an
   * active routine with no slot within the horizon, as K4 `recover`. Both phases set `ok` on a `schedule_retrying` routine
   * whose slot is within the horizon, as K4 `scheduleNext`. Then a staged version switches when it is due.
   */
  planRoutines(scope: string, now: number, phase: 'start' | 'pass'): Promise<void> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      await lockScope(client, key);
      const slice = await loadSlice(client, key);
      planSlice(slice, now, phase);
      await writeSlice(client, key, slice);
      await switchDueVersions(client, key, now);
    }, false);
  }

  /**
   * The SDK `agentMessage.consume` decision for one Agent message of `scope` (#793 D2c), as K4 `consumeMessage` decides it.
   * One transaction under the scope lock checks the frozen binding and the task's accepted reply, and commits the `message`
   * command. A scope with no row has no task, so it is refused with nothing written. A throw writes nothing and leaves the
   * SDK admission pending.
   */
  consume(scope: string, input: AgentMessageInput, ports: PortsFactory): Promise<MessageDecision> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      if (!(await client.query('SELECT 1 FROM scope WHERE scope = $1', [key])).rows[0]) return { outcome: 'refused', reasonCode: 'unknown_task' };
      return this.decideIn(client, key, messageCommandId(input), (state, publish) => decideMessage(client, scope, state, publish, input, ports));
    }, false);
  }

  /**
   * The terminal transaction of one reconciled task of `scope` (#793 D2d), as K4 `finish`: the outcome command, the
   * projections and the intent's conclusion commit together, under the scope lock. Returns the conclusion that it wrote,
   * or nothing when the intent already had one. A throw writes nothing.
   */
  finish(scope: string, turnId: string, evidence: TaskEvidence, ports: PortsFactory): Promise<Conclusion | undefined> {
    return this.transaction(client => this.decideIn(client, storedKey(scope), evidence.terminal.envelope.task_id,
      (state, publish) => decideFinish(client, scope, turnId, state, publish, evidence, ports)), false);
  }

  /**
   * One K8 retention call on `scope` (#793 D2g, #798), in one transaction under the scope lock: the acknowledged roots move
   * into `archived_row`, their ids are retired in `retired_identity`, and the moved command records answer replays until
   * they expire. A refusal or a throw writes nothing. A scope with no row has no rows to retain, so the rule runs on the
   * empty state, as L runs it on an empty ledger.
   */
  retain(scope: string, input: RetentionInput, limits: RetentionLimits): Promise<RetentionResult> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      if (!(await client.query('SELECT 1 FROM scope WHERE scope = $1', [key])).rowCount) return decideRetention(client, key, stateOf({}), input, limits);
      return this.decideIn(client, key, undefined, async state => ({ value: await decideRetention(client, key, state, input, limits), outbox: [] }));
    }, false);
  }

  /**
   * Binds a device of `scope` to H (#793 D2e) and returns its mode revision. A second bind changes nothing. A revoked
   * device id throws `DeviceBindingError` (#793 O1 option A).
   */
  bindDevice(scope: string, deviceId: string): Promise<number> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      await this.upsertScope(client, key);
      await lockScope(client, key);
      return bindDevice(client, key, deviceId);
    }, false);
  }

  /**
   * Revokes a device id of `scope` for good, and raises its mode revision. A second revoke changes nothing. An id that was
   * never bound, also in a new scope, gets a revoked tombstone row.
   */
  revokeDevice(scope: string, deviceId: string, revokedAt: number): Promise<void> {
    const key = storedKey(scope);
    return this.transaction(async client => {
      await this.upsertScope(client, key);
      await lockScope(client, key);
      await revokeDevice(client, key, deviceId, revokedAt);
    }, false);
  }

  private change<T>(scope: string, commandId: string | undefined, decide: Decide<T>): Promise<T> {
    // #793 O4: each table stores the scope as JSON text, so two scopes that UTF-8 would merge stay apart.
    const key = storedKey(scope);
    return this.transaction(async client => {
      await this.upsertScope(client, key);
      return this.decideIn(client, key, commandId, decide);
    }, false);
  }

  /** Upsert, then lock: a missing scope row would lock nothing, and two first writes would race. */
  private async upsertScope(client: PoolClient, key: string): Promise<void> {
    await client.query('INSERT INTO scope (scope, state_version, frame) VALUES ($1, $2, $3::json) ON CONFLICT (scope) DO NOTHING',
      [key, STORE_VERSION, EMPTY_FRAME]);
  }

  /** Locks the scope row, runs `decide` on the loaded state, and writes the changed rows and the outbox. */
  private async decideIn<T>(client: PoolClient, key: string, commandId: string | undefined, decide: Decide<T>): Promise<T> {
    const frame = await lockScope(client, key);
    const rows = await this.load(client, key, frame, commandId);
    const state = stateOf({ collaboration: assemble(rows) as unknown as Json });
    const before = split(state);
    const published = new Map<string, Json>();
    const { value, outbox } = await decide(state, (id, body) => {
      if (published.has(id) && canonical(published.get(id)!) !== canonical(body)) throw new Error('Projection identity conflict');
      published.set(id, structuredClone(body));
    }, client);
    await this.write(client, key, rows, before, split(state));
    await this.writeOutbox(client, key, outbox, published);
    return value;
  }

  /** Loads the scope's entities and entries, and only the one command record that a commit can replay. `scopeKey` is the stored scope key. */
  private async load(client: PoolClient, scopeKey: string, frame: string, commandId: string | undefined): Promise<Split & { ordinals: Map<EntityKind, Map<string, number>> }> {
    const rows: Split & { ordinals: Map<EntityKind, Map<string, number>> } =
      { frame, entities: new Map(), entries: new Map(), commands: new Map(), ordinals: new Map() };
    const entities = await client.query<{ kind: EntityKind; key: string; ordinal: string; body: string }>(
      'SELECT kind, key, ordinal::text, body::text FROM entity WHERE scope = $1 ORDER BY kind, ordinal', [scopeKey]);
    for (const row of entities.rows) {
      if (!rows.entities.has(row.kind)) { rows.entities.set(row.kind, new Map()); rows.ordinals.set(row.kind, new Map()); }
      rows.entities.get(row.kind)!.set(row.key, row.body);
      rows.ordinals.get(row.kind)!.set(row.key, Number(row.ordinal));
    }
    const entries = await client.query<{ kind: EntryKind; owner: string; position: string; body: string }>(
      'SELECT kind, owner, position::text, body::text FROM entry WHERE scope = $1 ORDER BY kind, owner, position', [scopeKey]);
    for (const row of entries.rows) {
      const group = entryGroup(row.kind, row.owner);
      if (!rows.entries.has(group)) rows.entries.set(group, { kind: row.kind, owner: row.owner, bodies: [] });
      const bodies = rows.entries.get(group)!.bodies;
      if (Number(row.position) !== bodies.length) throw new Error(`Stored ${row.kind} positions have a gap`);
      bodies.push(row.body);
    }
    const commands = await client.query<{ key: string; evidence: string; result: string; root: string | null }>(commandId === undefined
      ? 'SELECT key, evidence, result::text, root FROM command WHERE scope = $1 ORDER BY ordinal'
      : 'SELECT key, evidence, result::text, root FROM command WHERE scope = $1 AND key = $2',
    commandId === undefined ? [scopeKey] : [scopeKey, storedKey(commandId)]);
    for (const row of commands.rows) {
      rows.commands.set(row.key, { evidence: row.evidence, result: row.result, ...(row.root === null ? {} : { root: row.root }) });
    }
    return rows;
  }

  /** Writes only the rows that changed. A new row of a kind gets the next ordinal of that kind. */
  private async write(client: PoolClient, scopeKey: string, loaded: { ordinals: Map<EntityKind, Map<string, number>> }, before: Split, after: Split): Promise<void> {
    if (after.frame !== before.frame) await client.query('UPDATE scope SET frame = $2::json WHERE scope = $1', [scopeKey, after.frame]);
    for (const kind of new Set([...before.entities.keys(), ...after.entities.keys()])) {
      const old = before.entities.get(kind) ?? new Map<string, string>(), next = after.entities.get(kind) ?? new Map<string, string>();
      const ordinals = loaded.ordinals.get(kind) ?? new Map<string, number>();
      let ordinal = [...ordinals.values()].reduce((max, value) => Math.max(max, value), -1) + 1;
      for (const key of old.keys()) if (!next.has(key)) await client.query('DELETE FROM entity WHERE scope = $1 AND kind = $2 AND key = $3', [scopeKey, kind, key]);
      for (const [key, body] of next) {
        if (!old.has(key)) await client.query('INSERT INTO entity (scope, kind, key, ordinal, body) VALUES ($1, $2, $3, $4, $5::json)', [scopeKey, kind, key, ordinal++, body]);
        else if (old.get(key) !== body) await client.query('UPDATE entity SET body = $4::json WHERE scope = $1 AND kind = $2 AND key = $3', [scopeKey, kind, key, body]);
      }
    }
    for (const group of new Set([...before.entries.keys(), ...after.entries.keys()])) {
      const { kind, owner } = (after.entries.get(group) ?? before.entries.get(group))!;
      const old = before.entries.get(group)?.bodies ?? [], next = after.entries.get(group)?.bodies ?? [];
      if (next.length < old.length) await client.query('DELETE FROM entry WHERE scope = $1 AND kind = $2 AND owner = $3 AND position >= $4', [scopeKey, kind, owner, next.length]);
      for (const [position, body] of next.entries()) {
        if (position >= old.length) await client.query('INSERT INTO entry (scope, kind, owner, position, body) VALUES ($1, $2, $3, $4, $5::json)', [scopeKey, kind, owner, position, body]);
        else if (old[position] !== body) await client.query('UPDATE entry SET body = $5::json WHERE scope = $1 AND kind = $2 AND owner = $3 AND position = $4', [scopeKey, kind, owner, position, body]);
      }
    }
    for (const [key, record] of after.commands) {
      const prior = before.commands.get(key);
      if (prior && prior.evidence === record.evidence && prior.result === record.result && prior.root === record.root) continue;
      if (prior) throw new Error('A command record cannot change');
      await client.query(`INSERT INTO command (scope, key, ordinal, evidence, result, root)
        SELECT $1, $2, coalesce(max(ordinal) + 1, 0), $3, $4::json, $5 FROM command WHERE scope = $1`, [scopeKey, key, record.evidence, record.result, record.root ?? null]);
    }
  }

  /**
   * Saves each outbox intent of the commit. An existing projection with the same id must hold the same value;
   * otherwise the commit throws and rolls back, as the K4 projection does in L.
   */
  private async writeOutbox(client: PoolClient, scopeKey: string, outbox: OutboxIntent[], published: Map<string, Json>): Promise<void> {
    for (const intent of outbox) {
      const body = intent.kind === 'projection' ? published.get(intent.id) : undefined;
      if (intent.kind === 'projection' && body === undefined) throw new Error('A projection intent has no published value');
      const key = storedKey(intent.id);
      const prior = await client.query<{ kind: string; body: string | null }>('SELECT kind, body::text FROM outbox WHERE scope = $1 AND key = $2', [scopeKey, key]);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.kind !== intent.kind || (body !== undefined && canonical(JSON.parse(row.body!) as Json) !== canonical(body))) {
          throw new Error(intent.kind === 'projection' ? 'Projection identity conflict' : 'Delivery identity conflict');
        }
        continue;
      }
      await client.query(`INSERT INTO outbox (scope, key, ordinal, kind, body)
        SELECT $1, $2, coalesce(max(ordinal) + 1, 0), $3, $4::json FROM outbox WHERE scope = $1`,
      [scopeKey, key, intent.kind, body === undefined ? null : JSON.stringify(body)]);
    }
  }

  private transaction<T>(work: (client: PoolClient) => Promise<T>, readOnly: boolean): Promise<T> {
    return inSchema(this.pool, this.schema, work, readOnly);
  }
}

/** Runs `work` in one transaction with `search_path` set to `schema`. A throw rolls back every row. */
export async function inSchema<T>(pool: Pool, schema: string, work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  if (!SCHEMA.test(schema)) throw new Error('Invalid hosted collaboration schema name');
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    // A client whose rollback failed is broken: release it with the error, so the pool drops it.
    broken = await client.query('ROLLBACK').then(() => undefined, (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure)));
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * Locks an existing scope row for the rest of the transaction and returns its frame. Every writer of a scope
 * takes this lock first. A scope row of an unknown store version is refused before any write.
 */
export async function lockScope(client: PoolClient, scopeKey: string): Promise<string> {
  const head = await client.query<{ state_version: number; frame: string }>(
    'SELECT state_version, frame::text AS frame FROM scope WHERE scope = $1 FOR UPDATE', [scopeKey]);
  if (!head.rows[0]) throw new Error('Unknown hosted collaboration scope');
  if (!SUPPORTED_STORE_VERSIONS.has(head.rows[0].state_version)) throw new HostedStoreVersionError(head.rows[0].state_version);
  return head.rows[0].frame;
}

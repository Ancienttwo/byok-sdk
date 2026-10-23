import type { Pool, PoolClient } from 'pg';
import { canonical, type ExecutionTemplate, type Json } from '@byok-sdk/example-host-execution-core';
import { stateOf, type CollaborationState, type Turn } from '@byok-sdk/example-bot-collaboration/model';
import { commitCommand, syncTurn, type Command, type CommandPorts, type SyncOptions, type SyncStep } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { revisionOf, type CommitRequest, type CommitResult, type OutboxIntent } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { DDL, STORE_VERSION, SUPPORTED_STORE_VERSIONS } from './ddl';
import { syncFacts, writeSyncStep } from './intents';
import { decideMessage, messageCommandId, type AgentMessageInput, type MessageDecision } from './messages';
import { assemble, entryGroup, split, storedKey, type EntityKind, type EntryKind, type Split } from './layout';

/** A stored scope row of a store version that this code does not support. Nothing was written. */
export class HostedStoreVersionError extends Error {
  constructor(readonly version: number) { super(`Unsupported hosted collaboration store version ${version}`); this.name = 'HostedStoreVersionError'; }
}
export type Publish = (id: string, value: Json) => void;
export type Decision<T> = { value: T; outbox: OutboxIntent[] };
type Decide<T> = (state: CollaborationState, publish: Publish, client: PoolClient) => Decision<T> | Promise<Decision<T>>;
type TurnHistory = NonNullable<SyncOptions<never>['history']>;
/** The sync options of a scope. In history mode, `history` holds the rows of each Turn that may freeze, by Turn id. */
export type HostedSyncOptions = Omit<SyncOptions<never>, 'history'> & { history?: ReadonlyMap<string, TurnHistory> };
/** Builds the command ports on the state of the open commit. `publish` writes a projection in the same commit. */
export type PortsFactory = (state: CollaborationState, publish: Publish) => CommandPorts;

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
   */
  commit(scope: string, request: CommitRequest<Command>, ports: PortsFactory): Promise<CommitResult> {
    return this.change(scope, request.commandId, (state, publish) => {
      const head = revisionOf(state);
      const result = commitCommand(state, request, { scope, recordCallbacks: true }, ports(state, publish));
      // A new commit moves the head by 1. A replay returns its first result and writes nothing.
      return { value: result, outbox: result.revision === head + 1 ? result.outbox : [] };
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
          cancel_reason, conclusion FROM intent WHERE scope = $1 ORDER BY key`,
      ]) rows.push((await client.query({ text: query, values: [storedKey(scope)], rowMode: 'array' })).rows);
      return JSON.stringify(rows);
    }, true);
  }

  /**
   * One Host sync of a scope (#793 D2b-2): the sync rule for each stored Turn, in insertion order, in one transaction
   * under the scope lock. It reads the intent facts in that transaction, and writes each step with the state and the
   * projections. It writes no command record and keeps the revision. A throw writes nothing.
   */
  sync(scope: string, options: HostedSyncOptions): Promise<void> {
    return this.change(scope, undefined, async (state, publish, client) => {
      const facts = await syncFacts(client, scope, Object.keys(state.turns)), published = new Set<string>();
      const steps: Array<[Turn, SyncStep<ExecutionTemplate>]> = [];
      for (const turn of Object.values(state.turns)) {
        const step = syncTurn(state, turn, facts, { ...options, history: options.history?.get(turn.id) },
          (id, body) => { publish(id, body); published.add(id); });
        if (step) steps.push([turn, step]);
      }
      for (const [turn, step] of steps) await writeSyncStep(client, scope, turn, step);
      return { value: undefined, outbox: [...published].map(id => ({ kind: 'projection' as const, id })) };
    });
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

  private change<T>(scope: string, commandId: string | undefined, decide: Decide<T>): Promise<T> {
    // #793 O4: each table stores the scope as JSON text, so two scopes that UTF-8 would merge stay apart.
    const key = storedKey(scope);
    return this.transaction(async client => {
      // Upsert, then lock: a missing scope row would lock nothing, and two first commits would race.
      await client.query('INSERT INTO scope (scope, state_version, frame) VALUES ($1, $2, $3::json) ON CONFLICT (scope) DO NOTHING',
        [key, STORE_VERSION, EMPTY_FRAME]);
      return this.decideIn(client, key, commandId, decide);
    }, false);
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

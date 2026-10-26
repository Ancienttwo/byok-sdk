import type { PoolClient } from 'pg';
import { hash, time, type Json, type LedgerDumpTombstone } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState, Turn } from '@byok-sdk/example-bot-collaboration/model';
import { retainRoots, RetentionRefused, type RetentionInput, type RetentionLimits, type RetentionResult,
  type RetentionStore } from '@byok-sdk/example-bot-collaboration/retention';
import { commitCommand, refuseRetired, retiredIdentity, type AdmittedIds, type Command, type CommandPorts,
  type RetiredNamespace } from '@byok-sdk/example-bot-collaboration/rules/commands';
import type { CommandRecord, CommitRequest, CommitResult } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { queueDelivery } from '@byok-sdk/example-bot-collaboration/delivery-routing';
import { commandIntentFacts, intentConclusions } from './intents';
import { storedKey } from './layout';
import { loadSlice } from './routines';

type AcceptedReply = CollaborationState['replies'][string];

// The K4 application row limits (K4 ledger.ts:52-58), checked on the raw values.
const NAMESPACE_MAX = 128, ID_MAX = 1024;
function checkRow(namespace: string, id?: string): void {
  if (typeof namespace !== 'string' || !namespace || namespace.length > NAMESPACE_MAX) throw new Error('Invalid application row namespace');
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > ID_MAX)) throw new Error('Invalid application row id');
}

/** One archived row of a scope, as K4 `ApplicationRows.get` reads it: an expired row stays until a retention call removes it. */
export async function archivedRow(client: PoolClient, scopeKey: string, namespace: string, id: string): Promise<Json | undefined> {
  const found = await client.query<{ body: Json }>('SELECT body FROM archived_row WHERE scope = $1 AND namespace = $2 AND id = $3',
    [scopeKey, namespace, storedKey(id)]);
  return found.rows[0]?.body;
}
/** The accepted reply of a task: in the state, or archived with its Turn (K8 retention moves it with no expiry). */
export async function acceptedReply(client: PoolClient, scopeKey: string, state: CollaborationState, taskId: string): Promise<AcceptedReply | undefined> {
  return Object.hasOwn(state.replies, taskId) ? state.replies[taskId] : await archivedRow(client, scopeKey, 'replies', taskId) as AcceptedReply | undefined;
}

/** A kind of K4 `host_retired_identity`, `row` included. */
type TombstoneKind = LedgerDumpTombstone['kind'];
/**
 * The tombstones of `kind` among `hashes`. As K4's readers of `row` and `intent` tombstones (`ledger.ts` isRetired and the
 * transaction guard), the expiry is not read here.
 */
async function retiredHashes(client: PoolClient, scopeKey: string, kind: TombstoneKind, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const found = await client.query<{ identity: string }>(
    'SELECT identity FROM retired_identity WHERE scope = $1 AND kind = $2 AND identity = ANY($3::text[])', [scopeKey, kind, hashes]);
  return new Set(found.rows.map(row => row.identity));
}
/** Loads the tombstones of `ids` and returns a lookup, as K4 `isRetired`. A query outside `ids` throws. */
async function tombstones(client: PoolClient, scopeKey: string, ids: Array<[RetiredNamespace | 'root', string]>) {
  const asked = new Set(ids.map(([namespace, id]) => hash([namespace, id])));
  const retired = await retiredHashes(client, scopeKey, 'row', [...asked]);
  return (namespace: string, id: string): boolean => {
    checkRow(namespace, id);
    const identity = hash([namespace, id]);
    if (!asked.has(identity)) throw new Error('A tombstone was read that the store did not load');
    return retired.has(identity);
  };
}
const identities = (namespace: RetiredNamespace, id: string): Array<[RetiredNamespace, string]> =>
  namespace === 'round' ? [['round', id]] : [['turn', id], ['input', id]];

/** The intent tombstone of a Turn id (#793 S8): compaction removed its intent row for good. K4's intent id, `hash(key)`. */
export const intentIdentity = (turnId: string): string => hash(turnId);
/** The Turn ids among `turnIds` whose intent compaction retired (#793 S8). */
export async function retiredIntents(client: PoolClient, scopeKey: string, turnIds: readonly string[]): Promise<Set<string>> {
  const retired = await retiredHashes(client, scopeKey, 'intent', turnIds.map(intentIdentity));
  return new Set(turnIds.filter(id => retired.has(intentIdentity(id))));
}
/** Writes permanent tombstones of `kind`. A tombstone already there becomes permanent, as K4's row retire does. */
export async function retire(client: PoolClient, scopeKey: string, kind: TombstoneKind, identities: Iterable<string>): Promise<void> {
  for (const identity of identities) {
    await client.query(`INSERT INTO retired_identity (scope, kind, identity, expires_at) VALUES ($1, $2, $3, NULL)
      ON CONFLICT (scope, kind, identity) DO UPDATE SET expires_at = NULL`, [scopeKey, kind, identity]);
  }
}

/** The Turn ids among `turnIds` that retention retired (#798), as L reads them in its sync (K8 `commit.ts`). */
export async function retiredTurns(client: PoolClient, scopeKey: string, turnIds: readonly string[]): Promise<Set<string>> {
  const isRetired = await tombstones(client, scopeKey, turnIds.flatMap(id => identities('turn', id)));
  return new Set(turnIds.filter(id => retiredIdentity('turn', id, isRetired)));
}

/**
 * One command through the commit contract in the store's transaction, as L `commitInLedger` runs it (#798): a record that
 * retention moved still answers a replay, and an id that retention retired is refused at admission. A throw rolls back.
 */
export async function commitStored(client: PoolClient, scope: string, state: CollaborationState, request: CommitRequest<Command>,
  ports: Omit<CommandPorts, 'intents' | 'deliver' | 'outcome'> & { outcome?: Omit<NonNullable<CommandPorts['outcome']>, 'committed'> },
  channel: boolean): Promise<CommitResult> {
  const scopeKey = storedKey(scope), command = request.command, { outcome, ...rest } = ports;
  // The channel outbox port of a K4 callback, as L's (K8 host.ts `deliverPort`). The delivery rules read the intent
  // conclusions committed before this command, so the view is read here, before any write of this transaction (#793 D2b-out-2).
  const taskId = command.kind === 'message' ? command.message.taskId : command.kind === 'outcome' ? command.taskId : undefined;
  const conclusions = channel && taskId !== undefined ? await intentConclusions(client, scope) : undefined;
  const deliver = conclusions && taskId !== undefined
    ? { deliver: (turn: Turn, key: string, text: string) => queueDelivery(conclusions, state, turn, taskId, key, text, ports.now())?.id } : {};
  // The intent facts come from the intent rows in this transaction, never from the caller (#793 D2f-4). So do the committed
  // intents of an outcome, which a Main Bot cancel reads.
  const intents = await commandIntentFacts(client, scope, Object.keys(state.turns));
  const archived = typeof request.commandId === 'string' && request.commandId
    ? await archivedRow(client, scopeKey, 'commands', request.commandId) as CommandRecord | undefined : undefined;
  let admitted: AdmittedIds | undefined;
  const result = commitCommand(state, request, { scope, recordCallbacks: true,
    // As K4 `rows.get` in L: a keyed command that is not in the state checks its row id here, and an over-limit id throws.
    archived: (id: string) => { checkRow('commands', id); return id === request.commandId ? archived : undefined; },
    admitted: ids => { admitted = ids; } }, { ...rest, ...deliver, intents, ...(outcome ? { outcome: { ...outcome, committed: intents } } : {}) });
  if (admitted) {
    const ids = admitted as AdmittedIds;
    const isRetired = await tombstones(client, scopeKey, (['turn', 'input', 'round'] as const).flatMap(namespace =>
      ids[namespace].flatMap(id => identities(namespace, id))));
    refuseRetired(ids, isRetired);
  }
  return result;
}

/**
 * K8 `retainRoots` in the store's transaction, under the scope lock (#793 D2g). The rule is synchronous, so the store loads
 * what it reads first (the command expiry, the root tombstones it can ask for, the intent rows) and writes its rows after
 * it returns. A moved command record leaves the `command` table in the same transaction. A throw writes nothing.
 */
export async function decideRetention(client: PoolClient, scopeKey: string, state: CollaborationState, input: RetentionInput,
  limits: RetentionLimits): Promise<RetentionResult> {
  const now = time(input.now);
  const expired = (await client.query(`DELETE FROM archived_row WHERE scope = $1 AND namespace = 'commands' AND expires_at <= $2`,
    [scopeKey, now])).rowCount ?? 0;
  const roots = [...(Array.isArray(input.acknowledgedRoots) ? input.acknowledgedRoots : []),
    ...Object.values(state.commands ?? {}).flatMap(record => record.root === undefined ? [] : [record.root])]
    .filter((root): root is string => typeof root === 'string' && !!root && root.length <= ID_MAX);
  const loaded = await tombstones(client, scopeKey, roots.map(root => ['root', root]));
  const intents = new Set((await client.query<{ key: string }>('SELECT key FROM intent WHERE scope = $1 AND key = ANY($2::text[])',
    [scopeKey, Object.keys(state.turns).map(storedKey)])).rows.map(row => row.key));
  // The occurrences that are not concluded: K8 refuses a routine root while its occurrence is open (#793 D2f).
  const openOccurrences = new Set(Object.keys((await loadSlice(client, scopeKey)).state.occurrences));
  const puts = new Map<string, { namespace: string; id: string; value: Json; expiresAt: number | null }>(), retired = new Set<string>();
  const store: RetentionStore = {
    put(namespace, id, value, expiresAt) {
      checkRow(namespace, id);
      puts.set(JSON.stringify([namespace, id]), { namespace, id, value, expiresAt: expiresAt === undefined ? null : time(expiresAt) });
    },
    expire(namespace) {
      if (namespace !== 'commands') throw new Error('H expires only command records');
      return expired;
    },
    retire(namespace, id) { checkRow(namespace, id); retired.add(hash([namespace, id])); },
    isRetired(namespace, id) { checkRow(namespace, id); return retired.has(hash([namespace, id])) || loaded(namespace, id); },
  };
  // The root of each Turn before K8 moves it, for a refusal of the delivery outbox check below.
  const rootOf = new Map(Object.values(state.turns).map(turn => [turn.id, turn.root]));
  const result = retainRoots(state, input, limits, {
    hasIntent: turnId => intents.has(storedKey(turnId)),
    occurrenceOpen: turnId => openOccurrences.has(turnId.slice('occurrence:'.length)),
  }, store);
  for (const row of puts.values()) {
    const body = JSON.stringify(row.value);
    if (typeof body !== 'string') throw new Error('An application row must be JSON');
    await client.query(`INSERT INTO archived_row (scope, namespace, id, body, expires_at) VALUES ($1, $2, $3, $4::json, $5)
      ON CONFLICT (scope, namespace, id) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at`,
    [scopeKey, row.namespace, storedKey(row.id), body, row.expiresAt]);
    // A delivery leaves the state only after the sender settled its outbox row (#793 D2b-out E7). K8 already refuses an
    // unsettled delivery entity; this keeps the index from losing a row that the sender still needs.
    if (row.namespace === 'deliveries' && (await client.query(`SELECT 1 FROM outbox WHERE scope = $1 AND key = $2 AND kind = 'delivery'
      AND settled_at IS NULL`, [scopeKey, storedKey(row.id)])).rowCount) {
      const turnId = (row.value as { turnId: string }).turnId;
      throw new RetentionRefused('protected_root', rootOf.get(turnId) ?? turnId, 'A delivery outbox row of the root is not settled');
    }
    if (row.namespace === 'commands') await client.query('DELETE FROM command WHERE scope = $1 AND key = $2', [scopeKey, storedKey(row.id)]);
  }
  await retire(client, scopeKey, 'row', retired);
  return result;
}

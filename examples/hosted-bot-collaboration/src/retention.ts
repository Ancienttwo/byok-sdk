import type { PoolClient } from 'pg';
import { hash, time, type Json } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { retainRoots, type RetentionInput, type RetentionLimits, type RetentionResult,
  type RetentionStore } from '@byok-sdk/example-bot-collaboration/retention';
import { commitCommand, refuseRetired, retiredIdentity, type AdmittedIds, type Command, type CommandPorts,
  type RetiredNamespace } from '@byok-sdk/example-bot-collaboration/rules/commands';
import type { CommandRecord, CommitRequest, CommitResult } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { storedKey } from './layout';

type AcceptedReply = CollaborationState['replies'][string];

// The K4 application row limits (K4 ledger.ts:52-58), checked on the raw values.
const NAMESPACE_MAX = 128, ID_MAX = 1024;
function checkRow(namespace: string, id?: string): void {
  if (typeof namespace !== 'string' || !namespace || namespace.length > NAMESPACE_MAX) throw new Error('Invalid application row namespace');
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > ID_MAX)) throw new Error('Invalid application row id');
}

/** One archived row of a scope, as K4 `ApplicationRows.get` reads it: an expired row stays until a retention call removes it. */
async function archivedRow(client: PoolClient, scopeKey: string, namespace: string, id: string): Promise<Json | undefined> {
  const found = await client.query<{ body: Json }>('SELECT body FROM archived_row WHERE scope = $1 AND namespace = $2 AND id = $3',
    [scopeKey, namespace, storedKey(id)]);
  return found.rows[0]?.body;
}
/** The accepted reply of a task: in the state, or archived with its Turn (K8 retention moves it with no expiry). */
export async function acceptedReply(client: PoolClient, scopeKey: string, state: CollaborationState, taskId: string): Promise<AcceptedReply | undefined> {
  return Object.hasOwn(state.replies, taskId) ? state.replies[taskId] : await archivedRow(client, scopeKey, 'replies', taskId) as AcceptedReply | undefined;
}

/** The tombstones among `hashes`. */
async function retiredHashes(client: PoolClient, scopeKey: string, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const found = await client.query<{ identity: string }>('SELECT identity FROM retired_identity WHERE scope = $1 AND identity = ANY($2::text[])',
    [scopeKey, hashes]);
  return new Set(found.rows.map(row => row.identity));
}
/** Loads the tombstones of `ids` and returns a lookup, as K4 `isRetired`. A query outside `ids` throws. */
async function tombstones(client: PoolClient, scopeKey: string, ids: Array<[RetiredNamespace | 'root', string]>) {
  const asked = new Set(ids.map(([namespace, id]) => hash([namespace, id])));
  const retired = await retiredHashes(client, scopeKey, [...asked]);
  return (namespace: string, id: string): boolean => {
    const identity = hash([namespace, id]);
    if (!asked.has(identity)) throw new Error('A tombstone was read that the store did not load');
    return retired.has(identity);
  };
}
const identities = (namespace: RetiredNamespace, id: string): Array<[RetiredNamespace, string]> =>
  namespace === 'round' ? [['round', id]] : [['turn', id], ['input', id]];

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
  ports: CommandPorts): Promise<CommitResult> {
  const scopeKey = storedKey(scope);
  const archived = typeof request.commandId === 'string' && request.commandId
    ? await archivedRow(client, scopeKey, 'commands', request.commandId) as CommandRecord | undefined : undefined;
  let admitted: AdmittedIds | undefined;
  const result = commitCommand(state, request, { scope, recordCallbacks: true,
    ...(archived ? { archived: (id: string) => id === request.commandId ? archived : undefined } : {}),
    admitted: ids => { admitted = ids; } }, ports);
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
  const result = retainRoots(state, input, limits, {
    hasIntent: turnId => intents.has(storedKey(turnId)),
    occurrenceOpen: () => { throw new Error('H has no routine Turns before #793 D2f'); },
  }, store);
  for (const row of puts.values()) {
    const body = JSON.stringify(row.value);
    if (typeof body !== 'string') throw new Error('An application row must be JSON');
    await client.query(`INSERT INTO archived_row (scope, namespace, id, body, expires_at) VALUES ($1, $2, $3, $4::json, $5)
      ON CONFLICT (scope, namespace, id) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at`,
    [scopeKey, row.namespace, storedKey(row.id), body, row.expiresAt]);
    if (row.namespace === 'commands') await client.query('DELETE FROM command WHERE scope = $1 AND key = $2', [scopeKey, storedKey(row.id)]);
  }
  for (const identity of retired) {
    await client.query('INSERT INTO retired_identity (scope, identity) VALUES ($1, $2) ON CONFLICT DO NOTHING', [scopeKey, identity]);
  }
  return result;
}

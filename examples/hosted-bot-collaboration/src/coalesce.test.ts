import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrozenInput } from '@byok-sdk/example-host-execution-core';
import { coalescePolicy, type CoalescePolicy } from '@byok-sdk/example-bot-collaboration/coalesce';
import { coalesceVectors, seedCollaboration, SYNC_OPTIONS, type CoalesceSubject, type SyncIntentRecord } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { vectorPorts } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedCollaborationStore, type CommitPortsFactory } from './store';

// #793 H batch seal: input coalescing in the H commit and sync, as L's.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const table = (name: string) => `"${opened!.store.schema}".${name}`;
const input = (key: string) => ({ kind: 'input' as const, botId: 'main', key, request: key, sender: 'owner' });

/** One H subject per call: a store with `policy`, and a new scope seeded like the memory subject, its Bot bound for a freeze. */
async function hosted(policy?: CoalescePolicy): Promise<CoalesceSubject & { store: HostedCollaborationStore }> {
  const store = new HostedCollaborationStore(opened!.pool, opened!.store.schema, policy ? { coalesce: policy } : {});
  const scope = `tenant:${randomUUID()}`, pool = opened!.pool;
  await store.seed(scope, state => seedCollaboration(state));
  await store.bindDevice(scope, 'device');
  return {
    scope, store,
    commit: request => store.commit(scope, request, vectorPorts),
    stored: () => store.dump(scope),
    state: () => store.read(scope),
    change: edit => store.seed(scope, edit),
    sync: now => store.sync(scope, { ...SYNC_OPTIONS, now, history: undefined }),
    intent: async turnId => {
      const row = (await pool.query<{ key: string; source: SyncIntentRecord['source']; input: FrozenInput; wait_until: string }>(
        `SELECT key, source, input, wait_until::text FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId)])).rows[0];
      if (!row) return undefined;
      const { taskId: _, ...execution } = row.input;
      return { key: JSON.parse(row.key) as string, source: row.source, waitUntil: Number(row.wait_until), execution };
    },
    concludeIntent: async (turnId, conclusion) => {
      await pool.query(`UPDATE ${table('intent')} SET conclusion = $3 WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turnId), conclusion]);
    },
    projection: async id => (await pool.query<{ body: never }>(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2 AND kind = 'projection'`,
      [storedKey(scope), storedKey(id)])).rows.map(row => row.body),
  };
}

describe.skipIf(POSTGRES_URL === undefined)('H input coalescing on real Postgres (#793 H batch seal)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  coalesceVectors('H HostedCollaborationStore on Postgres', hosted);

  it('checks the policy at construction with K8 coalescePolicy', () => {
    expect(() => new HostedCollaborationStore(opened!.pool, opened!.store.schema, { coalesce: { windowMs: 10, maxItems: 2, maxBytes: 4096 } }))
      .toThrow('coalesce.windowMs must be an integer from 1000 to 60000');
  });

  it('refuses a sync whose ContextPack budget is too small for the policy, and writes nothing', async () => {
    const subject = await hosted(coalescePolicy({ maxBytes: 8192 }, 32_768)), before = await subject.stored();
    await expect(subject.store.sync(subject.scope, { ...SYNC_OPTIONS, limits: { ...SYNC_OPTIONS.limits, contextMaxBytes: 16_384 }, history: undefined }))
      .rejects.toThrow('coalesce.maxBytes must be an integer from 1024 to 4096');
    expect(await subject.stored()).toBe(before);
  });

  it('admits each input with its own policy, never with a port that a caller slips past the type', async () => {
    const subject = await hosted(coalescePolicy({}, 32_768)), called: string[] = [];
    const slipped = ((...args: Parameters<CommitPortsFactory>) => ({ ...vectorPorts(...args),
      admitInput: (fields: { id: string }) => { called.push(fields.id); return fields.id; } })) as unknown as CommitPortsFactory;
    // `t1` is open, so the Bot is busy and the input opens a batch.
    await subject.store.commit(subject.scope, { scope: subject.scope, commandId: 'c1', command: input('k1') }, slipped);
    expect(called).toEqual([]);
    expect(Object.values((await subject.state()).inputBatches ?? {})).toMatchObject([{ state: 'open' }]);
    // @ts-expect-error The commit ports carry no input admission.
    const withAdmit: CommitPortsFactory = (state, publish) => ({ ...vectorPorts(state, publish), admitInput: () => 'x' });
    expect(typeof withAdmit).toBe('function');
  });
});

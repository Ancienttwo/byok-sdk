import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ByokCloudOptions } from '@byok-sdk/cloud';
import { taskId } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { seedCollaboration } from '@byok-sdk/example-bot-collaboration/test-support';
import { freezeIntent } from './intents';
import { storedKey } from './layout';
import { vectorClock } from './memory-subject.test-support';
import { hostedMessageConsumer, type AgentMessageInput } from './messages';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedStoreVersionError, inSchema, lockScope } from './store';

// The H port of the K4 Host-side message vectors (host-execution-core/src/message.test.ts), which hold the Host half
// of the #651 exact-accepted invariant: a replay gets the same decision, and only the exact accepted message is accepted.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const execution = { ...template('device'), agentMessageContext: { destinationBinding: 'one' } };
/** The SDK tenant is the H scope in these tests. */
const consumer = () => hostedMessageConsumer(store(), { scopeOf: tenant => tenant, now: vectorClock });

/** A seeded scope, and an intent frozen for `turnId`. Returns the SDK input of its first reply. */
async function fixture(turnId = 't1') {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, state => seedCollaboration(state));
  await store().bindDevice(scope, 'device');
  await inSchema(opened!.pool, store().schema, async client => {
    await lockScope(client, storedKey(scope));
    await freezeIntent(client, scope, { key: turnId, source: 'user', execution, waitUntil: 60_000 });
  });
  const input = { tenant: scope, taskId: taskId(turnId, 0), deviceId: 'device', context: execution.agentMessageContext,
    payload: { agentRef: execution.payload.agentRef, messageId: 'one', contentHash: 'sha256:reply', body: 'Reply', contentType: 'text/markdown', byteCount: 5 },
  } as unknown as AgentMessageInput;
  return { scope, input, stored: () => store().dump(scope) };
}
const commands = async (scope: string) => (await opened!.pool.query<{ key: string }>(
  `SELECT key FROM "${store().schema}".command WHERE scope = $1 ORDER BY key`, [storedKey(scope)])).rows.map(row => JSON.parse(row.key) as string);
const other = (input: AgentMessageInput, payload: Partial<AgentMessageInput['payload']>) =>
  ({ ...input, payload: { ...input.payload, ...payload } }) as AgentMessageInput;

describe.skipIf(POSTGRES_URL === undefined)('H message consumer on real Postgres (#793 D2c)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  it('is the agentMessage option of createByokCloud', () => {
    const typed: ByokCloudOptions['agentMessage'] = consumer();
    expect(typeof typed?.consume).toBe('function');
  });

  it('accepts a reply once, and a replay after a crash before the SDK disposition gets the same decision', async () => {
    const f = await fixture();
    expect(await consumer().consume(f.input)).toEqual({ outcome: 'accepted' });
    const stored = await f.stored(), state = await store().read(f.scope);
    expect(state.replies[f.input.taskId]).toMatchObject({ turnId: 't1', messageId: 'one', contentHash: 'sha256:reply' });
    expect([state.revision, await commands(f.scope)]).toEqual([1, [`${f.input.taskId}:one`]]);
    // A new consumer: the first process died after the H commit and before the SDK recorded its disposition.
    expect(await consumer().consume(f.input)).toEqual({ outcome: 'accepted' });
    expect(await f.stored()).toBe(stored);
  });

  it.each(['device', 'agent', 'context'])('refuses a mismatched %s, also on an accepted replay, and writes nothing', async field => {
    const f = await fixture();
    await consumer().consume(f.input);
    const wrong = structuredClone(f.input) as { -readonly [K in keyof AgentMessageInput]: AgentMessageInput[K] };
    if (field === 'device') wrong.deviceId = 'other';
    if (field === 'agent') wrong.payload = { ...wrong.payload, agentRef: { ...wrong.payload.agentRef, agentId: 'other' } };
    if (field === 'context') wrong.context = { destinationBinding: 'other' } as AgentMessageInput['context'];
    const stored = await f.stored();
    expect(await consumer().consume(wrong as AgentMessageInput)).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
    expect(await f.stored()).toBe(stored);
  });

  it('refuses an unknown task, and a tenant with no scope, and writes nothing for either', async () => {
    const f = await fixture(), stored = await f.stored();
    expect(await consumer().consume({ ...f.input, taskId: 'unknown' })).toEqual({ outcome: 'refused', reasonCode: 'unknown_task' });
    expect(await f.stored()).toBe(stored);
    const tenant = `tenant:${randomUUID()}`;
    expect(await consumer().consume({ ...f.input, tenant } as AgentMessageInput)).toEqual({ outcome: 'refused', reasonCode: 'unknown_task' });
    expect((await opened!.pool.query(`SELECT 1 FROM "${store().schema}".scope WHERE scope = $1`, [storedKey(tenant)])).rows).toEqual([]);
  });

  it('checks the binding before the accepted reply, as K4 does', async () => {
    const f = await fixture();
    await consumer().consume(f.input);
    const stored = await f.stored();
    expect(await consumer().consume({ ...other(f.input, { messageId: 'two', contentHash: 'sha256:two' }), deviceId: 'other' }))
      .toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
    expect(await f.stored()).toBe(stored);
  });

  it('accepts only the exact accepted message of a task: other content or another message is a conflict', async () => {
    const f = await fixture();
    await consumer().consume(f.input);
    const stored = await f.stored();
    expect(await consumer().consume(other(f.input, { contentHash: 'sha256:other' }))).toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
    expect(await consumer().consume(other(f.input, { messageId: 'two', contentHash: 'sha256:two' }))).toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
    expect(await f.stored()).toBe(stored);
    expect((await store().read(f.scope)).replies[f.input.taskId]).toMatchObject({ messageId: 'one', contentHash: 'sha256:reply' });
    expect(await consumer().consume(f.input)).toEqual({ outcome: 'accepted' });
  });

  it('keeps a recorded refusal after the state changes, and refuses other content for its id', async () => {
    // The intent's Turn is not in the state, so the rule refuses the message, and the refusal gets a command record.
    const f = await fixture('ghost');
    expect(await consumer().consume(f.input)).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
    expect(await commands(f.scope)).toEqual([`${f.input.taskId}:one`]);
    await store().seed(f.scope, state => {
      state.turns.ghost = { id: 'ghost', root: 'ghost', botId: 'main', source: 'user', request: 'Late', hop: 0, status: 'processing', authority: 'owner' };
    });
    const stored = await f.stored();
    expect(await consumer().consume(f.input)).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
    expect(await consumer().consume(other(f.input, { contentHash: 'sha256:other' }))).toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
    expect(await f.stored()).toBe(stored);
  });

  it('gives two concurrent deliveries of one message one acceptance', async () => {
    const f = await fixture();
    // Open every pool connection first, so the two deliveries run at the same time and only the scope lock orders them.
    await Promise.all(Array.from({ length: 4 }, () => opened!.pool.query('SELECT pg_sleep(0.05)')));
    expect(await Promise.all([consumer().consume(f.input), consumer().consume(f.input)])).toEqual([{ outcome: 'accepted' }, { outcome: 'accepted' }]);
    expect([(await store().read(f.scope)).revision, await commands(f.scope)]).toEqual([1, [`${f.input.taskId}:one`]]);
  });

  it('throws on a scope of an unknown store version and writes nothing, so the SDK admission stays pending', async () => {
    const f = await fixture();
    await opened!.pool.query(`UPDATE "${store().schema}".scope SET state_version = 3 WHERE scope = $1`, [storedKey(f.scope)]);
    const stored = await f.stored();
    await expect(consumer().consume(f.input)).rejects.toBeInstanceOf(HostedStoreVersionError);
    expect(await f.stored()).toBe(stored);
  });
});

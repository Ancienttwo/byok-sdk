import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, HostLedger, MIN_TOMBSTONE_RETENTION_MS, occurrenceIntentKey, taskId, type FrozenSubmitPort, type Json,
  type RoutineDefinition } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { commitImport, importForSwitch, sealLedger } from '@byok-sdk/example-bot-collaboration/switch';
import { sealSwitchExport, verifySwitchExport, type IntentRecord, type SwitchContent, type SwitchExport } from '@byok-sdk/example-bot-collaboration/migration';
import { routineCalendar } from '@byok-sdk/example-bot-collaboration/routines';
import type { InboundMessage } from '@byok-sdk/example-bot-collaboration/channel';
import { DEVICE_SWITCHING } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { seedCollaboration, SYNC_OPTIONS, VECTOR_NOW } from '@byok-sdk/example-bot-collaboration/test-support';
import { HostedDueScheduler } from './due';
import { HostedCommandEntry, type EntryCaller } from './entry';
import { HostedReplyChecker } from './replies';
import { freezeIntent, HostedSubmitter } from './intents';
import { storedKey } from './layout';
import { hostedMessageConsumer, type AgentMessageInput } from './messages';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedReconciler, type HostedTaskPort, type TaskEvidence } from './reconcile';
import { HostedRoutineScheduler } from './scheduler';
import { HostedOutboxSender } from './sender';
import { TEST_HOST } from './memory-subject.test-support';
import { HostedCollaborationStore, homeRowKey, inSchema, lockScope, type InboundIdentity } from './store';

// #975 slice 5: H as the old owner exports a drained scope, writes nothing to it from then on, and commits away on the new
// owner's receipt.
let opened: Awaited<ReturnType<typeof openStore>> | undefined, hosted: HostedCollaborationStore | undefined;
const store = (): HostedCollaborationStore => hosted!;
const table = (name: string) => `"${store().schema}".${name}`;
const query = async <T extends object>(text: string, values: unknown[] = []) => (await opened!.pool.query<T>(text, values)).rows;
const SYNC = { ...SYNC_OPTIONS, history: undefined };
const IDENTITY: InboundIdentity = { owner: 'owner', self: {} };
const NOW = Date.UTC(2026, 0, 1), schedule = { minute: 0, hour: 9, tz: 'UTC' };
const clock = () => NOW;
const exportedError = (digest: string) => expect.objectContaining({ name: 'SwitchExportedError', code: 'switch_exported', digest });
const switching = expect.objectContaining({ name: 'DeviceSwitchingError', code: DEVICE_SWITCHING });
const execution = { ...template('device'), agentMessageContext: { destinationBinding: 'one' } };
const evidence = (turnId: string, document: Json = {}) => ({
  terminal: { envelope: { task_id: taskId(turnId, 0), type: 'task.complete', payload: { document } } } as unknown as DeviceTerminal,
  attempt: { taskId: taskId(turnId, 0), status: 'completed', claimedRuntime: 'runtime' } as unknown as TaskAttempt,
}) satisfies TaskEvidence;
/** An Agent message of the frozen task of `turnId`, bound as its input. */
async function message(scope: string, turnId: string, messageId: string): Promise<AgentMessageInput> {
  const [row] = await query<{ input: typeof execution & { taskId: string } }>(`SELECT input FROM ${table('intent')} WHERE scope = $1 AND key = $2`,
    [storedKey(scope), storedKey(turnId)]);
  const input = row?.input ?? { ...execution, taskId: taskId(turnId, 0) };
  return { tenant: scope, taskId: input.taskId, deviceId: input.deviceId, context: input.agentMessageContext,
    payload: { agentRef: input.payload.agentRef, messageId, contentHash: `sha256:${messageId}`, body: 'Reply', contentType: 'text/markdown', byteCount: 5 },
  } as unknown as AgentMessageInput;
}
const consumer = () => hostedMessageConsumer(store(), { scopeOf: tenant => tenant, now: clock });
const freeze = (scope: string, key: string, source: 'user' | 'routine' = 'user') => inSchema(opened!.pool, store().schema, async client => {
  await lockScope(client, storedKey(scope));
  await freezeIntent(client, scope, { key, source, execution, waitUntil: NOW + 600_000 });
});
/** Marks a frozen intent submitted and claimed, as the submitter and the reconciliation write it. */
const claimed = (scope: string, key: string) => query(`UPDATE ${table('intent')} SET submission = 'delivered', tries = 1, started = true
  WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)]);

/**
 * A scope that holds each kind of state a switch moves, with its device bound to H:
 * - `t1`, whose accepted message and outcome created a Bot routine, then retained (its Turn, reply and command record move
 *   to archived rows, its ids to row tombstones) and its intent compacted (an intent tombstone);
 * - the routine's first occurrence and its routine Turn, with an accepted message, settled;
 * - a concluded Host intent with its handler;
 * - an unsent Agent home write and its home row, and the seed's pending card.
 */
async function populated(): Promise<{ scope: string; routineId: string }> {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, state => seedCollaboration(state));
  await store().bindDevice(scope, 'device');
  await freeze(scope, 't1');
  await claimed(scope, 't1');
  expect(await consumer().consume(await message(scope, 't1', 'm1'))).toEqual({ outcome: 'accepted' });
  const document: Json = { create_routine: [{ localId: 'new_routine_1', schedule, prompt: 'Daily report' }] };
  expect(await store().finish(scope, 't1', evidence('t1', document), clock)).toBe('succeeded');
  await store().sync(scope, SYNC);
  const routineId = hash([taskId('t1', 0), 'create_routine', 0]);
  const slot = routineCalendar({ rule: schedule, timeZone: 'UTC' } as unknown as RoutineDefinition, NOW - 1)!;
  expect(await store().fire(scope, routineId, slot)).toBe('fired');
  await store().sync(scope, { ...SYNC, now: slot });
  const [occurrence] = await query<{ key: string }>(`SELECT key FROM ${table('occurrence')} WHERE scope = $1`, [storedKey(scope)]);
  const routineTurn = occurrenceIntentKey(JSON.parse(occurrence!.key) as string);
  await claimed(scope, routineTurn);
  expect(await consumer().consume(await message(scope, routineTurn, 'm2'))).toEqual({ outcome: 'accepted' });
  expect(await store().finish(scope, routineTurn, evidence(routineTurn), () => slot)).toBe('succeeded');
  await store().sync(scope, { ...SYNC, now: slot });
  await store().enqueueHostIntent(scope, { key: 'h1', source: 'user', execution: template('device'), waitUntil: NOW + 60_000 }, 'job', clock);
  await query(`UPDATE ${table('intent')} SET conclusion = 'cancelled', cancel_reason = 'cancelled' WHERE scope = $1 AND key = $2`,
    [storedKey(scope), storedKey('h1')]);
  // The routine Turn is the Bot's newest, so t1 leaves the ContextPack window and retention moves it.
  await store().seed(scope, state => { delete state.questions.q1; delete state.cards.c1; });
  expect(await store().retain(scope, { acknowledgedRoots: ['t1'], now: slot, retentionMs: MIN_TOMBSTONE_RETENTION_MS }, { contextTurnLimit: 1 }))
    .toMatchObject({ archivedRoots: 1 });
  expect(await store().compactIntents(scope, { acknowledgedTurnIds: ['t1'] })).toMatchObject({ compactedIntents: 1 });
  await pendingHome(scope);
  return { scope, routineId };
}
/** Adds an unsent Agent home write of the Main Bot and its home row, as a commit's home index writes it. */
async function pendingHome(scope: string): Promise<number> {
  let sequence = 0;
  await store().seed(scope, state => {
    sequence = ++state.sequence;
    state.team.homeOperations.push({ sequence, botId: 'main', status: 'pending', retries: [], request: { deviceId: 'device',
      payload: { requestId: `r-${sequence}`, agentRef: { agentId: 'main', profileRevision: '1' }, projectionHash: 'sha256:1',
        projection: { schemaVersion: 'bot-profile.v1', name: 'Main', role: 'Team owner', persona: '', model: 'default' } } } as never });
  });
  await query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, next_at) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'home', 0
    FROM ${table('outbox')} WHERE scope = $1`, [storedKey(scope), homeRowKey(sequence)]);
  return sequence;
}
/** Sends every pending projection of the schema, as the outbox sender does before an export. */
async function flushProjections(): Promise<void> {
  await new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} }, now: () => NOW + 86_400_000 }).run();
}
/** Freezes `device` away from H on revision 1, flushes the projections and exports the scope. */
async function exported(scope: string): Promise<SwitchExport> {
  await store().beginSwitch(scope, 'device', 'L', 1);
  await flushProjections();
  return store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 2 }], clock);
}
/** The authenticated command entry over the store, for any caller. */
const entry = () => new HostedCommandEntry<EntryCaller>(store(), { authenticate: async caller => caller, owner: async () => 'owner',
  sync: async (scope, now) => store().sync(scope, { ...SYNC, now }), now: clock });
/**
 * A scope where the Main Bot delegated to Bot `b` and `b`'s Turn succeeded with no reply, so the delegation's reply check
 * is due: work that is all concluded, with a check the reply checker still runs.
 */
async function replyPending(): Promise<string> {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, state => {
    seedCollaboration(state);
    Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    state.team.bots.b = { ...state.team.bots.main!, id: 'b', name: 'B', role: 'Reviewer', mainBot: false, execution: template('device', 'b') };
  });
  await store().bindDevice(scope, 'device');
  const result = await store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'input', botId: 'main', key: 'r1', request: 'Ask b',
    sender: 'owner' } }, clock);
  const root = result.disposition.outcome === 'accepted' ? result.disposition.value as string : '';
  await store().sync(scope, SYNC);
  await claimed(scope, root);
  expect(await store().finish(scope, root, evidence(root, { delegate: [{ to: 'b', request: 'Check' }] }), clock)).toBe('succeeded');
  await store().sync(scope, SYNC);
  const delegated = hash([taskId(root, 0), 'delegate', 0]);
  await claimed(scope, delegated);
  expect(await store().finish(scope, delegated, evidence(delegated), clock)).toBe('succeeded');
  await store().sync(scope, SYNC);
  expect(Object.values((await store().read(scope)).delegations)).toEqual([expect.objectContaining({ status: 'reply_pending' })]);
  return scope;
}
/** A Bot scope with only the seed, `t1` settled, bound to H. */
async function plain(): Promise<string> {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, state => {
    seedCollaboration(state);
    Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
  });
  await store().bindDevice(scope, 'device');
  return scope;
}

const owner: InboundMessage = { channel: 'fake', platformMessageId: 'in1', conversation: { kind: 'direct', id: 'main' },
  sender: { id: 'owner', kind: 'human' }, text: 'Do it', mentions: [] };
/** Each store entry that writes, and the refusal it gives on an exported scope with its device frozen away from H. */
const entries: Array<[string, (scope: string, digest: string) => Promise<unknown>, 'exported' | 'switching']> = [
  ['a command that adds no execution', scope => store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'cancel_turn', turnId: 't1' } }, clock), 'exported'],
  ['a command that adds execution on the frozen device', scope => store().commit(scope, { scope, commandId: randomUUID(),
    command: { kind: 'input', botId: 'main', key: 'k', request: 'Work', sender: 'owner' } }, clock, { requireBinding: true }), 'switching'],
  ['the inbound channel entry', scope => store().receive(scope, owner, IDENTITY, clock), 'switching'],
  ['a Host intent on the frozen device', scope => store().enqueueHostIntent(scope, { key: 'h2', source: 'user', execution: template('device'),
    waitUntil: NOW + 60_000 }, 'job', clock), 'switching'],
  ['an Agent message', async scope => consumer().consume(await message(scope, 't1', 'm9')), 'exported'],
  ['a terminal', scope => store().finish(scope, 'h1', evidence('h1'), clock), 'exported'],
  ['the sync', scope => store().sync(scope, SYNC), 'exported'],
  ['the routine upkeep', scope => store().planRoutines(scope, NOW, 'pass'), 'exported'],
  ['a Host job routine', scope => store().addHostJobRoutine(scope, { id: 'job-1', version: 1, timeZone: 'UTC', rule: schedule, waitMs: 60_000,
    lateAfterMs: 60_000, hostJob: { type: 'job', input: {} } } as never, NOW), 'exported'],
  ['retention', scope => store().retain(scope, { acknowledgedRoots: [], now: NOW, retentionMs: MIN_TOMBSTONE_RETENTION_MS }, { contextTurnLimit: 1 }), 'exported'],
  ['intent compaction', scope => store().compactIntents(scope, { acknowledgedTurnIds: ['h1'] }), 'exported'],
  ['a device observation', scope => store().observeDevices(scope, new Map([['device', true]]), clock), 'exported'],
  ['a reply check', scope => store().settleReplyCheck(scope, 'none', { nextCheckAt: 0 }, { kind: 'none' } as never, clock), 'exported'],
  ['a card claim', scope => store().claimCard(scope, 'c1', clock, 1000), 'exported'],
  ['a home claim', scope => store().claimHome(scope, 1, clock, 1000, 1000), 'exported'],
  ['an outbox deferral', scope => store().deferOutbox(scope, ['card', 'c1'], clock, 1000), 'exported'],
  ['a device revoke', scope => store().revokeDevice(scope, 'device', NOW), 'exported'],
  ['a bind of a new device', scope => store().bindDevice(scope, 'device-3'), 'exported'],
  ['a switch of another H device', scope => store().beginSwitch(scope, 'device-2', 'L', 1), 'exported'],
  ['a Host intent on a device that hosts no Bot', scope => store().enqueueHostIntent(scope, { key: 'h3', source: 'user', execution: template('device-2'),
    waitUntil: NOW + 60_000 }, 'job', clock), 'exported'],
  ['the command entry', scope => entry().cancelTurn({ scope, principal: { kind: 'human', id: 'owner' } }, 't1'), 'exported'],
  ['a drain', scope => store().drainDevice(scope, 'device', 2, {}, clock), 'exported'],
  ['an audit line', scope => store().audit(scope, 'line', clock), 'exported'],
  ['a seed', scope => store().seed(scope, () => {}), 'exported'],
];

describe.skipIf(POSTGRES_URL === undefined)('H switch export on real Postgres (#975)', () => {
  // One schema for each test, because the scans cover the whole schema.
  beforeEach(async () => {
    opened = await openStore();
    hosted = new HostedCollaborationStore(opened.pool, opened.store.schema, { host: TEST_HOST, hostIntents: { job: () => {} },
      hostJobs: { job: async () => ({ summary: {} }) } });
    await hosted.migrate();
  });
  afterEach(async () => { await opened?.close(); });

  it('moves a scope to a new L tenant: H exports it, L imports and reads it back, H commits away on the receipt and L commits', async () => {
    const { scope, routineId } = await populated();
    const document = await exported(scope);
    expect(verifySwitchExport(document)).toEqual(document.manifest);
    expect(document.manifest.counts).toMatchObject({ intents: 2, routines: 1, occurrences: 1, outbox: 0 });
    expect(document.archived.map(row => row.namespace).sort()).toEqual(expect.arrayContaining(['commands', 'replies', 'turns']));
    expect(new Set(document.tombstones.map(row => row.kind))).toEqual(new Set(['intent', 'row']));
    const routineTurn = document.intents.find(row => row.source === 'routine')!;
    expect(routineTurn).toMatchObject({ generation: 0, earlierExecutions: [], retry: { maxAttempts: 1, delaysMs: [], retryFailures: false },
      messageReceipt: { messageId: 'm2', contentHash: 'sha256:m2' }, conclusion: 'succeeded' });
    expect(document.intents.find(row => row.key === 'h1')).toMatchObject({ handler: 'job', conclusion: 'cancelled' });
    expect(document.routines).toEqual([expect.objectContaining({ id: routineId, ordinal: 0, lifecycle: 'active' })]);
    expect(document.collaboration.team.homeOperations).toEqual([expect.not.objectContaining({ sent: true })]);

    const ledger = new HostLedger(':memory:', `l:${randomUUID()}`);
    try {
      const receipt = importForSwitch(ledger, document);
      expect(receipt).toEqual({ digest: document.manifest.digest, devices: ['device'] });
      // A receipt that is not this export's moves nothing.
      await expect(store().commitSwitch(scope, 'device', 2, 'other')).rejects.toThrow(`The receipt other is not this scope's export ${receipt.digest}`);
      expect(await store().commitSwitch(scope, 'device', 2, receipt.digest)).toEqual({ mode: 'L', revision: 3, revoked: false });
      commitImport(ledger, receipt.digest);
    } finally { ledger.close(); }
    // The old scope keeps the exported state: H writes nothing to it, also after the commit.
    const kept = await store().dump(scope);
    await expect(store().audit(scope, 'after', clock)).rejects.toEqual(exportedError(document.manifest.digest));
    expect(await store().dump(scope)).toBe(kept);
  });

  it('keeps a Host job summary of null in the export, and L reads it back to the same digest', async () => {
    // K4 accepts a handler's { summary: null } and stores the null.
    hosted = new HostedCollaborationStore(opened!.pool, opened!.store.schema, { host: TEST_HOST, hostJobs: { job: async () => ({ summary: null }) } });
    const scope = await plain(), slot = routineCalendar({ rule: schedule, timeZone: 'UTC' } as unknown as RoutineDefinition, NOW - 1)!;
    await store().addHostJobRoutine(scope, { id: 'watch', version: 1, timeZone: 'UTC', rule: schedule as never, waitMs: 60_000, lateAfterMs: 60_000,
      hostJob: { type: 'job', input: null } }, NOW);
    expect(await new HostedRoutineScheduler(opened!.pool, store(), { now: () => slot }).run()).toEqual({ fired: 1, fenced: [], failed: [] });
    expect(await new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} }, now: () => slot }).run())
      .toMatchObject({ failed: [] });
    expect(await query(`SELECT job FROM ${table('occurrence')} WHERE scope = $1`, [storedKey(scope)])).toEqual([{ job: { summary: null } }]);
    const document = await exported(scope);
    expect(document.occurrences).toEqual([expect.objectContaining({ job: { attempts: 1, summary: null } })]);
    const ledger = new HostLedger(':memory:', `l:${randomUUID()}`);
    try {
      expect(importForSwitch(ledger, document)).toEqual({ digest: document.manifest.digest, devices: ['device'] });
    } finally { ledger.close(); }
  });

  it('refuses an export that a device or the scope is not ready for, and writes nothing', async () => {
    const scope = await plain();
    await freeze(scope, 'x1');
    await query(`UPDATE ${table('intent')} SET conclusion = 'cancelled' WHERE scope = $1`, [storedKey(scope)]);
    await expect(store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 1 }], clock))
      .rejects.toMatchObject({ name: 'DeviceSwitchRefusedError', reason: 'not_switching' });
    await store().beginSwitch(scope, 'device', 'L', 1);
    await expect(store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 1 }], clock))
      .rejects.toMatchObject({ name: 'DeviceSwitchRefusedError', reason: 'stale_revision' });
    await expect(store().exportScope(scope, [], clock)).rejects.toMatchObject({ name: 'SwitchExportError', reason: 'invalid' });
    // A live Bot on a device the export does not name.
    await store().seed(scope, state => {
      state.team.bots.other = { ...state.team.bots.main!, id: 'other', name: 'Other', mainBot: false, execution: template('device-2', 'other') };
    });
    await expect(store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 2 }], clock))
      .rejects.toMatchObject({ name: 'SwitchExportError', reason: 'device_missing' });
    await store().seed(scope, state => { delete state.team.bots.other; });
    // A pending projection: the sender flushes it first.
    await query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, body) SELECT $1, '"p1"', coalesce(max(ordinal) + 1, 0), 'projection', '{}'
      FROM ${table('outbox')} WHERE scope = $1`, [storedKey(scope)]);
    await expect(store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 2 }], clock))
      .rejects.toMatchObject({ name: 'SwitchExportError', reason: 'projection_pending' });
    await query(`UPDATE ${table('outbox')} SET settled_at = 1 WHERE scope = $1 AND key = '"p1"'`, [storedKey(scope)]);
    // A card connector call in flight: a card row with a try and no settle.
    await query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, tries) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'card', 1
      FROM ${table('outbox')} WHERE scope = $1`, [storedKey(scope), JSON.stringify(['card', 'c1'])]);
    await expect(store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 2 }], clock))
      .rejects.toMatchObject({ name: 'SwitchExportError', reason: 'card_call' });
    await query(`UPDATE ${table('outbox')} SET settled_at = 1 WHERE scope = $1 AND kind = 'card'`, [storedKey(scope)]);
    // An intent that queues under another scope's agent key.
    await query(`UPDATE ${table('intent')} SET agent = 'other' WHERE scope = $1`, [storedKey(scope)]);
    await expect(store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 2 }], clock))
      .rejects.toMatchObject({ name: 'SwitchExportError', reason: 'reference' });
    expect((await query<{ mark: unknown }>(`SELECT switch_export AS mark FROM ${table('scope')} WHERE scope = $1`, [storedKey(scope)]))[0])
      .toEqual({ mark: null });
  });

  it('refuses an export while the drain finds open work on the device', async () => {
    const scope = await plain();
    await store().seed(scope, state => {
      state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'q1', hop: 0, status: 'queued', authority: 'owner' };
    });
    await store().beginSwitch(scope, 'device', 'L', 1);
    await expect(store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 2 }], clock))
      .rejects.toMatchObject({ name: 'DeviceSwitchRefusedError', reason: 'open_work' });
  });

  it('commits away only on its own receipt, and only while the scope still seals to the exported digest', async () => {
    const scope = await plain(), document = await exported(scope);
    await expect(store().exportScope(scope, [{ deviceId: 'device', expectedRevision: 2 }], clock)).rejects.toEqual(exportedError(document.manifest.digest));
    await expect(store().commitSwitch(scope, 'device', 1, document.manifest.digest)).rejects.toMatchObject({ reason: 'stale_revision' });
    // A row that changed under the fence, as an operator edit would.
    await query(`UPDATE ${table('scope')} SET frame = frame WHERE scope = $1`, [storedKey(scope)]);
    await query(`INSERT INTO ${table('archived_row')} (scope, namespace, id, body) VALUES ($1, 'notes', '"n1"', '{}')`, [storedKey(scope)]);
    await expect(store().commitSwitch(scope, 'device', 2, document.manifest.digest)).rejects.toThrow('The scope changed after its export');
    await query(`DELETE FROM ${table('archived_row')} WHERE scope = $1`, [storedKey(scope)]);
    expect(await store().commitSwitch(scope, 'device', 2, document.manifest.digest)).toEqual({ mode: 'L', revision: 3, revoked: false });
    await expect(store().abortSwitch(scope, 'device', 3)).rejects.toMatchObject({ reason: 'not_switching' });
  });

  it('ends the export with an abort of its device: the fence lifts and the scope takes work again', async () => {
    const scope = await plain(), document = await exported(scope);
    const input = { kind: 'input' as const, botId: 'main', key: 'k', request: 'Work', sender: 'owner' as const };
    await expect(store().audit(scope, 'line', clock)).rejects.toEqual(exportedError(document.manifest.digest));
    expect(await store().abortSwitch(scope, 'device', 2)).toEqual({ mode: 'H', revision: 3, revoked: false });
    await store().audit(scope, 'line', clock);
    await store().commit(scope, { scope, commandId: randomUUID(), command: input }, clock, { requireBinding: true });
    await store().sync(scope, SYNC);
    expect((await query(`SELECT 1 FROM ${table('intent')} WHERE scope = $1`, [storedKey(scope)])).length).toBe(1);
    await expect(store().commitSwitch(scope, 'device', 3, document.manifest.digest)).rejects.toMatchObject({ reason: 'not_switching' });
  });

  describe('every write path refuses an exported scope after its own refusals, and nothing is written', () => {
    it.each(entries)('%s', async (_name, run, refusal) => {
      const scope = await plain();
      await store().bindDevice(scope, 'device-2');
      // An expired command record, which a retention pass would delete.
      await query(`INSERT INTO ${table('archived_row')} (scope, namespace, id, body, expires_at) VALUES ($1, 'commands', '"old"', '{}', 1)`, [storedKey(scope)]);
      await store().enqueueHostIntent(scope, { key: 'h1', source: 'user', execution: template('device'), waitUntil: NOW + 60_000 }, 'job', clock);
      await query(`UPDATE ${table('intent')} SET conclusion = 'cancelled', cancel_reason = 'cancelled' WHERE scope = $1`, [storedKey(scope)]);
      await pendingHome(scope);
      const { manifest: { digest } } = await exported(scope), kept = await store().dump(scope);
      await expect(run(scope, digest)).rejects.toEqual(refusal === 'exported' ? exportedError(digest) : switching);
      expect(await store().dump(scope)).toBe(kept);
    });

    it('refuses the reply checker\'s settle of a due check after its SDK read, and writes nothing', async () => {
      const scope = await replyPending();
      const { manifest: { digest } } = await exported(scope), kept = await store().dump(scope), reads: string[] = [];
      const checker = new HostedReplyChecker(store(), { port: () => ({ agentMessage: async taskId => { reads.push(taskId); return {} as never; } }), now: clock });
      await expect(checker.check(scope, NOW + 86_400_000)).rejects.toEqual(exportedError(digest));
      expect(reads).toHaveLength(1);
      expect(await store().dump(scope)).toBe(kept);
    });

    it('leaves an exported scope out of every scan: due, routine, submit, reconciliation and outbox', async () => {
      const { scope } = await populated();
      await store().seed(scope, state => {
        state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'q1', hop: 0, status: 'succeeded', conclusion: 'succeeded',
          reported: true, authority: 'owner' };
      });
      await exported(scope);
      // Make each kind of row due, as a scope with work would have it.
      await query(`UPDATE ${table('scope')} SET due_at = 0 WHERE scope = $1`, [storedKey(scope)]);
      await query(`UPDATE ${table('routine')} SET next_at = 0 WHERE scope = $1`, [storedKey(scope)]);
      await query(`UPDATE ${table('outbox')} SET next_at = 0 WHERE scope = $1`, [storedKey(scope)]);
      // Reopen the first intent for the submit scan and the second for the reconciliation scan.
      const reopened = await query<{ submission: string }>(`WITH ranked AS (SELECT key, row_number() OVER (ORDER BY ordinal) AS rank FROM ${table('intent')} WHERE scope = $1)
        UPDATE ${table('intent')} i SET conclusion = NULL, cancel_reason = NULL, next_at = 0, reconcile_at = 0,
          submission = CASE WHEN r.rank = 1 THEN 'reserved' ELSE 'delivered' END
        FROM ranked r WHERE i.scope = $1 AND i.key = r.key AND r.rank <= 2 RETURNING i.submission`, [storedKey(scope)]);
      expect(reopened.map(row => row.submission).sort()).toEqual(['delivered', 'reserved']);
      const kept = await store().dump(scope), later = NOW + 86_400_000;
      const sync = vi.fn(async () => ({ dueAt: null }));
      expect(await new HostedDueScheduler(opened!.pool, store(), { sync, now: () => later }).run()).toEqual({ synced: 0, stalled: [], failed: [] });
      expect(sync).not.toHaveBeenCalled();
      expect(await new HostedRoutineScheduler(opened!.pool, store(), { now: () => later }).run()).toEqual({ fired: 0, fenced: [], failed: [] });
      expect(await new HostedRoutineScheduler(opened!.pool, store(), { now: () => later }).start()).toEqual([]);
      const port: FrozenSubmitPort = { submit: vi.fn(), offer: vi.fn() } as unknown as FrozenSubmitPort;
      expect(await new HostedSubmitter(opened!.pool, store().schema, { port: () => port, now: () => later }).run()).toEqual({ tried: 0, failed: [] });
      expect(port.submit).not.toHaveBeenCalled();
      const tasks = { attempt: vi.fn(), deviceTerminal: vi.fn(), cancel: vi.fn(), offer: vi.fn() } satisfies HostedTaskPort;
      expect(await new HostedReconciler(opened!.pool, store().schema, store(), { port: () => tasks, now: () => later }).run())
        .toEqual({ concluded: 0, failed: [] });
      for (const read of Object.values(tasks)) expect(read).not.toHaveBeenCalled();
      const deliver = vi.fn(async () => {});
      expect(await new HostedOutboxSender(opened!.pool, store(), { projections: { deliver }, now: () => later }).run()).toEqual({ steps: 0, failed: [] });
      expect(await store().dump(scope)).toBe(kept);
    });

    it('writes no backoff to a scope exported after the scan read it', async () => {
      const scope = await plain();
      await store().beginSwitch(scope, 'device', 'L', 1);
      await flushProjections();
      await query(`UPDATE ${table('scope')} SET due_at = 0 WHERE scope = $1`, [storedKey(scope)]);
      // The export lands between the due scan and the sync of the scope.
      const sync = async (target: string) => {
        await store().exportScope(target, [{ deviceId: 'device', expectedRevision: 2 }], clock);
        return store().sync(target, SYNC);
      };
      const pass = await new HostedDueScheduler(opened!.pool, store(), { sync, now: clock }).run();
      expect(pass.failed.map(row => row.error)).toEqual([expect.objectContaining({ code: 'switch_exported' })]);
      expect(await query(`SELECT retry_at FROM ${table('scope')} WHERE scope = $1`, [storedKey(scope)])).toEqual([{ retry_at: null }]);
    });

    it('writes no routine backoff to a scope exported after the scan read the routine', async () => {
      const { scope, routineId } = await populated();
      await store().beginSwitch(scope, 'device', 'L', 1);
      await flushProjections();
      await query(`UPDATE ${table('routine')} SET next_at = 1 WHERE scope = $1`, [storedKey(scope)]);
      const fire = store().fire.bind(store());
      vi.spyOn(store(), 'fire').mockImplementationOnce(async (target, id, at) => {
        await store().exportScope(target, [{ deviceId: 'device', expectedRevision: 2 }], clock);
        return fire(target, id, at);
      });
      const pass = await new HostedRoutineScheduler(opened!.pool, store(), { now: clock }).run();
      // The fire's own refusal comes first: the routine's Bot is on the frozen device.
      expect([pass.failed, pass.fenced.map(row => [row.routineId, row.error])]).toEqual([[], [[routineId, switching]]]);
      expect((await query<{ mark: unknown }>(`SELECT switch_export AS mark FROM ${table('scope')} WHERE scope = $1`, [storedKey(scope)]))[0]!.mark)
        .not.toBeNull();
      expect(await query(`SELECT retry_at FROM ${table('routine')} WHERE scope = $1`, [storedKey(scope)])).toEqual([{ retry_at: null }]);
    });

    it('goes on with the outbox pass when a scope is exported after the scan, and writes no wait to that scope', async () => {
      const scope = await plain();
      await store().beginSwitch(scope, 'device', 'L', 1);
      await flushProjections();
      await query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, next_at) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'home', 0
        FROM ${table('outbox')} WHERE scope = $1`, [storedKey(scope), homeRowKey(1)]);
      // A healthy scope whose projection sorts after the exported scope's row.
      const healthy = await plain();
      await query(`UPDATE ${table('outbox')} SET next_at = 1 WHERE scope = $1 AND settled_at IS NULL`, [storedKey(healthy)]);
      await query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, body, next_at) SELECT $1, '"p1"', coalesce(max(ordinal) + 1, 0), 'projection', '{}', 1
        FROM ${table('outbox')} WHERE scope = $1`, [storedKey(healthy)]);
      const claimHome = store().claimHome.bind(store());
      vi.spyOn(store(), 'claimHome').mockImplementationOnce(async (target, ...rest) => {
        await store().exportScope(target, [{ deviceId: 'device', expectedRevision: 2 }], clock);
        return claimHome(target, ...rest);
      });
      const deliver = vi.fn(async () => {});
      const homes = { read: vi.fn(), enqueue: vi.fn() };
      const pass = await new HostedOutboxSender(opened!.pool, store(), { projections: { deliver }, homes: () => homes, now: () => NOW + 86_400_000 }).run();
      expect(pass.failed).toEqual([{ scope, id: ['home', 1], error: expect.objectContaining({ code: 'switch_exported' }) }]);
      expect([homes.read, homes.enqueue].map(call => call.mock.calls.length)).toEqual([0, 0]);
      expect(deliver).toHaveBeenCalled();
      expect(await query(`SELECT next_at::text FROM ${table('outbox')} WHERE scope = $1 AND key = $2`, [storedKey(scope), homeRowKey(1)]))
        .toEqual([{ next_at: '0' }]);
      expect(await query(`SELECT count(*)::int AS n FROM ${table('outbox')} WHERE scope = $1 AND settled_at IS NULL`, [storedKey(healthy)]))
        .toEqual([{ n: 0 }]);
    });

    it('writes no routine backoff while an export holds the scope row, once that export commits', async () => {
      const { scope } = await populated();
      await store().beginSwitch(scope, 'device', 'L', 1);
      await flushProjections();
      await query(`UPDATE ${table('routine')} SET next_at = 1 WHERE scope = $1`, [storedKey(scope)]);
      const exporter = await opened!.pool.connect();
      let committed: Promise<unknown> | undefined;
      try {
        const fire = store().fire.bind(store());
        // After the fire throws and before its backoff, an export locks the scope row and writes its mark, uncommitted.
        vi.spyOn(store(), 'fire').mockImplementationOnce(async (target, id, at) => {
          try { return await fire(target, id, at); } finally {
            await exporter.query('BEGIN');
            await exporter.query(`SELECT 1 FROM ${table('scope')} WHERE scope = $1 FOR UPDATE`, [storedKey(scope)]);
            await exporter.query(`UPDATE ${table('scope')} SET switch_export = $2::json WHERE scope = $1`,
              [storedKey(scope), JSON.stringify({ digest: 'd', exportedAt: NOW, devices: [{ deviceId: 'device', frozenRevision: 2 }] })]);
            // The export commits once the backoff waits on its lock, or after a second when nothing does.
            committed = (async () => {
              for (let waited = 0; waited < 1_000; waited += 20) {
                const waiting = await query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT switch_export IS NULL AS open%'`);
                if (waiting[0]!.n > 0) break;
                await new Promise(resolve => setTimeout(resolve, 20));
              }
              await exporter.query('COMMIT');
            })();
          }
        });
        const pass = await new HostedRoutineScheduler(opened!.pool, store(), { now: clock }).run();
        expect(pass.fenced).toHaveLength(1);
        await committed;
      } finally { exporter.release(); }
      expect(await query(`SELECT retry_at FROM ${table('routine')} WHERE scope = $1`, [storedKey(scope)])).toEqual([{ retry_at: null }]);
    });
  });

  it('refuses a scope lock outside a write transaction of inSchema', async () => {
    const client = await opened!.pool.connect();
    try {
      await expect(lockScope(client, storedKey('tenant:none'))).rejects.toThrow('A scope lock needs a write transaction of inSchema');
    } finally { client.release(); }
  });
});

const importedError = (digest: string) => expect.objectContaining({ name: 'SwitchImportedError', code: 'switch_imported', digest });
/**
 * H exports `scope`, a new L tenant imports and commits it, and the L ledger is sealed as the L export of the domain. L's own
 * freeze and drain are not run: the ledger holds the drained domain that H moved, and is sealed as it stands.
 */
async function throughL(scope: string): Promise<{ fromH: SwitchExport; fromL: SwitchExport }> {
  const fromH = await exported(scope);
  const ledger = new HostLedger(':memory:', `l:${randomUUID()}`);
  try {
    const receipt = importForSwitch(ledger, fromH);
    await store().commitSwitch(scope, 'device', 2, receipt.digest);
    commitImport(ledger, receipt.digest);
    return { fromH, fromL: sealLedger(ledger, { source: 'L', domain: ledger.tenant, exportedAt: NOW + 1,
      devices: fromH.devices.map(device => ({ deviceId: device.deviceId, frozenRevision: 3 })) }) };
  } finally { ledger.close(); }
}
/** The document sealed again after `change` edits its content. */
function resealed(document: SwitchExport, change: (content: SwitchContent) => void): SwitchExport {
  const { manifest: _manifest, ...content } = structuredClone(document);
  change(content);
  return sealSwitchExport(content);
}
/**
 * Moves an intent record to `generation`, as K4 would after a retry of each earlier one: each earlier generation was
 * delivered and ended, and the receipt of generation 0 stays with it. The current generation has no receipt.
 */
function retried(row: IntentRecord, generation: number): void {
  const { taskId: _current, ...execution } = row.input as Record<string, Json>;
  const ended = { submission: 'delivered' as const, started: true, attempt: { status: 'completed' }, terminal: { type: 'task.complete' } };
  row.earlierExecutions = Array.from({ length: generation }, (_, earlier) => ({ ...ended,
    ...(earlier === 0 && row.messageReceipt ? { messageReceipt: row.messageReceipt } : {}) }));
  delete row.messageReceipt;
  Object.assign(row, { ...ended, generation, taskId: taskId(row.key, generation), retry: { maxAttempts: generation + 1, delaysMs: Array(generation).fill(0),
    retryFailures: true } });
  row.input = { ...execution, taskId: row.taskId };
}
/** An Agent message for the task of `generation` of intent `key` of `scope`, bound as that task's input. */
async function generationMessage(scope: string, key: string, generation: number, messageId: string, deviceId?: string): Promise<AgentMessageInput> {
  const input = await message(scope, key, messageId);
  return { ...input, taskId: taskId(key, generation), ...(deviceId ? { deviceId } : {}) };
}
const bindingRows = (scope: string) => query<{ device: string; mode: string; mode_revision: string }>(`SELECT device, mode, mode_revision::text
  FROM ${table('device_binding')} WHERE scope = $1 ORDER BY device`, [storedKey(scope)]);

describe.skipIf(POSTGRES_URL === undefined)('H switch import on real Postgres (#975)', () => {
  beforeEach(async () => {
    opened = await openStore();
    hosted = new HostedCollaborationStore(opened.pool, opened.store.schema, { host: TEST_HOST, hostIntents: { job: () => {} },
      hostJobs: { job: async () => ({ summary: {} }) } });
    await hosted.migrate();
  });
  afterEach(async () => { await opened?.close(); });

  it('moves a domain H to L to a new H scope: the import reads back to the digest, and every section is the one that left H', async () => {
    const { scope } = await populated();
    const { fromH, fromL } = await throughL(scope);
    const target = `tenant:${randomUUID()}`;
    expect(await store().importScope(target, fromL, clock)).toEqual({ digest: fromL.manifest.digest, devices: ['device'] });
    expect(await bindingRows(target)).toEqual([{ device: '"device"', mode: 'L', mode_revision: '1' }]);
    // The unsent home write gets its home row again, which the source does not move.
    expect((await query<{ kind: string }>(`SELECT kind FROM ${table('outbox')} WHERE scope = $1 AND settled_at IS NULL`, [storedKey(target)]))
      .map(row => row.kind)).toEqual(['home']);
    await store().commitImport(target, fromL.manifest.digest);
    expect(await bindingRows(target)).toEqual([{ device: '"device"', mode: 'H', mode_revision: '2' }]);
    await store().beginSwitch(target, 'device', 'L', 2);
    await flushProjections();
    const again = await store().exportScope(target, [{ deviceId: 'device', expectedRevision: 3 }], clock);
    expect(again.manifest.digests).toEqual(fromH.manifest.digests);
    expect(again.manifest.digests).toEqual(fromL.manifest.digests);
    // L to H to L: a new L tenant reads H's export back to its digest.
    const ledger = new HostLedger(':memory:', `l:${randomUUID()}`);
    try {
      expect(importForSwitch(ledger, again)).toEqual({ digest: again.manifest.digest, devices: ['device'] });
    } finally { ledger.close(); }
  });

  it('runs the device\'s work once the import is committed: a new Turn freezes its intent, and the moved home write is sent', async () => {
    const { scope } = await populated();
    const { fromL } = await throughL(scope);
    const target = `tenant:${randomUUID()}`, calls = { reads: [] as string[], enqueued: [] as string[] };
    await store().importScope(target, fromL, clock);
    const homes = () => ({ read: async (request: { payload: { requestId: string } }) => { calls.reads.push(request.payload.requestId); return undefined as never; },
      enqueue: async (request: { payload: { requestId: string } }) => { calls.enqueued.push(request.payload.requestId); } });
    const sender = () => new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} }, homes: homes as never, now: clock });
    await sender().run();
    expect(calls).toEqual({ reads: [], enqueued: [] });
    await store().commitImport(target, fromL.manifest.digest);
    await sender().run();
    const [sequence] = fromL.collaboration.team.homeOperations.map(op => op.sequence);
    expect(calls).toEqual({ reads: [`r-${sequence}`], enqueued: [`r-${sequence}`] });
    const result = await store().commit(target, { scope: target, commandId: randomUUID(), command: { kind: 'input', botId: 'main', key: 'after', request: 'Work',
      sender: 'owner' } }, clock, { requireBinding: true });
    const turnId = result.disposition.outcome === 'accepted' ? result.disposition.value as string : '';
    await store().sync(target, SYNC);
    expect(await query(`SELECT generation, submission FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(target), storedKey(turnId)]))
      .toEqual([{ generation: 0, submission: 'reserved' }]);
  });

  it('keeps earlier generations, a memory block and a slot replay count, and answers a message of an earlier task from it', async () => {
    const { scope } = await populated();
    const { fromL } = await throughL(scope);
    const routineTurn = fromL.intents.find(row => row.source === 'routine')!.key;
    const document = resealed(fromL, content => {
      retried(content.intents.find(row => row.key === routineTurn)!, 1);
      const host = content.intents.find(row => row.key === 'h1')!;
      retried(host, 2);
      delete host.cancelReason;
      Object.assign(host, { conclusion: 'failed', memoryBlocked: { resume: 'queued', reason: 'memory unavailable' } });
      content.occurrences[0]!.slotReplayCount = 2;
    });
    const target = `tenant:${randomUUID()}`;
    await store().importScope(target, document, clock);
    expect(await query(`SELECT key, generation, task_id FROM ${table('intent_execution')} WHERE scope = $1 ORDER BY key, generation`, [storedKey(target)]))
      .toEqual([{ key: '"h1"', generation: 0, task_id: taskId('h1', 0) }, { key: '"h1"', generation: 1, task_id: taskId('h1', 1) },
        { key: JSON.stringify(routineTurn), generation: 0, task_id: taskId(routineTurn, 0) }]);
    await store().commitImport(target, document.manifest.digest);
    const kept = await store().dump(target);
    // A replay of the Host intent's freeze finds the imported row of generation 2 and changes nothing, as K4 enqueue does.
    expect(await store().enqueueHostIntent(target, { key: 'h1', source: 'user', execution: template('device'), waitUntil: NOW + 60_000 }, 'job', clock))
      .toEqual({ key: 'h1', taskId: taskId('h1', 2), conclusion: 'failed' });
    expect(await store().dump(target)).toBe(kept);
    // K4's order for an earlier task: the binding, its receipt (the accepted reply of that task), else stale_generation.
    expect(await consumer().consume(await generationMessage(target, routineTurn, 0, 'm2'))).toEqual({ outcome: 'accepted' });
    expect(await consumer().consume(await generationMessage(target, routineTurn, 0, 'm3'))).toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
    expect(await consumer().consume(await generationMessage(target, 'h1', 1, 'm4'))).toEqual({ outcome: 'refused', reasonCode: 'stale_generation' });
    expect(await consumer().consume(await generationMessage(target, 'h1', 0, 'm4', 'device-2')))
      .toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
    expect(await consumer().consume(await generationMessage(target, 'h1', 3, 'm4'))).toEqual({ outcome: 'refused', reasonCode: 'unknown_task' });
    expect(await store().dump(target)).toBe(kept);
    await store().beginSwitch(target, 'device', 'L', 2);
    await flushProjections();
    expect((await store().exportScope(target, [{ deviceId: 'device', expectedRevision: 3 }], clock)).manifest.digests).toEqual(document.manifest.digests);
    // Compaction deletes an intent with the execution of every generation, as K4 does.
    await store().abortSwitch(target, 'device', 3);
    expect(await store().compactIntents(target, { acknowledgedTurnIds: ['h1'] })).toMatchObject({ compactedIntents: 1 });
    expect(await query(`SELECT key FROM ${table('intent_execution')} WHERE scope = $1`, [storedKey(target)])).toEqual([{ key: JSON.stringify(routineTurn) }]);
  });

  it('reads the reply of a delegation chain end from its current task, which an import may put in a later generation', async () => {
    const scope = await replyPending();
    const { fromL } = await throughL(scope);
    const chainEnd = fromL.intents.find(row => row.source === 'bot')!.key;
    const document = resealed(fromL, content => retried(content.intents.find(row => row.key === chainEnd)!, 1));
    const target = `tenant:${randomUUID()}`;
    await store().importScope(target, document, clock);
    await store().commitImport(target, document.manifest.digest);
    expect((await store().replyChecks(target, NOW + 86_400_000 * 30)).map(check => check.task?.taskId)).toEqual([taskId(chainEnd, 1)]);
  });

  it('carries a pending Host job, which runs once the import is committed', async () => {
    hosted = new HostedCollaborationStore(opened!.pool, opened!.store.schema, { host: TEST_HOST, hostJobs: { job: async () => ({ summary: { ran: true } }) } });
    const scope = await plain(), slot = routineCalendar({ rule: schedule, timeZone: 'UTC' } as unknown as RoutineDefinition, NOW - 1)!;
    await store().addHostJobRoutine(scope, { id: 'watch', version: 1, timeZone: 'UTC', rule: schedule as never, waitMs: 60_000, lateAfterMs: 60_000,
      hostJob: { type: 'job', input: null } }, NOW);
    await new HostedRoutineScheduler(opened!.pool, store(), { now: () => slot }).run();
    await new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} }, now: () => slot }).run();
    const { fromL } = await throughL(scope);
    // The same domain with its Host job not run yet, as an L export carries it.
    const document = resealed(fromL, content => {
      const occurrence = content.occurrences[0]!;
      delete occurrence.conclusion;
      occurrence.job = { attempts: 1 };
      content.outbox = [{ kind: 'host-job', occurrenceKey: occurrence.key }];
    });
    const target = `tenant:${randomUUID()}`;
    await store().importScope(target, document, clock);
    const jobs = () => query(`SELECT tries, settled_at FROM ${table('outbox')} WHERE scope = $1 AND kind = 'host_job'`, [storedKey(target)]);
    expect(await jobs()).toEqual([{ tries: 1, settled_at: null }]);
    const sender = () => new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} }, now: () => slot + 86_400_000 });
    expect(await sender().run()).toEqual({ steps: 0, failed: [] });
    await store().commitImport(target, document.manifest.digest);
    expect(await sender().run()).toMatchObject({ failed: [] });
    expect(await jobs()).toEqual([{ tries: 2, settled_at: String(slot + 86_400_000) }]);
    expect(await query(`SELECT job, conclusion FROM ${table('occurrence')} WHERE scope = $1`, [storedKey(target)]))
      .toEqual([{ job: { summary: { ran: true } }, conclusion: 'succeeded' }]);
  });

  it('writes nothing when the scope does not read back to the digest', async () => {
    const scope = await plain();
    const { fromL } = await throughL(scope);
    // A row that the database stores other than written: its tombstone gets an expiry.
    await query(`CREATE FUNCTION ${table('shift_expiry')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.expires_at := 1; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER shift_expiry BEFORE INSERT ON ${table('retired_identity')} FOR EACH ROW EXECUTE FUNCTION ${table('shift_expiry')}()`);
    const target = `tenant:${randomUUID()}`, document = resealed(fromL, content => {
      content.tombstones.push({ kind: 'row', digest: hash(['turns', 'gone']) });
    });
    await expect(store().importScope(target, document, clock)).rejects.toMatchObject({ name: 'SwitchExportError', reason: 'manifest' });
    for (const name of ['scope', 'entity', 'intent', 'device_binding', 'retired_identity', 'outbox']) {
      expect(await query(`SELECT 1 FROM ${table(name)} WHERE scope = $1`, [storedKey(target)])).toEqual([]);
    }
  });

  it('refuses a document from H, an existing scope and a document that does not verify, and writes nothing', async () => {
    const scope = await plain();
    const { fromH, fromL } = await throughL(scope);
    const target = `tenant:${randomUUID()}`;
    await expect(store().importScope(target, fromH, clock)).rejects.toMatchObject({ name: 'SwitchExportError', reason: 'invalid' });
    await expect(store().importScope(target, { ...fromL, exportedAt: fromL.exportedAt + 1 }, clock)).rejects.toMatchObject({ reason: 'manifest' });
    await expect(store().importScope(scope, fromL, clock)).rejects.toThrow(`A switch import needs a new scope: ${scope} exists`);
    expect(await query(`SELECT 1 FROM ${table('scope')} WHERE scope = $1`, [storedKey(target)])).toEqual([]);
  });

  it('commits only the import of its digest, once, and discards only an uncommitted one', async () => {
    const scope = await plain();
    const { fromL } = await throughL(scope);
    const target = `tenant:${randomUUID()}`, other = `tenant:${randomUUID()}`, { digest } = fromL.manifest;
    await store().importScope(target, fromL, clock);
    await store().importScope(other, fromL, clock);
    await expect(store().commitImport(target, 'other')).rejects.toThrow(`The switch import is ${digest}, not other`);
    // An imported scope takes no switch away before its commit.
    await expect(store().exportScope(target, [{ deviceId: 'device', expectedRevision: 1 }], clock)).rejects.toEqual(importedError(digest));
    await expect(store().abortSwitch(target, 'device', 1)).rejects.toEqual(importedError(digest));
    await expect(store().commitSwitch(target, 'device', 1, digest)).rejects.toEqual(importedError(digest));
    await store().commitImport(target, digest);
    await expect(store().commitImport(target, digest)).rejects.toThrow('This scope holds no switch import record');
    await expect(store().discardImport(target)).rejects.toThrow('This scope holds no switch import record');
    await store().discardImport(other);
    for (const name of ['scope', 'entity', 'entry', 'command', 'intent', 'intent_execution', 'device_binding', 'routine', 'occurrence', 'outbox',
      'retired_identity', 'archived_row']) {
      expect(await query(`SELECT 1 FROM ${table(name)} WHERE scope = $1`, [storedKey(other)])).toEqual([]);
    }
    await expect(store().commitImport(other, digest)).rejects.toThrow('This scope holds no switch import record');
  });

  describe('every write path refuses an uncommitted import after its own refusals, and nothing is written', () => {
    /** The refusals that come first: each device of the import is in mode L, owned by the old owner until the commit. */
    const mode = expect.objectContaining({ name: 'DeviceBindingError', reason: 'mode', deviceId: 'device' });
    const own: Record<string, unknown> = {
      'a command that adds execution on the frozen device': mode,
      'the inbound channel entry': mode,
      'a Host intent on the frozen device': mode,
      // The import binds only the export's devices.
      'a Host intent on a device that hosts no Bot': expect.objectContaining({ name: 'DeviceBindingError', reason: 'unbound', deviceId: 'device-2' }),
      'a drain': expect.objectContaining({ name: 'DeviceSwitchRefusedError', reason: 'not_switching' }),
      'a switch of another H device': expect.objectContaining({ name: 'DeviceSwitchRefusedError', reason: 'same_mode', deviceId: 'device-2' }),
    };
    it.each(entries)('%s', async (name, run) => {
      const scope = await plain();
      await store().bindDevice(scope, 'device-2');
      await query(`INSERT INTO ${table('archived_row')} (scope, namespace, id, body, expires_at) VALUES ($1, 'commands', '"old"', '{}', 1)`, [storedKey(scope)]);
      await store().enqueueHostIntent(scope, { key: 'h1', source: 'user', execution: template('device'), waitUntil: NOW + 60_000 }, 'job', clock);
      await query(`UPDATE ${table('intent')} SET conclusion = 'cancelled', cancel_reason = 'cancelled' WHERE scope = $1`, [storedKey(scope)]);
      await pendingHome(scope);
      const { fromL } = await throughL(scope), target = `tenant:${randomUUID()}`, { digest } = fromL.manifest;
      await store().importScope(target, fromL, clock);
      const kept = await store().dump(target);
      await expect(run(target, digest)).rejects.toEqual(own[name] ?? importedError(digest));
      expect(await store().dump(target)).toBe(kept);
    });
  });

  it('leaves an uncommitted import out of every scan: due, routine, submit, reconciliation and outbox', async () => {
    const { scope } = await populated();
    const { fromL } = await throughL(scope);
    const target = `tenant:${randomUUID()}`;
    await store().importScope(target, fromL, clock);
    await query(`UPDATE ${table('scope')} SET due_at = 0 WHERE scope = $1`, [storedKey(target)]);
    await query(`UPDATE ${table('routine')} SET next_at = 0 WHERE scope = $1`, [storedKey(target)]);
    await query(`UPDATE ${table('outbox')} SET next_at = 0 WHERE scope = $1`, [storedKey(target)]);
    const reopened = await query<{ submission: string }>(`WITH ranked AS (SELECT key, row_number() OVER (ORDER BY ordinal) AS rank FROM ${table('intent')} WHERE scope = $1)
      UPDATE ${table('intent')} i SET conclusion = NULL, cancel_reason = NULL, next_at = 0, reconcile_at = 0,
        submission = CASE WHEN r.rank = 1 THEN 'reserved' ELSE 'delivered' END
      FROM ranked r WHERE i.scope = $1 AND i.key = r.key AND r.rank <= 2 RETURNING i.submission`, [storedKey(target)]);
    expect(reopened.map(row => row.submission).sort()).toEqual(['delivered', 'reserved']);
    const kept = await store().dump(target), later = NOW + 86_400_000;
    const sync = vi.fn(async () => ({ dueAt: null }));
    expect(await new HostedDueScheduler(opened!.pool, store(), { sync, now: () => later }).run()).toEqual({ synced: 0, stalled: [], failed: [] });
    expect(await new HostedRoutineScheduler(opened!.pool, store(), { now: () => later }).run()).toEqual({ fired: 0, fenced: [], failed: [] });
    expect(await new HostedRoutineScheduler(opened!.pool, store(), { now: () => later }).start()).toEqual([]);
    const port = { submit: vi.fn(), offer: vi.fn() };
    expect(await new HostedSubmitter(opened!.pool, store().schema, { port: () => port as unknown as FrozenSubmitPort, now: () => later }).run())
      .toEqual({ tried: 0, failed: [] });
    const tasks = { attempt: vi.fn(), deviceTerminal: vi.fn(), cancel: vi.fn(), offer: vi.fn() } satisfies HostedTaskPort;
    expect(await new HostedReconciler(opened!.pool, store().schema, store(), { port: () => tasks, now: () => later }).run()).toEqual({ concluded: 0, failed: [] });
    const deliver = vi.fn(async () => {}), homes = { read: vi.fn(), enqueue: vi.fn() };
    expect(await new HostedOutboxSender(opened!.pool, store(), { projections: { deliver }, homes: () => homes, now: () => later }).run())
      .toEqual({ steps: 0, failed: [] });
    for (const call of [sync, port.submit, ...Object.values(tasks), deliver, homes.read, homes.enqueue]) expect(call).not.toHaveBeenCalled();
    expect(await store().dump(target)).toBe(kept);
  });
});

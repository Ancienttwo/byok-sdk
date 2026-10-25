import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, taskId, type Json, type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { routineCalendar } from '@byok-sdk/example-bot-collaboration/routines';
import type { InboundMessage } from '@byok-sdk/example-bot-collaboration/channel';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { DEVICE_SWITCHING } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { seedCollaboration, SYNC_OPTIONS, VECTOR_NOW } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedRoutineScheduler } from './scheduler';
import { HostedOutboxSender } from './sender';
import { TEST_HOST } from './memory-subject.test-support';
import { HostedCollaborationStore, homeRowKey, inSchema, lockScope, type InboundIdentity } from './store';
import { freezeIntent, HostedSubmitter } from './intents';
import type { TaskEvidence } from './reconcile';

// #957: the owner switch of a device (§4.1) on H: freeze, drain, commit or abort, each on the expected mode revision.
let opened: Awaited<ReturnType<typeof openStore>> | undefined, hosted: HostedCollaborationStore | undefined;
/** A store over the test schema with one Host intent handler, `job`. */
const open = () => new HostedCollaborationStore(opened!.pool, opened!.store.schema, { host: TEST_HOST, hostIntents: { job: () => {} } });
const store = (): HostedCollaborationStore => hosted!;
const table = (name: string) => `"${store().schema}".${name}`;
const SYNC = { ...SYNC_OPTIONS, history: undefined };
const IDENTITY: InboundIdentity = { owner: 'owner', self: {} };
const clock = () => VECTOR_NOW;
const refused = (reason: string) => expect.objectContaining({ name: 'DeviceSwitchRefusedError', code: 'switch_refused', reason });
const switching = (target: 'L' | 'H', revision: number) =>
  expect.objectContaining({ name: 'DeviceSwitchingError', code: DEVICE_SWITCHING, deviceId: 'device', target, revision });
const modeRefusal = expect.objectContaining({ name: 'DeviceBindingError', code: 'device_not_bound', reason: 'mode' });
const binding = async (scope: string) => (await opened!.pool.query<{ mode: string; mode_revision: string; switching: string | null }>(
  `SELECT mode, mode_revision::text, switching FROM ${table('device_binding')} WHERE scope = $1 AND device = $2`,
  [storedKey(scope), storedKey('device')])).rows[0];
const intents = async (scope: string) => (await opened!.pool.query<{ key: string; tries: number; cancel_reason: string | null; conclusion: string | null }>(
  `SELECT key, tries, cancel_reason, conclusion FROM ${table('intent')} WHERE scope = $1 ORDER BY ordinal`, [storedKey(scope)])).rows
  .map(row => ({ ...row, key: JSON.parse(row.key) as string }));
const dueAt = async (scope: string) => (await opened!.pool.query<{ due_at: string | null }>(`SELECT due_at::text FROM ${table('scope')} WHERE scope = $1`,
  [storedKey(scope)])).rows[0]!.due_at;
const queued = (state: CollaborationState, id: string) => {
  state.turns[id] = { id, root: id, botId: 'main', source: 'user', request: id, hop: 0, status: 'queued', authority: 'owner' };
};
/** The seeded Main Bot runs on `device`, bound to H. `turns` are its queued Turns. */
async function bound(...turns: string[]): Promise<string> {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, state => {
    seedCollaboration(state);
    Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    for (const id of turns) queued(state, id);
  });
  await store().bindDevice(scope, 'device');
  return scope;
}
/** An SDK tenant in memory, with a hook that runs when the submit reads the offer back. */
function fakePort() {
  const submitted: string[] = [], hooks: { offer?: () => Promise<void> } = {};
  const port: FrozenSubmitPort = {
    submit: async input => { submitted.push(input.taskId); return undefined as never; },
    offer: async () => { await hooks.offer?.(); return undefined as never; },
  };
  return { port, submitted, hooks };
}
const submitter = (port: FrozenSubmitPort) =>
  new HostedSubmitter(opened!.pool, store().schema, { port: () => port, now: clock, leaseMs: 1000, backoffMs: 500 });

describe.skipIf(POSTGRES_URL === undefined)('H owner switch on real Postgres (#957)', () => {
  // One schema for each test, because the submit and sender scans cover the whole schema.
  beforeEach(async () => { opened = await openStore(); hosted = open(); });
  afterEach(async () => { await opened?.close(); });

  it('steps through freeze, commit and abort on the expected revision, and refuses every other step with nothing written', async () => {
    const scope = await bound();
    await expect(store().beginSwitch(scope, 'device', 'L', 0)).rejects.toEqual(refused('stale_revision'));
    await expect(store().beginSwitch(scope, 'device', 'H', 1)).rejects.toEqual(refused('same_mode'));
    await expect(store().commitSwitch(scope, 'device', 1)).rejects.toEqual(refused('not_switching'));
    expect(await binding(scope)).toEqual({ mode: 'H', mode_revision: '1', switching: null });
    expect(await store().beginSwitch(scope, 'device', 'L', 1)).toEqual({ mode: 'H', revision: 2, switching: 'L', revoked: false });
    const frozen = await store().dump(scope);
    await expect(store().beginSwitch(scope, 'device', 'L', 2)).rejects.toEqual(refused('switching'));
    await expect(store().commitSwitch(scope, 'device', 1)).rejects.toEqual(refused('stale_revision'));
    await expect(store().abortSwitch(scope, 'device', 3)).rejects.toEqual(refused('stale_revision'));
    expect(await store().dump(scope)).toBe(frozen);
    expect(await store().commitSwitch(scope, 'device', 2)).toEqual({ mode: 'L', revision: 3, revoked: false });
    // The device is L's now. Coming back to H is another switch, never a bind.
    await expect(store().bindDevice(scope, 'device')).rejects.toEqual(modeRefusal);
    expect(await store().beginSwitch(scope, 'device', 'H', 3)).toEqual({ mode: 'L', revision: 4, switching: 'H', revoked: false });
    expect(await store().abortSwitch(scope, 'device', 4)).toEqual({ mode: 'L', revision: 5, revoked: false });
  });

  it('switches a device with no row, in the default mode L at revision 0, to H, and then its work freezes', async () => {
    const scope = `tenant:${randomUUID()}`;
    await store().seed(scope, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      queued(state, 'q1');
    });
    await expect(store().beginSwitch(scope, 'device', 'L', 0)).rejects.toEqual(refused('same_mode'));
    await expect(store().beginSwitch(scope, 'device', 'H', 1)).rejects.toEqual(refused('stale_revision'));
    expect(await store().beginSwitch(scope, 'device', 'H', 0)).toEqual({ mode: 'L', revision: 1, switching: 'H', revoked: false });
    // H is the new owner here: L drains its own work, and H's queued Turn of the device is the work that runs after.
    await expect(store().drainDevice(scope, 'device', 1, { cancel: true }, clock)).rejects.toEqual(refused('not_owner'));
    expect(await store().commitSwitch(scope, 'device', 1)).toEqual({ mode: 'H', revision: 2, revoked: false });
    await store().sync(scope, SYNC);
    expect((await intents(scope)).map(row => row.key)).toEqual(['q1']);
  });

  it('ends an open switch with a revoke, so the device is never left frozen', async () => {
    const scope = await bound();
    await store().beginSwitch(scope, 'device', 'L', 1);
    await store().revokeDevice(scope, 'device', 5);
    expect(await binding(scope)).toEqual({ mode: 'H', mode_revision: '3', switching: null });
    await expect(store().commitSwitch(scope, 'device', 3)).rejects.toEqual(refused('revoked'));
    await expect(store().drainDevice(scope, 'device', 3, {}, clock)).rejects.toEqual(refused('revoked'));
  });

  it('refuses every write that creates execution on the frozen device with the typed refusal, and writes nothing', async () => {
    const scope = await bound();
    await store().beginSwitch(scope, 'device', 'L', 1);
    const frozen = await store().dump(scope);
    const input = { kind: 'input' as const, botId: 'main', key: 'k', request: 'Work', sender: 'owner' as const };
    await expect(store().commit(scope, { scope, commandId: randomUUID(), command: input }, clock, { requireBinding: true }))
      .rejects.toEqual(switching('L', 2));
    const owner: InboundMessage = { channel: 'fake', platformMessageId: 'in1', conversation: { kind: 'direct', id: 'main' },
      sender: { id: 'owner', kind: 'human' }, text: 'Do it', mentions: [] };
    await expect(store().receive(scope, owner, IDENTITY, clock)).rejects.toEqual(switching('L', 2));
    await expect(store().enqueueHostIntent(scope, { key: 'h1', source: 'user', execution: template('device'), waitUntil: VECTOR_NOW + 60_000 },
      'job', clock)).rejects.toEqual(switching('L', 2));
    // A restarted Host reads the freeze from the row: a new store refuses the same input.
    await expect(open().commit(scope, { scope, commandId: randomUUID(), command: input }, clock, { requireBinding: true }))
      .rejects.toEqual(switching('L', 2));
    expect(await store().dump(scope)).toBe(frozen);
    // After the commit to L, the same input is refused for good with the mode reason.
    await store().commitSwitch(scope, 'device', 2);
    await expect(store().receive(scope, owner, IDENTITY, clock)).rejects.toEqual(modeRefusal);
  });

  it('holds a Turn that reaches the sync during the freeze, and freezes it after an abort', async () => {
    const scope = await bound('q1');
    await store().beginSwitch(scope, 'device', 'L', 1);
    await store().sync(scope, SYNC);
    const state = await store().read(scope);
    expect([state.turns.q1!.held, state.audit]).toEqual([DEVICE_SWITCHING, [`Turn held ${DEVICE_SWITCHING} switching: q1`]]);
    expect(await intents(scope)).toEqual([]);
    expect(await dueAt(scope)).toBeNull();
    await store().abortSwitch(scope, 'device', 2);
    expect(await dueAt(scope)).toBe('0');
    await store().sync(scope, SYNC);
    expect((await store().read(scope)).turns.q1).not.toHaveProperty('held');
    expect((await intents(scope)).map(row => row.key)).toEqual(['q1']);
  });

  it('does not submit an intent claimed before the freeze: the read right before the SDK call refuses it', async () => {
    const scope = await bound('q1');
    await store().sync(scope, SYNC);
    const sdk = fakePort();
    sdk.hooks.offer = async () => { sdk.hooks.offer = undefined; await store().beginSwitch(scope, 'device', 'L', 1); };
    expect(await submitter(sdk.port).run()).toEqual({ tried: 1, failed: [] });
    expect(sdk.submitted).toEqual([]);
    expect((await opened!.pool.query(`SELECT last_error FROM ${table('intent')} WHERE scope = $1`, [storedKey(scope)])).rows)
      .toEqual([{ last_error: 'Device is switching to L: device' }]);
    // The next pass does not claim it either.
    const pass = await submitter(sdk.port).run();
    expect([pass.tried, sdk.submitted]).toEqual([0, []]);
  });

  it('commits only after the drain: cancels what never ran, and waits for the conclusion of a tried intent', async () => {
    const scope = await bound('q1', 'q2', 'q3');
    await store().sync(scope, SYNC);
    // q1 is tried (a submit that ran); q2 and q3 are frozen and never tried.
    await opened!.pool.query(`UPDATE ${table('intent')} SET tries = 1, submission = 'delivered' WHERE scope = $1 AND key = $2`,
      [storedKey(scope), storedKey('q1')]);
    await store().beginSwitch(scope, 'device', 'L', 1);
    const before = await store().drainDevice(scope, 'device', 2, {}, clock);
    expect(before).toEqual({ open: { intents: ['q1', 'q2', 'q3'], turns: ['q1', 'q2', 'q3'], batches: [], homes: [] }, failed: [] });
    await expect(store().commitSwitch(scope, 'device', 2)).rejects.toEqual(refused('open_work'));
    const drained = await store().drainDevice(scope, 'device', 2, { cancel: true }, clock);
    expect(drained.failed).toEqual([]);
    // The tried intent keeps its cancel reason and stays open until the reconciliation concludes it.
    expect(drained.open.intents).toEqual(['q1']);
    expect(await intents(scope)).toEqual([
      { key: 'q1', tries: 1, cancel_reason: 'cancelled', conclusion: null },
      { key: 'q2', tries: 0, cancel_reason: 'cancelled', conclusion: 'cancelled' },
      { key: 'q3', tries: 0, cancel_reason: 'cancelled', conclusion: 'cancelled' }]);
    // A second drain cancels again and changes no intent row: the cancel of a cancelled intent is a no-op.
    const rows = await intents(scope);
    expect((await store().drainDevice(scope, 'device', 2, { cancel: true }, clock)).failed).toEqual([]);
    expect(await intents(scope)).toEqual(rows);
    await expect(store().commitSwitch(scope, 'device', 2)).rejects.toEqual(refused('open_work'));
    // The reconciliation's conclusion of q1, as it writes it from the SDK evidence.
    await opened!.pool.query(`UPDATE ${table('intent')} SET conclusion = 'cancelled' WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey('q1')]);
    await store().sync(scope, SYNC);
    expect((await store().drainDevice(scope, 'device', 2, {}, clock)).open).toEqual({ intents: [], turns: [], batches: [], homes: [] });
    expect(await store().commitSwitch(scope, 'device', 2)).toEqual({ mode: 'L', revision: 3, revoked: false });
  });

  it('cancels a Host intent with no Turn in the drain, and then commits', async () => {
    const scope = await bound();
    await store().enqueueHostIntent(scope, { key: 'h1', source: 'user', execution: template('device'), waitUntil: VECTOR_NOW + 60_000 }, 'job', clock);
    await store().beginSwitch(scope, 'device', 'L', 1);
    expect((await store().drainDevice(scope, 'device', 2, {}, clock)).open).toEqual({ intents: ['h1'], turns: [], batches: [], homes: [] });
    expect(await store().drainDevice(scope, 'device', 2, { cancel: true }, clock))
      .toEqual({ open: { intents: [], turns: [], batches: [], homes: [] }, failed: [] });
    expect(await intents(scope)).toEqual([{ key: 'h1', tries: 0, cancel_reason: 'cancelled', conclusion: 'cancelled' }]);
    expect(await store().commitSwitch(scope, 'device', 2)).toEqual({ mode: 'L', revision: 3, revoked: false });
  });

  it('does not fire a Bot routine of the frozen device: nothing is written, and the slot fires after an abort', async () => {
    const scope = `tenant:${randomUUID()}`, now = Date.UTC(2026, 0, 1), schedule = { minute: 0, hour: 9, tz: 'UTC' };
    await store().seed(scope, state => seedCollaboration(state));
    await store().bindDevice(scope, 'device');
    // The seed's processing owner Turn `t1` creates one Bot routine through its outcome.
    await inSchema(opened!.pool, store().schema, async client => {
      await lockScope(client, storedKey(scope));
      await freezeIntent(client, scope, { key: 't1', source: 'user', execution: template('device'), waitUntil: now + 60_000 });
    });
    const document: Json = { create_routine: [{ localId: 'new_routine_1', schedule, prompt: 'Daily report' }] };
    const evidence = { terminal: { envelope: { task_id: taskId('t1', 0), type: 'task.complete', payload: { document } } } as unknown as DeviceTerminal,
      attempt: { taskId: taskId('t1', 0) } as unknown as TaskAttempt } satisfies TaskEvidence;
    expect(await store().finish(scope, 't1', evidence, () => now)).toBe('succeeded');
    const id = hash([taskId('t1', 0), 'create_routine', 0]);
    const first = routineCalendar({ rule: schedule, timeZone: 'UTC' } as unknown as RoutineDefinition, now - 1)!;
    await store().beginSwitch(scope, 'device', 'L', 1);
    const frozen = await store().dump(scope);
    await expect(store().fire(scope, id, first)).rejects.toEqual(switching('L', 2));
    // The routine scheduler counts that fire as fenced, as for a device with no binding.
    const pass = await new HostedRoutineScheduler(opened!.pool, store(), { now: () => first }).run();
    expect([pass.fired, pass.failed, pass.fenced.map(row => row.error)]).toEqual([0, [], [switching('L', 2)]]);
    expect(await store().dump(scope)).toBe(frozen);
    expect((await opened!.pool.query(`SELECT 1 FROM ${table('occurrence')} WHERE scope = $1`, [storedKey(scope)])).rows).toEqual([]);
    await store().abortSwitch(scope, 'device', 2);
    expect(await store().fire(scope, id, first)).toBe('fired');
  });

  /** Adds a pending Agent home operation of the Main Bot and its due home row, as a commit's home index writes it. */
  async function pendingHome(scope: string): Promise<number> {
    let sequence = 0;
    await store().seed(scope, state => {
      sequence = ++state.sequence;
      state.team.homeOperations.push({ sequence, botId: 'main', status: 'pending', retries: [], request: { deviceId: 'device',
        payload: { requestId: `r-${sequence}`, agentRef: { agentId: 'main', profileRevision: '1' }, projectionHash: 'sha256:1',
          projection: { schemaVersion: 'bot-profile.v1', name: 'Main', role: 'Team owner', persona: '', model: 'default' } } } as never });
    });
    await opened!.pool.query(`INSERT INTO ${table('outbox')} (scope, key, ordinal, kind, next_at) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'home', 0
      FROM ${table('outbox')} WHERE scope = $1`, [storedKey(scope), homeRowKey(sequence)]);
    return sequence;
  }
  /** A sender whose home port reads every request back as applied, and records each read. */
  const homeSender = (reads: string[], now = VECTOR_NOW) => new HostedOutboxSender(opened!.pool, store(), { projections: { deliver: async () => {} }, now: () => now,
    leaseMs: 20_000, sendTimeoutMs: 10_000, backoffMs: 5_000, homes: () => ({
      read: async request => { reads.push(request.payload.requestId); return { deviceId: request.deviceId, agentRef: request.payload.agentRef,
        requestId: request.payload.requestId, projectionHash: request.payload.projectionHash, status: 'applied' as const }; },
      enqueue: async () => {} }) });
  const backedOff = async (scope: string, sequence: number) => expect((await opened!.pool.query(`SELECT next_at::text, settled_at FROM
    ${table('outbox')} WHERE scope = $1 AND key = $2`, [storedKey(scope), homeRowKey(sequence)])).rows).toEqual([{ next_at: String(VECTOR_NOW + 5_000), settled_at: null }]);

  it('flushes a pending home operation while the switch is open, and backs it off after a commit to L', async () => {
    const scope = await bound(), reads: string[] = [];
    const first = await pendingHome(scope);
    await store().beginSwitch(scope, 'device', 'L', 1);
    expect((await store().drainDevice(scope, 'device', 2, {}, clock)).open.homes).toEqual([first]);
    await homeSender(reads).run();
    expect(reads).toEqual([`r-${first}`]);
    expect((await store().drainDevice(scope, 'device', 2, {}, clock)).open.homes).toEqual([]);
    await store().commitSwitch(scope, 'device', 2);
    const second = await pendingHome(scope);
    await homeSender(reads).run();
    expect(reads).toEqual([`r-${first}`]);
    await backedOff(scope, second);
  });

  it('backs off home flushes during a switch from L to H, and flushes them after its commit', async () => {
    const scope = `tenant:${randomUUID()}`, reads: string[] = [];
    await store().seed(scope, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    });
    const sequence = await pendingHome(scope);
    await store().beginSwitch(scope, 'device', 'H', 0);
    await homeSender(reads).run();
    expect(reads).toEqual([]);
    await backedOff(scope, sequence);
    await store().commitSwitch(scope, 'device', 1);
    // The row waits the backoff of its fenced try, then flushes.
    await homeSender(reads, VECTOR_NOW + 5_000).run();
    expect(reads).toEqual([`r-${sequence}`]);
  });

  it('stops a drain that an abort overtook: no cancel after the abort, and the drain refuses', async () => {
    const scope = await bound('q1');
    await store().beginSwitch(scope, 'device', 'L', 1);
    // The abort lands after the drain read its work and before its first cancel.
    const read = store().read.bind(store());
    vi.spyOn(store(), 'read').mockImplementationOnce(async target => { await store().abortSwitch(scope, 'device', 2); return read(target); });
    await expect(store().drainDevice(scope, 'device', 2, { cancel: true }, clock)).rejects.toEqual(refused('not_switching'));
    expect((await store().read(scope)).turns.q1).toMatchObject({ status: 'queued' });
    expect((await store().read(scope)).turns.q1).not.toHaveProperty('conclusion');
  });
});

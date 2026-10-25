import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenInput, FrozenSubmitPort } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { DEVICE_NOT_BOUND } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { DeviceBindingError } from './binding';
import { freezeIntent, HostedSubmitter } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { inSchema, lockScope } from './store';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
const binding = async (scope: string, device: string) => (await opened!.pool.query<{ mode: string; mode_revision: string; revoked_at: string | null }>(
  `SELECT mode, mode_revision::text, revoked_at::text FROM ${table('device_binding')} WHERE scope = $1 AND device = $2`,
  [storedKey(scope), storedKey(device)])).rows[0];
const refusal = (reason: DeviceBindingError['reason']) => expect.objectContaining({ name: 'DeviceBindingError', code: 'device_not_bound', reason });
/** A queued user Turn `q1` of the seeded Main Bot, which runs on `device`. */
const queued = (state: CollaborationState) => {
  seedCollaboration(state);
  Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
  state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'First', hop: 0, status: 'queued', authority: 'owner' };
};
const SYNC = { ...SYNC_OPTIONS, history: undefined };

/** An SDK tenant in memory, with a hook that runs when the submit reads the offer back. */
function fakePort() {
  const offers = new Map<string, unknown>(), submitted: string[] = [];
  const hooks: { offer?: () => Promise<void> } = {};
  const port: FrozenSubmitPort = {
    submit: async input => {
      submitted.push(input.taskId);
      offers.set(input.taskId, { taskId: input.taskId, deviceId: input.deviceId, type: 'task.offer_for_agent_with_egress_fresh',
        payload: structuredClone(input.payload), delivered: true, messageId: `offer-${input.taskId}` });
      return undefined as never;
    },
    offer: async id => { await hooks.offer?.(); return offers.get(id) as never; },
  };
  return { port, submitted, hooks };
}

describe.skipIf(POSTGRES_URL === undefined)('H device binding on real Postgres (#793 D2e)', () => {
  let clock = 1_000_000;
  // One schema for each test, because the submit scan covers the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  it('binds a device to H once, revokes it once with a raised revision, and never binds the revoked id again (O1 option A)', async () => {
    const scope = `tenant:${randomUUID()}`;
    expect(await store().bindDevice(scope, 'device')).toBe(1);
    const bound = await store().dump(scope);
    expect(await store().bindDevice(scope, 'device')).toBe(1);
    expect(await store().dump(scope)).toBe(bound);
    expect(await binding(scope, 'device')).toEqual({ mode: 'H', mode_revision: '1', revoked_at: null });
    await store().revokeDevice(scope, 'device', 5);
    expect(await binding(scope, 'device')).toEqual({ mode: 'H', mode_revision: '2', revoked_at: '5' });
    const revoked = await store().dump(scope);
    await store().revokeDevice(scope, 'device', 9);
    await expect(store().bindDevice(scope, 'device')).rejects.toEqual(refusal('revoked'));
    expect(await store().dump(scope)).toBe(revoked);
    // A revoke of a device id that was never bound is final too: it leaves a tombstone in the default mode L.
    await store().revokeDevice(scope, 'other', 7);
    expect(await binding(scope, 'other')).toEqual({ mode: 'L', mode_revision: '2', revoked_at: '7' });
    const tombstone = await store().dump(scope);
    await store().revokeDevice(scope, 'other', 9);
    await expect(store().bindDevice(scope, 'other')).rejects.toEqual(refusal('revoked'));
    expect(await store().dump(scope)).toBe(tombstone);
  });

  it('revokes a device id in a scope that has no row yet, and refuses a later bind of that id', async () => {
    const scope = `tenant:${randomUUID()}`;
    await store().revokeDevice(scope, 'device', 5);
    expect(await binding(scope, 'device')).toEqual({ mode: 'L', mode_revision: '2', revoked_at: '5' });
    await expect(store().bindDevice(scope, 'device')).rejects.toEqual(refusal('revoked'));
    // Another device of the scope still binds, at the next ordinal.
    expect(await store().bindDevice(scope, 'other')).toBe(1);
  });

  it.each(['unbound', 'revoked', 'mode'] as const)('holds the Turn of a device that is %s with no intent, and the sync goes on (#956)', async reason => {
    const scope = `tenant:${randomUUID()}`;
    await store().seed(scope, queued);
    if (reason !== 'unbound') await store().bindDevice(scope, 'device');
    if (reason === 'revoked') await store().revokeDevice(scope, 'device', 5);
    if (reason === 'mode') await opened!.pool.query(`UPDATE ${table('device_binding')} SET mode = 'L' WHERE scope = $1`, [storedKey(scope)]);
    expect(await store().sync(scope, SYNC)).toEqual({ dueAt: null });
    const state = await store().read(scope);
    expect([state.turns.q1!.held, state.audit]).toEqual([DEVICE_NOT_BOUND, [`Turn held ${DEVICE_NOT_BOUND} ${reason}: q1`]]);
    expect((await opened!.pool.query(`SELECT key FROM ${table('intent')} WHERE scope = $1`, [storedKey(scope)])).rows).toEqual([]);
    expect((await opened!.pool.query(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey('held:q1')])).rows)
      .toEqual([{ body: { owner: 'main', turnId: 'q1', code: DEVICE_NOT_BOUND } }]);
  });

  /** A bound scope with one frozen intent on `device`, due now. */
  async function frozen() {
    const scope = `tenant:${randomUUID()}`;
    await store().seed(scope, () => {});
    await store().bindDevice(scope, 'device');
    const input: FrozenInput = await inSchema(opened!.pool, store().schema, async client => {
      await lockScope(client, storedKey(scope));
      return freezeIntent(client, scope, { key: 'q1', source: 'user', execution: template('device'), waitUntil: clock + 60_000 });
    });
    return { scope, input };
  }
  const submitter = (port: FrozenSubmitPort) =>
    new HostedSubmitter(opened!.pool, store().schema, { port: () => port, now: () => clock, leaseMs: 1000, backoffMs: 500 });
  const row = async (scope: string) => (await opened!.pool.query<{ submission: string; tries: number; next_at: string; last_error: string | null;
    cancel_reason: string | null; conclusion: string | null }>(
    `SELECT submission, tries, next_at::text, last_error, cancel_reason, conclusion FROM ${table('intent')} WHERE scope = $1`, [storedKey(scope)])).rows[0]!;

  it('does not claim the intent of a revoked device: no SDK call, and the row backs off with the error', async () => {
    const { scope } = await frozen(), sdk = fakePort();
    await store().revokeDevice(scope, 'device', clock);
    const pass = await submitter(sdk.port).run();
    expect([pass.tried, pass.failed.map(failure => failure.error)]).toEqual([0, [refusal('revoked')]]);
    expect(sdk.submitted).toEqual([]);
    expect(await row(scope)).toEqual({ submission: 'reserved', tries: 0, next_at: String(clock + 500),
      last_error: 'Device has no active H binding: revoked', cancel_reason: null, conclusion: null });
  });

  it('does not submit when the device is revoked between the claim and the SDK call, and records no expiry', async () => {
    const { scope } = await frozen(), sdk = fakePort();
    // The submit reads the offer back before its last check. The revoke lands in that window.
    sdk.hooks.offer = async () => { sdk.hooks.offer = undefined; await store().revokeDevice(scope, 'device', clock); };
    expect(await submitter(sdk.port).run()).toEqual({ tried: 1, failed: [] });
    expect(sdk.submitted).toEqual([]);
    expect(await row(scope)).toEqual({ submission: 'uncertain', tries: 1, next_at: String(clock + 500),
      last_error: 'Device has no active H binding: revoked', cancel_reason: null, conclusion: null });
  });

  it('does not submit when the mode revision changes between the claim and the SDK call without a revoke', async () => {
    const { scope } = await frozen(), sdk = fakePort();
    // No writer changes only the revision yet (a mode switch will). The check before the SDK call compares it with the claim.
    sdk.hooks.offer = async () => {
      sdk.hooks.offer = undefined;
      await opened!.pool.query(`UPDATE ${table('device_binding')} SET mode_revision = mode_revision + 1 WHERE scope = $1`, [storedKey(scope)]);
    };
    expect(await submitter(sdk.port).run()).toEqual({ tried: 1, failed: [] });
    expect(sdk.submitted).toEqual([]);
    expect(await row(scope)).toEqual({ submission: 'uncertain', tries: 1, next_at: String(clock + 500),
      last_error: 'Device has no active H binding: revision', cancel_reason: null, conclusion: null });
  });

  it('submits the intent of a bound device', async () => {
    const { scope, input } = await frozen(), sdk = fakePort();
    expect(await submitter(sdk.port).run()).toEqual({ tried: 1, failed: [] });
    expect(sdk.submitted).toEqual([input.taskId]);
    expect(await row(scope)).toMatchObject({ submission: 'delivered', tries: 1, last_error: null });
  });
});

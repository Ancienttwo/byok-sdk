import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hash, sealRoutineTemplate, type FrozenSubmitPort, type Json, type RoutineDefinition, type SealedAgentExecutionInput } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { routineCalendar, sealedRoutineInstruction, SealedRoutineVersionError, type SealedRoutineAction,
  type SealedRoutineTemplate } from '@byok-sdk/example-bot-collaboration/routines';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { HostedCommandEntry, type EntryCaller } from './entry';
import { freezeIntent, HostedSubmitter } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { inSchema, lockScope } from './store';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
const query = <T extends object>(text: string, values: unknown[]) => opened!.pool.query<T>(text, values).then(found => found.rows);

const DAILY = { minute: 0, hour: 9, tz: 'UTC' };
const slotAfter = (after: number) => routineCalendar({ rule: DAILY, timeZone: 'UTC' } as unknown as RoutineDefinition, after)!;
/** The K8 calendar takes epoch times in [2000, 2200). */
const NOW = Date.UTC(2026, 0, 1);
const FIRST = slotAfter(NOW - 1);
const SYNC = { ...SYNC_OPTIONS, now: FIRST, history: undefined };
const ID = randomUUID();
const sealing = { scopeId: 'scope-1', epoch: 1, categories: ['task-input' as const] };
const notAfter = '2099-01-01T00:00:00.000Z';
const agentRef = template('device', 'main').payload.agentRef;

async function sealed(definitionVersion: number, prompt: string): Promise<SealedRoutineTemplate> {
  const template = await sealRoutineTemplate({ tenantId: 'tenant', scopeKey: Uint8Array.from({ length: 32 }, (_, index) => index), sealing,
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` }, sender: 'A'.repeat(43), routineRef: { routineId: ID, definitionVersion, notAfter },
    agentRef, instruction: sealedRoutineInstruction(prompt) });
  return { sealing, template, agentRef: { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision }, notAfter };
}

const routineRow = async (scope: string) => (await query<{ definition: RoutineDefinition; pending: RoutineDefinition | null; next_at: string | null }>(
  `SELECT definition, pending, next_at::text FROM ${table('routine')} WHERE scope = $1 AND id = $2`, [storedKey(scope), storedKey(ID)]))[0];
const intentRow = async (scope: string, key: string) => (await query<{ source: string; input: SealedAgentExecutionInput; last_error: string | null;
  preparation_error: string | null; conclusion: string | null; tries: number }>(
  `SELECT source, input, last_error, preparation_error, conclusion, tries FROM ${table('intent')} WHERE scope = $1 AND key = $2`,
[storedKey(scope), storedKey(key)]))[0];

describe.skipIf(POSTGRES_URL === undefined)('H sealed Bot routines on real Postgres (#953)', () => {
  let v1: SealedRoutineTemplate, v2: SealedRoutineTemplate, rival: SealedRoutineTemplate;
  beforeAll(async () => { [v1, v2, rival] = await Promise.all([sealed(1, 'Check the watchlist.'), sealed(2, 'Check it again.'), sealed(2, 'A rival edit.')]); });
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });
  const action = (definitionVersion: number, template: SealedRoutineTemplate): SealedRoutineAction =>
    ({ routineId: ID, definitionVersion, schedule: DAILY, sealed: template });

  /** A seeded scope whose Main Bot runs on the bound device `device`, with a sealed routine at version 1 and no open Turn. */
  async function scoped(create = true): Promise<string> {
    const scope = `tenant:${randomUUID()}`;
    await store().seed(scope, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    });
    await store().bindDevice(scope, 'device');
    if (create) await store().createSealedRoutine(scope, 'main', action(1, v1), NOW);
    return scope;
  }
  /** Fires the first slot and syncs. Returns the occurrence Turn id. */
  async function frozen(scope: string): Promise<string> {
    expect(await store().fire(scope, ID, FIRST)).toBe('fired');
    await store().sync(scope, SYNC);
    return `occurrence:${hash([ID, 1, { kind: 'scheduled', plannedAt: FIRST }])}`;
  }

  it('creates version 1 through the owner API, takes an exact retry as a no-op, and keeps it sealed', async () => {
    const scope = await scoped();
    expect(await routineRow(scope)).toMatchObject({ pending: null, next_at: String(FIRST), definition: { id: ID, version: 1,
      hostOccurrence: { type: 'bot-routine', input: { owner: 'main', authority: 'owner', sealed: { notAfter, template: v1.template as unknown as Json } } } } });
    const before = await store().dump(scope);
    await store().createSealedRoutine(scope, 'main', action(1, v1), NOW);
    expect(await store().dump(scope)).toBe(before);
    await expect(store().createSealedRoutine(scope, 'main', { ...action(1, v1), schedule: { ...DAILY, hour: 10 } }, NOW)).rejects.toThrow('already has this id');
    await expect(store().updateRoutine(scope, 'main', { routineId: ID, prompt: 'Plain now.' }, NOW)).rejects.toThrow('only through resealRoutine');
    expect(await store().dump(scope)).toBe(before);
  });

  it('fires the routine and freezes its Turn as a sealed occurrence intent, which goes to submitSealed', async () => {
    const scope = await scoped(), turn = await frozen(scope);
    const row = (await intentRow(scope, turn))!;
    expect(row.source).toBe('routine');
    expect(row.input.payload).not.toHaveProperty('instruction');
    expect(row.input.payload).toMatchObject({ sealing, sealed: v1.template, routineRef: { routineId: ID, definitionVersion: 1, notAfter } });
    expect((await store().read(scope)).turns[turn]).toMatchObject({ request: '', status: 'processing', sealedRoutine: { routineId: ID, definitionVersion: 1 } });
    const sent: SealedAgentExecutionInput[] = [];
    const port: FrozenSubmitPort = { submit: vi.fn(), offer: async () => undefined, submitSealed: async input => { sent.push(input); return {} as never; } };
    await new HostedSubmitter(opened!.pool, store().schema, { port: () => port, now: () => FIRST }).run();
    expect(sent).toEqual([row.input]);
    expect(port.submit).not.toHaveBeenCalled();
  });

  it('fails an untried sealed intent before any SDK call on a port with no sealed lane, as L does, and its Turn fails', async () => {
    const scope = await scoped(), turn = await frozen(scope);
    const port: FrozenSubmitPort = { submit: vi.fn(), offer: vi.fn(async () => undefined) }, changed: string[] = [];
    await new HostedSubmitter(opened!.pool, store().schema, { port: () => port, now: () => FIRST, changed: at => { changed.push(at); } }).run();
    expect(port.submit).not.toHaveBeenCalled();
    expect(port.offer).not.toHaveBeenCalled();
    expect(await intentRow(scope, turn)).toMatchObject({ conclusion: 'failed', tries: 0, last_error: null, preparation_error: 'sealed_dispatch_unavailable' });
    // The deployment syncs each scope that the submitter reports, which settles the Turn.
    expect(changed).toEqual([scope]);
    for (const at of changed) await store().sync(at, SYNC);
    expect((await store().read(scope)).turns[turn]).toMatchObject({ status: 'failed', conclusion: 'failed' });
  });

  it('reseals at the next version while an occurrence is open, replays it, and refuses a rival seal of the same version', async () => {
    const scope = await scoped();
    await frozen(scope);
    await store().resealRoutine(scope, 'main', action(2, v2), FIRST);
    // The open occurrence keeps version 1, so version 2 is staged.
    expect(await routineRow(scope)).toMatchObject({ definition: { version: 1 }, pending: { version: 2, hostOccurrence: { input: { sealed: { notAfter } } } } });
    const before = await store().dump(scope);
    await store().resealRoutine(scope, 'main', action(2, v2), FIRST);
    expect(await store().dump(scope)).toBe(before);
    // Another member sealed version 2 too: version 3 is the next one now, so that template is for another version.
    await expect(store().resealRoutine(scope, 'main', action(2, rival), FIRST)).rejects.toBeInstanceOf(SealedRoutineVersionError);
    expect(await store().dump(scope)).toBe(before);
  });

  it('freezes a sealed execution only as a routine occurrence, never as a Host intent', async () => {
    const scope = await scoped(), turn = await frozen(scope);
    const { taskId: _, ...execution } = (await intentRow(scope, turn))!.input;
    const forged = [{ source: 'user' }, { source: 'bot' }, { source: 'routine', handler: 'host-handler' }] as const;
    for (const [index, fields] of forged.entries()) {
      await expect(inSchema(opened!.pool, store().schema, async client => {
        await lockScope(client, storedKey(scope));
        return freezeIntent(client, scope, { key: `forged-${index}`, ...fields, execution, waitUntil: FIRST + 60_000 });
      })).rejects.toThrow('A sealed execution must be a routine template occurrence');
      expect(await intentRow(scope, `forged-${index}`)).toBeUndefined();
    }
  });

  it('takes both as owner commands of the entry: a non-owner is refused with nothing written, and an owner write syncs', async () => {
    const scope = await scoped(false), synced: string[] = [];
    const entry = new HostedCommandEntry<EntryCaller>(store(), { authenticate: async credential => credential, owner: async () => 'owner',
      sync: async (at, now) => { synced.push(at); return store().sync(at, { ...SYNC_OPTIONS, now, history: undefined }); }, now: () => NOW });
    const as = (id: string): EntryCaller => ({ scope, principal: { id, kind: 'human' } });
    await expect(entry.createSealedRoutine(as('mallory'), 'main', action(1, v1))).rejects.toMatchObject({ code: 'not_owner' });
    await expect(entry.resealRoutine(as('mallory'), 'main', action(2, v2))).rejects.toMatchObject({ code: 'not_owner' });
    expect(await routineRow(scope)).toBeUndefined();
    expect(synced).toEqual([]);
    await entry.createSealedRoutine(as('owner'), 'main', action(1, v1));
    // No occurrence is open, so version 2 replaces version 1 at once.
    await entry.resealRoutine(as('owner'), 'main', action(2, v2));
    expect(await routineRow(scope)).toMatchObject({ definition: { version: 2 }, pending: null });
    expect(synced).toEqual([scope, scope]);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@byok-sdk/example-host-execution-core';
import type { Command } from '@byok-sdk/example-bot-collaboration/rules/commands';
import type { CommandRecord, CommitRequest } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { commitVectors, seedCollaboration, type CommitSubject, type SeedTeam } from '@byok-sdk/example-bot-collaboration/test-support';
import { CallbackCommandError, HostedStoreVersionError, type CommitPortsFactory } from './store';
import { callbackPorts, memorySubject, vectorPorts } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
/** One H subject per call: a new scope of the shared test schema, seeded like the memory subject. */
async function hosted(team?: SeedTeam): Promise<CommitSubject> {
  const scope = `tenant:${randomUUID()}`;
  await store().seed(scope, state => seedCollaboration(state, team));
  return { scope, commit: request => store().commitIn(scope, request, callbackPorts), stored: () => store().dump(scope), state: () => store().read(scope) };
}
const input = (key: string, request = 'Hello'): Command => ({ kind: 'input', botId: 'main', key, request, sender: 'owner' });
const message = (turnId: string, taskId: string, body: string): Command =>
  ({ kind: 'message', turnId, message: { taskId, payload: { body, messageId: 'm1', contentHash: `sha256:${body}`, contentType: 'text/markdown' } } });
const outcome: Command = { kind: 'outcome', turnId: 't1', taskId: 'task-1',
  document: { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] } };
const team = (revision: number, ...bots: Array<{ id: string; persona?: string; mainBot?: boolean }>): Command => ({ kind: 'team_snapshot',
  snapshot: { revision, bots: bots.map(bot => ({ name: bot.id, role: 'Helper', persona: '', model: 'default', mainBot: false, ...bot })) } });

describe.skipIf(POSTGRES_URL === undefined)('H store on real Postgres (#793 D2a)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  commitVectors('H HostedCollaborationStore on Postgres', hosted);

  // #793 O2: only a byte compare sees drift in map order, key order or optional-field presence.
  it.each<[SeedTeam, Array<[string, Command]>]>([
    ['local', [
      ['10', input('k1')], ['2', input('k2')], ['10', input('k1')], ['a1', { kind: 'answer', questionId: 'q1', answer: 'Yes' }],
      ['d1', { kind: 'decide', cardId: 'c1', decision: 'confirmed' }], ['m1', { kind: 'set_main_bot', botId: 'main', mainBot: true }],
      ['task-1', outcome], ['task-9:m1', message('absent', 'task-9', 'a')], ['task-1:m1', message('t1', 'task-1', 'a')],
      ['\ud800', input('k3', 'a\u0000b')], ['\udc00', input('k4', ' ')], ['__proto__', input('k5')], ['constructor', input('k6')],
      ['10', input('k1', 'Other')], ['i9', input('k9')],
    ]],
    ['external', [
      [hash(['team', 2]), team(2, { id: 'main', mainBot: true }, { id: 'b2' })],
      [hash(['team', 3]), team(3, { id: 'main', mainBot: true, persona: 'New' })],
      [hash(['team', 1]), team(1, { id: 'main', mainBot: true })],
      [hash(['team', 4]), team(4, { id: 'main', mainBot: true }, { id: 'b2' })],
      ['i1', input('k1')],
    ]],
  ])('keeps the same state bytes as the memory subject after each step (%s team)', async (seed, steps) => {
    const memory = memorySubject(seed), h = await hosted(seed);
    expect(JSON.stringify(await h.state())).toBe(JSON.stringify(memory.state()));
    for (const [commandId, command] of steps) {
      const request: CommitRequest<Command> = { scope: 'memory', commandId, command };
      const settle = async (subject: CommitSubject, scope: string) => {
        try { return { result: await subject.commit({ ...request, scope }) }; } catch (error) { return { error: (error as Error).message }; }
      };
      expect(await settle(h, h.scope), commandId).toEqual(await settle(memory, memory.scope));
      expect(JSON.stringify(await h.state()), commandId).toBe(JSON.stringify(memory.state()));
    }
  });

  describe('the commit boundary (#793 D2f-6)', () => {
    const callbacks: Array<[string, Command]> = [['outcome', outcome], ['message', message('t1', 'task-1', 'a')],
      ['occurrence', { kind: 'occurrence', key: 'o1' }]];

    it.each(callbacks)('refuses the callback command %s before any write, also on a retry', async (kind, command) => {
      const h = await hosted(), before = await h.stored();
      for (const attempt of [1, 2]) {
        const refusal = await store().commit(h.scope, { scope: h.scope, commandId: `callback-${kind}`, command }, vectorPorts)
          .then(() => undefined, (error: unknown) => error);
        expect(refusal, `try ${attempt}`).toBeInstanceOf(CallbackCommandError);
        expect(refusal, `try ${attempt}`).toMatchObject({ kind, message: `commit() does not take the K4 callback command ${kind}` });
        expect(await h.stored(), `try ${attempt}`).toBe(before);
      }
    });

    it.each(callbacks)('refuses the callback command %s for a scope with no row, and creates no scope row', async (_kind, command) => {
      const scope = `tenant:${randomUUID()}`, before = await store().dump(scope);
      await expect(store().commit(scope, { scope, commandId: 'c1', command }, vectorPorts)).rejects.toBeInstanceOf(CallbackCommandError);
      expect(await store().dump(scope)).toBe(before);
      expect((await opened!.pool.query(`SELECT 1 FROM "${store().schema}".scope WHERE scope = $1`, [JSON.stringify(scope)])).rows).toEqual([]);
    });

    it('refuses a callback command before it reads or locks the scope row: an unknown store version is not reached', async () => {
      const h = await hosted();
      await h.commit({ scope: h.scope, commandId: 'i1', command: input('k1') });
      await opened!.pool.query(`UPDATE "${store().schema}".scope SET state_version = 3 WHERE scope = $1`, [JSON.stringify(h.scope)]);
      await expect(store().commit(h.scope, { scope: h.scope, commandId: 'task-1', command: outcome }, vectorPorts)).rejects.toBeInstanceOf(CallbackCommandError);
      await expect(store().commit(h.scope, { scope: h.scope, commandId: 'i2', command: input('k2') }, vectorPorts)).rejects.toBeInstanceOf(HostedStoreVersionError);
    });

    it('takes no outcome or occurrence port in the commit ports, by type', () => {
      // @ts-expect-error The commit ports carry no outcome port.
      const withOutcome: CommitPortsFactory = (state, publish) => callbackPorts(state, publish);
      // @ts-expect-error The commit ports carry no occurrence port.
      const withOccurrence: CommitPortsFactory = (state, publish) => ({ ...vectorPorts(state, publish), occurrence: () => {} });
      const plain: CommitPortsFactory = vectorPorts;
      expect([withOutcome, withOccurrence, plain].every(ports => typeof ports === 'function')).toBe(true);
    });
  });

  it('refuses a scope row of an unknown store version under the lock, and writes nothing', async () => {
    const h = await hosted();
    await h.commit({ scope: h.scope, commandId: 'i1', command: input('k1') });
    await opened!.pool.query(`UPDATE "${store().schema}".scope SET state_version = 3 WHERE scope = $1`, [JSON.stringify(h.scope)]);
    const before = await h.stored();
    await expect(h.commit({ scope: h.scope, commandId: 'i2', command: input('k2') })).rejects.toBeInstanceOf(HostedStoreVersionError);
    await expect(h.commit({ scope: h.scope, commandId: 'i1', command: input('k1') })).rejects.toThrow('Unsupported hosted collaboration store version 3');
    await expect(h.state()).rejects.toBeInstanceOf(HostedStoreVersionError);
    expect(await h.stored()).toBe(before);
  });

  it('refuses a projection that another value already holds, and leaves every row unchanged', async () => {
    const h = await hosted(), card = hash(['task-1', 'confirmable_action', 0]);
    await opened!.pool.query(`INSERT INTO "${store().schema}".outbox (scope, key, ordinal, kind, body) VALUES ($1, $2, 0, 'projection', '{"other":true}')`,
      [JSON.stringify(h.scope), JSON.stringify(`card:${card}`)]);
    const before = await h.stored();
    await expect(h.commit({ scope: h.scope, commandId: 'task-1', command: outcome })).rejects.toThrow('Projection identity conflict');
    expect(await h.stored()).toBe(before);
    expect((await h.state()).revision).toBeUndefined();
  });

  it('stores the outbox row of a projection once, and a replay writes nothing', async () => {
    const h = await hosted(), card = hash(['task-1', 'confirmable_action', 0]);
    const first = await h.commit({ scope: h.scope, commandId: 'task-1', command: outcome });
    const rows = await opened!.pool.query(`SELECT key, ordinal::text, kind, body::text FROM "${store().schema}".outbox WHERE scope = $1`, [JSON.stringify(h.scope)]);
    expect(rows.rows).toEqual([{ key: JSON.stringify(`card:${card}`), ordinal: '0', kind: 'projection', body: expect.stringContaining('"hello"') }]);
    const stored = await h.stored();
    expect(await h.commit({ scope: h.scope, commandId: 'task-1', command: outcome })).toEqual(first);
    expect(await h.stored()).toBe(stored);
  });

  it('keeps two ids that UTF-8 would merge as two command records (#793 O4)', async () => {
    const h = await hosted();
    await h.commit({ scope: h.scope, commandId: '\ud800', command: input('k1') });
    await h.commit({ scope: h.scope, commandId: '\udc00', command: input('k2') });
    expect(Object.keys((await h.state()).commands ?? {})).toEqual(['\ud800', '\udc00']);
  });

  it('keeps two scopes that UTF-8 would merge apart, and accepts a NUL in a scope (#793 O4)', async () => {
    const scopes = ['t:\ud800', 't:\udc00', 't:\u0000x'];
    for (const [index, scope] of scopes.entries()) await store().seed(scope, state => { state.audit.push(`scope ${index}`); });
    for (const [index, scope] of scopes.entries()) expect((await store().read(scope)).audit).toEqual([`scope ${index}`]);
    const rows = await opened!.pool.query(`SELECT scope FROM "${store().schema}".scope WHERE scope = ANY($1)`, [scopes.map(scope => JSON.stringify(scope))]);
    expect(rows.rows.map(row => row.scope).sort()).toEqual(scopes.map(scope => JSON.stringify(scope)).sort());
  });

  it('writes an entity whose only change is its key order', async () => {
    const h = await hosted();
    await store().seed(h.scope, state => {
      const turn = state.turns.t1!;
      state.turns.t1 = Object.fromEntries(Object.entries(turn).reverse()) as typeof turn;
    });
    const keys = Object.keys((await h.state()).turns.t1!);
    expect(keys).toEqual(Object.keys((await memorySubject().state()).turns.t1!).reverse());
  });

  it('keeps the root of a command record, and no root where the record has none (#793 25a)', async () => {
    const h = await hosted();
    const result = { revision: 1, disposition: { outcome: 'accepted' as const }, outbox: [] };
    await store().seed(h.scope, state => {
      state.commands = { plain: { evidence: 'sha256:a', result }, owned: { evidence: 'sha256:b', result, root: 'turn:t1' } as CommandRecord };
    });
    expect(JSON.stringify((await h.state()).commands)).toBe(JSON.stringify({
      plain: { evidence: 'sha256:a', result }, owned: { evidence: 'sha256:b', result, root: 'turn:t1' } }));
    const rows = await opened!.pool.query(`SELECT key, root FROM "${store().schema}".command WHERE scope = $1 ORDER BY key`, [JSON.stringify(h.scope)]);
    expect(rows.rows).toEqual([{ key: '"owned"', root: 'turn:t1' }, { key: '"plain"', root: null }]);
  });

  it('runs two first writes of a new scope one at a time, with no unique violation', async () => {
    for (let round = 0; round < 5; round++) {
      const scope = `tenant:${randomUUID()}`;
      // Both writes succeed. Without upsert-then-lock, the second insert of the scope row would fail.
      await Promise.all([0, 1].map(() => store().seed(scope, state => { state.audit.push('seeded'); })));
      expect((await store().read(scope)).audit).toEqual(['seeded', 'seeded']);
    }
  });

  it('gives concurrent commits of one scope consecutive revisions', async () => {
    const scope = `tenant:${randomUUID()}`;
    await store().seed(scope, state => seedCollaboration(state));
    const revisions = await Promise.all(['i1', 'i2', 'i3'].map(commandId =>
      store().commit(scope, { scope, commandId, command: input(commandId) }, vectorPorts).then(result => result.revision)));
    expect(revisions.sort()).toEqual([1, 2, 3]);
  });
});

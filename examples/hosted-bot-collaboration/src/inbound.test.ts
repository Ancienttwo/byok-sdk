import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@byok-sdk/example-host-execution-core';
import { inboundKey, type Delivery, type InboundMessage } from '@byok-sdk/example-bot-collaboration/channel';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { seedCollaboration, VECTOR_NOW } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from './layout';
import { vectorPorts } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedCollaborationStore, InboundCommandError, type CommitPortsFactory, type InboundIdentity } from './store';

// #793 D2b-out-3: the H inbound channel entry, as L `receive()`.
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const IDENTITY: InboundIdentity = { owner: 'owner', self: { fake: ['own-bot'] } };
const DIRECT = { kind: 'direct', id: 'main' } as const, GROUP = { kind: 'group', id: 'r1' } as const;
const message = (fields: Partial<InboundMessage> = {}): InboundMessage => ({ channel: 'fake', platformMessageId: 'in1', conversation: DIRECT,
  sender: { id: 'owner', kind: 'human' }, text: 'Do it', mentions: [], ...fields });
const REPLY = { kind: 'reply', channel: 'fake', inboundId: 'in1', token: 'secret', expiresAt: VECTOR_NOW + 600_000 } as const;
/** Room `r1` with the Main Bot as its one member. */
const room = (state: CollaborationState) => {
  seedCollaboration(state);
  state.team.rooms.r1 = { id: 'r1', name: 'R', members: ['main'], mode: 'mention', announcement: '', admin: 'main', visibleFrom: {}, messages: [] };
};

describe.skipIf(POSTGRES_URL === undefined)('H inbound channel entry on real Postgres (#793 D2b-out-3)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });

  async function scoped(channel: boolean, seed: (state: CollaborationState) => void = seedCollaboration) {
    const on = new HostedCollaborationStore(opened!.pool, store().schema, { channel });
    const scope = `tenant:${randomUUID()}`;
    await on.seed(scope, seed);
    return { on, scope };
  }

  it('takes an owner message as owner input, keeps its inbound and reply route with a channel, and replays a redelivery', async () => {
    const { on, scope } = await scoped(true), inbound = message({ replyRoute: REPLY });
    const first = await on.receive(scope, inbound, IDENTITY, vectorPorts);
    expect(first).toEqual({ kind: 'owner_input', id: hash(['user', 'main', inboundKey(inbound)]) });
    const state = await on.read(scope);
    expect(state.turns[first.id!]).toMatchObject({ botId: 'main', request: 'Do it', authority: 'owner' });
    expect(state.channel!.inbounds[inboundKey(inbound)]).toMatchObject({ root: first.id, conversation: DIRECT, channel: 'fake', reply: REPLY });
    const before = await on.dump(scope);
    expect(await on.receive(scope, inbound, IDENTITY, vectorPorts)).toEqual(first);
    expect(await on.dump(scope)).toBe(before);
  });

  it('keeps no inbound without a channel, as L passes no remember port then', async () => {
    const { on, scope } = await scoped(false);
    expect(await on.receive(scope, message({ replyRoute: REPLY }), IDENTITY, vectorPorts)).toMatchObject({ kind: 'owner_input' });
    expect((await on.read(scope)).channel?.inbounds ?? {}).toEqual({});
  });

  it('takes a human message in a room as room input, and a bot message there as background with no mention', async () => {
    const { on, scope } = await scoped(true, room);
    const human = message({ conversation: GROUP, sender: { id: 'alice', kind: 'human' }, mentions: ['main'] });
    expect(await on.receive(scope, human, IDENTITY, vectorPorts)).toEqual({ kind: 'room_input', id: hash(['room-input', 'r1', inboundKey(human)]) });
    const bot = message({ conversation: GROUP, platformMessageId: 'in2', sender: { id: 'other-bot', kind: 'bot' }, mentions: ['main'], text: 'Hi' });
    expect(await on.receive(scope, bot, IDENTITY, vectorPorts)).toEqual({ kind: 'bot_background', id: hash(['room-input', 'r1', inboundKey(bot)]) });
    const state = await on.read(scope);
    expect(state.team.rooms.r1!.messages).toEqual([expect.objectContaining({ from: 'alice', text: 'Do it' }), expect.objectContaining({ from: 'other-bot', text: 'Hi' })]);
    expect(JSON.parse(state.team.rounds[hash(['room-input', 'r1', inboundKey(bot)])]!.input)).toMatchObject({ mentions: [] });
    expect(state.channel!.inbounds[inboundKey(human)]).toMatchObject({ root: hash(['room-input', 'r1', inboundKey(human)]) });
  });

  it('writes only an audit line for a message that is not input', async () => {
    const { on, scope } = await scoped(true);
    const cases: Array<[InboundMessage, string, string]> = [
      [message({ sender: undefined, platformMessageId: 'u1' }), 'unverified_sender', 'Inbound unverified_sender: fake direct:main u1'],
      [message({ sender: { id: 'mallory', kind: 'human' }, platformMessageId: 'n1' }), 'not_owner', 'Inbound not_owner: fake direct:main n1 human:mallory'],
      [message({ sender: { id: 'other-bot', kind: 'bot' }, platformMessageId: 'b1' }), 'bot_audit', 'Inbound bot_audit: fake direct:main b1 bot:other-bot'],
    ];
    for (const [inbound, kind, line] of cases) {
      const before = await on.read(scope);
      expect(await on.receive(scope, inbound, IDENTITY, vectorPorts)).toEqual({ kind });
      const after = await on.read(scope);
      expect(after.audit).toEqual([...before.audit, line]);
      expect(Object.keys(after.turns)).toEqual(Object.keys(before.turns));
    }
  });

  it('accepts the one delivery that an echo names, settles its outbox row, and audits an echo that names none', async () => {
    const delivery: Delivery = { id: 'd1', taskId: 'task', turnId: 't1', messageId: 'm1', body: 'b', conversation: DIRECT, channel: 'fake',
      route: { kind: 'push', pushRouteId: 'p' }, state: 'unknown', attempts: 1, code: 'send_timeout' };
    // Two accepted rows share a platform message id, and an inbound of an ended Turn keeps an expired reply token.
    const twin = (id: string): Delivery => ({ ...delivery, id, state: 'accepted', platformMessageId: 'shared' });
    const { on, scope } = await scoped(true, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      state.channel = { pushRoutes: {}, deliveries: { d1: delivery, d2: twin('d2'), d3: twin('d3') },
        inbounds: { i1: { id: 'i1', root: 't1', conversation: DIRECT, channel: 'fake', sequence: 1, reply: { ...REPLY, expiresAt: VECTOR_NOW - 1 } } } };
    });
    // A seed writes no outbox row, so this adds the delivery index row by hand.
    await opened!.pool.query(`INSERT INTO "${store().schema}".outbox (scope, key, ordinal, kind) VALUES ($1, $2, 0, 'delivery')`, [storedKey(scope), storedKey('d1')]);
    const echo = (fields: Partial<InboundMessage>) => message({ sender: { id: 'own-bot', kind: 'bot' }, text: '', ...fields });
    expect(await on.receive(scope, echo({ platformMessageId: 'x', deliveryId: 'none' }), IDENTITY, vectorPorts)).toEqual({ kind: 'echo' });
    let state = await on.read(scope);
    const turns = Object.keys(state.turns);
    expect(state.audit.at(-1)).toBe('Delivery unmatched_echo: fake x');
    expect(state.channel!.deliveries.d1).toMatchObject({ state: 'unknown' });
    // The echo transaction drops the expired reply token, as L's does.
    expect(state.channel!.inbounds.i1!.reply!.token).toBeUndefined();
    expect(await on.receive(scope, echo({ platformMessageId: 'shared' }), IDENTITY, vectorPorts)).toEqual({ kind: 'echo' });
    expect((await on.read(scope)).audit.at(-1)).toBe('Delivery unmatched_echo: fake shared');
    expect(await on.receive(scope, echo({ platformMessageId: 'echoed', deliveryId: 'd1' }), IDENTITY, vectorPorts)).toEqual({ kind: 'echo' });
    state = await on.read(scope);
    expect(state.channel!.deliveries.d1).toMatchObject({ state: 'accepted', platformMessageId: 'echoed' });
    expect(state.channel!.deliveries.d1!.code).toBeUndefined();
    // An echo never creates input.
    expect(Object.keys(state.turns)).toEqual(turns);
    const row = await opened!.pool.query<{ settled_at: string }>(`SELECT settled_at::text FROM "${store().schema}".outbox WHERE scope = $1`, [storedKey(scope)]);
    expect(row.rows).toEqual([{ settled_at: String(VECTOR_NOW) }]);
  });

  it('refuses the receive command in commit(), before it reads or writes, and takes no remember port by type', async () => {
    const { on, scope } = await scoped(true), before = await on.dump(scope);
    await expect(on.commit(scope, { scope, commandId: 'r1', command: { kind: 'receive', inbound: 'owner_input', key: 'k', botId: 'main', request: 'x', sender: 'owner' } },
      vectorPorts)).rejects.toBeInstanceOf(InboundCommandError);
    expect(await on.dump(scope)).toBe(before);
    // @ts-expect-error The commit ports carry no remember port.
    const withRemember: CommitPortsFactory = (state, publish) => ({ ...vectorPorts(state, publish), remember: () => {} });
    expect(typeof withRemember).toBe('function');
  });
});

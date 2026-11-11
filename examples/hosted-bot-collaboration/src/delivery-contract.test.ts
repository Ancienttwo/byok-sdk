import { createHash, randomUUID } from 'node:crypto';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskId, type Json } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { ChannelPort, Delivery, InboundMessage } from '@byok-sdk/bot-collaboration/host-kit';
import type { KeylessCommand } from '@byok-sdk/bot-collaboration/rules';
import { type DeliverySubject, deliveryVectors, FINAL_BODY, replyToken, seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/bot-collaboration/testing';
import { frozenIntent } from './intents';
import { storedKey } from './layout';
import { TEST_HOST } from './memory-subject.test-support';
import { hostedMessageConsumer, type AgentMessageInput } from './messages';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedOutboxSender } from './sender';
import { HostedCollaborationStore, type InboundIdentity } from './store';
import type { TaskEvidence } from './reconcile';
import { inSchema } from './transaction';

// #793 D2b-out-2: the K8 delivery vectors on H, with the outbox sender on real Postgres.
const DIRECT = { kind: 'direct', id: 'main' } as const;
/** The Host's channel identity, as the L subject's options give it. */
const IDENTITY: InboundIdentity = { owner: 'owner', self: { fake: ['own-bot'] } };
const LEASE_MS = 60_000;
const opened: Array<Awaited<ReturnType<typeof openStore>>> = [];
beforeEach(() => { opened.length = 0; });
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

/** A failure of the delivery outbox index: the derived row values that the K8 entity decides (plan §4, index drift). */
async function indexDrift(db: Awaited<ReturnType<typeof openStore>>, scope: string, deliveries: Delivery[]): Promise<string[]> {
  const rows = new Map((await db.pool.query<{ key: string; next_at: string; settled_at: string | null }>(
    `SELECT key, next_at::text, settled_at::text FROM "${db.store.schema}".outbox WHERE scope = $1 AND kind = 'delivery'`, [storedKey(scope)]))
    .rows.map(row => [JSON.parse(row.key) as string, row]));
  const drift: string[] = [];
  for (const row of deliveries) {
    const index = rows.get(row.id);
    // A staged row, or one withheld before its promotion, has no outbox row (#1762).
    if (!index) { if (row.state !== 'staged' && row.code !== 'outcome_not_applied') drift.push(`${row.id}: no outbox row`); continue; }
    if ((index.settled_at !== null) !== (row.state === 'accepted' || row.state === 'rejected')) drift.push(`${row.id}: settled_at for ${row.state}`);
    if (row.state === 'pending' && Number(index.next_at) !== (row.nextAttemptAt ?? 0)) drift.push(`${row.id}: next_at for pending`);
  }
  if ([...rows.keys()].some(key => !deliveries.some(row => row.id === key))) drift.push('an outbox delivery row with no entity');
  return drift;
}

const terminal = (turnId: string, type: string): TaskEvidence => ({ attempt: { taskId: taskId(turnId, 0) } as unknown as TaskAttempt,
  terminal: { envelope: { task_id: taskId(turnId, 0), type, payload: type === 'task.complete' ? { document: {} } : {} } } as unknown as DeviceTerminal });

async function hostedSubject(port: ChannelPort) {
  const db = await openStore();
  opened.push(db);
  const store = new HostedCollaborationStore(db.pool, db.store.schema, { host: TEST_HOST, channel: true });
  const scope = `tenant:${randomUUID()}`;
  let now = Date.UTC(2026, 0, 1), crash = false;
  /**
   * A held channel call: `started` resolves when it starts, `open` lets its result return, and `holder` is the sender pass
   * that waits for it. `armed` is the hold that the next call of its kind takes.
   */
  type Hold = { kind: 'send' | 'readback'; started: Promise<void>; begin(): void; gate: Promise<void>; open(): void; holder?: Promise<void> };
  let armed: Hold | undefined;
  /** Makes the call at once, and returns its result once the hold that it took opens. */
  const held = async <T>(kind: Hold['kind'], call: () => Promise<T>): Promise<T> => {
    const hold = armed?.kind === kind ? armed : undefined;
    if (!hold) return call();
    armed = undefined;
    const result = call();
    // A call that fails before the release is awaited below; this keeps it from being an unhandled rejection meanwhile.
    result.catch(() => {});
    hold.begin();
    await hold.gate;
    return result;
  };
  const execution = { ...template('device', 'main'), agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'delivery' } };
  await store.seed(scope, state => { seedCollaboration(state); state.team.bots.main!.execution = execution; });
  await store.bindDevice(scope, 'device');

  const clock = () => now;
  const keyless = async (command: KeylessCommand) => {
    const result = await store.commit(scope, { scope, commandId: randomUUID(), command }, clock);
    if (result.disposition.outcome !== 'accepted') throw new Error(`Refused ${command.kind}: ${JSON.stringify(result.disposition)}`);
    return result.disposition.value;
  };
  // The crash boundary: a sender whose settle never runs for the claim it made while armed.
  const dropped = new Set<string>();
  const crashing = new Proxy(store, { get(target, name, receiver) {
    if (name === 'claimDelivery') return async (...args: Parameters<HostedCollaborationStore['claimDelivery']>) => {
      const claim = await target.claimDelivery(...args);
      if (crash && claim.kind === 'send') { crash = false; dropped.add(`${args[1]}:${claim.attempt}`); }
      return claim;
    };
    if (name === 'finishDelivery') return async (...args: Parameters<HostedCollaborationStore['finishDelivery']>) => {
      if (!dropped.has(`${args[1]}:${args[2]}`)) await target.finishDelivery(...args);
    };
    return Reflect.get(target, name, receiver) as unknown;
  } });
  const channel: ChannelPort = { send: (input, signal) => held('send', () => port.send(input, signal)),
    ...(port.readback ? { readback: (id: string) => held('readback', () => port.readback!(id)) } : {}) };
  // The send deadline outlives the steps of a case while a send is held; a hanging send (vector 5) still times out.
  const sender = new HostedOutboxSender(db.pool, crashing, { projections: { deliver: async () => {} }, channel, now: () => now,
    leaseMs: LEASE_MS, sendTimeoutMs: 2_000 });
  const passOf = async () => {
    const pass = await sender.run();
    if (pass.failed.length) throw new AggregateError(pass.failed.map(failure => failure.error), 'A sender step failed');
    return pass;
  };

  const deliveries = async () => Object.values((await store.read(scope)).channel?.deliveries ?? {});
  /**
   * Runs the Host as one L pass does: the sync, then the sender, again while the sender changed a row. A pass that starts
   * a held call keeps waiting for it, and this run returns. A later run is another sender pass on the same rows: the
   * other Host.
   */
  const run = async () => {
    for (let round = 0; ; round++) {
      if (round === 10) throw new Error('The Host does not settle');
      await store.sync(scope, { ...SYNC_OPTIONS, now, history: undefined });
      const pass = passOf(), hold = armed;
      if (hold && await Promise.race([pass.then(() => false), hold.started.then(() => true)])) { hold.holder = pass.then(() => undefined); return; }
      if (!(await pass).steps) break;
    }
    expect(await indexDrift(db, scope, await deliveries())).toEqual([]);
  };
  const holdNext = (kind: Hold['kind']) => {
    let begin!: () => void, open!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; }), gate = new Promise<void>(resolve => { open = resolve; });
    const hold: Hold = { kind, started, begin, gate, open };
    armed = hold;
    return { release: async () => { hold.open(); await hold.holder; await run(); } };
  };
  const consume = hostedMessageConsumer(store, { scopeOf: tenant => tenant, now: clock });

  /** Owner message `key` reaches Bot `main`, and its Turn's final Agent message is accepted. Returns the Turn id. */
  const accept = async (key: string, replyMs: number | null = 600_000) => {
    const message: InboundMessage = { channel: 'fake', platformMessageId: key, conversation: DIRECT, sender: { id: 'owner', kind: 'human' },
      text: 'Answer me', mentions: [], ...(replyMs === null ? {} : { replyRoute: { kind: 'reply', channel: 'fake', inboundId: key, token: replyToken(key), expiresAt: now + replyMs } }) };
    const received = await store.receive(scope, message, IDENTITY, clock);
    expect(received).toMatchObject({ kind: 'owner_input' });
    const turnId = received.id!;
    await store.sync(scope, { ...SYNC_OPTIONS, now, history: undefined });
    const frozen = await inSchema(db.pool, store.schema, client => frozenIntent(client, scope, taskId(turnId, 0)), true);
    if (!frozen) throw new Error('The Turn did not freeze');
    const input = { tenant: scope, taskId: frozen.input.taskId, deviceId: frozen.input.deviceId, context: frozen.input.agentMessageContext,
      payload: { agentRef: frozen.input.payload.agentRef, sessionRef: randomUUID(), contract: 'conversation-turn/v1', messageId: randomUUID(), cursor: 1,
        contentType: 'text/markdown', body: FINAL_BODY, contentHash: `sha256:${createHash('sha256').update(FINAL_BODY).digest('hex')}`,
        byteCount: Buffer.byteLength(FINAL_BODY) } } as unknown as AgentMessageInput;
    expect(await consume.consume(input)).toEqual({ outcome: 'accepted' });
    return turnId;
  };
  /** The Turn's terminal concludes its intent; the reply becomes sendable only in a succeeded outcome transaction (#1762). */
  const conclude = async (turnId: string, type: 'task.complete' | 'task.fail') => {
    expect(await store.finish(scope, turnId, terminal(turnId, type), clock)).toBe(type === 'task.complete' ? 'succeeded' : 'failed');
    await run();
  };

  const subject: DeliverySubject = {
    now: () => now,
    drain: run,
    advance: async ms => { now += ms; await run(); },
    publish: async (key, { replyMs = 600_000 } = {}) => { await conclude(await accept(key, replyMs), 'task.complete'); },
    holdNextSend: () => holdNext('send'),
    holdNextReadback: () => holdNext('readback'),
    enablePush: async target => {
      const id = await keyless({ kind: 'enable_push_route', conversation: DIRECT, channel: 'fake', target, owner: 'owner' }) as string;
      await run();
      return id;
    },
    revokePush: async id => { await keyless({ kind: 'revoke_push_route', routeId: id }); await run(); },
    echo: async (deliveryId, platformMessageId) => {
      expect(await store.receive(scope, { channel: 'fake', platformMessageId, conversation: DIRECT, sender: { id: 'own-bot', kind: 'bot' }, text: '',
        mentions: [], deliveryId }, IDENTITY, clock)).toEqual({ kind: 'echo' });
      await run();
    },
    resend: async id => { const next = await keyless({ kind: 'resend_delivery', deliveryId: id }) as string; await run(); return next; },
    crashOnNextSend: () => { crash = true; },
    recoveryMs: LEASE_MS,
    deliveries,
    projections: async () => (await db.pool.query<{ key: string; body: Json }>(`SELECT key, body FROM "${store.schema}".outbox
      WHERE scope = $1 AND kind = 'projection' ORDER BY ordinal`, [storedKey(scope)])).rows.map(row => ({ id: JSON.parse(row.key) as string, value: row.body })),
    state: () => store.read(scope),
    stored: () => store.dump(scope),
  };
  /** The delivery keys of the scope's outbox rows. */
  const outbox = async () => (await db.pool.query<{ key: string }>(`SELECT key FROM "${store.schema}".outbox WHERE scope = $1 AND kind = 'delivery'`,
    [storedKey(scope)])).rows.map(row => JSON.parse(row.key) as string);
  return { ...subject, accept, conclude, outbox };
}

describe.skipIf(POSTGRES_URL === undefined)('H delivery sender (#793 D2b-out-2)', () => {
  deliveryVectors('H HostedCollaborationStore and outbox sender on Postgres', hostedSubject);

  it.each(['task.complete', 'task.fail'] as const)('gives a staged reply an outbox row only when a succeeded outcome promotes it: %s (#1762)', async type => {
    const sent: string[] = [];
    const subject = await hostedSubject({ send: async input => { sent.push(input.deliveryId); return { result: 'accepted', platformMessageId: 'p1' }; } });
    const turnId = await subject.accept('in1');
    await subject.drain();
    expect(await subject.deliveries()).toMatchObject([{ state: 'staged', body: FINAL_BODY, attempts: 0 }]);
    expect(await subject.outbox()).toEqual([]);
    await subject.conclude(turnId, type);
    await subject.drain();
    const [row] = await subject.deliveries();
    if (type === 'task.complete') {
      expect(row).toMatchObject({ state: 'accepted', attempts: 1, platformMessageId: 'p1' });
      expect(await subject.outbox()).toEqual([row!.id]);
      expect(sent).toEqual([row!.id]);
    } else {
      expect(row).toMatchObject({ state: 'rejected', code: 'outcome_not_applied', attempts: 0 });
      expect((await subject.state()).audit).toContain(`Delivery outcome_not_applied: ${row!.taskId} ${row!.messageId}`);
      expect(await subject.outbox()).toEqual([]);
      expect(sent).toEqual([]);
    }
  }, 60_000);

  it('keeps a send claim whose settle never ran until its lease has passed, because another sender may still be sending', async () => {
    const send: ChannelPort['send'] = async () => ({ result: 'accepted', platformMessageId: 'late' });
    const subject = await hostedSubject({ send });
    subject.crashOnNextSend();
    await subject.publish('in1');
    expect(await subject.deliveries()).toMatchObject([{ state: 'sending', attempts: 1 }]);
    await subject.advance(LEASE_MS - 1);
    expect(await subject.deliveries()).toMatchObject([{ state: 'sending', attempts: 1 }]);
    await subject.advance(1);
    expect(await subject.deliveries()).toMatchObject([{ state: 'unknown', attempts: 1, code: 'interrupted' }]);
  }, 60_000);
});

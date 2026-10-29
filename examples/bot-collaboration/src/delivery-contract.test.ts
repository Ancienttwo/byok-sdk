import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect } from 'vitest';
import { freezeRuntimeAdapterDescriptor } from '@byok-sdk/client';
import { tenantId } from '@byok-sdk/core';
import { HostLedger } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotStubAdapter } from '../../basic/goal-btw.test-support';
import type { ChannelPort, InboundMessage } from './channel';
import { botCompactVeto } from './compaction';
import { FINAL_BODY, deliveryVectors, replyToken, type DeliverySubject } from './delivery-vectors.test-support';
import { BotCollaboration, type AgentMessageInput, type BotOptions } from './host';

// #793 D2b-out-1: the delivery vectors on the K8 L Host, with a real SQLite HostLedger, embedded server and daemon.
class DraftAdapter extends BotStubAdapter {
  override readonly descriptor = freezeRuntimeAdapterDescriptor({ ...new BotStubAdapter().descriptor,
    capabilities: { ...new BotStubAdapter().descriptor.capabilities, messageDraft: true } });
  private readonly startWaiters = new Map<string, Set<() => void>>();
  started(taskId: string): Promise<void> {
    if (this.sessions.has(taskId)) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.startWaiters.get(taskId) ?? new Set<() => void>();
      waiters.add(resolve); this.startWaiters.set(taskId, waiters);
    });
  }
  override async prepare(input: Parameters<BotStubAdapter['prepare']>[0]): ReturnType<BotStubAdapter['prepare']> {
    const prepared = await super.prepare(input);
    if (prepared.kind !== 'prepared') return prepared;
    const operation = prepared.operation;
    return { ...prepared, operation: { ...operation, start: async start => {
      const session = await operation.start(start);
      const taskId = start.manifest.taskId;
      for (const resolve of this.startWaiters.get(taskId) ?? []) resolve();
      this.startWaiters.delete(taskId);
      return session;
    } } };
  }
}
const conversation = { kind: 'direct', id: 'main' } as const;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function ledgerSubject(port: ChannelPort): Promise<DeliverySubject> {
  let bot!: BotCollaboration, reopened: HostLedger | undefined, now = Date.now(), crash = false, checkpoint: string | undefined;
  /**
   * A held channel call: `started` resolves when it starts, `open` lets its result return, and `holder` is the drain that
   * waits for it. `armed` is the hold that the next call of its kind takes. `busy` is the drain of the current Host while
   * that Host holds a call.
   */
  type Hold = { kind: 'send' | 'readback'; started: Promise<void>; begin(): void; gate: Promise<void>; open(): void; holder?: Promise<void> };
  let armed: Hold | undefined, busy: Promise<void> | undefined;
  /** Makes the call at once, and returns its result once the hold that it took opens. */
  const held = async <T>(kind: Hold['kind'], call: () => Promise<T>): Promise<T> => {
    const hold = armed?.kind === kind ? armed : undefined;
    if (!hold) return call();
    armed = undefined;
    const result = call();
    hold.begin();
    await hold.gate;
    return result;
  };
  const roots = new Map<string, string>();
  const adapter = new DraftAdapter();
  const fixture: TestHost = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, adapter,
    consume: (wake, signal) => bot.consume(wake, signal), agentMessage: { consume: input => bot.consumeMessage(input) } });
  const ledger = () => reopened ?? fixture.ledger;
  // The crash boundary: the claim is committed, and this copy of the database is what a restarted Host opens.
  const send: ChannelPort['send'] = async (input, signal) => {
    if (crash) {
      crash = false;
      const db = new DatabaseSync(join(fixture.root, 'host.sqlite'));
      checkpoint = join(fixture.root, `crash-${randomUUID()}.sqlite`);
      db.exec(`VACUUM INTO '${checkpoint.replaceAll("'", "''")}'`); db.close();
    }
    return held('send', () => port.send(input, signal));
  };
  const readback = port.readback && ((id: string) => held('readback', () => port.readback!(id)));
  const base = template(fixture.deviceId);
  const options: BotOptions = { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'delivery' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } },
    connector: async () => null, now: () => now,
    // Long enough for a held send to outlive the steps of its vector; a hanging send still times out within the case.
    channel: { port: { send, ...(readback ? { readback } : {}) }, self: { fake: ['own-bot'] }, sendTimeoutMs: 2_000 } };
  bot = new BotCollaboration(fixture.server, fixture.ledger, options);
  closers.push(async () => { await bot.close(); reopened?.close(); await fixture.close(); });
  /** A crashed claim: the replacement Host opens the checkpoint and recovers at startup. */
  const settle = async () => {
    if (checkpoint === undefined) return;
    const path = checkpoint;
    checkpoint = undefined;
    await bot.close();
    reopened?.close();
    reopened = new HostLedger(path, fixture.ledger.tenant, { compactVeto: botCompactVeto });
    bot = new BotCollaboration(fixture.server, reopened, options);
    await bot.recover();
  };
  /**
   * Runs the Host. While a call is held, its Host is busy in that call, so another Host on the same ledger takes over: L
   * recovers at startup, so a held send's claim becomes `unknown` (`interrupted`) at once.
   */
  const run = async () => {
    if (busy) {
      const holding = bot, holder = busy;
      bot = new BotCollaboration(fixture.server, ledger(), options);
      closers.push(async () => { await holder; await holding.close(); });
      busy = undefined;
      await bot.recover();
    }
    const pass = bot.drain(), hold = armed;
    if (hold) {
      // The held call may start in this pass: then this verb returns while the pass waits for it.
      const started = await Promise.race([pass.then(() => false), hold.started.then(() => true)]);
      if (started) { hold.holder = busy = pass; return; }
    } else await pass;
    await settle();
  };
  const holdNext = (kind: Hold['kind']) => {
    let begin!: () => void, open!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; }), gate = new Promise<void>(resolve => { open = resolve; });
    const hold: Hold = { kind, started, begin, gate, open };
    armed = hold;
    return { release: async () => {
      hold.open();
      await hold.holder;
      if (busy === hold.holder) busy = undefined;
      await settle();
    } };
  };
  const agentMessage = (turnId: string): AgentMessageInput => {
    const intent = bot.core.intent(turnId)!;
    return { tenant: tenantId(ledger().tenant), taskId: intent.taskId, deviceId: fixture.deviceId,
      context: intent.execution.agentMessageContext!, payload: { agentRef: intent.execution.payload.agentRef,
        sessionRef: randomUUID(), contract: 'conversation-turn/v1', messageId: randomUUID(), cursor: 1, contentType: 'text/markdown',
        body: FINAL_BODY, contentHash: `sha256:${createHash('sha256').update(FINAL_BODY).digest('hex')}`, byteCount: Buffer.byteLength(FINAL_BODY) } };
  };
  return {
    now: () => now,
    drain: run,
    advance: async ms => { now += ms; await run(); },
    publish: async (key, { replyMs = 600_000 } = {}) => {
      const message: InboundMessage = { channel: 'fake', platformMessageId: key, conversation, sender: { id: 'owner', kind: 'human' }, text: 'Answer me',
        mentions: [], ...(replyMs === null ? {} : { replyRoute: { kind: 'reply', channel: 'fake', inboundId: key, token: replyToken(key), expiresAt: now + replyMs } }) };
      const root = (await bot.receive(message)).id!;
      roots.set(key, root);
      await bot.drain();
      await adapter.started(bot.core.intent(root)!.taskId);
      expect(await bot.consumeMessage(agentMessage(root))).toEqual({ outcome: 'accepted' });
      await run();
    },
    end: async key => {
      const root = roots.get(key)!, taskId = bot.core.intent(root)!.taskId;
      const events = fixture.server.events.subscribe()[Symbol.asyncIterator]();
      try {
        await bot.cancelTurn(root);
        for (;;) {
          const next = await events.next();
          if (next.done) throw new Error('Server event stream ended before the task terminal');
          if (next.value.kind === 'task.state' && next.value.taskId === taskId && ['Complete', 'Failed', 'Cancelled'].includes(next.value.state)) break;
        }
      } finally { await events.return?.(); }
      // K4 takes the terminal through its own wake, so the Turn can conclude a pass after the server event.
      for (let tries = 0; !bot.snapshot().turns[root]?.conclusion; tries++) {
        if (tries === 100) throw new Error('The Turn did not conclude');
        await run();
        if (!bot.snapshot().turns[root]?.conclusion) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(bot.snapshot().turns[root]).toMatchObject({ conclusion: 'cancelled' });
    },
    holdNextSend: () => holdNext('send'),
    holdNextReadback: () => holdNext('readback'),
    enablePush: async target => { const id = await bot.enablePushRoute(conversation, 'fake', target); await run(); return id; },
    revokePush: async id => { await bot.revokePushRoute(id); await run(); },
    echo: async (deliveryId, platformMessageId) => {
      expect(await bot.receive({ channel: 'fake', platformMessageId, conversation, sender: { id: 'own-bot', kind: 'bot' }, text: '', mentions: [], deliveryId }))
        .toEqual({ kind: 'echo' });
      await run();
    },
    resend: async id => { const next = await bot.resendDelivery(id); await run(); return next; },
    crashOnNextSend: () => { crash = true; },
    recoveryMs: 0,
    deliveries: () => Object.values(bot.snapshot().channel?.deliveries ?? {}),
    projections: () => Object.values(ledger().snapshot().outbox).flatMap(row => row.kind === 'projection' ? [{ id: row.id, value: row.value }] : []),
    state: () => bot.snapshot(),
    stored: () => JSON.stringify(ledger().snapshot()),
  };
}
deliveryVectors('L BotCollaboration', ledgerSubject);

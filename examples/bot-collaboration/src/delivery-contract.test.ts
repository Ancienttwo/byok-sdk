import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect } from 'vitest';
import { freezeRuntimeAdapterDescriptor } from '@byok-sdk/client';
import { tenantId } from '@byok-sdk/core';
import { HostLedger } from '@byok-sdk/example-host-execution-core';
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
  let bot!: BotCollaboration, reopened: HostLedger | undefined, now = Date.now(), armed = false, checkpoint: string | undefined;
  const adapter = new DraftAdapter();
  const fixture: TestHost = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, adapter,
    consume: (wake, signal) => bot.consume(wake, signal), agentMessage: { consume: input => bot.consumeMessage(input) } });
  const ledger = () => reopened ?? fixture.ledger;
  // The crash boundary: the claim is committed, and this copy of the database is what a restarted Host opens.
  const send: ChannelPort['send'] = (input, signal) => {
    if (armed) {
      armed = false;
      const db = new DatabaseSync(join(fixture.root, 'host.sqlite'));
      checkpoint = join(fixture.root, `crash-${randomUUID()}.sqlite`);
      db.exec(`VACUUM INTO '${checkpoint.replaceAll("'", "''")}'`); db.close();
    }
    return port.send(input, signal);
  };
  const base = template(fixture.deviceId);
  const options: BotOptions = { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'delivery' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } },
    connector: async () => null, now: () => now,
    channel: { port: { send, ...(port.readback ? { readback: port.readback } : {}) }, self: { fake: ['own-bot'] }, sendTimeoutMs: 10 } };
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
  const run = async () => { await bot.drain(); await settle(); };
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
      await bot.drain();
      await adapter.started(bot.core.intent(root)!.taskId);
      expect(await bot.consumeMessage(agentMessage(root))).toEqual({ outcome: 'accepted' });
      await run();
    },
    enablePush: async target => { const id = await bot.enablePushRoute(conversation, 'fake', target); await run(); return id; },
    revokePush: async id => { await bot.revokePushRoute(id); await run(); },
    echo: async (deliveryId, platformMessageId) => {
      expect(await bot.receive({ channel: 'fake', platformMessageId, conversation, sender: { id: 'own-bot', kind: 'bot' }, text: '', mentions: [], deliveryId }))
        .toEqual({ kind: 'echo' });
      await run();
    },
    resend: async id => { const next = await bot.resendDelivery(id); await run(); return next; },
    crashOnNextSend: () => { armed = true; },
    recoveryMs: 0,
    deliveries: () => Object.values(bot.snapshot().channel?.deliveries ?? {}),
    projections: () => Object.values(ledger().snapshot().outbox).flatMap(row => row.kind === 'projection' ? [{ id: row.id, value: row.value }] : []),
    state: () => bot.snapshot(),
    stored: () => JSON.stringify(ledger().snapshot()),
  };
}
deliveryVectors('L BotCollaboration', ledgerSubject);

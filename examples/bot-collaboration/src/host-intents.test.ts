import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS, type AgentMessageInput, type ExecutionServer, type IntentInput } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, IntentOutcomeError, type BotOptions, type HostIntentHandler } from './host';
import { botCompactVeto } from './compaction';
import type { HostIntentMessageHandler, MessageDisposition } from './index';
import { sealLedger } from './switch';

/**
 * #882: the Host's own K4 work on the Bot tenant's core. A fake server: a submitted task with the K4 test contract
 * completes at once unless `paused`; a Bot Turn task never completes, so its intent stays in flight.
 */
const submitted = new Map<string, { taskId: string; deviceId: string; payload: { agentRef: unknown; terminalProjection: { contract: string } } }>();
let paused = false;
/** Task ids that got an SDK cancel. Unless `paused`, such a task ends with a `task.cancelled` terminal. */
const cancels: string[] = [];
/** When set, a Bot Turn task completes with the result document that it returns for the task id. */
let botDocument: ((taskId: string) => unknown) | undefined;
const server = {
  executions: { submit: async (input: { taskId: string; deviceId: string; payload: { agentRef: unknown; terminalProjection: { contract: string } } }) => {
    submitted.set(input.taskId, input); return {};
  } },
  tasks: {
    offer: async (taskId: string) => {
      const input = submitted.get(taskId);
      return input && { taskId, deviceId: input.deviceId, type: 'task.offer', payload: input.payload, delivered: true };
    },
    deviceTerminal: async (taskId: string) => {
      const input = submitted.get(taskId);
      if (!input || paused) return undefined;
      if (cancels.includes(taskId)) return { envelope: { type: 'task.cancelled', task_id: taskId, payload: {} } };
      if (input.payload.terminalProjection.contract === 'host-core-test-v1') {
        return { envelope: { type: 'task.complete', task_id: taskId, payload: { document: { summary: 'host research done' } } } };
      }
      const document = botDocument?.(taskId);
      return document === undefined ? undefined : { envelope: { type: 'task.complete', task_id: taskId, payload: { document } } };
    },
    attempt: async (taskId: string) => {
      const input = submitted.get(taskId);
      return input && { taskId, deviceId: input.deviceId, agentRef: input.payload.agentRef, status: 'completed', claimedRuntime: 'r', ownerDeviceId: input.deviceId };
    },
    cancel: async (taskId: string) => { cancels.push(taskId); },
  },
  wakes: { pending: async () => [], schedule: async () => undefined, cancel: async () => undefined },
} as unknown as ExecutionServer;

let root: string | undefined, ledger: HostLedger | undefined, bot: BotCollaboration | undefined;
afterEach(async () => {
  await bot?.close(); ledger?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = ledger = bot = undefined; paused = false; botDocument = undefined;
  submitted.clear(); cancels.length = 0;
});
function openBot(hostIntents: Record<string, HostIntentHandler>, extra: Partial<BotOptions> = {}): BotCollaboration {
  root ??= mkdtempSync(join(tmpdir(), 'k8-host-intents-'));
  ledger ??= new HostLedger(join(root, 'host.sqlite'), 'tenant', { compactVeto: botCompactVeto });
  return new BotCollaboration(server as never, ledger, { botId: 'main', execution: template('device'), connector: async () => null, hostIntents, ...extra });
}
async function restart(hostIntents: Record<string, HostIntentHandler>, extra: Partial<BotOptions> = {}): Promise<BotCollaboration> {
  await bot!.close(); ledger!.close();
  bot = ledger = undefined;
  return openBot(hostIntents, extra);
}
const KEY = 'host-research-1', WAIT_UNTIL = Date.now() + 600_000;
const input = (extra: Partial<IntentInput> = {}): IntentInput => ({ key: KEY, source: 'user', execution: template('device', 'research'), waitUntil: WAIT_UNTIL, ...extra });
const refusals = () => bot!.snapshot().audit.filter(row => row.startsWith('Intent outcome refused'));

it('settles a Host intent through its handler in the terminal transaction, and keeps the K8 revision', async () => {
  const seen: unknown[] = [];
  bot = openBot({ research: (document, tx) => { seen.push(document); tx.application.research = { done: true }; } });
  const revision = bot.snapshot().revision;
  const intent = await bot.enqueueHostIntent(input(), 'research');
  expect({ conclusion: intent.conclusion, seen, research: ledger!.snapshot().application.research, revision: bot.snapshot().revision })
    .toEqual({ conclusion: 'succeeded', seen: [{ summary: 'host research done' }], research: { done: true }, revision });
  expect(bot.snapshot().hostIntents).toEqual({ [KEY]: { handler: 'research' } });
  // An exact replay returns the settled intent, and the handler does not run again.
  expect((await bot.enqueueHostIntent(input(), 'research')).id).toBe(intent.id);
  expect(seen).toHaveLength(1);
});

it('refuses a handler name, a key or an execution that the Host intent cannot own', async () => {
  paused = true;
  bot = openBot({ research: () => {}, other: () => {} });
  await expect(bot.enqueueHostIntent(input(), 'missing')).rejects.toThrow('Unknown Host intent handler: missing');
  await expect(bot.enqueueHostIntent(input({ execution: { ...template('device', 'research'),
    payload: { ...template('device', 'research').payload, requiredToolsets: ['market.write'] } } }), 'research')).rejects.toThrow('market.write');
  await bot.enqueueHostIntent(input(), 'research');
  await expect(bot.enqueueHostIntent(input(), 'other')).rejects.toThrow('Host intent identity conflict');
  await expect(bot.enqueueHostIntent(input({ waitUntil: WAIT_UNTIL + 1 }), 'research')).rejects.toThrow('Intent identity conflict');
  const turnId = await bot.input('k1', 'hello');
  await expect(bot.enqueueHostIntent(input({ key: turnId }), 'research')).rejects.toThrow('the key is a Bot Turn');
  await bot.core.enqueue(input({ key: 'direct' }));
  await expect(bot.enqueueHostIntent(input({ key: 'direct' }), 'research')).rejects.toThrow('Host intent identity conflict');
});

it('rejects each drain for a terminal whose key K8 never wrote, and audits it once', async () => {
  bot = openBot({});
  // A direct `core.enqueue` is not a Host intent. Its success must not settle as a Bot outcome or as a silent success.
  await bot.core.enqueue(input());
  const refused = { name: 'IntentOutcomeError', key: KEY, code: 'unknown_intent', message: 'No Bot Turn or Host intent has this key' };
  await expect(bot.drain()).rejects.toMatchObject(refused);
  await expect(bot.drain()).rejects.toBeInstanceOf(IntentOutcomeError);
  // Every API that runs a pass rejects too, after its own commit.
  await expect(bot.input('k1', 'hello')).rejects.toMatchObject(refused);
  expect(bot.core.intent(KEY)).toMatchObject({ phase: 'inflight' });
  expect(bot.core.intent(KEY)?.conclusion).toBeUndefined();
  expect(refusals()).toEqual([`Intent outcome refused unknown_intent: ${KEY} No Bot Turn or Host intent has this key`]);
});

it('keeps a failed handler intent open across a restart, and a fixed handler settles it', async () => {
  bot = openBot({ research: () => { throw new Error('research store offline'); } });
  await expect(bot.enqueueHostIntent(input(), 'research')).rejects.toMatchObject({ code: 'handler_failed', message: 'research store offline' });
  await expect(bot.drain()).rejects.toMatchObject({ code: 'handler_failed' });
  expect(bot.core.intent(KEY)?.conclusion).toBeUndefined();
  expect(refusals()).toEqual([`Intent outcome refused handler_failed: ${KEY} research store offline`]);
  // The ledger stores the handler name, so a restart without that handler fails closed.
  await expect(restart({})).rejects.toThrow('An open Host intent needs the handler research');
  const seen: unknown[] = [];
  bot = openBot({ research: document => { seen.push(document); } });
  await bot.recover();
  await bot.drain();
  expect({ conclusion: bot.core.intent(KEY)?.conclusion, seen }).toEqual({ conclusion: 'succeeded', seen: [{ summary: 'host research done' }] });
});

const ownerFailures = () => bot!.snapshot().audit.filter(row => row.startsWith('Intent failed by owner'));

it('fails a stuck intent on an owner call, so drain moves past it and the Bot FIFO runs', async () => {
  bot = openBot({});
  // A direct `core.enqueue` on the Main Bot's agentRef: its refused terminal holds the Bot's FIFO.
  await bot.core.enqueue(input({ execution: template('device') }));
  await expect(bot.input('k1', 'hello')).rejects.toMatchObject({ code: 'unknown_intent' });
  const turnIntent = () => Object.values(ledger!.snapshot().intents).find(row => row.key !== KEY);
  // Without the owner call, the intent stays and each drain rejects.
  await expect(bot.drain()).rejects.toMatchObject({ code: 'unknown_intent' });
  expect({ host: bot.core.intent(KEY)?.conclusion, turn: turnIntent()?.phase }).toEqual({ host: undefined, turn: 'queued' });
  await bot.failStuckIntent(KEY);
  expect({ host: bot.core.intent(KEY)?.conclusion, turn: turnIntent()?.phase }).toEqual({ host: 'failed', turn: 'inflight' });
  await expect(bot.drain()).resolves.toBeUndefined();
  expect(ownerFailures()).toEqual([`Intent failed by owner unknown_intent: ${KEY} No Bot Turn or Host intent has this key`]);
});

it('fails a failed handler intent after a restart, and only the probe drain of the call runs the handler', async () => {
  let calls = 0;
  const failing: HostIntentHandler = () => { calls++; throw new Error('research store offline'); };
  bot = openBot({ research: failing });
  await expect(bot.enqueueHostIntent(input(), 'research')).rejects.toMatchObject({ code: 'handler_failed' });
  // A fresh process has no refusal yet; the call drains first to find it.
  bot = await restart({ research: failing });
  const before = calls;
  await bot.failStuckIntent(KEY);
  // The drain inside the call applies the terminal once more; the settle and later drains run no handler.
  expect({ conclusion: bot.core.intent(KEY)?.conclusion, calls }).toEqual({ conclusion: 'failed', calls: before + 1 });
  await expect(bot.drain()).resolves.toBeUndefined();
  expect(calls).toBe(before + 1);
  expect(ownerFailures()).toEqual([`Intent failed by owner handler_failed: ${KEY} research store offline`]);
  // The ownership record stays until K4 compacts the intent, so an exact replay returns the failed intent.
  expect(bot.snapshot().hostIntents).toEqual({ [KEY]: { handler: 'research' } });
  expect((await bot.enqueueHostIntent(input(), 'research')).conclusion).toBe('failed');
  // A settled intent needs no handler at a restart.
  bot = await restart({});
});

it('refuses to fail an unknown key, an intent that can still settle, a settled intent and a non-owner', async () => {
  paused = true;
  bot = openBot({ research: () => {} });
  await expect(bot.failStuckIntent('missing')).rejects.toThrow('Unknown intent: missing');
  await bot.enqueueHostIntent(input(), 'research');
  await expect(bot.failStuckIntent(KEY)).rejects.toThrow(`Intent is not stuck: ${KEY} has no refused terminal`);
  const turnId = await bot.input('k1', 'hello');
  await expect(bot.failStuckIntent(turnId)).rejects.toThrow(`Intent is not stuck: ${turnId}`);
  await expect(bot.failStuckIntent(KEY, { id: 'guest', kind: 'human' })).rejects.toThrow('not_owner: failStuckIntent needs the owner principal');
  paused = false;
  await bot.drain();
  await expect(bot.failStuckIntent(KEY)).rejects.toThrow(`Intent already settled: ${KEY}`);
  expect(bot.core.intent(KEY)?.conclusion).toBe('succeeded');
  expect(ownerFailures()).toEqual([]);
});

it('throws the error of a drain that stopped before it reached the intent', async () => {
  paused = true;
  bot = openBot({ research: () => {} });
  await bot.enqueueHostIntent(input(), 'research');
  const drain = vi.spyOn(bot.core, 'drain').mockRejectedValueOnce(new Error('scan stopped'));
  onTestFinished(() => { drain.mockRestore(); });
  await expect(bot.failStuckIntent(KEY)).rejects.toThrow('scan stopped');
  expect(drain).toHaveBeenCalledTimes(1);
  expect(bot.core.intent(KEY)?.conclusion).toBeUndefined();
  expect(ownerFailures()).toEqual([]);
});

it('refuses to fail a Bot Turn that is only queued behind another stuck intent', async () => {
  bot = openBot({});
  // The stuck direct intent holds the head of the Bot FIFO, so the queued Turn has no refusal of its own.
  await bot.core.enqueue(input({ execution: template('device') }));
  await expect(bot.input('k1', 'hello')).rejects.toMatchObject({ code: 'unknown_intent' });
  const turnId = Object.values(ledger!.snapshot().intents).find(row => row.key !== KEY)!.key;
  await expect(bot.failStuckIntent(turnId)).rejects.toThrow(`Intent is not stuck: ${turnId} has no refused terminal`);
  expect(ownerFailures()).toEqual([]);
});

it('fails a Bot Turn whose outcome commit throws on an owner call, so its FIFO moves on and the Turn ends failed', async () => {
  // The first Bot Turn task completes with a document outside its frozen schema, so K8's outcome commit throws in the K4
  // terminal transaction. Later tasks stay in flight.
  let first: string | undefined;
  botDocument = taskId => (first ??= taskId) === taskId ? { summary: 'not a Bot Turn outcome' } : undefined;
  bot = openBot({});
  const refused = { name: 'IntentOutcomeError', code: 'outcome_failed', message: 'Outcome differs from the frozen schema' };
  await expect(bot.input('k1', 'hello')).rejects.toMatchObject(refused);
  const turnId = Object.keys(bot.snapshot().turns)[0]!;
  await expect(bot.drain()).rejects.toMatchObject({ ...refused, key: turnId });
  expect(bot.core.intent(turnId)).toMatchObject({ phase: 'inflight' });
  expect(refusals()).toEqual([`Intent outcome refused outcome_failed: ${turnId} Outcome differs from the frozen schema`]);
  // The next Turn of the Bot waits behind it.
  await expect(bot.input('k2', 'next')).rejects.toMatchObject(refused);
  const next = () => Object.values(ledger!.snapshot().intents).find(row => row.key !== turnId)!;
  expect(next().phase).toBe('queued');
  await bot.failStuckIntent(turnId);
  expect(bot.core.intent(turnId)?.conclusion).toBe('failed');
  expect(bot.snapshot().turns[turnId]).toMatchObject({ status: 'failed', conclusion: 'failed', reported: true });
  expect(ownerFailures()).toEqual([`Intent failed by owner outcome_failed: ${turnId} Outcome differs from the frozen schema`]);
  expect(next().phase).toBe('inflight');
});

it('refuses an async handler, and consumes its rejection', async () => {
  const unhandled: unknown[] = [], record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  onTestFinished(() => { process.off('unhandledRejection', record); });
  bot = openBot({ research: async () => { throw new Error('async research failed'); } });
  await expect(bot.enqueueHostIntent(input(), 'research')).rejects.toMatchObject({ code: 'handler_failed', message: 'Host intent handler must be synchronous' });
  expect(bot.core.intent(KEY)?.conclusion).toBeUndefined();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(unhandled).toEqual([]);
});

it('holds the Main Bot FIFO only until its Host intent settles', async () => {
  paused = true;
  bot = openBot({ research: () => {} });
  // The Main Bot's agentRef: one FIFO for the Host intent and the Bot's Turns.
  await bot.enqueueHostIntent(input({ execution: template('device') }), 'research');
  const turnId = await bot.input('k1', 'hello');
  const turnIntent = () => Object.values(ledger!.snapshot().intents).find(row => row.key === turnId);
  expect({ host: bot.core.intent(KEY)?.phase, turn: turnIntent()?.phase, submitted: submitted.size }).toEqual({ host: 'inflight', turn: 'queued', submitted: 1 });
  paused = false;
  await bot.drain();
  expect({ host: bot.core.intent(KEY)?.conclusion, turn: turnIntent()?.phase, submitted: submitted.size }).toEqual({ host: 'succeeded', turn: 'inflight', submitted: 2 });
});

it('removes the ownership record once K4 compacts the intent', async () => {
  bot = openBot({ research: () => {} });
  await bot.enqueueHostIntent(input(), 'research');
  await bot.core.flushProjections(async () => {});
  expect(ledger!.compact({ acknowledgedIntentKeys: [KEY], now: Date.now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ compactedIntents: 1 });
  await bot.drain();
  expect(bot.snapshot().hostIntents).toEqual({});
});

it('opens without the handler of a Host intent that K4 compacted before the next pass', async () => {
  bot = openBot({ research: () => {} });
  await bot.enqueueHostIntent(input(), 'research');
  await bot.core.flushProjections(async () => {});
  await bot.close(); bot = undefined;
  // No pass runs between this compaction and the restart, so the ownership record is still stored.
  ledger!.compact({ acknowledgedIntentKeys: [KEY], now: Date.now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS });
  bot = openBot({});
  expect(bot.snapshot().hostIntents).toEqual({ [KEY]: { handler: 'research' } });
  await bot.drain();
  expect(bot.snapshot().hostIntents).toEqual({});
});

it('passes reconcileMs and onOutbox to the K4 core', async () => {
  expect(() => openBot({}, { reconcileMs: 0 })).toThrow('Reconciliation interval must be positive');
  const hints: string[] = [];
  bot = openBot({ research: (_document, tx) => { tx.publish('research', { done: true }); } }, { onOutbox: () => { hints.push('outbox'); } });
  await bot.enqueueHostIntent(input(), 'research');
  await vi.waitFor(() => expect(hints).not.toEqual([]));
});

const handled = (keys: string[]): HostIntentHandler => (_document, tx) => { keys.push(tx.intent.key); };

it('cancels an unsubmitted Host intent, so no handler runs and the Bot FIFO moves on, and a replay is already settled', async () => {
  paused = true;
  const keys: string[] = [];
  bot = openBot({ research: handled(keys) });
  // One Main Bot FIFO: a submitted Host intent, then the one to cancel, then a Bot Turn.
  for (const key of ['head', KEY]) await bot.enqueueHostIntent(input({ key, execution: template('device') }), 'research');
  const turnId = await bot.input('k1', 'hello');
  await expect(bot.cancelHostIntent(KEY)).resolves.toEqual({ key: KEY, result: 'cancelled', conclusion: 'cancelled' });
  paused = false;
  await bot.drain();
  expect({ keys, turn: bot.core.intent(turnId)?.phase, submitted: submitted.size }).toEqual({ keys: ['head'], turn: 'inflight', submitted: 2 });
  // K4 keeps the cancel on the intent row, so a restart reads the same fact and a replay sends nothing.
  bot = await restart({ research: handled(keys) });
  expect(bot.core.intent(KEY)).toMatchObject({ conclusion: 'cancelled', cancelReason: 'cancelled' });
  await expect(bot.cancelHostIntent(KEY)).resolves.toEqual({ key: KEY, result: 'already_settled', conclusion: 'cancelled' });
  expect({ keys, cancels }).toEqual({ keys: ['head'], cancels: [] });
});

it('sends an SDK cancel for a submitted Host intent, and a cancelled terminal after a restart runs no handler', async () => {
  paused = true;
  const keys: string[] = [];
  bot = openBot({ research: handled(keys) });
  const { taskId } = await bot.enqueueHostIntent(input(), 'research');
  await expect(bot.cancelHostIntent(KEY)).resolves.toEqual({ key: KEY, result: 'cancel_pending' });
  expect({ cancels: [...new Set(cancels)], conclusion: bot.core.intent(KEY)?.conclusion }).toEqual({ cancels: [taskId], conclusion: undefined });
  bot = await restart({ research: handled(keys) });
  paused = false;
  await bot.recover();
  expect({ conclusion: bot.core.intent(KEY)?.conclusion, keys }).toEqual({ conclusion: 'cancelled', keys: [] });
  await expect(bot.cancelHostIntent(KEY)).resolves.toEqual({ key: KEY, result: 'already_settled', conclusion: 'cancelled' });
});

it('runs the handler once for a Host intent that completed before the cancel', async () => {
  paused = true;
  const keys: string[] = [];
  bot = openBot({ research: handled(keys) });
  await bot.enqueueHostIntent(input(), 'research');
  paused = false; // The terminal is on the server before the cancel; no K8 pass has read it yet.
  await expect(bot.cancelHostIntent(KEY)).resolves.toEqual({ key: KEY, result: 'cancel_pending' });
  await bot.drain();
  expect({ conclusion: bot.core.intent(KEY)?.conclusion, keys, cancels }).toEqual({ conclusion: 'succeeded', keys: [KEY], cancels: [] });
});

it('refuses to cancel an unknown key, a direct K4 intent, a Bot Turn and a non-owner', async () => {
  paused = true;
  bot = openBot({ research: () => {} });
  await expect(bot.cancelHostIntent('missing')).rejects.toMatchObject({ name: 'HostIntentError', key: 'missing', code: 'unknown_intent' });
  await bot.core.enqueue(input({ key: 'direct' }));
  await expect(bot.cancelHostIntent('direct')).rejects.toMatchObject({ code: 'unknown_intent' });
  const turnId = await bot.input('k1', 'hello');
  await expect(bot.cancelHostIntent(turnId)).rejects.toMatchObject({ key: turnId, code: 'not_host_intent' });
  await bot.enqueueHostIntent(input(), 'research');
  await expect(bot.cancelHostIntent(KEY, { id: 'guest', kind: 'human' })).rejects.toThrow('not_owner: cancelHostIntent needs the owner principal');
  expect({ cancels, conclusion: bot.core.intent(KEY)?.conclusion }).toEqual({ cancels: [], conclusion: undefined });
});

// #1356: the Agent message of a Host intent goes to the Host's message handler in the K4 message transaction.
const base = template('device', 'research');
const chat = { ...base, agentMessageContext: { destinationBinding: 'conversation' }, payload: { ...base.payload,
  messageEgress: { mode: 'required' as const, contract: 'conversation-turn/v1', contentType: 'text/markdown' as const, maxBytes: 1024 } } };
const chatInput = () => input({ execution: chat });
function message(messageId = 'm1', contentHash = 'h1'): AgentMessageInput {
  return { tenant: 'tenant', taskId: bot!.core.intent(KEY)!.taskId, deviceId: 'device', context: chat.agentMessageContext,
    payload: { agentRef: chat.payload.agentRef, messageId, contentHash, contentType: 'text/markdown', body: 'Here is the answer.' } } as unknown as AgentMessageInput;
}
/** A message handler that records each call's message id and returns `decide()`. */
function chatBot(decide: () => unknown, calls: string[] = []): { calls: string[]; handler: HostIntentMessageHandler } {
  return { calls, handler: input => { calls.push(input.payload.messageId); return decide() as MessageDisposition; } };
}

it('gives a Host intent message to its handler, records the accepted reply without a body, and a replay runs no handler', async () => {
  paused = true;
  const { calls, handler } = chatBot(() => ({ outcome: 'accepted' }));
  bot = openBot({ chat: () => {} }, { hostIntentMessages: { chat: handler } });
  const { taskId } = await bot.enqueueHostIntent(chatInput(), 'chat');
  expect(await bot.consumeMessage(message())).toEqual({ outcome: 'accepted' });
  expect(bot.snapshot().replies[taskId]).toEqual({ turnId: KEY, messageId: 'm1', contentHash: 'h1', contentType: 'text/markdown', acceptedAt: expect.any(Number) });
  expect(await bot.consumeMessage(message())).toEqual({ outcome: 'accepted' });
  expect(calls).toEqual(['m1']);
});

it('returns a refusal of the handler as it is, and its replay without the handler, and other content is a conflict', async () => {
  paused = true;
  const { calls, handler } = chatBot(() => ({ outcome: 'refused', reasonCode: 'conversation_closed' }));
  bot = openBot({ chat: () => {} }, { hostIntentMessages: { chat: handler } });
  await bot.enqueueHostIntent(chatInput(), 'chat');
  const refused = { outcome: 'refused', reasonCode: 'conversation_closed' };
  expect(await bot.consumeMessage(message())).toEqual(refused);
  expect(await bot.consumeMessage(message())).toEqual(refused);
  expect(await bot.consumeMessage(message('m1', 'h2'))).toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
  expect({ calls, replies: bot.snapshot().replies }).toEqual({ calls: ['m1'], replies: {} });
});

it('writes nothing for a handler that throws, returns a thenable or returns another shape', async () => {
  paused = true;
  const unhandled: unknown[] = [], record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  onTestFinished(() => { process.off('unhandledRejection', record); });
  let decide: () => unknown = () => { throw new Error('conversation store offline'); };
  bot = openBot({ chat: () => {} }, { hostIntentMessages: { chat: () => decide() as MessageDisposition } });
  await bot.enqueueHostIntent(chatInput(), 'chat');
  const before = ledger!.snapshot();
  await expect(bot.consumeMessage(message())).rejects.toThrow('conversation store offline');
  decide = async () => { throw new Error('async conversation failed'); };
  await expect(bot.consumeMessage(message())).rejects.toThrow('Host intent message handler must be synchronous');
  decide = () => ({ outcome: 'refused' });
  await expect(bot.consumeMessage(message())).rejects.toThrow('Invalid Host intent message disposition');
  expect(ledger!.snapshot()).toEqual(before);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(unhandled).toEqual([]);
});

it('refuses the message of a Host intent whose name has no message handler with binding_mismatch', async () => {
  paused = true;
  const { calls, handler } = chatBot(() => ({ outcome: 'accepted' }));
  bot = openBot({ research: () => {}, chat: () => {} }, { hostIntentMessages: { chat: handler } });
  const { taskId } = await bot.enqueueHostIntent(input(), 'research');
  const plain = { ...message(), context: undefined, payload: { ...message().payload, agentRef: base.payload.agentRef } } as unknown as AgentMessageInput;
  expect(await bot.consumeMessage({ ...plain, taskId })).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
  expect(calls).toEqual([]);
});

it('needs a message handler for a messageEgress Host intent at enqueue and at a restart', async () => {
  paused = true;
  expect(() => openBot({}, { hostIntentMessages: { chat: () => ({ outcome: 'accepted' }) } }))
    .toThrow('A Host intent message handler needs the Host intent handler chat');
  bot = openBot({ chat: () => {} });
  await expect(bot.enqueueHostIntent(chatInput(), 'chat')).rejects.toThrow('Host intent handler chat has no message handler');
  expect(bot.core.intent(KEY)).toBeUndefined();
  const { handler } = chatBot(() => ({ outcome: 'accepted' }));
  bot = await restart({ chat: () => {} }, { hostIntentMessages: { chat: handler } });
  await bot.enqueueHostIntent(chatInput(), 'chat');
  await expect(restart({ chat: () => {} })).rejects.toThrow('An open Host intent needs the message handler chat');
  bot = openBot({ chat: () => {} }, { hostIntentMessages: { chat: handler } });
  expect(await bot.consumeMessage(message())).toEqual({ outcome: 'accepted' });
});

it('exports a ledger with a Host intent reply, and the pass after K4 compacts the intent removes the reply', async () => {
  paused = true;
  const { handler } = chatBot(() => ({ outcome: 'accepted' }));
  bot = openBot({ chat: () => {} }, { hostIntentMessages: { chat: handler } });
  const { taskId } = await bot.enqueueHostIntent(chatInput(), 'chat');
  expect(await bot.consumeMessage(message())).toEqual({ outcome: 'accepted' });
  paused = false;
  await bot.drain();
  expect(bot.core.intent(KEY)?.conclusion).toBe('succeeded');
  await bot.core.flushProjections(async () => {});
  expect(() => sealLedger(ledger!, { source: 'L', domain: 'tenant', exportedAt: Date.now(), devices: [{ deviceId: 'device', frozenRevision: 1 }] }))
    .not.toThrow();
  expect(ledger!.compact({ acknowledgedIntentKeys: [KEY], now: Date.now(), tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ compactedIntents: 1 });
  expect(bot.snapshot().replies[taskId]).toBeDefined();
  await bot.drain();
  expect({ hostIntents: bot.snapshot().hostIntents, replies: bot.snapshot().replies }).toEqual({ hostIntents: {}, replies: {} });
});

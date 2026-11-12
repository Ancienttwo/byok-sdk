import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type AgentEgressPolicy, type Daemon } from '@byok-sdk/client';
import { InMemoryDeviceCredentialBackend } from '@byok-sdk/client/testing';
import { createByokServer, listenLoopback, type ByokServer, type LoopbackListener } from '@byok-sdk/server';
import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { createBotPersonaProjection, type AgentMessageInput } from '@byok-sdk/bot-collaboration';
import { ResultStubAdapter } from '@byok-sdk/bot-collaboration/testing';
import { ConversationService } from '../conversation/service.ts';
import { botViews, conversationItems, turnEnd } from '../conversation/view.ts';
import { HostStore } from '../store/store.ts';
import { Conversation } from './conversation.ts';

const productId = 'desktop-k8-test';
const policy: AgentEgressPolicy = {
  policyRevision: 'k4-v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};
const WRITER = { id: 'writer', name: 'Writer', role: 'Writes drafts', persona: 'Short answers.', model: 'default' };

interface Fixture {
  root: string; server: ByokServer; listener: LoopbackListener; daemon: Daemon; adapter: ResultStubAdapter; store: HostStore;
  conversation: Conversation; execution: ExecutionTemplate; deviceCredentials: InMemoryDeviceCredentialBackend;
}
let f: Fixture | undefined;
afterEach(async () => {
  if (!f) return;
  await f.conversation.close(); await f.daemon.stop(); await f.listener.close(); await f.server.close(); f.store.close();
  await rm(f.root, { recursive: true, force: true });
  f = undefined;
});

/** The daemon's own ready fact: the server accepted this run's hello. */
const ready = (daemon: Daemon) => daemon.whenOpen({ signal: AbortSignal.timeout(5000) });
function newDaemon(fx: Pick<Fixture, 'root' | 'listener' | 'adapter' | 'deviceCredentials'>): Daemon {
  return createDaemonWithAdapters({ productId, productName: 'Desktop K8 Test', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: fx.listener.serverUrl, storeDir: path.join(fx.root, 'sdk'),
    agentHome: { hostStorageRoot: fx.root, projection: createBotPersonaProjection() }, agentEgress: { policy },
  }, [fx.adapter], { deviceCredentials: fx.deviceCredentials });
}
const openConversation = (fx: Pick<Fixture, 'root' | 'server' | 'store' | 'execution'>, dreaming: { models: string[] } | false = { models: [] }) =>
  Conversation.open({ server: fx.server, productId, ledgerFile: path.join(fx.root, 'host', 'k8.sqlite'), store: fx.store, execution: fx.execution,
    models: { default: fx.execution }, dreaming });
const openDreams = (fx: Fixture) => Object.values(fx.conversation.bot.ledger.snapshot().routines)
  .filter(row => row.definition.id.startsWith('dream:') && row.lifecycle !== 'completed');

/** K8's synthetic adapter on a real embedded server, loopback listener and daemon; the store and K8 ledger are files. */
async function open(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-k8-'));
  await mkdir(path.join(root, 'host'));
  let conversation: Conversation | undefined;
  const live = () => { if (!conversation) throw new Error('No conversation'); return conversation; };
  const server = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(root, 'host', 'server.sqlite') }, longPollHoldMs: 100,
    agentMessage: { consume: input => live().consumeMessage(input) }, wake: { consume: (wake, signal) => live().consume(wake, signal) } });
  let port: number | null = null;
  const listener = await listenLoopback({ portStore: { read: async () => port, claim: async candidate => (port = candidate) },
    createHandler: () => request => server.hono.fetch(request) });
  const adapter = new ResultStubAdapter(), deviceCredentials = new InMemoryDeviceCredentialBackend();
  const daemon = newDaemon({ root, listener, adapter, deviceCredentials });
  const { deviceId } = await daemon.pair((await server.pairing.createPairingCode({ productId })).code);
  await daemon.start(); await ready(daemon);
  const execution: ExecutionTemplate = { deviceId, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'desktop' }, payload: {
    runtime: 'pi', session: { mode: 'fresh' }, instruction: 'Answer the user.', agentRef: { agentId: 'host', profileRevision: '1' }, egressPolicy: policy,
    messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 },
    terminalProjection: { mode: 'result-document', contract: 'desktop-test-v1', schema: { type: 'object' } },
  } };
  const store = HostStore.open(path.join(root, 'host', 'store.sqlite'));
  conversation = await openConversation({ root, server, store, execution });
  f = { root, server, listener, daemon, adapter, store, conversation, execution, deviceCredentials };
  return f;
}
async function reopen(fx: Fixture, dreaming?: false): Promise<void> {
  await fx.conversation.close();
  fx.conversation = await openConversation(fx, dreaming);
}
async function running(fx: Fixture, turnId: string) {
  return vi.waitFor(async () => {
    await fx.conversation.bot.drain();
    const session = fx.adapter.sessions.get(fx.conversation.bot.core.intent(turnId)?.taskId ?? '');
    if (!session) throw new Error(`Turn ${turnId} is not running`);
    return session;
  }, { timeout: 10_000 });
}
async function ended(fx: Fixture, turnId: string) {
  return vi.waitFor(async () => {
    await fx.conversation.bot.drain();
    const turn = fx.store.turns(WRITER.id).find(row => row.turnId === turnId);
    if (turn?.projection.conclusion === undefined) throw new Error(`Turn ${turnId} has not ended in the store`);
    return turn;
  }, { timeout: 10_000 });
}
function historyOf(fx: Fixture, turnId: string): Array<{ lines: Array<{ speaker: string; text: string }> }> {
  const instruction = String(fx.conversation.bot.core.intent(turnId)!.execution.payload.instruction);
  return JSON.parse(instruction.split('\nContextPack:\n')[1]!).history.recent;
}

it('writes the reply after the outcome, carries it into the next history, and clears the epoch', async () => {
  const fx = await open();
  await fx.conversation.saveBot(WRITER);
  const first = await fx.conversation.send('a1', WRITER.id, 'Hello');
  expect(await fx.conversation.send('a1', WRITER.id, 'Hello')).toBe(first);
  await (await running(fx, first)).finish({}, true, 'Hi there');
  expect(await ended(fx, first)).toMatchObject({ reply: 'Hi there', projection: { status: 'succeeded' } });
  expect(fx.store.transcript(WRITER.id).map(entry => [entry.kind, 'text' in entry ? entry.text : ''])).toEqual([['input', 'Hello'], ['reply', 'Hi there']]);

  const second = await fx.conversation.send('a2', WRITER.id, 'Again');
  await running(fx, second);
  expect(historyOf(fx, second).map(turn => turn.lines)).toEqual([[{ speaker: 'user', text: 'Hello' }, { speaker: 'bot', text: 'Hi there' }]]);
  await (await running(fx, second)).finish({}, true, 'Second answer');
  await ended(fx, second);

  fx.conversation.clear('c1', WRITER.id);
  const third = await fx.conversation.send('a3', WRITER.id, 'Fresh start');
  await running(fx, third);
  expect(historyOf(fx, third)).toEqual([]);
}, 30_000);

it('finishes sends at reopen: inputRoot for one K8 committed, input for one it never saw', async () => {
  const fx = await open();
  await fx.conversation.saveBot(WRITER);
  // A crash after the store write and before K8's input.
  fx.store.recordInput('unseen', WRITER.id, 'Never reached K8');
  // A crash after K8's input and before the store recorded its Turn.
  fx.store.recordInput('committed', WRITER.id, 'Reached K8');
  const committed = await fx.conversation.bot.input('committed', 'Reached K8', WRITER.id);
  expect(openDreams(fx)).toHaveLength(1);
  // Dreaming turned off in settings: the next open ends the Bot's dream routine.
  await reopen(fx, false);
  expect(openDreams(fx)).toEqual([]);
  const inputs = fx.store.transcript(WRITER.id).filter(entry => entry.kind === 'input');
  expect(inputs.map(entry => entry.turnId)).toEqual([expect.any(String), committed]);
  expect(Object.keys(fx.conversation.bot.snapshot().turns).sort()).toEqual(inputs.map(entry => entry.turnId).sort());
});

it('keeps a reply out of the transcript when the daemon stops between its acceptance and the outcome (R1)', async () => {
  const fx = await open();
  await fx.conversation.saveBot(WRITER);
  const turnId = await fx.conversation.send('a1', WRITER.id, 'Hello');
  await running(fx, turnId);
  const intent = fx.conversation.bot.core.intent(turnId)!, body = 'Early reply';
  const message = { tenant: fx.conversation.bot.ledger.tenant, taskId: intent.taskId, deviceId: intent.execution.deviceId,
    context: intent.execution.agentMessageContext!, payload: { agentRef: intent.execution.payload.agentRef, sessionRef: randomUUID(),
      contract: 'conversation-turn/v1', messageId: randomUUID(), cursor: 1, contentType: 'text/markdown', body,
      contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}`, byteCount: Buffer.byteLength(body) } } as unknown as AgentMessageInput;
  expect(await fx.conversation.consumeMessage(message)).toEqual({ outcome: 'accepted' });
  await fx.daemon.stop();
  fx.daemon = newDaemon(fx);
  await fx.daemon.start(); await ready(fx.daemon);
  expect(await ended(fx, turnId)).toMatchObject({ projection: { status: 'failed' } });
  expect(fx.store.turns(WRITER.id)[0]!.reply).toBeUndefined();
  expect(fx.store.transcript(WRITER.id).map(entry => entry.kind)).toEqual(['input']);
});

it('shows a failed Turn with the server\'s task reason, and marks a Pi background refusal (R2)', async () => {
  const fx = await open();
  const changed = vi.fn();
  const service = new ConversationService({ conversation: fx.conversation, store: fx.store, server: fx.server,
    brand: { roles: [] }, models: () => [{ id: 'default', label: 'Default' }], changed });
  await service.saveBot(WRITER);
  // A command the view reads signals the Host's view change.
  expect(changed).toHaveBeenCalled();
  const { turnId } = await service.send({ actionId: 'a1', botId: WRITER.id, text: 'Run it in the background' });
  expect((await service.view({ botId: WRITER.id })).conversation!.cancellable).toEqual([turnId]);
  const session = await running(fx, turnId);
  session.emit({ type: 'error', message: 'runtime refused' });
  await session.close();
  const record = await ended(fx, turnId);
  const { result } = (await fx.server.tasks.get(fx.conversation.bot.core.intent(turnId)!.taskId))!;
  const view = await service.view({ botId: WRITER.id });
  expect(view.bots).toMatchObject([{ id: WRITER.id, state: 'idle' }]);
  expect(view.conversation).toEqual({ botId: WRITER.id, cancellable: [], items: [
    expect.objectContaining({ kind: 'input', text: 'Run it in the background' }),
    expect.objectContaining({ kind: 'ended', end: { turnId, conclusion: 'failed', reason: result!.reason } }),
  ] });
  const refusal = 'pi_background_unavailable: Node SEA cannot run background Pi subagents or workflows.';
  expect(turnEnd(record, refusal)).toEqual({ turnId, conclusion: 'failed', reason: refusal, backgroundUnavailable: true });
  service.close();
}, 30_000);

it('places drafts, questions, outcome-less and cancelled Turns, folds above the clear, and derives each rail state', () => {
  const turn = (id: string, fields: Record<string, unknown> = {}) => ({ id, root: id, botId: 'b', source: 'user', request: '', hop: 0, status: 'processing', ...fields }) as never;
  const ended = (id: string, seq: number, conclusion: string, reply?: string) => ({ turnId: id, botId: 'b', root: id, seq,
    projection: { ...turn(id, { status: conclusion === 'succeeded' ? 'succeeded' : 'failed', conclusion }) as object, owner: 'b' }, ...(reply ? { reply } : {}) }) as never;
  const view = conversationItems('b', {
    entries: [
      { seq: 1, kind: 'input', botId: 'b', actionId: 'a1', text: 'one', turnId: 't1', at: 0 },
      { seq: 2, kind: 'reply', botId: 'b', turnId: 't1', taskId: 'k1', text: 'reply one', at: 0 },
      { seq: 3, kind: 'clear', botId: 'b', actionId: 'c1', at: 0 },
      { seq: 4, kind: 'input', botId: 'b', actionId: 'a2', text: 'two', turnId: 't2', at: 0 },
      { seq: 5, kind: 'input', botId: 'b', actionId: 'a3', text: 'three', turnId: 't3', at: 0 },
      { seq: 6, kind: 'input', botId: 'b', actionId: 'a4', text: 'four', turnId: 't4', at: 0 },
      { seq: 7, kind: 'input', botId: 'b', actionId: 'a5', text: 'five', turnId: 't5', at: 0 },
    ],
    ended: [ended('t1', 1, 'succeeded', 'reply one'), ended('t2', 4, 'succeeded'), ended('t3', 5, 'cancelled'), ended('t4', 6, 'succeeded')],
    open: [turn('t5')], questions: [{ id: 'q1', turnId: 't4', value: { question: 'Which?', answerKind: 'text' } }],
    drafts: new Map([['t5', { text: 'typing', state: 'open' as const }]]), taskReasons: new Map(),
  });
  expect(view.items.map(item => [item.kind, 'folded' in item ? item.folded : undefined])).toEqual([
    ['input', true], ['reply', true], ['clear', undefined], ['input', false], ['ended', false], ['input', false], ['ended', false],
    ['input', false], ['question', undefined], ['input', false], ['working', undefined],
  ]);
  expect(view.items.filter(item => item.kind === 'ended').map(item => item.end.conclusion)).toEqual(['no_reply', 'cancelled']);
  expect(view.items.at(-1)).toMatchObject({ turnId: 't5', draft: { text: 'typing' } });

  const row = (id: string, archived = false) => ({ ...WRITER, id, archived });
  const ready = { revision: '1', readyRevision: '1' }, bots = { a: ready, b: { revision: '2', readyRevision: '1' }, c: ready, d: ready, e: ready, f: ready };
  const states = botViews([row('z', true), row('a'), row('b'), row('c'), row('d'), row('e')], { team: { bots: bots as never }, questions: {
    q: { id: 'q', turnId: 'tc', value: { question: '?', answerKind: 'text' } },
  }, turns: { ta: turn('ta', { botId: 'a', status: 'blocked', blockedReason: 'model_unavailable' }), tc: turn('tc', { botId: 'c', status: 'succeeded', conclusion: 'succeeded' }),
    td: turn('td', { botId: 'd' }) } });
  expect(states.map(bot => [bot.id, bot.state, bot.reason])).toEqual([['z', 'archived', undefined], ['a', 'runtime_unavailable', 'model_unavailable'],
    ['b', 'profile_updating', undefined], ['c', 'waiting', undefined], ['d', 'working', undefined], ['e', 'idle', undefined]]);
});

/** A refused Bot leaves the store and its revision unchanged, so the next open still sends a roster that K8 accepts. */
async function refused(fx: Fixture, profile: typeof WRITER, message: RegExp): Promise<void> {
  const before = fx.store.roster();
  await expect(fx.conversation.saveBot(profile)).rejects.toThrow(message);
  expect(fx.store.roster()).toEqual(before);
  await reopen(fx);
  expect(fx.conversation.bot.snapshot().team.external!.revision).toBe(before.revision);
}

it('refuses a Bot beyond K8\'s team limit before the store commits it', async () => {
  const fx = await open();
  for (let n = 1; n <= 24; n++) await fx.conversation.saveBot({ ...WRITER, id: `bot-${n}` });
  await refused(fx, { ...WRITER, id: 'bot-25' }, /Team Bot limit/);
}, 30_000);

it('refuses a created or re-pointed Bot whose model is not in the catalog before the store commits it', async () => {
  const fx = await open();
  await refused(fx, { ...WRITER, model: 'missing' }, /Unavailable model: missing/);
  await fx.conversation.saveBot(WRITER);
  await refused(fx, { ...WRITER, model: 'missing' }, /Unavailable model: missing/);
});

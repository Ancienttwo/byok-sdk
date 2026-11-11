import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type AgentEgressPolicy, type Daemon } from '@byok-sdk/client';
import { createByokServer, listenLoopback, type ByokServer, type LoopbackListener } from '@byok-sdk/server';
import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { createBotPersonaProjection, type AgentMessageInput } from '@byok-sdk/example-bot-collaboration';
import { InMemoryDeviceCredentials, ResultStubAdapter } from '@byok-sdk/example-bot-collaboration/l-test-host';
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
  conversation: Conversation; execution: ExecutionTemplate; deviceCredentials: InMemoryDeviceCredentials;
}
let f: Fixture | undefined;
afterEach(async () => {
  if (!f) return;
  await f.conversation.close(); await f.daemon.stop(); await f.listener.close(); await f.server.close(); f.store.close();
  await rm(f.root, { recursive: true, force: true });
  f = undefined;
});

/** The daemon's own ready fact: the server accepted this run's hello. */
async function ready(daemon: Daemon): Promise<void> {
  await vi.waitFor(() => expect(daemon.status().lifecycle).toEqual({ phase: 'running', connection: 'open' }), { timeout: 5000 });
}
function newDaemon(fx: Pick<Fixture, 'root' | 'listener' | 'adapter' | 'deviceCredentials'>): Daemon {
  return createDaemonWithAdapters({ productId, productName: 'Desktop K8 Test', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: fx.listener.serverUrl, storeDir: path.join(fx.root, 'sdk'),
    agentHome: { hostStorageRoot: fx.root, projection: createBotPersonaProjection() }, agentEgress: { policy },
  }, [fx.adapter], { deviceCredentials: fx.deviceCredentials });
}
const openConversation = (fx: Pick<Fixture, 'root' | 'server' | 'store' | 'execution'>) => Conversation.open({ server: fx.server, productId,
  ledgerFile: path.join(fx.root, 'host', 'k8.sqlite'), store: fx.store, execution: fx.execution, models: { default: fx.execution } });

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
  const adapter = new ResultStubAdapter(), deviceCredentials = new InMemoryDeviceCredentials();
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
async function reopen(fx: Fixture): Promise<void> {
  await fx.conversation.close();
  fx.conversation = await openConversation(fx);
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
  await reopen(fx);
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

import { spawn, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessagePublishPayload, Envelope } from '@byok-sdk/protocol';
import type { AgentMessageDraftEvent } from '@byok-sdk/server';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { createDaemonWithAdapters, type Daemon } from '@byok-sdk/client';
import type { RuntimeAdapter } from '../types';
import { InMemoryDeviceCredentialStore } from './fixtures/device-credentials';
import { testScratchRoot } from './fixtures/execution-scratch';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';
import { startRealServer, type RealServerHandle } from './fixtures/real-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const piFixture = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const agentRef = { agentId: 'stream-agent', profileRevision: '1' };
const taskId = 'stream-task';
const productId = 'draft-e2e';
const policy = { ...DEFAULT_AGENT_EGRESS_POLICY,
  activity: { ...DEFAULT_AGENT_EGRESS_POLICY.activity, maxCoalesceMs: 25 } };
const originalFetch = globalThis.fetch;
let real: RealServerHandle | undefined;
let daemon: Daemon | undefined;
let root: string | undefined;
let readerAbort: AbortController | undefined;

afterEach(async () => {
  readerAbort?.abort();
  await daemon?.stop();
  await real?.close();
  globalThis.fetch = originalFetch;
  if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  daemon = undefined; real = undefined; root = undefined; readerAbort = undefined;
});

async function setup(options: { adapter?: RuntimeAdapter; oldServer?: boolean; gateReply?: boolean } = {}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-draft-e2e-'));
  const gate = path.join(root, 'reply');
  await fs.mkdir(gate);
  const adapter = options.adapter ?? new PiAdapter({
    resolveBin: () => ({ command: piFixture, source: 'env' }),
    spawnFn: ((command: string, args: readonly string[], spawnOptions?: SpawnOptions) => spawn(command, args, {
      ...spawnOptions, env: { ...spawnOptions?.env,
        ...(options.gateReply ? { FAKE_PI_REPLY_GATE: gate } : {}) },
    })) as typeof spawn,
  });
  const accepted: AgentMessagePublishPayload[] = [];
  const sent: Envelope[] = [];
  const rejections: unknown[] = [];
  const advertisements: string[][] = [];
  real = await startRealServer({ productId, storage: { kind: 'memory' }, longPollHoldMs: 30,
    agentMessage: { consume: async ({ payload }) => { accepted.push(payload); return { outcome: 'accepted' }; } },
  });
  const server = real;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const messagesRoute = url.startsWith(`${server.url}/byok/messages`);
    const eventsRoute = url.startsWith(`${server.url}/byok/events`);
    if (messagesRoute && typeof init?.body === 'string') {
      sent.push(...(JSON.parse(init.body) as { messages: Envelope[] }).messages);
    }
    const response = await originalFetch(input, init);
    if (!messagesRoute && !eventsRoute) return response;
    const body = await response.clone().json() as { capabilities?: string[]; rejected?: number };
    if (body.rejected) rejections.push(body);
    if (body.capabilities !== undefined) {
      if (options.oldServer) body.capabilities = body.capabilities.filter(flag => flag !== 'agent-message-draft');
      advertisements.push(body.capabilities);
      if (options.oldServer) return new Response(JSON.stringify(body), {
        status: response.status, headers: response.headers,
      });
    }
    return response;
  }) as typeof fetch;
  daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-draft-test' },
    productName: 'Draft test', productId, serverUrl: server.url,
    storeDir: path.join(root, 'store'),
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  const { deviceId } = await daemon.pair((await server.createPairingCode()).code);
  await daemon.start();
  await waitForDaemonOpen(daemon);
  const submit = async (required = true) => {
    await server.byok.executions.submit({ taskId, deviceId, payload: {
      instruction: 'Write a reply.', agentRef, session: { mode: 'fresh' }, egressPolicy: policy,
      ...(adapter.descriptor.id === 'custom-draft' ? { harnessId: 'custom-draft' } : { runtime: 'pi' as const }),
      ...(required ? { messageEgress: {
        mode: 'required' as const, contract: 'draft.v1', contentType: 'text/plain' as const, maxBytes: 1024,
      } } : {}),
      terminalProjection: { mode: 'none' },
    }, ...(required ? { agentMessageContext: { destinationBinding: 'chat' } } : {}) });
  };
  const read = () => {
    readerAbort = new AbortController();
    const events: AgentMessageDraftEvent[] = [];
    const done = (async () => {
      for await (const event of server.byok.tasks.messageDraft(taskId, deviceId, agentRef, { signal: readerAbort!.signal })) {
        events.push(event);
      }
    })();
    return { events, done };
  };
  const terminal = () => vi.waitFor(async () => {
    expect(await server.byok.tasks.deviceTerminal(taskId)).toMatchObject({ envelope: { type: 'task.complete' } });
  }, { timeout: 10_000 });
  return { server, deviceId, accepted, sent, rejections, advertisements, submit, read, terminal,
    release: (name: 'next' | 'finish') => fs.writeFile(path.join(gate, name), '') };
}

function drafts(sent: Envelope[]) {
  return sent.filter((e): e is Extract<Envelope, { type: 'agent.message.draft' }> => e.type === 'agent.message.draft');
}

function assertWireCapability(sent: Envelope[], id: string, expected: true | undefined) {
  const hello = sent.find(e => e.type === 'conn.hello');
  if (hello?.type !== 'conn.hello') throw new Error('missing conn.hello');
  const runtime = [...(hello.payload.runtimes ?? []), ...(hello.payload.harnesses ?? [])].find(r => r.id === id);
  expect(runtime).toBeDefined();
  expect(runtime?.capabilities?.messageDraft).toBe(expected);
  const claim = sent.find(e => e.type === 'task.claim');
  if (claim?.type !== 'task.claim') throw new Error('missing task.claim');
  expect(claim.payload.capabilities?.messageDraft).toBe(expected);
}

describe('Agent message drafts through the real server and daemon', () => {
  it('streams at least two Pi appends whose trimmed text equals the accepted message', async () => {
    const f = await setup({ gateReply: true });
    await f.submit();
    const reader = f.read();
    await vi.waitFor(() => expect(reader.events.filter(e => e.kind === 'append')).toHaveLength(1), { timeout: 10_000 });
    await f.release('next');
    await vi.waitFor(() => expect(reader.events.filter(e => e.kind === 'append')).toHaveLength(2));
    await f.release('finish');
    await reader.done;
    await f.terminal();
    const appends = reader.events.filter(e => e.kind === 'append');
    expect(appends.length).toBeGreaterThanOrEqual(2);
    expect(appends.map(e => e.text).join('').trim()).toBe(f.accepted[0]?.body);
    expect(f.accepted).toHaveLength(1);
    expect(f.accepted[0]?.body).toBe('Hello world');
    expect(appends.map(e => e.offset)).toEqual([0, 6]);
    expect(new Set(appends.map(e => e.revision)).size).toBe(1);
    expect(reader.events.at(-1)).toEqual({ kind: 'ended' });
    expect(f.sent.findIndex(e => e.type === 'agent.message.publish')).toBeGreaterThan(f.sent.findLastIndex(e => e.type === 'agent.message.draft'));
    expect(f.rejections).toEqual([]);
    expect(f.advertisements.some(flags => flags.includes('agent-message-draft'))).toBe(true);
    assertWireCapability(f.sent, 'pi', true);
  }, 20_000);

  it('discards a Pi reply cancelled after its first real draft append', async () => {
    const f = await setup({ gateReply: true });
    await f.submit();
    const reader = f.read();
    await vi.waitFor(() => expect(reader.events.some(e => e.kind === 'append')).toBe(true), { timeout: 10_000 });
    await f.server.byok.tasks.cancel(taskId, 'cancel mid-reply');
    await reader.done;
    expect(reader.events.at(-1)).toEqual({ kind: 'discarded' });
    expect(f.accepted).toEqual([]);
    expect(f.sent.filter(e => e.type === 'agent.message.publish')).toEqual([]);
    const cancelled = f.sent.findIndex(e => e.type === 'task.cancelled');
    expect(cancelled).toBeGreaterThanOrEqual(0);
    expect(f.sent.slice(cancelled + 1).some(e => e.type === 'agent.message.draft')).toBe(false);
    expect(f.rejections).toEqual([]);
  }, 20_000);

  it('sends zero draft envelopes for a stub adapter without messageDraft', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const f = await setup({ adapter });
    await f.submit();
    const reader = f.read();
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), { timeout: 10_000 });
    adapter.sessions[0]!.emit({ type: 'progress', text: 'stub answer' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await reader.done;
    await f.terminal();
    expect(reader.events).toEqual([{ kind: 'ended' }]);
    expect(f.accepted[0]?.body).toBe('stub answer');
    expect(drafts(f.sent)).toEqual([]);
    assertWireCapability(f.sent, 'pi', undefined);
    expect(f.rejections).toEqual([]);
  }, 20_000);

  it('sends zero Pi draft frames to an old server without the flag', async () => {
    const f = await setup({ oldServer: true });
    await f.submit();
    const reader = f.read();
    await reader.done;
    await f.terminal();
    expect(reader.events).toEqual([{ kind: 'ended' }]);
    expect(f.accepted[0]?.body).toBe('Hello world');
    expect(drafts(f.sent)).toEqual([]);
    expect(f.advertisements.length).toBeGreaterThan(0);
    expect(f.advertisements.every(flags => !flags.includes('agent-message-draft'))).toBe(true);
    assertWireCapability(f.sent, 'pi', true);
    expect(f.rejections).toEqual([]);
  }, 20_000);

  it('sends zero frames without a message requirement even for Pi', async () => {
    const f = await setup();
    await f.submit(false);
    await f.terminal();
    expect(drafts(f.sent)).toEqual([]);
    expect(f.accepted).toEqual([]);
    assertWireCapability(f.sent, 'pi', true);
  }, 20_000);

  it.each(['pi', 'custom-draft'])('flushes pending %s text before publish and maps the claim capability', async id => {
    const adapter = new StubRuntimeAdapter(id, { kind: 'available' }, {
      steer: true, resume: true, approvalInteractive: false, mcpToolsets: true, messageDraft: true,
    });
    const f = await setup({ adapter });
    await f.submit();
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), { timeout: 10_000 });
    adapter.sessions[0]!.emit({ type: 'progress', text: '  closing reply \n' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await f.terminal();
    const frames = drafts(f.sent);
    const revisions = [...new Set(frames.map(e => e.payload.revision))];
    expect(revisions).toEqual([1, 2]);
    expect(frames.filter(e => e.payload.revision === revisions[0]).map(e => e.payload.text).join('')).toBe('  closing reply \n');
    expect(frames.filter(e => e.payload.revision === revisions[1]).map(e => e.payload.text).join('')).toBe('closing reply');
    expect(f.accepted[0]?.body).toBe('closing reply');
    expect(f.sent.findIndex(e => e.type === 'agent.message.publish')).toBeGreaterThan(f.sent.findLastIndex(e => e.type === 'agent.message.draft'));
    assertWireCapability(f.sent, id, true);
    expect(f.rejections).toEqual([]);
  }, 20_000);
});

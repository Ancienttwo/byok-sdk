import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessagePublishPlainPayload, Envelope } from '@byok-sdk/protocol';
import type { AgentMessageDraftEvent } from '@byok-sdk/server';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { HermesAdapter } from '../adapters/hermes/hermes-adapter';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { taskRuntimeTarget } from '../runtime-detection';
import { createDaemonWithAdapters, type Daemon } from '@byok-sdk/client';
import type { RuntimeAdapter } from '../types';
import { InMemoryDeviceCredentialStore } from './fixtures/device-credentials';
import { testScratchRoot } from './fixtures/execution-scratch';
import { fakeHermesCommand } from './fixtures/fake-hermes-command';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';
import { startRealServer, type RealServerHandle } from './fixtures/real-server';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const agentRef = { agentId: 'draft-runtime-agent', profileRevision: '1' };
const taskId = 'draft-runtime-task';
const productId = 'draft-runtime-e2e';
const policy = { ...DEFAULT_AGENT_EGRESS_POLICY,
  activity: { ...DEFAULT_AGENT_EGRESS_POLICY.activity, maxCoalesceMs: 25 } };
const posix = process.platform !== 'win32';
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

interface RuntimeCase {
  readonly fixture: string;
  /** The latest draft revision while the fake holds its reply. */
  readonly held: RegExp;
  /** Each fake holds its reply until `<gate>/release`, after two streamed pieces and before the whole message. */
  readonly env: (gate: string) => Record<string, string>;
  readonly adapter: (command: string, root: string) => RuntimeAdapter;
}

const cases: Record<'claude' | 'codex' | 'grok' | 'hermes', RuntimeCase> = {
  claude: {
    fixture: 'fake-claude.mjs',
    held: /^reply-1:[\s\S]*Write a reply\.$/,
    env: gate => ({ FAKE_CLAUDE_PARTIAL_MESSAGES: '1', FAKE_CLAUDE_REPLY_GATE: gate }),
    adapter: command => new ClaudeAdapter({ resolveBin: () => ({ command, source: 'path' }) }),
  },
  codex: {
    fixture: 'fake-codex.mjs',
    held: /^hello from fake codex$/,
    env: gate => ({ FAKE_CODEX_MESSAGE_DELTAS: '1', FAKE_CODEX_REPLY_GATE: gate }),
    adapter: command => new CodexAdapter({ resolveBin: () => ({ command, source: 'path' }) }),
  },
  grok: {
    fixture: 'fake-acp-agent.mjs',
    held: /^echo:Write a reply\.$/,
    env: gate => ({ FAKE_ACP_REPLY_GATE: gate }),
    adapter: command => new GrokAdapter({ resolveBin: () => ({ command, source: 'path' }) }),
  },
  hermes: {
    fixture: 'fake-hermes.mjs',
    held: /^Done$/,
    env: gate => ({ FAKE_HERMES_REPLY_GATE: gate }),
    adapter: (command, dir) => new HermesAdapter({ home: path.join(dir, 'hermes-root'), resolveBin: () => ({ command: fakeHermesCommand(command, dir), source: 'path' }) }),
  },
};

/** A launcher that sets the fake's toggles itself, so the test does not depend on which variables an adapter forwards. */
async function launcher(dir: string, script: string, env: Record<string, string>): Promise<string> {
  const file = path.join(dir, `launch-${path.basename(script)}`);
  await fs.writeFile(file, `#!/usr/bin/env node
Object.assign(process.env, ${JSON.stringify(env)});
await import(${JSON.stringify(pathToFileURL(script).href)});
`, { mode: 0o755 });
  return file;
}

async function setup(runtime: RuntimeCase) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-draft-runtime-')));
  const gate = path.join(root, 'gate');
  await fs.mkdir(gate);
  const adapter = runtime.adapter(await launcher(root, fixture(runtime.fixture), runtime.env(gate)), root);
  const accepted: AgentMessagePublishPlainPayload[] = [];
  const sent: Envelope[] = [];
  real = await startRealServer({ productId, storage: { kind: 'memory' }, longPollHoldMs: 30,
    agentMessage: { consume: async ({ payload }) => { accepted.push(payload); return { outcome: 'accepted' }; } },
  });
  const server = real;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${server.url}/byok/messages`) && typeof init?.body === 'string') {
      sent.push(...(JSON.parse(init.body) as { messages: Envelope[] }).messages);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-draft-test' },
    productName: 'Draft runtime test', productId, serverUrl: server.url,
    storeDir: path.join(root, 'store'),
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  const { deviceId } = await daemon.pair((await server.createPairingCode()).code);
  await daemon.start();
  await waitForDaemonOpen(daemon);
  await server.byok.executions.submit({ taskId, deviceId, payload: {
    instruction: 'Write a reply.', agentRef, session: { mode: 'fresh' }, egressPolicy: policy, ...taskRuntimeTarget(adapter.descriptor),
    messageEgress: { mode: 'required', contract: 'draft.v1', contentType: 'text/plain', maxBytes: 4096 },
    terminalProjection: { mode: 'none' },
  }, agentMessageContext: { destinationBinding: 'chat' } });
  readerAbort = new AbortController();
  const events: AgentMessageDraftEvent[] = [];
  const done = (async () => {
    for await (const event of server.byok.tasks.messageDraft(taskId, deviceId, agentRef, { signal: readerAbort!.signal })) events.push(event);
  })();
  return { server, accepted, sent, events, done, release: () => fs.writeFile(path.join(gate, 'release'), '') };
}

describe('Agent message drafts from each bundled runtime through the real server and daemon', () => {
  // Grok and Hermes declare darwin and linux only.
  it.skipIf(!posix).each(['grok', 'hermes'] as const)('%s shows the reply mid-turn and ends on the accepted text', id => runtimeCase(id), 40_000);
  it.each(['claude', 'codex'] as const)('%s shows the reply mid-turn and ends on the accepted text', id => runtimeCase(id), 40_000);
});

async function runtimeCase(id: keyof typeof cases): Promise<void> {
  const f = await setup(cases[id]);
  const appends = () => f.events.filter((e): e is Extract<AgentMessageDraftEvent, { kind: 'append' }> => e.kind === 'append' && e.text !== '');
  const revisionText = (revision: number) => appends().filter(e => e.revision === revision).map(e => e.text).join('');
  // Held before the whole message: the reply text so far can only come from streamed text.
  await vi.waitFor(() => expect(revisionText(appends().at(-1)?.revision ?? 0)).toMatch(cases[id].held), { timeout: 15_000 });
  const midReply = appends().at(-1)!;
  expect(f.accepted).toEqual([]);
  await f.release();
  await f.done;
  await vi.waitFor(async () => {
    expect(await f.server.byok.tasks.deviceTerminal(taskId)).toMatchObject({ envelope: { type: 'task.complete' } });
  }, { timeout: 15_000 });
  expect(f.accepted).toHaveLength(1);
  const body = f.accepted[0]!.body;
  expect(body).toBe(body.trim());
  const last = appends().at(-1)!.revision;
  expect(revisionText(last)).toBe(body);
  // The reply has no surrounding whitespace, so the streamed text already matched it: no reconciling revision.
  expect(last).toBe(midReply.revision);
  expect(f.events.at(-1)).toEqual({ kind: 'ended' });
  expect(JSON.stringify(f.events)).not.toContain('STALE');
  const drafts = f.sent.filter(e => e.type === 'agent.message.draft');
  expect(f.sent.findIndex(e => e.type === 'agent.message.publish')).toBeGreaterThan(f.sent.lastIndexOf(drafts.at(-1)!));
}

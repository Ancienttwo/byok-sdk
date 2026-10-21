import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { AgentMessageOutbox } from '../daemon/agent-message-outbox';
import { InMemoryDeviceCredentialStore } from './fixtures/credential-backend';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServer, type RealServerHandle } from './fixtures/real-server';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';
import { testScratchRoot } from './fixtures/execution-scratch';

let root: string | undefined;
let child: ChildProcess | undefined;
let daemon: Daemon | undefined;
let server: RealServerHandle | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await daemon?.stop(); await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('recovers missing-result truth after SIGKILL following accepted reply but before terminal persistence', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-result-reply-kill-'));
  const bundle = path.join(root, 'daemon.mjs');
  execFileSync('bun', ['build', fileURLToPath(new URL('./fixtures/result-reply-kill-daemon.ts', import.meta.url)), '--target=node', '--outfile', bundle], { stdio: 'pipe' });
  const consumed: string[] = [];
  server = await startRealServer({ productId: 'result-reply-kill', storage: { kind: 'memory' }, longPollHoldMs: 30,
    agentMessage: { consume: async ({ payload }) => { consumed.push(payload.body); return { outcome: 'accepted' }; } },
  });
  const config = { productId: 'result-reply-kill', productName: 'Fake recovery test', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: server.url, storeDir: path.join(root, 'store'), workspaceRoot: path.join(root, 'workspace'),
    storage: { scratchRoot: testScratchRoot() }, agentHome: { hostStorageRoot: path.join(root, 'homes') },
    agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY }, hostedJournal: { mode: 'sqlite' as const } };
  const credentials = new InMemoryDeviceCredentialStore();
  const pairing = createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { deviceCredentials: credentials });
  const { deviceId } = await pairing.pair((await server.createPairingCode()).code);
  const checkpoint = path.join(root, 'checkpoint');
  const input = path.join(root, 'input.json');
  await fs.writeFile(input, JSON.stringify({ config, credentials: await credentials.read(), checkpoint,
    clientEntry: new URL('../../dist/index.js', import.meta.url).href }), { mode: 0o600 });
  child = spawn(process.execPath, [bundle, input], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout!.on('data', data => { stdout += String(data); });
  child.stderr!.on('data', data => { stderr += String(data); });
  await vi.waitFor(() => { expect(child!.exitCode, stderr).toBeNull(); expect(stdout).toContain('ready'); }, { timeout: 10_000 });
  const taskId = 'reply-accepted-then-killed';
  const agentRef = { agentId: 'reply-agent', profileRevision: '1' };
  await server.byok.executions.submit({ taskId, deviceId, payload: { runtime: 'pi', instruction: 'Reply without a result.', agentRef,
    egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    messageEgress: { mode: 'required', contract: 'reply.v1', contentType: 'text/plain', maxBytes: 1024 },
    terminalProjection: { mode: 'result-document', contract: 'result.v1', schema: { type: 'object' } },
  }, agentMessageContext: { destinationBinding: 'chat' } });
  await vi.waitFor(() => expect(child!.signalCode, stderr).toBe('SIGKILL'), { timeout: 10_000 });
  expect(await fs.readFile(checkpoint, 'utf8')).toBe('accepted-before-terminal');
  expect(consumed).toEqual(['Crash-safe required reply.']);
  expect(await server.byok.tasks.agentMessage(taskId, deviceId, agentRef)).toMatchObject({ disposition: { outcome: 'accepted' } });
  expect(await server.byok.tasks.deviceTerminal(taskId)).toBeUndefined();
  const outbox = await AgentMessageOutbox.open(path.join(config.agentHome.hostStorageRoot, 'agents', agentRef.agentId));
  expect(outbox.get(taskId)).toBeUndefined(); // accepted disposition already deleted the draft
  const journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir });
  expect((await journal.listRecoverable()).find(row => row.taskId === taskId)?.localState).toBe('required-reply-result-missing');
  await journal.close();
  const adapter = new StubRuntimeAdapter();
  daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials: credentials });
  await daemon.start(); await waitForDaemonOpen(daemon);
  await vi.waitFor(async () => expect(await server!.byok.tasks.deviceTerminal(taskId)).toMatchObject({ envelope: {
    type: 'task.fail', payload: { reason: expect.stringMatching(/^result_not_submitted:/), retryable: false },
  } }), { timeout: 10_000 });
  const terminal = await server.byok.tasks.deviceTerminal(taskId);
  expect(terminal!.envelope.payload).not.toHaveProperty('document');
  expect(adapter.sessions).toHaveLength(0);
  await daemon.stop();
  daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { deviceCredentials: credentials });
  await daemon.start(); await waitForDaemonOpen(daemon);
  expect(consumed).toEqual(['Crash-safe required reply.']);
  expect(await server.byok.tasks.deviceTerminal(taskId)).toEqual(terminal);
}, 30_000);

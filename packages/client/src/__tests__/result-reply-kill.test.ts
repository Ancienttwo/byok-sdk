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

it.skipIf(process.platform === 'win32').each([
  { checkpointMode: 'accepted-before-terminal', outcome: 'accepted' },
  { checkpointMode: 'marker-before-draft-activation', outcome: 'accepted' },
  { checkpointMode: 'marker-before-draft-activation', outcome: 'held' },
  { checkpointMode: 'marker-before-draft-activation', outcome: 'refused' },
] as const)('recovers required reply after SIGKILL at $checkpointMode with $outcome disposition', async ({ checkpointMode, outcome }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-result-reply-kill-'));
  const bundle = path.join(root, 'daemon.mjs');
  execFileSync('bun', ['build', fileURLToPath(new URL('./fixtures/result-reply-kill-daemon.ts', import.meta.url)), '--target=node', '--outfile', bundle], { stdio: 'pipe' });
  const consumed: string[] = [];
  const terminalPresentAtConsumption: boolean[] = [];
  server = await startRealServer({ productId: 'result-reply-kill', storage: { kind: 'memory' }, longPollHoldMs: 30,
    agentMessage: { consume: async ({ payload }) => {
      terminalPresentAtConsumption.push((await server!.byok.tasks.deviceTerminal('reply-accepted-then-killed')) !== undefined);
      consumed.push(payload.body);
      return { outcome, ...(outcome === 'accepted' ? {} : { reasonCode: outcome === 'held' ? 'freshness_pending' : 'stale_product_context' }) };
    } },
  });
  const config = { productId: 'result-reply-kill', productName: 'Fake recovery test', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: server.url, storeDir: path.join(root, 'store'),
    storage: { scratchRoot: testScratchRoot() }, agentHome: { hostStorageRoot: path.join(root, 'homes') },
    agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } };
  const credentials = new InMemoryDeviceCredentialStore();
  const pairing = createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { deviceCredentials: credentials });
  const { deviceId } = await pairing.pair((await server.createPairingCode()).code);
  const checkpoint = path.join(root, 'checkpoint');
  const input = path.join(root, 'input.json');
  await fs.writeFile(input, JSON.stringify({ config, credentials: await credentials.read(), checkpoint, checkpointMode,
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
  expect(await fs.readFile(checkpoint, 'utf8')).toBe(checkpointMode);
  if (checkpointMode === 'accepted-before-terminal') {
    expect(consumed).toEqual(['Crash-safe required reply.']);
    expect(await server.byok.tasks.agentMessage(taskId, deviceId, agentRef)).toMatchObject({ disposition: { outcome: 'accepted' } });
  } else {
    expect(consumed).toEqual([]);
    expect(await server.byok.tasks.agentMessage(taskId, deviceId, agentRef)).toBeUndefined();
  }
  expect(await server.byok.tasks.deviceTerminal(taskId)).toBeUndefined();
  const outbox = await AgentMessageOutbox.open(path.join(config.agentHome.hostStorageRoot, 'agents', agentRef.agentId));
  if (checkpointMode === 'accepted-before-terminal') expect(outbox.get(taskId)).toBeUndefined();
  else {
    expect(outbox.get(taskId)).toMatchObject({ body: 'Crash-safe required reply.', recoverySessionRef: expect.any(String) });
    expect(outbox.get(taskId)).not.toHaveProperty('sessionRef'); // durable but inert until recovery validates the marker
  }
  const journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir });
  expect((await journal.listRecoverable()).find(row => row.taskId === taskId)?.localState).toBe(checkpointMode === 'accepted-before-terminal' ? 'required-reply-result-missing-accepted' : 'required-reply-result-missing');
  await journal.close();
  const adapter = new StubRuntimeAdapter();
  daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials: credentials });
  await daemon.start(); await waitForDaemonOpen(daemon);
  await vi.waitFor(async () => expect(await server!.byok.tasks.agentMessage(taskId, deviceId, agentRef)).toMatchObject({ disposition: { outcome } }), { timeout: 10_000 });
  expect(consumed).toEqual(['Crash-safe required reply.']);
  expect(terminalPresentAtConsumption).toEqual([false]);
  if (outcome === 'held') {
    expect(await server.byok.tasks.deviceTerminal(taskId)).toBeUndefined();
    expect(adapter.sessions).toHaveLength(0);
    await daemon.stop();
    const restartedAdapter = new StubRuntimeAdapter();
    daemon = createDaemonWithAdapters(config, [restartedAdapter], { deviceCredentials: credentials });
    await daemon.start(); await waitForDaemonOpen(daemon);
    expect(await server.byok.tasks.agentMessage(taskId, deviceId, agentRef)).toMatchObject({ disposition: { outcome: 'held' } });
    expect(await server.byok.tasks.deviceTerminal(taskId)).toBeUndefined();
    expect(restartedAdapter.sessions).toHaveLength(0);
    await daemon.stop();
    const recoveredJournal = new SqliteLocalTaskJournal({ storeDir: config.storeDir });
    expect((await recoveredJournal.listRecoverable()).find(row => row.taskId === taskId)?.localState).toBe('required-reply-result-missing');
    await recoveredJournal.close();
    // A recovered held reply has no active runtime task, but cancellation must
    // still settle the durable recovery lane and revoke its replayable draft.
    const cancelAdapter = new StubRuntimeAdapter();
    daemon = createDaemonWithAdapters(config, [cancelAdapter], { deviceCredentials: credentials });
    await daemon.start(); await waitForDaemonOpen(daemon);
    const consumedBeforeCancel = [...consumed];
    await server.byok.tasks.cancel(taskId, 'cancel recovered held reply');
    await vi.waitFor(async () => expect(await server!.byok.tasks.deviceTerminal(taskId)).toMatchObject({
      envelope: { type: 'task.cancelled' },
    }), { timeout: 10_000 });
    const cancelledTerminal = await server.byok.tasks.deviceTerminal(taskId);
    expect(cancelAdapter.sessions).toHaveLength(0);
    await daemon.stop();
    const cancelledOutbox = await AgentMessageOutbox.open(path.join(config.agentHome.hostStorageRoot, 'agents', agentRef.agentId));
    expect(cancelledOutbox.terminalRecords().map(record => record.taskId)).toContain(taskId);
    expect(cancelledOutbox.retryableRecords()).toEqual([]);
    const afterCancelAdapter = new StubRuntimeAdapter();
    daemon = createDaemonWithAdapters(config, [afterCancelAdapter], { deviceCredentials: credentials });
    await daemon.start(); await waitForDaemonOpen(daemon);
    expect(consumed).toEqual(consumedBeforeCancel);
    expect(afterCancelAdapter.sessions).toHaveLength(0);
    expect(await server.byok.tasks.deviceTerminal(taskId)).toEqual(cancelledTerminal);
    const reopenedCancelledOutbox = await AgentMessageOutbox.open(path.join(config.agentHome.hostStorageRoot, 'agents', agentRef.agentId));
    expect(reopenedCancelledOutbox.terminalRecords().map(record => record.taskId)).toContain(taskId);
    expect(reopenedCancelledOutbox.retryableRecords()).toEqual([]);
    return;
  }
  await vi.waitFor(async () => expect(await server!.byok.tasks.deviceTerminal(taskId)).toMatchObject({ envelope: {
    type: 'task.fail', payload: { reason: outcome === 'refused' ? expect.stringContaining('required Agent message was refused') : expect.stringMatching(/^result_not_submitted:/), retryable: false },
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

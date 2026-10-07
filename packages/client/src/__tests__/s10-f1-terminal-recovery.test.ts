import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentMessageOutbox } from '../daemon/agent-message-outbox';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import * as mutationGate from '../daemon/path-mutation-gate';
import * as launchCwd from '../daemon/trusted-launch-cwd';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const roots: string[] = [];
const heldGates = new Set<string>();
const acquireNativeGate = mutationGate.acquirePathMutationGate;
beforeEach(() => {
  // The sandbox cannot bind the native Unix mutation-gate socket. Keep the
  // real home/lease/filesystem implementation and inject only this test port.
  vi.spyOn(mutationGate, 'acquirePathMutationGate').mockImplementation(async input => {
    const targetPath = await mutationGate.resolvePathWithoutCreate(input.targetPath);
    const identity = `${input.scope}:${targetPath}`;
    if (heldGates.has(identity)) throw new mutationGate.PathMutationGateBusyError(input.scope, targetPath);
    heldGates.add(identity);
    let released = false;
    return { scope: input.scope, targetPath, identity, async release() {
      if (released) return;
      released = true; heldGates.delete(identity);
    } };
  });
});
afterEach(async () => {
  expect(heldGates.size).toBe(0);
  vi.restoreAllMocks();
  expect(mutationGate.acquirePathMutationGate).toBe(acquireNativeGate);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function cancellationFixture(overrides: Partial<TaskRunnerDeps> = {}) {
    const sent: Envelope[] = [];
    const storeDir = await temporary('byok-publish-cancel-store-');
    const hostStorageRoot = await temporary('byok-publish-cancel-home-');
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
    });
    const deps: TaskRunnerDeps = {
      adapters: [adapter], workspaceRoot: await temporary('byok-publish-cancel-workspace-'),
      agentHome: new AgentHomeManager({ hostStorageRoot }), agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-cancel',
      send: envelope => sent.push(envelope),
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir), approvalRegistry: new ApprovalRegistry(),
      storeDir, productId: 'cancel-test', tenantId: 'tenant-cancel',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: async () => {},
      ...overrides,
    };
    return { runner: new TaskRunner(deps), adapter, sent, deps };
}


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const AGENT = { agentId: 'active-revoke-agent', profileRevision: '1' };
const TASK = 'active-revoke-task';

async function activeFixture(unsent: boolean, overrides: Partial<TaskRunnerDeps> = {}) {
  const h = await cancellationFixture(overrides);
  // This fixture never spawns MCP/runtime processes. Only its admission-time
  // launch-directory dependency is injected; restore it before settlement.
  const originalResolver = launchCwd.resolveTrustedLaunchCwd;
  const launch = vi.spyOn(launchCwd, 'resolveTrustedLaunchCwd').mockResolvedValue({ kind: 'resolved', dir: await temporary('byok-inert-launch-') });
  try { await h.runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
    instruction: 'reply', runtime: 'pi', agentRef: AGENT,
    egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
  }, { taskId: TASK, seq: 1 })); } finally { launch.mockRestore(); }
  expect(launchCwd.resolveTrustedLaunchCwd).toBe(originalResolver);
  expect(h.runner.activeTaskCount, JSON.stringify(h.sent)).toBe(1);
  expect(h.sent.filter(e => e.type === 'task.started')).toHaveLength(1);
  const ctx = h.adapter.startCalls[0]!.ctx;
  const token = ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!;
  const entered = deferred(); const gate = deferred();
  const activate = AgentMessageOutbox.prototype.activate;
  const activation = unsent ? vi.spyOn(AgentMessageOutbox.prototype, 'activate').mockImplementationOnce(async function (this: AgentMessageOutbox, ...args) {
    entered.resolve(); await gate.promise; return activate.apply(this, args);
  }) : undefined;
  const publishing = h.runner.publishAgentMessage({ contextToken: token, contentType: 'text/markdown', body: 'selected message' })
    .then(value => ({ value }), error => ({ error }));
  if (unsent) await entered.promise;
  else expect(await publishing).toMatchObject({ value: { state: 'pending' } });
  return { ...h, ctx, token, publishing, release: () => { gate.resolve(); activation?.mockRestore(); } };
}

function cancel(runner: TaskRunner, reason = 'first cancellation') {
  return runner.handleEnvelope(createEnvelope('task.cancel', { reason }, { taskId: TASK, seq: 2 }));
}
function reject(runner: TaskRunner) {
  return runner.handleEnvelope(createEnvelope('task.reject', { reason: 'first rejection' }, { taskId: TASK, seq: 3 }));
}
function terminals(sent: Envelope[]) {
  return sent.filter(e => ['task.cancelled', 'task.fail', 'task.complete'].includes(e.type));
}
async function assertReleased(h: Awaited<ReturnType<typeof activeFixture>>, expected: 'cancelled' | 'failed') {
  expect(h.runner.activeTaskCount).toBe(0);
  expect(h.adapter.sessions[0]!.closeCalled).toBe(true);
  expect(terminals(h.sent)).toHaveLength(1);
  expect(terminals(h.sent)[0]).toMatchObject({ type: expected === 'cancelled' ? 'task.cancelled' : 'task.fail',
    payload: { reason: expected === 'cancelled' ? 'first cancellation' : 'first rejection' } });
  expect((await AgentMessageOutbox.open(h.ctx.workspaceDir)).retryableRecords()).toHaveLength(0);
  const binding = await h.deps.agentHome!.acquire(AGENT);
  await binding.lease.release();
  await h.runner.shutdownActiveTasks('idempotent shutdown');
  await h.runner.shutdownActiveTasks('idempotent shutdown again');
}

describe('S10-F1 active terminal revocation recovery', () => {
  it.each([
    ['cancelled', 'cancel'], ['cancelled', 'shutdown'],
    ['failed', 'cancel'], ['failed', 'shutdown'],
    ['cancelled', 'finalization'], ['failed', 'finalization'],
  ] as const)('retries the selected %s terminal through %s after revoke failure', async (cause, retry) => {
    const h = await activeFixture(cause === 'failed');
    const originalRevoke = AgentMessageOutbox.prototype.revoke;
    const revoke = vi.spyOn(AgentMessageOutbox.prototype, 'revoke').mockRejectedValueOnce(new Error('transient revoke failure'));
    try {
      await expect(cause === 'cancelled' ? cancel(h.runner) : reject(h.runner)).rejects.toThrow('transient revoke failure');
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(terminals(h.sent)).toHaveLength(0);
      expect(h.runner.activeTaskCount, JSON.stringify(h.sent)).toBe(1);
      await expect(h.deps.agentHome!.acquire(AGENT)).rejects.toThrow();
      await expect(h.runner.publishAgentMessage({ contextToken: h.token, contentType: 'text/markdown', body: 'late' })).rejects.toThrow();
      const published = h.sent.filter(e => e.type === 'agent.message.publish').length;
      revoke.mockImplementation(originalRevoke);
      if (retry === 'cancel') await cancel(h.runner, 'competing retry must not replace reason');
      else if (retry === 'shutdown') await h.runner.shutdownActiveTasks('competing shutdown must not replace reason');
      else await h.runner.retryTerminalFinalization(TASK);
      expect(revoke.mock.calls.length).toBeGreaterThanOrEqual(2);
      h.release(); await h.publishing;
      expect(h.sent.filter(e => e.type === 'agent.message.publish')).toHaveLength(published);
      await assertReleased(h, cause);
      const recovered = new TaskRunner(h.deps);
      await recovered.recoverAgentMessageOutboxes(path.dirname(h.ctx.workspaceDir));
      recovered.retryRecoveredAgentMessages();
      expect(h.sent.filter(e => e.type === 'agent.message.publish')).toHaveLength(published);
    } finally {
      h.release(); revoke.mockRestore(); await h.publishing;
      await h.runner.shutdownActiveTasks('fixture cleanup').catch(() => {});
      h.runner.stopAcceptingOffers();
    }
  });
});

it.each(['cancelled', 'failed'] as const)('S10-F1 shares one failed and one recovered %s attempt across concurrent controls', async cause => {
  const h = await activeFixture(cause === 'failed');
  const first = deferred(); const retry = deferred(); const entered = deferred(); const retried = deferred();
  const original = AgentMessageOutbox.prototype.revoke;
  const revoke = vi.spyOn(AgentMessageOutbox.prototype, 'revoke')
    .mockImplementationOnce(async () => { entered.resolve(); await first.promise; throw new Error('first revoke failed'); })
    .mockImplementationOnce(async function (this: AgentMessageOutbox, taskId) { retried.resolve(); await retry.promise; return original.call(this, taskId); });
  try {
    const selected = cause === 'cancelled' ? cancel(h.runner) : reject(h.runner);
    await entered.promise;
    const waiting = Promise.allSettled([selected, cancel(h.runner, 'competing cancel'), h.runner.shutdownActiveTasks('competing shutdown')]);
    first.resolve();
    expect((await waiting).map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(terminals(h.sent)).toHaveLength(0);
    expect(h.runner.activeTaskCount).toBe(1);
    const recovery = cancel(h.runner, 'retry cancel');
    await retried.promise;
    let settled = false;
    const recovered = Promise.all([recovery, h.runner.shutdownActiveTasks('retry shutdown'), h.runner.retryTerminalFinalization(TASK)])
      .then(() => { settled = true; });
    await new Promise<void>(done => setImmediate(done));
    expect(settled).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(terminals(h.sent)).toHaveLength(0);
    await expect(h.deps.agentHome!.acquire(AGENT)).rejects.toThrow();
    retry.resolve(); await recovered;
    h.release(); await h.publishing;
    await assertReleased(h, cause);
  } finally {
    first.resolve(); retry.resolve(); h.release(); revoke.mockRestore(); await h.publishing;
    await h.runner.shutdownActiveTasks('cleanup').catch(() => {}); h.runner.stopAcceptingOffers();
  }
});

it('S10-F1 retries a runtime-selected failure without replacing its reason or retryability', async () => {
  const h = await activeFixture(true);
  const revoke = vi.spyOn(AgentMessageOutbox.prototype, 'revoke').mockRejectedValueOnce(new Error('runtime revoke failed'));
  const pump = (h.runner as unknown as { tasks: Map<string, { eventPump: Promise<void> }> }).tasks.get(TASK)!.eventPump;
  const outcome = pump.then(() => undefined, error => error);
  try {
    h.adapter.sessions[0]!.fail(new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure', retry: 'retryable', reason: 'original runtime failure' }));
    expect(await outcome).toMatchObject({ message: 'runtime revoke failed' });
    expect(terminals(h.sent)).toHaveLength(0);
    await cancel(h.runner, 'later cancellation');
    h.release(); await h.publishing;
    expect(terminals(h.sent)).toHaveLength(1);
    expect(terminals(h.sent)[0]).toMatchObject({ type: 'task.fail', payload: { reason: 'original runtime failure', retryable: true } });
    expect(h.runner.activeTaskCount).toBe(0);
    const binding = await h.deps.agentHome!.acquire(AGENT); await binding.lease.release();
  } finally { h.release(); revoke.mockRestore(); await h.publishing; await h.runner.shutdownActiveTasks('cleanup').catch(() => {}); h.runner.stopAcceptingOffers(); }
});

it('S10-F1 retains exact terminal bytes through a synchronous sender failure', async () => {
  const h = await activeFixture(false);
  const send = h.deps.send;
  const attempts: Envelope[] = [];
  vi.spyOn(h.deps, 'send').mockImplementation(envelope => {
    if (envelope.type === 'task.cancelled') {
      attempts.push(structuredClone(envelope));
      if (attempts.length === 1) throw new Error('sender temporarily failed');
    }
    send(envelope);
  });
  try {
    await expect(cancel(h.runner)).rejects.toThrow('sender temporarily failed');
    expect(h.runner.activeTaskCount).toBe(1);
    await h.runner.shutdownActiveTasks('different terminal decision');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await assertReleased(h, 'cancelled');
  } finally { h.release(); await h.runner.shutdownActiveTasks('cleanup').catch(() => {}); h.runner.stopAcceptingOffers(); }
});

it('S10-F1 retains home ownership through recovered revoke, close and terminal commit barriers', async () => {
  const committed = deferred(); const committing = deferred();
  const h = await activeFixture(false, { awaitTerminalCommit: async () => { committing.resolve(); await committed.promise; } });
  const releaseClose = h.adapter.sessions[0]!.blockClose();
  const revoke = vi.spyOn(AgentMessageOutbox.prototype, 'revoke').mockRejectedValueOnce(new Error('revoke failed'));
  try {
    await expect(cancel(h.runner)).rejects.toThrow('revoke failed');
    const recovering = h.runner.shutdownActiveTasks('retry');
    await vi.waitFor(() => expect(terminals(h.sent)).toHaveLength(1));
    expect(h.runner.activeTaskCount).toBe(1);
    await expect(h.deps.agentHome!.acquire(AGENT)).rejects.toThrow();
    releaseClose(); await committing.promise;
    expect(h.runner.activeTaskCount).toBe(1);
    await expect(h.deps.agentHome!.acquire(AGENT)).rejects.toThrow();
    committed.resolve(); await recovering;
    expect(revoke).toHaveBeenCalledTimes(2);
    await assertReleased(h, 'cancelled');
  } finally { releaseClose(); committed.resolve(); h.release(); revoke.mockRestore(); await h.runner.shutdownActiveTasks('cleanup').catch(() => {}); h.runner.stopAcceptingOffers(); }
});

it('S10-F1 retries terminal commitment without republishing or repeating durable revocation', async () => {
  const commit = vi.fn().mockRejectedValueOnce(new Error('journal failure')).mockResolvedValue(undefined);
  const h = await activeFixture(false, { awaitTerminalCommit: commit });
  const revoke = vi.spyOn(AgentMessageOutbox.prototype, 'revoke');
  try {
    await cancel(h.runner);
    expect(h.runner.activeTaskCount).toBe(1);
    expect(terminals(h.sent)).toHaveLength(1);
    await expect(h.deps.agentHome!.acquire(AGENT)).rejects.toThrow();
    await h.runner.shutdownActiveTasks('retry journal');
    expect(commit).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(1);
    await assertReleased(h, 'cancelled');
  } finally { h.release(); revoke.mockRestore(); await h.runner.shutdownActiveTasks('cleanup').catch(() => {}); h.runner.stopAcceptingOffers(); }
});

it('S10-F1 keeps actual uncertain outbox I/O quarantined without terminal or home release', async () => {
  const h = await activeFixture(false);
  const file = path.join(h.ctx.workspaceDir, '.byok', 'messages', 'outbox-v1.jsonl');
  const open = fs.open.bind(fs);
  let inject = true;
  const io = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (inject && String(args[0]) === file) { inject = false; throw new Error('injected filesystem failure'); }
    return open(...args);
  });
  const originalRevoke = AgentMessageOutbox.prototype.revoke;
  const revoke = vi.spyOn(AgentMessageOutbox.prototype, 'revoke');
  try {
    await expect(cancel(h.runner)).rejects.toThrow('injected filesystem failure');
    io.mockRestore();
    await expect(cancel(h.runner)).rejects.toThrow('quarantined');
    await expect(h.runner.shutdownActiveTasks('still quarantined')).rejects.toThrow('quarantined');
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(terminals(h.sent)).toHaveLength(0);
    expect(h.runner.activeTaskCount).toBe(1);
    await expect(h.deps.agentHome!.acquire(AGENT)).rejects.toThrow();
  } finally {
    // Test cleanup supplies an explicitly reopened, validated outbox only to
    // this fixture's revoke port. Product code never clears uncertain I/O.
    io.mockRestore();
    const validated = await AgentMessageOutbox.open(h.ctx.workspaceDir);
    revoke.mockImplementation(taskId => originalRevoke.call(validated, taskId));
    h.release(); await h.runner.shutdownActiveTasks('fixture validated cleanup'); h.runner.stopAcceptingOffers();
  }
});

it('S10-F1 preserves cancellation selected during the durable startup handoff', async () => {
  const h = await cancellationFixture(); const recorded = deferred(); const gate = deferred();
  const record = h.deps.agentSessionHandoffs!.record.bind(h.deps.agentSessionHandoffs);
  vi.spyOn(h.deps.agentSessionHandoffs!, 'record').mockImplementationOnce(async (...args) => {
    const result = await record(...args); recorded.resolve(); await gate.promise; return result;
  });
  const offering = h.runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
    instruction: 'no message contract', runtime: 'pi', agentRef: AGENT,
    egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
  }, { taskId: TASK, seq: 1 }));
  try {
    await recorded.promise;
    await cancel(h.runner);
    gate.resolve(); await offering;
    expect(h.sent.filter(e => e.type === 'task.started')).toHaveLength(0);
    expect(terminals(h.sent)).toHaveLength(1);
    expect(terminals(h.sent)[0]).toMatchObject({ type: 'task.cancelled', payload: { reason: 'first cancellation' } });
    expect(h.runner.activeTaskCount).toBe(0);
    expect(h.adapter.sessions[0]!.closeCalled).toBe(true);
    const binding = await h.deps.agentHome!.acquire(AGENT); await binding.lease.release();
  } finally { gate.resolve(); await offering; await h.runner.shutdownActiveTasks('cleanup').catch(() => {}); h.runner.stopAcceptingOffers(); }
});

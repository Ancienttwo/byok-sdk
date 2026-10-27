import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MEMORY_PROJECTION_CAPABILITY, createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeBusyError, AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import { ApprovalRegistry } from '../daemon/approvals';
import { AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS, TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { RuntimeDisposalFailure } from '../runtime-failure';
import { builtAgentMemoryFilesystemHelperBin } from './fixtures/agent-memory-helper-build';
import { testIngressBudget } from './fixtures/activity-ingress';
import { testScratchOwner } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const AGENT = { agentId: 'cancel-durability-agent', profileRevision: '1' };
const TASK = 'cancel-durability-task';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(overrides: Partial<TaskRunnerDeps> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-cancel-durability-'));
  roots.push(root);
  const agentHome = new AgentHomeManager({ hostStorageRoot: path.join(root, 'homes') });
  const acquire = agentHome.leaseManager.acquire.bind(agentHome.leaseManager);
  // Observe the real base lease. Keep the native mutation gate and all disk I/O.
  const releases: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(agentHome.leaseManager, 'acquire').mockImplementation(async (...args) => {
    const lease = await acquire(...args);
    releases.push(vi.spyOn(lease, 'release'));
    return lease;
  });
  const handoffs = new AgentSessionHandoffStore();
  const adapter = new StubRuntimeAdapter('pi');
  const sent: Envelope[] = [];
  const terminalSent = deferred();
  const committing = deferred();
  const committed = deferred();
  const awaitTerminalCommit = vi.fn(async () => { committing.resolve(); await committed.promise; });
  const runner = new TaskRunner({
    getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    agentHome, agentSessionHandoffs: handoffs, deviceId: 'cancel-device',
    send: envelope => {
      sent.push(envelope);
      if (['task.complete', 'task.fail', 'task.cancelled'].includes(envelope.type)) terminalSent.resolve();
    },
    blobClient: { resolveInstruction: async () => { throw new Error('unused'); }, uploadArtifact: async () => { throw new Error('unused'); } },
    approvalRegistry: new ApprovalRegistry(),
    storeDir: root, productId: 'cancel-product', tenantId: 'cancel-tenant',
    awaitTerminalCommit, ...overrides,
  });
  await runner.handleEnvelope(createEnvelope('task.offer_for_agent', {
    instruction: 'wait for cancellation', runtime: 'pi', agentRef: AGENT,
  }, { taskId: TASK, seq: 1 }));
  expect(sent.filter(event => event.type === 'task.started')).toHaveLength(1);
  expect(releases).toHaveLength(1);
  const session = adapter.sessions[0]!;
  const close = vi.spyOn(session, 'close');
  const terminals = () => sent.filter(event => ['task.complete', 'task.fail', 'task.cancelled'].includes(event.type));
  const cancel = (reason = 'first cancel') => runner.handleEnvelope(createEnvelope('task.cancel', { reason }, { taskId: TASK, seq: 2 }));
  const held = async () => {
    expect(runner.activeTaskCount).toBe(1);
    expect(releases[0]).not.toHaveBeenCalled();
    await expect(agentHome.acquire(AGENT)).rejects.toBeInstanceOf(AgentHomeBusyError);
  };
  const released = async () => {
    expect(runner.activeTaskCount).toBe(0);
    expect(terminals()).toEqual([expect.objectContaining({ type: 'task.cancelled', payload: expect.objectContaining({ reason: 'first cancel' }) })]);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    const next = await agentHome.acquire(AGENT);
    await next.lease.release();
  };
  const cleanup = async () => {
    committed.resolve();
    await runner.shutdownActiveTasks('cleanup');
    runner.stopAcceptingOffers();
  };
  return { runner, agentHome, handoffs, session, close, terminals, terminalSent, cancel, held, released, cleanup, committing, committed, awaitTerminalCommit, releases };
}

describe('Octop F1 cancel write failures (#554, plan gaps 1a-1d)', () => {
  it('1a: retains ownership after close failure until close retry and terminal commit succeed', async () => {
    const failures = vi.fn();
    const h = await fixture({ onRuntimeDisposalFailure: failures });
    h.close.mockRejectedValueOnce(new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'cancel close failed' }));
    try {
      await h.cancel();
      expect(failures).toHaveBeenCalledTimes(1);
      expect(failures).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK, stage: 'cleanup', reason: 'cancel close failed' }));
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(h.terminals().map(event => event.type)).toEqual(['task.cancelled']);
      expect(h.awaitTerminalCommit).not.toHaveBeenCalled();
      await h.held();
      const retry = h.runner.retryTerminalFinalization(TASK);
      await h.committing.promise;
      expect(h.close).toHaveBeenCalledTimes(2);
      await h.held();
      h.committed.resolve();
      await retry;
      expect(failures).toHaveBeenCalledTimes(1);
      await h.released();
    } finally { await h.cleanup(); }
  });

  const helperBin = builtAgentMemoryFilesystemHelperBin();
  // Snapshot needs Linux descriptors or the verified macOS SDK helper. Windows
  // has no admitted backend. A normal JS build has no macOS helper assets.
  it.skipIf(!isAgentMemorySecureFilesystemAvailable(helperBin !== undefined))('1b: logs snapshot failure and releases ownership after cancel', async () => {
    const redacting = deferred();
    const failSnapshot = deferred();
    const redact = vi.fn(async () => { redacting.resolve(); await failSnapshot.promise; throw new Error('cancel snapshot failed'); });
    const publish = vi.fn();
    const log = vi.spyOn(console, 'error');
    const h = await fixture({
      ...(helperBin === undefined ? {} : { resolveAgentMemoryFilesystemHelperBin: () => helperBin }),
      agentMemoryHostedProjection: {
        capability: AGENT_MEMORY_PROJECTION_CAPABILITY,
        grant: { grantRef: 'cancel-grant', writerEpoch: 1, policyRevision: '1' },
        redactor: { redact }, port: { publish },
      },
    });
    try {
      const cancelling = h.cancel();
      await h.committing.promise;
      await h.held();
      h.committed.resolve();
      await redacting.promise;
      await h.held();
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(h.terminals().map(event => event.type)).toEqual(['task.cancelled']);
      failSnapshot.resolve();
      await cancelling;
      expect(redact).toHaveBeenCalledTimes(1);
      expect(publish).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`Agent memory quiescent snapshot failed for ${TASK}: cancel snapshot failed`));
      await h.released();
    } finally { failSnapshot.resolve(); await h.cleanup(); }
  });

  it('1c: bounds permanent terminal evidence failure, reports once and releases ownership', async () => {
    const failures = vi.fn();
    const h = await fixture({ onAgentTerminalEvidenceFailure: failures });
    const evidence = vi.spyOn(h.handoffs, 'recordTerminal').mockRejectedValue(new Error('cancel evidence disk offline'));
    try {
      const cancelling = h.cancel();
      await h.committing.promise;
      expect(evidence).toHaveBeenCalledTimes(AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS);
      expect(failures).not.toHaveBeenCalled();
      await h.held();
      h.committed.resolve();
      await cancelling;
      expect(evidence).toHaveBeenCalledTimes(AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS * 2);
      expect(failures).toHaveBeenCalledTimes(1);
      expect(failures).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK, agentRef: AGENT, cause: 'cancelled', attempts: AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS }));
      await h.released();
    } finally { await h.cleanup(); }
  });

  it('1d: reports a changed lease marker and returns false without a second terminal', async () => {
    const log = vi.spyOn(console, 'error');
    const h = await fixture();
    // Observe the actual finishOnce result; handleEnvelope intentionally returns void.
    const finish = vi.spyOn(h.runner as unknown as { finishOnce(taskId: string): Promise<boolean> }, 'finishOnce');
    const { canonicalHome } = await h.agentHome.layout.resolve(AGENT);
    const marker = path.join(canonicalHome, '.byok', 'agent-home.lease');
    try {
      const cancelling = h.cancel();
      await h.committing.promise;
      await h.held();
      await fs.writeFile(marker, JSON.stringify({ version: 1, ownerId: 'other-owner', leaseId: 'other-lease', agentRef: AGENT, canonicalHome }));
      h.committed.resolve();
      await cancelling;
      expect(finish).toHaveBeenCalledTimes(1);
      await expect(finish.mock.results[0]!.value).resolves.toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`Agent home lease could not be released for ${TASK}:`));
      expect(h.releases[0]).toHaveBeenCalledTimes(1);
      expect(h.runner.activeTaskCount).toBe(0);
      expect(h.terminals().map(event => event.type)).toEqual(['task.cancelled']);
      await expect(h.agentHome.acquire(AGENT)).rejects.toBeInstanceOf(AgentHomeBusyError);
      await fs.rm(marker);
      await h.released();
    } finally { await fs.rm(marker, { force: true }); await h.cleanup(); }
  });
});

describe('Octop F2 duplicate cancel (#554, plan gaps 2a-2b)', () => {
  it.each(['close', 'commit'] as const)('shares cancel and shutdown while %s is pending', async stage => {
    const h = await fixture();
    const closing = deferred();
    const releaseClose = h.session.blockClose();
    // A second observer leaves StubSession.close and its existing blockClose gate intact.
    const close = h.session.close.bind(h.session);
    h.session.close = async () => { closing.resolve(); await close(); };
    const controls: Promise<void>[] = [];
    try {
      controls.push(h.cancel());
      await closing.promise;
      await h.terminalSent.promise;
      if (stage === 'commit') { releaseClose(); await h.committing.promise; }
      controls.push(h.cancel('later cancel'), h.runner.shutdownActiveTasks('later shutdown'));
      await h.held();
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(h.terminals().map(event => event.type)).toEqual(['task.cancelled']);
      if (stage === 'close') {
        expect(h.awaitTerminalCommit).not.toHaveBeenCalled();
        releaseClose();
        await h.committing.promise;
        await h.held();
      }
      expect(h.awaitTerminalCommit).toHaveBeenCalledTimes(1);
      h.committed.resolve();
      await Promise.all(controls);
      await h.cancel('after completion');
      await h.runner.shutdownActiveTasks('after completion');
      expect(h.close).toHaveBeenCalledTimes(1);
      await h.released();
    } finally {
      releaseClose(); h.committed.resolve();
      await Promise.all(controls);
      await h.cleanup();
    }
  });
});

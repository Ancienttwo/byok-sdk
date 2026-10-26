import { testScratchOwner } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentMessageOutbox } from '../daemon/agent-message-outbox';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { RuntimeDisposalFailure } from '../runtime-failure';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult } from '../types';
import { StubRuntimeAdapter, StubSession } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

/**
 * Characterization of `TaskRunner.handleOffer` exits that no other test pins
 * by reason. Each case drives one branch through the public `handleEnvelope`
 * path on the unchanged code, and records three facts: the terminal envelope,
 * its reason and `retryable`, and that whatever the offer held at that branch
 * is free afterwards (Agent execution lease, home reservation, Git lease,
 * startup owner, in-flight marker).
 *
 * The phase split (`plans/plan-20261012-handle-offer-phase-split.md`) moves
 * these bodies. A move error in one of these branches must fail here.
 */

const AGENT = { agentId: 'characterized-agent', profileRevision: 'profile-1' } as const;

const roots: string[] = [];
async function temporary(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

const blobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used'); },
  uploadArtifact: async () => { throw new Error('not used'); },
};

function declines(sent: readonly Envelope[], taskId: string): Envelope[] {
  return sent.filter((entry) => entry.type === 'task.decline' && entry.task_id === taskId);
}

function terminals(sent: readonly Envelope[], taskId: string): Envelope[] {
  return sent.filter((entry) => entry.task_id === taskId
    && ['task.complete', 'task.fail', 'task.cancelled'].includes(entry.type));
}

function claimed(sent: readonly Envelope[], taskId: string): number {
  return sent.filter((entry) => entry.type === 'task.claim' && entry.task_id === taskId).length;
}

function agentOffer(taskId: string, seq: number, extra: { sessionRef?: string } = {}): Envelope {
  return createEnvelope('task.offer_for_agent', {
    instruction: 'characterized work', runtime: 'pi', agentRef: AGENT, ...extra,
  }, { taskId, seq });
}

async function agentRunner(
  adapter: StubRuntimeAdapter,
  extra: Partial<TaskRunnerDeps> = {},
): Promise<{ runner: TaskRunner; agentHome: AgentHomeManager; sent: Envelope[]; deps: TaskRunnerDeps }> {
  const storeDir = await temporary('byok-offer-char-store-');
  const agentHome = new AgentHomeManager({ hostStorageRoot: await temporary('byok-offer-char-home-') });
  const sent: Envelope[] = [];
  // Held by reference: the runner re-reads `startupTimeoutMs` per offer.
  const deps: TaskRunnerDeps = { getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    workspaceRoot: await temporary('byok-offer-char-workspace-'),
    agentHome,
    agentSessionHandoffs: new AgentSessionHandoffStore(),
    deviceId: 'device-offer-char',
    send: (envelope) => sent.push(envelope),
    blobClient,
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'offer-characterization',
    ...extra,
  };
  const runner = new TaskRunner(deps);
  return { runner, agentHome, sent, deps };
}

/** Finishes the one admitted Session of a redelivery and waits until nothing is owned. */
async function completeAdmitted(runner: TaskRunner, adapter: StubRuntimeAdapter, sent: Envelope[], taskId: string): Promise<void> {
  adapter.sessions.at(-1)!.emit({ type: 'turn_end' });
  await vi.waitFor(() => expect(terminals(sent, taskId).map((entry) => entry.type)).toEqual(['task.complete']));
  await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
}

/** Returns a Session whose ref differs from the one the offer resumes. */
class DriftingSessionAdapter extends StubRuntimeAdapter {
  driftTo: string | undefined;

  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const base = await super.prepare(input);
    const driftTo = this.driftTo;
    if (base.kind !== 'prepared' || driftTo === undefined) return base;
    return {
      ...base,
      operation: {
        ...base.operation,
        start: async () => {
          const session = new StubSession(driftTo);
          this.sessions.push(session);
          return session;
        },
      },
    };
  }
}

describe('handleOffer exit characterization (before the phase split)', () => {
  it('invalid AgentRef: declines a strict offer before registration and admits a valid redelivery', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, agentHome, sent } = await agentRunner(adapter);
    const taskId = 'invalid-agent-ref';
    const valid = agentOffer(taskId, 1);
    // The wire codec rejects this AgentRef, so the envelope is built past it.
    // handleOffer still validates on its own; this drives that check.
    const invalid = { ...valid, payload: { ...valid.payload, agentRef: { agentId: '..', profileRevision: 'profile-1' } } } as Envelope;

    await runner.handleEnvelope(invalid);

    expect(declines(sent, taskId)).toHaveLength(1);
    const payload = declines(sent, taskId)[0]!.payload as { reason: string; retryable: boolean; agentRef?: unknown };
    expect(payload.reason.startsWith('invalid AgentRef: AgentRef does not match the protocol contract')).toBe(true);
    expect(payload.retryable).toBe(false);
    expect(payload).not.toHaveProperty('agentRef');
    expect(claimed(sent, taskId)).toBe(0);
    expect(adapter.startCalls).toHaveLength(0);
    expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });

    await runner.handleEnvelope(agentOffer(taskId, 2));
    expect(declines(sent, taskId)).toHaveLength(1);
    expect(claimed(sent, taskId)).toBe(1);
    await completeAdmitted(runner, adapter, sent, taskId);
  });

  it('runtime detection failed: declines retryably and gives the Agent home reservation back', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    vi.spyOn(adapter, 'detect').mockRejectedValueOnce(new Error('detect fixture failure'));
    const { runner, agentHome, sent } = await agentRunner(adapter);
    const taskId = 'runtime-detection-failed';

    await runner.handleEnvelope(agentOffer(taskId, 1));

    expect(declines(sent, taskId).map((entry) => entry.payload)).toEqual([{
      reason: 'runtime detection failed: detect fixture failure', retryable: true, agentRef: AGENT,
    }]);
    expect(claimed(sent, taskId)).toBe(0);
    expect(adapter.startCalls).toHaveLength(0);
    expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });

    // A leaked reservation would decline this as `agent home busy`, and a
    // leaked in-flight marker would drop it silently.
    await runner.handleEnvelope(agentOffer(taskId, 2));
    expect(declines(sent, taskId)).toHaveLength(1);
    expect(claimed(sent, taskId)).toBe(1);
    await completeAdmitted(runner, adapter, sent, taskId);
  });

  it('runtime preparation failed: declines retryably and gives the Agent home reservation back', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    vi.spyOn(adapter, 'prepare').mockRejectedValueOnce(new Error('prepare fixture failure'));
    const { runner, agentHome, sent } = await agentRunner(adapter);
    const taskId = 'runtime-preparation-failed';

    await runner.handleEnvelope(agentOffer(taskId, 1));

    expect(declines(sent, taskId).map((entry) => entry.payload)).toEqual([{
      reason: 'runtime preparation failed: prepare fixture failure', retryable: true, agentRef: AGENT,
    }]);
    expect(claimed(sent, taskId)).toBe(0);
    expect(adapter.startCalls).toHaveLength(0);
    expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });

    await runner.handleEnvelope(agentOffer(taskId, 2));
    expect(declines(sent, taskId)).toHaveLength(1);
    expect(claimed(sent, taskId)).toBe(1);
    await completeAdmitted(runner, adapter, sent, taskId);
  });

  it('Agent home initialization failed: releases the execution lease before the decline', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, agentHome, sent } = await agentRunner(adapter);
    const acquire = vi.spyOn(agentHome, 'acquireExecution');
    vi.spyOn(agentHome, 'initializeExecution').mockRejectedValueOnce(new Error('init fixture failure'));
    const taskId = 'agent-home-init-failed';

    await runner.handleEnvelope(agentOffer(taskId, 1));

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(declines(sent, taskId).map((entry) => entry.payload)).toEqual([{
      reason: 'Agent home initialization failed: init fixture failure', retryable: false, agentRef: AGENT,
    }]);
    expect(claimed(sent, taskId)).toBe(0);
    expect(adapter.startCalls).toHaveLength(0);
    expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });

    await runner.handleEnvelope(agentOffer(taskId, 2));
    expect(declines(sent, taskId)).toHaveLength(1);
    expect(claimed(sent, taskId)).toBe(1);
    await completeAdmitted(runner, adapter, sent, taskId);
  });

  it('Agent message outbox initialization failed: releases the execution lease before the retryable decline', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, agentHome, sent } = await agentRunner(adapter, {
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      tenantId: 'tenant-offer-char',
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: async () => {},
    });
    const acquire = vi.spyOn(agentHome, 'acquireExecution');
    vi.spyOn(AgentMessageOutbox, 'open').mockRejectedValueOnce(new Error('outbox fixture failure'));
    const taskId = 'agent-message-outbox-failed';
    const offer = (seq: number) => createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply', runtime: 'pi', agentRef: AGENT, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
    }, { taskId, seq });

    try {
      await runner.handleEnvelope(offer(1));

      expect(acquire).toHaveBeenCalledTimes(1);
      expect(declines(sent, taskId).map((entry) => entry.payload)).toEqual([{
        reason: 'Agent message outbox initialization failed: outbox fixture failure', retryable: true, agentRef: AGENT,
      }]);
      expect(claimed(sent, taskId)).toBe(0);
      expect(adapter.startCalls).toHaveLength(0);
      expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });

      await runner.handleEnvelope(offer(2));
      expect(declines(sent, taskId)).toHaveLength(1);
      expect(claimed(sent, taskId)).toBe(1);
      expect(sent.some((entry) => entry.type === 'task.started' && entry.task_id === taskId)).toBe(true);
    } finally {
      await runner.shutdownActiveTasks('test cleanup');
    }
    expect(runner.activeTaskCount).toBe(0);
  });

  it('could not bind the runtime session: fails the claimed Agent task and releases the lease through the startup owner', async () => {
    const adapter = new DriftingSessionAdapter('pi');
    const { runner, agentHome, sent } = await agentRunner(adapter);

    // A first Attempt records the durable session handoff the resume needs.
    await runner.handleEnvelope(agentOffer('bind-first', 1));
    const recordedSession = adapter.sessions[0]!.sessionRef;
    await completeAdmitted(runner, adapter, sent, 'bind-first');

    // The resume binds its lease to `recordedSession`. The runtime returns a
    // different session, so the lease refuses to rebind.
    adapter.driftTo = 'drifted-session';
    const taskId = 'bind-resume';
    await runner.handleEnvelope(agentOffer(taskId, 2, { sessionRef: recordedSession }));

    expect(claimed(sent, taskId)).toBe(1);
    expect(sent.some((entry) => entry.type === 'task.started' && entry.task_id === taskId)).toBe(false);
    const failed = terminals(sent, taskId);
    expect(failed.map((entry) => entry.type)).toEqual(['task.fail']);
    const payload = failed[0]!.payload as { reason: string; retryable: boolean; agentRef?: unknown };
    expect(payload.reason.startsWith('Agent session execution lease could not bind the runtime session: ')).toBe(true);
    expect(payload.retryable).toBe(false);
    expect(payload.agentRef).toEqual(AGENT);
    const drifted = adapter.sessions.at(-1)!;
    expect(drifted.sessionRef).toBe('drifted-session');
    expect(drifted.closeCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
    expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });
    const binding = await agentHome.acquire(AGENT);
    await binding.lease.release();
  });

  it('runtime activation failed: fails the claimed task and releases the Session and Agent lease through the startup owner', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const { runner, agentHome } = await agentRunner(adapter, {
      // A transport that throws on the `task.started` send fails activation
      // after the startup owner was registered and before the active handoff.
      send: (envelope) => {
        if (envelope.type === 'task.started') throw new Error('send fixture failure');
        sent.push(envelope);
      },
    });
    const taskId = 'runtime-activation-failed';

    await runner.handleEnvelope(agentOffer(taskId, 1));

    expect(claimed(sent, taskId)).toBe(1);
    expect(terminals(sent, taskId).map((entry) => ({ type: entry.type, payload: entry.payload }))).toEqual([{
      type: 'task.fail', payload: { reason: 'runtime activation failed: send fixture failure', retryable: false, agentRef: AGENT },
    }]);
    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.sessions[0]!.closeCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
    const binding = await agentHome.acquire(AGENT);
    await binding.lease.release();
  });
});

/** A promise a test settles by hand. */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/**
 * #476 trigger: the next busy-gate count opens `open` on the following
 * microtask. Without the admission wait the busy decline is sent
 * synchronously after that count, before the gate opens; with it the offer
 * parks on the finishing Attempt and resumes once the gate opened.
 */
function openOnNextCount(agentHome: AgentHomeManager, open: () => void): void {
  const manager = agentHome.executionLeaseManager;
  const original = manager.activeAttemptCount.bind(manager);
  let armed = true;
  vi.spyOn(manager, 'activeAttemptCount').mockImplementation((home, access) => {
    const count = original(home, access);
    if (armed) { armed = false; queueMicrotask(open); }
    return count;
  });
}

/** Ends `first`'s turn and waits for its published terminal; its cleanup is what the caller holds. */
async function publishFirstTerminal(adapter: StubRuntimeAdapter, sent: Envelope[], agentHome: AgentHomeManager): Promise<void> {
  adapter.sessions[0]!.emit({ type: 'turn_end' });
  await vi.waitFor(() => expect(terminals(sent, 'first').map((entry) => entry.type)).toEqual(['task.complete']));
  // The terminal is on the wire, the writer lease is not yet released.
  expect(agentHome.executionLeaseManager.activeAttemptSummary()).toMatchObject({ homes: 1, attempts: 1 });
}

const BUSY_WRITER = 'agent home busy: 1 active attempt(s)';

describe('same-home admission after a published terminal (#476)', () => {
  it('waits for a finishing Attempt held at its terminal commit, then admits the same-home offer', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const commit = gate();
    const { runner, agentHome, sent } = await agentRunner(adapter, {
      awaitTerminalCommit: (taskId) => (taskId === 'first' ? commit.promise : Promise.resolve()),
    });
    await runner.handleEnvelope(agentOffer('first', 1));
    await publishFirstTerminal(adapter, sent, agentHome);

    openOnNextCount(agentHome, commit.open);
    await runner.handleEnvelope(agentOffer('second', 2));

    expect(declines(sent, 'second')).toEqual([]);
    expect(claimed(sent, 'second')).toBe(1);
    expect(adapter.startCalls).toHaveLength(2);
    expect(agentHome.executionLeaseManager.activeAttemptSummary()).toMatchObject({ homes: 1, attempts: 1 });
    await completeAdmitted(runner, adapter, sent, 'second');
  });

  it('waits for a finishing Attempt held in Session.close(), then admits the same-home offer', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, agentHome, sent } = await agentRunner(adapter);
    await runner.handleEnvelope(agentOffer('first', 1));
    const releaseClose = adapter.sessions[0]!.blockClose();
    await publishFirstTerminal(adapter, sent, agentHome);

    openOnNextCount(agentHome, releaseClose);
    await runner.handleEnvelope(agentOffer('second', 2));

    expect(adapter.sessions[0]!.closeCalled).toBe(true);
    expect(declines(sent, 'second')).toEqual([]);
    expect(claimed(sent, 'second')).toBe(1);
    expect(adapter.startCalls).toHaveLength(2);
    await completeAdmitted(runner, adapter, sent, 'second');
  });

  it('a finishing Attempt whose close fails keeps the slot: the parked offer is declined busy after the wait', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, agentHome, sent } = await agentRunner(adapter);
    await runner.handleEnvelope(agentOffer('first', 1));
    const session = adapter.sessions[0]!;
    const originalClose = session.close.bind(session);
    const close = gate();
    session.close = async () => {
      await close.promise;
      throw new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'held close fixture failed' });
    };
    await publishFirstTerminal(adapter, sent, agentHome);

    const counted = vi.spyOn(agentHome.executionLeaseManager, 'activeAttemptCount');
    const offer = runner.handleEnvelope(agentOffer('second', 2));
    await vi.waitFor(() => expect(counted).toHaveBeenCalled());
    expect(declines(sent, 'second')).toEqual([]);
    close.open();
    await offer;

    expect(declines(sent, 'second').map((entry) => entry.payload)).toEqual([
      { reason: BUSY_WRITER, retryable: true, agentRef: AGENT, code: 'agent_home_writer_busy' },
    ]);
    expect(claimed(sent, 'second')).toBe(0);
    expect(adapter.startCalls).toHaveLength(1);
    expect(runner.activeTaskCount).toBe(1);

    session.close = originalClose;
    await runner.retryTerminalFinalization('first');
    expect(runner.activeTaskCount).toBe(0);
  });

  describe('a parked offer is withdrawn without waiting for the finishing Attempt', () => {
    async function parkSecondBehindHeldClose(secondStartupTimeoutMs?: number) {
      const adapter = new StubRuntimeAdapter('pi');
      const harness = await agentRunner(adapter);
      const { runner, agentHome, sent, deps } = harness;
      await runner.handleEnvelope(agentOffer('first', 1));
      const releaseClose = adapter.sessions[0]!.blockClose();
      await publishFirstTerminal(adapter, sent, agentHome);
      // Read per offer at receipt: `first` started under the default budget.
      if (secondStartupTimeoutMs !== undefined) deps.startupTimeoutMs = secondStartupTimeoutMs;
      const counted = vi.spyOn(agentHome.executionLeaseManager, 'activeAttemptCount');
      const offer = runner.handleEnvelope(agentOffer('second', 2));
      await vi.waitFor(() => expect(counted).toHaveBeenCalled());
      expect(declines(sent, 'second')).toEqual([]);
      return { ...harness, adapter, releaseClose, offer };
    }

    it('task.cancel declines it as cancelled before claim', async () => {
      const { runner, sent, adapter, releaseClose, offer } = await parkSecondBehindHeldClose();
      await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'host withdrew' }, { taskId: 'second', seq: 3 }));
      await offer;

      expect(declines(sent, 'second').map((entry) => entry.payload)).toEqual([
        { reason: 'cancelled before claim', retryable: false, agentRef: AGENT },
      ]);
      expect(claimed(sent, 'second')).toBe(0);
      expect(adapter.startCalls).toHaveLength(1);
      releaseClose();
      await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    });

    it('stopAcceptingOffers declines it as shutting down, and shutdown completes once the close resolves', async () => {
      const { runner, sent, adapter, releaseClose, offer } = await parkSecondBehindHeldClose();
      runner.stopAcceptingOffers();
      await offer;

      expect(declines(sent, 'second').map((entry) => entry.payload)).toEqual([
        { reason: 'daemon is shutting down', retryable: true, agentRef: AGENT },
      ]);
      expect(adapter.startCalls).toHaveLength(1);
      let shutDown = false;
      const shutdown = runner.shutdownActiveTasks('daemon stopping').then(() => { shutDown = true; });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(shutDown).toBe(false);
      releaseClose();
      await shutdown;
      expect(runner.activeTaskCount).toBe(0);
    });

    it('the startup deadline declines it retryably', async () => {
      // Bounds the product's own abort timer while `first`'s close is held; not a test wait.
      const { runner, sent, adapter, releaseClose, offer } = await parkSecondBehindHeldClose(500);
      await offer;

      expect(declines(sent, 'second').map((entry) => entry.payload)).toEqual([
        { reason: 'runtime startup deadline exceeded', retryable: true, agentRef: AGENT },
      ]);
      expect(claimed(sent, 'second')).toBe(0);
      expect(adapter.startCalls).toHaveLength(1);
      releaseClose();
      await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    });
  });

  it('an offer received after stopAcceptingOffers does not park on a finishing Attempt', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, agentHome, sent } = await agentRunner(adapter);
    await runner.handleEnvelope(agentOffer('first', 1));
    const releaseClose = adapter.sessions[0]!.blockClose();
    await publishFirstTerminal(adapter, sent, agentHome);
    // The sweep runs before `second` exists, so `second`'s admission signal is never aborted.
    runner.stopAcceptingOffers();

    const counted = vi.spyOn(agentHome.executionLeaseManager, 'activeAttemptCount');
    const offer = runner.handleEnvelope(agentOffer('second', 2));
    await vi.waitFor(() => expect(counted).toHaveBeenCalled());
    // Declined on the same synchronous path as the count, while `first`'s close is still held.
    expect(declines(sent, 'second').map((entry) => entry.payload)).toEqual([
      { reason: BUSY_WRITER, retryable: true, agentRef: AGENT, code: 'agent_home_writer_busy' },
    ]);
    await offer;
    expect(claimed(sent, 'second')).toBe(0);
    expect(adapter.startCalls).toHaveLength(1);
    releaseClose();
    await runner.shutdownActiveTasks('daemon stopping');
    expect(runner.activeTaskCount).toBe(0);
  });

  it('a live, not finishing Attempt is busy at once: no wait', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, sent } = await agentRunner(adapter);
    await runner.handleEnvelope(agentOffer('first', 1));

    await runner.handleEnvelope(agentOffer('second', 2));

    expect(declines(sent, 'second').map((entry) => entry.payload)).toEqual([
      { reason: BUSY_WRITER, retryable: true, agentRef: AGENT, code: 'agent_home_writer_busy' },
    ]);
    expect(claimed(sent, 'second')).toBe(0);
    expect(adapter.startCalls).toHaveLength(1);
    await completeAdmitted(runner, adapter, sent, 'first');
  });
});

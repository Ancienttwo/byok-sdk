import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentEvent, type Envelope, type TaskOfferPayload } from '@byok/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import type {
  ApprovalChannel,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeDetectResult,
  Session,
  TaskContext,
} from '../types';
import { AsyncQueue } from '../util/async-queue';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * M4 (additive-minor, `task.approval_resolved` — see `messages.ts`'s doc
 * comment on `TaskApprovalResolvedPayloadSchema` and `task-runner.ts`'s
 * `sendApprovalResolved` for the full rationale): the daemon-side send
 * decision in isolation, mirroring `task-runner-approval.test.ts`'s own
 * convention of driving `TaskRunner` directly (no control socket, no real
 * connection) via `requestApproval`/`handleEnvelope` and a plain `sent`
 * array — `getServerCapabilities` is just a stub function here, exactly like
 * every other `TaskRunnerDeps` field this file's sibling stubs.
 *
 * A full end-to-end pass (real daemon, real `@byok/server`, real capability
 * negotiation over a real handshake, real local-CLI-equivalent resolve) is
 * `real-server-approval-resolved-e2e.test.ts`.
 */

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

async function makeRunner(
  adapter: RuntimeAdapter,
  sent: Envelope[],
  overrides: Partial<Pick<TaskRunnerDeps, 'approvalTimeoutMs' | 'approvalRegistry' | 'getServerCapabilities'>> = {},
): Promise<{ runner: TaskRunner; approvalRegistry: ApprovalRegistry }> {
  const approvalRegistry = overrides.approvalRegistry ?? new ApprovalRegistry();
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-approval-resolved-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-approval-resolved-store-')),
    approvalRegistry,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    approvalTimeoutMs: overrides.approvalTimeoutMs,
    getServerCapabilities: overrides.getServerCapabilities,
  };
  return { runner: new TaskRunner(deps), approvalRegistry };
}

async function offerAndActivate(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { instruction: 'do gated work', policy: { mode: 'confirm' } }, { taskId, seq: 1 }),
  );
}

function findApprovalResolved(sent: Envelope[]) {
  const envelope = sent.find((e) => e.type === 'task.approval_resolved');
  if (envelope?.type !== 'task.approval_resolved') return undefined;
  return envelope;
}

/**
 * A minimal `Session`/`RuntimeAdapter` double whose `resolveApproval` genuinely
 * routes through `TaskContext.approvalChannel.resolve` — deliberately
 * mirroring what the real claude adapter's `ClaudeSession.resolveApproval`
 * does under `confirm` mode (see `claude-adapter.ts`), which is what actually
 * exercises the WIRE path (`TaskRunner.handleApprove`/`handleReject` ->
 * `session.resolveApproval` -> `approvalChannel.resolve` ->
 * `ApprovalRegistry.resolve(..., 'wire')`). `StubSession`
 * (`fixtures/stub-adapter.ts`) deliberately does NOT do this (it only
 * records the call) — this file needs the real relay, so it gets its own
 * tiny double, matching `confirm-mode-approval-e2e.test.ts`'s own
 * file-local `ApprovalAwareSession`/`ApprovalAwareAdapter` precedent.
 */
class RelayingSession implements Session {
  readonly resolveApprovalCalls: Array<{ approved: boolean; reason?: string }> = [];
  private readonly queue = new AsyncQueue<AgentEvent>();

  constructor(
    public readonly sessionRef: string,
    private readonly approvalChannel: ApprovalChannel | undefined,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.queue.end();
  }
  async resolveApproval(approved: boolean, reason?: string): Promise<void> {
    this.resolveApprovalCalls.push(reason === undefined ? { approved } : { approved, reason });
    if (!this.approvalChannel) throw new Error('no approval channel wired up for this session');
    await this.approvalChannel.resolve(approved, reason);
  }
  emit(event: AgentEvent): void {
    this.queue.push(event);
  }
}

class RelayingAdapter implements RuntimeAdapter {
  readonly id = 'relay-stub';
  readonly sessions: RelayingSession[] = [];

  async detect(): Promise<RuntimeDetectResult> {
    return { present: true, version: '0.0.0' };
  }
  capabilities(): RuntimeCapabilities {
    return { steer: false, resume: true, permissionModes: ['confirm'] };
  }
  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    const session = new RelayingSession(task.sessionRef ?? `relay-session-${this.sessions.length + 1}`, ctx.approvalChannel);
    this.sessions.push(session);
    return session;
  }
}

describe('TaskRunner: task.approval_resolved send decision', () => {
  it('local approve (approvalRegistry.resolve directly, simulating the control-socket approvals.resolve RPC) sends task.approval_resolved with the right payload', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, {
      getServerCapabilities: () => ['approval_resolved'],
    });
    const taskId = 'task-local-approve-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    const pending = approvalRegistry.list();
    const approvalId = pending[0]!.approvalId;
    // No `origin` arg — mirrors what create-daemon.ts's real
    // 'approvals.resolve' control-socket handler passes, defaulting to 'local'.
    approvalRegistry.resolve(approvalId, 'approve');
    await expect(outcomePromise).resolves.toEqual({ approved: true, reason: undefined });

    const resolved = findApprovalResolved(sent);
    expect(resolved).toBeDefined();
    if (resolved === undefined) throw new Error('unreachable');
    expect(resolved.task_id).toBe(taskId);
    expect(resolved.payload).toEqual({
      approvalId,
      decision: 'approve',
      resolvedBy: 'local',
      at: resolved.payload.at,
    });
    expect(() => new Date(resolved.payload.at).toISOString()).not.toThrow();
  });

  it('local reject sends task.approval_resolved with decision: reject', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, {
      getServerCapabilities: () => ['approval_resolved'],
    });
    const taskId = 'task-local-reject-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: rm -rf /');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'reject', 'operator declined via CLI');
    await outcomePromise;

    const resolved = findApprovalResolved(sent);
    expect(resolved?.payload.decision).toBe('reject');
    expect(resolved?.payload.resolvedBy).toBe('local');
  });

  it('wire-resolved (server-sent task.approve, routed through session.resolveApproval -> ctx.approvalChannel.resolve) does NOT send task.approval_resolved', async () => {
    const adapter = new RelayingAdapter();
    const sent: Envelope[] = [];
    const { runner } = await makeRunner(adapter, sent, {
      getServerCapabilities: () => ['approval_resolved'],
    });
    const taskId = 'task-wire-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    // The server's own wire task.approve — TaskRunner.handleApprove calls
    // session.resolveApproval(true), which (only for THIS test's adapter)
    // forwards to ctx.approvalChannel.resolve -> approvalRegistry.resolve(...,
    // 'wire').
    await runner.handleEnvelope(createEnvelope('task.approve', {}, { taskId, seq: 0 }));
    await expect(outcomePromise).resolves.toEqual({ approved: true, reason: undefined });

    expect(adapter.sessions[0]?.resolveApprovalCalls).toEqual([{ approved: true }]);
    expect(sent.some((e) => e.type === 'task.approval_resolved')).toBe(false);
  });

  it('wire-resolved reject also does NOT send task.approval_resolved', async () => {
    const adapter = new RelayingAdapter();
    const sent: Envelope[] = [];
    const { runner } = await makeRunner(adapter, sent, {
      getServerCapabilities: () => ['approval_resolved'],
    });
    const taskId = 'task-wire-2';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Write: /etc/shadow');
    await runner.handleEnvelope(createEnvelope('task.reject', { reason: 'server said no' }, { taskId, seq: 0 }));
    await outcomePromise;

    expect(sent.some((e) => e.type === 'task.approval_resolved')).toBe(false);
  });

  it('an unanswered approval that force-resolves via timeout is itself a local resolution: sends task.approval_resolved with decision: reject', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = await makeRunner(adapter, sent, {
      approvalTimeoutMs: 20,
      getServerCapabilities: () => ['approval_resolved'],
    });
    const taskId = 'task-timeout-1';
    await offerAndActivate(runner, taskId);

    const outcome = await runner.requestApproval(taskId, 'Bash: sleep forever');
    expect(outcome.approved).toBe(false);

    const resolved = findApprovalResolved(sent);
    expect(resolved).toBeDefined();
    expect(resolved?.payload.decision).toBe('reject');
    expect(resolved?.payload.resolvedBy).toBe('local');
  });

  it('capability absent (getServerCapabilities not supplied at all) -> task.approval_resolved is never sent, even for a local resolution', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    // No getServerCapabilities override — TaskRunnerDeps.getServerCapabilities
    // is entirely omitted, exactly like a minimal test harness that doesn't
    // care about this gate (see that field's own doc comment).
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-no-cap-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'approve');
    await outcomePromise;

    expect(sent.some((e) => e.type === 'task.approval_resolved')).toBe(false);
  });

  it("capability list present but WITHOUT approval_resolved (e.g. an old server's conn.ack) -> still not sent", async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, {
      getServerCapabilities: () => ['steer', 'blob-upload'],
    });
    const taskId = 'task-old-server-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'approve');
    await outcomePromise;

    expect(sent.some((e) => e.type === 'task.approval_resolved')).toBe(false);
  });

  it('ordering: task.approval_resolved is queued before any progress the resumed session goes on to produce', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, {
      getServerCapabilities: () => ['approval_resolved'],
    });
    const taskId = 'task-ordering-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'approve');
    await outcomePromise;

    // The resumed session immediately produces more progress and completes —
    // simulating the runtime turn continuing right after being unblocked.
    adapter.sessions[0]!.emit({ type: 'progress', text: 'resuming after local approval' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'task.complete')).toBe(true));

    const resolvedIndex = sent.findIndex((e) => e.type === 'task.approval_resolved');
    const completeIndex = sent.findIndex((e) => e.type === 'task.complete');
    expect(resolvedIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(resolvedIndex);
  });
});

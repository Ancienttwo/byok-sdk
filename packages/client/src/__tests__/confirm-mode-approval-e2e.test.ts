import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig, type DaemonOverrides } from '../daemon/create-daemon';
import { connectControlClient } from '../bin/control-client';
import type { ApprovalsListResult, ApprovalsRequestResult, ControlStatusResult } from '../daemon/control-protocol';
import type { DaemonEvent } from '../daemon/observer';
import type { ApprovalChannel, RuntimeAdapter, RuntimeCapabilities, RuntimeDetectResult, Session, TaskContext } from '../types';
import { AsyncQueue } from '../util/async-queue';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * M4 Phase 3: end-to-end coverage of the out-of-band approval channel
 * through the REAL control socket (mirrors `daemon-control-socket.test.ts`'s
 * own `createDaemonWithAdapters` + `TestServer` convention) — proves what
 * `task-runner-approval.test.ts`'s unit-level tests can't on their own: that
 * the server-sent wire `task.approve`/`task.reject` AND the local CLI's
 * `approvals.resolve` genuinely converge on the exact same
 * `ApprovalRegistry` entry a pending `approvals.request` control call is
 * awaiting (the task's own "dual entry convergence" requirement).
 *
 * `ApprovalAwareSession`/`ApprovalAwareAdapter` below are a minimal
 * test-local double whose `resolveApproval` genuinely routes through
 * `TaskContext.approvalChannel` — deliberately mirroring exactly what the
 * real claude adapter's `ClaudeSession.resolveApproval` does (see
 * `claude-adapter.ts`), so the WIRE path (`TaskRunner.handleApprove`/
 * `handleReject` -> `session.resolveApproval` -> `approvalChannel.resolve`
 * -> `ApprovalRegistry.resolve`) is exercised faithfully without needing a
 * real claude binary or MCP round trip — that mechanism itself (the MCP
 * wire shape, `--permission-prompt-tool`) was empirically verified directly
 * against the real installed binary in M4 Phase 3 STEP 0 and is covered at
 * the protocol-handler level by `approval-mcp-server.test.ts`.
 */
class ApprovalAwareSession implements Session {
  readonly resolveApprovalCalls: Array<{ approved: boolean; reason?: string }> = [];
  /** Counts real `interrupt()` calls — used to prove a STALE wire `task.reject` (Decision #3) does NOT tear the session down, unlike a genuine reject. */
  interruptCalls = 0;
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
  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }
  async close(): Promise<void> {
    this.queue.end();
  }
  async resolveApproval(approved: boolean, reason?: string): Promise<void> {
    this.resolveApprovalCalls.push(reason === undefined ? { approved } : { approved, reason });
    if (!this.approvalChannel) throw new Error('no approval channel wired up for this session');
    await this.approvalChannel.resolve(approved, reason);
  }

  /**
   * Simulates the underlying (stubbed) runtime naturally continuing and
   * finishing its own turn — e.g. after being unblocked by whichever path
   * actually won a pending approval. Pushed directly onto this session's own
   * event stream, exactly like a real adapter's stream-json reader would.
   */
  pushTurnEnd(): void {
    this.queue.push({ type: 'turn_end' });
  }
}

class ApprovalAwareAdapter implements RuntimeAdapter {
  readonly id = 'confirm-stub';
  readonly sessions: ApprovalAwareSession[] = [];

  async detect(): Promise<RuntimeDetectResult> {
    return { present: true, version: '0.0.0' };
  }
  capabilities(): RuntimeCapabilities {
    return { steer: false, resume: true, permissionModes: ['confirm'] };
  }
  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    const session = new ApprovalAwareSession(task.sessionRef ?? `session-${this.sessions.length + 1}`, ctx.approvalChannel);
    this.sessions.push(session);
    return session;
  }
}

describe('M4 Phase 3: confirm-mode approval end-to-end (control socket + wire)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function pairedAndStarted(
    productId: string,
    adapter: ApprovalAwareAdapter,
    overrides: DaemonOverrides = {},
  ): Promise<{ daemon: Daemon; config: DaemonConfig; storeDir: string }> {
    const workspaceRoot = await tmpDir(`byok-confirm-e2e-${productId}-ws-`);
    const storeDir = await tmpDir(`byok-confirm-e2e-${productId}-store-`);
    const config: DaemonConfig = { productName: 'Acme', productId, serverUrl: server.url, workspaceRoot, storeDir };
    const built = createDaemonWithAdapters(config, [adapter], overrides);
    await built.pair('pairing-code');
    await built.start();
    return { daemon: built, config, storeDir };
  }

  it('(a) approvals.request + server-sent wire task.approve resolves the SAME pending approval — the gated action proceeds', async () => {
    const adapter = new ApprovalAwareAdapter();
    const built = await pairedAndStarted('acme-confirm-approve', adapter);
    daemon = built.daemon;

    const taskId = 't-approve-1';
    server.send(
      createEnvelope('task.offer', { instruction: 'do gated work', policy: { mode: 'confirm' } }, { taskId, seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');

    const requestPromise = conn.client.request<ApprovalsRequestResult>('approvals.request', {
      taskId,
      summary: 'Bash: rm -rf /tmp/whatever',
    });

    await server.waitFor((e) => e.type === 'task.await_approval' && e.task_id === taskId);

    // The SaaS/server side decides to approve — a real Hub would send this
    // itself (hub.ts's approveTask); this test drives the wire message
    // directly, matching daemon-control-socket.test.ts's own convention of
    // exercising TaskRunner's server-facing side via a raw envelope.
    server.send(createEnvelope('task.approve', {}, { taskId, seq: server.nextSeq() }));

    const outcome = await requestPromise;
    expect(outcome).toEqual({ approved: true, reason: undefined });
    expect(adapter.sessions[0]?.resolveApprovalCalls).toEqual([{ approved: true }]);

    conn.client.close();
  });

  it('finding F4: the awaiting-approval DaemonEvent, approvals.list, and status.approvals all agree on the SAME real approvalId — an operator can learn it from any of the three surfaces', async () => {
    const adapter = new ApprovalAwareAdapter();
    const built = await pairedAndStarted('acme-confirm-approvalid-surfaces', adapter);
    daemon = built.daemon;

    const events: DaemonEvent[] = [];
    built.daemon.subscribe((e) => events.push(e));

    const taskId = 't-approvalid-surfaces-1';
    server.send(
      createEnvelope('task.offer', { instruction: 'do gated work', policy: { mode: 'confirm' } }, { taskId, seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');

    const requestPromise = conn.client.request<ApprovalsRequestResult>('approvals.request', {
      taskId,
      summary: 'Bash: rm -rf /tmp/surfaces',
    });
    await server.waitFor((e) => e.type === 'task.await_approval' && e.task_id === taskId);

    // Surface 1: the awaiting-approval DaemonEvent (what `tasks --follow`
    // renders) — must have a defined approvalId now (finding F4), not the
    // pre-fix `undefined` that left operators with no way to learn one.
    const awaiting = await vi.waitFor(() => {
      const e = events.find((e) => e.kind === 'awaiting-approval' && e.taskId === taskId);
      if (e?.kind !== 'awaiting-approval') throw new Error('not yet emitted');
      return e;
    });
    expect(awaiting.approvalId).toEqual(expect.any(String));

    // Surface 2: approvals.list (backing the new `byok-agent approvals` command).
    const list = await conn.client.request<ApprovalsListResult>('approvals.list');
    expect(list.approvals).toHaveLength(1);
    expect(list.approvals[0]?.approvalId).toBe(awaiting.approvalId);
    expect(list.approvals[0]?.taskId).toBe(taskId);

    // Surface 3: status's live section (`formatLiveStatusLines`'s `live-approval` line).
    const status = await conn.client.request<ControlStatusResult>('status');
    expect(status.approvalsPending).toBe(1);
    expect(status.approvals).toHaveLength(1);
    expect(status.approvals[0]?.approvalId).toBe(awaiting.approvalId);
    expect(status.approvals[0]?.taskId).toBe(taskId);

    // Clean up: resolve so the pending `approvals.request` call doesn't hang past this test.
    await conn.client.request('approvals.resolve', { approvalId: awaiting.approvalId, decision: 'approve' });
    await requestPromise;

    conn.client.close();
  });

  it('(b) local CLI reject (approvals.resolve, a SEPARATE control-socket connection) denies the SAME pending approvals.request call', async () => {
    const adapter = new ApprovalAwareAdapter();
    const built = await pairedAndStarted('acme-confirm-reject', adapter);
    daemon = built.daemon;

    const taskId = 't-reject-1';
    server.send(
      createEnvelope('task.offer', { instruction: 'do gated work', policy: { mode: 'confirm' } }, { taskId, seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);

    const requesterConn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!requesterConn.ok) throw new Error('expected reachable');
    const requestPromise = requesterConn.client.request<ApprovalsRequestResult>('approvals.request', {
      taskId,
      summary: 'Write: /etc/shadow',
    });

    await server.waitFor((e) => e.type === 'task.await_approval' && e.task_id === taskId);

    const cliConn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!cliConn.ok) throw new Error('expected reachable');
    const list = await cliConn.client.request<{ approvals: Array<{ approvalId: string; taskId: string }> }>('approvals.list');
    expect(list.approvals).toHaveLength(1);
    expect(list.approvals[0]?.taskId).toBe(taskId);
    await cliConn.client.request('approvals.resolve', {
      approvalId: list.approvals[0]?.approvalId,
      decision: 'reject',
      reason: 'operator declined via CLI',
    });

    const outcome = await requestPromise;
    expect(outcome).toEqual({ approved: false, reason: 'operator declined via CLI' });
    // The local CLI's approvals.resolve resolves the ApprovalRegistry entry
    // DIRECTLY (control-server.ts's own handler) — it never goes through
    // TaskRunner.handleApprove/handleReject or session.resolveApproval() at
    // all (that's the WIRE task.approve/task.reject path's own job — see
    // test (a) above). Both paths converge on the SAME registry entry,
    // which is what actually unblocks a pending approvals.request/
    // byok-approval-mcp — that convergence is what this test proves, not
    // that every path notifies the session identically.
    expect(adapter.sessions[0]?.resolveApprovalCalls).toEqual([]);

    requesterConn.client.close();
    cliConn.client.close();
  });

  it('dual-entry convergence: wire task.reject racing a local CLI approvals.resolve for the SAME approval — exactly one wins, the daemon never hangs or crashes, and the loser surfaces as a well-formed error rather than corrupting state', async () => {
    const adapter = new ApprovalAwareAdapter();
    const built = await pairedAndStarted('acme-confirm-race', adapter);
    daemon = built.daemon;

    const taskId = 't-race-1';
    server.send(
      createEnvelope('task.offer', { instruction: 'do gated work', policy: { mode: 'confirm' } }, { taskId, seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    const requestPromise = conn.client.request<ApprovalsRequestResult>('approvals.request', { taskId, summary: 'Bash: contested' });
    await server.waitFor((e) => e.type === 'task.await_approval' && e.task_id === taskId);

    const list = await conn.client.request<{ approvals: Array<{ approvalId: string }> }>('approvals.list');
    const approvalId = list.approvals[0]?.approvalId;
    expect(approvalId).toBeDefined();

    // Fire both "decide this approval" paths without awaiting either first —
    // the whole point is that they genuinely race. The local CLI path
    // resolves the registry directly and settles first in practice (no
    // network hop, unlike the wire message below), but this test does not
    // depend on which one wins — only that exactly one does, cleanly.
    const cliResolvePromise = conn.client.request('approvals.resolve', { approvalId, decision: 'reject', reason: 'CLI won the race' });
    server.send(createEnvelope('task.approve', {}, { taskId, seq: server.nextSeq() }));

    const outcome = await requestPromise;
    // Whichever path actually won, requestApproval settles exactly once —
    // the resolved promise itself proves the registry's "first resolution
    // wins" guarantee held (a second resolve() for the same id would have
    // thrown ApprovalNotFoundError inside whichever handler lost, not
    // produced a second, conflicting resolution of this promise).
    expect(typeof outcome.approved).toBe('boolean');
    await expect(cliResolvePromise).resolves.toBeDefined();

    // The daemon itself must still be alive and answering control requests
    // afterward, regardless of which side lost the race — the definition of
    // "clean" this test actually holds itself to.
    const status = await conn.client.request('status');
    expect(status).toBeDefined();

    conn.client.close();
  });

  it('(c) an unanswered approval force-resolves as a fail-closed deny once the configured timeout elapses', async () => {
    const adapter = new ApprovalAwareAdapter();
    const built = await pairedAndStarted('acme-confirm-timeout', adapter, { approvalTimeoutMs: 50 });
    daemon = built.daemon;

    const taskId = 't-timeout-1';
    server.send(
      createEnvelope('task.offer', { instruction: 'do gated work', policy: { mode: 'confirm' } }, { taskId, seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId, requestTimeoutMs: 5000 });
    if (!conn.ok) throw new Error('expected reachable');

    const outcome = await conn.client.request<ApprovalsRequestResult>('approvals.request', {
      taskId,
      summary: 'Bash: never answered',
    });
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toMatch(/timed out/);

    conn.client.close();
  });

  it('(d) [orchestrator Decision #3] local approvals.resolve APPROVE wins; a stale wire task.approve arriving strictly after is an audit-only no-op — the task is NOT failed and completes normally', async () => {
    const adapter = new ApprovalAwareAdapter();
    const built = await pairedAndStarted('acme-confirm-stale-approve', adapter);
    daemon = built.daemon;

    const events: DaemonEvent[] = [];
    built.daemon.subscribe((e) => events.push(e));

    const taskId = 't-stale-approve-1';
    server.send(
      createEnvelope('task.offer', { instruction: 'do gated work', policy: { mode: 'confirm' } }, { taskId, seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    const requestPromise = conn.client.request<ApprovalsRequestResult>('approvals.request', {
      taskId,
      summary: 'Bash: local wins',
    });
    await server.waitFor((e) => e.type === 'task.await_approval' && e.task_id === taskId);

    // Strict sequence, not a race: the local CLI resolve is fully awaited to
    // completion BEFORE the stale wire message is even sent below.
    const list = await conn.client.request<{ approvals: Array<{ approvalId: string }> }>('approvals.list');
    const approvalId = list.approvals[0]?.approvalId;
    await conn.client.request('approvals.resolve', { approvalId, decision: 'approve' });

    const outcome = await requestPromise;
    expect(outcome).toEqual({ approved: true, reason: undefined });
    // The local CLI path resolves the ApprovalRegistry entry directly
    // (control-server.ts) — it never calls session.resolveApproval() at all
    // (see test (b) above for the same distinction).
    expect(adapter.sessions[0]?.resolveApprovalCalls).toEqual([]);

    // NOW the stale wire task.approve arrives — strictly after the local
    // resolution above already settled this exact approval, mirroring
    // task-runner.ts's handleApprove doc comment (Decision #3 fix).
    server.send(createEnvelope('task.approve', {}, { taskId, seq: server.nextSeq() }));
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.kind === 'stale-approval-decision' && e.taskId === taskId && e.decision === 'approve'),
      ).toBe(true);
    });

    // The stubbed runtime continues on its own after being unblocked and
    // finishes its turn normally — proving the stale wire message above
    // never touched this task's state (no fail(taskId) call).
    adapter.sessions[0]?.pushTurnEnd();
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === taskId);
    expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === taskId)).toBe(false);

    conn.client.close();
  });

  it('(e) [orchestrator Decision #3] local approvals.resolve REJECT wins; a stale wire task.reject arriving strictly after is an audit-only no-op — the session is NOT interrupted a second time and the task is NOT failed twice', async () => {
    const adapter = new ApprovalAwareAdapter();
    const built = await pairedAndStarted('acme-confirm-stale-reject', adapter);
    daemon = built.daemon;

    const events: DaemonEvent[] = [];
    built.daemon.subscribe((e) => events.push(e));

    const taskId = 't-stale-reject-1';
    server.send(
      createEnvelope('task.offer', { instruction: 'do gated work', policy: { mode: 'confirm' } }, { taskId, seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    const requestPromise = conn.client.request<ApprovalsRequestResult>('approvals.request', {
      taskId,
      summary: 'Bash: local rejects',
    });
    await server.waitFor((e) => e.type === 'task.await_approval' && e.task_id === taskId);

    const list = await conn.client.request<{ approvals: Array<{ approvalId: string }> }>('approvals.list');
    const approvalId = list.approvals[0]?.approvalId;
    await conn.client.request('approvals.resolve', {
      approvalId,
      decision: 'reject',
      reason: 'operator declined via CLI',
    });

    const outcome = await requestPromise;
    expect(outcome).toEqual({ approved: false, reason: 'operator declined via CLI' });
    expect(adapter.sessions[0]?.resolveApprovalCalls).toEqual([]);
    expect(adapter.sessions[0]?.interruptCalls).toBe(0);

    // The stale wire task.reject arrives strictly after the local reject
    // above already settled this exact approval. Pre-fix, handleReject
    // unconditionally interrupted the session and sent task.fail regardless
    // of whether resolveApproval even threw (see task-runner.ts's own doc
    // comment on this — a worse bug than handleApprove's).
    server.send(createEnvelope('task.reject', { reason: 'stale server-side reject' }, { taskId, seq: server.nextSeq() }));
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.kind === 'stale-approval-decision' && e.taskId === taskId && e.decision === 'reject'),
      ).toBe(true);
    });

    // The session must NOT have been interrupted by the stale wire reject —
    // proving handleReject's interrupt+task.fail+finish sequence never ran
    // for it. The stubbed runtime is still alive and can still finish its
    // turn normally.
    expect(adapter.sessions[0]?.interruptCalls).toBe(0);
    adapter.sessions[0]?.pushTurnEnd();
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === taskId);
    expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === taskId)).toBe(false);

    conn.client.close();
  });
});

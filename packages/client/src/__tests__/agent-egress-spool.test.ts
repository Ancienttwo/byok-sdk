import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEgressPolicy } from '@byok-sdk/protocol';
import { AgentEgressController } from '../daemon/agent-egress-controller';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentLatestValueState, AgentReliableSpool } from '../daemon/agent-egress-spool';

const roots: string[] = [];
const agentRef = { agentId: 'agent-spool', profileRevision: 'r1' };

async function home(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `byok-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent reliable egress spool', () => {
  it('appends before send, keeps stable id/cursor across restart, and retires only after exact ack', async () => {
    const agentHome = await home('reliable-restart');
    const spool = await AgentReliableSpool.open(agentHome);
    const record = await spool.append({
      agentRef,
      tenantId: 'tenant-spool',
      policyRevision: DEFAULT_AGENT_EGRESS_POLICY.policyRevision,
      eventId: '32f23f5a-2dc5-4c82-a7c8-2b50d940a417',
      payload: { status: 'completed', count: 1 },
      sessionRef: 'session-spool',
    }, DEFAULT_AGENT_EGRESS_POLICY, 0);
    expect(record.cursor).toBe(1);
    expect(spool.records()).toHaveLength(1);

    const restarted = await AgentReliableSpool.open(agentHome);
    expect(restarted.records()).toEqual([record]);
    expect(await restarted.acknowledge({
      agentRef,
      tenantId: 'tenant-spool',
      sessionRef: 'session-spool',
      policyRevision: record.policyRevision,
      eventId: record.eventId,
      cursor: record.cursor + 1,
    })).toBe(false);
    expect(restarted.records()).toHaveLength(1);
    expect(await restarted.acknowledge({
      agentRef,
      tenantId: 'tenant-spool',
      sessionRef: 'session-spool',
      policyRevision: record.policyRevision,
      eventId: record.eventId,
      cursor: record.cursor,
    })).toBe(true);
    expect((await AgentReliableSpool.open(agentHome)).records()).toEqual([]);
  });

  it('shares one first-open authority across concurrent public reliable appends', async () => {
    const agentHome = await home('concurrent-first-open');
    const controller = new AgentEgressController({
      policy: DEFAULT_AGENT_EGRESS_POLICY,
      tenantId: 'tenant-concurrent-first-open',
    });
    const originalOpen = AgentReliableSpool.open.bind(AgentReliableSpool);
    let openReached!: () => void;
    let releaseOpen!: () => void;
    const reached = new Promise<void>((resolve) => { openReached = resolve; });
    const release = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const open = vi.spyOn(AgentReliableSpool, 'open').mockImplementation(async (homeDir) => {
      openReached();
      await release;
      return originalOpen(homeDir);
    });

    const first = controller.appendReliable({
      homeDir: agentHome,
      agentRef,
      sessionRef: 'session-concurrent-first-open',
      payload: { status: 'first' },
      eventId: '2f99ca6e-7cdc-43d5-8db8-94bf4941b1de',
    });
    await reached;
    const second = controller.appendReliable({
      homeDir: agentHome,
      agentRef,
      sessionRef: 'session-concurrent-first-open',
      payload: { status: 'second' },
      eventId: '9744a168-7d1f-49a2-95f5-3f5960ed9211',
    });
    await Promise.resolve();
    try {
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      releaseOpen();
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(controller.reliableRecords()).toMatchObject([
      { eventId: '2f99ca6e-7cdc-43d5-8db8-94bf4941b1de', cursor: 1 },
      { eventId: '9744a168-7d1f-49a2-95f5-3f5960ed9211', cursor: 2 },
    ]);
    expect(new Set(controller.reliableRecords().map((record) => record.cursor)).size).toBe(2);
  });

  it('clears a shared failed first-open slot so a later public reliable append can retry', async () => {
    const agentHome = await home('shared-failed-first-open');
    const controller = new AgentEgressController({
      policy: DEFAULT_AGENT_EGRESS_POLICY,
      tenantId: 'tenant-shared-failed-first-open',
    });
    const originalOpen = AgentReliableSpool.open.bind(AgentReliableSpool);
    let openReached!: () => void;
    let releaseOpen!: () => void;
    const reached = new Promise<void>((resolve) => { openReached = resolve; });
    const release = new Promise<void>((resolve) => { releaseOpen = resolve; });
    let opens = 0;
    const open = vi.spyOn(AgentReliableSpool, 'open').mockImplementation(async (homeDir) => {
      opens += 1;
      if (opens === 1) {
        openReached();
        await release;
        throw new Error('controlled first-open failure');
      }
      return originalOpen(homeDir);
    });

    const first = controller.appendReliable({
      homeDir: agentHome,
      agentRef,
      sessionRef: 'session-shared-failed-first-open',
      payload: { status: 'first' },
      eventId: '75621fbe-fd6e-4eed-b30e-bc4a2780d4e2',
    });
    await reached;
    const second = controller.appendReliable({
      homeDir: agentHome,
      agentRef,
      sessionRef: 'session-shared-failed-first-open',
      payload: { status: 'second' },
      eventId: '20f2cf83-c645-467d-936d-65c66fc5ea50',
    });
    await Promise.resolve();
    try {
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      releaseOpen();
    }
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: false, reason: 'backpressure' },
      { ok: false, reason: 'backpressure' },
    ]);

    const retried = await controller.appendReliable({
      homeDir: agentHome,
      agentRef,
      sessionRef: 'session-shared-failed-first-open',
      payload: { status: 'retry' },
      eventId: '8edf1f13-46e8-446f-bb84-e8f39df6c2a8',
    });
    expect(retried.ok).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    expect(controller.reliableRecords()).toMatchObject([
      { eventId: '8edf1f13-46e8-446f-bb84-e8f39df6c2a8', cursor: 1 },
    ]);
  });

  it('fails closed for a different home while opening and after caching an Agent reliable spool', async () => {
    const agentHome = await home('home-bound-first-open');
    const otherHome = await home('home-bound-other');
    const controller = new AgentEgressController({
      policy: DEFAULT_AGENT_EGRESS_POLICY,
      tenantId: 'tenant-home-bound-first-open',
    });
    const originalOpen = AgentReliableSpool.open.bind(AgentReliableSpool);
    let openReached!: () => void;
    let releaseOpen!: () => void;
    const reached = new Promise<void>((resolve) => { openReached = resolve; });
    const release = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const open = vi.spyOn(AgentReliableSpool, 'open').mockImplementation(async (homeDir) => {
      openReached();
      await release;
      return originalOpen(homeDir);
    });

    const first = controller.appendReliable({
      homeDir: agentHome,
      agentRef,
      sessionRef: 'session-home-bound-first-open',
      payload: { status: 'first' },
      eventId: 'aa7d1d93-2194-4490-812f-0550e6f90c79',
    });
    await reached;
    const openingMismatch = await controller.appendReliable({
      homeDir: otherHome,
      agentRef,
      sessionRef: 'session-home-bound-opening-mismatch',
      payload: { status: 'wrong-home-opening' },
      eventId: '706869a2-8ad7-470d-a631-d041362ec640',
    });
    expect(openingMismatch).toEqual({ ok: false, reason: 'backpressure' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(controller.reliableRecords()).toEqual([]);

    releaseOpen();
    expect((await first).ok).toBe(true);
    expect(controller.reliableRecords()).toMatchObject([
      { eventId: 'aa7d1d93-2194-4490-812f-0550e6f90c79', cursor: 1 },
    ]);

    const cachedMismatch = await controller.appendReliable({
      homeDir: otherHome,
      agentRef,
      sessionRef: 'session-home-bound-cached-mismatch',
      payload: { status: 'wrong-home-cached' },
      eventId: '5717a541-577a-43ce-a594-bab1949bb609',
    });
    expect(cachedMismatch).toEqual({ ok: false, reason: 'backpressure' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(controller.reliableRecords()).toMatchObject([
      { eventId: 'aa7d1d93-2194-4490-812f-0550e6f90c79', cursor: 1 },
    ]);
    expect(controller.reliableRecords()).toHaveLength(1);
  });

  it('keeps denied content receipts durable and content-free across crash/restart until an exact ack', async () => {
    const agentHome = await home('content-receipt-restart');
    const spool = await AgentReliableSpool.open(agentHome);
    const record = await spool.appendContentReceipt({
      agentRef,
      tenantId: 'tenant-content',
      policyRevision: DEFAULT_AGENT_EGRESS_POLICY.policyRevision,
      sessionRef: 'session-content',
      payload: {
        requestId: 'f0000000-0000-4000-8000-000000000001',
        surface: 'workspace',
        actor: { kind: 'user', id: 'content-user' },
        agentRef,
        sessionRef: 'session-content',
        runtime: 'pi',
        cwd: '/agents/agent-spool',
        policyRevision: DEFAULT_AGENT_EGRESS_POLICY.policyRevision,
        target: 'host-only-secret.txt',
        mimeType: 'text/plain',
        decodeAs: 'utf8',
        decision: 'denied',
        byteCount: 0,
        reason: 'sensitive-name',
      },
    }, DEFAULT_AGENT_EGRESS_POLICY, 0);
    expect(record.wireType).toBe('agent.content.receipt');
    expect(record.payload).toMatchObject({ eventId: 'f0000000-0000-4000-8000-000000000001', cursor: 1, decision: 'denied' });
    const raw = await readFile(path.join(agentHome, '.byok', 'egress', 'reliable-v1.jsonl'), 'utf8');
    expect(raw).not.toContain('host-only-secret bytes');
    expect(raw).not.toContain('inline');

    const restarted = await AgentReliableSpool.open(agentHome);
    expect(restarted.records()).toEqual([record]);
    expect(await restarted.acknowledge({
      agentRef,
      tenantId: 'tenant-content',
      sessionRef: 'session-content',
      policyRevision: record.policyRevision,
      eventId: record.eventId,
      cursor: record.cursor + 1,
    })).toBe(false);
    expect(restarted.records()).toEqual([record]);
    expect(await restarted.acknowledge({
      agentRef,
      tenantId: 'tenant-content',
      sessionRef: 'session-content',
      policyRevision: record.policyRevision,
      eventId: record.eventId,
      cursor: record.cursor,
    })).toBe(true);
    expect((await AgentReliableSpool.open(agentHome)).records()).toEqual([]);
  });

  it('enforces tenant quota without silently moving reliable evidence to latest-value', async () => {
    const policy: AgentEgressPolicy = {
      ...DEFAULT_AGENT_EGRESS_POLICY,
      policyRevision: 'quota-r1',
      reliable: { maxPendingEventsPerAgent: 1, maxPendingBytesPerAgent: 1024, maxPendingBytesPerTenant: 1024 },
    };
    const controller = new AgentEgressController({ policy, tenantId: 'tenant-quota' });
    const first = await controller.appendReliable({
      homeDir: await home('quota-one'),
      agentRef,
      sessionRef: 'session-quota',
      payload: { status: 'one' },
      eventId: 'ac6cf0d5-7ba6-4780-a037-5e72c04477cb',
    });
    expect(first.ok).toBe(true);
    const second = await controller.appendReliable({
      homeDir: roots[0]!,
      agentRef,
      sessionRef: 'session-quota',
      payload: { status: 'two' },
      eventId: '49550eb5-0b97-486d-96ca-930452c40a99',
    });
    expect(second).toEqual({ ok: false, reason: 'quota_exceeded' });
    expect(controller.reliableRecords()).toHaveLength(1);
    expect(controller.status().latestValue.pendingEvents).toBe(0);
    expect(controller.status().reliable.lastDropReason).toBe('quota_exceeded');
  });

  it('isolates different Agents while enforcing one tenant-wide byte quota', async () => {
    const policy: AgentEgressPolicy = {
      ...DEFAULT_AGENT_EGRESS_POLICY,
      policyRevision: 'tenant-isolation-r1',
      reliable: { maxPendingEventsPerAgent: 2, maxPendingBytesPerAgent: 1024, maxPendingBytesPerTenant: 31 },
    };
    const controller = new AgentEgressController({ policy, tenantId: 'tenant-isolation' });
    const first = await controller.appendReliable({
      homeDir: await home('isolation-one'),
      agentRef: { agentId: 'agent-one', profileRevision: 'r1' },
      sessionRef: 'session-one',
      payload: { status: 'one' },
    });
    expect(first.ok).toBe(true);
    const second = await controller.appendReliable({
      homeDir: await home('isolation-two'),
      agentRef: { agentId: 'agent-two', profileRevision: 'r1' },
      sessionRef: 'session-two',
      payload: { status: 'two' },
    });
    expect(second).toEqual({ ok: false, reason: 'quota_exceeded' });
    expect(controller.reliableRecords()).toHaveLength(1);
  });

  it('admits at most one cross-Agent reliable append when their combined bytes exceed the tenant ceiling', async () => {
    const policy: AgentEgressPolicy = {
      ...DEFAULT_AGENT_EGRESS_POLICY,
      policyRevision: 'tenant-reliable-race-r1',
      reliable: { maxPendingEventsPerAgent: 2, maxPendingBytesPerAgent: 1024, maxPendingBytesPerTenant: 31 },
    };
    const controller = new AgentEgressController({ policy, tenantId: 'tenant-reliable-race' });
    const originalAppend = AgentReliableSpool.prototype.append;
    let releaseAppend!: () => void;
    const appendMayCommit = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let firstAppendEntered!: () => void;
    const firstAppendStarted = new Promise<void>((resolve) => { firstAppendEntered = resolve; });
    const appendSpy = vi.spyOn(AgentReliableSpool.prototype, 'append').mockImplementation(async function (this: AgentReliableSpool, input, appendPolicy, tenantPendingBytes) {
      firstAppendEntered();
      await appendMayCommit;
      return originalAppend.call(this, input, appendPolicy, tenantPendingBytes);
    });

    const first = controller.appendReliable({
      homeDir: await home('tenant-reliable-race-one'),
      agentRef: { agentId: 'agent-race-one', profileRevision: 'r1' },
      sessionRef: 'session-race-one',
      eventId: '81000000-0000-4000-8000-000000000001',
      payload: { status: 'one' },
    });
    await firstAppendStarted;
    const second = controller.appendReliable({
      homeDir: await home('tenant-reliable-race-two'),
      agentRef: { agentId: 'agent-race-two', profileRevision: 'r1' },
      sessionRef: 'session-race-two',
      eventId: '81000000-0000-4000-8000-000000000002',
      payload: { status: 'two' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseAppend();

    const results = await Promise.all([first, second]);
    appendSpy.mockRestore();
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(controller.status().reliable.pendingBytes).toBeLessThanOrEqual(policy.reliable.maxPendingBytesPerTenant);
  });

  it('accounts for a reliable append racing a content receipt across Agent spools', async () => {
    const policy: AgentEgressPolicy = {
      ...DEFAULT_AGENT_EGRESS_POLICY,
      policyRevision: 'tenant-content-receipt-race-r1',
      reliable: { maxPendingEventsPerAgent: 2, maxPendingBytesPerAgent: 2048, maxPendingBytesPerTenant: 1024 },
    };
    const controller = new AgentEgressController({ policy, tenantId: 'tenant-content-receipt-race' });
    const originalAppend = AgentReliableSpool.prototype.append;
    let releaseAppend!: () => void;
    const appendMayCommit = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let firstAppendEntered!: () => void;
    const firstAppendStarted = new Promise<void>((resolve) => { firstAppendEntered = resolve; });
    const appendSpy = vi.spyOn(AgentReliableSpool.prototype, 'append').mockImplementation(async function (this: AgentReliableSpool, input, appendPolicy, tenantPendingBytes) {
      firstAppendEntered();
      await appendMayCommit;
      return originalAppend.call(this, input, appendPolicy, tenantPendingBytes);
    });

    const firstAgent = { agentId: 'agent-content-race-one', profileRevision: 'r1' };
    const secondAgent = { agentId: 'agent-content-race-two', profileRevision: 'r1' };
    const reliable = controller.appendReliable({
      homeDir: await home('tenant-content-receipt-race-one'),
      agentRef: firstAgent,
      sessionRef: 'session-content-race-one',
      eventId: '81000000-0000-4000-8000-000000000011',
      payload: { status: 'x'.repeat(800) },
    });
    await firstAppendStarted;
    const receipt = controller.appendContentReceipt({
      homeDir: await home('tenant-content-receipt-race-two'),
      agentRef: secondAgent,
      payload: {
        requestId: '81000000-0000-4000-8000-000000000012',
        surface: 'workspace',
        actor: { kind: 'user', id: 'content-user' },
        agentRef: secondAgent,
        sessionRef: 'session-content-race-two',
        runtime: 'pi',
        cwd: '/agents/agent-content-race-two',
        policyRevision: policy.policyRevision,
        target: 'report.txt',
        mimeType: 'text/plain',
        decodeAs: 'utf8',
        decision: 'denied',
        byteCount: 0,
        reason: 'sensitive-name',
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseAppend();

    const results = await Promise.all([reliable, receipt]);
    appendSpy.mockRestore();
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(controller.status().reliable.pendingBytes).toBeLessThanOrEqual(policy.reliable.maxPendingBytesPerTenant);
  });

  it('releases the tenant append operation after a durable append fails', async () => {
    const policy: AgentEgressPolicy = {
      ...DEFAULT_AGENT_EGRESS_POLICY,
      policyRevision: 'tenant-append-failure-r1',
      reliable: { maxPendingEventsPerAgent: 2, maxPendingBytesPerAgent: 1024, maxPendingBytesPerTenant: 1024 },
    };
    const controller = new AgentEgressController({ policy, tenantId: 'tenant-append-failure' });
    vi.spyOn(AgentReliableSpool.prototype, 'append').mockImplementationOnce(async () => {
      throw new Error('simulated durable append failure');
    });

    const failed = await controller.appendReliable({
      homeDir: await home('tenant-append-failure-one'),
      agentRef: { agentId: 'agent-failure-one', profileRevision: 'r1' },
      sessionRef: 'session-failure-one',
      eventId: '81000000-0000-4000-8000-000000000021',
      payload: { status: 'fails' },
    });
    expect(failed).toEqual({ ok: false, reason: 'backpressure' });

    const accepted = await controller.appendReliable({
      homeDir: await home('tenant-append-failure-two'),
      agentRef: { agentId: 'agent-failure-two', profileRevision: 'r1' },
      sessionRef: 'session-failure-two',
      eventId: '81000000-0000-4000-8000-000000000022',
      payload: { status: 'after-failure' },
    });
    expect(accepted.ok).toBe(true);
  });

  it('keeps one latest value per Agent without applying the reliable per-Agent event quota to tenant peers', () => {
    const latest = new AgentLatestValueState();
    const policy: AgentEgressPolicy = {
      ...DEFAULT_AGENT_EGRESS_POLICY,
      policyRevision: 'latest-agent-isolation-r1',
      reliable: { maxPendingEventsPerAgent: 1, maxPendingBytesPerAgent: 1024, maxPendingBytesPerTenant: 1024 },
    };
    expect(latest.offer({
      agentRef: { agentId: 'agent-latest-one', profileRevision: 'r1' },
      tenantId: 'tenant-latest',
      event: { type: 'progress', text: 'one' },
    }, policy)).toMatchObject({ accepted: true, replaced: false });
    expect(latest.offer({
      agentRef: { agentId: 'agent-latest-two', profileRevision: 'r1' },
      tenantId: 'tenant-latest',
      event: { type: 'progress', text: 'two' },
    }, policy)).toMatchObject({ accepted: true, replaced: false });
    expect(latest.pendingEvents).toBe(2);
  });

  it('fails closed when restart recovery finds a spool under another Agent or tenant home', async () => {
    const storageRoot = await home('recovery-root');
    const agentsRoot = path.join(storageRoot, 'agents');
    await mkdir(agentsRoot);
    const originalHome = path.join(agentsRoot, 'agent-original');
    await mkdir(originalHome);
    const spool = await AgentReliableSpool.open(originalHome);
    await spool.append({
      agentRef: { agentId: 'agent-original', profileRevision: 'r1' },
      tenantId: 'tenant-original',
      policyRevision: DEFAULT_AGENT_EGRESS_POLICY.policyRevision,
      payload: { status: 'pending' },
      sessionRef: 'session-original',
    }, DEFAULT_AGENT_EGRESS_POLICY, 0);

    const movedHome = path.join(agentsRoot, 'agent-moved');
    await rename(originalHome, movedHome);
    await expect(new AgentEgressController({
      policy: DEFAULT_AGENT_EGRESS_POLICY,
      tenantId: 'tenant-original',
    }).recover(agentsRoot)).rejects.toThrow(/claims Agent agent-original/);

    await rename(movedHome, originalHome);
    await expect(new AgentEgressController({
      policy: DEFAULT_AGENT_EGRESS_POLICY,
      tenantId: 'tenant-other',
    }).recover(agentsRoot)).rejects.toThrow(/different tenant/);
  });
});

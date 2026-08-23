import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEgressPolicy } from '@byok-sdk/protocol';
import { AgentEgressController } from '../daemon/agent-egress-controller';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentReliableSpool } from '../daemon/agent-egress-spool';

const roots: string[] = [];
const agentRef = { agentId: 'agent-spool', profileRevision: 'r1' };

async function home(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `byok-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
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

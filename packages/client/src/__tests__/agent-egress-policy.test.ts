import { testScratchRoot } from "./fixtures/execution-scratch";
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEgressPolicy, AgentEvent } from '@byok-sdk/protocol';
import { AgentEgressController } from '../daemon/agent-egress-controller';
import {
  DEFAULT_AGENT_EGRESS_POLICY,
  AgentEgressPolicyError,
  resolveAgentEgressPolicy,
} from '../daemon/agent-egress-policy';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const agentRef = { agentId: 'agent-egress-policy', profileRevision: 'r1' };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Synthetic content of every kind the removed sanitizer used to replace or drop.
const TRAJECTORY = 'trajectory SECRET=synthetic-value /private/path --argv synthetic';
const SPILL = {
  field: 'output' as const,
  totalBytes: 3_145_728,
  omittedBytes: 3_145_700,
  contentType: 'application/json' as const,
  blob: {
    blobId: 'blob_spilled_tool_output',
    contentHash: `sha256:${'c'.repeat(64)}`,
    size: 3_145_728,
    contentType: 'application/json',
  },
};
const RUNTIME_EVENTS: readonly AgentEvent[] = [
  { type: 'progress', text: TRAJECTORY },
  { type: 'tool_use', tool: '/private/path/tool', input: { prompt: TRAJECTORY, env: { SECRET: TRAJECTORY }, argv: [TRAJECTORY] } },
  { type: 'tool_result', tool: 'bash', isError: false, output: { preview: { head: 'HEAD-BYTES', tail: 'TAIL-BYTES' } }, spill: SPILL },
  { type: 'artifact', name: 'report.md', contentType: 'text/markdown' },
  { type: 'needs_approval', summary: TRAJECTORY },
  { type: 'error', message: TRAJECTORY },
];

describe('Agent egress goes to the Host as is', () => {
  it('forwards each runtime event unchanged through the latest-value lane', () => {
    const controller = new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY, tenantId: 'tenant-egress' });
    for (const event of RUNTIME_EVENTS) {
      expect(controller.projectLatestValue({ agentRef, taskId: 'task-as-is', events: [event] })).toEqual([event]);
    }
    expect(controller.status().latestValue.dropped).toBe(0);
  });

  it('sends every error of a batch and coalesces the other events to their last', () => {
    const controller = new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY, tenantId: 'tenant-egress' });
    const progress = { type: 'progress', text: 'writing the report' } as const;
    const error = { type: 'error', message: 'artifact "../secret" escapes the workspace' } as const;
    const artifact = { type: 'artifact', name: 'report.txt', contentType: 'text/plain' } as const;
    expect(controller.projectLatestValue({ agentRef, taskId: 'task-error-kept', events: [progress, error, artifact] })).toEqual([error, artifact]);
  });

  it('counts as coalesced only the accepted events it does not send', () => {
    const controller = new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY, tenantId: 'tenant-egress' });
    const first = { type: 'error', message: 'first failure' } as const;
    const second = { type: 'error', message: 'second failure' } as const;
    expect(controller.projectLatestValue({ agentRef, taskId: 'task-two-errors', events: [first, second] })).toEqual([first, second]);
    expect(controller.status().latestValue).toMatchObject({ replaced: 0, dropped: 0 });
    const progress = { type: 'progress', text: 'step one' } as const;
    const next = { type: 'progress', text: 'step two' } as const;
    expect(controller.projectLatestValue({ agentRef, taskId: 'task-two-progress', events: [progress, first, next] })).toEqual([first, next]);
    expect(controller.status().latestValue).toMatchObject({ replaced: 1, dropped: 0, lastDropReason: 'coalesced' });
  });

  it('drops an error over the event-byte bound like any other event', () => {
    const policy = { ...DEFAULT_AGENT_EGRESS_POLICY, activity: { ...DEFAULT_AGENT_EGRESS_POLICY.activity, maxEventBytes: 64 } };
    const controller = new AgentEgressController({ policy, tenantId: 'tenant-egress' });
    const error = { type: 'error', message: 'x'.repeat(128) } as const;
    expect(controller.projectLatestValue({ agentRef, taskId: 'task-error-bound', events: [error] })).toEqual([]);
    expect(controller.status().latestValue).toMatchObject({ dropped: 1, lastDropReason: 'backpressure' });
  });

  it('appends a contentful reliable payload to the spool unchanged', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'byok-egress-as-is-'));
    roots.push(homeDir);
    const controller = new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY, tenantId: 'tenant-egress' });
    const payload = { text: TRAJECTORY, tool: { input: { argv: [TRAJECTORY] } }, status: 'running' };
    const appended = await controller.appendReliable({ homeDir, agentRef, payload, sessionRef: 'session-as-is' });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.record.payload).toEqual(payload);
  });

  it('refuses a reliable payload that is not a valid wire value before the spool makes it durable', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'byok-egress-invalid-'));
    roots.push(homeDir);
    const controller = new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY, tenantId: 'tenant-egress' });
    const appended = await controller.appendReliable({
      homeDir, agentRef, payload: { text: 'x'.repeat(256 * 1024) }, sessionRef: 'session-invalid',
    });
    expect(appended).toEqual({ ok: false, reason: 'invalid_envelope' });
    expect(controller.reliableRecords()).toEqual([]);
  });

  it('does not reclassify a legacy task that has no AgentRef into the Agent egress lane', () => {
    const controller = new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY });
    const events = [{ type: 'progress', text: 'legacy task reason and progress remain unchanged' }] as const;
    expect(controller.projectLatestValue({
      taskId: 'legacy-task',
      events,
    })).toEqual(events);
  });

  it('rejects a malformed policy instead of selecting a default', () => {
    expect(() => resolveAgentEgressPolicy({
      ...DEFAULT_AGENT_EGRESS_POLICY,
      activity: { delivery: 'latest-value', maxCoalesceMs: 0, maxEventBytes: 1 },
    } as unknown as AgentEgressPolicy)).toThrow(AgentEgressPolicyError);
  });

  it('refuses the removed agentEgress.sanitizer key instead of ignoring it', () => {
    const config = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product',
      serverUrl: 'http://localhost:3000',
      agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY, sanitizer: (value: unknown) => value },
    } as DaemonConfig;
    expect(() => createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter('claude', { kind: 'available' })]))
      .toThrow('DaemonConfig.agentEgress.sanitizer was removed: Agent egress goes to the Host as is');
  });
});

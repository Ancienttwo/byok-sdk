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
      serverUrl: 'http://localhost:3000', workspaceRoot: '/tmp/byok-test-workspace',
      agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY, sanitizer: (value: unknown) => value },
    } as DaemonConfig;
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter('claude', { kind: 'available' })]))
      .toThrow('DaemonConfig.agentEgress.sanitizer was removed: Agent egress goes to the Host as is');
  });
});

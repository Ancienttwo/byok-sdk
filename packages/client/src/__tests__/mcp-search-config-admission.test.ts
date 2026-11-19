import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { ApprovalRegistry } from '../daemon/approvals';
import { TaskRunner } from '../daemon/task-runner';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { acceptClaimSettlement, testIngressBudget } from './fixtures/activity-ingress';
import { testScratchOwner } from './fixtures/execution-scratch';
import { observationOf } from './fixtures/mcp-observation';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

function snapshot(exposure: 'direct' | 'search', command: string) {
  return new McpToolsetRegistry({ host: { exposure, mcpServers: { host: { command } } } }).snapshot().toolsets;
}

function setup(getMcpToolsets: () => ReturnType<typeof snapshot>) {
  const adapter = new StubRuntimeAdapter('claude', { kind: 'available' }, {
    steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
  });
  const sent: Envelope[] = [];
  const probe = vi.fn(async () => observationOf({ host: ['echo'] }).host!);
  const runner = new TaskRunner({
    ...testAgentHomeDeps(),
    adapters: [adapter],
    deviceId: 'device-1',
    productId: 'mcp-search-admission',
    storeDir: 'unused-store-dir',
    send: (envelope) => sent.push(envelope),
    blobClient: {
      async resolveInstruction() { throw new Error('not used'); },
      async uploadArtifact() { throw new Error('not used'); },
    },
    approvalRegistry: new ApprovalRegistry(),
    agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    advertisedCapabilities: advertiseEveryDeviceFlag,
    getIngressBudget: testIngressBudget,
    awaitClaimSettlement: acceptClaimSettlement,
    scratchRoot: testScratchOwner(),
    mcpToolsetToolsProbe: probe,
    getMcpToolsets,
  });
  const taskId = 'search-admission';
  const offer = createEnvelope('task.offer', {
    agentRef: freshTestAgentRef(), session: { mode: 'fresh' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    instruction: 'test instruction', target: { lane: 'runtime', runtimeId: 'claude' }, requiredToolsets: ['host'],
  }, { taskId, seq: 1 });
  return {
    adapter, sent, probe,
    run: () => runner.handleEnvelope(offer),
    cancel: () => runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId, seq: 2 })),
  };
}

it('declines ordinary search offers before runtime detection, probing or claim', async () => {
  const search = snapshot('search', process.execPath);
  const { adapter, sent, probe, run, cancel } = setup(() => search);
  const detect = vi.spyOn(adapter, 'detect');
  try {
    await run();
    expect(sent.map((envelope) => envelope.type)).toEqual(['task.decline']);
    expect(sent[0]!.payload).toMatchObject({
      reason: 'MCP toolset "host" requires search exposure, which is unavailable on this device', retryable: true,
    });
    expect(detect).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(adapter.startCalls).toHaveLength(0);
  } finally {
    await cancel();
  }
});

it('checks exposure and projects servers from the same registry snapshot', async () => {
  const direct = snapshot('direct', process.execPath);
  const search = snapshot('search', process.execPath + '-search');
  const getMcpToolsets = vi.fn(() => search).mockReturnValueOnce(direct);
  const { adapter, sent, probe, run, cancel } = setup(getMcpToolsets);
  try {
    await run();
    expect(getMcpToolsets).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sent.map((envelope) => envelope.type)).toEqual(['task.claim', 'task.started']);
    expect(adapter.startCalls[0]?.ctx.mcpServers?.host?.command).toBe(process.execPath);
  } finally {
    await cancel();
  }
});

import { createEnvelope, type Envelope, type TaskOfferPlainPayload } from '@byok-sdk/protocol';
import { expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { ApprovalRegistry } from '../daemon/approvals';
import { TaskRunner } from '../daemon/task-runner';
import { admitOfferLimits } from '../daemon/task-runner/offer-admission';
import { OfferAdmissionTiming } from '../daemon/task-runner/offer-admission-timing';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { testHarnesses, acceptClaimSettlement, testIngressBudget } from './fixtures/activity-ingress';
import { testScratchOwner } from './fixtures/execution-scratch';
import { observationOf } from './fixtures/mcp-observation';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

function snapshot(exposure: 'direct' | 'search', command: string) {
  return new McpToolsetRegistry({ host: { exposure, mcpServers: { host: { command } } } }).snapshot();
}

function setup(getMcpToolsetSnapshot: () => ReturnType<typeof snapshot>) {
  const adapter = new StubRuntimeAdapter('claude', { kind: 'available' }, {
    steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
  });
  const sent: Envelope[] = [];
  const probe = vi.fn(async () => observationOf({ host: ['echo'] }).host!);
  const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); },
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
    getMcpToolsetSnapshot,
  });
  const taskId = 'search-admission';
  const payload: TaskOfferPlainPayload = {
    agentRef: freshTestAgentRef(), session: { mode: 'fresh' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    instruction: 'test instruction', target: { lane: 'harness', harnessId: 'claude', selection: { mode: 'device-default' } }, requiredToolsets: ['host'],
  };
  const offer = createEnvelope('task.offer', payload, { taskId, seq: 1 });
  return {
    adapter, sent, probe, runner, taskId, payload,
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
      reason: 'MCP search exposure is unavailable on this device for the requested runtime or version', retryable: true,
    });
    expect(detect).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(adapter.startCalls).toHaveLength(0);
  } finally {
    await cancel();
  }
});

it('declines native-sessions in search admission before runtime selection', () => {
  const search = snapshot('search', process.execPath);
  const { runner, taskId, payload } = setup(() => search);
  const decline = vi.fn();
  // The wire selection rule already rejects the combination. Exercise the
  // separate limits boundary with the same payload shape.
  const result = admitOfferLimits.call(runner, {
    taskId, decline, admissionWithdrawn: () => false,
    admissionSignal: new AbortController().signal,
    releaseReservation() {}, reserveHome() {}, admission: new OfferAdmissionTiming(),
  }, {
    ...payload, target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } },
    agentMemory: 'none', nativeSessions: { fromMs: 1, toMs: 2 },
  });
  expect(result).toBeUndefined();
  expect(decline).toHaveBeenCalledExactlyOnceWith({
    reason: 'native-sessions require direct exposure for MCP toolset "host"',
    retryable: false, code: 'unsupported_input',
  });
});

it('checks exposure and projects servers from the same registry snapshot', async () => {
  const direct = snapshot('direct', process.execPath);
  const search = snapshot('search', process.execPath + '-search');
  const getMcpToolsetSnapshot = vi.fn(() => search).mockReturnValueOnce(direct);
  const { adapter, sent, probe, run, cancel } = setup(getMcpToolsetSnapshot);
  try {
    await run();
    expect(getMcpToolsetSnapshot).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sent.map((envelope) => envelope.type)).toEqual(['task.claim', 'task.started']);
    expect(adapter.startCalls[0]?.ctx.mcpServers?.host?.command).toBe(process.execPath);
  } finally {
    await cancel();
  }
});

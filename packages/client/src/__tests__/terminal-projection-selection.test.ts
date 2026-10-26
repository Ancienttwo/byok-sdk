import { testScratchOwner } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, RESULT_ISSUES_MAX_COUNT, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AGENT_RESULT_DIRECTORY, AgentResultStore } from '../daemon/agent-result-store';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import {
  RESULT_NOT_SUBMITTED_REASON_PREFIX,
  TaskRunner,
  type TaskRunnerDeps,
} from '../daemon/task-runner';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'score'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    score: { type: 'integer', minimum: 0, maximum: 10 },
    notes: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 3 },
  },
} as const;
const SELECTION = { mode: 'result-document', contract: 'example.review.v1', schema: SCHEMA } as const;
const AGENT_REF = { agentId: 'review-agent', profileRevision: '7' } as const;

async function harness(overrides: Partial<TaskRunnerDeps> = {}) {
  const sent: Envelope[] = [];
  const hostStorageRoot = await temporary('byok-result-home-');
  const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
    steer: false, resume: true, approvalInteractive: false, mcpToolsets: true,
  });
  const preflight = vi.fn<NonNullable<TaskRunnerDeps['agentResultMcpPreflight']>>(async () => {});
  const storeDir = await temporary('byok-result-control-');
  const deps: TaskRunnerDeps = { getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    agentHome: new AgentHomeManager({ hostStorageRoot }),
    agentSessionHandoffs: new AgentSessionHandoffStore(),
    deviceId: 'device-result',
    send: (envelope) => sent.push(envelope),
    blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'result-test',
    tenantId: 'tenant-result',
    agentResultMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-result-mcp.js'] },
    agentResultMcpPreflight: preflight,
    ...overrides,
  };
  return { adapter, runner: new TaskRunner(deps), sent, preflight, storeDir, hostStorageRoot };
}

async function offerResult(runner: TaskRunner, taskId: string, terminalProjection: unknown = SELECTION): Promise<void> {
  await runner.handleEnvelope(createEnvelope('task.offer_for_agent', {
    instruction: 'review', runtime: 'pi', agentRef: AGENT_REF,
    terminalProjection: terminalProjection as typeof SELECTION,
  }, { taskId, seq: 1 }));
}

function resultToken(adapter: StubRuntimeAdapter, index = 0): string {
  const token = adapter.startCalls[index]?.ctx.mcpServers?.byokagentresult?.env?.BYOK_AGENT_RESULT_CONTEXT;
  if (token === undefined) throw new Error('result helper was not injected');
  return token;
}

function terminal(sent: Envelope[], taskId: string): Envelope | undefined {
  return sent.find((e) => e.task_id === taskId && (e.type === 'task.complete' || e.type === 'task.fail' || e.type === 'task.cancelled'));
}

async function waitForTerminal(sent: Envelope[], taskId: string): Promise<Envelope> {
  await vi.waitFor(() => expect(terminal(sent, taskId)).toBeDefined());
  return terminal(sent, taskId)!;
}

function noDocumentAnywhere(sent: Envelope[]): void {
  expect(sent.some((e) => JSON.stringify(e.payload).includes('"document"'))).toBe(false);
}

async function stagedOnDisk(hostStorageRoot: string, taskId: string) {
  return (await AgentResultStore.open(path.join(await fs.realpath(hostStorageRoot), 'agents', AGENT_REF.agentId))).get(taskId);
}

describe('submit_result: injection and describe', () => {
  it('injects the reserved helper with only the context token and serves the frozen schema over describe', async () => {
    const { adapter, runner, preflight, storeDir } = await harness();
    await offerResult(runner, 'describe-task');
    const server = adapter.startCalls[0]!.ctx.mcpServers!.byokagentresult!;
    expect(server).toMatchObject({
      command: process.execPath,
      args: ['/sdk/byok-agent-result-mcp.js'],
      env: { BYOK_STORE_DIR: storeDir, BYOK_PRODUCT_ID: 'result-test' },
    });
    // R3: the schema never travels by env or argv.
    expect(JSON.stringify(server)).not.toContain('verdict');
    expect(Object.keys(server.env!).sort()).toEqual(['BYOK_AGENT_RESULT_CONTEXT', 'BYOK_PRODUCT_ID', 'BYOK_STORE_DIR']);
    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight.mock.calls[0]![0]).toEqual(server);
    const described = runner.describeAgentResult({ contextToken: resultToken(adapter) });
    expect(described).toMatchObject({ name: 'submit_result', inputSchema: SCHEMA });
    expect(() => runner.describeAgentResult({ contextToken: '0'.repeat(64) })).toThrow(/invalid or expired/);
    await runner.shutdownActiveTasks('test cleanup');
  });

  it('does not inject the result helper for mode none and completes without a document', async () => {
    const { adapter, runner, sent } = await harness();
    await offerResult(runner, 'none-task', { mode: 'none' });
    expect(adapter.startCalls[0]!.ctx.mcpServers?.byokagentresult).toBeUndefined();
    adapter.sessions[0]!.emit({ type: 'progress', text: 'done' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    const done = await waitForTerminal(sent, 'none-task');
    expect(done.type).toBe('task.complete');
    expect(done.payload).not.toHaveProperty('document');
  });

  it('declines a result-document offer when the preflight cannot list submit_result', async () => {
    const { adapter, runner, sent } = await harness({ agentResultMcpPreflight: async () => { throw new Error('helper tools/list omitted submit_result'); } });
    await offerResult(runner, 'preflight-task');
    expect(adapter.startCalls).toHaveLength(0);
    expect(sent.find((e) => e.type === 'task.decline')).toMatchObject({
      payload: { retryable: false, reason: expect.stringContaining('required Agent result helper preflight failed') },
    });
  });
});

describe('submit_result: admission (R6, R8)', () => {
  it.each([
    ['no result helper', { agentResultMcpBin: undefined }, /cannot host the submit_result channel/],
    ['no enrolled tenant', { tenantId: undefined }, /cannot host the submit_result channel/],
  ] as const)('declines non-retryably with %s', async (_label, overrides, reason) => {
    const { adapter, runner, sent } = await harness(overrides as Partial<TaskRunnerDeps>);
    await offerResult(runner, 'declined-task');
    expect(adapter.startCalls).toHaveLength(0);
    const decline = sent.find((e) => e.type === 'task.decline');
    expect(decline).toMatchObject({ payload: { retryable: false } });
    expect(decline?.type === 'task.decline' ? decline.payload.reason : '').toMatch(reason);
    expect(decline?.payload).not.toHaveProperty('code');
  });
});

describe('submit_result: stage, ack and turn_end', () => {
  it('stages a valid outcome, returns the same receipt for the same content and delivers it as the document', async () => {
    const { adapter, runner, sent, hostStorageRoot } = await harness();
    await offerResult(runner, 'valid-task');
    const contextToken = resultToken(adapter);
    const first = await runner.submitAgentResult({ contextToken, outcome: { verdict: 'pass', score: 9 } });
    expect(first).toMatchObject({ state: 'staged', receiptId: expect.any(String) });
    // Same content in another key order is the same staged record.
    const again = await runner.submitAgentResult({ contextToken, outcome: { score: 9, verdict: 'pass' } });
    expect(again).toEqual(first);
    await expect(runner.submitAgentResult({ contextToken, outcome: { verdict: 'fail', score: 1 } }))
      .rejects.toThrow(/already staged a different result/);
    const record = await stagedOnDisk(hostStorageRoot, 'valid-task');
    expect(record).toMatchObject({
      schema: 1, taskId: 'valid-task', tenantId: 'tenant-result', agentRef: AGENT_REF,
      contract: 'example.review.v1', outcome: { verdict: 'pass', score: 9 },
      receiptId: first.state === 'staged' ? first.receiptId : '',
    });
    adapter.sessions[0]!.emit({ type: 'progress', text: 'reviewed' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    const done = await waitForTerminal(sent, 'valid-task');
    expect(done.type).toBe('task.complete');
    expect(done.payload).toMatchObject({ document: { verdict: 'pass', score: 9 }, summary: 'reviewed' });
    // The context is revoked at turn_end.
    await expect(runner.submitAgentResult({ contextToken, outcome: { verdict: 'pass', score: 9 } }))
      .rejects.toThrow(/invalid or expired/);
  });

  it('acks only after the outcome is on disk: a fault between stage and ack loses nothing and a resubmit returns the staged receipt', async () => {
    const { adapter, runner, sent, hostStorageRoot } = await harness();
    await offerResult(runner, 'fault-task');
    const contextToken = resultToken(adapter);
    const stage = AgentResultStore.prototype.stage;
    let stagedReceipt: string | undefined;
    const spy = vi.spyOn(AgentResultStore.prototype, 'stage').mockImplementationOnce(async function (this: AgentResultStore, ...args) {
      const record = await stage.apply(this, args);
      stagedReceipt = record.receiptId;
      // Before the ack: the record must already be durable and readable by a fresh store.
      expect(await stagedOnDisk(hostStorageRoot, 'fault-task')).toMatchObject({ receiptId: record.receiptId });
      throw new Error('injected fault between stage and ack');
    });
    await expect(runner.submitAgentResult({ contextToken, outcome: { verdict: 'pass', score: 4 } })).rejects.toThrow(/injected fault/);
    spy.mockRestore();
    expect(await runner.submitAgentResult({ contextToken, outcome: { verdict: 'pass', score: 4 } }))
      .toEqual({ state: 'staged', receiptId: stagedReceipt });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    expect((await waitForTerminal(sent, 'fault-task')).payload).toMatchObject({ document: { verdict: 'pass', score: 4 } });
  });

  it('rejects an invalid outcome with bounded issues, stores nothing, and accepts a corrected resubmit', async () => {
    const { adapter, runner, sent, hostStorageRoot } = await harness();
    await offerResult(runner, 'invalid-task');
    const contextToken = resultToken(adapter);
    const rejected = await runner.submitAgentResult({ contextToken, outcome: { verdict: 'maybe', score: 11, extra: true } });
    expect(rejected).toMatchObject({ state: 'rejected', reason: 'schema-mismatch', truncated: false });
    if (rejected.state !== 'rejected') throw new Error('unreachable');
    expect(rejected.issues.length).toBeGreaterThan(0);
    expect(rejected.issues.length).toBeLessThanOrEqual(RESULT_ISSUES_MAX_COUNT);
    for (const issue of rejected.issues) expect(issue).toEqual({ pointer: expect.any(String), keyword: expect.any(String), message: expect.any(String) });
    const tooBig = await runner.submitAgentResult({ contextToken, outcome: { verdict: 'pass', score: 1, notes: ['x'.repeat(70_000)] } });
    expect(tooBig).toMatchObject({ state: 'rejected', reason: 'over-cap' });
    expect(await stagedOnDisk(hostStorageRoot, 'invalid-task')).toBeUndefined();
    const home = path.join(await fs.realpath(hostStorageRoot), 'agents', AGENT_REF.agentId, AGENT_RESULT_DIRECTORY);
    expect(await fs.readdir(home)).toEqual([]);
    expect(await runner.submitAgentResult({ contextToken, outcome: { verdict: 'fail', score: 0 } })).toMatchObject({ state: 'staged' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    expect((await waitForTerminal(sent, 'invalid-task')).payload).toMatchObject({ document: { verdict: 'fail', score: 0 } });
  });

  it('fails non-retryably when the turn ends with nothing staged and never derives a document from text', async () => {
    const { adapter, runner, sent } = await harness();
    await offerResult(runner, 'missing-task');
    adapter.sessions[0]!.emit({ type: 'progress', text: '{"verdict":"pass","score":9}' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    const failure = await waitForTerminal(sent, 'missing-task');
    expect(failure.type).toBe('task.fail');
    if (failure.type !== 'task.fail') throw new Error('unreachable');
    expect(failure.payload.retryable).toBe(false);
    expect(failure.payload.reason.startsWith(RESULT_NOT_SUBMITTED_REASON_PREFIX)).toBe(true);
    expect(failure.payload.reason).toContain('example.review.v1');
    noDocumentAnywhere(sent);
  });

  it('a runtime failure after staging reports task.fail with no document', async () => {
    const { adapter, runner, sent, hostStorageRoot } = await harness();
    await offerResult(runner, 'failed-task');
    await runner.submitAgentResult({ contextToken: resultToken(adapter), outcome: { verdict: 'pass', score: 3 } });
    adapter.sessions[0]!.fail(new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure', retry: 'retryable', reason: 'runtime exited' }));
    expect((await waitForTerminal(sent, 'failed-task')).type).toBe('task.fail');
    noDocumentAnywhere(sent);
    // The staged record stays as local audit evidence only.
    expect(await stagedOnDisk(hostStorageRoot, 'failed-task')).toMatchObject({ outcome: { verdict: 'pass', score: 3 } });
  });

  it('a cancel after staging reports task.cancelled with no document and revokes the context', async () => {
    const { adapter, runner, sent } = await harness();
    await offerResult(runner, 'cancelled-task');
    const contextToken = resultToken(adapter);
    await runner.submitAgentResult({ contextToken, outcome: { verdict: 'pass', score: 3 } });
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'host cancelled' }, { taskId: 'cancelled-task', seq: 2 }));
    expect((await waitForTerminal(sent, 'cancelled-task')).type).toBe('task.cancelled');
    noDocumentAnywhere(sent);
    await expect(runner.submitAgentResult({ contextToken, outcome: { verdict: 'pass', score: 3 } })).rejects.toThrow(/invalid or expired/);
  });
});

describe('submit_result: one document shape for every runtime lane', () => {
  // Durable Pi gets the same reserved helper (pi-durable-host registers every
  // reserved server's tools as bare durable tools) and the same daemon
  // resolution, so the document is the staged canonical outcome either way.
  it('durable Pi and a CLI runtime produce the identical task.complete document', async () => {
    const documents: unknown[] = [];
    for (const durablePi of [false, true]) {
      const { adapter, runner, sent } = await harness();
      if (durablePi) {
        Object.defineProperty(adapter, 'descriptor', { value: Object.freeze({ ...adapter.descriptor,
          capabilities: Object.freeze({ ...adapter.descriptor.capabilities, durablePi: true }) }) });
      }
      const taskId = durablePi ? 'durable-shape' : 'cli-shape';
      await offerResult(runner, taskId);
      expect(adapter.startCalls[0]!.ctx.mcpServers?.byokagentresult).toBeDefined();
      await runner.submitAgentResult({ contextToken: resultToken(adapter), outcome: { notes: ['a', 'b'], score: 5, verdict: 'pass' } });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      const done = await waitForTerminal(sent, taskId);
      if (done.type !== 'task.complete') throw new Error(`expected task.complete, got ${done.type}`);
      documents.push(done.payload.document);
    }
    expect(documents[1]).toEqual(documents[0]);
    expect(JSON.stringify(documents[1])).toBe(JSON.stringify(documents[0]));
  });
});

describe('submit_result with a required Agent message (R10)', () => {
  it('parks the staged document behind the message gate and delivers both', async () => {
    const { adapter, runner, sent } = await harness({
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: async () => {},
    });
    const taskId = 'message-and-result';
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply and review', runtime: 'pi', agentRef: AGENT_REF, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
      terminalProjection: SELECTION,
    }, { taskId, seq: 1 }));
    const servers = adapter.startCalls[0]!.ctx.mcpServers!;
    expect(Object.keys(servers).sort()).toEqual(['byokagentmessage', 'byokagentresult']);
    await runner.publishAgentMessage({ contextToken: servers.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT!, contentType: 'text/markdown', body: 'reviewed' });
    await runner.submitAgentResult({ contextToken: resultToken(adapter), outcome: { verdict: 'pass', score: 8 } });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminal(sent, taskId)).toBeUndefined();
    const message = sent.find((e) => e.type === 'agent.message.publish');
    if (message?.type !== 'agent.message.publish') throw new Error('missing message publish');
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      agentRef: AGENT_REF, sessionRef: message.payload.sessionRef, contract: message.payload.contract,
      messageId: message.payload.messageId, cursor: message.payload.cursor, contentHash: message.payload.contentHash,
      outcome: 'accepted', receiptId: '10000000-0000-4000-8000-000000000009',
    }, { taskId, seq: 2 }));
    const done = await waitForTerminal(sent, taskId);
    expect(done.type).toBe('task.complete');
    expect(done.payload).toMatchObject({ document: { verdict: 'pass', score: 8 } });
  });

  it('a message-required task without a staged result accepts its reply before failing result_not_submitted', async () => {
    const recordFailure = vi.fn<NonNullable<TaskRunnerDeps['recordResultReplyFailure']>>(async () => {});
    const { adapter, runner, sent } = await harness({
      recordResultReplyFailure: recordFailure,
      agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: async () => {},
    });
    const taskId = 'message-no-result';
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'reply', runtime: 'pi', agentRef: AGENT_REF, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
      terminalProjection: SELECTION,
    }, { taskId, seq: 1 }));
    adapter.sessions[0]!.emit({ type: 'progress', text: 'reply text' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some(e => e.type === 'agent.message.publish')).toBe(true));
    expect(recordFailure).toHaveBeenCalledWith(taskId, 'required-reply-result-missing');
    expect(terminal(sent, taskId)).toBeUndefined();
    const message = sent.find(e => e.type === 'agent.message.publish');
    if (message?.type !== 'agent.message.publish') throw new Error('missing message publish');
    expect(message.payload.body).toBe('reply text');
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      agentRef: AGENT_REF, sessionRef: message.payload.sessionRef, contract: message.payload.contract,
      messageId: message.payload.messageId, cursor: message.payload.cursor, contentHash: message.payload.contentHash,
      outcome: 'accepted', receiptId: '10000000-0000-4000-8000-000000000010',
    }, { taskId, seq: 2 }));
    const failure = await waitForTerminal(sent, taskId);
    expect(failure).toMatchObject({ type: 'task.fail', payload: { retryable: false, reason: expect.stringContaining(RESULT_NOT_SUBMITTED_REASON_PREFIX) } });
    expect(failure.payload).not.toHaveProperty('document');
    expect(sent.filter(e => e.type === 'agent.message.publish')).toHaveLength(1);
  });
});

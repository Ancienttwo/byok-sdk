import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX, TaskRunner, type ResultDocumentTask } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function temporary(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function harness(extract: (output: string, task: ResultDocumentTask) => unknown) {
  const sent: Envelope[] = [];
  const adapter = new StubRuntimeAdapter('pi');
  const runner = new TaskRunner({
    adapters: [adapter],
    workspaceRoot: await temporary('byok-terminal-workspace-'),
    agentHome: new AgentHomeManager({ hostStorageRoot: await temporary('byok-terminal-home-') }),
    agentSessionHandoffs: new AgentSessionHandoffStore(),
    deviceId: 'device-terminal',
    send: (envelope) => sent.push(envelope),
    blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
    sessionWorkspaces: new SessionWorkspaceStore(await temporary('byok-terminal-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: await temporary('byok-terminal-control-'),
    productId: 'terminal-test',
    resultDocument: { extract },
    getServerCapabilities: () => ['result-document'],
  });
  return { adapter, runner, sent };
}

describe('offer-scoped terminal projection selection', () => {
  it('passes exact result contract authority to the extractor and emits its document', async () => {
    const calls: ResultDocumentTask[] = [];
    const { adapter, runner, sent } = await harness((_output, task) => {
      calls.push(task);
      return { kind: 'research-result' };
    });
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent', {
      instruction: 'research', policy: { mode: 'auto' }, runtime: 'pi',
      agentRef: { agentId: 'research-agent', profileRevision: '7' },
      terminalProjection: { mode: 'result-document', contract: 'example.research.v1' },
    }, { taskId: 'research-task', seq: 1 }));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true));
    expect(calls).toEqual([{
      taskId: 'research-task',
      sessionRef: adapter.sessions[0]!.sessionRef,
      terminalProjection: { mode: 'result-document', contract: 'example.research.v1' },
    }]);
    expect(sent.find((envelope) => envelope.type === 'task.complete')).toMatchObject({
      payload: { document: { kind: 'research-result' } },
    });
  });

  it('fails closed when a required result contract produces no document', async () => {
    const { adapter, runner, sent } = await harness(() => undefined);
    await runner.handleEnvelope(createEnvelope('task.offer_for_agent', {
      instruction: 'research', policy: { mode: 'auto' }, runtime: 'pi',
      agentRef: { agentId: 'research-agent', profileRevision: '7' },
      terminalProjection: { mode: 'result-document', contract: 'example.research.v1' },
    }, { taskId: 'research-missing', seq: 1 }));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.fail')).toBe(true));
    const failure = sent.find((envelope) => envelope.type === 'task.fail');
    expect(failure).toMatchObject({ payload: { retryable: false } });
    expect(failure?.type === 'task.fail' ? failure.payload.reason : '').toContain(RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX);
    expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(false);
  });
});

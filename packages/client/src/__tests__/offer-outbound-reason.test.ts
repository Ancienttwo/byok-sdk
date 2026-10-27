import { freshTestAgentRef } from './fixtures/test-agent';
import { testScratchOwner } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AGENT_MESSAGE_DIRECTORY, AgentMessageOutbox } from '../daemon/agent-message-outbox';
import { preflightAgentMessageMcp } from '../daemon/agent-message-mcp-preflight';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { DurableJsonlFile } from '../util/durable-jsonl';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';
import { AgentEgressController } from '../daemon/agent-egress-controller';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

/**
 * `task.decline`, `task.fail` and `task.progress` leave this device. These
 * `handleOffer` reasons forward an error that a runtime adapter, the Agent
 * message outbox, an MCP server probe or the artifact open produced. A Node
 * filesystem error names its absolute path (`ENOENT: ..., open '/path'`), and
 * so does a failed spawn (`spawn /path ENOENT`). Each case makes a real
 * filesystem call or spawn fail and checks that the reason keeps the error
 * but not the path. The roots have a space in the name, like
 * `~/Library/Application Support`, and so do some file names, so the last
 * path segment is checked too.
 */

const AGENT = { agentId: 'outbound-offer-agent', profileRevision: 'profile-1' } as const;

const roots: string[] = [];
async function temporary(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

const blobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used'); },
  uploadArtifact: async () => { throw new Error('not used'); },
};

const MESSAGE_DEPS: Partial<TaskRunnerDeps> = {
  agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
  tenantId: 'tenant-outbound-offer',
  agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
  agentMessageMcpPreflight: async () => {},
};

function agentOffer(taskId: string, seq: number): Envelope {
  return createEnvelope('task.offer', {
    ...FRESH_OFFER, instruction: 'outbound offer work', runtime: 'pi', agentRef: AGENT,
  }, { taskId, seq });
}

function messageOffer(taskId: string, seq: number): Envelope {
  return createEnvelope('task.offer', {
    session: { mode: 'fresh' }, instruction: 'reply', runtime: 'pi', agentRef: AGENT, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    messageEgress: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 1000 },
  }, { taskId, seq });
}

function reasonOf(sent: readonly Envelope[], type: 'task.decline' | 'task.fail', taskId: string): string {
  const envelope = sent.find((entry) => entry.type === type && entry.task_id === taskId);
  expect(envelope, `${type} for ${taskId}`).toBeDefined();
  return (envelope!.payload as { reason: string }).reason;
}

async function runner(adapter: StubRuntimeAdapter, extra: Partial<TaskRunnerDeps> = {}): Promise<{
  runner: TaskRunner; agentHome: AgentHomeManager; sent: Envelope[]; localRoots: string[];
}> {
  const storeDir = await temporary('byok outbound offer store-');
  const hostStorageRoot = await temporary('byok outbound offer home-');
  const agentHome = new AgentHomeManager({ hostStorageRoot });
  const sent: Envelope[] = [];
  const taskRunner = new TaskRunner({ getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY, agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }), scratchRoot: testScratchOwner(),
    adapters: [adapter],
    agentHome,
    agentSessionHandoffs: new AgentSessionHandoffStore(),
    deviceId: 'device-outbound-offer',
    send: (envelope) => sent.push(envelope),
    blobClient,
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'outbound-offer',
    ...extra,
  });
  const localRoots = [storeDir, hostStorageRoot];
  localRoots.push(...await Promise.all(localRoots.map((root) => fs.realpath(root))));
  return { runner: taskRunner, agentHome, sent, localRoots };
}

function expectNoLocalPath(reason: string, localRoots: readonly string[], fileName?: string): void {
  if (fileName !== undefined) expect(reason).not.toContain(fileName);
  for (const root of localRoots) {
    expect(reason).not.toContain(root);
    expect(reason).not.toContain(path.basename(root));
  }
  expect(reason).not.toContain(os.tmpdir());
}

describe('local paths in outbound handleOffer reasons', () => {
  it('runtime detection failed: a filesystem error from detect() names no local path', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner: taskRunner, sent, localRoots } = await runner(adapter);
    const missingBinary = path.join(localRoots[2]!, 'missing runtime', 'pi runtime');
    vi.spyOn(adapter, 'detect').mockImplementationOnce(async () => {
      await fs.access(missingBinary);
      throw new Error('the runtime binary unexpectedly exists');
    });

    await taskRunner.handleEnvelope(agentOffer('detect-path', 1));

    const reason = reasonOf(sent, 'task.decline', 'detect-path');
    expect(reason).toBe("runtime detection failed: ENOENT: no such file or directory, access '<local path>'");
    expectNoLocalPath(reason, localRoots, 'pi runtime');
  });

  it('runtime preparation failed: a filesystem error from prepare() names no local path', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner: taskRunner, sent, localRoots } = await runner(adapter);
    const missingConfig = path.join(localRoots[2]!, 'missing runtime', 'runtime config.json');
    vi.spyOn(adapter, 'prepare').mockImplementationOnce(async () => {
      await fs.writeFile(missingConfig, '{}');
      throw new Error('the runtime config directory unexpectedly exists');
    });

    await taskRunner.handleEnvelope(agentOffer('prepare-path', 1));

    const reason = reasonOf(sent, 'task.decline', 'prepare-path');
    expect(reason).toBe("runtime preparation failed: ENOENT: no such file or directory, open '<local path>'");
    expectNoLocalPath(reason, localRoots, 'config.json');
  });

  it('required Agent message helper preflight failed: a helper that cannot spawn names no local path', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const missingHelper = path.join(await temporary('byok outbound offer helper-'), 'missing helper', 'byok agent message mcp');
    const { runner: taskRunner, sent, localRoots } = await runner(adapter, {
      ...MESSAGE_DEPS,
      agentMessageMcpBin: { command: missingHelper, args: [] },
      agentMessageMcpPreflight: preflightAgentMessageMcp,
    });
    localRoots.push(path.dirname(path.dirname(missingHelper)));

    await taskRunner.handleEnvelope(messageOffer('helper-path', 1));

    const reason = reasonOf(sent, 'task.decline', 'helper-path');
    expect(reason).toBe('required Agent message helper preflight failed: helper failed to start: spawn <local path> ENOENT');
    expectNoLocalPath(reason, localRoots, 'message mcp');
  });

  it('required MCP toolset server could not be observed: a server that cannot spawn names no local path', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const missingServer = path.join(await temporary('byok outbound offer toolset-'), 'missing server', 'team mcp server');
    const { runner: taskRunner, sent, localRoots } = await runner(adapter, {
      getMcpToolsets: () => new Map([['team', { mcpServers: { team: { command: missingServer } } }]]),
    });
    localRoots.push(path.dirname(path.dirname(missingServer)));

    await taskRunner.handleEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER,
      instruction: 'outbound offer work', runtime: 'pi', requiredToolsets: ['team'],
    }, { taskId: 'toolset-path', seq: 1 }));

    const reason = reasonOf(sent, 'task.decline', 'toolset-path');
    expect(reason).toBe(
      'required MCP toolset server "team" could not be observed: MCP toolset server "team" failed to start: spawn <local path> ENOENT',
    );
    expectNoLocalPath(reason, localRoots, 'mcp server');
  });

  it('Agent message outbox initialization failed: a file where the outbox directory goes names no local path', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner: taskRunner, agentHome, sent, localRoots } = await runner(adapter, MESSAGE_DEPS);
    // A first Attempt creates the canonical home the outbox lives in.
    await taskRunner.handleEnvelope(agentOffer('outbox-home', 1));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((entry) => entry.type === 'task.complete' && entry.task_id === 'outbox-home')).toBe(true));
    await vi.waitFor(() => expect(taskRunner.activeTaskCount).toBe(0));
    const messageDirectory = path.join(await agentHome.layout.canonicalHomePath(AGENT), AGENT_MESSAGE_DIRECTORY);
    await fs.mkdir(path.dirname(messageDirectory), { recursive: true });
    await fs.writeFile(messageDirectory, 'not a directory');

    await taskRunner.handleEnvelope(messageOffer('outbox-path', 2));

    const reason = reasonOf(sent, 'task.decline', 'outbox-path');
    expect(reason).toBe("Agent message outbox initialization failed: EEXIST: file already exists, mkdir '<local path>'");
    expectNoLocalPath(reason, localRoots);
  });

  it('runtime activation failed: an outbox append error names no local path', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner: taskRunner, agentHome, sent, localRoots } = await runner(adapter, MESSAGE_DEPS);
    // The append a recovered draft makes at activation, against the outbox
    // directory itself, so the real writer fails with EISDIR.
    vi.spyOn(AgentMessageOutbox.prototype, 'activate').mockImplementationOnce(async () => {
      const home = await agentHome.layout.canonicalHomePath(AGENT);
      await new DurableJsonlFile(path.join(home, AGENT_MESSAGE_DIRECTORY)).append('{}');
      throw new Error('the outbox directory unexpectedly accepted an append');
    });

    try {
      await taskRunner.handleEnvelope(messageOffer('activation-path', 1));

      const reason = reasonOf(sent, 'task.fail', 'activation-path');
      expect(reason).toBe("runtime activation failed: EISDIR: illegal operation on a directory, open '<local path>'");
      expectNoLocalPath(reason, localRoots);
    } finally {
      await taskRunner.shutdownActiveTasks('test cleanup');
    }
  });

  it('artifact could not be opened: the task.progress error names no local path', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner: taskRunner, sent, localRoots } = await runner(adapter);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await taskRunner.handleEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'outbound offer work' }, { taskId: 'artifact-path', seq: 1 }));
    adapter.sessions[0]!.emit({ type: 'artifact', name: 'missing report.txt', contentType: 'text/plain' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((entry) => entry.type === 'task.complete' && entry.task_id === 'artifact-path')).toBe(true));

    const errors = sent
      .filter((entry) => entry.type === 'task.progress' && entry.task_id === 'artifact-path')
      .flatMap((entry) => (entry.payload as { events: Array<{ type: string; message?: string }> }).events)
      .filter((event) => event.type === 'error')
      .map((event) => event.message!);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe('artifact "missing report.txt" could not be opened: ENOENT: no such file or directory, open \'<local path>\'');
    expect(errors[0]).not.toContain(' report.txt\'');
    expectNoLocalPath(errors[0]!.replace('"missing report.txt"', ''), localRoots, 'report.txt');
  });
});

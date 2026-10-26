import { freshTestAgentRef } from './fixtures/test-agent';
/**
 * #654 E3c: every outbound of a task that seals its output goes through one
 * per-task queue, so a plaintext type sent after a sealed one cannot pass it
 * while the sealed one is still being sealed. A task with sealing streams no
 * Agent message draft (decision D9).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { generateScopeKey } from '@byok-sdk/core/sealed-payload';
import { createEnvelope, decodeEnvelope, encodeEnvelope, type Envelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { SealedTasks, type SealedScopeKeyring } from '../daemon/sealed-task';
import { TaskRunner } from '../daemon/task-runner';
import { testIngressBudget } from './fixtures/activity-ingress';
import { testScratchOwner } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/** A keyring whose sealing key waits for `gate`, so a test can hold a seal open. */
class GatedKeyring implements SealedScopeKeyring {
  readonly scopeKey = generateScopeKey();
  gate: Promise<void> = Promise.resolve();
  async scopeCategories() { return []; }
  async openingKey() { return this.scopeKey; }
  async acceptHeader() { return true; }
  async sealingKey() {
    await this.gate;
    return { scopeKey: this.scopeKey, epoch: 1, sender: 'm'.repeat(43), chainHead: { seq: 1, hash: `sha256:${'0'.repeat(64)}` } };
  }
}

describe('SealedTasks send order (#654 E3c)', () => {
  it('keeps a plaintext outbound behind an earlier sealed outbound of the same task', async () => {
    const keyring = new GatedKeyring();
    const tasks = new SealedTasks({
      keyring, tenantId: 'tenant-test', deviceId: 'dev_1',
      blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } },
      serverCapabilities: () => [],
    });
    const opened = await tasks.openOffer(createEnvelope('task.offer_for_agent_sealed', {
      agentRef: freshTestAgentRef(), instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
    } as never, { taskId: 'ordered', seq: 1 }));
    expect(opened.ok).toBe(true);

    let release!: () => void;
    keyring.gate = new Promise<void>((resolve) => { release = resolve; });
    const awaitApproval = createEnvelope('task.await_approval', { summary: 'secret', approvalId: 'a1' }, { taskId: 'ordered' });
    const resolved = createEnvelope('task.approval_resolved', { approvalId: 'a1', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() } as never, { taskId: 'ordered' });
    expect(tasks.sealsOutbound(awaitApproval)).toBe(true);
    expect(tasks.sealsOutbound(resolved)).toBe(true);

    const order: string[] = [];
    const sent = (envelope: Envelope | undefined) => { order.push(envelope!.type); };
    const first = tasks.sealOutbound(awaitApproval).then(sent);
    const second = tasks.sealOutbound(resolved).then(sent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['task.await_approval_sealed', 'task.approval_resolved']);
  });
});

describe('SealedTasks memory after a terminal (#654 E3c)', () => {
  it('keeps no sealed terminal alive once it is handed on', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const tasks = new SealedTasks({
      keyring: new GatedKeyring(), tenantId: 'tenant-test', deviceId: 'dev_1',
      blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } },
      serverCapabilities: () => [],
    });
    await tasks.openOffer(createEnvelope('task.offer_for_agent_sealed', {
      agentRef: freshTestAgentRef(), instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
    } as never, { taskId: 'finished', seq: 1 }));

    const sendTerminal = async (): Promise<WeakRef<Envelope>> => {
      const sealed = await tasks.sealOutbound(createEnvelope('task.complete', { summary: 'r'.repeat(100_000), sessionRef: 'session' }, { taskId: 'finished' }));
      expect(sealed?.type).toBe('task.complete_sealed');
      tasks.plainOf(sealed!);
      return new WeakRef(sealed!);
    };
    const terminal = await sendTerminal();
    await tasks.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    expect(terminal.deref()).toBeUndefined();
    expect(tasks.sealsOutbound(createEnvelope('task.await_approval', { summary: 'late', approvalId: 'a2' }, { taskId: 'finished' }))).toBe(true);
  });
});

describe('Agent message drafts of a sealed task (#654 D9)', () => {
  const runners: TaskRunner[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((runner) => runner.shutdownActiveTasks('test cleanup')));
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function runEgressTask(sealing?: { scopeId: string; epoch: number; categories: Array<'task-input' | 'task-output'> }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-draft-'));
    roots.push(root);
    const storeDir = path.join(root, 'store');
    const sent: Envelope[] = [];
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: true, resume: true, approvalInteractive: false, mcpToolsets: true, messageDraft: true,
    });
    const policy = { ...DEFAULT_AGENT_EGRESS_POLICY, activity: { ...DEFAULT_AGENT_EGRESS_POLICY.activity, maxCoalesceMs: 10 } };
    const sealedTasks = new SealedTasks({
      keyring: new GatedKeyring(), tenantId: 'draft-tenant', deviceId: 'draft-device',
      blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } },
      serverCapabilities: () => [],
    });
    const runner = new TaskRunner({
      getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
      adapters: [adapter], workspaceRoot: path.join(root, 'workspace'),
      agentHome: new AgentHomeManager({ hostStorageRoot: path.join(root, 'home') }),
      agentEgressPolicy: policy, agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'draft-device', tenantId: 'draft-tenant', productId: 'sealed-draft', storeDir,
      getServerCapabilities: () => ['agent-message-draft', 'sealed-payload-v1'], send: (envelope) => { sent.push(envelope); },
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      approvalRegistry: new ApprovalRegistry(),
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: async () => {},
      sealedTasks,
    });
    runners.push(runner);
    const payload = {
      instruction: 'reply', runtime: 'pi', agentRef: { agentId: 'draft-agent', profileRevision: '1' }, egressPolicy: policy,
      messageEgress: { mode: 'required', contract: 'draft.v1', contentType: 'text/plain', maxBytes: 4096 },
    };
    await runner.handleEnvelope(sealing === undefined
      ? createEnvelope('task.offer_for_agent_with_egress_fresh', payload as never, { taskId: 'draft-task', seq: 1 })
      : createEnvelope('task.offer_for_agent_with_egress_fresh_sealed', { ...payload, sealing } as never, { taskId: 'draft-task', seq: 1 }));
    expect(adapter.sessions).toHaveLength(1);
    adapter.sessions[0]!.emit({ type: 'progress', text: 'secret draft text' });
    return { sent };
  }

  it('streams drafts for a plaintext task (control)', async () => {
    const { sent } = await runEgressTask();
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'agent.message.draft')).toBe(true));
  });

  it('creates no draft publisher for a task with sealing', async () => {
    const { sent } = await runEgressTask({ scopeId: 'scope-a', epoch: 1, categories: ['task-output'] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.filter((envelope) => envelope.type === 'agent.message.draft')).toEqual([]);
  });
});

describe('the failure class of a sealed task (#869)', () => {
  const sealedTasks = async (keyring: SealedScopeKeyring, taskId: string, flags: readonly string[] = []) => {
    const tasks = new SealedTasks({ keyring, tenantId: 'tenant-test', deviceId: 'dev_1', blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } }, serverCapabilities: () => flags });
    await tasks.openOffer(createEnvelope('task.offer_for_agent_sealed', {
      agentRef: freshTestAgentRef(), instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
    } as never, { taskId, seq: 1 }));
    return tasks;
  };
  const failure = { class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z' } as const;

  it('stays plaintext on task.fail_sealed', async () => {
    const tasks = await sealedTasks(new GatedKeyring(), 'sealed-fail');
    const sealed = await tasks.sealOutbound(createEnvelope('task.fail', { reason: 'secret reason', retryable: false, failure }, { taskId: 'sealed-fail' }));
    expect(sealed?.type).toBe('task.fail_sealed');
    // The strict sealed decoder accepts it.
    expect(decodeEnvelope(encodeEnvelope(sealed!)).payload).toMatchObject({ retryable: false, failure });
    expect(JSON.stringify(sealed!.payload)).not.toContain('secret reason');
  });

  it('is unknown on a replacement failure the daemon makes, whatever the replaced task.fail carried', async () => {
    // The key is there when the offer opens and gone when the terminal seals.
    const keyless: SealedScopeKeyring = new GatedKeyring();
    const tasks = await sealedTasks(keyless, 'keyless', ['runtime-failure-class']);
    const other = await sealedTasks(keyless, 'keyless-2', ['runtime-failure-class']);
    keyless.sealingKey = async () => undefined;
    const withClass = await tasks.sealOutbound(createEnvelope('task.fail', { reason: 'r', retryable: false, failure }, { taskId: 'keyless' }));
    expect(withClass?.payload).toEqual({ reason: 'sealed_key_unavailable', retryable: false, failure: { class: 'unknown' } });
    const withoutClass = await other.sealOutbound(createEnvelope('task.fail', { reason: 'r', retryable: false }, { taskId: 'keyless-2' }));
    expect(withoutClass?.payload).toEqual({ reason: 'sealed_key_unavailable', retryable: false, failure: { class: 'unknown' } });
  });

  it('carries no class on a replacement failure when the server does not advertise the flag', async () => {
    const keyless: SealedScopeKeyring = new GatedKeyring();
    const tasks = await sealedTasks(keyless, 'keyless-no-flag');
    keyless.sealingKey = async () => undefined;
    const replaced = await tasks.sealOutbound(createEnvelope('task.fail', { reason: 'r', retryable: false, failure }, { taskId: 'keyless-no-flag' }));
    expect(replaced?.payload).toEqual({ reason: 'sealed_key_unavailable', retryable: false });
  });

  it('gives a sealed task.complete that cannot be sealed a class by the live server flags', async () => {
    const keyless: SealedScopeKeyring = new GatedKeyring();
    let flags: readonly string[] | undefined = ['runtime-failure-class'];
    const open = async (taskId: string) => {
      const tasks = new SealedTasks({ keyring: keyless, tenantId: 'tenant-test', deviceId: 'dev_1', blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } }, serverCapabilities: () => flags });
      await tasks.openOffer(createEnvelope('task.offer_for_agent_sealed', {
        agentRef: freshTestAgentRef(), instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
      } as never, { taskId, seq: 1 }));
      return tasks;
    };
    const advertised = await open('complete-flag');
    const without = await open('complete-no-flag');
    const between = await open('complete-between');
    keyless.sealingKey = async () => undefined;
    const complete = (taskId: string) => createEnvelope('task.complete', { summary: 'done', sessionRef: 'session' }, { taskId });

    expect((await advertised.sealOutbound(complete('complete-flag')))?.payload).toEqual({ reason: 'sealed_key_unavailable', retryable: false, failure: { class: 'unknown' } });
    flags = [];
    expect((await without.sealOutbound(complete('complete-no-flag')))?.payload).toEqual({ reason: 'sealed_key_unavailable', retryable: false });
    flags = undefined;
    expect((await between.sealOutbound(complete('complete-between')))?.payload).toEqual({ reason: 'sealed_key_unavailable', retryable: false });
  });
});

describe('a terminal built for a sealed task in a run that may not seal it (#866 R1, R2)', () => {
  const tasks = () => new SealedTasks({
    keyring: new GatedKeyring(), tenantId: 'tenant-test', deviceId: 'dev_1',
    blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } },
    serverCapabilities: () => [],
  });
  const sealedOffer = createEnvelope('task.offer_for_agent_sealed', {
    agentRef: freshTestAgentRef(), instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
  } as never, { taskId: 'recovered', seq: 1 });

  it.each([
    ['an interrupted task.fail with its recovery', createEnvelope('task.fail', {
      reason: 'daemon_interrupted', retryable: false, recovery: { kind: 'daemon_interrupted', offerId: sealedOffer.id },
    } as never, { taskId: 'recovered' })],
    ['a task.decline with its sealed code', createEnvelope('task.decline', { reason: 'sealed_open_failed', code: 'sealed_open_failed', retryable: false } as never, { taskId: 'recovered' })],
    ['a task.cancelled without a reason', createEnvelope('task.cancelled', {} as never, { taskId: 'recovered' })],
  ])('keeps %s, which is already a closed plaintext form', async (_label, terminal) => {
    expect(await tasks().sealRecovered(sealedOffer, terminal, false)).toBe(terminal);
  });

  it('gives any other terminal its closed plaintext form, with no free text', async () => {
    const fail = createEnvelope('task.fail', { reason: 'secret reason', retryable: true, agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' } } as never, { taskId: 'recovered' });
    const closed = await tasks().sealRecovered(sealedOffer, fail, false);
    expect(closed.type).toBe('task.fail');
    expect(closed.payload).toEqual({ reason: 'sealed_key_unavailable', retryable: false, agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' } });
    const cancelled = await tasks().sealRecovered(sealedOffer, createEnvelope('task.cancelled', { reason: 'secret reason' } as never, { taskId: 'recovered' }), false);
    expect(cancelled.payload).toEqual({});
  });

  it('keeps every terminal of a task whose offer does not seal output', async () => {
    const plainOffer = createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'plain instruction' }, { taskId: 'recovered', seq: 1 });
    const fail = createEnvelope('task.fail', { reason: 'plain reason', retryable: false }, { taskId: 'recovered' });
    expect(await tasks().sealRecovered(plainOffer, fail, false)).toBe(fail);
  });
});

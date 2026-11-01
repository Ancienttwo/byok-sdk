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
import { generateScopeKey, openSealedContent, type SealedCategory } from '@byok-sdk/core/sealed-payload';
import { createEnvelope, decodeEnvelope, encodeEnvelope, sealedAgentMessageMaxContentLength, type Envelope, type TaskSealing } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentMessageOutbox } from '../daemon/agent-message-outbox';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { SealedTasks, type SealedScopeKeyring } from '../daemon/sealed-task';
import { TaskRunner } from '../daemon/task-runner';
import { testIngressBudget } from './fixtures/activity-ingress';
import { testScratchOwner } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

/** A keyring whose sealing key waits for `gate`, so a test can hold a seal open. */
class GatedKeyring implements SealedScopeKeyring {
  readonly scopeKey = generateScopeKey();
  gate: Promise<void> = Promise.resolve();
  /** The key is gone, as after a stale epoch. */
  lost = false;
  constructor(private readonly policy: readonly SealedCategory[] = []) {}
  async scopeCategories() { return this.policy; }
  async openingKey() { return this.scopeKey; }
  async acceptHeader() { return true; }
  async sealingKey() {
    await this.gate;
    if (this.lost) return undefined;
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
    const opened = await tasks.openOffer(createEnvelope('task.offer', {
      agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
    } as never, { taskId: 'ordered', seq: 1 }));
    expect(opened.ok).toBe(true);

    let release!: () => void;
    keyring.gate = new Promise<void>((resolve) => { release = resolve; });
    const awaitApproval = createEnvelope('task.await_approval', { summary: 'secret', approvalId: 'a1' }, { taskId: 'ordered' });
    const resolved = createEnvelope('task.approval_resolved', { approvalId: 'a1', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() } as never, { taskId: 'ordered' });
    expect(tasks.sealsOutbound(awaitApproval)).toBe(true);
    expect(tasks.sealsOutbound(resolved)).toBe(true);

    const order: string[] = [];
    const sealedOrder: boolean[] = [];
    const sent = (envelope: Envelope | undefined) => {
      order.push(envelope!.type);
      sealedOrder.push((envelope!.payload as { sealed?: unknown }).sealed !== undefined);
    };
    const first = tasks.sealOutbound(awaitApproval).then(sent);
    const second = tasks.sealOutbound(resolved).then(sent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['task.await_approval', 'task.approval_resolved']);
    expect(sealedOrder).toEqual([true, false]);
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
    await tasks.openOffer(createEnvelope('task.offer', {
      agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
    } as never, { taskId: 'finished', seq: 1 }));

    const sendTerminal = async (): Promise<WeakRef<Envelope>> => {
      const sealed = await tasks.sealOutbound(createEnvelope('task.complete', { summary: 'r'.repeat(100_000), sessionRef: 'session' }, { taskId: 'finished' }));
      expect(sealed?.type).toBe('task.complete');
      expect(sealed?.payload).toHaveProperty('sealed');
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
      getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, scratchRoot: testScratchOwner(),
      adapters: [adapter],
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
      session: { mode: 'fresh' }, instruction: 'reply', runtime: 'pi', agentRef: { agentId: 'draft-agent', profileRevision: '1' }, egressPolicy: policy,
      messageEgress: { mode: 'required', contract: 'draft.v1', contentType: 'text/plain', maxBytes: 4096 },
    };
    await runner.handleEnvelope(sealing === undefined
      ? createEnvelope('task.offer', payload as never, { taskId: 'draft-task', seq: 1 })
      : createEnvelope('task.offer', { ...payload, sealing } as never, { taskId: 'draft-task', seq: 1 }));
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

describe('admission timings on a sealed task\'s decline (#1014)', () => {
  const admission = { totalMs: 30, resultHelperPreflightMs: 12 };
  const sealedTasks = async (keyring: SealedScopeKeyring, taskId: string) => {
    const tasks = new SealedTasks({ keyring, tenantId: 'tenant-test', deviceId: 'dev_1', blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } }, serverCapabilities: () => [] });
    await tasks.openOffer(createEnvelope('task.offer', {
      agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
    } as never, { taskId, seq: 1 }));
    return tasks;
  };
  const decline = (taskId: string) => createEnvelope('task.decline', { reason: 'secret reason', retryable: true, admission }, { taskId });

  it('stays plaintext on the sealed branch', async () => {
    const tasks = await sealedTasks(new GatedKeyring(), 'sealed-decline');
    const sealed = await tasks.sealOutbound(decline('sealed-decline'));
    expect(sealed?.payload).toHaveProperty('sealed');
    expect(decodeEnvelope(encodeEnvelope(sealed!)).payload).toMatchObject({ retryable: true, admission });
    expect(JSON.stringify(sealed!.payload)).not.toContain('secret reason');
  });

  it('survives the closed decline sent when the output cannot be sealed', async () => {
    const keyless: SealedScopeKeyring = new GatedKeyring();
    const tasks = await sealedTasks(keyless, 'keyless-decline');
    keyless.sealingKey = async () => undefined;
    const closed = await tasks.sealOutbound(decline('keyless-decline'));
    expect(closed?.payload).toEqual({ reason: 'sealed_key_unavailable', code: 'sealed_key_unavailable', retryable: false, admission });
  });
});

describe('the failure class of a sealed task (#869)', () => {
  const sealedTasks = async (keyring: SealedScopeKeyring, taskId: string, flags: readonly string[] = []) => {
    const tasks = new SealedTasks({ keyring, tenantId: 'tenant-test', deviceId: 'dev_1', blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } }, serverCapabilities: () => flags });
    await tasks.openOffer(createEnvelope('task.offer', {
      agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
    } as never, { taskId, seq: 1 }));
    return tasks;
  };
  const failure = { class: 'quota', resetsAt: '2026-10-24T05:00:00.000Z' } as const;

  it('stays plaintext on the sealed branch of task.fail', async () => {
    const tasks = await sealedTasks(new GatedKeyring(), 'sealed-fail');
    const sealed = await tasks.sealOutbound(createEnvelope('task.fail', { reason: 'secret reason', retryable: false, failure }, { taskId: 'sealed-fail' }));
    expect(sealed?.type).toBe('task.fail');
    expect(sealed?.payload).toHaveProperty('sealed');
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
      await tasks.openOffer(createEnvelope('task.offer', {
        agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
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
  const sealedOffer = createEnvelope('task.offer', {
    agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'plain instruction', sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-output'] },
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
    const plainOffer = createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'plain instruction' }, { taskId: 'recovered', seq: 1 });
    const fail = createEnvelope('task.fail', { reason: 'plain reason', retryable: false }, { taskId: 'recovered' });
    expect(await tasks().sealRecovered(plainOffer, fail, false)).toBe(fail);
  });
});

describe('sealed payload v2 on the device (#1045 S2)', () => {
  const MESSAGE: TaskSealing = { scopeId: 'scope-a', epoch: 1, categories: ['agent-message', 'task-output', 'memory-projection'] };
  const requirement = { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 1000 } as const;
  const sealedTasks = (keyring: GatedKeyring) => new SealedTasks({
    keyring, tenantId: 'tenant-test', deviceId: 'dev_1',
    blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } },
    serverCapabilities: () => [],
  });
  async function openTask(keyring: GatedKeyring, taskId: string) {
    const tasks = sealedTasks(keyring);
    const agentRef = freshTestAgentRef();
    expect((await tasks.openOffer(createEnvelope('task.offer', {
      agentRef, ...FRESH_OFFER, instruction: 'plain instruction', sealing: MESSAGE,
    } as never, { taskId, seq: 1 }))).ok).toBe(true);
    return { tasks, agentRef };
  }
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
  async function outbox() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-message-'));
    dirs.push(dir);
    return AgentMessageOutbox.open(dir);
  }

  it('sends an Agent message only sealed, once, and matches its disposition by contentMac', async () => {
    const keyring = new GatedKeyring();
    const { tasks, agentRef } = await openTask(keyring, 'message');
    expect(tasks.sealsMessages('message')).toBe(true);
    const messages = await outbox();
    const draft = await messages.appendDraft({
      taskId: 'message', tenantId: 'tenant-test', agentRef, requirement, contentType: 'text/markdown', body: 'secret reply',
      maxPendingEvents: 4, maxPendingBytes: 4096, seal: (input) => tasks.sealPublish('message', input),
    });
    const record = (await messages.activate('message', 'session-1'))!;
    const payload = messages.publishPayload(record);
    expect(payload).not.toHaveProperty('body');
    expect(payload).not.toHaveProperty('contentHash');
    expect(payload).not.toHaveProperty('byteCount');
    expect(JSON.stringify(payload)).not.toContain('secret reply');
    // The outbox keeps the sealed member, so a retry after a restart sends the same bytes.
    expect((await AgentMessageOutbox.open(messages.homeDir)).publishPayload(record)).toEqual(payload);
    if (payload.sealed === undefined) throw new Error('sealed publish expected');
    const { ciphertext, ciphertextRef: _ref, ...header } = payload.sealed;
    const opened = await openSealedContent({
      header, ciphertext: Buffer.from(ciphertext!, 'base64url'), scopeKey: keyring.scopeKey,
      binding: {
        tenantId: 'tenant-test', family: 'agent.message.publish', direction: 'daemon-to-server',
        identity: { taskId: 'message', messageId: draft.messageId, cursor: draft.cursor }, deviceId: 'dev_1', agentRef, categories: MESSAGE.categories, notAfter: null,
      },
      sealing: { scopeId: 'scope-a', epoch: 1 }, maxContentLength: sealedAgentMessageMaxContentLength(requirement.maxBytes),
    });
    expect(opened).toMatchObject({ ok: true, plaintext: { body: 'secret reply' } });
    const exact = { agentRef, sessionRef: 'session-1', contract: requirement.contract, messageId: draft.messageId, cursor: draft.cursor, receiptId: '10000000-0000-4000-8000-000000000001' };
    expect(await messages.applyDisposition('message', { ...exact, contentHash: draft.contentHash, outcome: 'accepted' })).toBe('mismatch');
    expect(await messages.applyDisposition('message', { ...exact, contentMac: payload.sealed.contentMac, outcome: 'accepted' })).toBe('accepted');
  });

  it('sends no Agent message, and no plaintext, when the sealing key is gone', async () => {
    const keyring = new GatedKeyring();
    const { tasks, agentRef } = await openTask(keyring, 'no-key');
    keyring.lost = true;
    const messages = await outbox();
    await expect(messages.appendDraft({
      taskId: 'no-key', tenantId: 'tenant-test', agentRef, requirement, contentType: 'text/markdown', body: 'secret reply',
      maxPendingEvents: 4, maxPendingBytes: 4096, seal: (input) => tasks.sealPublish('no-key', input),
    })).rejects.toThrow(/no sealing key/);
    expect(messages.records()).toEqual([]);
    expect(await fs.readFile(path.join(messages.homeDir, '.byok', 'messages', 'outbox-v1.jsonl'), 'utf8').catch(() => '')).not.toContain('secret reply');
  });

  it('moves the memory evidence of a memory-projection task into the sealed terminal, and drops it from the closed plaintext form', async () => {
    const keyring = new GatedKeyring();
    const { tasks } = await openTask(keyring, 'memory');
    const change = { outcome: 'reader-attributed', paths: ['notes/plan.md'] } as const;
    const fail = createEnvelope('task.fail', { reason: 'sealed_key_unavailable', retryable: false, agentHomeMemoryChange: change } as never, { taskId: 'memory' });
    const sealed = (await tasks.sealOutbound(fail))!;
    expect(sealed.payload).toHaveProperty('sealed');
    expect(sealed.payload).not.toHaveProperty('agentHomeMemoryChange');
    expect(tasks.unsealable(fail, MESSAGE.categories)!.payload).not.toHaveProperty('agentHomeMemoryChange');
    expect(tasks.unsealable(fail, ['task-output'])!.payload).toMatchObject({ agentHomeMemoryChange: change });
  });

  it.each([
    ['seals a memory projection under an Agent scope whose policy is memory-projection', ['memory-projection'], true],
    ['seals no memory projection under a scope whose policy names another category', ['task-output', 'memory-projection'], false],
  ] as const)('%s', async (_label, policy, seals) => {
    const keyring = new GatedKeyring(policy);
    const agentRef = freshTestAgentRef();
    const identity = { agentId: agentRef.agentId, writerEpoch: 2, sourceSeq: 1, mutationId: '10000000-0000-4000-8000-000000000002' };
    const sealed = await sealedTasks(keyring).sealMemoryProjection({ sealing: { scopeId: 'scope-agent', epoch: 1 }, agentRef, identity, redactedBytes: 'cmVkYWN0ZWQ' });
    if (!seals) return expect(sealed).toBeUndefined();
    const { ciphertext, ...header } = sealed!;
    expect(await openSealedContent({
      header, ciphertext: Buffer.from(ciphertext!, 'base64url'), scopeKey: keyring.scopeKey,
      binding: {
        tenantId: 'tenant-test', family: 'agent.memory.projection', direction: 'daemon-to-server', identity,
        deviceId: 'dev_1', agentRef, categories: ['memory-projection'], notAfter: null,
      },
      sealing: { scopeId: 'scope-agent', epoch: 1 }, maxContentLength: 262_140,
    })).toMatchObject({ ok: true, plaintext: { redactedBytes: 'cmVkYWN0ZWQ' } });
  });
});

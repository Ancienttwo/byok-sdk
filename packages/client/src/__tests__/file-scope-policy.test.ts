import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import {
  FileScopePolicyError, parseToolAuthorizationPolicy, toolAuthorizationResolver,
  type ToolAuthorizationResolver, type ToolAuthorizationTask,
} from '../tool-authorization';
import { fileScopeAdmission } from '../daemon/task-runner/file-scope-admission';
import type { FileScopeAudit } from '../file-scope-guard';
import { fileScopeGateBinding } from '../file-scope-gate-binding';
import { toolAuthorizationIssues } from '../daemon/config-schema/static-tool-authorization';
import { describeEffectiveDaemonConfig } from '../daemon/config-schema/effective';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { checkDaemonConfig } from '../daemon/config-schema';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeCapabilities, RuntimeOperationStartInput } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { freshTestAgentRef, testAgentHomeConfig, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner, testScratchRoot } from './fixtures/execution-scratch';
import { testIngressBudget } from './fixtures/activity-ingress';
import { FRESH_OFFER, freshOfferEgressDeps } from './fixtures/fresh-offer';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used in this test'); },
  uploadArtifact: async () => { throw new Error('not used in this test'); },
};

const AUTO_CAPABLE: RuntimeCapabilities = {
  steer: true, resume: true, approvalInteractive: false, mcpToolsets: true, toolAuthorizationAuto: true,
};

/** Records the daemon-built start input so a claim/start can be distinguished from a decline. */
class GateCapturingAdapter extends StubRuntimeAdapter {
  readonly inputs: RuntimeOperationStartInput[] = [];
  constructor(capabilities: RuntimeCapabilities, runtimeId = 'pi') {
    super(runtimeId, { kind: 'available', version: '0.0.0' }, capabilities);
  }
  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const result = await super.prepare(input);
    if (result.kind !== 'prepared') return result;
    const start = result.operation.start;
    return {
      ...result,
      operation: { ...result.operation, start: (startInput) => { this.inputs.push(startInput); return start(startInput); } },
    };
  }
}

function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  toolAuthorization: ToolAuthorizationResolver,
  extra: Partial<Pick<TaskRunnerDeps, 'onFileScopeAudit'>> = {},
): TaskRunner {
  return new TaskRunner({
    advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget,
    scratchRoot: testScratchOwner(), adapters: [adapter], ...testAgentHomeDeps(),
    deviceId: 'device-1', send: (envelope) => { sent.push(envelope); },
    blobClient: unusedBlobClient, approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir', productId: 'unused-product-id', toolAuthorization,
    ...extra,
  });
}

async function offer(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(createEnvelope(
    'task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'do work' }, { taskId, seq: 1 },
  ));
}

const declineReason = (sent: Envelope[]): string | undefined => {
  const decline = sent.find((envelope) => envelope.type === 'task.decline');
  return decline?.type === 'task.decline' && decline.payload.sealed === undefined ? decline.payload.reason : undefined;
};

const dirs: string[] = [];
async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function canonicalTmpDir(prefix: string): Promise<string> {
  return fs.realpath(await tmpDir(prefix));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const CONFIG_BASE = {
  productName: 'Acme', productId: 'acme', serverUrl: 'https://acme.example',
  localAgentRelease: { version: '0.0.0-test' }, agentMemoryMcp: 'off' as const,
  agentHome: testAgentHomeConfig(), storage: { scratchRoot: testScratchRoot() },
};

async function configWith(extra: Partial<DaemonConfig>): Promise<DaemonConfig> {
  return { ...CONFIG_BASE, storeDir: await tmpDir('byok-file-scope-'), ...extra };
}

describe('parseToolAuthorizationPolicy fileScope (#1061 slice 1)', () => {
  it('defaults to inherit: no fileScope property and no resolver scope', () => {
    const parsed = parseToolAuthorizationPolicy({ default: 'auto' });
    expect(parsed).toEqual({ default: 'auto' });
    expect(Object.hasOwn(parsed, 'fileScope')).toBe(false);
    const resolved = toolAuthorizationResolver(parsed)({ taskId: 't', runtimeId: 'pi' });
    expect(resolved).toEqual({ default: 'auto' });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('parses home mode without roots', () => {
    const parsed = parseToolAuthorizationPolicy({ default: 'auto', fileScope: { mode: 'home' } });
    expect(parsed.fileScope).toEqual({ mode: 'home' });
    expect(Object.isFrozen(parsed.fileScope)).toBe(true);
  });

  it('copies and freezes explicit workspace roots with their access', () => {
    const raw = {
      default: 'auto' as const,
      fileScope: {
        mode: 'workspaces' as const,
        roots: [
          { id: 'repo', path: path.join(os.tmpdir(), 'repo'), access: 'write' as const },
          { id: 'docs', path: '/workspace/docs', access: 'read' as const },
        ],
      },
    };
    const parsed = parseToolAuthorizationPolicy(raw);
    expect(parsed.fileScope).toEqual({
      mode: 'workspaces',
      roots: [
        { id: 'repo', path: path.join(os.tmpdir(), 'repo'), access: 'write' },
        { id: 'docs', path: '/workspace/docs', access: 'read' },
      ],
    });
    expect(Object.isFrozen(parsed.fileScope?.roots)).toBe(true);
    expect(Object.isFrozen(parsed.fileScope?.roots?.[0])).toBe(true);
    // The snapshot is independent of later Host edits.
    raw.fileScope.roots[0]!.path = '/tmp/changed';
    expect(parsed.fileScope?.roots?.[0]?.path).toBe(path.join(os.tmpdir(), 'repo'));
  });

  it('deduplicates a repeated root path and keeps write as the union of access', () => {
    const parsed = parseToolAuthorizationPolicy({
      default: 'auto',
      fileScope: { mode: 'workspaces', roots: [
        { id: 'repo-read', path: '/workspace/repo', access: 'read' },
        { id: 'repo-write', path: '/workspace/repo/', access: 'write' },
      ] },
    });
    expect(parsed.fileScope?.roots).toEqual([{ id: 'repo-read', path: '/workspace/repo', access: 'write' }]);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an unknown field', { mode: 'home', extra: true }],
    ['an unknown mode', { mode: 'everywhere' }],
    ['home with roots', { mode: 'home', roots: [{ id: 'repo', path: '/workspace/repo', access: 'write' }] }],
    ['workspaces without roots', { mode: 'workspaces' }],
    ['workspaces with empty roots', { mode: 'workspaces', roots: [] }],
    ['a root with a relative path', { mode: 'workspaces', roots: [{ id: 'repo', path: 'repo', access: 'write' }] }],
    ['a root with a tilde path', { mode: 'workspaces', roots: [{ id: 'repo', path: '~/repo', access: 'write' }] }],
    ['a root with a dot-dot segment', { mode: 'workspaces', roots: [{ id: 'repo', path: '/workspace/../etc', access: 'write' }] }],
    ['a root with NUL', { mode: 'workspaces', roots: [{ id: 'repo', path: '/workspace/repo\0x', access: 'write' }] }],
    ['a root with an unknown field', { mode: 'workspaces', roots: [{ id: 'repo', path: '/workspace/repo', access: 'write', x: 1 }] }],
    ['a root with a bad access', { mode: 'workspaces', roots: [{ id: 'repo', path: '/workspace/repo', access: 'admin' }] }],
    ['a root with an empty id', { mode: 'workspaces', roots: [{ id: '', path: '/workspace/repo', access: 'write' }] }],
    ['duplicate root ids', { mode: 'workspaces', roots: [
      { id: 'repo', path: '/workspace/repo', access: 'write' },
      { id: 'repo', path: '/workspace/other', access: 'read' },
    ] }],
  ])('rejects %s with the typed file-scope error', (_label, fileScope) => {
    expect(() => parseToolAuthorizationPolicy({ default: 'auto', fileScope }))
      .toThrow(FileScopePolicyError);
    try {
      parseToolAuthorizationPolicy({ default: 'auto', fileScope });
    } catch (error) {
      expect((error as FileScopePolicyError).code).toBe('invalid_file_scope');
    }
  });

  it('allows an all default at parse time; the config check reports the conflict', () => {
    const parsed = parseToolAuthorizationPolicy({ default: 'all', fileScope: { mode: 'home' } });
    expect(parsed.fileScope).toEqual({ mode: 'home' });
  });
});

describe('fileScope static validation and effective report', () => {
  const validate = async (extra: Partial<DaemonConfig>) => checkDaemonConfig(
    await configWith(extra), { source: 'embedded', adapters: [new StubRuntimeAdapter('pi', undefined, AUTO_CAPABLE)] },
  );

  it('accepts home and explicit workspaces for an auto policy', async () => {
    const home = await validate({ toolAuthorization: { default: 'auto', fileScope: { mode: 'home' } } });
    expect(home.ok).toBe(true);
    expect(home.effective?.toolAuthorization.fileScope).toEqual({ mode: 'home' });
    const workspaces = await validate({ toolAuthorization: { default: 'auto', fileScope: {
      mode: 'workspaces', roots: [{ id: 'repo', path: '/workspace/repo', access: 'write' }],
    } } });
    expect(workspaces.ok).toBe(true);
    expect(workspaces.effective?.toolAuthorization.fileScope).toEqual({
      mode: 'workspaces', roots: [{ id: 'repo', path: '/workspace/repo', access: 'write' }],
    });
  });

  it('reports a typed invalid_file_scope for a relative root', async () => {
    const check = await validate({ toolAuthorization: { default: 'auto', fileScope: {
      mode: 'workspaces', roots: [{ id: 'repo', path: 'relative/repo', access: 'write' }],
    } } });
    expect(check.ok).toBe(false);
    expect(check.issues).toEqual([expect.objectContaining({
      severity: 'error', code: 'invalid_file_scope', path: 'toolAuthorization.fileScope',
    })]);
  });

  it('rejects all + fileScope at construction with invalid_file_scope', async () => {
    const config = await configWith({ toolAuthorization: { default: 'all', fileScope: { mode: 'home' } } });
    let thrown: unknown;
    try {
      createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'daemon_config_invalid' });
    expect((thrown as { issues: unknown }).issues).toEqual([expect.objectContaining({
      severity: 'error', code: 'invalid_file_scope', path: 'toolAuthorization.default',
    })]);
    const issues = toolAuthorizationIssues(config, [new StubRuntimeAdapter('pi')], 'injected');
    expect(issues).toEqual([expect.objectContaining({
      severity: 'error', code: 'invalid_file_scope', path: 'toolAuthorization.default',
    })]);
  });

  it('rejects a per-runtime all override alongside fileScope', async () => {
    const config = await configWith({ toolAuthorization: {
      default: 'auto', byRuntime: { pi: 'all' }, fileScope: { mode: 'home' },
    } });
    expect(toolAuthorizationIssues(config, [new StubRuntimeAdapter('pi')], 'injected')).toEqual([
      expect.objectContaining({ severity: 'error', code: 'invalid_file_scope', path: 'toolAuthorization.byRuntime.pi' }),
    ]);
  });

  it('requires agentHome for a file scope', async () => {
    const config = await configWith({
      agentHome: undefined, agentMemoryMcp: 'off',
      toolAuthorization: { default: 'auto', fileScope: { mode: 'home' } },
    });
    expect(toolAuthorizationIssues(config, [new StubRuntimeAdapter('pi', undefined, AUTO_CAPABLE)], 'injected')).toEqual([
      expect.objectContaining({ severity: 'error', code: 'invalid_file_scope', path: 'toolAuthorization.fileScope' }),
    ]);
  });

  it('reports inherit as an absent fileScope, unchanged from before this slice', async () => {
    const check = await validate({ toolAuthorization: { default: 'auto' } });
    expect(check.ok).toBe(true);
    expect(check.effective?.toolAuthorization).toEqual({ mode: 'static', byRuntime: { pi: 'auto' }, localToolApproval: 'host-only' });
    expect(Object.hasOwn(check.effective!.toolAuthorization, 'fileScope')).toBe(false);
  });

  it('reports the normalized scope through describeEffectiveDaemonConfig', async () => {
    const config = await configWith({ toolAuthorization: { default: 'auto', fileScope: {
      mode: 'workspaces', roots: [
        { id: 'repo-read', path: '/workspace/repo', access: 'read' },
        { id: 'repo-write', path: '/workspace/repo/', access: 'write' },
      ],
    } } });
    const effective = describeEffectiveDaemonConfig({
      config, warnings: [], memoryHelper: { state: 'not-needed' }, agentMemoryMcpAdmission: 'off',
      storeDir: path.join(os.tmpdir(), 'byok-effective-store'), scratchRoot: testScratchRoot(),
      adapters: [new StubRuntimeAdapter('pi')], runtimeSource: 'injected', platform: 'darwin',
    });
    expect(effective.toolAuthorization).toEqual({
      mode: 'static', byRuntime: { pi: 'auto' }, localToolApproval: 'host-only',
      fileScope: { mode: 'workspaces', roots: [{ id: 'repo-read', path: '/workspace/repo', access: 'write' }] },
    });
  });
});

describe('fileScope admission support matrix (#1061 slice 1)', () => {
  const pi = { id: 'pi', fileScope: { lanes: ['rpc' as const] } };
  const claude = { id: 'claude' };
  it.each([
    ['ordinary Pi RPC on darwin', { descriptor: pi, lane: 'rpc' as const, homeAccess: 'writer' as const, platform: 'darwin' as NodeJS.Platform }],
    ['ordinary Pi RPC on linux', { descriptor: pi, lane: 'rpc' as const, homeAccess: 'writer' as const, platform: 'linux' as NodeJS.Platform }],
    ['any runtime that declares the lane', { descriptor: { id: 'acme', fileScope: { lanes: ['rpc' as const] } }, lane: 'rpc' as const, homeAccess: 'writer' as const, platform: 'linux' as NodeJS.Platform }],
  ])('admits %s', (_label, facts) => {
    expect(fileScopeAdmission(facts)).toEqual({ supported: true });
  });

  it.each([
    ['another runtime', { descriptor: claude, lane: 'rpc' as const, homeAccess: 'writer' as const, platform: 'darwin' as NodeJS.Platform }, /runtime claude/],
    ['a runtime named pi that declares no scope', { descriptor: { id: 'pi' }, lane: 'rpc' as const, homeAccess: 'writer' as const, platform: 'darwin' as NodeJS.Platform }, /runtime pi cannot enforce/],
    ['the prepared lane', { descriptor: pi, lane: 'prepared' as const, homeAccess: 'writer' as const, platform: 'darwin' as NodeJS.Platform }, /prepared lane/],
    ['the durable lane', { descriptor: pi, lane: 'durable' as const, homeAccess: 'writer' as const, platform: 'linux' as NodeJS.Platform }, /durable Pi worker/],
    ['a memory-reader offer', { descriptor: pi, lane: 'rpc' as const, homeAccess: 'memory-reader' as const, platform: 'darwin' as NodeJS.Platform }, /memory-reader/],
    ['Windows', { descriptor: pi, lane: 'rpc' as const, homeAccess: 'writer' as const, platform: 'win32' as NodeJS.Platform }, /not supported on win32/],
  ])('refuses %s', (_label, facts, reason) => {
    const admission = fileScopeAdmission(facts);
    expect(admission.supported).toBe(false);
    if (!admission.supported) expect(admission.reason).toMatch(reason);
  });
});

describe('fileScope fail-closed admission through the task runner', () => {
  const homePolicy: ToolAuthorizationResolver = () => ({ default: 'auto', fileScope: { mode: 'home' } });

  it('declines another runtime before claim, with no start and no unscoped fallback', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE, 'claude');
    const sent: Envelope[] = [];
    await offer(makeRunner(adapter, sent, homePolicy), 'scope-claude');
    expect(declineReason(sent)).toMatch(/^file_scope_unsupported: runtime claude /);
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
    expect(adapter.inputs).toEqual([]);
  });

  it('declines the durable Pi worker before claim', async () => {
    const adapter = new GateCapturingAdapter({ ...AUTO_CAPABLE, durableLane: true });
    const sent: Envelope[] = [];
    const seen: ToolAuthorizationTask[] = [];
    await offer(makeRunner(adapter, sent, (task) => { seen.push(task); return { default: 'auto', fileScope: { mode: 'home' } }; }), 'scope-durable');
    expect(seen).toEqual([expect.objectContaining({ taskId: 'scope-durable', runtimeId: 'pi', lane: 'durable', homeAccess: 'writer' })]);
    expect(declineReason(sent)).toMatch(/^file_scope_unsupported: the durable Pi worker /);
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
    expect(adapter.inputs).toEqual([]);
  });

  it('declines an all-mode runtime with a file scope instead of running unscoped', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    await offer(makeRunner(adapter, sent,
      () => ({ default: 'auto', byRuntime: { pi: 'all' }, fileScope: { mode: 'home' } })), 'scope-all');
    expect(declineReason(sent)).toMatch(/^file_scope_conflicts_with_all: /);
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(false);
    expect(adapter.inputs).toEqual([]);
  });

  it('does not change an existing offer without a file scope', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const audits: FileScopeAudit[] = [];
    await offer(makeRunner(adapter, sent, () => ({ default: 'auto' }),
      { onFileScopeAudit: (event) => audits.push(event) }), 'no-scope');
    expect(declineReason(sent)).toBeUndefined();
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(adapter.inputs).toHaveLength(1);
    expect(adapter.inputs[0]!.toolAuthorization).toBeDefined();
    expect(audits).toEqual([]);
  });

  it('admits an ordinary Pi POSIX offer with a file scope and shows lane/homeAccess to a Host resolver', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const seen: ToolAuthorizationTask[] = [];
    await offer(makeRunner(adapter, sent, (task) => {
      seen.push(task);
      return { default: 'auto', fileScope: { mode: 'home' } };
    }), 'scope-supported');
    expect(seen).toEqual([expect.objectContaining({
      taskId: 'scope-supported', runtimeId: 'pi', lane: 'rpc', homeAccess: 'writer', agentRef: expect.any(Object),
    })]);
    expect(declineReason(sent)).toBeUndefined();
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(adapter.inputs).toHaveLength(1);
    // The resolved grant is bound to the exact gate the adapter receives, so
    // the launch can carry it; a missing binding would be an unscoped start.
    const binding = fileScopeGateBinding(adapter.inputs[0]!.toolAuthorization!);
    expect(binding).toMatchObject({ taskId: 'scope-supported', lane: 'rpc', homeAccess: 'writer' });
    expect(binding!.grant.mode).toBe('home');
  });

  it('uses the effective per-runtime mode when byRuntime selects auto over an all default', async () => {
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    await offer(makeRunner(adapter, sent,
      () => ({ default: 'all', byRuntime: { pi: 'auto' }, fileScope: { mode: 'home' } })), 'scope-by-runtime');
    expect(declineReason(sent)).toBeUndefined();
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(adapter.inputs).toHaveLength(1);
    expect(fileScopeGateBinding(adapter.inputs[0]!.toolAuthorization!)).toBeDefined();
  });
});

describe('fileScope root validation at task start (#1061 slice 2)', () => {
  const failReason = (sent: Envelope[]): string | undefined => {
    const fail = sent.find((envelope) => envelope.type === 'task.fail');
    if (fail?.type !== 'task.fail') return undefined;
    return 'reason' in fail.payload ? fail.payload.reason : undefined;
  };

  it('revalidates a real workspace root after claim, then starts and records adoption', async () => {
    const root = await canonicalTmpDir('byok-scope-root-');
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const audits: FileScopeAudit[] = [];
    await offer(makeRunner(adapter, sent,
      () => ({ default: 'auto', fileScope: { mode: 'workspaces', roots: [{ id: 'repo', path: root, access: 'write' }] } }),
      { onFileScopeAudit: (event) => audits.push(event) }), 'scope-root-valid');
    expect(declineReason(sent)).toBeUndefined();
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(failReason(sent)).toBeUndefined();
    expect(adapter.inputs).toHaveLength(1);
    expect(audits).toEqual([expect.objectContaining({
      taskId: 'scope-root-valid',
      decision: 'policy-adoption',
      lane: 'rpc',
      homeAccess: 'writer',
      scope: expect.objectContaining({ source: 'host', mode: 'workspaces', digest: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      rootIds: ['home', 'repo'],
    })]);
    // D12: allow is never recorded; only the one adoption event exists.
    expect(audits.every((event) => event.decision !== 'deny')).toBe(true);
  });

  it('fails a claimed task with a typed reason when a root is missing, before start', async () => {
    const root = path.join(await canonicalTmpDir('byok-scope-missing-'), 'gone');
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const audits: FileScopeAudit[] = [];
    await offer(makeRunner(adapter, sent,
      () => ({ default: 'auto', fileScope: { mode: 'workspaces', roots: [{ id: 'repo', path: root, access: 'write' }] } }),
      { onFileScopeAudit: (event) => audits.push(event) }), 'scope-root-missing');
    // Post-claim failure, not a pre-claim decline and not an unscoped start.
    expect(declineReason(sent)).toBeUndefined();
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(failReason(sent)).toMatch(/^file_scope_unavailable: file scope root_missing for root "repo"/);
    expect(sent.some((envelope) => envelope.type === 'task.started')).toBe(false);
    expect(adapter.inputs).toEqual([]);
    expect(audits).toEqual([expect.objectContaining({
      taskId: 'scope-root-missing',
      decision: 'deny',
      lane: 'rpc',
      homeAccess: 'writer',
      scope: expect.objectContaining({ mode: 'workspaces', digest: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      rootId: 'repo',
      access: 'write',
      code: 'file_scope_unavailable',
      reason: 'root_missing',
    })]);
  });

  it('fails a claimed task when a configured root is a symlink', async () => {
    const target = await canonicalTmpDir('byok-scope-link-target-');
    const link = path.join(await canonicalTmpDir('byok-scope-link-parent-'), 'linked');
    await fs.symlink(target, link, 'dir');
    const adapter = new GateCapturingAdapter(AUTO_CAPABLE);
    const sent: Envelope[] = [];
    const audits: FileScopeAudit[] = [];
    await offer(makeRunner(adapter, sent,
      () => ({ default: 'auto', fileScope: { mode: 'workspaces', roots: [{ id: 'repo', path: link, access: 'read' }] } }),
      { onFileScopeAudit: (event) => audits.push(event) }), 'scope-root-symlink');
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(failReason(sent)).toMatch(/^file_scope_unavailable: file scope symlink for root "repo"/);
    expect(adapter.inputs).toEqual([]);
    expect(audits).toEqual([expect.objectContaining({
      decision: 'deny', rootId: 'repo', access: 'read', code: 'file_scope_unavailable', reason: 'symlink',
    })]);
  });
});

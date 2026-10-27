import { testScratchOwner } from "./fixtures/execution-scratch";
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INPUT_PREPARATION_REQUEST_FORMAT, INPUT_PREPARATION_VERSION, validateInputPreparationLimits, type InputPreparationRequestV1 } from '../input-preparation';
import { createInputPreparationService } from '../daemon/input-preparation-service';
import { TaskRunner } from '../daemon/task-runner';
import { ApprovalRegistry } from '../daemon/approvals';
import { recordingToolSurface } from './fixtures/prepared-tool-surface';
import { InputPreparationCompileError, SUPPORTED_PREPARED_COMPILER_VERSION, type InputPreparationCompiler, type CompilePreparedInputRequest, type CompiledPreparedInput } from '../adapters/pi/input-preparation';
import { testIngressBudget } from './fixtures/activity-ingress';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.useRealTimers(); vi.restoreAllMocks(); });
const LIMITS = validateInputPreparationLimits({ revision: 'limits-rev-1', maxRequestBytes: 64_000, maxArtifactBytes: 200_000, maxScopeAggregateBytes: 400_000, maxInFlight: 4, maxCounterCallsPerScope: 8, counterTimeoutMs: 5, preparationDeadlineMs: 10, retentionMs: 100, retryHorizonMs: 100 });
interface StubCompiler extends InputPreparationCompiler { readonly calls: CompilePreparedInputRequest[]; }
function sha256Hex(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function request(overrides: Partial<InputPreparationRequestV1> = {}): InputPreparationRequestV1 {
  return {
    format: INPUT_PREPARATION_REQUEST_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    requestId: 'prep-1',
    policyRevision: LIMITS.revision,
    scope: { deviceId: 'device-1', agentRef: 'agent-1', profileId: 'profile-1', profileRevision: 'profile-rev-1' },
    source: { revision: 'src-rev-1', digest: 'src-digest-1' },
    selection: {
      model: {
        id: 'glm-4.6',
        name: 'GLM 4.6',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: false,
        input: ['text'],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      options: { cacheRetention: 'none', maxTokens: 4_096 },
    },
    snapshot: {
      prompt: { systemPrompt: 'Host framing' },
      messages: [{ role: 'user', content: 'hello', timestamp: 1_700_000_000_000 }],
    },
    agentMemory: 'none', requiredToolsets: ['team'],
    ...overrides,
  };
}

function stubCompiler(
  options: {
    fail?: boolean;
    body?: () => string;
    projectionKind?: 'content_complete' | 'unknown';
    residual?: readonly { readonly key: string; readonly valueClass: 'bounded_integer' }[];
    compilerVersion?: number;
  } = {},
): StubCompiler {
  const calls: CompilePreparedInputRequest[] = [];
  return {
    calls,
    runtime: {
      packageName: '@byok-sdk/pi-coding-agent',
      packageVersion: '0.85.1001',
      tarballIntegrity: 'sha512-test', provenanceDigest: 'a'.repeat(64), closureDigest: 'b'.repeat(64),
      upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
      envelopeFormat: 'pi.session.prepared-input',
      requestFormat: 'pi.openai-completions.prepared',
      // The contract this build prepares against, unless a test states another
      // one on purpose — a fixture that pinned a literal would quietly make
      // every receipt in this file carry `runtime_contract_superseded`.
      compilerVersion: options.compilerVersion ?? SUPPORTED_PREPARED_COMPILER_VERSION,
    },
    async compile(compileRequest: CompilePreparedInputRequest): Promise<CompiledPreparedInput> {
      // Deep-copy at capture time so a later mutation of the service's own
      // object cannot rewrite what this test observed.
      calls.push(structuredClone(compileRequest) as CompilePreparedInputRequest);
      if (options.fail === true) throw new InputPreparationCompileError('stub refuses this input');
      // A chat-completions-shaped D: `messages` is what the text-only rule
      // reads, and a D without it is (correctly) never text-only.
      const body = options.body?.() ?? JSON.stringify({
        model: compileRequest.model.id,
        messages: compileRequest.snapshot.messages.map((message) => ({ role: message.role, content: message.content })),
        snapshot: compileRequest.snapshot,
      });
      const counterProjection = JSON.stringify({ model: compileRequest.model.id });
      return {
        requestBody: body,
        counterProjection,
        requestBytes: Buffer.byteLength(body, 'utf8'),
        projectionBytes: 32,
        requestDigest: 'a'.repeat(64),
        envelopeDigest: 'b'.repeat(64),
        toolManifestDigest: 'c'.repeat(64),
        // The digest a real compiler would have taken over these exact bytes,
        // so a fixture counter's evidence can bind to the same projection the
        // service compares it against.
        projection: {
          version: 3,
          kind: options.projectionKind ?? 'content_complete',
          digest: sha256Hex(counterProjection),
        },
        residual: options.residual ?? [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
        envelope: { format: 'pi.session.prepared-input', version: 3 } as never,
      };
    },
  };
}


async function harness() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(1_700_000_000_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s11-f2-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const compiler = stubCompiler();
  const service = createInputPreparationService({ storeDir: dir, limits: LIMITS, compiler, toolSurface: recordingToolSurface(), authorityResolver: {
    resolveSource: async ({ source }) => ({ authorized: true, source }),
    resolveScope: async claim => ({ authorized: true, grant: { ...claim, scopeId: 'scope', agentMemory: 'none' } }),
  } });
  await service.open();
  cleanups.push(() => service.stop().catch(() => {}));
  const receipt = await service.prepare(request());
  const recordId = receipt.reference;
  const artifactPath = service.store.artifactPathOf(service.store.get(recordId)!);
  const taskId = 'terminal-task';
  await service.store.pin(recordId, { taskId, manifestDigest: 'manifest', sealedAt: new Date().toISOString() });
  const gc = vi.spyOn(service.store, 'gc');
  // Exercise the actual TaskRunner terminal-release helper against its real
  // held-pin map. Admission/runtime launching is outside this retention test;
  // no launch ownership guard or provider is mocked/bypassed.
  const runner = new TaskRunner({ getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, scratchRoot: testScratchOwner(), adapters: [], deviceId: 'device-1', storeDir: dir, productId: 'retention-test', send: () => {},
    blobClient: { resolveInstruction: async () => { throw new Error('unused'); }, uploadArtifact: async () => { throw new Error('unused'); } },
    approvalRegistry: new ApprovalRegistry(),
    inputPreparationLane: { store: service.store, open: () => service.open(), authorizeAgentMemory: async () => {}, runtime: compiler.runtime, policyRevision: LIMITS.revision, toolsetDefinitionRevisions: () => new Map() },
  });
  const terminal = runner as unknown as { preparationPinsByTask: Map<string, string>; releasePreparationPin: (taskId: string) => Promise<void> };
  terminal.preparationPinsByTask.set(taskId, recordId);
  async function settleGc() {
    await Promise.all(gc.mock.results.filter(result => result.type === 'return').map(result => result.value));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); await service.collectExpired(Date.now(), 32); await settleGc(); }
  return { service, compiler, gc, recordId, artifactPath, taskId, terminal, tick, settleGc,
    release: () => terminal.releasePreparationPin(taskId),
    async expectCollected() {
      expect(service.store.get(recordId)).toBeUndefined();
      await expect(fs.stat(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(compiler.calls).toHaveLength(1);
    },
  };
}

describe('S11-F2 pins under unified maintenance', () => {
  it('collects after the final TaskRunner pin releases without a private timer', async () => {
    const h = await harness(); await h.tick(201);
    expect(h.service.store.get(h.recordId)?.pin?.taskId).toBe(h.taskId);
    await h.release(); expect(h.terminal.preparationPinsByTask.has(h.taskId)).toBe(false);
    await h.tick(1); await h.expectCollected(); expect(vi.getTimerCount()).toBe(0);
  });
  it('expires artifacts before tombstones and preserves both absolute horizons', async () => {
    const h = await harness(); await h.tick(50); await h.release(); await h.tick(49);
    expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0); await h.tick(1);
    expect(h.service.store.get(h.recordId)?.artifactBytes).toBe(0); await h.tick(99);
    expect(h.service.store.get(h.recordId)).toBeDefined(); await h.tick(1); await h.expectCollected();
  });
  it('a scan observes the pin when unpin is queued behind it; the next pass collects', async () => {
    const h = await harness(); vi.setSystemTime(Date.now() + 201);
    const gate = deferred(), entered = deferred();
    const serialized = h.service.store as unknown as { enqueue(work: () => Promise<void>): Promise<void> };
    const blocker = serialized.enqueue(async () => { entered.resolve(); await gate.promise; });
    cleanups.push(async () => gate.resolve()); await entered.promise;
    const scan = h.service.collectExpired(Date.now(), 32), released = h.release(); gate.resolve();
    await blocker; await scan; await released;
    expect(h.service.store.get(h.recordId)?.pin).toBeUndefined(); await h.tick(1); await h.expectCollected();
  });
  it('keeps a different pin holder protected', async () => {
    const h = await harness(); await h.tick(201);
    await expect(h.service.store.unpin(h.recordId, 'other-task')).rejects.toThrow('cannot be released');
    await h.tick(1); expect(h.service.store.get(h.recordId)?.pin?.taskId).toBe(h.taskId);
    expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0);
  });
  it('does not revive timers after stop; reopen applies overdue retention', async () => {
    const h = await harness(); await h.tick(201); await h.service.stop(); await h.release();
    expect(vi.getTimerCount()).toBe(0); expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0);
    await h.service.open(); await h.expectCollected();
  });
  it('does not expose an unpin whose durable append failed', async () => {
    const h = await harness(); await h.tick(201);
    const durable = h.service.store as unknown as { log: { append(body: string): Promise<void> } };
    const append = vi.spyOn(durable.log, 'append').mockRejectedValueOnce(new Error('fixture write failure'));
    await expect(h.service.store.unpin(h.recordId, h.taskId)).rejects.toThrow('could not be durably written');
    expect(h.service.store.get(h.recordId)?.pin?.taskId).toBe(h.taskId);
    append.mockRestore(); await h.release(); await h.tick(1); await h.expectCollected();
  });
  it('idempotent concurrent unpins create no timer and a bounded pass reports physical bytes', async () => {
    const h = await harness(); await h.tick(125); const bytes = (await fs.stat(h.artifactPath)).size;
    await Promise.all([h.service.store.unpin(h.recordId,h.taskId), h.service.store.unpin(h.recordId,h.taskId)]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await h.service.collectExpired(Date.now(), 1)).toMatchObject({ artifactsRemoved: 1, recordsRemoved: 0, bytesReclaimed: bytes });
    await h.tick(75); await h.expectCollected();
  });
});

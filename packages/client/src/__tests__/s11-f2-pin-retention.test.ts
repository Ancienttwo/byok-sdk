import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INPUT_PREPARATION_REQUEST_FORMAT, INPUT_PREPARATION_VERSION, validateInputPreparationLimits, type InputPreparationRequestV1 } from '../input-preparation';
import { createInputPreparationService } from '../daemon/input-preparation-service';
import { TaskRunner } from '../daemon/task-runner';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { recordingToolSurface } from './fixtures/prepared-tool-surface';
import { InputPreparationCompileError, SUPPORTED_PREPARED_COMPILER_VERSION, type InputPreparationCompiler, type CompilePreparedInputRequest, type CompiledPreparedInput } from '../adapters/pi/input-preparation';

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
  const runner = new TaskRunner({ adapters: [], deviceId: 'device-1', workspaceRoot: path.join(dir, 'workspace'), storeDir: dir, productId: 'retention-test', send: () => {},
    blobClient: { resolveInstruction: async () => { throw new Error('unused'); }, uploadArtifact: async () => { throw new Error('unused'); } },
    sessionWorkspaces: new SessionWorkspaceStore(path.join(dir, 'sessions')), approvalRegistry: new ApprovalRegistry(),
    inputPreparationLane: { store: service.store, open: () => service.open(), authorizeAgentMemory: async () => {}, runtime: compiler.runtime, policyRevision: LIMITS.revision, toolsetDefinitionRevisions: () => new Map() },
  });
  const terminal = runner as unknown as { preparationPinsByTask: Map<string, string>; releasePreparationPin: (taskId: string) => Promise<void> };
  terminal.preparationPinsByTask.set(taskId, recordId);
  async function settleGc() {
    await Promise.all(gc.mock.results.filter(result => result.type === 'return').map(result => result.value));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); await settleGc(); }
  return { service, compiler, gc, recordId, artifactPath, taskId, terminal, tick, settleGc,
    release: () => terminal.releasePreparationPin(taskId),
    async expectCollected() {
      expect(service.store.get(recordId)).toBeUndefined();
      await expect(fs.stat(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(compiler.calls).toHaveLength(1);
    },
  };
}

describe('S11-F2 pin release rearms owned retention GC', () => {
  it('collects after the last pin releases beyond both horizons, through the real terminal-release helper', async () => {
    const h = await harness();
    await h.tick(201);
    expect(h.service.store.get(h.recordId)?.pin?.taskId).toBe(h.taskId);
    expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0); // The wholly pinned store is dormant.
    await h.release();
    expect(h.service.store.get(h.recordId)?.pin).toBeUndefined();
    expect(h.terminal.preparationPinsByTask.has(h.taskId)).toBe(false);
    await h.tick(1);
    await h.expectCollected();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('collects an expired artifact immediately after release but preserves the tombstone to its own horizon', async () => {
    const h = await harness();
    await h.tick(125);
    expect(vi.getTimerCount()).toBe(0);
    await h.release();
    await h.tick(1);
    await expect(fs.stat(h.artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.service.store.get(h.recordId)?.artifactBytes).toBe(0);
    await h.tick(73);
    expect(h.service.store.get(h.recordId)).toBeDefined();
    await h.tick(1);
    await h.expectCollected();
  });

  it('does not shorten either horizon when a pin releases before expiry', async () => {
    const h = await harness();
    await h.tick(50);
    await h.release();
    await h.tick(49);
    expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0);
    await h.tick(1);
    expect(h.service.store.get(h.recordId)?.artifactBytes).toBe(0);
    await h.tick(99);
    expect(h.service.store.get(h.recordId)).toBeDefined();
    await h.tick(1);
    await h.expectCollected();
  });

  it('retains the rearm when unpin commits while a completed GC scan is still in flight', async () => {
    const h = await harness();
    const scanned = deferred(); const releaseGc = deferred();
    const realGc = h.service.store.gc.bind(h.service.store);
    h.gc.mockRestore();
    const gc = vi.spyOn(h.service.store, 'gc').mockImplementationOnce(async (...args) => {
      const result = await realGc(...args); scanned.resolve(); await releaseGc.promise; return result;
    });
    cleanups.push(async () => { releaseGc.resolve(); });
    await vi.advanceTimersByTimeAsync(201);
    await scanned.promise;
    await h.release();
    expect(vi.getTimerCount()).toBe(0); // Existing GC owns the next scheduling pass.
    releaseGc.resolve();
    await gc.mock.results[0]!.value;
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1);
    await gc.mock.results.at(-1)!.value;
    await h.expectCollected();
  });

  it('rearms when GC observes the pin and unpin is queued behind that serialized scan', async () => {
    const h = await harness();
    const gate = deferred(); const entered = deferred();
    const serialized = h.service.store as unknown as { enqueue: (work: () => Promise<void>) => Promise<void> };
    const blocker = serialized.enqueue(async () => { entered.resolve(); await gate.promise; });
    cleanups.push(async () => { gate.resolve(); });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(201); // GC queued behind the held mutation.
    const released = h.release(); // Unpin queued behind GC.
    gate.resolve();
    await blocker; await released; await h.settleGc();
    expect(h.service.store.get(h.recordId)?.pin).toBeUndefined();
    await h.tick(1);
    await h.expectCollected();
  });

  it('leaves a different holder protected and schedules nothing for a failed release', async () => {
    const h = await harness();
    await h.tick(201);
    await expect(h.service.store.unpin(h.recordId, 'other-task')).rejects.toThrow('cannot be released');
    expect(vi.getTimerCount()).toBe(0);
    expect(h.service.store.get(h.recordId)?.pin?.taskId).toBe(h.taskId);
    expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0);
  });

  it('does not revive timers after service stop; reopen applies overdue retention', async () => {
    const h = await harness();
    await h.tick(201);
    await h.service.stop();
    await h.release();
    expect(vi.getTimerCount()).toBe(0);
    expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0);
    await h.service.open();
    await h.expectCollected();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not publish a retention change when the durable unpin append fails', async () => {
    const h = await harness();
    await h.tick(201);
    const durable = h.service.store as unknown as { log: { append: (body: string) => Promise<void> } };
    const append = vi.spyOn(durable.log, 'append').mockRejectedValueOnce(new Error('fixture write failure'));
    await expect(h.service.store.unpin(h.recordId, h.taskId)).rejects.toThrow('could not be durably written');
    expect(h.service.store.get(h.recordId)?.pin?.taskId).toBe(h.taskId);
    expect(vi.getTimerCount()).toBe(0);
    expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0);
    append.mockRestore();
    await h.release();
    await h.tick(1);
    await h.expectCollected();
  });

  it('does not mask a committed unpin if scheduling fails; the service exposes its GC fault', async () => {
    const h = await harness();
    await h.tick(201);
    const fault = new Error('fixture scheduling scan failure');
    const list = vi.spyOn(h.service.store, 'list').mockImplementationOnce(() => { throw fault; });
    await expect(h.service.store.unpin(h.recordId, h.taskId)).resolves.toMatchObject({ recordId: h.recordId });
    expect(h.service.store.get(h.recordId)?.pin).toBeUndefined();
    list.mockRestore();
    expect(vi.getTimerCount()).toBe(0);
    await expect(h.service.lookup({ requestId: request().requestId, scope: request().scope })).rejects.toBe(fault);
    await expect(h.service.stop()).rejects.toBe(fault);
  });

  it('cannot resurrect the scheduler when stop races a queued durable unpin', async () => {
    const h = await harness();
    await h.tick(201);
    const gate = deferred(); const entered = deferred();
    const serialized = h.service.store as unknown as { enqueue: (work: () => Promise<void>) => Promise<void> };
    const blocker = serialized.enqueue(async () => { entered.resolve(); await gate.promise; });
    cleanups.push(async () => { gate.resolve(); });
    await entered.promise;
    const unpin = h.release();
    await h.service.stop();
    gate.resolve();
    await blocker; await unpin;
    expect(h.service.store.get(h.recordId)?.pin).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect((await fs.stat(h.artifactPath)).size).toBeGreaterThan(0);
    await h.service.open();
    await h.expectCollected();
  });

  it('keeps one absolute-expiry timer across concurrent idempotent unpin retries', async () => {
    const h = await harness();
    await h.tick(125);
    await Promise.all([h.service.store.unpin(h.recordId, h.taskId), h.service.store.unpin(h.recordId, h.taskId)]);
    expect(vi.getTimerCount()).toBe(1);
    await h.tick(1);
    expect(h.service.store.get(h.recordId)?.artifactBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    await h.tick(74);
    await h.expectCollected();
    expect(vi.getTimerCount()).toBe(0);
  });

});

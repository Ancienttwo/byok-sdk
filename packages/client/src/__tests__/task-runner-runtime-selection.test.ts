import { testRuntimeEnvironment } from './fixtures/runtime-env';
import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import { spawn as realSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter, claudeProbeTimeouts, type SpawnFn } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { OpenCodeAdapter } from '../adapters/opencode/opencode-adapter';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import type { RuntimeAdapter, RuntimeOperationStartInput } from '../types';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter, StubSession } from './fixtures/stub-adapter';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { TaskRunner } from '../daemon/task-runner';
import { FRESH_OFFER } from './fixtures/fresh-offer';

const PI_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

/**
 * M5 batch-3 (workstream 1): runtime auto-selection order
 * (`TaskRunner.pickAdapter`, `daemon/task-runner.ts`).
 *
 * Problem this closes (see task-runner.ts's `DEFAULT_RUNTIME_PREFERENCE` doc
 * comment for the full rationale): pi used to be the de-facto DEFAULT
 * auto-selected runtime (an accident of `ALL_RUNTIME_IDS`'s construction
 * order doubling as selection order), contradicting the product decision
 * that pi is the FALLBACK — tried only once nothing better is available.
 *
 * Mirrors `daemon-task-loop.test.ts`'s own `StubRuntimeAdapter` + `TestServer`
 * convention (full daemon/wire-level assertions on decline/claim envelopes)
 * rather than a directly-constructed `TaskRunner`, since these scenarios are
 * fundamentally about which of SEVERAL adapters gets picked.
 */

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('TaskRunner.pickAdapter — runtime selection + capability matching (M5 batch-3)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function setup(adapters: RuntimeAdapter[], configOverrides: Partial<DaemonConfig> = {}): Promise<Daemon> {
    const storeDir = await tmpDir('byok-selection-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product-selection',
        serverUrl: server.url,
        agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
        storeDir,
        ...configOverrides,
      },
      adapters,
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return daemon;
  }

  it.each(['pi'] as const)('declines %s resume before preparing or claiming', async (id) => {
    const adapter = new StubRuntimeAdapter(id, { kind: 'available' }, { steer: false, resume: false, approvalInteractive: false, mcpToolsets: true });
    const prepare = vi.spyOn(adapter, 'prepare');
    await setup([adapter]);
    const taskId = 'unsupported-resume';
    server.send(createEnvelope('task.offer', { target: { lane: 'harness', harnessId: id, selection: { mode: 'device-default' } }, agentRef: freshTestAgentRef(), session: { mode: 'resume', sessionRef: 'prior' }, instruction: 'x' }, { taskId, seq: server.nextSeq() }));
    const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === taskId);
    expect(decline.payload).toMatchObject({ reason: `runtime "${id}" cannot resume a session`, retryable: false });
    expect(decline.payload).not.toHaveProperty('runtimeUnavailable');
    expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === taskId)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('declines auto selection when no candidate supports resume', async () => {
    vi.spyOn(TaskRunner.prototype as unknown as { agentMemoryMcpAdmitted: () => boolean }, 'agentMemoryMcpAdmitted').mockReturnValue(true);
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, { steer: false, resume: false, approvalInteractive: false, mcpToolsets: true });
    const prepare = vi.spyOn(adapter, 'prepare');
    await setup([adapter]);
    const taskId = 'auto-unsupported-resume';
    server.send(createEnvelope('task.offer', { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), session: { mode: 'resume', sessionRef: 'prior' }, instruction: 'x', agentMemory: 'none' }, { taskId, seq: server.nextSeq() }));
    const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === taskId);
    expect(decline.payload).toMatchObject({ reason: 'no available runtime on this device can resume a session', retryable: true });
    expect(decline.payload).not.toHaveProperty('runtimeUnavailable');
    expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === taskId)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('auto selection skips a runtime that cannot resume and starts a capable one', async () => {
    const claude = new StubRuntimeAdapter('claude', { kind: 'available' }, { steer: false, resume: false, approvalInteractive: false, mcpToolsets: true });
    const pi = new StubRuntimeAdapter('pi');
    const prepare = vi.spyOn(claude, 'prepare');
    const handoff = vi.spyOn(AgentSessionHandoffStore.prototype, 'requireMatch').mockImplementation(async (expected) => ({ ...expected, taskId: 'prior-task', leaseId: 'prior-lease', updatedAt: new Date().toISOString() }));
    try {
      await setup([claude, pi]);
      const taskId = 'auto-resume-capable';
      server.send(createEnvelope('task.offer', { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), session: { mode: 'resume', sessionRef: 'prior' }, instruction: 'x' }, { taskId, seq: server.nextSeq() }));
      const claim = await server.waitFor((e) => e.type === 'task.claim' && e.task_id === taskId);
      expect(claim.payload).toMatchObject({ executor: { id: 'pi' } });
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);
      expect(prepare).not.toHaveBeenCalled();
      expect(pi.startCalls).toHaveLength(1);
    } finally { handoff.mockRestore(); }
  });

  it('skips an advertised OpenCode that requires an explicit model on auto', async () => {
    const opencode = new OpenCodeAdapter();
    const descriptor = opencode.descriptor;
    vi.spyOn(opencode, 'descriptor', 'get').mockReturnValue({ ...descriptor, platforms: [process.platform] });
    vi.spyOn(opencode, 'detect').mockResolvedValue({ kind: 'available' });
    const prepare = vi.spyOn(opencode, 'prepare');
    await setup([opencode]);
    const hello = await server.waitFor(envelope => envelope.type === 'conn.hello');
    expect(hello.payload).toMatchObject({ harnesses: expect.arrayContaining([expect.objectContaining({ id: 'opencode', capabilities: expect.objectContaining({ selectionModes: ['adapter-model'] }) })]) });
    const taskId = 'auto-explicit-model';
    server.send(createEnvelope('task.offer', { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER }, { taskId, seq: server.nextSeq() }));
    const decline = await server.waitFor(envelope => envelope.type === 'task.decline' && envelope.task_id === taskId);
    expect(decline.payload).toMatchObject({ runtimeUnavailable: { cause: 'none_available' } });
    const explicitId = 'missing-adapter-model';
    server.send(createEnvelope('task.offer', { target: { lane: 'harness', harnessId: 'opencode', selection: { mode: 'adapter-model' } },
      agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER }, { taskId: explicitId, seq: server.nextSeq() }));
    const missing = await server.waitFor(envelope => envelope.type === 'task.decline' && envelope.task_id === explicitId);
    expect(missing.payload).toMatchObject({ code: 'invalid_request', retryable: false });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(['invalid_request', 'model_unavailable'] as const)('forwards adapter rejection %s before claiming', async code => {
    const adapter = new StubRuntimeAdapter('pi');
    vi.spyOn(adapter, 'prepare').mockResolvedValue({ kind: 'reject', code, reason: 'selection refused', retryable: false });
    await setup([adapter]);
    const taskId = `reject-${code}`;
    server.send(createEnvelope('task.offer', { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER }, { taskId, seq: server.nextSeq() }));
    const declined = await server.waitFor(envelope => envelope.type === 'task.decline' && envelope.task_id === taskId);
    expect(declined.payload).toMatchObject({ code, retryable: false });
    expect(server.received.some(envelope => envelope.type === 'task.claim' && envelope.task_id === taskId)).toBe(false);
  });

  it('#2469: hands each offer its own fresh admission observation in prepare(), on auto and explicit targets', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    // Startup reporting observes too; each observation gets its own version.
    const observed: string[] = [];
    vi.spyOn(adapter, 'detect').mockImplementation(async () => {
      const version = `1.0.${observed.length}`;
      observed.push(version);
      return { kind: 'available', version };
    });
    const prepare = vi.spyOn(adapter, 'prepare').mockResolvedValue({ kind: 'reject', reason: 'observed', retryable: false });
    await setup([adapter]);
    const targets = [{ lane: 'auto' }, { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }] as const;
    for (const [index, target] of targets.entries()) {
      const taskId = `fresh-detect-${index}`;
      server.send(createEnvelope('task.offer', { target, agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER }, { taskId, seq: server.nextSeq() }));
      await server.waitFor(envelope => envelope.type === 'task.decline' && envelope.task_id === taskId);
    }
    const handed = prepare.mock.calls.map(([input]) => input.detected?.kind === 'available' ? input.detected.version : undefined);
    expect(handed).toHaveLength(2);
    // Each prepare() got an observation taken for its own offer: distinct, in order.
    expect(observed.indexOf(handed[1]!)).toBeGreaterThan(observed.indexOf(handed[0]!));
    expect(observed.indexOf(handed[0]!)).toBeGreaterThanOrEqual(0);
  });

  it.each(['claude', 'codex'] as const)('declines %s API-key login before claiming a subscription offer', async id => {
    const fake = fileURLToPath(new URL(`./fixtures/fake-${id}.mjs`, import.meta.url));
    const resolveBin = () => ({ command: fake, source: 'env' as const });
    const environment: Record<string, string> = id === 'claude'
      ? { FAKE_CLAUDE_AUTH_STATUS: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'apiKeyHelper' }) }
      : { FAKE_CODEX_ACCOUNT_TYPE: 'apiKey' };
    const adapter = id === 'claude' ? new ClaudeAdapter({ resolveBin }) : new CodexAdapter({ resolveBin });
    const runtimeEnvironment = testRuntimeEnvironment();
    vi.spyOn(adapter, 'runtimeEnvironment').mockResolvedValue({ ...runtimeEnvironment, env: { ...runtimeEnvironment.env, ...environment } });
    await setup([adapter]);
    const taskId = `subscription-key-${id}`;
    server.send(createEnvelope('task.offer', { target: { lane: 'harness', harnessId: id, selection: { mode: 'subscription', modelId: 'fixture-model' } },
      agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER }, { taskId, seq: server.nextSeq() }));
    const declined = await server.waitFor(envelope => envelope.type === 'task.decline' && envelope.task_id === taskId);
    expect(declined.payload, JSON.stringify(declined.payload)).toMatchObject({ code: 'invalid_request', retryable: false });
    expect(server.received.some(envelope => envelope.type === 'task.claim' && envelope.task_id === taskId)).toBe(false);
  });

  /**
   * A real built-in adapter on its fake CLI. `environment` is read per call:
   * tests fill it after `setup()`, so the daemon's startup observation (the
   * full `detect()`) runs on the plain fixture and only the offer sees the toggles.
   */
  function fakeRuntime<T extends ClaudeAdapter | CodexAdapter>(adapter: T, environment: Record<string, string>): T {
    const runtimeEnvironment = testRuntimeEnvironment();
    // Both adapters share `runtimeEnvironment`'s signature; spyOn cannot resolve it through the generic.
    vi.spyOn(adapter as ClaudeAdapter, 'runtimeEnvironment').mockImplementation(async () => ({ ...runtimeEnvironment, env: { ...runtimeEnvironment.env, ...environment } }));
    return adapter;
  }
  const fakeBin = (id: 'claude' | 'codex') => () => ({ command: fileURLToPath(new URL(`./fixtures/fake-${id}.mjs`, import.meta.url)), source: 'env' as const });
  const subscriptionOffer = (id: 'claude' | 'codex', taskId: string) => createEnvelope('task.offer', {
    target: { lane: 'harness', harnessId: id, selection: { mode: 'subscription', modelId: 'fixture-model' } },
    agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER,
  }, { taskId, seq: server.nextSeq() });

  it('#2468: a slow Claude subscription login is read once, in its launch context, within the startup deadline', async () => {
    // 30 s startup / 18 s login / 25 s cap, scaled: one read fits, a second would not.
    const log = path.join(await tmpDir('byok-claude-auth-log-'), 'auth.jsonl');
    const spawnCwds: string[] = [];
    const spawnFn = ((command: string, args: string[], options: { cwd?: string }) => {
      spawnCwds.push(String(options.cwd));
      return realSpawn(command, args, options);
    }) as unknown as SpawnFn;
    const environment: Record<string, string> = {};
    const adapter = fakeRuntime(new ClaudeAdapter({ resolveBin: fakeBin('claude'), spawnFn }), environment);
    claudeProbeTimeouts.override(adapter, { authStatus: 3_400 });
    await setup([adapter], { startupTimeoutMs: 4_000 });
    Object.assign(environment, { FAKE_CLAUDE_AUTH_DELAY_MS: '2200', FAKE_CLAUDE_AUTH_LOG_FILE: log });
    const taskId = 'claude-slow-login';
    server.send(subscriptionOffer('claude', taskId));
    await server.waitFor(e => e.type === 'task.claim' && e.task_id === taskId);
    await server.waitFor(e => e.type === 'task.started' && e.task_id === taskId);
    await server.waitFor(e => e.type === 'task.complete' && e.task_id === taskId);
    expect(server.received.some(e => (e.type === 'task.decline' || e.type === 'task.fail') && e.task_id === taskId)).toBe(false);
    const reads = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { cwd: string });
    expect(reads).toHaveLength(1);
    expect(spawnCwds).toHaveLength(1);
    expect(await fs.realpath(reads[0]!.cwd)).toBe(await fs.realpath(spawnCwds[0]!));
  }, 15_000);

  it('#2468: a Claude subscription login past its deadline declines retryably before claim', async () => {
    const spawnFn = vi.fn(() => { throw new Error('unexpected Claude session spawn'); });
    const environment: Record<string, string> = {};
    const adapter = fakeRuntime(new ClaudeAdapter({ resolveBin: fakeBin('claude'), spawnFn }), environment);
    claudeProbeTimeouts.override(adapter, { authStatus: 200 });
    await setup([adapter]);
    environment.FAKE_CLAUDE_AUTH_HANG = '1';
    const taskId = 'claude-login-timeout';
    server.send(subscriptionOffer('claude', taskId));
    const declined = await server.waitFor(e => e.type === 'task.decline' && e.task_id === taskId);
    expect(declined.payload).toMatchObject({ retryable: true });
    expect(server.received.some(e => e.type === 'task.claim' && e.task_id === taskId)).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('#2468: Codex subscription admission skips `login status` and confirms the account at launch', async () => {
    // A hung `login status` would hold admission for its 25 s cap, past this startup deadline.
    const environment: Record<string, string> = {};
    const adapter = fakeRuntime(new CodexAdapter({ resolveBin: fakeBin('codex') }), environment);
    await setup([adapter], { startupTimeoutMs: 8_000 });
    environment.FAKE_CODEX_LOGIN_HANG = '1';
    const taskId = 'codex-login-hang';
    server.send(subscriptionOffer('codex', taskId));
    await server.waitFor(e => e.type === 'task.started' && e.task_id === taskId);
    await server.waitFor(e => e.type === 'task.complete' && e.task_id === taskId);
    expect(server.received.some(e => (e.type === 'task.decline' || e.type === 'task.fail') && e.task_id === taskId)).toBe(false);
  }, 15_000);

  it('declines an undeclared dispatch selection before preparing or claiming', async () => {
    const base = new StubRuntimeAdapter('claude');
    let supportsSelection = true;
    const adapter: RuntimeAdapter = { get descriptor() { return { ...base.descriptor, selectionModes: supportsSelection ? ['device-default', 'subscription'] as const : ['device-default'] as const }; }, detect: () => base.detect(), prepare: vi.fn((input) => base.prepare(input)), runtimeEnvironment: () => base.runtimeEnvironment() };
    await setup([adapter]);
    supportsSelection = false;
    const taskId = 'unsupported-selection';
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x', target: { lane: 'harness', harnessId: 'claude', selection: { mode: 'subscription', modelId: 'model' } } }, { taskId, seq: server.nextSeq() }));
    const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === taskId);
    expect(decline.payload).toMatchObject({ reason: 'runtime "claude" has no advertised support for the requested selection or effort', retryable: false });
    expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === taskId)).toBe(false);
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(base.startCalls).toHaveLength(0);
  });

  describe('default auto-select order (no runtimePreference configured)', () => {
    it('claude wins over pi when both are present (pi is the fallback, not the default)', async () => {
      const pi = new StubRuntimeAdapter('pi');
      const claude = new StubRuntimeAdapter('claude');
      await setup([pi, claude]);

      server.send(
        createEnvelope('task.offer', { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), ...FRESH_OFFER,  instruction: 'x' }, { taskId: 'task-order-1', seq: server.nextSeq() }),
      );

      const claim = await server.waitFor((e) => e.type === 'task.claim');
      expect(claim.payload).toMatchObject({ executor: { id: 'claude' } });
      // `task.claim` is sent before `adapter.start()` is actually invoked
      // (workspace-dir creation awaits in between — see `handleOffer`) —
      // wait for `task.started` too before asserting on `startCalls`,
      // mirroring daemon-task-loop.test.ts's own claim-then-started
      // convention, so this isn't a race against that async gap.
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-order-1');
      expect(claude.startCalls).toHaveLength(1);
      expect(pi.startCalls).toHaveLength(0);
    });

    it('pi wins when it is the only runtime present (the fallback actually works)', async () => {
      const pi = new StubRuntimeAdapter('pi');
      await setup([pi]);

      server.send(
        createEnvelope('task.offer', { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), ...FRESH_OFFER,  instruction: 'x' }, { taskId: 'task-order-2', seq: server.nextSeq() }),
      );

      const claim = await server.waitFor((e) => e.type === 'task.claim');
      expect(claim.payload).toMatchObject({ executor: { id: 'pi' } });
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-order-2');
      expect(pi.startCalls).toHaveLength(1);
    });
  });

  it('runtimePreference overrides the default order: codex wins when listed first, even with claude and pi both present', async () => {
    const pi = new StubRuntimeAdapter('pi');
    const claude = new StubRuntimeAdapter('claude');
    const codex = new StubRuntimeAdapter('codex');
    await setup([pi, claude, codex], { runtimePreference: ['codex', 'claude', 'pi'] });

    server.send(
      createEnvelope('task.offer', { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), ...FRESH_OFFER,  instruction: 'x' }, { taskId: 'task-preference-1', seq: server.nextSeq() }),
    );

    const claim = await server.waitFor((e) => e.type === 'task.claim');
    expect(claim.payload).toMatchObject({ executor: { id: 'codex' } });
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-preference-1');
    expect(codex.startCalls).toHaveLength(1);
    expect(claude.startCalls).toHaveLength(0);
    expect(pi.startCalls).toHaveLength(0);
  });

  describe('Host-configured version block (#1103)', () => {
    const blockedDetect = {
      kind: 'available' as const,
      version: 'codex-cli 0.161.0',
      versionVerdict: { state: 'block' as const, qualifiedVersion: '0.169.0', matched: '0.16.' },
    };

    it('declines an explicit blocked runtime non-retryably, without claiming or starting it', async () => {
      const blocked = new StubRuntimeAdapter('codex');
      await setup([blocked]);
      await server.waitFor(envelope => envelope.type === 'conn.hello');
      vi.spyOn(blocked, 'detect').mockResolvedValue(blockedDetect);
      const taskId = 'task-version-block-explicit';
      server.send(
        createEnvelope(
          'task.offer',
          { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x', target: { lane: 'harness', harnessId: 'codex', selection: { mode: 'device-default' } } },
          { taskId, seq: server.nextSeq() },
        ),
      );
      const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === taskId);
      expect(decline.payload).toMatchObject({
        retryable: false, code: 'runtime_unavailable', runtimeUnavailable: { cause: 'version_blocked' },
      });
      expect(decline.type === 'task.decline' ? (decline.payload as { reason?: string }).reason : '').toContain('blocked by the device version policy');
      expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === taskId)).toBe(false);
      expect(blocked.startCalls).toHaveLength(0);
    });

    it('auto selection skips a blocked candidate and keeps the candidate order', async () => {
      const blocked = new StubRuntimeAdapter('codex', blockedDetect);
      const claude = new StubRuntimeAdapter('claude');
      await setup([blocked, claude], { runtimePreference: ['codex', 'claude'] });
      const taskId = 'task-version-block-auto';
      server.send(
        createEnvelope(
          'task.offer',
          { target: { lane: 'auto' }, agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x' },
          { taskId, seq: server.nextSeq() },
        ),
      );
      const claim = await server.waitFor((e) => e.type === 'task.claim' && e.task_id === taskId);
      expect(claim.payload).toMatchObject({ executor: { id: 'claude' } });
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);
      expect(blocked.startCalls).toHaveLength(0);
      expect(claude.startCalls).toHaveLength(1);
      expect(server.received.some((e) => e.type === 'task.decline' && e.task_id === taskId)).toBe(false);
    });
  });

  describe('explicit-runtime regression pin (unchanged by this batch)', () => {
    it.each(['not-found', 'not-executable', 'timeout', 'probe-failed'] as const)('an explicit runtime with %s still declines pre-claim, never claims', async (kind) => {
      // Regression pin for the pre-existing (M1 gap #5) behavior — unchanged
      // by this batch's capability-matching/preference-order additions. Also
      // covered end-to-end by daemon-task-loop.test.ts's own identical
      // scenario; asserted again here so this workstream's own test file is
      // self-contained proof the explicit path wasn't disturbed.
      const pi = new StubRuntimeAdapter('pi');
      await setup([pi]);
      const hello = await server.waitFor((envelope) => envelope.type === 'conn.hello');
      expect(hello.payload).toMatchObject({ harnesses: [{ id: 'pi' }] });
      vi.spyOn(pi, 'detect').mockResolvedValue({ kind });

      server.send(
        createEnvelope(
          'task.offer',
          { agentRef: freshTestAgentRef(), ...FRESH_OFFER,  instruction: 'x', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } } },
          { taskId: 'task-unavailable-1', seq: server.nextSeq() },
        ),
      );

      const decline = await server.waitFor((e) => e.type === 'task.decline');
      expect(decline.payload).toMatchObject({ retryable: true });
      expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-unavailable-1')).toBe(false);
      expect(pi.startCalls).toHaveLength(0);
    });
  });

  describe('dispatchSelection authority', () => {
    it('seals one descriptor snapshot through preparation, claim, environment projection, and prepared start', async () => {
      const sourceDescriptor = {
        id: 'pi',
        selectionModes: ['device-default', 'subscription'] as const,
        capabilities: {
          steer: true,
          resume: true,
          approvalInteractive: false,
          // Pi projects MCP toolsets. An Agent offer carries the Agent memory MCP whenever the daemon admits it.
          mcpToolsets: true,
        },
      };
      const starts: RuntimeOperationStartInput[] = [];
      const sessions: StubSession[] = [];
      const adapter: RuntimeAdapter = {
        descriptor: sourceDescriptor,
        runtimeEnvironment: async () => testRuntimeEnvironment(),
        async detect() {
          return { kind: 'available', version: '0.0.0' };
        },
        async prepare(input) {
          expect(input.descriptor).not.toBe(sourceDescriptor);
          sourceDescriptor.capabilities.steer = false;
          return {
            kind: 'prepared',
            operation: {
              start: async (startInput) => {
                starts.push(startInput);
                const session = new StubSession('descriptor-snapshot-session');
                sessions.push(session);
                return session;
              },
            },
          };
        },
      };
      const previousOpenAi = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'descriptor-snapshot-secret';
      try {
        await setup([adapter]);
        const taskId = 'task-descriptor-snapshot';
        server.send(
          createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER,  instruction: 'x', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } } }, { taskId, seq: server.nextSeq() }),
        );
        const claim = await server.waitFor((envelope) => envelope.type === 'task.claim' && envelope.task_id === taskId);
        await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === taskId);
        expect(claim.type === 'task.claim' && claim.payload.capabilities).toMatchObject({ steer: true });
        expect(starts).toHaveLength(1);
        expect(Object.isFrozen(starts[0]?.manifest)).toBe(true);
        expect(Object.isFrozen(starts[0]?.manifest.descriptor)).toBe(true);
        expect(starts[0]?.manifest.descriptor.capabilities.steer).toBe(true);
        expect(starts[0]?.manifest.forwardedEnvironmentNames).toContain('OPENAI_API_KEY');
        expect(starts[0]?.env.OPENAI_API_KEY).toBe('descriptor-snapshot-secret');
        expect(JSON.stringify(starts[0]?.manifest)).not.toContain('descriptor-snapshot-secret');
        sessions[0]?.emit({ type: 'turn_end' });
        await server.waitFor((envelope) => envelope.type === 'task.complete' && envelope.task_id === taskId);
      } finally {
        if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousOpenAi;
      }
    });

    const providerProfile = {
      profileRef: 'openai', profileRevision: '1',
      profileHash: `sha256:${'a'.repeat(64)}`, requiredCapabilities: [],
    };

    it('refuses a Pi profile before prepare when the device has no launcher', async () => {
      const taskId = 'task-pi-missing-launcher-falsifier';
      const storeDir = await tmpDir('byok-pi-falsifier-store-');
      const spawnCalls: unknown[] = [];
      const pi = new PiAdapter({
        resolveBin: () => ({ command: PI_FIXTURE_PATH, source: 'env' }),
        spawnFn: (() => {
          spawnCalls.push(undefined);
          throw new Error('Pi spawn is forbidden during pre-claim admission');
        }) as never,
      });
      const prepareSpy = vi.spyOn(pi, 'prepare');
      daemon = createDaemonWithAdapters(
        { storage: { scratchRoot: testScratchRoot() },
          localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
          productId: 'test-product-pi-falsifier',
          serverUrl: server.url,
          agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
          storeDir,
        },
        [pi],
      );
      await daemon.pair('pairing-code');
      await daemon.start();

      server.send(
        createEnvelope(
          'task.offer',
          { agentRef: freshTestAgentRef(), ...FRESH_OFFER,
            instruction: 'x',
            target: {
              lane: 'harness',
              harnessId: 'pi',
              selection: { mode: 'byok-profile', providerProfile },
            },
          },
          { taskId, seq: server.nextSeq() },
        ),
      );

      await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === taskId);
      expect({
        declined: server.received.some((envelope) => envelope.type === 'task.decline' && envelope.task_id === taskId),
        claimed: server.received.some((envelope) => envelope.type === 'task.claim' && envelope.task_id === taskId),
        prepares: prepareSpy.mock.calls.length,
        started: server.received.some((envelope) => envelope.type === 'task.started' && envelope.task_id === taskId),
        spawns: spawnCalls.length,
      }).toEqual({ declined: true, claimed: false, prepares: 0, started: false, spawns: 0 });
    });

    it('selects Pi from its advertised provider-profile mode', async () => {
      const pi = new StubRuntimeAdapter('pi');
      const claude = new StubRuntimeAdapter('claude');
      await setup([claude, pi]);

      const target = {
        lane: 'harness' as const,
        harnessId: 'pi' as const,
        selection: { mode: 'byok-profile' as const, providerProfile, modelId: 'gpt-5.2' },
      };
      server.send(
        createEnvelope(
          'task.offer',
          { agentRef: freshTestAgentRef(), ...FRESH_OFFER,  instruction: 'x', target },
          { taskId: 'task-selection-1', seq: server.nextSeq() },
        ),
      );

      const claim = await server.waitFor((e) => e.type === 'task.claim');
      expect(claim.payload).toMatchObject({ executor: { id: 'pi' } });
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-selection-1');
      expect(pi.startCalls[0]?.task.target).toEqual(target);
      expect(claude.startCalls).toHaveLength(0);
    });
  });
});

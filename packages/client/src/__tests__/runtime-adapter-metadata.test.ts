import { FRESH_DAEMON_EGRESS, FRESH_OFFER } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, HarnessIdSchema, RuntimeIdSchema } from '@byok-sdk/protocol';
import { RUNTIME_IDS } from '@byok-sdk/protocol/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeAdapter, CodexAdapter, DshAdapter, GrokAdapter, HermesAdapter, PiAdapter,
  isWireRuntimeId, observeRuntimeDetection, projectRuntimeObservation, taskRuntimeTarget, validateRuntimeDetectResult,
} from '../adapters/index';
import { fakeRuntimeAdapter, type FakeRuntimeAdapterId } from '../testing/index';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { DaemonEvent } from '../daemon/observer';
import { parseRuntimeObservations } from '../runtime-detection';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapter } from '../types';
import { testScratchRoot } from './fixtures/execution-scratch';
import { TestServer } from './fixtures/test-server';

const dirs: string[] = [];
const daemons: Daemon[] = [];
const servers: TestServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(daemons.splice(0).map(d => d.stop()));
  await Promise.all(servers.splice(0).map(s => s.close()));
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-adapter-metadata-'));
  dirs.push(dir);
  return dir;
}

/** The real built-in adapters, constructed with their defaults. */
function builtIns(home: string): Record<FakeRuntimeAdapterId, RuntimeAdapter> {
  return {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    pi: new PiAdapter(),
    grok: new GrokAdapter(),
    hermes: new HermesAdapter({ home }),
    dsh: new DshAdapter({ home, model: { provider: 'deepseek', model: 'deepseek-v4-flash', keyEnv: 'TEST_DSH_PROVIDER_KEY' } }),
  };
}

async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

describe('selection target', () => {
  it('derives the wire runtime ids and the harness exclusion from one list', () => {
    expect(RuntimeIdSchema.options).toEqual([...RUNTIME_IDS]);
    for (const id of RUNTIME_IDS) expect(HarnessIdSchema.safeParse(id).success).toBe(false);
  });

  it('selects every built-in adapter exactly as RuntimeIdSchema says', async () => {
    const adapters = builtIns(await tempDir());
    for (const adapter of Object.values(adapters)) {
      const { id } = adapter.descriptor;
      const wire = RuntimeIdSchema.safeParse(id).success;
      expect(isWireRuntimeId(id)).toBe(wire);
      expect(taskRuntimeTarget(adapter.descriptor)).toEqual(wire ? { runtime: id } : { harnessId: id });
      if (!wire) expect(HarnessIdSchema.parse(id)).toBe(id);
    }
    expect(Object.values(adapters).map(adapter => taskRuntimeTarget(adapter.descriptor))).toEqual([
      { runtime: 'claude' }, { runtime: 'codex' }, { runtime: 'pi' }, { harnessId: 'grok' }, { harnessId: 'hermes' }, { harnessId: 'dsh' },
    ]);
  });
});

describe('supported platforms', () => {
  it('every built-in adapter declares its platforms', async () => {
    const adapters = builtIns(await tempDir());
    expect(Object.fromEntries(Object.entries(adapters).map(([id, adapter]) => [id, adapter.descriptor.platforms]))).toEqual({
      claude: ['darwin', 'linux', 'win32'],
      codex: ['darwin', 'linux', 'win32'],
      pi: ['darwin', 'linux', 'win32'],
      grok: ['darwin', 'linux'],
      hermes: ['darwin', 'linux', 'win32'],
      dsh: ['darwin', 'linux'],
    });
    expect(new PiAdapter({ durablePi: true }).descriptor.platforms).toEqual(['darwin', 'linux']);
    expect(Object.isFrozen(adapters.grok.descriptor.platforms)).toBe(true);
  });

  it('a custom descriptor without platforms keeps no restriction', () => {
    const descriptor = freezeRuntimeAdapterDescriptor({ id: 'custom', supportsDispatchSelection: false, capabilities: { steer: false, resume: false, approvalInteractive: false } });
    expect(descriptor).not.toHaveProperty('platforms');
  });

  it.each(['grok'] as const)('Windows refuses %s with platform_unsupported before any probe', async (id) => {
    const resolveBin = vi.fn(() => { throw new Error('the probe must not run'); });
    const adapter = new GrokAdapter({ resolveBin });
    const detect = vi.spyOn(adapter, 'detect');
    const detected = await onPlatform('win32', () => observeRuntimeDetection(adapter));
    expect(detected).toEqual({ kind: 'refused', reason: 'platform_unsupported' });
    expect(detect).not.toHaveBeenCalled();
    expect(resolveBin).not.toHaveBeenCalled();
    expect(projectRuntimeObservation(adapter.descriptor, detected)).toMatchObject({ id, present: false, outcome: 'refused', reason: 'platform_unsupported' });
  });

  it('Windows refuses dsh with platform_unsupported before any probe', async () => {
    const resolveBin = vi.fn(() => { throw new Error('the probe must not run'); });
    const adapter = new DshAdapter({ home: await tempDir(), model: { provider: 'deepseek', model: 'deepseek-v4-flash', keyEnv: 'TEST_DSH_PROVIDER_KEY' }, resolveBin });
    expect(await onPlatform('win32', () => observeRuntimeDetection(adapter))).toEqual({ kind: 'refused', reason: 'platform_unsupported' });
    expect(resolveBin).not.toHaveBeenCalled();
  });

  it('Windows still probes an adapter that supports it', async () => {
    const adapter = new ClaudeAdapter({ resolveBin: () => { throw new Error('resolver failed'); } });
    expect(await onPlatform('win32', () => observeRuntimeDetection(adapter))).toEqual({ kind: 'probe-failed' });
  });

  // #608: a real Hermes run on windows-latest qualified Hermes there.
  it('Windows probes Hermes', async () => {
    const resolveBin = vi.fn(() => { throw new Error('resolver failed'); });
    const adapter = new HermesAdapter({ home: await tempDir(), resolveBin });
    expect(await onPlatform('win32', () => observeRuntimeDetection(adapter))).toEqual({ kind: 'probe-failed' });
    expect(resolveBin).toHaveBeenCalled();
  });

  it('the strict decoders accept the platform refusal', () => {
    expect(validateRuntimeDetectResult({ kind: 'refused', reason: 'platform_unsupported' })).toEqual({ kind: 'refused', reason: 'platform_unsupported' });
    expect(parseRuntimeObservations([{ id: 'grok', present: false, outcome: 'refused', reason: 'platform_unsupported', steer: false, resume: true }]))
      .toEqual([{ id: 'grok', present: false, outcome: 'refused', reason: 'platform_unsupported', steer: false, resume: true }]);
  });
});

describe('adapter-declared facts the daemon reads instead of the runtime id', () => {
  it('only Pi declares a file scope and provider profile binding, also as the durable worker', async () => {
    const adapters = builtIns(await tempDir());
    expect(Object.fromEntries(Object.entries(adapters).map(([id, adapter]) => [id, {
      fileScope: adapter.descriptor.fileScope, providerProfileBinding: adapter.descriptor.providerProfileBinding,
    }]))).toEqual({
      claude: { fileScope: undefined, providerProfileBinding: undefined },
      codex: { fileScope: undefined, providerProfileBinding: undefined },
      pi: { fileScope: { lanes: ['rpc'] }, providerProfileBinding: true },
      grok: { fileScope: undefined, providerProfileBinding: undefined },
      hermes: { fileScope: undefined, providerProfileBinding: undefined },
      dsh: { fileScope: undefined, providerProfileBinding: undefined },
    });
    const durable = new PiAdapter({ durablePi: true }).descriptor;
    expect(durable.fileScope).toEqual({ lanes: ['rpc'] });
    expect(durable.providerProfileBinding).toBe(true);
    expect(Object.isFrozen(adapters.pi.descriptor.fileScope!.lanes)).toBe(true);
  });

  it('only Pi projects the MCP environment, keeping its private names from MCP servers', async () => {
    const adapters = builtIns(await tempDir());
    expect(Object.entries(adapters).filter(([, adapter]) => adapter.projectMcpEnvironment !== undefined).map(([id]) => id)).toEqual(['pi']);
    expect(adapters.pi.projectMcpEnvironment!({ PATH: '/bin', PI_CODING_AGENT_DIR: '/x', BYOK_PI_LAUNCH: '1', ANTHROPIC_API_KEY: 'k' }))
      .toEqual({ PATH: '/bin' });
  });

  it('a custom descriptor keeps its declarations through freezing', () => {
    const descriptor = freezeRuntimeAdapterDescriptor({
      id: 'acme', supportsDispatchSelection: true, fileScope: { lanes: ['rpc', 'prepared'] }, providerProfileBinding: true,
      capabilities: { steer: false, resume: false, approvalInteractive: false },
    });
    expect(descriptor.fileScope).toEqual({ lanes: ['rpc', 'prepared'] });
    expect(descriptor.providerProfileBinding).toBe(true);
    expect(freezeRuntimeAdapterDescriptor({ id: 'bare', supportsDispatchSelection: false, capabilities: { steer: false, resume: false, approvalInteractive: false } }))
      .not.toHaveProperty('fileScope');
  });
});

describe('daemon detection authority', () => {
  /** A real adapter descriptor narrowed to a platform this host is not. */
  function unsupportedHere(): RuntimeAdapter & { detect: ReturnType<typeof vi.fn> } {
    const real = fakeRuntimeAdapter('claude');
    return {
      descriptor: freezeRuntimeAdapterDescriptor({ ...real.descriptor, platforms: [process.platform === 'aix' ? 'sunos' : 'aix'] }),
      detect: vi.fn(real.detect),
      prepare: real.prepare,
      runtimeEnvironment: real.runtimeEnvironment,
    };
  }

  it('declines a platform-refused runtime with the typed reason and matches the local projection', async () => {
    const root = await tempDir();
    const server = await TestServer.start(); servers.push(server);
    const refused = unsupportedHere();
    const available = fakeRuntimeAdapter('codex', {
      detect: { kind: 'available', version: 'codex-cli 9.9.9', authPresent: true, advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '0.160.0' } },
    });
    const daemon = createDaemonWithAdapters({
      storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Metadata', productId: 'metadata',
      storeDir: path.join(root, 'store'), serverUrl: server.url,
      agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS,
    }, [refused, available]);
    daemons.push(daemon);
    const events: DaemonEvent[] = [];
    daemon.subscribe(event => { events.push(event); });
    await daemon.pair('pairing-code'); await daemon.start();

    const hello = await server.waitFor(e => e.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('wrong envelope');
    expect(hello.payload.runtimes?.map(runtime => runtime.id)).toEqual(['codex']);

    // The public, transport-free projection equals the daemon's event, field for field.
    const detected = events.find(event => event.kind === 'runtimes-detected');
    if (detected?.kind !== 'runtimes-detected') throw new Error('no runtimes-detected event');
    expect(detected.runtimes).toEqual(await Promise.all([refused, available].map(async adapter =>
      projectRuntimeObservation(adapter.descriptor, await observeRuntimeDetection(adapter)))));
    expect(detected.runtimes[0]).toMatchObject({ id: 'claude', outcome: 'refused', reason: 'platform_unsupported' });
    expect(detected.runtimes[1]).toMatchObject({ id: 'codex', version: 'codex-cli 9.9.9', qualifiedVersion: '0.160.0', authPresent: true });

    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'no start', runtime: 'claude', ...FRESH_OFFER }, { taskId: 'platform-refused', seq: server.nextSeq() }));
    const declined = await server.waitFor(e => e.type === 'task.decline');
    if (declined.type !== 'task.decline' || declined.payload.sealed !== undefined) throw new Error('wrong envelope');
    expect(declined.payload.reason).toBe(`platform_unsupported: runtime "claude" does not support ${process.platform}`);
    expect(declined.payload.retryable).toBe(true);
    expect(refused.detect).not.toHaveBeenCalled();
  });
});

describe('fakeRuntimeAdapter', () => {
  it.each(['claude', 'codex', 'pi', 'grok', 'hermes'] as const)('%s carries the real adapter descriptor', async (id) => {
    const real = builtIns(await tempDir())[id];
    const fake = fakeRuntimeAdapter(id);
    expect(fake.descriptor).toEqual(real.descriptor);
    expect(fake.descriptor.capabilities).toEqual(real.descriptor.capabilities);
  });

  it('runs only the behavior the test supplies', async () => {
    const fake = fakeRuntimeAdapter('codex');
    expect(await fake.detect()).toEqual({ kind: 'available' });
    expect(await fake.prepare({} as never)).toEqual({ kind: 'reject', reason: 'fake codex adapter has no prepare behavior', retryable: false });
    const prepare = vi.fn(async () => ({ kind: 'reject' as const, reason: 'custom', retryable: true }));
    const custom = fakeRuntimeAdapter('pi', { detect: async () => ({ kind: 'not-found' }), prepare });
    expect(await custom.detect()).toEqual({ kind: 'not-found' });
    expect(await custom.prepare({} as never)).toEqual({ kind: 'reject', reason: 'custom', retryable: true });
    expect(() => fakeRuntimeAdapter('nope' as FakeRuntimeAdapterId)).toThrow('unknown runtime adapter id: nope');
  });
});

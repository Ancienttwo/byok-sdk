import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ protocol: 4, helperVersion: '4', requests: [] as Record<string, unknown>[],
  barriers: [] as Record<string, unknown>[], commands: [] as string[], deferBarrier: false,
  finishBarrier: undefined as (() => void) | undefined, barrierError: null as Error | null, barrierStderr: '',
  error: undefined as { code: string; message: string } | undefined, hangOpen: false,
  finishOpen: undefined as (() => void) | undefined,
  budgets: [] as number[] }));
vi.mock('../util/agent-memory-helper-release', () => ({ verifyAgentMemoryFilesystemHelper: (bin: string) => bin }));
vi.mock('node:child_process', () => ({
  execFile: (_bin: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    wire.commands.push(args[0]!);
    const { timeout, ...rest } = options;
    expect(rest).toMatchObject({ shell: false, windowsHide: true, env: {}, maxBuffer: 4096 });
    expect(Number.isInteger(timeout)).toBe(true);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(60_000);
    wire.budgets.push(timeout as number);
    return { stdin: new Writable({
      write(chunk, _encoding, done) { wire.barriers.push(JSON.parse(String(chunk))); done(); },
      final(done) {
        let settled = false;
        const signal = options.signal as AbortSignal | undefined;
        const finish = (error: Error | null, stderr: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          callback(error, '', stderr);
        };
        const abort = () => finish(new Error('aborted'), '');
        const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { killed: true }), ''), timeout as number);
        signal?.addEventListener('abort', abort, { once: true });
        wire.finishBarrier = () => finish(wire.barrierError, wire.barrierStderr);
        if (!wire.deferBarrier) queueMicrotask(wire.finishBarrier);
        done();
      },
    }) };
  },
  spawn: () => {
    wire.commands.push('serve');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null,
      kill: () => { child.exitCode = 0; child.emit('exit', 0, null); return true; },
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const request = JSON.parse(String(chunk)) as Record<string, unknown>;
          wire.requests.push(request);
          const reply = () => {
            const response = wire.error === undefined
              ? { ok: true, result: request.op === 'open' ? { helperVersion: wire.helperVersion, identity: request.expectedIdentity } : {} }
              : { ok: false, error: wire.error };
            child.stdout.write(`${JSON.stringify({ id: request.id, protocol: wire.protocol, ...response })}\n`);
            if (request.op === 'close') { child.exitCode = 0; child.emit('exit', 0, null); }
          };
          if (wire.hangOpen && request.op === 'open') wire.finishOpen = reply;
          else queueMicrotask(reply);
          done();
        },
      }),
    });
    return child;
  },
}));
import { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import { withAgentMemoryHelperProbe } from '../daemon/agent-memory-helper-probe';
import { AgentHomeLayout } from '../agent-home';
import { agentMemoryBackendProof, provenAgentMemoryBackend, recoverAgentMemoryBackend } from '../daemon/create-daemon/services';
import { composeStartLanes } from '../daemon/create-daemon/start-lanes';
import { composeStartRunnerDeps } from '../daemon/create-daemon/start-runner';
import { setHelloCapability } from '../daemon/create-daemon/presence';
import type { DaemonScope } from '../daemon/create-daemon/scope';
import type { StartRun } from '../daemon/create-daemon/start-run';
import type { AgentMemoryIntentTransport } from '@byok-sdk/protocol/agent-memory';
import { AGENT_MEMORY_INTENT_CAPABILITY, AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY } from '@byok-sdk/protocol';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
  vi.restoreAllMocks();
  wire.hangOpen = false;
  wire.finishOpen = undefined;
  wire.budgets.length = 0;
  wire.barriers.length = 0;
  wire.commands.length = 0;
  wire.deferBarrier = false;
  wire.finishBarrier = undefined;
  wire.barrierError = null;
  wire.barrierStderr = '';
  wire.protocol = 4;
  wire.helperVersion = '4';
  wire.error = undefined;
  wire.requests.length = 0;
});
function input() {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  return { helperBin: path.resolve('helper'), canonicalHome: path.resolve('host/agents/one'), ancestorRoot: path.resolve('host'), homeIdentity: { dev: 1n, ino: 2n } };
}

describe('protocol 4 transport contract (#605)', () => {
  async function existingRootInput() {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-helper-root-')));
    roots.push(parent);
    const ancestorRoot = path.join(parent, 'host');
    // Simulate a root left by a prior process before its first helper open.
    await fs.mkdir(ancestorRoot);
    const home = await new AgentHomeLayout(ancestorRoot).resolve({ agentId: 'one', profileRevision: 'p1' });
    return { ...input(), ancestorRoot, canonicalHome: home.canonicalHome };
  }

  it('runs the barrier for an existing root and shares it before concurrent first opens', async () => {
    const selected = await existingRootInput();
    wire.deferBarrier = true;
    const first = openAgentMemoryFilesystemHelper(selected);
    const second = openAgentMemoryFilesystemHelper(selected);
    expect(wire.commands).toEqual(['root-barrier']);
    expect(wire.barriers).toEqual([{ root: selected.ancestorRoot }]);
    expect(wire.requests).toEqual([]);
    wire.finishBarrier!();
    const filesystems = await Promise.all([first, second]);
    filesystems.push(await openAgentMemoryFilesystemHelper(selected));
    expect(wire.commands).toEqual(['root-barrier', 'serve', 'serve', 'serve']);
    await Promise.all(filesystems.map(filesystem => filesystem.close()));
  });

  it('skips the root barrier on win32 without requiring access to the drive root', async () => {
    const selected = input();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
    wire.barrierError = new Error('root parent access denied');
    const ancestorRoot = path.join(path.parse(selected.ancestorRoot).root, 'ByokHost');
    const filesystem = await openAgentMemoryFilesystemHelper({ ...selected, ancestorRoot });
    expect(wire.commands).toEqual(['serve']);
    expect(wire.barriers).toEqual([]);
    expect(wire.requests[0]?.ancestorRoot).toBe(ancestorRoot);
    await filesystem.close();
  });

  it.each(['root_barrier_sync_failed', 'private native failure at /private/host'])('refuses open with a bounded cause for %s', async stderr => {
    const selected = await existingRootInput();
    wire.barrierError = new Error(`private native failure at ${selected.ancestorRoot}`);
    wire.barrierStderr = `${stderr}\n`;
    const code = stderr === 'root_barrier_sync_failed' ? stderr : 'root_barrier_process_failed';
    await expect(openAgentMemoryFilesystemHelper(selected)).rejects.toMatchObject({ name: 'AgentMemoryIoError', cause: code,
      message: `Agent memory hostStorageRoot durability barrier failed (${code}); helper open refused` });
    expect(wire.commands).toEqual(['root-barrier']);
    expect(wire.requests).toEqual([]);
  });

  it('allows a full-sync open to exceed the ordinary request deadline', async () => {
    const selected = input();
    wire.hangOpen = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const opened = withAgentMemoryHelperProbe(() => openAgentMemoryFilesystemHelper(selected));
    // Attach immediately so the old implementation's early timeout is an assertion failure.
    const result = opened.then(filesystem => ({ filesystem }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10_001);
    wire.finishOpen!();
    expect(await result).not.toHaveProperty('error');
    const filesystem = await opened;
    await filesystem.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps ordinary helper requests on the ten-second budget', async () => {
    const selected = input();
    wire.hangOpen = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const refused = expect(openAgentMemoryFilesystemHelper(selected)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(wire.requests.map(request => request.op)).toEqual(['open']);
    await vi.advanceTimersByTimeAsync(1);
    await refused;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends the separately selected ancestor root in the first request', async () => {
    const selected = input();
    const filesystem = await openAgentMemoryFilesystemHelper(selected);
    expect(wire.requests[0]).toEqual({ id: 'm1', protocol: 4, op: 'open', root: selected.canonicalHome,
      ancestorRoot: selected.ancestorRoot, expectedIdentity: { kind: 'unix', dev: '1', ino: '2' } });
    await filesystem.close();
  });
  it('gives the Host a same-volume remedy when the ancestor chain is refused', async () => {
    wire.error = { code: 'ancestor_volume_mismatch', message: 'private diagnostic must not be forwarded' };
    const refused = openAgentMemoryFilesystemHelper(input());
    await expect(refused).rejects.toThrow('ancestor_volume_mismatch. Put the agents directory on the same volume as hostStorageRoot.');
    await expect(refused).rejects.not.toThrow(wire.error.message);
    expect(wire.requests.map(request => request.op)).toEqual(['open', 'close']);
  });
  it.each([3, 5])('rejects response protocol %s without granting filesystem authority', async protocol => {
    wire.protocol = protocol;
    await expect(openAgentMemoryFilesystemHelper(input())).rejects.toThrow('invalid response');
    expect(wire.requests.map(request => request.op)).toEqual(['open']);
  });
  it.each(['3', '5'])('rejects helper version %s even in a protocol-4 response', async version => {
    wire.helperVersion = version;
    await expect(openAgentMemoryFilesystemHelper(input())).rejects.toThrow('version mismatch');
    expect(wire.requests.map(request => request.op)).toEqual(['open', 'close']);
  });
  it.each([undefined, '', 'relative'])('rejects absent or invalid ancestor %s before spawn', async ancestorRoot => {
    const selected = input();
    // The public type requires this field; also prove the untyped caller boundary.
    await expect(openAgentMemoryFilesystemHelper({ ...selected, ancestorRoot: ancestorRoot as string })).rejects.toThrow('explicit absolute ancestor root');
    expect(wire.requests).toEqual([]);
  });
});


describe('recoverable daemon memory proof (#2200)', () => {
  async function scope() {
    input();
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-proof-')));
    roots.push(root);
    const abort = new AbortController();
    const refreshHello = vi.fn();
    const acquire = vi.fn(async () => { throw new Error('controlled home unavailable'); });
    const fetch = vi.fn(async () => { throw new Error('controlled Host unavailable'); });
    // SAFETY: these tests use only fetch; it always rejects before a Host response is needed.
    const transport = { fetch } as unknown as AgentMemoryIntentTransport;
    // SAFETY: the selected composition paths read only these scope members; no daemon is started.
    const selected = {
      config: { agentHome: { hostStorageRoot: root }, agentMemoryIntents: transport, serverUrl: 'http://localhost' },
      agentHomeManager: { layout: { hostRootInput: () => root }, supportsTaskFreeProjection: () => false, acquire },
      resolveAgentMemoryFilesystemHelperBin: () => path.resolve('helper'),
      daemonState: { blobLifecycleAbort: abort, helloCapabilities: [], connection: { refreshHello } },
      adapters: [], overrides: {}, observer: {},
    } as unknown as DaemonScope;
    Object.assign(selected, { setHelloCapability: (flag: Parameters<typeof setHelloCapability>[1], wanted: boolean) => setHelloCapability(selected, flag, wanted) });
    return { selected, abort, refreshHello, fetch, acquire };
  }
  async function timeout(selected: DaemonScope, kind: 'root' | 'open') {
    wire.deferBarrier = kind === 'root';
    wire.hangOpen = kind === 'open';
    const proving = provenAgentMemoryBackend(selected);
    // Flush real filesystem metadata before advancing only the controlled helper clock.
    await vi.waitFor(() => expect(kind === 'root' ? wire.barriers.length : wire.requests.length).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(10_001);
    expect(agentMemoryBackendProof(selected).status).toBeUndefined();
    await vi.advanceTimersByTimeAsync(49_999);
    await expect(proving).resolves.toBeUndefined();
    expect(agentMemoryBackendProof(selected).status).toBe('unproven');
    expect(agentMemoryBackendProof(selected).backend).toBeUndefined();
    expect(wire.budgets).toEqual([60_000]);
  }
  it.each(['root', 'open'] as const)('keeps a %s timeout unproven, then recovers both live lanes and refreshes hello', async kind => {
    const { selected, abort, refreshHello, fetch, acquire } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await timeout(selected, kind);
    // SAFETY: composeStartLanes reads only record and sealedRun from this startup fixture.
    const run = { record: { tenantId: 'tenant', deviceId: 'device' }, sealedRun: {}, agentMemoryBackend: undefined, agentMemoryIntentBackend: undefined } as unknown as StartRun;
    const lanes = composeStartLanes(selected, run);
    const { deps } = composeStartRunnerDeps(selected, { ...run, ...lanes, sendEnvelope: vi.fn(), withReplyTransition: async work => work(), recordReplyState: vi.fn() });
    const notice = { intentId: 'intent', agentRef: { agentId: 'agent', profileRevision: 'p1' } };
    expect(deps.agentMemoryCommit).toBeUndefined();
    await expect(lanes.processAgentMemoryIntentNotice(notice)).rejects.toMatchObject({ reason: 'filesystem_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(lanes.capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    wire.deferBarrier = false;
    wire.hangOpen = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('proven'));
    expect(deps.agentMemoryCommit).toBeDefined();
    expect(lanes.capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    expect(lanes.capabilities).toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    expect(refreshHello).toHaveBeenCalledTimes(1);
    await expect(lanes.processAgentMemoryIntentNotice(notice)).rejects.toMatchObject({ reason: 'local_io_failed' });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([['[byok/client] agent memory backend unproven'], ['[byok/client] agent memory backend recovered']]);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('logs proven once and never re-probes a proven or authoritatively refused volume', async () => {
    const { selected } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await provenAgentMemoryBackend(selected)).toBeDefined();
    await provenAgentMemoryBackend(selected);
    expect(log.mock.calls).toEqual([['[byok/client] agent memory backend proven']]);
    const { selected: refused, abort } = await scope();
    wire.barrierError = new Error('unsupported');
    wire.barrierStderr = 'root_barrier_unsupported';
    expect(await provenAgentMemoryBackend(refused)).toBeUndefined();
    const commands = wire.commands.length;
    await provenAgentMemoryBackend(refused);
    vi.useFakeTimers();
    recoverAgentMemoryBackend(refused, abort.signal, vi.fn());
    expect(agentMemoryBackendProof(refused).status).toBe('refused');
    expect(wire.commands).toHaveLength(commands);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain('[byok/client] agent memory backend refused: Agent memory hostStorageRoot durability barrier failed (root_barrier_unsupported)');
    expect(log).toHaveBeenCalledTimes(2);
  });
  it('caps retry backoff and stop cancels an in-flight probe without a diagnostic or another timer', async () => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await timeout(selected, 'open');
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = wire.commands.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(wire.commands).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(wire.commands.length).toBeGreaterThan(count));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(log.mock.calls).toEqual([['[byok/client] agent memory backend unproven']]);
    const count = wire.commands.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(wire.commands.length).toBeGreaterThan(count));
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(agentMemoryBackendProof(selected).status).toBe('unproven');
    expect(log).toHaveBeenCalledTimes(1);
  });
  it.each(['root', 'open'] as const)('stop cancels an in-flight %s proof without declaring a refusal', async kind => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.deferBarrier = kind === 'root';
    wire.hangOpen = kind === 'open';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const proving = provenAgentMemoryBackend(selected, abort.signal);
    await vi.waitFor(() => expect(kind === 'root' ? wire.barriers.length : wire.requests.length).toBeGreaterThan(0));
    abort.abort();
    await expect(proving).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(agentMemoryBackendProof(selected).status).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('stop cancels a pending retry before a helper is spawned', async () => {
    const { selected, abort } = await scope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await timeout(selected, 'open');
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    const count = wire.commands.length;
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(wire.commands).toHaveLength(count);
  });
});

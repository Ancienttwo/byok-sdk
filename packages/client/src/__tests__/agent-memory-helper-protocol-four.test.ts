import { EventEmitter } from 'node:events';
import { promises as fs, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ protocol: 4, helperVersion: '4', requests: [] as Record<string, unknown>[],
  barriers: [] as Record<string, unknown>[], commands: [] as string[], deferBarrier: false,
  finishBarrier: undefined as (() => void) | undefined, barrierError: null as Error | null, barrierStderr: '',
  error: undefined as { code: string; message: string } | undefined, hangOpen: false,
  finishOpen: undefined as (() => void) | undefined,
  budgets: [] as number[], barrierSignals: [] as AbortSignal[], hangClose: false,
  hangExit: false, closeExitCode: 0 as number | null, closeExitSignal: null as NodeJS.Signals | null,
  kills: [] as NodeJS.Signals[], openStartedAt: undefined as number | undefined,
  onRoot: undefined as (() => void) | undefined, onOpen: undefined as (() => void) | undefined }));
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
    wire.barrierSignals.push(options.signal as AbortSignal);
    return { stdin: new Writable({
      write(chunk, _encoding, done) {
        wire.barriers.push(JSON.parse(String(chunk))); wire.onRoot?.(); wire.onRoot = undefined; done();
      },
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
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => { wire.kills.push(signal); child.signalCode = signal; child.emit('exit', null, signal); return true; },
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const request = JSON.parse(String(chunk)) as Record<string, unknown>;
          wire.requests.push(request);
          if (request.op === 'open') {
            wire.openStartedAt = performance.now(); wire.onOpen?.(); wire.onOpen = undefined;
          }
          const reply = () => {
            const response = wire.error === undefined
              ? { ok: true, result: request.op === 'open' ? { helperVersion: wire.helperVersion, identity: request.expectedIdentity } : {} }
              : { ok: false, error: wire.error };
            child.stdout.write(`${JSON.stringify({ id: request.id, protocol: wire.protocol, ...response })}\n`);
            if (request.op === 'close' && !wire.hangExit) {
              child.exitCode = wire.closeExitCode; child.signalCode = wire.closeExitSignal;
              child.emit('exit', wire.closeExitCode, wire.closeExitSignal);
            }
          };
          if (wire.hangOpen && request.op === 'open') wire.finishOpen = reply;
          else if (wire.hangClose && request.op === 'close') { /* controlled stalled close */ }
          else queueMicrotask(reply);
          done();
        },
      }),
    });
    return child;
  },
}));
import { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import { openAgentMemoryFilesystemHelperWithBudget } from '../daemon/agent-memory-fs-helper-internal';
import * as helperInternal from '../daemon/agent-memory-fs-helper-internal';
import { AgentHomeLayout } from '../agent-home';
import { agentMemoryBackendProof, agentMemoryCommitStore, initializeAgentMemoryBackend, recoverAgentMemoryBackend } from '../daemon/create-daemon/services';
import { openStartRun } from '../daemon/create-daemon/start-run';
import * as processTree from '../adapters/process-tree';
import * as shellEnvironment from '../login-shell-environment';
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
beforeEach(() => { vi.spyOn(fs, 'access').mockResolvedValue(); });
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
  vi.restoreAllMocks();
  wire.hangOpen = false;
  wire.finishOpen = undefined;
  wire.budgets.length = 0;
  wire.barrierSignals.length = 0;
  wire.hangClose = false;
  wire.hangExit = false; wire.closeExitCode = 0; wire.closeExitSignal = null;
  wire.kills.length = 0; wire.openStartedAt = undefined;
  wire.onRoot = undefined; wire.onOpen = undefined;
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
    wire.deferBarrier = false;
    filesystems.push(await openAgentMemoryFilesystemHelper(selected));
    expect(wire.commands).toEqual(['root-barrier', 'serve', 'serve', 'root-barrier', 'serve']);
    expect(wire.barriers).toHaveLength(2);
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
    const opened = openAgentMemoryFilesystemHelperWithBudget(selected, { timeout: 60_000 });
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
  async function scope(existingRoot?: string) {
    input();
    const root = existingRoot ?? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-proof-')));
    if (existingRoot === undefined) roots.push(root);
    const abort = new AbortController();
    const refreshHello = vi.fn();
    const acquire = vi.fn(async () => { throw new Error('controlled home unavailable'); });
    const fetch = vi.fn(async () => { throw new Error('controlled Host unavailable'); });
    // SAFETY: these tests reject before a Host response or acquired home is needed.
    const transport = { fetch } as unknown as AgentMemoryIntentTransport;
    // SAFETY: each test supplies the scope members its composition paths read.
    const selected = {
      config: { agentHome: { hostStorageRoot: root }, agentMemoryIntents: transport, serverUrl: 'http://localhost', productId: 'proof-test' },
      agentHomeManager: { layout: { hostRootInput: () => root }, supportsTaskFreeProjection: () => false, acquire },
      resolveAgentMemoryFilesystemHelperBin: () => path.resolve('helper'),
      daemonState: { blobLifecycleAbort: abort, helloCapabilities: [], connection: { refreshHello } },
      adapters: [], overrides: {}, observer: {},
    } as unknown as DaemonScope;
    Object.assign(selected, { setHelloCapability: (flag: Parameters<typeof setHelloCapability>[1], wanted: boolean) => setHelloCapability(selected, flag, wanted) });
    await initializeAgentMemoryBackend(selected);
    return { selected, abort, refreshHello, fetch, acquire, root };
  }
  function lanes(selected: DaemonScope) {
    // SAFETY: only record/sealedRun and the explicitly supplied runner callbacks are used.
    const run = { record: { tenantId: 'tenant', deviceId: 'device' }, sealedRun: {}, agentMemoryBackend: undefined, agentMemoryIntentBackend: undefined } as unknown as StartRun;
    const result = composeStartLanes(selected, run);
    const { deps } = composeStartRunnerDeps(selected, { ...run, ...result, sendEnvelope: vi.fn(), withReplyTransition: async work => work(), recordReplyState: vi.fn() });
    return { ...result, deps };
  }
  function nextHelperRequest(kind: 'root' | 'open'): Promise<void> {
    return new Promise(resolve => { if (kind === 'root') wire.onRoot = resolve; else wire.onOpen = resolve; });
  }
  async function timeout(selected: DaemonScope, kind: 'root' | 'open') {
    wire.deferBarrier = kind === 'root';
    wire.hangOpen = kind === 'open';
    const ready = nextHelperRequest(kind);
    recoverAgentMemoryBackend(selected, selected.daemonState.blobLifecycleAbort!.signal, vi.fn());
    await ready;
    await vi.advanceTimersByTimeAsync(10_001);
    expect(agentMemoryBackendProof(selected).status).toBeUndefined();
    await vi.advanceTimersByTimeAsync(49_999);
    expect(agentMemoryBackendProof(selected).status).toBe('unproven');
    expect(agentMemoryBackendProof(selected).backend).toBeUndefined();
    expect(wire.budgets).toEqual([60_000]);
  }
  it.each(['root', 'open'] as const)('keeps a %s timeout unproven, then recovers both live lanes and refreshes hello', async kind => {
    const { selected, abort, refreshHello, fetch, acquire } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.deferBarrier = kind === 'root';
    wire.hangOpen = kind === 'open';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const live = lanes(selected);
    await vi.waitFor(() => expect(kind === 'root' ? wire.barriers.length : wire.requests.length).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(agentMemoryBackendProof(selected).status).toBe('unproven');
    const notice = { intentId: 'intent', agentRef: { agentId: 'agent', profileRevision: 'p1' } };
    expect(live.deps.agentMemoryCommit).toBeUndefined();
    await expect(live.processAgentMemoryIntentNotice(notice)).rejects.toMatchObject({ reason: 'filesystem_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(live.capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    wire.deferBarrier = false;
    wire.hangOpen = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('proven'));
    expect(live.deps.agentMemoryCommit).toBeDefined();
    expect(live.capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    expect(live.capabilities).toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    expect(refreshHello).toHaveBeenCalledTimes(1);
    await expect(live.processAgentMemoryIntentNotice(notice)).rejects.toMatchObject({ reason: 'local_io_failed' });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([['[byok/client] agent memory backend unproven'], ['[byok/client] agent memory backend recovered']]);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('logs proven once and never re-probes a proven or authoritatively refused volume', async () => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('proven'));
    const count = wire.commands.length;
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    expect(wire.commands).toHaveLength(count);
    expect(log.mock.calls).toEqual([['[byok/client] agent memory backend proven']]);
    const { selected: refused, abort: refusedAbort } = await scope();
    wire.barrierError = new Error('unsupported');
    wire.barrierStderr = 'root_barrier_unsupported';
    recoverAgentMemoryBackend(refused, refusedAbort.signal, vi.fn());
    await vi.waitFor(() => expect(agentMemoryBackendProof(refused).status).toBe('refused'));
    const commands = wire.commands.length;
    vi.useFakeTimers();
    recoverAgentMemoryBackend(refused, refusedAbort.signal, vi.fn());
    expect(wire.commands).toHaveLength(commands);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.mock.calls.at(-1)).toEqual(['[byok/client] agent memory backend refused: AgentMemoryIoError']);
    expect(log).toHaveBeenCalledTimes(2);
    abort.abort(); refusedAbort.abort();
  });
  it('caps retry backoff and stop cancels an in-flight probe without a diagnostic or another timer', async () => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await timeout(selected, 'open');
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = wire.commands.length;
      const ready = nextHelperRequest('open');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(wire.commands).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      await ready;
      expect(wire.commands.length).toBeGreaterThan(count);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(log.mock.calls).toEqual([['[byok/client] agent memory backend unproven']]);
    const count = wire.commands.length;
    const ready = nextHelperRequest('open');
    await vi.advanceTimersByTimeAsync(30_000);
    await ready;
    expect(wire.commands.length).toBeGreaterThan(count);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(agentMemoryBackendProof(selected).status).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
  it.each(['root', 'open', 'close'] as const)('stop cancels an in-flight %s proof without declaring a refusal', async kind => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.deferBarrier = kind === 'root'; wire.hangOpen = kind === 'open'; wire.hangClose = kind === 'close';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    await vi.waitFor(() => expect(kind === 'root' ? wire.barriers.length : wire.requests.filter(r => r.op === kind).length).toBeGreaterThan(0));
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(agentMemoryBackendProof(selected).status).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
  it('includes close in the same probe deadline', async () => {
    const { selected, abort } = await scope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.hangOpen = true; wire.hangClose = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    await vi.waitFor(() => expect(wire.finishOpen).toBeDefined());
    await vi.advanceTimersByTimeAsync(55_000);
    wire.finishOpen!();
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.requests.at(-1)?.op).toBe('close');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agentMemoryBackendProof(selected).status).toBe('unproven');
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['first', 'second'] as const)('one shared-root caller stopping (%s) leaves the other proof usable', async stopping => {
    const a = await scope(); const b = await scope(a.root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.deferBarrier = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    recoverAgentMemoryBackend(a.selected, a.abort.signal, vi.fn());
    recoverAgentMemoryBackend(b.selected, b.abort.signal, vi.fn());
    await vi.waitFor(() => expect(wire.barriers).toHaveLength(1));
    // Let both real metadata reads join the shared barrier before cancellation.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(3));
    const stopped = stopping === 'first' ? a : b;
    const live = stopping === 'first' ? b : a;
    stopped.abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.barrierSignals[0]?.aborted).toBe(false);
    expect(agentMemoryBackendProof(stopped.selected).status).not.toBe('refused');
    wire.finishBarrier!();
    await vi.waitFor(() => expect(agentMemoryBackendProof(live.selected).status).toBe('proven'));
    expect(agentMemoryBackendProof(live.selected).backend).toBeDefined();
    live.abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('the last shared-root waiter leaving reaps its shared helper and a later run retries', async () => {
    const a = await scope(); const b = await scope(a.root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.deferBarrier = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    recoverAgentMemoryBackend(a.selected, a.abort.signal, vi.fn());
    recoverAgentMemoryBackend(b.selected, b.abort.signal, vi.fn());
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(3));
    a.abort.abort(); b.abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.barrierSignals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    wire.deferBarrier = false;
    const c = await scope(a.root);
    recoverAgentMemoryBackend(c.selected, c.abort.signal, vi.fn());
    await vi.waitFor(() => expect(agentMemoryBackendProof(c.selected).status).toBe('proven'));
    expect(wire.barriers).toHaveLength(2);
    c.abort.abort();
  });
  it('leftover-copy lease attempts never bypass backoff or start probes after stop', async () => {
    const { selected, abort, root } = await scope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.mkdir(path.join(root, '.byok'));
    await fs.writeFile(path.join(root, '.byok', 'agent-memory-commit-manifest.json'), '{}');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await timeout(selected, 'open');
    const store = agentMemoryCommitStore(selected);
    const resolve = vi.fn(selected.resolveAgentMemoryFilesystemHelperBin);
    Object.assign(selected, { resolveAgentMemoryFilesystemHelperBin: resolve });
    const home = { canonicalHome: root, homeIdentity: { dev: 1n, ino: 2n } };
    const count = wire.commands.length;
    for (let i = 0; i < 3; i++) await expect(store.settle(home)).rejects.toThrow('needs a proven strict memory backend');
    expect(resolve).not.toHaveBeenCalled();
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    expect(wire.commands).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(wire.commands).toHaveLength(count);
    abort.abort();
    selected.daemonState.blobLifecycleAbort = undefined;
    await expect(store.settle(home)).rejects.toThrow('needs a proven strict memory backend');
    expect(resolve).not.toHaveBeenCalled();
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    await vi.advanceTimersByTimeAsync(100_000);
    expect(wire.commands).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refusal diagnostics include code/class without original message or path', async () => {
    const { selected, abort } = await scope();
    const error = Object.assign(new TypeError('private /home/secret value'), { code: 'ERR_HELPER_VERIFICATION' });
    const probe = vi.spyOn(helperInternal, 'openAgentMemoryFilesystemHelperWithBudget').mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('refused'));
    expect(log.mock.calls).toEqual([['[byok/client] agent memory backend refused: ERR_HELPER_VERIFICATION']]);
    const fallback = await scope();
    probe.mockRejectedValue(new TypeError('private /home/secret value'));
    recoverAgentMemoryBackend(fallback.selected, fallback.abort.signal, vi.fn());
    await vi.waitFor(() => expect(agentMemoryBackendProof(fallback.selected).status).toBe('refused'));
    expect(log.mock.calls.at(-1)).toEqual(['[byok/client] agent memory backend refused: TypeError']);
    abort.abort(); fallback.abort.abort();
  });
  async function startupScope() {
    const fixture = await scope();
    const { selected } = fixture;
    vi.spyOn(processTree, 'attachOwnedProcessGroupLedger').mockReturnValue(vi.fn());
    vi.spyOn(shellEnvironment, 'loginShellSnapshot').mockResolvedValue({ status: { source: 'inherited' } });
    const noop = vi.fn(async () => {});
    Object.assign(selected, {
      storeDir: selected.config.agentHome!.hostStorageRoot, scratchRoot: { open: noop },
      ownedProcessLedger: { reconcile: async () => ({ recorded: 0 }) }, initializeInputPreparation: noop,
      retentionSweeper: { runPass: noop, start: vi.fn() }, replaceControlServer: noop,
      initializeOwnedHostedStorage: () => ({ listRecoveryTasks: async () => [], listPendingTerminals: async () => [] }),
      cursorStore: { load: async () => 0 }, taskSettlement: { bindJournal: vi.fn() },
      terminalCommits: { hasPending: () => false }, operationalHealth: { startRun: noop },
      observer: { noteEnvironmentResolved: vi.fn(), noteRuntimesDetected: vi.fn() },
      // A deterministic slow dependency for the former blocking startup composition.
      provenAgentMemoryBackend: () => new Promise(() => {}),
    });
    Object.assign(selected.agentHomeManager!, { preflight: noop });
    Object.assign(selected.daemonState, { auth: { loadExisting: async () => ({ tenantId: 'tenant', deviceId: 'device' }) } });
    return fixture;
  }

  it.each(['ENOENT', 'EACCES'])('configured intents preserve the original startup helper error %s', async code => {
    const { selected } = await startupScope();
    const failure = Object.assign(new Error('helper configuration invalid'), { code });
    Object.assign(selected, { resolveAgentMemoryFilesystemHelperBin: () => { throw failure; } });
    await expect(openStartRun(selected, 0)).rejects.toBe(failure);
    expect(wire.commands).toEqual([]);
    expect(agentMemoryBackendProof(selected).backend).toBeUndefined();
  });

  it('configured intents fail startup when a verified helper is not executable', async () => {
    const { selected } = await startupScope();
    const failure = Object.assign(new Error('helper executable permission denied'), { code: 'EACCES' });
    vi.mocked(fs.access).mockRejectedValueOnce(failure);
    await expect(openStartRun(selected, 0)).rejects.toBe(failure);
    expect(fs.access).toHaveBeenLastCalledWith(path.resolve('helper'), constants.X_OK);
    expect(wire.commands).toEqual([]);
  });

  it('configured intents fail startup on an invalid canonical helper root', async () => {
    const { selected, root } = await startupScope();
    Object.assign(selected.agentHomeManager!.layout, { hostRootInput: () => path.join(root, 'missing') });
    await expect(openStartRun(selected, 0)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(wire.commands).toEqual([]);
  });

  it('refused proof can recover after stop, helper repair and a new start run', async () => {
    const { selected } = await startupScope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.barrierError = new Error('unsupported'); wire.barrierStderr = 'root_barrier_unsupported';
    await openStartRun(selected, 0);
    const first = lanes(selected);
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('refused'));
    expect(first.capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    selected.daemonState.blobLifecycleAbort!.abort();
    expect(agentMemoryBackendProof(selected).status).toBeUndefined();
    wire.barrierError = null; wire.barrierStderr = '';
    const restarted = await openStartRun(selected, 0);
    expect(restarted?.agentMemoryBackend).toBeUndefined();
    const second = lanes(selected);
    expect(second.capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    await vi.waitFor(() => expect(second.capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY));
    expect(agentMemoryBackendProof(selected).status).toBe('proven');
    expect(wire.barriers).toHaveLength(2);
    selected.daemonState.blobLifecycleAbort!.abort();
  });

  it('a previously proven run and root do not authorize a changed volume on restart', async () => {
    const { selected } = await startupScope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openStartRun(selected, 0);
    const first = lanes(selected);
    await vi.waitFor(() => expect(first.capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY));
    selected.daemonState.blobLifecycleAbort!.abort();
    wire.barrierError = new Error('new volume unsupported'); wire.barrierStderr = 'root_barrier_unsupported';
    const restarted = await openStartRun(selected, 0);
    expect(restarted?.agentMemoryBackend).toBeUndefined();
    const second = lanes(selected);
    expect(second.capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('refused'));
    expect(second.capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    expect(wire.barriers).toHaveLength(2);
    selected.daemonState.blobLifecycleAbort!.abort();
  });

  it('a changed helper is revalidated before a previously proven daemon restarts', async () => {
    const { selected } = await startupScope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openStartRun(selected, 0);
    const first = lanes(selected);
    await vi.waitFor(() => expect(first.capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY));
    selected.daemonState.blobLifecycleAbort!.abort();
    const failure = Object.assign(new Error('helper removed'), { code: 'ENOENT' });
    Object.assign(selected, { resolveAgentMemoryFilesystemHelperBin: () => { throw failure; } });
    await expect(openStartRun(selected, 0)).rejects.toBe(failure);
    expect(agentMemoryBackendProof(selected).backend).toBeUndefined();
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('root-barrier external %s stays unproven and reports its signal', async signal => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.barrierError = Object.assign(new Error('root helper terminated'), { code: null, signal, killed: false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const live = lanes(selected);
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('unproven'));
    expect(wire.requests).toEqual([]);
    expect(live.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    expect(log.mock.calls).toEqual([[`[byok/client] agent memory backend unproven: signal=${signal}`]]);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([7, 23])('root-barrier exit %s refuses proof and reports its exit code', async code => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.barrierError = Object.assign(new Error('root helper refused'), { code, signal: null, killed: false });
    wire.barrierStderr = 'root_barrier_unsupported';
    const live = lanes(selected);
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('refused'));
    expect(wire.requests).toEqual([]);
    expect(live.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    expect(log.mock.calls).toEqual([[`[byok/client] agent memory backend refused: exit_code=${code}`]]);
    abort.abort();
  });

  it('a close reply without child exit exhausts the same absolute deadline and stays unproven', async () => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.hangOpen = true; wire.hangExit = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const live = lanes(selected);
    await vi.waitFor(() => expect(wire.finishOpen).toBeDefined());
    await vi.advanceTimersByTimeAsync(60_000 - (performance.now() - wire.openStartedAt!) - 100);
    wire.finishOpen!();
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.requests.at(-1)?.op).toBe('close');
    expect(agentMemoryBackendProof(selected).status).toBeUndefined();
    await vi.advanceTimersByTimeAsync(99);
    expect(wire.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(wire.kills).toEqual(['SIGKILL']);
    expect(agentMemoryBackendProof(selected).status).toBe('unproven');
    expect(live.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    expect(log.mock.calls).toEqual([['[byok/client] agent memory backend unproven']]);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop cancels child reaping after a successful close reply', async () => {
    const { selected, abort } = await scope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.hangExit = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    recoverAgentMemoryBackend(selected, abort.signal, vi.fn());
    await vi.waitFor(() => expect(wire.requests.at(-1)?.op).toBe('close'));
    expect(agentMemoryBackendProof(selected).backend).toBeUndefined();
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.kills).toEqual(['SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
    expect(agentMemoryBackendProof(selected).backend).toBeUndefined();
  });

  it.each([7, 23])('nonzero exit %s after close refuses proof and reports the exit code', async code => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.closeExitCode = code;
    const live = lanes(selected);
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('refused'));
    expect(live.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    expect(log.mock.calls).toEqual([[`[byok/client] agent memory backend refused: exit_code=${code}`]]);
    abort.abort();
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('external %s after close leaves proof unproven and reports the signal', async signal => {
    const { selected, abort } = await scope();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.closeExitCode = null; wire.closeExitSignal = signal;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const live = lanes(selected);
    await vi.waitFor(() => expect(agentMemoryBackendProof(selected).status).toBe('unproven'));
    expect(live.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    expect(log.mock.calls).toEqual([[`[byok/client] agent memory backend unproven: signal=${signal}`]]);
    expect(wire.kills).toEqual([]);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('openStartRun returns within the ordinary budget while its background helper is stalled', async () => {
    const { selected, abort } = await startupScope();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.deferBarrier = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let opened = false;
    const starting = openStartRun(selected, 0).then(run => { opened = true; return run; });
    await vi.waitFor(() => expect(opened).toBe(true), { timeout: 1_000 });
    const run = await starting;
    expect(run?.agentMemoryBackend).toBeUndefined();
    const live = lanes(selected);
    await vi.waitFor(() => expect(wire.barriers).toHaveLength(1));
    expect(live.capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    expect(live.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opened).toBe(true);
    expect(agentMemoryBackendProof(selected).backend).toBeUndefined();
    wire.finishBarrier!();
    await vi.waitFor(() => expect(live.capabilities).toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY));
    selected.daemonState.blobLifecycleAbort!.abort();
    abort.abort();
  });
});

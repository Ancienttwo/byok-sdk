import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({
  helperBin: '',
  helperAvailable: true,
  deferBarrier: false,
  finishBarrier: undefined as (() => void) | undefined,
  onBarrierStarted: undefined as (() => void) | undefined,
  barrierError: null as Error | null,
  barrierStderr: '',
  barrierCalls: 0,
  hangOpen: false,
  finishOpen: undefined as (() => void) | undefined,
  onOpenStarted: undefined as (() => void) | undefined,
  closeExitCode: 0 as number | null,
  closeExitSignal: null as NodeJS.Signals | null,
}));

vi.mock('../util/agent-memory-helper-release', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util/agent-memory-helper-release')>();
  return {
    ...actual,
    resolveAgentMemoryFilesystemHelper: () => {
      if (!wire.helperAvailable) throw new Error('SDK Agent memory helper release assets missing');
      return wire.helperBin;
    },
    verifyAgentMemoryFilesystemHelper: (bin: string) => bin,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      bin: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (bin !== wire.helperBin) {
        return (actual.execFile as unknown as (...callArgs: unknown[]) => unknown)(bin, args, options, callback);
      }
      wire.barrierCalls += 1;
      const timeout = typeof options?.timeout === 'number' ? options.timeout : 60_000;
      const signal = options?.signal as AbortSignal | undefined;
      return {
        stdin: new Writable({
          write(_chunk, _encoding, done) {
            wire.onBarrierStarted?.();
            wire.onBarrierStarted = undefined;
            done();
          },
          final(done) {
            let settled = false;
            const finish = (error: Error | null, stderr: string) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              callback(error, '', stderr);
            };
            const onAbort = () => finish(new Error('aborted'), '');
            const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { killed: true }), ''), timeout);
            timer.unref?.();
            signal?.addEventListener('abort', onAbort, { once: true });
            wire.finishBarrier = () => finish(wire.barrierError, wire.barrierStderr);
            if (!wire.deferBarrier) queueMicrotask(wire.finishBarrier);
            done();
          },
        }),
      };
    },
    spawn: (bin: string, args: readonly string[], options?: Record<string, unknown>) => {
      if (bin !== wire.helperBin) {
        return (actual.spawn as unknown as (...callArgs: unknown[]) => unknown)(bin, args, options);
      }
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: (sig: NodeJS.Signals = 'SIGTERM') => {
          child.signalCode = sig;
          child.emit('exit', null, sig);
          return true;
        },
        stdin: new Writable({
          write(chunk, _encoding, done) {
            const request = JSON.parse(String(chunk)) as Record<string, unknown>;
            if (request.op === 'open') {
              wire.onOpenStarted?.();
              wire.onOpenStarted = undefined;
            }
            const reply = () => {
              const result = request.op === 'open'
                ? { helperVersion: '4', identity: request.expectedIdentity }
                : {};
              child.stdout.write(`${JSON.stringify({ id: request.id, protocol: 4, ok: true, result })}\n`);
              if (request.op === 'close') {
                child.exitCode = wire.closeExitCode;
                child.signalCode = wire.closeExitSignal;
                child.emit('exit', wire.closeExitCode, wire.closeExitSignal);
              }
            };
            if (wire.hangOpen && request.op === 'open') wire.finishOpen = reply;
            else queueMicrotask(reply);
            done();
          },
        }),
      });
      return child;
    },
  };
});

import {
  AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY,
  HOST_MCP_TASK_CONTEXT_CAPABILITY,
  type CapabilityFlag,
} from '@byok-sdk/protocol';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager, type AcceptedHelloSnapshot } from '../daemon/connection-manager';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { agentMemoryBackendProofState, initializeAgentMemoryBackend } from '../daemon/create-daemon/services';
import type { DaemonScope } from '../daemon/create-daemon/scope';
import { AgentHomeLayout } from '../agent-home';
import { CursorStore } from '../daemon/cursor-store';
import { DeviceStore } from '../daemon/store';
import { InMemoryDeviceCredentialBackend } from './fixtures/credential-backend';
import { testScratchRoot } from './fixtures/execution-scratch';
import { startRealServer, type RealServerHandle } from './fixtures/real-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testAgentHomeConfig } from './fixtures/test-agent';
import { TestServer } from './fixtures/test-server';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!;

const roots: string[] = [];
const daemons: Daemon[] = [];
const testServers: TestServer[] = [];
const realServers: RealServerHandle[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function setPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture = 'arm64'): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  Object.defineProperty(process, 'arch', { ...archDescriptor, value: arch });
}

function waitForBarrierStart(): Promise<void> {
  return new Promise((resolve) => {
    wire.onBarrierStarted = resolve;
  });
}

function isPending<T>(promise: Promise<T>): Promise<boolean> {
  const sentinel = Symbol('pending');
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 40)),
  ]).then((result) => (result === (sentinel as unknown) ? true : result));
}

beforeEach(async () => {
  setPlatform('darwin', 'arm64');
  const helperDir = await tmpDir('byok-cap-settled-helper-');
  wire.helperBin = path.join(helperDir, 'agent-memory-fs');
  await fs.writeFile(wire.helperBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  wire.helperAvailable = true;
  wire.deferBarrier = false;
  wire.finishBarrier = undefined;
  wire.onBarrierStarted = undefined;
  wire.barrierError = null;
  wire.barrierStderr = '';
  wire.barrierCalls = 0;
  wire.hangOpen = false;
  wire.finishOpen = undefined;
  wire.onOpenStarted = undefined;
  wire.closeExitCode = 0;
  wire.closeExitSignal = null;
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  Object.defineProperty(process, 'arch', archDescriptor);
  for (const daemon of daemons.splice(0).reverse()) {
    await daemon.stop().catch(() => undefined);
  }
  for (const server of testServers.splice(0).reverse()) {
    await server.close();
  }
  for (const server of realServers.splice(0).reverse()) {
    await server.close();
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function startTestServer(): Promise<TestServer> {
  const server = await TestServer.start();
  testServers.push(server);
  return server;
}

async function createPairedDaemon(
  serverUrl: string,
  pairingCode: string,
  overrides: Partial<DaemonConfig> & { readonly omitAgentHome?: boolean } = {},
): Promise<{ daemon: Daemon; deviceId: string }> {
  const { omitAgentHome, ...configOverrides } = overrides;
  const storeDir = await tmpDir('byok-cap-settled-store-');
  const daemon = createDaemonWithAdapters(
    {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-cap-settled-test' },
      productName: 'CapSettledTest',
      productId: 'cap-settled-test',
      serverUrl,
      ...(omitAgentHome ? {} : { agentHome: testAgentHomeConfig() }),
      agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      storeDir,
      ...configOverrides,
    },
    [new StubRuntimeAdapter('pi')],
    {
      deviceCredentials: new InMemoryDeviceCredentialBackend(),
      longPoll: { retryDelayMs: 25, idleDelayMs: 25 },
    },
  );
  daemons.push(daemon);
  const enrollment = await daemon.pair(pairingCode);
  return { daemon, deviceId: enrollment.deviceId };
}

describe('Daemon.whenCapabilitiesSettled (#2471)', () => {
  it('acceptance 1: waits through deferred helper proof and server ACK so first on-success-if-advertised Turn selects on-success', async () => {
    wire.deferBarrier = true;
    const barrierStarted = waitForBarrierStart();

    const real = await startRealServer({
      productId: 'cap-settled-e2e',
      longPollHoldMs: 50,
    });
    realServers.push(real);

    const { code } = await real.createPairingCode();
    const { daemon, deviceId } = await createPairedDaemon(real.url, code, {
      productId: 'cap-settled-e2e',
    });

    await daemon.start();

    // `whenOpen()` stays nonblocking (#2200) and resolves on gen 1 before the helper proof completes.
    await daemon.whenOpen({ signal: AbortSignal.timeout(5_000) });
    await barrierStarted;

    // Immediately after `whenOpen()`, the server has only seen the initial conn.hello (without commit capability).
    const beforeMachines = await real.byok.machines.list();
    expect(beforeMachines).toHaveLength(1);
    expect(beforeMachines[0]?.capabilities).toBeDefined();
    expect(beforeMachines[0]?.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);

    const settledPromise = daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(await isPending(settledPromise)).toBe(true);

    // Complete deferred macOS helper proof -> daemon refreshes conn.hello -> server HTTP-200 ACKs it.
    wire.finishBarrier!();
    const settled = await settledPromise;
    expect(settled).toEqual({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'proven',
      deploymentDiscovery: 'read',
      capabilities: expect.arrayContaining([AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY]),
    });

    // Server MachineInfo.capabilities reflects the server-acknowledged capability snapshot.
    const afterMachines = await real.byok.machines.list();
    expect(afterMachines[0]?.capabilities).toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);

    // First Turn with `agentMemoryCommit: 'on-success-if-advertised'` deterministically selects `'on-success'`.
    const taskId = 'cap-settled-first-turn';
    await real.byok.executions.submit({
      taskId,
      deviceId,
      payload: {
        instruction: 'verify settled memory commit selection',
        target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } },
        agentRef: { agentId: 'agent-settled', profileRevision: 'rev-1' },
        session: { mode: 'fresh' },
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        terminalProjection: { mode: 'none' },
        agentMemoryCommit: 'on-success-if-advertised',
      },
    });
    const offer = await real.byok.tasks.offer(taskId);
    expect(offer?.payload.agentMemoryCommit).toBe('on-success');
  });

  it('waits for server HTTP-200 ACK of the refreshed conn.hello even after helper proof completes', async () => {
    wire.deferBarrier = true;
    const barrierStarted = waitForBarrierStart();
    const server = await startTestServer();
    const { daemon } = await createPairedDaemon(server.url, 'ack-barrier-code');

    await daemon.start();
    await daemon.whenOpen({ signal: AbortSignal.timeout(5_000) });
    await barrierStarted;

    // Hold HTTP 200 on the refreshed conn.hello carrying agent-memory-commit-on-success.
    const releaseAck = server.holdNextMessagesResponse(
      (envelope) => envelope.type === 'conn.hello'
        && envelope.payload.capabilities.includes(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY),
    );
    const settledPromise = daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });

    wire.finishBarrier!();
    // Wait until the server has received the refreshed conn.hello (still holding HTTP 200).
    await vi.waitFor(() => {
      expect(server.received.some(
        (envelope) => envelope.type === 'conn.hello'
          && envelope.payload.capabilities.includes(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY),
      )).toBe(true);
    }, { timeout: 5_000 });

    // Must NOT settle before the server HTTP-200 ACK returns.
    expect(await isPending(settledPromise)).toBe(true);

    releaseAck();
    const settled = await settledPromise;
    expect(settled).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'proven',
      deploymentDiscovery: 'read',
    });
    if (settled.status !== 'settled') throw new Error('unreachable');
    expect(settled.capabilities).toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
  });

  it('acceptance 2: settles immediately for unsupported (missing helper & win32 x64), refused, not-configured, and unproven (then recovers)', async () => {
    const server = await startTestServer();

    // 2a: not-configured (agentHome absent)
    const notConfigured = await createPairedDaemon(server.url, 'code-not-configured', {
      omitAgentHome: true,
      agentEgress: undefined,
    });
    await notConfigured.daemon.start();
    const sNotConfigured = await notConfigured.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(sNotConfigured).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'not-configured',
      deploymentDiscovery: 'read',
    });
    if (sNotConfigured.status !== 'settled') throw new Error('unreachable');
    expect(sNotConfigured.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    await notConfigured.daemon.stop();

    // 2b-i: unsupported (macOS without helper assets)
    wire.helperAvailable = false;
    const unsupportedMissing = await createPairedDaemon(server.url, 'code-unsupported-missing');
    await unsupportedMissing.daemon.start();
    const sMissing = await unsupportedMissing.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(sMissing).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'unsupported',
      deploymentDiscovery: 'read',
    });
    if (sMissing.status !== 'settled') throw new Error('unreachable');
    expect(sMissing.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    await unsupportedMissing.daemon.stop();

    // 2b-ii: unsupported (Windows x64 helper lacks strictLedgerBarrier -> explicitly 'unsupported', not 'verifying')
    wire.helperAvailable = true;
    const winRoot = await tmpDir('byok-win32-unsupported-');
    setPlatform('win32', 'x64');
    const winScope = {
      config: { agentHome: { hostStorageRoot: winRoot } },
      agentHomeManager: { layout: new AgentHomeLayout(winRoot) },
      resolveAgentMemoryFilesystemHelperBin: () => wire.helperBin,
    } as unknown as DaemonScope;
    await initializeAgentMemoryBackend(winScope);
    expect(agentMemoryBackendProofState(winScope)).toBe('unsupported');
    setPlatform('darwin', 'arm64');

    // 2b-iii: unsupported (macOS with agentMemoryMcp: 'off' -> no helper resolved -> settles immediately as unsupported)
    const unsupportedOff = await createPairedDaemon(server.url, 'code-unsupported-off', {
      agentMemoryMcp: 'off',
    });
    await unsupportedOff.daemon.start();
    const sOff = await unsupportedOff.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(sOff).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'unsupported',
      deploymentDiscovery: 'read',
    });
    if (sOff.status !== 'settled') throw new Error('unreachable');
    expect(sOff.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    await unsupportedOff.daemon.stop();

    // 2c: refused (helper returns permanent refusal)
    setPlatform('darwin', 'arm64');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.barrierError = new Error('unsupported volume');
    wire.barrierStderr = 'root_barrier_unsupported';
    const refused = await createPairedDaemon(server.url, 'code-refused');
    await refused.daemon.start();
    const sRefused = await refused.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(sRefused).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'refused',
      deploymentDiscovery: 'read',
    });
    if (sRefused.status !== 'settled') throw new Error('unreachable');
    expect(sRefused.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    await refused.daemon.stop();

    // 2d: unproven (initial helper probe killed by signal -> transient error, then #2200 retry recovers)
    wire.barrierError = null;
    wire.barrierStderr = '';
    wire.closeExitCode = null;
    wire.closeExitSignal = 'SIGKILL';
    const unproven = await createPairedDaemon(server.url, 'code-unproven');
    await unproven.daemon.start();
    const sUnproven = await unproven.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(sUnproven).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'unproven',
      deploymentDiscovery: 'read',
    });
    if (sUnproven.status !== 'settled') throw new Error('unreachable');
    expect(sUnproven.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);

    // Allow the background retry to succeed; subsequent whenCapabilitiesSettled sees proven + ACKed capability.
    wire.closeExitCode = 0;
    wire.closeExitSignal = null;
    await vi.waitFor(async () => {
      const recovered = await unproven.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
      expect(recovered).toMatchObject({
        status: 'settled',
        connectionGeneration: 1,
        memoryBackend: 'proven',
        deploymentDiscovery: 'read',
      });
      if (recovered.status !== 'settled') throw new Error('unreachable');
      expect(recovered.capabilities).toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
    }, { timeout: 5_000, interval: 50 });
  });

  it('acceptance 3a: mid-proof disconnect resolves disconnected immediately, clears acceptedHello, and gen 2 settles only on its own ACK + discovery', async () => {
    wire.deferBarrier = true;
    const barrierStarted = waitForBarrierStart();
    const server = await startTestServer();
    const { daemon } = await createPairedDaemon(server.url, 'code-disconnect');

    await daemon.start();
    await daemon.whenOpen({ signal: AbortSignal.timeout(5_000) });
    await barrierStarted;

    const gen1Waiter = daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(await isPending(gen1Waiter)).toBe(true);

    // Gate gen 2's /byok/capabilities before forcing disconnect so we can prove gen 2 waits for its own discovery.
    let releaseGen2Discovery!: () => void;
    const gen2DiscoveryGate = new Promise<void>((resolve) => { releaseGen2Discovery = resolve; });

    // Force a route failure on long-poll GET -> open -> connecting.
    server.setFailEventsPolls(true);
    await expect(gen1Waiter).resolves.toEqual({ status: 'disconnected', connectionGeneration: 1 });

    // Pause discovery for gen 2, finish proof while disconnected, and allow gen 2 to connect.
    server.setCapabilityResponseGate(gen2DiscoveryGate);
    wire.finishBarrier!();
    server.setFailEventsPolls(false);

    // Wait until gen 2 opens; whenCapabilitiesSettled must wait for gen 2's own discovery pass.
    await daemon.whenOpen({ signal: AbortSignal.timeout(5_000) });
    const gen2Waiter = daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(await isPending(gen2Waiter)).toBe(true);

    releaseGen2Discovery();
    const gen2Settled = await gen2Waiter;
    expect(gen2Settled).toMatchObject({
      status: 'settled',
      connectionGeneration: 2,
      memoryBackend: 'proven',
      deploymentDiscovery: 'read',
    });
    if (gen2Settled.status !== 'settled') throw new Error('unreachable');
    expect(gen2Settled.capabilities).toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
  });

  it('acceptance 3b: daemon restart into refused never inherits run 1 proven state and keeps connectionGeneration monotonic', async () => {
    const server = await startTestServer();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { daemon } = await createPairedDaemon(server.url, 'code-restart');

    // Run 1: helper proof succeeds -> gen 1 settled with proven + commit capability.
    await daemon.start();
    const run1 = await daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(run1).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'proven',
      deploymentDiscovery: 'read',
    });
    if (run1.status !== 'settled') throw new Error('unreachable');
    expect(run1.capabilities).toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);

    await daemon.stop();

    // Run 2: same Daemon instance restarted after helper begins refusing -> gen 2 must NOT inherit run 1's proven state.
    wire.barrierError = new Error('volume switched to non-strict fs');
    wire.barrierStderr = 'root_barrier_unsupported';
    await daemon.start();
    const run2 = await daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(run2).toMatchObject({
      status: 'settled',
      connectionGeneration: 2,
      memoryBackend: 'refused',
      deploymentDiscovery: 'read',
    });
    if (run2.status !== 'settled') throw new Error('unreachable');
    expect(run2.capabilities).not.toContain(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
  });

  it('acceptance 3c: ConnectionManager ignores a late gen-1 refreshHello HTTP 200 ACK after disconnect', async () => {
    const server = await startTestServer();
    const storeDir = await tmpDir('byok-cm-stale-ack-');
    const store = new DeviceStore('stale-ack-product', storeDir, new InMemoryDeviceCredentialBackend());
    const auth = new AuthManager({ serverUrl: server.url, store, deviceName: 'stale-ack-test' });
    const enrollment = await auth.pair('stale-ack-code');
    const cursorStore = new CursorStore(storeDir);

    const capabilities: CapabilityFlag[] = ['agent-home-contract'];
    let revision = 1;
    const states: Array<{ state: string; accepted?: AcceptedHelloSnapshot }> = [];
    const refreshedAcks: AcceptedHelloSnapshot[] = [];

    const cm = new ConnectionManager({
      serverUrl: server.url,
      deviceId: enrollment.deviceId,
      productId: 'stale-ack-product',
      capabilities,
      getCapabilityRevision: () => revision,
      harnesses: [],
      auth,
      cursorStore,
      onEnvelope: () => undefined,
      onStateChange: (state, accepted) => { states.push({ state, accepted }); },
      onHelloAccepted: (accepted) => { refreshedAcks.push(accepted); },
      longPollRetryDelayMs: 25,
      longPollIdleDelayMs: 25,
    });
    try {
      await cm.start();
      await vi.waitFor(() => expect(states.some((entry) => entry.state === 'open')).toBe(true), { timeout: 5_000 });
      expect(states.find((entry) => entry.state === 'open')?.accepted).toEqual({
        revision: 1,
        capabilities: ['agent-home-contract'],
      });

      // Hold the gen-1 refreshed conn.hello HTTP 200 response.
      const releaseGen1Refresh = server.holdNextMessagesResponse(
        (envelope) => envelope.type === 'conn.hello'
          && envelope.payload.capabilities.includes(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY),
      );
      capabilities.push(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY);
      revision = 2;
      cm.refreshHello();

      await vi.waitFor(() => {
        expect(server.received.some(
          (envelope) => envelope.type === 'conn.hello'
            && envelope.payload.capabilities.includes(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY),
        )).toBe(true);
      }, { timeout: 5_000 });

      // Disconnect gen 1 while the gen-1 refreshHello HTTP 200 is still held.
      server.setFailEventsPolls(true);
      await vi.waitFor(() => expect(states.at(-1)?.state).toBe('connecting'), { timeout: 5_000 });

      // Release gen-1's late HTTP 200 ACK while disconnected; it MUST NOT invoke onHelloAccepted.
      releaseGen1Refresh();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(refreshedAcks).toEqual([]);

      // Reconnect gen 2: its own handshake opens with revision 2.
      server.setFailEventsPolls(false);
      await vi.waitFor(() => expect(states.filter((entry) => entry.state === 'open')).toHaveLength(2), { timeout: 5_000 });
      expect(states.filter((entry) => entry.state === 'open')[1]?.accepted).toEqual({
        revision: 2,
        capabilities: ['agent-home-contract', AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY],
      });
    } finally {
      await cm.stop();
      await auth.stop();
    }
  });

  it('waits for discovery-triggered refreshHello ACK (host-mcp-task-context) and reports failed discovery cleanly', async () => {
    const server = await startTestServer();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Case A: deployment declares host-mcp-task-context + deviceAssertion configured -> waits for refreshed conn.hello ACK.
    const releaseTaskContextAck = server.holdNextMessagesResponse(
      (envelope) => envelope.type === 'conn.hello'
        && envelope.payload.capabilities.includes(HOST_MCP_TASK_CONTEXT_CAPABILITY),
    );
    const withAssertion = await createPairedDaemon(server.url, 'code-task-ctx', {
      deviceAssertion: { audiences: ['test-aud'] },
    });
    await withAssertion.daemon.start();
    const waitTaskCtx = withAssertion.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });

    await vi.waitFor(() => {
      expect(server.received.some(
        (envelope) => envelope.type === 'conn.hello'
          && envelope.payload.capabilities.includes(HOST_MCP_TASK_CONTEXT_CAPABILITY),
      )).toBe(true);
    }, { timeout: 5_000 });
    expect(await isPending(waitTaskCtx)).toBe(true);

    releaseTaskContextAck();
    const settledCtx = await waitTaskCtx;
    expect(settledCtx).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'proven',
      deploymentDiscovery: 'read',
    });
    if (settledCtx.status !== 'settled') throw new Error('unreachable');
    expect(settledCtx.capabilities).toContain(HOST_MCP_TASK_CONTEXT_CAPABILITY);
    await withAssertion.daemon.stop();

    // Case B: GET /byok/capabilities returns 404 -> settles with deploymentDiscovery: 'failed'.
    server.setCapabilityDeclaration(undefined);
    const failedDiscovery = await createPairedDaemon(server.url, 'code-disc-fail');
    await failedDiscovery.daemon.start();
    const settledFailed = await failedDiscovery.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    expect(settledFailed).toMatchObject({
      status: 'settled',
      connectionGeneration: 1,
      memoryBackend: 'proven',
      deploymentDiscovery: 'failed',
    });
    await failedDiscovery.daemon.stop();

    // Case C: GET /byok/capabilities stalls past discovery timeout -> settles with deploymentDiscovery: 'timeout'.
    let releaseHungDiscovery!: () => void;
    server.setCapabilityResponseGate(new Promise<void>((resolve) => { releaseHungDiscovery = resolve; }));
    const timedOutDiscovery = await createPairedDaemon(server.url, 'code-disc-timeout');
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await timedOutDiscovery.daemon.start();
      await timedOutDiscovery.daemon.whenOpen({ signal: new AbortController().signal });
      const waitTimeout = timedOutDiscovery.daemon.whenCapabilitiesSettled({ signal: new AbortController().signal });
      await vi.advanceTimersByTimeAsync(5_000);
      const settledTimeout = await waitTimeout;
      expect(settledTimeout).toMatchObject({
        status: 'settled',
        connectionGeneration: 1,
        memoryBackend: 'proven',
        deploymentDiscovery: 'timeout',
      });
    } finally {
      vi.useRealTimers();
      releaseHungDiscovery();
      server.setCapabilityResponseGate(undefined);
      await timedOutDiscovery.daemon.stop();
    }
  });

  it('rejects on caller abort, halt, and stop (parity with whenOpen)', async () => {
    const server = await startTestServer();
    const { daemon } = await createPairedDaemon(server.url, 'code-errors');

    // Pre-start (stopped) -> DaemonNotOpenError('stopped')
    await expect(daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(1_000) }))
      .rejects.toMatchObject({ name: 'DaemonNotOpenError', reason: 'stopped' });

    // Pre-aborted signal -> signal.reason
    const preAborted = new AbortController();
    const preReason = new Error('already aborted');
    preAborted.abort(preReason);
    await expect(daemon.whenCapabilitiesSettled({ signal: preAborted.signal })).rejects.toBe(preReason);

    // Mid-wait abort while connecting -> signal.reason
    server.setFailMessagesSends(true);
    await daemon.start();
    const midAbort = new AbortController();
    const midWait = daemon.whenCapabilitiesSettled({ signal: midAbort.signal });
    const midReason = new Error('caller cancelled');
    midAbort.abort(midReason);
    await expect(midWait).rejects.toBe(midReason);

    // Mid-wait stop while connecting -> DaemonNotOpenError('stopped')
    const stopWait = daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) });
    const stopExpectation = expect(stopWait).rejects.toMatchObject({ name: 'DaemonNotOpenError', reason: 'stopped' });
    await daemon.stop();
    await stopExpectation;

    // Halt (handshake_rejected) -> DaemonHaltError('handshake_rejected')
    server.setFailMessagesSends(false);
    server.setRejectHello(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const halted = await createPairedDaemon(server.url, 'code-halted');
    await halted.daemon.start();
    await expect(halted.daemon.whenCapabilitiesSettled({ signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ name: 'DaemonHaltError', reason: 'handshake_rejected' });
  });
});

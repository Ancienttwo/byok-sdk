import { testScratchOwner } from "./fixtures/execution-scratch";
import { promises as fs, readFileSync } from 'node:fs';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import {
  AgentHomeBusyError,
  AgentHomeLeaseCorruptError,
  AgentHomeLeaseHeldError,
  setAgentHomeLeaseFaultsForTests,
  AgentHomeLayout,
  AgentHomeResolutionError,
  AgentHomeLeaseManager,
  AgentHomeManager,
  validateAgentRef,
} from '../agent-home';
import { acquirePathMutationGate, PathMutationGateBusyError } from '../util/path-mutation-gate';
import { installTestLeaseWriterProbe } from './fixtures/runtime-env';
import { outboundErrorMessage } from '../daemon/outbound-error';
import {
  currentAgentHomeLeaseWriter,
  judgeAgentHomeLeaseWriter,
  setAgentHomeLeaseWriterProbeForTests,
  type AgentHomeLeaseWriter,
  type AgentHomeLeaseWriterProbe,
} from '../agent-home-writer';
import { AgentSessionHandoffStore, AgentSessionHandoffMismatchError } from '../daemon/agent-session-handoff-store';
import { isAgentSessionLedgerName, isAgentTaskTerminalName } from '../daemon/retention/session-ledgers';
import { AgentEgressController } from '../daemon/agent-egress-controller';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentReliableSpool } from '../daemon/agent-egress-spool';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import {
  TaskRunner,
  type TaskRunnerDeps,
} from '../daemon/task-runner';
import { AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS } from '../daemon/task-runner/state';
import { sealRuntimeOperationManifest } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { npmNodeShim } from './fixtures/npm-node-shim';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { testHarnesses, testIngressBudget, acceptClaimSettlement } from './fixtures/activity-ingress';
import { FRESH_OFFER, freshOfferEgressDeps } from './fixtures/fresh-offer';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

const RUNTIME_FIXTURES = {
  pi: fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url)),
  claude: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)),
  codex: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
} as const;

const roots: string[] = [];

/**
 * Windows cannot spawn a `.mjs` file. Claude and Codex fixtures are reached
 * through an npm-style `.cmd` node shim, as an installed runtime is; Pi runs
 * its fixture as a `package` entry under node.
 */
async function runtimeCommand(runtime: 'claude' | 'codex'): Promise<string> {
  if (process.platform !== 'win32') return RUNTIME_FIXTURES[runtime];
  const bin = await makeRoot();
  const entry = `${runtime}-entry.mjs`;
  await fs.writeFile(path.join(bin, entry), `await import(${JSON.stringify(pathToFileURL(RUNTIME_FIXTURES[runtime]).href)});\n`);
  const shim = path.join(bin, `${runtime}.cmd`);
  await fs.writeFile(shim, npmNodeShim(entry));
  return shim;
}

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-home-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function ref(agentId: string, profileRevision = 'profile-1') {
  return { agentId, profileRevision } as const;
}

describe('SDK-owned Agent home contract', () => {
  it('rejects traversal, absolute, malformed, and oversized AgentRef segments', () => {
    expect(() => validateAgentRef(ref('../escape'))).toThrow();
    expect(() => validateAgentRef(ref('/absolute'))).toThrow();
    expect(() => validateAgentRef(ref('C:\\absolute'))).toThrow();
    expect(() => validateAgentRef(ref('a/b'))).toThrow();
    expect(() => validateAgentRef(ref('.'))).toThrow();
    expect(() => validateAgentRef(ref('..'))).toThrow();
    expect(() => validateAgentRef(ref(''))).toThrow();
    expect(() => validateAgentRef(ref('agent', ''))).toThrow();
    expect(() => validateAgentRef(ref('agent', 'revision\u0000'))).toThrow();
    expect(() => validateAgentRef(ref('é'.repeat(100)))).toThrow();
  });

  it('is the sole composer of hostStorageRoot/agents/agentId and rejects symlink escape', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    expect(() => new AgentHomeLayout('relative/root')).toThrow(/absolute/);

    const layout = new AgentHomeLayout(root);
    const resolved = await layout.resolve(ref('one'));
    expect(resolved.canonicalHome).toBe(path.join(await fs.realpath(root), 'agents', 'one'));
    expect(path.isAbsolute(resolved.canonicalHome)).toBe(true);

    const escape = path.join(root, 'agents', 'escape');
    await fs.symlink(outside, escape, 'dir');
    await expect(layout.resolve(ref('escape'))).rejects.toThrow(/real directory|escapes|outside|symlink/);

    const firstLayout = new AgentHomeLayout(root);
    const one = await firstLayout.resolve(ref('one'));
    await fs.symlink(one.canonicalHome, path.join(root, 'agents', 'two'), 'dir');
    const restartedLayout = new AgentHomeLayout(root);
    await expect(restartedLayout.resolve(ref('two'))).rejects.toThrow(/real directory|symlink/);
  });

  it.skipIf(process.platform === 'win32')('rejects a hostStorageRoot link in a directory writable by others before creating homes', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const link = path.join(root, 'host');
    await fs.symlink(outside, link, 'dir');
    await fs.chmod(root, 0o777);
    expect(() => new AgentHomeLayout(link)).toThrow(AgentHomeResolutionError);
    expect(() => new AgentHomeLayout(link)).toThrow(/agentHome.hostStorageRoot: .*directory_writable/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('rejects a hostStorageRoot behind a junction before creating homes', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const junction = path.join(root, 'host');
    await fs.symlink(outside, junction, 'junction');
    expect(() => new AgentHomeLayout(path.join(junction, 'missing'))).toThrow(AgentHomeResolutionError);
    expect(() => new AgentHomeLayout(junction)).toThrow(/agentHome.hostStorageRoot: .*windows_link/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('keeps one Agent home across profile revisions and different Agents isolated', async () => {
    const root = await makeRoot();
    const layout = new AgentHomeLayout(root);
    const first = await layout.resolve(ref('one', 'profile-1'));
    const revised = await layout.resolve(ref('one', 'profile-2'));
    const other = await layout.resolve(ref('two', 'profile-1'));
    expect(revised.canonicalHome).toBe(first.canonicalHome);
    expect(other.canonicalHome).not.toBe(first.canonicalHome);
  });

  it('initializes create-if-missing assets, preserves existing bytes, and leaves artifacts opaque', async () => {
    const root = await makeRoot();
    const projectedHomes: string[] = [];
    const manager = new AgentHomeManager({
      hostStorageRoot: root,
      projection: { prepare: async ({ cwd, agentRef }) => {
        projectedHomes.push(cwd);
        await fs.writeFile(
          path.join(cwd, 'profile.json'),
          JSON.stringify({ profileRevision: agentRef.profileRevision }),
          'utf8',
        );
      } },
    });
    const first = await manager.prepare(ref('one'));
    const home = first.resolution.canonicalHome;
    expect(first.lease.cwd).toBe(home);
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('');
    expect((await fs.stat(path.join(home, 'notes'))).isDirectory()).toBe(true);
    await first.lease.release();

    await fs.writeFile(path.join(home, 'MEMORY.md'), 'preserved edit\n', 'utf8');
    await fs.writeFile(path.join(home, 'strategy.pdf'), 'opaque artifact bytes', 'utf8');
    const second = await manager.prepare(ref('one', 'profile-2'));
    await second.lease.release();

    expect(projectedHomes).toEqual([home, home]);
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('preserved edit\n');
    expect(await fs.readFile(path.join(home, 'strategy.pdf'), 'utf8')).toBe('opaque artifact bytes');
    await expect(fs.stat(path.join(home, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('counts a home in activeHomes, and keeps maintenance out, until its base lease is released (#2349)', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const resolution = await manager.layout.resolve(ref('one'));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const acquire = manager.leaseManager.acquire.bind(manager.leaseManager);
    vi.spyOn(manager.leaseManager, 'acquire').mockImplementationOnce(async (claim) => {
      const base = await acquire(claim);
      const release = base.release.bind(base);
      (base as { release(): Promise<void> }).release = async () => { await gate; await release(); };
      return base;
    });
    const execution = await manager.executionLeaseManager.acquire(resolution, { taskId: 'task-1' });

    const releasing = execution.release();
    await vi.waitFor(() => expect(manager.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 1, attempts: 0, readerAttempts: 0 }));
    expect(await manager.withIdleHomeLease('one', async () => {})).toBe(false);

    open();
    await releasing;
    expect(manager.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });
    expect(await manager.withIdleHomeLease('one', async () => {})).toBe(true);
  });

  it('drops a home from activeHomes and passes the error on when its base lease release fails (#2349)', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const resolution = await manager.layout.resolve(ref('one'));
    const acquire = manager.leaseManager.acquire.bind(manager.leaseManager);
    vi.spyOn(manager.leaseManager, 'acquire').mockImplementationOnce(async (claim) => {
      const base = await acquire(claim);
      const release = base.release.bind(base);
      (base as { release(): Promise<void> }).release = async () => { await release(); throw new Error('base release failed'); };
      return base;
    });
    const execution = await manager.executionLeaseManager.acquire(resolution, { taskId: 'task-1' });

    await expect(execution.release()).rejects.toThrow('base release failed');
    expect(manager.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });
  });

  it('an execution claim whose acquire throws synchronously leaves no task mark: a later standalone acquire of the same resolution fails at once', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const resolution = await manager.layout.resolve(ref('one'));
    const holder = await manager.leaseManager.acquire(resolution);
    vi.spyOn(manager.leaseManager, 'acquire').mockImplementationOnce(() => { throw new Error('overridden acquire threw'); });
    await expect(manager.executionLeaseManager.acquire(resolution, { taskId: 'task-1' })).rejects.toThrow('overridden acquire threw');

    // A task-marked claim would wait up to 5 s for the standalone holder; a standalone claim fails at once.
    const started = Date.now();
    await expect(manager.leaseManager.acquire(resolution)).rejects.toBeInstanceOf(AgentHomeBusyError);
    expect(Date.now() - started).toBeLessThan(1_000);
    await holder.release();
  });

  it('atomically pre-claims concurrent same-Agent writers while different Agents remain independent', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const resolution = await manager.layout.resolve(ref('one'));
    const overlap = await Promise.allSettled([
      manager.leaseManager.acquire(resolution),
      manager.leaseManager.acquire({ ...resolution, agentRef: ref('one', 'profile-2') }),
    ]);
    const acquired = overlap.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<AgentHomeLeaseManager['acquire']>>> =>
      result.status === 'fulfilled');
    const declined = overlap.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(acquired).toHaveLength(1);
    expect(declined).toHaveLength(1);
    expect(declined[0]!.reason).toBeInstanceOf(AgentHomeBusyError);
    const two = await manager.prepare(ref('two'));
    await two.lease.release();
    await Promise.all([acquired[0]!.value.release(), acquired[0]!.value.release()]);
    const retry = await manager.prepare(ref('one', 'profile-2'));
    await retry.lease.release();
  });

  it('serializes one Agent session while keeping the home active until every different session releases', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const first = await manager.acquireExecution(ref('one'), { taskId: 'task-one' });
    await first.lease.bindSession('session-one');

    await expect(manager.acquireExecution(ref('one'), {
      taskId: 'task-one-retry',
      sessionRef: 'session-one',
    })).rejects.toBeInstanceOf(AgentHomeBusyError);
    const second = await manager.acquireExecution(ref('one'), {
      taskId: 'task-two',
      sessionRef: 'session-two',
    });
    await expect(manager.acquire(ref('one'))).rejects.toBeInstanceOf(AgentHomeBusyError);

    await first.lease.release();
    await expect(manager.acquire(ref('one'))).rejects.toBeInstanceOf(AgentHomeBusyError);
    await second.lease.release();

    const after = await manager.acquire(ref('one'));
    await after.lease.release();
  });

  it('never rekeys an exact-resume execution lease to a different runtime session', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const resumed = await manager.acquireExecution(ref('one'), {
      taskId: 'task-resume',
      sessionRef: 'session-authoritative',
    });

    await expect(resumed.lease.bindSession('session-runtime-mismatch'))
      .rejects.toThrow(/cannot rebind to a different runtime session/);
    await expect(manager.acquireExecution(ref('one'), {
      taskId: 'task-duplicate-resume',
      sessionRef: 'session-authoritative',
    })).rejects.toBeInstanceOf(AgentHomeBusyError);

    await resumed.lease.release();
    const retry = await manager.acquireExecution(ref('one'), {
      taskId: 'task-resume-retry',
      sessionRef: 'session-authoritative',
    });
    await retry.lease.release();
  });

  // No pid is this large on any supported platform, so its writer is proved gone.
  const DEAD_PID = 2147483646;
  const crashedWriter = async (): Promise<AgentHomeLeaseWriter> => ({ ...(await currentAgentHomeLeaseWriter())!, pid: DEAD_PID });

  it('reclaims its own owner\'s marker only once its writer is proved gone and the caller reclaims residue', async () => {
    const root = await makeRoot();
    const ownerId = 'store-product:stable-owner';
    const managerOf = (reclaimsResidue: boolean) => new AgentHomeManager({
      hostStorageRoot: root,
      leaseManager: new AgentHomeLeaseManager({ ownerId, reclaimsResidue: () => reclaimsResidue }),
    });
    const manager = managerOf(true);
    const initial = await manager.prepare(ref('one'));
    const home = initial.resolution.canonicalHome;
    await initial.lease.release();
    const marker = path.join(home, '.byok', 'agent-home.lease');
    const residue = { version: 1, ownerId, leaseId: 'crashed-lease', agentRef: ref('one'), canonicalHome: home };
    const refusal = async (holder: AgentHomeManager) => (await holder.prepare(ref('one')).catch((error: unknown) => error)) as AgentHomeLeaseHeldError;

    // A marker of an earlier release records no writer: never reclaimed automatically.
    await fs.writeFile(marker, JSON.stringify(residue), 'utf8');
    expect(await refusal(manager)).toMatchObject({ name: 'AgentHomeLeaseHeldError', blockedBy: 'legacy-marker', markerPath: marker });

    // Its writer is gone, but only a caller that reclaims residue (a started daemon) may take it.
    await fs.writeFile(marker, JSON.stringify({ ...residue, writer: await crashedWriter() }), 'utf8');
    const held = await refusal(managerOf(false));
    expect(held).toMatchObject({ blockedBy: 'owner-reclaim-required' });
    expect(held.message).toMatch(/start this store's daemon once/u);

    const restarted = await manager.prepare(ref('one'));
    await restarted.lease.release();
    await fs.writeFile(marker, JSON.stringify({
      ...residue,
      ownerId: 'store-product:another-owner',
      leaseId: 'live-lease',
    }), 'utf8');
    // #2333: the refusal names the owner; the reason that leaves the device keeps it and drops the paths.
    const foreign = await manager.prepare(ref('one')).catch((error: unknown) => error);
    expect(foreign).toMatchObject({ name: 'AgentHomeForeignLeaseError', ownerId: 'store-product:another-owner', markerPath: marker });
    expect(foreign).toBeInstanceOf(AgentHomeBusyError);
    expect(outboundErrorMessage(foreign)).toContain('of owner store-product:another-owner');
    expect(outboundErrorMessage(foreign)).not.toContain(marker);
  });

  it('never takes a live marker of its own owner that another process holds', async () => {
    const root = await makeRoot();
    const gateRoot = await makeRoot();
    const ownerId = 'store-product:stable-owner';
    // Another process of the same owner (a running daemon beside a memory export): its own SDK copy, so its own registry.
    vi.resetModules();
    (await import('../util/path-mutation-gate')).setPosixGateRootForTests(gateRoot);
    const other = await import('../agent-home');
    const running = await new other.AgentHomeManager({ hostStorageRoot: root,
      leaseManager: new other.AgentHomeLeaseManager({ ownerId }) }).acquire(ref('one'));
    const marker = path.join(running.lease.canonicalHome, '.byok', 'agent-home.lease');
    try {
      const manager = new AgentHomeManager({ hostStorageRoot: root, leaseManager: new AgentHomeLeaseManager({ ownerId, reclaimsResidue: () => true }) });
      await expect(manager.acquire(ref('one'))).rejects.toBeInstanceOf(AgentHomeBusyError);
      expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toMatchObject({ leaseId: running.lease.leaseId });
    } finally {
      await running.lease.release();
    }
  });

  describe('a lease writer is gone only when proved', () => {
    const HOST_A = 'a'.repeat(64);
    const HOST_B = 'b'.repeat(64);
    const BOOT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
    const BOOT_0 = '00000000-0000-4000-8000-000000000000';
    const recorded: AgentHomeLeaseWriter = { pid: 7, start: '7000', host: HOST_A, boot: BOOT_A, pidNamespace: 'pid:[1]' };
    const probeWith = (overrides: Partial<{ platform: NodeJS.Platform; host: string; boot: string; start: string; signal: 'exists' | 'gone' | 'denied' }>): AgentHomeLeaseWriterProbe => ({
      platform: overrides.platform ?? 'linux',
      pid: 1,
      host: async () => ('host' in overrides ? overrides.host : HOST_A),
      boot: async () => overrides.boot ?? BOOT_A,
      pidNamespace: async () => 'pid:[1]',
      processStart: async (pid) => (pid === 1 ? '1000' : ('start' in overrides ? overrides.start : '7000')),
      signal: () => overrides.signal ?? 'exists',
    });
    it.each([
      { case: 'written in an earlier boot', writer: { ...recorded, boot: BOOT_0 }, probe: {}, verdict: { gone: true } },
      { case: 'no process has its pid (ESRCH)', writer: recorded, probe: { signal: 'gone' as const }, verdict: { gone: true } },
      { case: 'its pid now names a later process', writer: recorded, probe: { start: '8000' }, verdict: { gone: true } },
      { case: 'it still runs', writer: recorded, probe: {}, verdict: { gone: false, blockedBy: 'writer-running' } },
      { case: 'it cannot be signalled (EPERM)', writer: recorded, probe: { signal: 'denied' as const }, verdict: { gone: false, blockedBy: 'writer-running' } },
      { case: 'on Windows, its pid exists (no start time is read)', writer: { ...recorded, boot: '1700000000', start: undefined, pidNamespace: undefined }, probe: { platform: 'win32' as const, boot: '1700000000', start: '8000' }, verdict: { gone: false, blockedBy: 'writer-running' } },
      { case: 'off Windows, it records no start time', writer: { ...recorded, start: undefined }, probe: { signal: 'gone' as const }, verdict: { gone: false, blockedBy: 'unverifiable' } },
      { case: 'its start time cannot be read', writer: recorded, probe: { start: undefined }, verdict: { gone: false, blockedBy: 'unverifiable' } },
      { case: 'written on another host', writer: { ...recorded, host: HOST_B }, probe: {}, verdict: { gone: false, blockedBy: 'other-host' } },
      { case: 'this host\'s identity cannot be read', writer: recorded, probe: { host: undefined }, verdict: { gone: false, blockedBy: 'other-host' } },
      { case: 'written in another PID namespace', writer: { ...recorded, pidNamespace: 'pid:[2]' }, probe: {}, verdict: { gone: false, blockedBy: 'other-pid-namespace' } },
      { case: 'it records no writer', writer: undefined, probe: {}, verdict: { gone: false, blockedBy: 'legacy-marker' } },
      { case: 'this boot id is malformed', writer: recorded, probe: { boot: 'boot-a' }, verdict: { gone: false, blockedBy: 'unverifiable' } },
      { case: 'off Windows, it records a boot in Windows form', writer: { ...recorded, boot: '1700000000' }, probe: {}, verdict: { gone: false, blockedBy: 'unverifiable' } },
      { case: 'on Windows, it records a boot in UUID form', writer: { ...recorded, boot: BOOT_A, start: undefined, pidNamespace: undefined }, probe: { platform: 'win32' as const, boot: '1700000000' }, verdict: { gone: false, blockedBy: 'unverifiable' } },
    ])('$case', async ({ writer, probe, verdict }) => {
      setAgentHomeLeaseWriterProbeForTests(probeWith(probe));
      try {
        expect(await judgeAgentHomeLeaseWriter(writer)).toEqual(verdict);
      } finally {
        await installTestLeaseWriterProbe();
      }
    });

    it('keeps no failed read of this process\'s identity: the next acquire records its writer', async () => {
      const root = await makeRoot();
      const manager = new AgentHomeManager({ hostStorageRoot: root });
      let hostReads = 0;
      // A transient failure, as an ioreg past its timeout, on the first read only.
      setAgentHomeLeaseWriterProbeForTests({ ...probeWith({}), host: async () => (++hostReads === 1 ? undefined : HOST_A) });
      try {
        const writerOf = async (binding: { lease: { canonicalHome: string; release(): Promise<void> } }) => {
          const marker = JSON.parse(await fs.readFile(path.join(binding.lease.canonicalHome, '.byok', 'agent-home.lease'), 'utf8')) as { writer: unknown };
          await binding.lease.release();
          return marker.writer;
        };
        expect(await writerOf(await manager.prepare(ref('one')))).toBeNull();
        expect(await writerOf(await manager.prepare(ref('one')))).toEqual({ pid: 1, start: '1000', host: HOST_A, boot: BOOT_A, pidNamespace: 'pid:[1]' });
        expect(hostReads).toBe(2);
      } finally {
        await installTestLeaseWriterProbe();
      }
    });

    it.skipIf(process.platform === 'win32')('records and judges the same start time whatever the locale and time zone', async () => {
      const saved = { TZ: process.env.TZ, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
      const environment = async (values: Record<string, string>) => {
        Object.assign(process.env, values);
        await installTestLeaseWriterProbe(); // a fresh read of this process's identity
      };
      try {
        await environment({ TZ: 'Asia/Tokyo', LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' });
        const written = (await currentAgentHomeLeaseWriter())!;
        expect(written.start).toMatch(/^\d+$/u);
        await environment({ TZ: 'America/Los_Angeles', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' });
        expect((await currentAgentHomeLeaseWriter())!.start).toBe(written.start);
        expect(await judgeAgentHomeLeaseWriter(written)).toEqual({ gone: false, blockedBy: 'writer-running' });
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await installTestLeaseWriterProbe();
      }
    });
  });

  it('treats a corrupt persisted lease marker as non-retryable integrity failure', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const initial = await manager.prepare(ref('one'));
    const marker = path.join(initial.resolution.canonicalHome, '.byok', 'agent-home.lease');
    await initial.lease.release();
    await fs.writeFile(marker, '{broken', 'utf8');

    await expect(manager.prepare(ref('one'))).rejects.toBeInstanceOf(AgentHomeLeaseCorruptError);
  });

  it('still refuses an empty lease marker; restart reclaims only a parseable one', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const initial = await manager.prepare(ref('one'));
    const marker = path.join(initial.resolution.canonicalHome, '.byok', 'agent-home.lease');
    await initial.lease.release();
    await fs.writeFile(marker, '', 'utf8');

    await expect(manager.prepare(ref('one'))).rejects.toBeInstanceOf(AgentHomeLeaseCorruptError);
    await expect(manager.prepare(ref('one'))).rejects.toThrow(
      `Agent home lease marker ${marker} is corrupt. Confirm that no process uses this Agent home, then delete this lease marker file and retry.`,
    );
  });

  const leaseTemps = async (home: string) => (await fs.readdir(path.join(home, '.byok'))).filter((name) => /^agent-home\.lease\..+\.tmp$/u.test(name));

  it('publishes the lease marker whole, and removes a killed acquire\'s temp file once its writer is proved gone', async () => {
    const root = await makeRoot();
    const ownerId = 'store-product:stable-owner';
    const manager = new AgentHomeManager({ hostStorageRoot: root, leaseManager: new AgentHomeLeaseManager({ ownerId }) });
    const initial = await manager.prepare(ref('one'));
    const home = initial.resolution.canonicalHome;
    expect(await leaseTemps(home)).toEqual([]);
    await initial.lease.release();
    const internal = path.join(home, '.byok');
    const complete = 'agent-home.lease.00000000-0000-4000-8000-000000000001.tmp';
    const torn = 'agent-home.lease.00000000-0000-4000-8000-000000000002.tmp';
    const earlierRelease = 'agent-home.lease.4242-0.tmp';
    // Killed after its temp file was synced; killed while writing one; and one an earlier release left.
    await fs.writeFile(path.join(internal, complete), JSON.stringify({ version: 1, ownerId, writer: await crashedWriter() }), 'utf8');
    await fs.writeFile(path.join(internal, torn), '{"version":1,"own', 'utf8');
    await fs.writeFile(path.join(internal, earlierRelease), 'complete residue', 'utf8');

    const next = await manager.prepare(ref('one'));
    // Only a temp file whose writer is proved gone goes; the others hold no lease.
    expect((await leaseTemps(home)).sort()).toEqual([earlierRelease, torn].sort());
    const stored = JSON.parse(await fs.readFile(path.join(internal, 'agent-home.lease'), 'utf8')) as { ownerId: string; leaseId: string };
    expect(stored).toMatchObject({ ownerId, leaseId: next.lease.leaseId });
    await next.lease.release();
  });

  it('keeps another SDK copy\'s temp file in this process while it is being linked, for the same owner', async () => {
    const root = await makeRoot();
    const gateRoot = await makeRoot();
    const ownerId = 'store-product:shared-owner';
    let ran = false;
    setAgentHomeLeaseFaultsForTests({ onStep: async (step) => {
      if (step !== 'acquire:temp-synced' || ran) return;
      ran = true;
      // A second copy of the SDK with the same owner and no daemon, as an
      // export beside a running daemon is: its acquire runs while this one
      // holds a synced temp file, before the link.
      vi.resetModules();
      (await import('../util/path-mutation-gate')).setPosixGateRootForTests(gateRoot);
      const second = await import('../agent-home');
      const other = await new second.AgentHomeManager({ hostStorageRoot: root,
        leaseManager: new second.AgentHomeLeaseManager({ ownerId }) }).acquire(ref('one'));
      await other.lease.release();
    } });
    try {
      const manager = new AgentHomeManager({ hostStorageRoot: root, leaseManager: new AgentHomeLeaseManager({ ownerId }) });
      const binding = await manager.acquire(ref('one'));
      expect(await leaseTemps(binding.resolution.canonicalHome)).toEqual([]);
      await binding.lease.release();
    } finally {
      setAgentHomeLeaseFaultsForTests(undefined);
    }
    expect(ran).toBe(true);
  });

  it('refuses a marker linked by another writer during reclaim, and leaves no temp file', async () => {
    const root = await makeRoot();
    const ownerId = 'store-product:stable-owner';
    const manager = new AgentHomeManager({ hostStorageRoot: root, leaseManager: new AgentHomeLeaseManager({ ownerId, reclaimsResidue: () => true }) });
    const initial = await manager.prepare(ref('one'));
    const home = initial.resolution.canonicalHome;
    await initial.lease.release();
    const marker = path.join(home, '.byok', 'agent-home.lease');
    const residue = { version: 1, ownerId, leaseId: 'crashed-lease', agentRef: ref('one'), canonicalHome: home, writer: await crashedWriter() };
    await fs.writeFile(marker, JSON.stringify(residue), 'utf8');
    const link = fs.link.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      calls += 1;
      // After this writer removed its own residue, another one links first.
      if (calls === 2) await fs.writeFile(marker, JSON.stringify({ ...residue, ownerId: 'store-product:another-owner', leaseId: 'raced' }), 'utf8');
      return link(source, target);
    });

    await expect(manager.prepare(ref('one'))).rejects.toThrow(/was concurrently reclaimed/u);
    expect(calls).toBe(2);
    expect(await leaseTemps(home)).toEqual([]);
    expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toMatchObject({ leaseId: 'raced' });
  });

  it('fails closed on a filesystem without hard links, and leaves neither marker nor temp file', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const initial = await manager.prepare(ref('one'));
    const home = initial.resolution.canonicalHome;
    await initial.lease.release();
    vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }));

    await expect(manager.prepare(ref('one'))).rejects.toThrow(/needs a hard link in .+ which its filesystem refused \(ENOTSUP\)/u);
    await expect(fs.lstat(path.join(home, '.byok', 'agent-home.lease'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await leaseTemps(home)).toEqual([]);
    // The refusal leaves no in-process writer behind.
    const retried = await manager.prepare(ref('one'));
    await retried.lease.release();
  });

  it('names a hard-link refusal as EPERM only off Windows, where EPERM also means access denied', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));

    const refused = manager.prepare(ref('one'));
    if (process.platform === 'win32') await expect(refused).rejects.toThrow(/could not acquire Agent home lease: operation not permitted/u);
    else await expect(refused).rejects.toThrow(/needs a hard link in .+ which its filesystem refused \(EPERM\)/u);
  });

  it('keeps an acquired lease when the temp file cannot be removed, and removes it once its writer is proved gone', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const rm = fs.rm.bind(fs);
    const refuse = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (/agent-home\.lease\..+\.tmp$/u.test(String(target))) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return rm(target, options);
    });
    const first = await manager.prepare(ref('one'));
    const home = first.resolution.canonicalHome;
    expect(await leaseTemps(home)).toHaveLength(1);
    await first.lease.release();
    refuse.mockRestore();

    // Its writer, this process, still runs.
    const [left] = await leaseTemps(home);
    await (await manager.prepare(ref('one'))).lease.release();
    expect(await leaseTemps(home)).toEqual([left]);
    // As this process would be after a restart.
    const file = path.join(home, '.byok', left!);
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), writer: await crashedWriter() }), 'utf8');
    const next = await manager.prepare(ref('one'));
    expect(await leaseTemps(home)).toEqual([]);
    await next.lease.release();
  });

  it('runs no fsync while it holds the Agent-home root gate, and names every holder when the gate is busy', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    // The first resolve of a layout materializes the configured root, once, under the gate.
    await (await manager.prepare(ref('warm'))).lease.release();
    const agentsRoot = path.join(await fs.realpath(root), 'agents');
    let syncs = 0;
    const syncedUnderGate: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        syncs += 1;
        await acquirePathMutationGate({ scope: 'agent-home-root', targetPath: agentsRoot })
          .then((gate) => gate.release(), () => { syncedUnderGate.push(path.basename(String(args[0]))); });
        await sync();
      });
      return handle;
    });
    const binding = await manager.prepare(ref('fresh'));
    await binding.lease.release();
    vi.restoreAllMocks();
    expect(syncs).toBeGreaterThan(0);
    expect(syncedUnderGate).toEqual([]);

    const held = await acquirePathMutationGate({ scope: 'agent-home-root', targetPath: agentsRoot });
    try {
      const refused = await manager.layout.resolve(ref('other')).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AgentHomeBusyError);
      expect((refused as Error).message).toBe(`Agent-home root ${agentsRoot} is held by another Agent-home operation (an admission, maintenance or a local-state relocation)`);
      expect((refused as Error).cause).toBeInstanceOf(PathMutationGateBusyError);
    } finally {
      await held.release();
    }
  });

  it('persists exact AgentRef/profileRevision/session/runtime/cwd and terminal cause in Agent home', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const binding = await manager.prepare(ref('one', 'profile-7'));
    const store = new AgentSessionHandoffStore();
    const identity = {
      agentRef: ref('one', 'profile-7'),
      sessionRef: 'session-1',
      runtimeId: 'pi',
      cwd: binding.resolution.canonicalHome,
    } as const;
    await store.record({ ...identity, taskId: 'task-1', leaseId: binding.lease.leaseId });
    await expect(store.requireMatch(identity)).resolves.toMatchObject(identity);
    await expect(store.requireMatch({ ...identity, agentRef: ref('one', 'profile-8') }))
      .rejects.toBeInstanceOf(AgentSessionHandoffMismatchError);
    await expect(store.requireMatch({ ...identity, runtimeId: 'codex' }))
      .rejects.toBeInstanceOf(AgentSessionHandoffMismatchError);
    await store.recordTerminal(identity, 'failed', 'runtime stopped');
    await binding.lease.release();

    const restarted = new AgentSessionHandoffStore();
    await expect(restarted.get(identity)).resolves.toMatchObject({
      ...identity,
      taskId: 'task-1',
      terminalCause: 'failed',
      terminalReason: 'runtime stopped',
    });
    await expect(restarted.history(identity)).resolves.toHaveLength(2);
    const evidenceDir = path.join(identity.cwd, '.byok', 'runtime-sessions');
    const [evidenceFile] = await fs.readdir(evidenceDir);
    await fs.writeFile(path.join(evidenceDir, evidenceFile!), '{broken', 'utf8');
    await expect(restarted.get(identity)).rejects.toThrow(/not valid JSON/);
  });

  it('names every session ledger so retention recognizes it, and never a task terminal file', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const agentRef = ref('names', 'profile-1');
    const binding = await manager.prepare(agentRef);
    const store = new AgentSessionHandoffStore();
    const cwd = binding.resolution.canonicalHome;
    const runtimes = ['pi', 'claude', 'codex', 'my-harness', 'harness.v2', 'my_harness', 'Custom Harness/2', 'x'.repeat(80), 'my-task-runner', 'custom-task'];
    for (const [index, runtimeId] of runtimes.entries()) {
      await store.record({ agentRef, sessionRef: `session-${index}`, runtimeId, cwd, taskId: `task-${index}`, leaseId: binding.lease.leaseId });
      await store.recordTaskTerminal({ agentRef, taskId: `failed-${index}`, runtimeId, cwd, leaseId: binding.lease.leaseId, terminalReason: 'start failed' });
    }
    await binding.lease.release();
    const evidenceDir = path.join(cwd, '.byok', 'runtime-sessions');
    const names = await fs.readdir(evidenceDir);
    const kinds = await Promise.all(names.map(async (name) => ({
      name, terminal: (await fs.readFile(path.join(evidenceDir, name), 'utf8')).includes('"kind":"task-terminal"'),
    })));
    const ledgers = kinds.filter((entry) => !entry.terminal).map((entry) => entry.name);
    const terminals = kinds.filter((entry) => entry.terminal).map((entry) => entry.name);
    expect(ledgers).toHaveLength(runtimes.length);
    expect(terminals).toHaveLength(runtimes.length);
    for (const name of terminals) expect([isAgentSessionLedgerName(name), isAgentTaskTerminalName(name)]).toEqual([false, true]);
    // A runtime id ending in `-task` is classified as terminal evidence; sweeping must honor both TTLs (#1455).
    for (const name of ledgers) expect(isAgentSessionLedgerName(name)).toBe(!name.startsWith('custom-task-'));
    expect(ledgers.filter((name) => name.startsWith('custom-task-'))).toHaveLength(1);
  });

  it('names a missing session ledger as missing, and keeps the mismatch text for a ledger that exists', async () => {
    const root = await makeRoot();
    const manager = new AgentHomeManager({ hostStorageRoot: root });
    const binding = await manager.prepare(ref('one', 'profile-7'));
    const store = new AgentSessionHandoffStore();
    const identity = { agentRef: ref('one', 'profile-7'), sessionRef: 'session-1', runtimeId: 'pi', cwd: binding.resolution.canonicalHome } as const;
    await store.record({ ...identity, taskId: 'task-1', leaseId: binding.lease.leaseId });
    await binding.lease.release();
    const missing = /^Agent session handoff session-1 does not exist on this device: it was never recorded here, or retention removed it$/;
    await expect(store.requireMatch({ ...identity, agentRef: ref('one', 'profile-8') })).rejects.toThrow(/session-1 does not match AgentRef/);
    const evidenceDir = path.join(identity.cwd, '.byok', 'runtime-sessions');
    for (const file of await fs.readdir(evidenceDir)) await fs.rm(path.join(evidenceDir, file));
    await expect(store.requireMatch(identity)).rejects.toThrow(missing);
    await expect(store.requireMatch(identity)).rejects.toBeInstanceOf(AgentSessionHandoffMismatchError);
    await expect(store.readerSessionCwd({ agentRef: identity.agentRef, sessionRef: 'session-1', runtimeId: 'pi', home: identity.cwd })).rejects.toThrow(missing);
  });

  it('seals exact AgentRef, canonical cwd and lease in an immutable runtime manifest', () => {
    const manifest = sealRuntimeOperationManifest({
      taskId: 'task-1',
      runtimeId: 'pi',
      descriptor: {
        id: 'pi',
        selectionModes: ['device-default'],
        capabilities: { steer: false, resume: true, approvalInteractive: false },
      },
      requiredToolsetIds: [],
      agentRef: ref('one', 'profile-1'),
      cwd: '/tmp/agent-home-one',
      lease: { leaseId: 'lease-1', canonicalHome: '/tmp/agent-home-one' },
      workspace: { workspaceDir: '/tmp/agent-home-one' },
      forwardedEnvironmentNames: [],
    });
    expect(manifest.cwd).toBe('/tmp/agent-home-one');
    expect(manifest.workspace.workspaceDir).toBe(manifest.cwd);
    expect(manifest.agentRef).toEqual(ref('one', 'profile-1'));
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.agentRef)).toBe(true);
    expect(Object.isFrozen(manifest.lease)).toBe(true);
  });

  it('passes the sealed canonical Agent home to the runtime adapter and persists terminal evidence', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const agentHome = new AgentHomeManager({ hostStorageRoot });
    const handoffs = new AgentSessionHandoffStore();
    const recordTerminal = handoffs.recordTerminal.bind(handoffs);
    let terminalAttempts = 0;
    const terminalEvidence = vi.spyOn(handoffs, 'recordTerminal').mockImplementation(async (...args) => {
      expect(sent.some((entry) => entry.type === 'task.complete')).toBe(false);
      terminalAttempts += 1;
      if (terminalAttempts < AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS) throw new Error('transient evidence outage');
      return recordTerminal(...args);
    });
    const blobClient: BlobResolver = {
      resolveInstruction: async () => { throw new Error('not used'); },
      uploadArtifact: async () => { throw new Error('not used'); },
    };
    const deps: TaskRunnerDeps = { advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome,
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient,
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    };
    const runner = new TaskRunner(deps);
    const agentRef = ref('agent-runtime', 'profile-3');
    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'run in the durable Agent home', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER },
      { taskId: 'task-agent-runtime', seq: 1 },
    ));

    const expectedCwd = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    expect(adapter.startCalls[0]?.ctx.workspaceDir).toBe(expectedCwd);
    expect(sent.find((entry) => entry.type === 'task.claim')?.payload).toMatchObject({ agentRef });
    expect(sent.some((entry) => entry.type === 'task.started')).toBe(true);

    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    expect(terminalEvidence).toHaveBeenCalledTimes(AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS);
    await expect(handoffs.get({
      agentRef,
      sessionRef: adapter.sessions[0]!.sessionRef,
      runtimeId: 'pi',
      cwd: expectedCwd,
    })).resolves.toMatchObject({ terminalCause: 'complete' });
  });

  it('runs different sessions for the same Agent concurrently as memory-reader Attempts, each in its own run directory under the canonical home', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      // #317: concurrent sessions in ONE canonical home are memory-reader
      // Attempts. A second writer offer is declined retryably as
      // `agent home busy`; readers each get their own run directory.
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });
    const agentRef = ref('parallel-agent', 'profile-1');

    await Promise.all([
      runner.handleEnvelope(createEnvelope(
        'task.offer',
        { instruction: 'first conversation', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER, homeAccess: 'memory-reader' },
        { taskId: 'task-parallel-a', seq: 1 },
      )),
      runner.handleEnvelope(createEnvelope(
        'task.offer',
        { instruction: 'second conversation', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER, homeAccess: 'memory-reader' },
        { taskId: 'task-parallel-b', seq: 2 },
      )),
    ]);

    expect(adapter.startCalls).toHaveLength(2);
    expect(sent.filter((entry) => entry.type === 'task.decline' || entry.type === 'task.fail')).toEqual([]);
    expect(runner.activeTaskCount).toBe(2);
    const home = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    expect(new Set(adapter.startCalls.map((call) => call.ctx.workspaceDir))).toEqual(new Set([
      path.join(home, '.byok', 'runs', 'task-parallel-a'),
      path.join(home, '.byok', 'runs', 'task-parallel-b'),
    ]));
    for (const session of adapter.sessions) session.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
  });

  it('single-flights the shared reliable spool when same-Agent sessions append concurrently', async () => {
    const agentHome = await makeRoot();
    const agentRef = ref('parallel-egress', 'profile-1');
    const controller = new AgentEgressController({
      policy: DEFAULT_AGENT_EGRESS_POLICY,
      tenantId: 'tenant-parallel',
    });
    const outcomes = await Promise.all([
      controller.appendReliable({
        homeDir: agentHome,
        agentRef,
        sessionRef: 'session-one',
        eventId: '08b9cfc8-1a55-42bd-88ac-40967b2d1431',
        payload: { status: 'one' },
      }),
      controller.appendReliable({
        homeDir: agentHome,
        agentRef,
        sessionRef: 'session-two',
        eventId: 'b67cb55a-1f91-48e5-b4ed-317ae6ca661d',
        payload: { status: 'two' },
      }),
    ]);

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(controller.reliableRecords().map((record) => record.cursor)).toEqual([1, 2]);
    expect((await AgentReliableSpool.open(agentHome)).records()).toHaveLength(2);
  });

  it('persists claimed Agent adapter-start failure before sending task.fail with exact AgentRef', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    adapter.startError = new Error('spawn failed');
    const sent: Envelope[] = [];
    const handoffs = new AgentSessionHandoffStore();
    const realRecordTaskTerminal = handoffs.recordTaskTerminal.bind(handoffs);
    const terminalEvidence = vi.spyOn(handoffs, 'recordTaskTerminal').mockImplementation(async (...args) => {
      expect(sent.some((entry) => entry.type === 'task.fail')).toBe(false);
      return realRecordTaskTerminal(...args);
    });
    const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });
    const agentRef = ref('agent-start-failure', 'profile-4');
    const taskId = 'task-agent-start-failure';

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'fail before session start', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER },
      { taskId, seq: 1 },
    ));

    const cwd = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    expect(terminalEvidence).toHaveBeenCalledTimes(1);
    expect(sent.map((entry) => entry.type)).toEqual(['task.claim', 'task.fail']);
    expect(sent.at(-1)?.payload).toMatchObject({ agentRef });
    await expect(terminalEvidence.mock.results[0]!.value)
      .resolves.toMatchObject({
      agentRef,
      taskId,
      runtimeId: 'pi',
      cwd,
      terminalCause: 'failed',
      terminalReason: expect.stringContaining('start'),
      });
    const evidenceDir = path.join(cwd, '.byok/runtime-sessions');
    const evidence = JSON.parse((await fs.readFile(path.join(evidenceDir, (await fs.readdir(evidenceDir))[0]!), 'utf8')).trim());
    expect(evidence).toMatchObject(await terminalEvidence.mock.results[0]!.value);
  });

  it('persists claimed Agent handoff-write failure before task.fail and includes the runtime sessionRef', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const handoffs = new AgentSessionHandoffStore();
    vi.spyOn(handoffs, 'record').mockRejectedValueOnce(new Error('disk unavailable'));
    const realRecordTaskTerminal = handoffs.recordTaskTerminal.bind(handoffs);
    const terminalEvidence = vi.spyOn(handoffs, 'recordTaskTerminal').mockImplementation(async (...args) => {
      expect(sent.some((entry) => entry.type === 'task.fail')).toBe(false);
      return realRecordTaskTerminal(...args);
    });
    const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });
    const agentRef = ref('agent-handoff-failure', 'profile-5');
    const taskId = 'task-agent-handoff-failure';

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'fail while writing handoff', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER },
      { taskId, seq: 1 },
    ));

    const cwd = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    expect(terminalEvidence).toHaveBeenCalledTimes(1);
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    expect(sent.map((entry) => entry.type)).toEqual(['task.claim', 'task.fail']);
    expect(sent.at(-1)?.payload).toMatchObject({ agentRef });
    await expect(terminalEvidence.mock.results[0]!.value)
      .resolves.toMatchObject({
      agentRef,
      taskId,
      runtimeId: 'pi',
      cwd,
      sessionRef: adapter.sessions[0]?.sessionRef,
      terminalCause: 'failed',
      terminalReason: expect.stringContaining('disk unavailable'),
      });
    const evidenceDir = path.join(cwd, '.byok/runtime-sessions');
    const evidence = JSON.parse((await fs.readFile(path.join(evidenceDir, (await fs.readdir(evidenceDir))[0]!), 'utf8')).trim());
    expect(evidence).toMatchObject(await terminalEvidence.mock.results[0]!.value);
  });

  it('retains the startup owner after handoff and close failures until explicit cleanup retry', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const handoffs = new AgentSessionHandoffStore();
    let closeFails = true;
    vi.spyOn(handoffs, 'record').mockImplementationOnce(async () => {
      adapter.sessions[0]!.close = async () => {
        if (closeFails) throw new Error('injected disposal failure');
      };
      throw new Error('disk unavailable');
    });
    const realRecordTaskTerminal = handoffs.recordTaskTerminal.bind(handoffs);
    const terminalEvidence = vi.spyOn(handoffs, 'recordTaskTerminal').mockImplementation(async (...args) => {
      expect(sent.some((entry) => entry.type === 'task.fail')).toBe(false);
      return realRecordTaskTerminal(...args);
    });
    const agentHome = new AgentHomeManager({ hostStorageRoot });
    const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome,
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });
    const agentRef = ref('agent-handoff-failure', 'profile-5');
    const taskId = 'task-agent-handoff-failure';

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'fail while writing handoff', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER },
      { taskId, seq: 1 },
    ));

    const cwd = await agentHome.layout.canonicalHomePath(agentRef);
    expect(agentHome.executionLeaseManager.activeAttemptCount(cwd, 'memory-writer')).toBe(1);
    await runner.handleEnvelope(createEnvelope('task.offer', {
      instruction: 'competing writer', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER,
    }, { taskId: 'competing-writer', seq: 2 }));
    expect(adapter.sessions).toHaveLength(1);
    expect(sent.at(-1)?.type).toBe('task.decline');
    closeFails = false;
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'retry cleanup' }, { taskId, seq: 3 }));
    expect(agentHome.executionLeaseManager.activeAttemptCount(cwd, 'memory-writer')).toBe(0);
    expect(sent.filter(e => e.type === 'task.fail')).toHaveLength(1);
    expect(sent.filter(e => e.type === 'task.started')).toHaveLength(0);
  });

  it('publishes a claimed failure after bounded permanent evidence failure and releases the Agent lease', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    adapter.startError = new Error('spawn failed permanently');
    const sent: Envelope[] = [];
    const handoffs = new AgentSessionHandoffStore();
    const terminalEvidence = vi.spyOn(handoffs, 'recordTaskTerminal').mockRejectedValue(new Error('disk offline'));
    const evidenceFailures: NonNullable<TaskRunnerDeps['onAgentTerminalEvidenceFailure']> extends (event: infer T) => void ? T[] : never = [];
    const agentHome = new AgentHomeManager({ hostStorageRoot });
    const agentRef = ref('agent-permanent-prestart-failure', 'profile-1');
    const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome,
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
      onAgentTerminalEvidenceFailure: (event) => evidenceFailures.push(event),
    });

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'fail safely', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER },
      { taskId: 'task-permanent-prestart-failure', seq: 1 },
    ));

    expect(terminalEvidence).toHaveBeenCalledTimes(AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS);
    expect(sent.map((entry) => entry.type)).toEqual(['task.claim', 'task.fail']);
    expect(evidenceFailures).toHaveLength(1);
    expect(evidenceFailures[0]).toMatchObject({ agentRef, cause: 'failed', attempts: AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS });
    const reacquired = await agentHome.prepare(agentRef);
    await reacquired.lease.release();
  });

  it('does not strand a running Agent or its lease when terminal evidence remains unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const handoffs = new AgentSessionHandoffStore();
    const terminalEvidence = vi.spyOn(handoffs, 'recordTerminal').mockRejectedValue(new Error('disk offline'));
    const evidenceFailures: NonNullable<TaskRunnerDeps['onAgentTerminalEvidenceFailure']> extends (event: infer T) => void ? T[] : never = [];
    const agentHome = new AgentHomeManager({ hostStorageRoot });
    const agentRef = ref('agent-permanent-active-failure', 'profile-1');
    const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome,
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
      onAgentTerminalEvidenceFailure: (event) => evidenceFailures.push(event),
    });

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'complete despite evidence outage', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER },
      { taskId: 'task-permanent-active-failure', seq: 1 },
    ));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));

    expect(sent.some((entry) => entry.type === 'task.complete')).toBe(true);
    expect(terminalEvidence).toHaveBeenCalledTimes(AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS * 2);
    expect(evidenceFailures).toHaveLength(1);
    expect(evidenceFailures[0]).toMatchObject({ agentRef, cause: 'complete' });
    const reacquired = await agentHome.prepare(agentRef);
    await reacquired.lease.release();
  });

  it('declines profile-revision and cross-Agent resume before projection or adapter start', async () => {
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    let projectionCalls = 0;
    const manager = new AgentHomeManager({
      hostStorageRoot,
      projection: { prepare: () => { projectionCalls += 1; } },
    });
    const original = await manager.prepare(ref('one', 'profile-1'));
    const handoffs = new AgentSessionHandoffStore();
    await handoffs.record({
      agentRef: ref('one', 'profile-1'),
      taskId: 'task-original',
      sessionRef: 'session-original',
      runtimeId: 'pi',
      cwd: original.resolution.canonicalHome,
      leaseId: original.lease.leaseId,
    });
    await original.lease.release();

    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome: manager,
      agentSessionHandoffs: handoffs,
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });
    const offer = (taskId: string, agentRef: ReturnType<typeof ref>, seq: number) => createEnvelope(
      'task.offer',
      {
        instruction: 'resume',
        target: { lane: 'harness', harnessId: 'pi' as const, selection: { mode: 'device-default' } },
        session: { mode: 'resume' as const, sessionRef: 'session-original' },
        agentRef,
      },
      { taskId, seq },
    );

    await runner.handleEnvelope(offer('task-revision-mismatch', ref('one', 'profile-2'), 1));
    await runner.handleEnvelope(offer('task-cross-agent', ref('two', 'profile-1'), 2));
    expect(adapter.startCalls).toHaveLength(0);
    expect(projectionCalls).toBe(1);
    const declines = sent.filter((entry) => entry.type === 'task.decline');
    expect(declines).toHaveLength(2);
    expect(declines[0]?.payload).toMatchObject({
      agentRef: ref('one', 'profile-2'),
      retryable: false,
    });
    expect(declines[1]?.payload).toMatchObject({
      agentRef: ref('two', 'profile-1'),
      retryable: false,
    });
  });

  it('drains a terminal task when an externally changed lease marker cannot be released', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hostStorageRoot = await makeRoot();
    const storeDir = await makeRoot();
    const adapter = new StubRuntimeAdapter('pi');
    const manager = new AgentHomeManager({ hostStorageRoot });
    const agentRef = ref('agent-release-conflict', 'profile-1');
    const runner = new TaskRunner({ advertisedHarnesses() { return testHarnesses(this.adapters); }, advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome: manager,
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-1',
      send: () => {},
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });

    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'finish after lease marker conflict', target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, agentRef, ...FRESH_OFFER },
      { taskId: 'task-release-conflict', seq: 1 },
    ));
    const home = path.join(await fs.realpath(hostStorageRoot), 'agents', agentRef.agentId);
    await fs.writeFile(
      path.join(home, '.byok', 'agent-home.lease'),
      JSON.stringify({
        version: 1,
        ownerId: 'other-owner',
        leaseId: 'other-lease',
        agentRef,
        canonicalHome: home,
      }),
    );
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    await fs.rm(path.join(home, '.byok', 'agent-home.lease'));
    const reacquired = await manager.prepare(agentRef);
    await reacquired.lease.release();
  });

  it.each(['pi', 'claude', 'codex'] as const)(
    'binds the %s Agent home while respecting its runtime process cwd contract',
    async (runtime) => {
      const cwd = await makeRoot();
      const observedCwds: Array<string | URL | undefined> = [];
      const piSessionCwds: string[] = [];
      // Every runtime process starts in the session cwd, as in OAR. Pi binds it
      // as a real path, because its host compares it with `process.cwd()`.
      const expectedProcessCwd = runtime === 'pi' ? await fs.realpath(cwd) : cwd;
      const spawnFn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
        observedCwds.push(options?.cwd);
        if (runtime === 'pi') {
          const configIndex = args.indexOf('--config');
          expect(configIndex).toBeGreaterThanOrEqual(0);
          const config = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf8')) as { cwd: string };
          piSessionCwds.push(config.cwd);
        }
        return realSpawn(command, args, options);
      }) as never;
      const command = runtime === 'pi' ? RUNTIME_FIXTURES.pi : await runtimeCommand(runtime);
      const adapter = runtime === 'pi'
        ? new PiAdapter({
            resolveBin: () => ({ command, source: process.platform === 'win32' ? 'package' : 'env' }),
            spawnFn,
          })
        : runtime === 'claude'
          ? new ClaudeAdapter({ resolveBin: () => ({ command, source: 'path' }), spawnFn })
          : new CodexAdapter({ resolveBin: () => ({ command, source: 'path' }), spawnFn });
      const session = await startPreparedOperation(
        adapter,
        { target: { lane: 'auto' }, instruction: 'verify cwd' },
        { workspaceDir: cwd, env: process.env },
      );
      await session.close();
      expect(observedCwds.length).toBeGreaterThan(0);
      expect(observedCwds.every((observed) => observed === expectedProcessCwd)).toBe(true);
      if (runtime === 'pi') {
        expect(piSessionCwds).toHaveLength(observedCwds.length);
        expect(piSessionCwds.every((observed) => observed === cwd)).toBe(true);
      }
    },
  );
});

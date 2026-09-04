import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_HOME_PROJECTION_STATE_FILE,
  AgentHomeBusyError,
  AgentHomeManager,
  createAgentHomeProjectionConsumer,
} from '../agent-home';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServer, type RealServerHandle } from './fixtures/real-server';

const roots: string[] = [];
const daemons: Daemon[] = [];
const servers: RealServerHandle[] = [];
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-home-projection-'));
  roots.push(root);
  return root;
}

function desired(revision: string, projectionHash = HASH_A, requestId = '00000000-0000-4000-8000-000000000001') {
  return {
    requestId,
    agentRef: { agentId: 'agent-one', profileRevision: revision },
    projectionHash,
    projection: { schemaVersion: 'host.opaque.v1', displayName: `Agent ${revision}` },
  } as const;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('task-free Agent-home projection', () => {
  it('binds the hook to the canonical cwd, initializes once, preserves memory, and fsyncs ordering state', async () => {
    const root = await makeRoot();
    const applied: string[] = [];
    const manager = new AgentHomeManager({
      hostStorageRoot: root,
      projection: createAgentHomeProjectionConsumer(async ({ cwd, projection, projectionHash }) => {
        applied.push(cwd);
        await fs.writeFile(path.join(cwd, 'profile.json'), JSON.stringify({ projection, projectionHash }), 'utf8');
      }),
    });

    await expect(manager.project(desired('1'))).resolves.toBe('applied');
    const home = path.join(await fs.realpath(root), 'agents', 'agent-one');
    expect(applied).toEqual([home]);
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('');
    expect((await fs.stat(path.join(home, 'notes'))).isDirectory()).toBe(true);
    await fs.writeFile(path.join(home, 'MEMORY.md'), 'keep me\n', 'utf8');

    await expect(manager.project(desired('1'))).resolves.toBe('idempotent');
    expect(applied).toEqual([home, home]);
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('keep me\n');
    const state = JSON.parse(
      await fs.readFile(path.join(home, '.byok', AGENT_HOME_PROJECTION_STATE_FILE), 'utf8'),
    ) as { agentRef: { profileRevision: string }; projectionHash: string };
    expect(state).toMatchObject({ agentRef: { profileRevision: '1' }, projectionHash: HASH_A });
  });

  it('re-applies exact desired state but keeps stale/conflict requests out of the hook', async () => {
    const root = await makeRoot();
    const calls: string[] = [];
    const manager = new AgentHomeManager({
      hostStorageRoot: root,
      projection: createAgentHomeProjectionConsumer(({ projectionHash }) => {
        calls.push(projectionHash);
      }),
    });

    await expect(manager.project(desired('7'))).resolves.toBe('applied');
    await expect(manager.project(desired('7', HASH_A, '00000000-0000-4000-8000-000000000002')))
      .resolves.toBe('idempotent');
    await expect(manager.project(desired('7', HASH_B, '00000000-0000-4000-8000-000000000003')))
      .resolves.toBe('conflict');
    await expect(manager.project(desired('6', HASH_B, '00000000-0000-4000-8000-000000000004')))
      .resolves.toBe('stale');
    await expect(manager.project(desired('8', HASH_B, '00000000-0000-4000-8000-000000000005')))
      .resolves.toBe('applied');
    expect(calls).toEqual([HASH_A, HASH_A, HASH_B]);
  });

  it('pre-claims one same-Agent writer while a different Agent remains independent', async () => {
    const root = await makeRoot();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const manager = new AgentHomeManager({
      hostStorageRoot: root,
      projection: createAgentHomeProjectionConsumer(async ({ agentRef }) => {
        if (agentRef.agentId === 'agent-one') {
          entered();
          await firstBlocked;
        }
      }),
    });

    const first = manager.project(desired('1'));
    await firstEntered;
    await expect(manager.project(desired('2', HASH_B, '00000000-0000-4000-8000-000000000006')))
      .rejects.toBeInstanceOf(AgentHomeBusyError);
    await expect(manager.project({
      ...desired('1', HASH_A, '00000000-0000-4000-8000-000000000007'),
      agentRef: { agentId: 'agent-two', profileRevision: '1' },
    })).resolves.toBe('applied');
    releaseFirst();
    await expect(first).resolves.toBe('applied');
  });

  it('does not publish local ordering state after hook or fsync failure, so redelivery retries', async () => {
    const root = await makeRoot();
    let attempts = 0;
    const manager = new AgentHomeManager({
      hostStorageRoot: root,
      projection: createAgentHomeProjectionConsumer(async ({ cwd }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('host hook failed');
        if (attempts === 2) {
          await fs.mkdir(path.join(cwd, '.byok', AGENT_HOME_PROJECTION_STATE_FILE));
        }
      }),
    });

    await expect(manager.project(desired('1'))).rejects.toThrow('host hook failed');
    await expect(manager.project(desired('1'))).rejects.toThrow(/regular file|directory|rename|EISDIR|EEXIST/);
    const home = path.join(await fs.realpath(root), 'agents', 'agent-one');
    await fs.rm(path.join(home, '.byok', AGENT_HOME_PROJECTION_STATE_FILE), { recursive: true });
    await expect(manager.project(desired('1'))).resolves.toBe('applied');
    expect(attempts).toBe(3);
  });

  // Step 4 regression: a rejected completion must leave the kernel ack behind
  // so a fresh daemon can consume the same projection row.
  it('keeps the mailbox cursor behind exact completion and redelivers after daemon restart without starting a runtime', async () => {
    const real = await startRealServer({ productId: 'agent-home-projection-test', longPollHoldMs: 200 });
    servers.push(real);
    const workspaceRoot = await makeRoot();
    const storeDir = await makeRoot();
    const hostStorageRoot = await makeRoot();
    const hookCwds: string[] = [];
    const projection = createAgentHomeProjectionConsumer(({ cwd }) => {
      hookCwds.push(cwd);
    });
    const adapterA = new StubRuntimeAdapter();
    const daemonA = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Test',
      productId: 'agent-home-projection-test',
      serverUrl: real.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot, projection },
    }, [adapterA], {
      // WP3B Step 2: the real server has no WS upgrade handler at all, so fail
      // over to long-poll after a single failed attempt instead of waiting
      // through a full default backoff sequence — same configuration as
      // `real-server-longpoll-only.test.ts`.
      // Keep the first daemon from completing an automatic retry before the
      // test can stop it; the second daemon must be the successful redelivery.
      longPoll: { retryDelayMs: 1_000, idleDelayMs: 20 },
    });
    daemons.push(daemonA);
    const pairing = await real.createPairingCode();
    const record = await daemonA.pair(pairing.code);
    await daemonA.start();
    // `daemon.start()` settles when the daemon commits to long-poll mode, which
    // can be a tick before its first `GET /byok/events` lands — and the server
    // only counts a device connected once that poll arrives. Enqueueing before
    // then throws `device ... is not connected`. Same wait as
    // `real-server-longpoll-only.test.ts`.
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const nativeFetch = globalThis.fetch;
    let rejectedCompletions = 0;
    const interceptedFetch: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(`/byok/agent-home-projections/${desired('1').requestId}/completion`)) {
        rejectedCompletions += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: 'injected completion failure' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return nativeFetch(input, init);
    };
    vi.stubGlobal('fetch', interceptedFetch);

    const pending = await real.byok.enqueueAgentHomeProjection({ deviceId: record.deviceId, payload: desired('1') });
    expect(pending.status).toBe('pending');
    await vi.waitFor(() => expect(rejectedCompletions).toBeGreaterThan(0));
    expect((await real.byok.readAgentHomeProjection(record.deviceId, desired('1').requestId))?.status).toBe('pending');
    await expect(new CursorStore(storeDir).load(real.url, record.deviceId)).resolves.toBe(0);
    expect(adapterA.sessions).toHaveLength(0);
    expect((await real.byok.tasks.list()).tasks).toHaveLength(0);

    await daemonA.stop();
    daemons.splice(daemons.indexOf(daemonA), 1);
    vi.unstubAllGlobals();
    const adapterB = new StubRuntimeAdapter();
    const daemonB = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Test',
      productId: 'agent-home-projection-test',
      serverUrl: real.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot, projection },
    }, [adapterB], {
      longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
    });
    daemons.push(daemonB);
    await daemonB.start();

    await vi.waitFor(async () => {
      expect((await real.byok.readAgentHomeProjection(record.deviceId, desired('1').requestId))?.status).toBe('idempotent');
    }, { timeout: 10_000 });
    await vi.waitFor(async () => {
      // This task-free projection is the kernel mailbox's first and only row;
      // the successful retry acknowledges that same seq rather than minting
      // a second delivery position.
      expect(await new CursorStore(storeDir).load(real.url, record.deviceId)).toBe(1);
    }, { timeout: 10_000 });
    expect(hookCwds).toHaveLength(2);
    expect(hookCwds[0]).toBe(path.join(await fs.realpath(hostStorageRoot), 'agents', 'agent-one'));
    expect(adapterB.sessions).toHaveLength(0);
    expect((await real.byok.tasks.list()).tasks).toHaveLength(0);
  }, 15_000);
});

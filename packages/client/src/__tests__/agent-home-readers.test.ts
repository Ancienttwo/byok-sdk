import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import {
  AGENT_HOME_DIRECTORY,
  AgentHomeBusyError,
  AgentHomeManager,
  createAgentHomeProjectionConsumer,
} from '../agent-home';
import {
  AGENT_HOME_READER_RUN_MAX_AGE_MS,
  compareAgentHomeMemory,
  digestAgentHomeMemory,
  pruneReaderRuns,
} from '../agent-home-readers';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * #317 acceptance: one canonical Agent home runs up to N `memory-reader`
 * Attempts beside at most one writer. Each reader has its own run directory,
 * `<home>/.byok/runs/<taskId>/`, and its terminal reports memory changes.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function temp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function payloadOf(envelope: Envelope): Record<string, unknown> {
  return envelope.payload as Record<string, unknown>;
}

async function age(dir: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await fs.utimes(dir, when, when);
}

describe('memory-reader Attempts in one Agent home (#317)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  interface Harness {
    readonly daemon: Daemon;
    readonly pi: StubRuntimeAdapter;
    readonly hostStorageRoot: string;
    home(agentId: string): Promise<string>;
  }

  async function start(overrides: Partial<DaemonConfig> = {}): Promise<Harness> {
    const storeDir = await temp('byok-readers-store-');
    const hostStorageRoot = await temp('byok-readers-home-');
    const pi = new StubRuntimeAdapter('pi');
    const started = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Readers',
      productId: `readers-${path.basename(storeDir)}`,
      serverUrl: server.url,
      workspaceRoot: await temp('byok-readers-workspace-'),
      storeDir,
      agentHome: { hostStorageRoot },
      ...overrides,
    }, [pi]);
    daemon = started;
    await started.pair('pairing-code');
    await started.start();
    await server.waitFor((entry) => entry.type === 'conn.hello');
    return {
      daemon: started,
      pi,
      hostStorageRoot,
      home: async (agentId) => path.join(await fs.realpath(hostStorageRoot), AGENT_HOME_DIRECTORY, agentId),
    };
  }

  function offer(taskId: string, agentId: string, options: { reader?: boolean; sessionRef?: string } = {}): void {
    server.send(createEnvelope('task.offer_for_agent', {
      instruction: `work for ${agentId}`,
      agentRef: { agentId, profileRevision: 'r1' },
      runtime: 'pi',
      ...(options.reader === true ? { homeAccess: 'memory-reader' as const } : {}),
      ...(options.sessionRef === undefined ? {} : { sessionRef: options.sessionRef }),
    }, { taskId, seq: server.nextSeq() }));
  }

  async function claimed(taskId: string): Promise<void> {
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === taskId);
  }

  async function declined(taskId: string): Promise<{ reason: string; retryable: boolean }> {
    const envelope = await server.waitFor((entry) => entry.type === 'task.decline' && entry.task_id === taskId);
    const { reason, retryable } = envelope.payload as { reason: string; retryable: boolean };
    return { reason, retryable };
  }

  async function complete(harness: Harness, sessionIndex: number, taskId: string): Promise<Envelope> {
    harness.pi.sessions[sessionIndex]!.emit({ type: 'turn_end' });
    return server.waitFor((entry) => entry.type === 'task.complete' && entry.task_id === taskId);
  }

  async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  it('advertises agent-home-readers with the Agent home', async () => {
    await start();
    const hello = server.received.find((entry) => entry.type === 'conn.hello')!;
    expect(payloadOf(hello).capabilities).toContain('agent-home-readers');
  });

  it('runs N readers and one writer at once, counted apart, each reader in its own run directory', async () => {
    const harness = await start();
    const home = await harness.home('shared');

    offer('writer-1', 'shared');
    await claimed('writer-1');
    for (const taskId of ['reader-1', 'reader-2', 'reader-3', 'reader-4']) {
      offer(taskId, 'shared', { reader: true });
      await claimed(taskId);
    }

    offer('reader-5', 'shared', { reader: true });
    expect(await declined('reader-5')).toEqual({ reason: 'agent home busy: 4 active reader attempt(s)', retryable: true });
    offer('writer-2', 'shared');
    expect(await declined('writer-2')).toEqual({ reason: 'agent home busy: 1 active attempt(s)', retryable: true });

    const cwds = harness.pi.startCalls.map((call) => call.ctx.workspaceDir);
    expect(cwds).toEqual([
      home,
      path.join(home, '.byok', 'runs', 'reader-1'),
      path.join(home, '.byok', 'runs', 'reader-2'),
      path.join(home, '.byok', 'runs', 'reader-3'),
      path.join(home, '.byok', 'runs', 'reader-4'),
    ]);
    expect(new Set(cwds).size).toBe(5);
    for (const cwd of cwds.slice(1)) {
      expect((await fs.lstat(cwd)).isDirectory()).toBe(true);
      expect(path.relative(home, cwd).split(path.sep)).toHaveLength(3);
    }
    expect(harness.daemon.status().agentHomeExecution).toEqual({
      maxConcurrentReaderAttemptsPerAgentHome: 4,
      activeHomes: 1,
      activeAttempts: 5,
      activeReaderAttempts: 4,
    });

    // The reader prompt points at the home's memory, not at its own cwd.
    expect(harness.pi.startCalls[1]!.task.instruction).toContain('../../../MEMORY.md');
    expect(harness.pi.startCalls[0]!.task.instruction).not.toContain('../../../MEMORY.md');
  });

  it('applies a configured reader limit and keeps the writer limit at one', async () => {
    const harness = await start({ maxConcurrentReaderAttemptsPerAgentHome: 2 });
    offer('limit-reader-1', 'limited', { reader: true });
    await claimed('limit-reader-1');
    offer('limit-reader-2', 'limited', { reader: true });
    await claimed('limit-reader-2');
    offer('limit-reader-3', 'limited', { reader: true });
    expect(await declined('limit-reader-3')).toEqual({ reason: 'agent home busy: 2 active reader attempt(s)', retryable: true });
    offer('limit-writer', 'limited');
    await claimed('limit-writer');
    expect(harness.daemon.status().agentHomeExecution.maxConcurrentReaderAttemptsPerAgentHome).toBe(2);
  });

  it('declines a fresh reader whose taskId cannot name a run directory before any side effect', async () => {
    const harness = await start();
    offer('bad/../task', 'naming', { reader: true });
    const decline = await declined('bad/../task');
    expect(decline.retryable).toBe(false);
    expect(decline.reason).toMatch(/one plain path segment/);
    expect(harness.pi.startCalls).toHaveLength(0);
    await expect(fs.stat(await harness.home('naming'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports unchanged memory, and a writer terminal carries no memory evidence', async () => {
    const harness = await start();
    offer('quiet-reader', 'quiet', { reader: true });
    await claimed('quiet-reader');
    const readerTerminal = await complete(harness, 0, 'quiet-reader');
    expect(payloadOf(readerTerminal).agentHomeMemoryChange).toEqual({ outcome: 'unchanged' });

    offer('quiet-writer', 'quiet');
    await claimed('quiet-writer');
    const writerTerminal = await complete(harness, 1, 'quiet-writer');
    expect(Object.hasOwn(payloadOf(writerTerminal), 'agentHomeMemoryChange')).toBe(false);
  });

  it('attributes a memory change to readers when no writer overlapped', async () => {
    const harness = await start();
    const home = await harness.home('attributed');
    offer('changing-reader', 'attributed', { reader: true });
    await claimed('changing-reader');
    await fs.writeFile(path.join(home, 'notes', 'added.md'), 'reader wrote this\n');
    await fs.writeFile(path.join(home, 'MEMORY.md'), 'reader changed the index\n');

    const terminal = await complete(harness, 0, 'changing-reader');
    expect(payloadOf(terminal).agentHomeMemoryChange).toEqual({
      outcome: 'reader-attributed',
      paths: ['MEMORY.md', 'notes/added.md'],
    });
  });

  it('reports an unattributed change when a writer started during the reader', async () => {
    const harness = await start();
    const home = await harness.home('overlap');
    offer('overlap-reader', 'overlap', { reader: true });
    await claimed('overlap-reader');
    offer('overlap-writer', 'overlap');
    await claimed('overlap-writer');
    await fs.writeFile(path.join(home, 'MEMORY.md'), 'writer changed the index\n');
    // The writer has ended before the reader's terminal: overlap still counts.
    await complete(harness, 1, 'overlap-writer');

    const terminal = await complete(harness, 0, 'overlap-reader');
    expect(payloadOf(terminal).agentHomeMemoryChange).toEqual({ outcome: 'unattributed', paths: ['MEMORY.md'] });
  });

  it('reports an unattributed change when the writer was already active at reader start', async () => {
    const harness = await start();
    const home = await harness.home('writer-first');
    offer('first-writer', 'writer-first');
    await claimed('first-writer');
    offer('late-reader', 'writer-first', { reader: true });
    await claimed('late-reader');
    await fs.mkdir(path.join(home, 'notes', 'deep'), { recursive: true });
    await fs.writeFile(path.join(home, 'notes', 'deep', 'n.md'), 'x');

    const terminal = await complete(harness, 1, 'late-reader');
    expect(payloadOf(terminal).agentHomeMemoryChange).toEqual({ outcome: 'unattributed', paths: ['notes/deep/n.md'] });
  });

  it('does not count a writer that ended before the reader started', async () => {
    const harness = await start();
    const home = await harness.home('sequential');
    offer('earlier-writer', 'sequential');
    await claimed('earlier-writer');
    await complete(harness, 0, 'earlier-writer');
    await waitUntil(() => harness.daemon.status().agentHomeExecution.activeAttempts === 0, 'the writer lease to release');

    offer('later-reader', 'sequential', { reader: true });
    await claimed('later-reader');
    await fs.writeFile(path.join(home, 'notes', 'later.md'), 'x');
    const terminal = await complete(harness, 1, 'later-reader');
    expect(payloadOf(terminal).agentHomeMemoryChange).toEqual({ outcome: 'reader-attributed', paths: ['notes/later.md'] });
  });

  it('reports unmeasured memory when the digest bound is exceeded', async () => {
    const harness = await start();
    const home = await harness.home('crowded');
    await fs.mkdir(path.join(home, 'notes'), { recursive: true });
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      fs.writeFile(path.join(home, 'notes', `n-${index}.md`), String(index))));

    offer('crowded-reader', 'crowded', { reader: true });
    await claimed('crowded-reader');
    const terminal = await complete(harness, 0, 'crowded-reader');
    expect(payloadOf(terminal).agentHomeMemoryChange).toEqual({ outcome: 'unmeasured' });
  });

  it('reports memory evidence on a cancelled reader too', async () => {
    const harness = await start();
    const home = await harness.home('cancelled');
    offer('cancel-reader', 'cancelled', { reader: true });
    await claimed('cancel-reader');
    await fs.writeFile(path.join(home, 'notes', 'c.md'), 'x');
    server.send(createEnvelope('task.cancel', { reason: 'stop' }, { taskId: 'cancel-reader', seq: server.nextSeq() }));
    const terminal = await server.waitFor((entry) => entry.type === 'task.cancelled' && entry.task_id === 'cancel-reader');
    expect(payloadOf(terminal).agentHomeMemoryChange).toEqual({ outcome: 'reader-attributed', paths: ['notes/c.md'] });
  });

  it('resumes a reader session in the run directory its handoff recorded', async () => {
    const harness = await start();
    const home = await harness.home('resume');
    offer('resume-first', 'resume', { reader: true });
    await claimed('resume-first');
    const sessionRef = harness.pi.sessions[0]!.sessionRef;
    await complete(harness, 0, 'resume-first');
    await waitUntil(() => harness.daemon.status().agentHomeExecution.activeAttempts === 0, 'the first reader to release');

    offer('resume-second', 'resume', { reader: true, sessionRef });
    await claimed('resume-second');
    expect(harness.pi.startCalls[1]!.ctx.workspaceDir).toBe(path.join(home, '.byok', 'runs', 'resume-first'));
    expect(harness.pi.startCalls[1]!.task.sessionRef).toBe(sessionRef);
    await expect(fs.stat(path.join(home, '.byok', 'runs', 'resume-second'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The handoff ledger stays in the home, not in the run directory.
    await expect(fs.stat(path.join(home, '.byok', 'runs', 'resume-first', '.byok'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(new AgentSessionHandoffStore().requireMatch({
      agentRef: { agentId: 'resume', profileRevision: 'r1' },
      sessionRef,
      runtimeId: 'pi',
      home,
      cwd: path.join(home, '.byok', 'runs', 'resume-first'),
      homeAccess: 'memory-reader',
    })).resolves.toMatchObject({ taskId: 'resume-second', homeAccess: 'memory-reader' });
  });

  it('declines a writer session resumed as a reader, without retry', async () => {
    const harness = await start();
    offer('mode-writer', 'mode-a');
    await claimed('mode-writer');
    const sessionRef = harness.pi.sessions[0]!.sessionRef;
    await complete(harness, 0, 'mode-writer');
    await waitUntil(() => harness.daemon.status().agentHomeExecution.activeAttempts === 0, 'the writer to release');

    offer('mode-as-reader', 'mode-a', { reader: true, sessionRef });
    const decline = await declined('mode-as-reader');
    expect(decline.retryable).toBe(false);
    expect(decline.reason).toMatch(/^Agent session handoff mismatch: .*not a memory-reader session/);
    expect(harness.pi.startCalls).toHaveLength(1);
  });

  it('declines a reader session resumed as a writer, without retry', async () => {
    const harness = await start();
    offer('mode-reader', 'mode-b', { reader: true });
    await claimed('mode-reader');
    const sessionRef = harness.pi.sessions[0]!.sessionRef;
    await complete(harness, 0, 'mode-reader');
    await waitUntil(() => harness.daemon.status().agentHomeExecution.activeAttempts === 0, 'the reader to release');

    offer('mode-as-writer', 'mode-b', { sessionRef });
    const decline = await declined('mode-as-writer');
    expect(decline.retryable).toBe(false);
    expect(decline.reason).toMatch(/^Agent session handoff mismatch: .*homeAccess exactly/);
    expect(harness.pi.startCalls).toHaveLength(1);
  });

  it('declines the resume of a reader session whose run directory is gone, naming the session', async () => {
    const harness = await start();
    const home = await harness.home('missing');
    offer('missing-first', 'missing', { reader: true });
    await claimed('missing-first');
    const sessionRef = harness.pi.sessions[0]!.sessionRef;
    await complete(harness, 0, 'missing-first');
    await waitUntil(() => harness.daemon.status().agentHomeExecution.activeAttempts === 0, 'the reader to release');
    await fs.rm(path.join(home, '.byok', 'runs', 'missing-first'), { recursive: true });

    offer('missing-resume', 'missing', { reader: true, sessionRef });
    const decline = await declined('missing-resume');
    expect(decline).toEqual({
      reason: `Agent session ${sessionRef} cannot resume: its reader run directory no longer exists`,
      retryable: false,
    });
    expect(harness.pi.startCalls).toHaveLength(1);
    await expect(fs.stat(path.join(home, '.byok', 'runs', 'missing-first'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(harness.daemon.status().agentHomeExecution.activeAttempts).toBe(0);
  });

  it('retention at a fresh reader start keeps active and recently resumable runs and removes stale ones', async () => {
    const harness = await start();
    const home = await harness.home('retained');
    const runs = path.join(home, '.byok', 'runs');

    // A finished reader with a resumable handoff, its directory older than the limit.
    offer('retained-resumable', 'retained', { reader: true });
    await claimed('retained-resumable');
    await complete(harness, 0, 'retained-resumable');
    await waitUntil(() => harness.daemon.status().agentHomeExecution.activeAttempts === 0, 'the reader to release');
    await age(path.join(runs, 'retained-resumable'), 8 * DAY_MS);

    // An active reader whose directory also looks old.
    offer('retained-active', 'retained', { reader: true });
    await claimed('retained-active');
    await age(path.join(runs, 'retained-active'), 8 * DAY_MS);

    // Stale directories with no handoff.
    for (const name of ['stale-a', 'stale-b']) {
      await fs.mkdir(path.join(runs, name));
      await age(path.join(runs, name), 8 * DAY_MS);
    }

    offer('retained-new', 'retained', { reader: true });
    await claimed('retained-new');
    expect((await fs.readdir(runs)).sort()).toEqual(['retained-active', 'retained-new', 'retained-resumable']);
  });

  it('keeps the base lease while a reader runs, so a task-free projection waits', async () => {
    const harness = await start();
    offer('projection-reader', 'projected', { reader: true });
    await claimed('projection-reader');

    const projector = new AgentHomeManager({
      hostStorageRoot: harness.hostStorageRoot,
      projection: createAgentHomeProjectionConsumer(() => {}),
    });
    await expect(projector.project({
      requestId: '00000000-0000-4000-8000-000000000317',
      agentRef: { agentId: 'projected', profileRevision: '2' },
      projectionHash: `sha256:${'7'.repeat(64)}`,
      projection: { schemaVersion: 'host.opaque.v1' },
    })).rejects.toBeInstanceOf(AgentHomeBusyError);
  });
});

describe('reader run retention (#317)', () => {
  async function runsWith(names: readonly string[]): Promise<string> {
    const runs = await fs.realpath(await temp('byok-reader-runs-'));
    for (const name of names) await fs.mkdir(path.join(runs, name));
    return runs;
  }

  it('removes unprotected directories older than the age limit and never an active one', async () => {
    const runs = await runsWith(['old', 'active-old', 'fresh']);
    await age(path.join(runs, 'old'), AGENT_HOME_READER_RUN_MAX_AGE_MS + DAY_MS);
    await age(path.join(runs, 'active-old'), AGENT_HOME_READER_RUN_MAX_AGE_MS + DAY_MS);

    const removed = await pruneReaderRuns({
      runsRoot: runs,
      active: new Set([path.join(runs, 'active-old')]),
      referenced: new Map(),
      nowMs: Date.now(),
    });
    expect(removed).toEqual([path.join(runs, 'old')]);
    expect((await fs.readdir(runs)).sort()).toEqual(['active-old', 'fresh']);
  });

  it('keeps a directory a recent handoff points to, until that record is older than the limit', async () => {
    const runs = await runsWith(['recent-ref', 'expired-ref']);
    for (const name of ['recent-ref', 'expired-ref']) await age(path.join(runs, name), AGENT_HOME_READER_RUN_MAX_AGE_MS + DAY_MS);
    const nowMs = Date.now();

    await pruneReaderRuns({
      runsRoot: runs,
      active: new Set(),
      referenced: new Map([
        [path.join(runs, 'recent-ref'), nowMs - DAY_MS],
        [path.join(runs, 'expired-ref'), nowMs - AGENT_HOME_READER_RUN_MAX_AGE_MS - DAY_MS],
      ]),
      nowMs,
    });
    expect(await fs.readdir(runs)).toEqual(['recent-ref']);
  });

  it('over the count limit removes the oldest unprotected directories first', async () => {
    const runs = await runsWith(['a', 'b', 'c', 'd', 'e']);
    // a is oldest and active; b and c are the next oldest unprotected ones.
    const ages: Record<string, number> = { a: 5, b: 4, c: 3, d: 2, e: 1 };
    for (const [name, days] of Object.entries(ages)) await age(path.join(runs, name), days * DAY_MS);

    await pruneReaderRuns({
      runsRoot: runs,
      active: new Set([path.join(runs, 'a')]),
      referenced: new Map(),
      nowMs: Date.now(),
      maxRetained: 3,
    });
    expect((await fs.readdir(runs)).sort()).toEqual(['a', 'd', 'e']);
  });
});

describe('reader memory digest (#317)', () => {
  it('ignores a missing notes directory and compares MEMORY.md alone', async () => {
    const home = await temp('byok-reader-digest-');
    await fs.writeFile(path.join(home, 'MEMORY.md'), 'index');
    const before = await digestAgentHomeMemory(home);
    expect(before).toEqual(new Map([['MEMORY.md', expect.stringMatching(/^sha256:/)]]));
    expect(compareAgentHomeMemory(before, await digestAgentHomeMemory(home), false)).toEqual({ outcome: 'unchanged' });
  });

  it('reports a deleted note and never follows a symbolic link', async () => {
    const home = await temp('byok-reader-digest-');
    const outside = await temp('byok-reader-digest-outside-');
    await fs.mkdir(path.join(home, 'notes'));
    await fs.writeFile(path.join(home, 'notes', 'gone.md'), 'x');
    await fs.writeFile(path.join(outside, 'secret.md'), 'outside');
    await fs.symlink(outside, path.join(home, 'notes', 'link'));
    const before = await digestAgentHomeMemory(home);
    expect(before?.get('notes/link')).toBe(`link:${outside}`);

    await fs.writeFile(path.join(outside, 'secret.md'), 'changed outside');
    await fs.rm(path.join(home, 'notes', 'gone.md'));
    expect(compareAgentHomeMemory(before, await digestAgentHomeMemory(home), false))
      .toEqual({ outcome: 'reader-attributed', paths: ['notes/gone.md'] });
  });
});

describe('durable Pi and memory-reader Attempts (#317)', () => {
  it('declines a reader offer on durable Pi before the lease, without retry', async () => {
    const hostStorageRoot = await temp('byok-readers-durable-home-');
    const storeDir = await temp('byok-readers-durable-store-');
    const durable = new StubRuntimeAdapter('pi', { kind: 'available', version: '0.0.0' }, {
      steer: false, resume: false, approvalInteractive: true, mcpToolsets: true, durablePi: true,
    });
    const sent: Envelope[] = [];
    const agentHome = new AgentHomeManager({ hostStorageRoot });
    const runner = new TaskRunner({
      adapters: [durable],
      workspaceRoot: await temp('byok-readers-durable-workspace-'),
      agentHome,
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-1',
      send: (envelope) => sent.push(envelope),
      blobClient: {
        resolveInstruction: async () => { throw new Error('not used'); },
        uploadArtifact: async () => { throw new Error('not used'); },
      },
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-1',
    });

    await runner.handleEnvelope(createEnvelope('task.offer_for_agent', {
      instruction: 'read on durable Pi', runtime: 'pi', agentRef: { agentId: 'durable-agent', profileRevision: 'r1' },
      homeAccess: 'memory-reader',
    }, { taskId: 'durable-reader', seq: 1 }));

    expect(sent.map((entry) => entry.type)).toEqual(['task.decline']);
    expect(sent[0]!.payload).toMatchObject({
      reason: 'durable Pi runs only in the canonical Agent home; it does not run memory-reader Attempts',
      retryable: false,
    });
    expect(durable.startCalls).toHaveLength(0);
    expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0, readerAttempts: 0 });
  });
});

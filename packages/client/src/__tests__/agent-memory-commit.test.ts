import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MEMORY_PROJECTION_CAPABILITY, createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AGENT_HOME_DIRECTORY, AgentHomeCommitCopyError, AgentHomeLeaseManager, AgentHomeManager } from '../agent-home';
import { compareAndSwapAgentMemoryHomeFile, isAgentMemorySecureFilesystemAvailable, observeAgentMemoryHomeFile } from '../daemon/agent-memory';
import { createAgentMemoryCommitStore, type AgentMemoryCommitHome } from '../daemon/agent-memory-commit';
import { helperAgentMemoryIntentBackend, NATIVE_AGENT_MEMORY_INTENT_BACKEND } from '../daemon/agent-memory-intent';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { DaemonScope } from '../daemon/create-daemon/scope';
import { provenAgentMemoryBackend } from '../daemon/create-daemon/services';
import { builtAgentMemoryFilesystemHelperBin } from './fixtures/agent-memory-helper-build';
import { testScratchRoot } from './fixtures/execution-scratch';
import { FRESH_OFFER } from './fixtures/fresh-offer';
import { StubRuntimeAdapter, type StubSession } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/** #1440: a writer Attempt's memory writes stay only when its task ends in `task.complete`. */

const helperBin = builtAgentMemoryFilesystemHelperBin();
// Windows has the helper but no power-loss proof, so it never declares the flag.
const supported = isAgentMemorySecureFilesystemAvailable(helperBin !== undefined) && process.platform !== 'win32';
const backend = helperBin === undefined ? NATIVE_AGENT_MEMORY_INTENT_BACKEND : helperAgentMemoryIntentBackend(helperBin, os.tmpdir());
const roots: string[] = [];
async function temp(prefix: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function seed(home: string): Promise<void> {
  await fs.mkdir(path.join(home, 'notes', 'deep'), { recursive: true });
  await fs.writeFile(path.join(home, 'MEMORY.md'), 'as it started\n');
  await fs.writeFile(path.join(home, 'notes', 'index.md'), 'index\n');
  await fs.writeFile(path.join(home, 'notes', 'deep', 'gone.md'), 'gone\n');
  await fs.writeFile(path.join(home, 'notes', 'opaque.txt'), 'not a memory file\n');
}
/** What a runtime does with its own file tools: nothing here goes through `memory_save`. */
async function writeAsRuntime(home: string): Promise<void> {
  await fs.writeFile(path.join(home, 'MEMORY.md'), 'overrun '.repeat(1536));
  await fs.writeFile(path.join(home, 'notes', 'index.md'), 'changed\n');
  await fs.writeFile(path.join(home, 'notes', 'added.md'), 'added\n');
  await fs.writeFile(path.join(home, 'notes', 'opaque.txt'), 'still not a memory file\n');
  await fs.rm(path.join(home, 'notes', 'deep'), { recursive: true });
}
async function overfill(home: string, count: number, bytes = 1): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, index) => fs.writeFile(path.join(home, 'notes', `n-${index}.md`), Buffer.alloc(bytes, 0x61))));
}
async function expectStarted(home: string): Promise<void> {
  expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('as it started\n');
  expect(await fs.readFile(path.join(home, 'notes', 'index.md'), 'utf8')).toBe('index\n');
  expect(await fs.readFile(path.join(home, 'notes', 'deep', 'gone.md'), 'utf8')).toBe('gone\n');
  await expect(fs.stat(path.join(home, 'notes', 'added.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  // Not a memory file, so a restore never touches it.
  expect(await fs.readFile(path.join(home, 'notes', 'opaque.txt'), 'utf8')).toBe('still not a memory file\n');
}
async function copyFiles(home: string): Promise<readonly string[]> {
  return (await fs.readdir(path.join(home, '.byok'))).filter((name) => name.startsWith('agent-memory-commit-'));
}
async function homeIdentity(home: string): Promise<AgentMemoryCommitHome> {
  const stat = await fs.stat(home, { bigint: true });
  return { canonicalHome: home, homeIdentity: { dev: stat.dev, ino: stat.ino } };
}

describe('the backend proof when the helper stops verifying', () => {
  const scope = (config: object) => ({
    config: { agentHome: { hostStorageRoot: '/unused' }, ...config },
    agentHomeManager: {},
    resolveAgentMemoryFilesystemHelperBin: () => { throw new Error('helper unverified'); },
  }) as unknown as DaemonScope;

  it('still fails the start of a daemon configured for intents', async () => {
    await expect(provenAgentMemoryBackend(scope({ agentMemoryIntents: {} }))).rejects.toThrow('helper unverified');
  });

  it('only withholds the proof from a daemon without them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provenAgentMemoryBackend(scope({}))).resolves.toBeUndefined();
  });
});

describe.skipIf(!supported)('the commit copy behind the base lease', () => {
  const AGENT = { agentId: 'commit', profileRevision: 'r1' };

  async function harness(completed: (taskId: string) => boolean) {
    const taskCompleted = vi.fn(async (taskId: string) => completed(taskId));
    const store = createAgentMemoryCommitStore({ backend: async () => backend, taskCompleted });
    const hostStorageRoot = await temp('byok-commit-store-');
    const manager = new AgentHomeManager({ hostStorageRoot, leaseManager: new AgentHomeLeaseManager({
      ownerId: 'commit-test', settleAgentMemoryCommit: (home) => store.settle(home),
    }) });
    const binding = await manager.prepare(AGENT);
    const home = binding.lease.canonicalHome;
    await seed(home);
    await store.copy(binding.lease, 'task-1');
    await writeAsRuntime(home);
    await binding.lease.release();
    return { store, manager, home, taskCompleted };
  }

  it('keeps every write and drops the copy when the journal holds task.complete', async () => {
    const { store, manager, home } = await harness(() => true);
    const holder = await manager.acquire(AGENT);
    expect(await copyFiles(home)).toEqual([]);
    expect(await fs.readFile(path.join(home, 'notes', 'added.md'), 'utf8')).toBe('added\n');

    // A `memory_save` is this same compare-and-swap.
    await store.copy(holder.lease, 'task-2');
    const filesystem = await backend.openFilesystem?.(holder.lease);
    const binding = { ...holder.lease, ...(filesystem === undefined ? {} : { filesystem }) };
    const current = await observeAgentMemoryHomeFile(binding, 'notes/index.md');
    await compareAndSwapAgentMemoryHomeFile(binding, { operation: 'replace', path: 'notes/index.md', expectedRevision: current.revision, content: 'saved\n' });
    await filesystem?.close();
    await holder.lease.release();
    await (await manager.acquire(AGENT)).lease.release();
    expect(await fs.readFile(path.join(home, 'notes', 'index.md'), 'utf8')).toBe('saved\n');
    expect(await copyFiles(home)).toEqual([]);
  });

  it('restores when the journal has another terminal or no row, on a maintenance lease too', async () => {
    const { manager, home } = await harness(() => false);
    expect(await manager.withIdleHomeLease(AGENT.agentId, async () => {})).toBe(true);
    await expectStarted(home);
    expect(await copyFiles(home)).toEqual([]);
    const audit = await fs.readFile(path.join(home, '.byok', 'agent-memory-audit-v1.jsonl'), 'utf8');
    expect(JSON.parse(audit.trim().split('\n').at(-1)!)).toMatchObject({ kind: 'agent_memory_commit_restore', taskId: 'task-1', restored: 3, deleted: 1 });
  });

  it('fails the acquire while the copy cannot be settled, keeps it, and settles it on a later acquire', async () => {
    const { manager, home, taskCompleted } = await harness(() => false);
    const content = path.join(home, '.byok', 'agent-memory-commit-content-0');
    await fs.chmod(content, 0o000);
    await expect(manager.acquire(AGENT)).rejects.toBeInstanceOf(AgentHomeCommitCopyError);
    expect(await manager.withIdleHomeLease(AGENT.agentId, async () => { throw new Error('must not run'); })).toBe(false);
    expect((await copyFiles(home)).length).toBeGreaterThan(0);

    await fs.chmod(content, 0o600);
    taskCompleted.mockClear();
    await (await manager.acquire(AGENT)).lease.release();
    expect(taskCompleted).toHaveBeenCalledTimes(1);
    await expectStarted(home);
  });

  it('refuses a copy whose content no longer matches its manifest, before it writes anything', async () => {
    const { manager, home } = await harness(() => false);
    await fs.writeFile(path.join(home, '.byok', 'agent-memory-commit-content-0'), 'tampered');
    await expect(manager.acquire(AGENT)).rejects.toThrow('does not match its manifest');
    expect(await fs.readFile(path.join(home, 'notes', 'added.md'), 'utf8')).toBe('added\n');
  });

  it('refuses a record kind outside the four, before it deletes anything', async () => {
    const { manager, home } = await harness(() => false);
    const manifest = path.join(home, '.byok', 'agent-memory-commit-manifest.json');
    const parsed = JSON.parse(await fs.readFile(manifest, 'utf8')) as { entries: { path: string; kind: string }[] };
    parsed.entries.find((entry) => entry.path === 'notes/deep')!.kind = 'folder';
    await fs.writeFile(manifest, JSON.stringify(parsed));
    await expect(manager.acquire(AGENT)).rejects.toThrow('manifest is invalid');
    expect(await fs.readFile(path.join(home, 'notes', 'added.md'), 'utf8')).toBe('added\n');
  });

  it('builds notes back when the runtime replaced it and the copy holds no note', async () => {
    const { store, manager, home } = await harness(() => false);
    const holder = await manager.acquire(AGENT);
    await fs.rm(path.join(home, 'notes'), { recursive: true });
    await fs.mkdir(path.join(home, 'notes'));
    await store.copy(holder.lease, 'no-notes');
    await fs.rm(path.join(home, 'notes'), { recursive: true });
    await fs.writeFile(path.join(home, 'notes'), 'a file');
    await holder.lease.release();

    const next = await manager.acquire(AGENT);
    expect((await fs.lstat(path.join(home, 'notes'))).isDirectory()).toBe(true);
    // The copy of the next Attempt walks `notes`.
    await store.copy(next.lease, 'next');
    await next.lease.release();
  });
});

describe.skipIf(!supported)('a commit Attempt on the device', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function start(capabilities?: ConstructorParameters<typeof StubRuntimeAdapter>[2], config?: Pick<Parameters<typeof createDaemonWithAdapters>[0], 'agentMemory'>) {
    const storeDir = await temp('byok-commit-daemon-store-');
    const hostStorageRoot = await temp('byok-commit-daemon-home-');
    const pi = new StubRuntimeAdapter('pi', undefined, capabilities);
    daemon = createDaemonWithAdapters({
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Commit',
      productId: `commit-${path.basename(storeDir)}`,
      serverUrl: server.url,
      storeDir,
      agentHome: { hostStorageRoot },
      agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      ...config,
    }, [pi]);
    await daemon.pair('pairing-code');
    await daemon.start();
    const hello = await server.waitFor((entry) => entry.type === 'conn.hello');
    const home = path.join(hostStorageRoot, AGENT_HOME_DIRECTORY, 'commit');
    await seed(home);
    return { pi, home, hello };
  }
  function offer(taskId: string, options: { commit?: boolean; reader?: boolean; limits?: { maxDurationMs: number } } = {}): void {
    server.send(createEnvelope('task.offer', {
      instruction: 'work',
      agentRef: { agentId: 'commit', profileRevision: 'r1' },
      runtime: 'pi',
      ...FRESH_OFFER,
      ...(options.commit === false ? {} : { agentMemoryCommit: 'on-success' as const }),
      ...(options.reader === true ? { homeAccess: 'memory-reader' as const } : {}),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    }, { taskId, seq: server.nextSeq() }));
  }
  const terminal = (type: Envelope['type'], taskId: string): Promise<Envelope> =>
    server.waitFor((entry) => entry.type === type && entry.task_id === taskId);
  const released = (): Promise<void> => vi.waitFor(() => {
    if (daemon!.status().agentHomeExecution.activeAttempts !== 0) throw new Error('an Attempt still holds its lease');
  }, { timeout: 5_000 });

  it('declares the flag with a proven backend and no intent transport', async () => {
    const { hello } = await start();
    expect((hello.payload as { capabilities: string[] }).capabilities).toContain('agent-memory-commit-on-success');
  });

  it('keeps the writes of a completed task and leaves no copy', async () => {
    const { pi, home } = await start();
    offer('kept');
    await terminal('task.started', 'kept');
    await writeAsRuntime(home);
    pi.sessions[0]!.emit({ type: 'turn_end' });
    await terminal('task.complete', 'kept');
    await released();
    expect(await fs.readFile(path.join(home, 'notes', 'added.md'), 'utf8')).toBe('added\n');
    expect(await fs.readFile(path.join(home, 'notes', 'index.md'), 'utf8')).toBe('changed\n');
    expect(await copyFiles(home)).toEqual([]);
  });

  it.each([
    ['failed', 'task.fail', (session: StubSession) => session.fail(new Error('runtime failed')), {}],
    ['was cancelled', 'task.cancelled', () => server.send(createEnvelope('task.cancel', { reason: 'stop' }, { taskId: 'ended', seq: server.nextSeq() })), {}],
    ['timed out', 'task.fail', () => {}, { limits: { maxDurationMs: 200 } }],
  ] as const)('restores MEMORY.md and notes/ of a task that %s', async (_label, type, end, options) => {
    server.setAckCapabilities(['resident-memory-over-limit']);
    const { pi, home } = await start();
    offer('ended', options);
    await terminal('task.started', 'ended');
    await writeAsRuntime(home);
    end(pi.sessions[0]!);
    const envelope = await terminal(type, 'ended');
    await released();
    await expectStarted(home);
    expect(await copyFiles(home)).toEqual([]);
    // The one terminal measurement sees what the runtime left, before any restore.
    expect((envelope.payload as { residentMemoryOverLimit?: unknown }).residentMemoryOverLimit).toEqual({ byteCount: 12288 });
    expect(await fs.readFile(path.join(home, '.byok', 'agent-memory-audit-v1.jsonl'), 'utf8')).not.toContain('resident_memory_restore');
  });

  it('restores what the memory path cannot read: a huge note, a non-UTF-8 note, a symlink and a new file', async () => {
    const outside = path.join(await temp('byok-commit-outside-'), 'target.md');
    await fs.writeFile(outside, 'outside\n');
    const { pi, home } = await start();
    offer('ended');
    await terminal('task.started', 'ended');
    await writeAsRuntime(home);
    await fs.writeFile(path.join(home, 'notes', 'index.md'), Buffer.alloc(300 * 1024, 0x61));
    await fs.writeFile(path.join(home, 'notes', 'binary.md'), Buffer.from([0xff, 0xfe, 0x00]));
    await fs.writeFile(path.join(home, 'notes', 'data.json'), '{}');
    await fs.symlink(outside, path.join(home, 'notes', 'link.md'));
    pi.sessions[0]!.fail(new Error('runtime failed'));
    await terminal('task.fail', 'ended');
    await released();
    await expectStarted(home);
    for (const name of ['binary.md', 'data.json', 'link.md']) {
      await expect(fs.lstat(path.join(home, 'notes', name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await fs.readFile(outside, 'utf8')).toBe('outside\n');
    expect(await copyFiles(home)).toEqual([]);

    offer('next');
    await terminal('task.started', 'next');
    pi.sessions[1]!.emit({ type: 'turn_end' });
    await terminal('task.complete', 'next');
    await released();
  });

  it('projects nothing while a failed task cannot restore, and restores on the next lease', async () => {
    const redact = vi.fn(async () => { throw new Error('the projection only has to be reached'); });
    const { pi, home } = await start(undefined, { agentMemory: {
      capability: AGENT_MEMORY_PROJECTION_CAPABILITY,
      grant: { grantRef: 'commit-grant', writerEpoch: 1, policyRevision: '1' },
      redactor: { redact }, port: { publish: vi.fn() },
    } });
    offer('ended');
    await terminal('task.started', 'ended');
    await writeAsRuntime(home);
    // An I/O failure: the open of this content file fails on either backend.
    const content = path.join(home, '.byok', 'agent-memory-commit-content-0');
    await fs.chmod(content, 0o000);
    pi.sessions[0]!.fail(new Error('runtime failed'));
    await terminal('task.fail', 'ended');
    await released();
    expect(redact).not.toHaveBeenCalled();
    expect((await copyFiles(home)).length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(home, 'notes', 'added.md'), 'utf8')).toBe('added\n');
    // The over-limit restore has its own condition, so it still ran.
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('as it started\n');

    await fs.chmod(content, 0o600);
    offer('next', { commit: false });
    await terminal('task.started', 'next');
    await expectStarted(home);
    expect(await copyFiles(home)).toEqual([]);
    pi.sessions[1]!.emit({ type: 'turn_end' });
    await released();
    expect(redact).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['too many files', /file count/u, (home: string) => overfill(home, 126)],
    ['too many bytes', /total size/u, (home: string) => overfill(home, 5, 250 * 1024)],
    ['a note over the file limit', /size_limit|bounded regular file/u, (home: string) => overfill(home, 1, 300 * 1024)],
    ['a non-UTF-8 note', /invalid_content|UTF-8/u, (home: string) => fs.writeFile(path.join(home, 'notes', 'binary.md'), Buffer.from([0xff, 0xfe]))],
    ['a symlink in notes/', /unsafe_path|symlink/u, (home: string) => fs.symlink(home, path.join(home, 'notes', 'link'))],
    ['notes/ replaced by a file', /not a real directory/u, async (home: string) => {
      await fs.rm(path.join(home, 'notes'), { recursive: true });
      await fs.writeFile(path.join(home, 'notes'), 'a file');
    }],
  ])('fails and rolls back a task that ends on %s, and the next one starts', async (_label, named, leave) => {
    const { pi, home } = await start();
    offer('over');
    await terminal('task.started', 'over');
    await writeAsRuntime(home);
    await leave(home);
    pi.sessions[0]!.emit({ type: 'turn_end' });
    const failure = await terminal('task.fail', 'over');
    expect(failure.payload).toMatchObject({ retryable: false, reason: expect.stringMatching(/^agent_memory_commit_refused: .*rolled back$/u) });
    expect((failure.payload as { reason: string }).reason).toMatch(named);
    await released();
    expect(await fs.readFile(path.join(home, 'notes', 'index.md'), 'utf8')).toBe('index\n');
    expect(await fs.readFile(path.join(home, 'MEMORY.md'), 'utf8')).toBe('as it started\n');
    expect(await copyFiles(home)).toEqual([]);

    offer('next');
    await terminal('task.started', 'next');
    pi.sessions[1]!.emit({ type: 'turn_end' });
    await terminal('task.complete', 'next');
    await released();
  });

  it('completes a task that removed MEMORY.md and notes/, which the next lease builds back', async () => {
    const { pi, home } = await start();
    offer('removed');
    await terminal('task.started', 'removed');
    await fs.rm(path.join(home, 'MEMORY.md'));
    await fs.rm(path.join(home, 'notes'), { recursive: true });
    pi.sessions[0]!.emit({ type: 'turn_end' });
    await terminal('task.complete', 'removed');
    await released();
    expect(await copyFiles(home)).toEqual([]);
  });

  it('leaves the terminal alone when the check hits an I/O failure, for the next start to decide', async () => {
    const { pi, home } = await start();
    offer('unread');
    await terminal('task.started', 'unread');
    await overfill(home, 126);
    const notes = path.join(home, 'notes');
    const lstat = fs.lstat.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, 'lstat').mockImplementation(((...args: unknown[]) => (args[0] === notes
      ? Promise.reject(Object.assign(new Error('injected'), { code: 'EIO' })) : lstat(...args))) as typeof fs.lstat);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    pi.sessions[0]!.emit({ type: 'turn_end' });
    await terminal('task.complete', 'unread');
    await released();
    expect(logged).toHaveBeenCalled();
  });

  it('settles the copy of a runtime that failed to start', async () => {
    const { pi, home } = await start();
    pi.startError = new Error('no runtime');
    offer('unstarted');
    await terminal('task.fail', 'unstarted');
    await released();
    expect(await copyFiles(home)).toEqual([]);
    expect(await fs.readFile(path.join(home, '.byok', 'agent-memory-audit-v1.jsonl'), 'utf8')).toContain('"taskId":"unstarted"');
  });

  it.each([
    ['a symlink in notes/', 'agent_memory_snapshot_refused', (home: string) => fs.symlink(home, path.join(home, 'notes', 'link'))],
    ['too many files', 'agent_memory_snapshot_over_file_limit', (home: string) => overfill(home, 128)],
    ['too many bytes', 'agent_memory_snapshot_over_byte_limit', (home: string) => overfill(home, 5, 250 * 1024)],
  ])('fails before the runtime starts on %s', async (_label, failureClass, prepare) => {
    const { pi, home } = await start();
    await prepare(home);
    offer('refused');
    const failure = await terminal('task.fail', 'refused');
    expect(failure.payload).toMatchObject({
      retryable: false, reason: expect.stringContaining('agent_memory_commit_unavailable'), failure: { class: failureClass },
    });
    expect(pi.startCalls).toHaveLength(0);
    expect((failure.payload as { reason: string }).reason).toContain('a write task with agentMemory:"none" and no agentMemoryCommit');
    await released();
  });

  it('settles a leftover copy before a writer that joined a reader\'s lease group reads memory', async () => {
    const { pi, home } = await start();
    offer('beside', { commit: false, reader: true });
    await terminal('task.started', 'beside');
    const store = createAgentMemoryCommitStore({ backend: async () => backend, taskCompleted: async () => false });
    await store.copy(await homeIdentity(home), 'crashed');
    await writeAsRuntime(home);
    offer('joined', { commit: false });
    await terminal('task.started', 'joined');
    await expectStarted(home);
    expect(await copyFiles(home)).toEqual([]);
    pi.sessions[1]!.emit({ type: 'turn_end' });
    pi.sessions[0]!.emit({ type: 'turn_end' });
    await released();
  });

  it('declines on the durable lane, which runs on past a restart', async () => {
    const { pi } = await start({ steer: true, resume: true, approvalInteractive: true, mcpToolsets: true, durableLane: true });
    offer('durable');
    const decline = await terminal('task.decline', 'durable');
    expect(decline.payload).toMatchObject({ retryable: false, reason: expect.stringContaining('durable lane') });
    expect(pi.startCalls).toHaveLength(0);
  });
});

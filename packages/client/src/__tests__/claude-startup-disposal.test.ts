import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { ClaudeProcessClient, type SpawnFn } from '../adapters/claude/process-client';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';

const tree = vi.hoisted(() => ({ adopt: vi.fn(async () => {}), dispose: vi.fn(async () => {}), terminate: vi.fn(async () => {}) }));
const wrapping = vi.hoisted(() => ({ wrap: vi.fn((server: unknown) => server) }));
vi.mock('../adapters/process-tree', () => ({
  adoptOwnedProcessTree: tree.adopt, disposeOwnedProcessTree: tree.dispose,
  requestOwnedProcessTreeTermination: tree.terminate, withOwnedProcessTree: (options: unknown) => options,
}));
// This suite isolates ownership after admission. Filesystem and launcher effects
// are inert doubles; no native launcher guard or real directory is changed.
vi.mock('../daemon/trusted-launch-cwd', () => ({ wrapMcpServerWithLaunchCwd: wrapping.wrap }));

const configDir = '/inert-fixture/task-owned-mcp';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; value?: T; error?: unknown } = { status: 'pending' };
  void promise.then(value => { state.status = 'fulfilled'; state.value = value; }, error => { state.status = 'rejected'; state.error = error; });
  return state;
}
function containsCause(actual: unknown, expected: unknown): boolean {
  return actual === expected || (actual instanceof Error && (
    containsCause(actual.cause, expected) || (actual instanceof AggregateError && actual.errors.some(error => containsCause(error, expected)))
  ));
}
const children: { emit(event: string, ...args: unknown[]): boolean }[] = [];
function childFixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  children.push(child);
  const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
  return { child, spawnFn, init: (id = 'wrong-session') => child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }) + '\n') };
}
function resources(): PreparedOperationResources {
  return {
    workspaceDir: '/inert-workspace', env: {},
    mcpServers: { byokagentmessage: { command: '/inert-mcp' } },
    mcpLaunch: { cwd: '/inert-launch', launcher: { kind: 'shell', interpreter: '/bin/sh', script: 'inert' } },
  };
}
function start(spawnFn: SpawnFn, overrides: Partial<PreparedOperationResources> = {}) {
  const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'inert-claude', source: 'path' }), spawnFn });
  return startPreparedOperation(adapter, { instruction: 'hello', sessionRef: 'requested-session' }, { ...resources(), ...overrides });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(fs, 'mkdtemp').mockResolvedValue(configDir);
  vi.spyOn(fs, 'chmod').mockResolvedValue(undefined);
  vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
  vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
});
afterEach(() => { for (const child of children.splice(0)) child.emit('close', 1, null); vi.restoreAllMocks(); });

describe('Claude failed-start resource ownership', () => {
  it('does not report resume mismatch or remove config before process disposal settles', async () => {
    const fixture = childFixture();
    const disposal = deferred();
    tree.dispose.mockReturnValue(disposal.promise);
    const result = observe(start(fixture.spawnFn));
    await flush(); fixture.init(); await flush();
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('pending');
    expect(fs.rm).not.toHaveBeenCalled();
    fixture.child.emit('close', 1, null);
    await flush(); expect(result.status).toBe('pending');
    disposal.resolve(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(result.error).toMatchObject({ category: 'authority', retry: 'non-retryable' });
    expect((result.error as Error).message).toMatch(/different session id/);
    expect(fs.rm).toHaveBeenCalledWith(configDir, { recursive: true, force: true });
  });

  it('retains resume mismatch and disposal failure, then coalesces cleanup retries', async () => {
    const fixture = childFixture();
    const failure = new Error('tree still alive');
    tree.dispose.mockRejectedValueOnce(failure);
    const result = observe(start(fixture.spawnFn));
    await flush(); fixture.init(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(containsCause(result.error, failure)).toBe(true);
    expect(fs.rm).not.toHaveBeenCalled();
    const receipt = result.error as RuntimeStartupDisposalFailure;
    expect(receipt.cause).toBeInstanceOf(AggregateError);
    expect((receipt.cause as AggregateError).errors[0]).toMatchObject({ phase: 'start', category: 'authority', message: expect.stringMatching(/different session id/) });
    const disposal = deferred();
    tree.dispose.mockReturnValue(disposal.promise);
    const first = receipt.retryDisposal();
    const second = receipt.retryDisposal();
    await flush();
    expect(tree.dispose).toHaveBeenCalledTimes(2);
    expect(fs.rm).not.toHaveBeenCalled();
    disposal.resolve(); await Promise.all([first, second]);
    await receipt.retryDisposal();
    expect(fs.rm).toHaveBeenCalledTimes(1);
  });

  it('retries failed config cleanup without repeating successful process disposal', async () => {
    const fixture = childFixture();
    const cleanupError = new Error('config removal refused');
    vi.mocked(fs.rm).mockRejectedValueOnce(cleanupError);
    const result = observe(start(fixture.spawnFn));
    await flush(); fixture.init(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(containsCause(result.error, cleanupError)).toBe(true);
    const receipt = result.error as RuntimeStartupDisposalFailure;
    await Promise.all([receipt.retryDisposal(), receipt.retryDisposal()]);
    await receipt.retryDisposal();
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledTimes(2);
  });

  it('a client adoption failure cannot hide failed owned disposal', async () => {
    const fixture = childFixture();
    const adoptionError = new Error('adoption refused');
    const disposalError = new Error('disposal failed');
    tree.adopt.mockRejectedValue(adoptionError);
    tree.dispose.mockRejectedValueOnce(disposalError);
    const client = new ClaudeProcessClient({ command: 'inert', args: [], cwd: '/', env: {}, spawnFn: fixture.spawnFn });
    const failure = await client.waitForInit().catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(containsCause(failure, adoptionError)).toBe(true);
    expect(containsCause(failure, disposalError)).toBe(true);
    await (failure as RuntimeStartupDisposalFailure).retryDisposal();
    expect(tree.dispose).toHaveBeenCalledTimes(2);
  });

  it('keeps an adapter adoption failure and config owned until a successful disposal retry', async () => {
    const fixture = childFixture();
    const adoptionError = new Error('adoption refused');
    const disposalError = new Error('disposal failed');
    tree.adopt.mockRejectedValue(adoptionError);
    tree.dispose.mockRejectedValue(disposalError);
    const failure = await start(fixture.spawnFn).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(containsCause(failure, adoptionError)).toBe(true);
    expect(containsCause(failure, disposalError)).toBe(true);
    expect(fs.rm).not.toHaveBeenCalled();
    tree.dispose.mockResolvedValue(undefined);
    await (failure as RuntimeStartupDisposalFailure).retryDisposal();
    expect(fs.rm).toHaveBeenCalledTimes(1);
  });

  it.each(['binding', 'wrapper', 'write'] as const)('cleans allocated config on pre-spawn %s failure', async phase => {
    const fixture = childFixture();
    const original = new Error('pre-spawn failure');
    if (phase === 'wrapper') wrapping.wrap.mockImplementationOnce(() => { throw original; });
    if (phase === 'write') vi.mocked(fs.writeFile).mockRejectedValueOnce(original);
    const failure = await start(fixture.spawnFn, phase === 'binding' ? { mcpLaunch: null } : {}).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    if (phase !== 'binding') expect(containsCause(failure, original)).toBe(true);
    expect(fixture.spawnFn).not.toHaveBeenCalled();
    expect(fs.rm).toHaveBeenCalledWith(configDir, { recursive: true, force: true });
  });

  it('retains a pre-spawn cleanup failure and original spawn error for an idempotent retry', async () => {
    const original = new Error('spawn refused');
    const cleanupError = new Error('config removal refused');
    const spawnFn = (() => { throw original; }) as SpawnFn;
    vi.mocked(fs.rm).mockRejectedValueOnce(cleanupError);
    const failure = await start(spawnFn).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(containsCause(failure, original)).toBe(true);
    expect(containsCause(failure, cleanupError)).toBe(true);
    await failure.retryDisposal(); await failure.retryDisposal();
    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(tree.dispose).not.toHaveBeenCalled();
  });

  it('retains a child when client initialization throws after spawn', async () => {
    const fixture = childFixture();
    const original = new Error('stdout initialization failed');
    vi.spyOn(fixture.child.stdout, 'setEncoding').mockImplementation(() => { throw original; });
    const disposalError = new Error('tree not yet disposed');
    tree.dispose.mockRejectedValue(disposalError);
    const failure = await start(fixture.spawnFn).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(containsCause(failure, original)).toBe(true);
    expect(fs.rm).not.toHaveBeenCalled();
    tree.dispose.mockResolvedValue(undefined);
    await failure.retryDisposal();
    expect(fs.rm).toHaveBeenCalledTimes(1);
  });
});

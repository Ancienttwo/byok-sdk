import { inertScratch } from './fixtures/inert-scratch';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter, type SpawnFn } from '../adapters/claude/claude-adapter';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';

const tree = vi.hoisted(() => ({ adopt: vi.fn(async () => {}), dispose: vi.fn(async () => {}), terminate: vi.fn(async () => {}) }));
vi.mock('../adapters/process-tree', () => ({
  adoptOwnedProcessTree: tree.adopt, disposeOwnedProcessTree: tree.dispose,
  requestOwnedProcessTreeTermination: tree.terminate, withOwnedProcessTree: (options: unknown) => options,
}));
// This suite isolates ownership after admission. Filesystem effects are inert
// doubles; no real directory is changed.

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
  // The owned line process adopts the tree on the child's own 'spawn' event.
  const spawnFn = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child; }) as unknown as SpawnFn;
  return { child, spawnFn, init: (id = 'wrong-session') => child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }) + '\n') };
}
function resources(): PreparedOperationResources {
  return {
    scratch: inertScratch(configDir), workspaceDir: '/inert-workspace', env: {},
    mcpServers: { byokagentmessage: { command: '/inert-mcp' } },
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
    expect(result.error).toMatchObject({ retry: 'non-retryable' });
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
    expect((receipt.cause as AggregateError).errors[0]).toMatchObject({ phase: 'start', message: expect.stringMatching(/different session id/) });
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

  it('cleans allocated config on pre-spawn write failure', async () => {
    const fixture = childFixture();
    const original = new Error('pre-spawn failure');
    vi.mocked(fs.writeFile).mockRejectedValueOnce(original);
    const failure = await start(fixture.spawnFn).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(containsCause(failure, original)).toBe(true);
    expect(fixture.spawnFn).not.toHaveBeenCalled();
    expect(fs.rm).toHaveBeenCalledWith(configDir, { recursive: true, force: true });
  });

  it.each(['ENOENT', 'EACCES', undefined])('retains a pre-spawn cleanup failure and sanitized spawn error (code %s) for an idempotent retry', async (code) => {
    const canary = 'private-spawn-input';
    const original = Object.assign(new Error(`spawn refused: ${canary}`), {
      code, path: `/inert/${canary}`, spawnargs: [canary], env: { TOKEN: canary }, cwd: `/inert/${canary}`, cause: new Error(canary),
    });
    expect(inspect(original, { depth: null })).toContain(canary);
    const cleanupError = new Error('config removal refused');
    const spawnFn = (() => { throw original; }) as SpawnFn;
    vi.mocked(fs.rm).mockRejectedValueOnce(cleanupError);
    const failure = await start(spawnFn).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const startupError = (failure.cause as AggregateError).errors[0];
    expect(startupError).toBeInstanceOf(RuntimeExecutionFailure);
    expect(startupError.cause).toMatchObject({ message: `spawn failed: ${code ?? 'unknown'}`, code });
    for (const field of ['path', 'spawnargs', 'env', 'cwd', 'cause']) expect(startupError.cause).not.toHaveProperty(field);
    expect(containsCause(failure, original)).toBe(false);
    expect(inspect(failure, { depth: null })).not.toContain(canary);
    expect(containsCause(failure, cleanupError)).toBe(true);
    await failure.retryDisposal(); await failure.retryDisposal();
    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(tree.dispose).not.toHaveBeenCalled();
  });
});

import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { SpawnFn } from '../adapters/claude/process-client';
import { startOwnedRuntime } from '../daemon/runtime-start';
import { RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
import { sealRuntimeOperationManifest, type RuntimeOperationStartInput } from '../types';

const tree = vi.hoisted(() => ({
  adopt: vi.fn(async () => {}),
  terminate: vi.fn(async () => {}),
  dispose: vi.fn(async (_options: { isClosed(): boolean; waitClosed(): Promise<void> }) => {}),
}));
vi.mock('../adapters/process-tree', () => ({
  adoptOwnedProcessTree: tree.adopt, requestOwnedProcessTreeTermination: tree.terminate,
  disposeOwnedProcessTree: tree.dispose, withOwnedProcessTree: (options: unknown) => options,
}));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; value?: T; error?: unknown } = { status: 'pending' };
  void promise.then(value => { state.status = 'fulfilled'; state.value = value; }, error => { state.status = 'rejected'; state.error = error; });
  return state;
}
const children: EventEmitter[] = [];
function fixture(holdWrite = false, onSpawn?: () => void) {
  let finishWrite!: () => void;
  const write = vi.fn((_chunk, _encoding, callback: (error?: Error | null) => void) => {
    if (holdWrite) finishWrite = () => callback();
    else callback();
  });
  const child = Object.assign(new EventEmitter(), { stdin: new Writable({ write }), stdout: new PassThrough(), stderr: new PassThrough() });
  children.push(child);
  const spawnFn = vi.fn(() => { onSpawn?.(); return child; }) as unknown as SpawnFn;
  return { child, spawnFn, write, finishWrite: () => finishWrite(), init: () => child.stdout.write('{"type":"system","subtype":"init","session_id":"ready"}\n') };
}
async function operation(spawnFn: SpawnFn, signal?: AbortSignal, withMcp = false) {
  const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'inert-fixture', source: 'path' }), spawnFn });
  const offer = { instruction: 'hello', policy: { mode: 'auto' as const } };
  const mcp = withMcp ? { mcpServers: { byokagentmessage: { command: '/inert-mcp' } } } : {};
  const prepared = await adapter.prepare({ offer, policy: offer.policy, descriptor: adapter.descriptor, requiredToolsetIds: [], ...mcp });
  if (prepared.kind !== 'prepared') throw new Error('unexpected fixture admission rejection');
  const input: RuntimeOperationStartInput = {
    kind: 'instruction', instruction: 'hello', env: {}, ...(signal ? { signal } : {}), ...mcp,
    manifest: sealRuntimeOperationManifest({ taskId: 'abort-fixture', runtimeId: 'claude', descriptor: adapter.descriptor,
      policy: offer.policy, requiredToolsetIds: [], workspace: { workspaceDir: '/inert-workspace' }, forwardedEnvironmentNames: [] }),
  };
  return { start: () => prepared.operation.start(input), prepared: prepared.operation, input };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => { for (const child of children.splice(0)) child.emit('close', 1, null); vi.restoreAllMocks(); });

describe('Claude startup cancellation ownership', () => {
  it('refuses an already-aborted startup without spawning', async () => {
    const controller = new AbortController(); controller.abort();
    const fake = fixture();
    const op = await operation(fake.spawnFn, controller.signal);
    const result = observe(op.start()); await flush();
    expect(result.error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(result.error).toMatchObject({ phase: 'start', message: expect.stringMatching(/cancel/i) });
    expect(fake.spawnFn).not.toHaveBeenCalled();
    expect(tree.dispose).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not allocate MCP configuration for an already-aborted startup', async () => {
    const allocated = vi.spyOn(fs, 'mkdtemp').mockResolvedValue('/inert-config');
    vi.spyOn(fs, 'chmod').mockResolvedValue(undefined);
    vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
    const controller = new AbortController(); controller.abort();
    const fake = fixture(); const op = await operation(fake.spawnFn, controller.signal, true);
    await expect(op.start()).rejects.toMatchObject({ phase: 'start', message: expect.stringMatching(/cancel/i) });
    expect(allocated).not.toHaveBeenCalled();
    expect(fake.spawnFn).not.toHaveBeenCalled();
  });

  it('owns a late MCP directory allocation after cancellation without spawning', async () => {
    let completeAllocation!: (dir: string) => void;
    vi.spyOn(fs, 'mkdtemp').mockReturnValue(new Promise<string>(resolve => { completeAllocation = resolve; }));
    const chmod = vi.spyOn(fs, 'chmod').mockResolvedValue(undefined);
    const cleanup = vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
    const controller = new AbortController(); const fake = fixture();
    const op = await operation(fake.spawnFn, controller.signal, true);
    const result = observe(op.start()); await flush(); controller.abort(); await flush();
    expect(result.status).toBe('pending');
    completeAllocation('/inert-late-config'); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    await (result.error as RuntimeStartupDisposalFailure).retryDisposal();
    expect(cleanup).toHaveBeenCalledWith('/inert-late-config', { recursive: true, force: true });
    expect(chmod).not.toHaveBeenCalled();
    expect(fake.spawnFn).not.toHaveBeenCalled();
    expect(tree.dispose).not.toHaveBeenCalled();
  });

  it('exposes an immediately usable owner during silent init without claiming child closure', async () => {
    const controller = new AbortController();
    const fake = fixture();
    const disposal = deferred(); tree.dispose.mockReturnValue(disposal.promise);
    const op = await operation(fake.spawnFn, controller.signal);
    const result = observe(op.start()); await flush();
    controller.abort(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    const owned = tree.dispose.mock.calls[0]![0];
    expect(owned.isClosed()).toBe(false);
    const closed = observe(owned.waitClosed());
    const receipt = result.error as RuntimeStartupDisposalFailure;
    const retry = observe(Promise.all([receipt.retryDisposal(), receipt.retryDisposal()]));
    fake.init(); await flush();
    expect(result.status).toBe('rejected');
    expect(closed.status).toBe('pending');
    expect(retry.status).toBe('pending');
    fake.child.emit('close', 1, null); await flush();
    expect(closed.status).toBe('fulfilled');
    expect(retry.status).toBe('pending');
    disposal.resolve(); await flush();
    expect(retry.status).toBe('fulfilled');
    await receipt.retryDisposal();
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('cancels while adoption is pending and never writes a prompt when adoption later succeeds', async () => {
    const controller = new AbortController();
    const fake = fixture();
    const adoption = deferred(); tree.adopt.mockReturnValue(adoption.promise);
    const op = await operation(fake.spawnFn, controller.signal);
    const result = observe(op.start()); await flush();
    controller.abort(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    await (result.error as RuntimeStartupDisposalFailure).retryDisposal();
    expect(fake.write).not.toHaveBeenCalled();
    adoption.resolve(); fake.init(); await flush();
    expect(fake.write).not.toHaveBeenCalled();
    expect(result.status).toBe('rejected');
    expect(tree.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not create a second disposal owner when adoption rejects after cancellation cleanup', async () => {
    const controller = new AbortController(); const fake = fixture();
    const adoption = deferred(); tree.adopt.mockReturnValue(adoption.promise);
    const op = await operation(fake.spawnFn, controller.signal);
    const result = observe(op.start()); await flush(); controller.abort(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    await (result.error as RuntimeStartupDisposalFailure).retryDisposal();
    adoption.reject(new Error('late adoption rejection')); await flush();
    expect(fake.write).not.toHaveBeenCalled();
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('rejected');
  });

  it('cancels a stalled initial write and ignores its late completion and init', async () => {
    const controller = new AbortController(); const fake = fixture(true);
    const op = await operation(fake.spawnFn, controller.signal);
    const result = observe(op.start()); await flush();
    controller.abort(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    await (result.error as RuntimeStartupDisposalFailure).retryDisposal();
    fake.finishWrite(); fake.init(); await flush();
    expect(result.status).toBe('rejected');
    expect(fake.write).toHaveBeenCalledTimes(1);
    expect(tree.dispose).toHaveBeenCalledTimes(1);
  });

  it('retains a retry after cancellation disposal fails', async () => {
    const controller = new AbortController(); const fake = fixture();
    tree.dispose.mockRejectedValueOnce(new Error('not quiescent'));
    const op = await operation(fake.spawnFn, controller.signal);
    const result = observe(op.start()); await flush();
    controller.abort(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    await (result.error as RuntimeStartupDisposalFailure).retryDisposal();
    expect(tree.dispose).toHaveBeenCalledTimes(2);
  });

  it('captures cancellation during the synchronous spawn handoff before writing a prompt', async () => {
    const controller = new AbortController(); const fake = fixture(false, () => controller.abort());
    const op = await operation(fake.spawnFn, controller.signal);
    const result = observe(op.start()); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    await (result.error as RuntimeStartupDisposalFailure).retryDisposal();
    expect(fake.write).not.toHaveBeenCalled();
    expect(tree.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not publish a Session when init and cancellation arrive in the same turn', async () => {
    const controller = new AbortController(); const fake = fixture();
    const op = await operation(fake.spawnFn, controller.signal);
    const result = observe(op.start()); await flush();
    fake.init(); controller.abort(); await flush();
    expect(result.error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    await (result.error as RuntimeStartupDisposalFailure).retryDisposal();
  });

  it('detaches startup cancellation after publishing a successful Session', async () => {
    const controller = new AbortController(); const fake = fixture();
    const op = await operation(fake.spawnFn, controller.signal);
    const result = op.start(); await flush(); fake.init();
    const session = await result;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort(); await flush();
    expect(tree.terminate).not.toHaveBeenCalled();
    expect(tree.dispose).not.toHaveBeenCalled();
    await session.close();
  });

  it('makes the real startup deadline owner converge with an in-flight silent-init disposal', async () => {
    const fake = fixture(); const disposal = deferred(); tree.dispose.mockReturnValue(disposal.promise);
    const op = await operation(fake.spawnFn);
    const failure = await startOwnedRuntime(input => op.prepared.start(input), op.input, new AbortController().signal, 10).catch(error => error);
    await flush();
    expect(failure).toBeInstanceOf(RuntimeStartupDisposalFailure);
    expect(tree.dispose).toHaveBeenCalledTimes(1);
    const retry = observe(failure.retryDisposal()); await flush();
    expect(retry.status).toBe('pending');
    disposal.resolve(); await flush();
    expect(retry.status).toBe('fulfilled');
    expect(tree.dispose).toHaveBeenCalledTimes(1);
  });
});

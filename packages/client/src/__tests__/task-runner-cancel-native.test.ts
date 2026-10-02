import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope, type RuntimeId } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import type { RuntimeAdapter, Session } from '../types';
import { TestServer } from './fixtures/test-server';

const fixture = fileURLToPath(new URL('./fixtures/task-runner-cancel-runtime.mjs', import.meta.url));
const cases: Array<{ dir: string; gate: string; runner: TaskRunner; sessions: Session[];
  startSettled: ReturnType<typeof deferred>; hasStarted: () => boolean }> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function setup(runtime: RuntimeId, scenario: string, overrides: Partial<Pick<TaskRunnerDeps, 'startupTimeoutMs'>> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-t1-native-'));
  const tree = path.join(dir, 'tree.json');
  const traceFile = path.join(dir, 'trace');
  const gate = path.join(dir, 'gate');
  for (const [name, value] of Object.entries({ T1_SCENARIO: scenario, T1_TREE: tree, T1_TRACE: traceFile, T1_GATE: gate })) vi.stubEnv(name, value);
  const resolveBin = () => ({ command: fixture, source: 'path' as const });
  const adapter: RuntimeAdapter = runtime === 'claude' ? new ClaudeAdapter({ resolveBin, interruptTimeoutMs: 60 })
    : runtime === 'codex' ? new CodexAdapter({ resolveBin, interruptTimeoutMs: 60 })
    : new PiAdapter({ resolveBin: () => ({ command: fixture, source: 'env' }) });
  if (scenario === 'startup') {
    // Freeze a REAL installation observation before timing the owned-start
    // window. Version/auth probe scheduling is a different cancellation phase
    // (covered below), and must not consume this startup fixture's deadline.
    const observation = await adapter.detect();
    expect(observation.kind).toBe('available');
    vi.spyOn(adapter, 'detect').mockResolvedValue(observation);
  }
  const sessions: Session[] = [];
  const startSettled = deferred();
  let started = false;
  const prepare = adapter.prepare.bind(adapter);
  vi.spyOn(adapter, 'prepare').mockImplementation(async input => {
    const result = await prepare(input);
    if (result.kind !== 'prepared') return result;
    const start = result.operation.start.bind(result.operation);
    return { ...result, operation: { ...result.operation, start: async input => {
      started = true;
      try { const session = await start(input); sessions.push(session); return session; }
      finally { startSettled.resolve(); }
    } } };
  });
  const sent: Envelope[] = [];
  const runner = new TaskRunner({
    adapters: [adapter], deviceId: 't1-native-device', workspaceRoot: path.join(dir, 'workspace'), storeDir: dir, productId: 't1-cancel',
    send: event => { sent.push(event); },
    blobClient: {
      resolveInstruction: async () => { throw new Error('unexpected blob resolution'); },
      uploadArtifact: async () => { throw new Error('unexpected artifact upload'); },
    },
    sessionWorkspaces: new SessionWorkspaceStore(path.join(dir, 'sessions')), approvalRegistry: new ApprovalRegistry(),
    localAgentRelease: Object.freeze({ version: '0.24.0-rc.1' }),
    runtimeEnvironment: { [runtime]: { allow: ['T1_*'] } }, shutdownInterruptTimeoutMs: 100,
    ...overrides,
  });
  const taskId = 'native-task';
  const offer = (limits?: { maxDurationMs: number }) => runner.handleEnvelope(createEnvelope('task.offer', {
    instruction: 'observe native cancellation', runtime, policy: { mode: 'auto' }, limits,
  }, { taskId, seq: 1 }));
  const cancel = () => runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'operator' }, { taskId, seq: 2 }));
  const terminals = () => sent.filter(event => ['task.complete', 'task.fail', 'task.cancelled'].includes(event.type));
  const events = () => sent.flatMap(event => event.type === 'task.progress' ? event.payload.events : []);
  const trace = async () => (await fs.readFile(traceFile, 'utf8')).trim().split('\n');
  const assertReaped = async () => {
    const pids = JSON.parse(await fs.readFile(tree, 'utf8')) as Record<string, number>;
    expect(Object.keys(pids).sort()).toEqual(['descendantPid', 'grandchildPid', 'rootPid']);
    for (const pid of Object.values(pids)) expect(alive(pid), `PID ${pid} still live`).toBe(false);
    expect(runner.activeTaskCount).toBe(0);
  };
  const c = { runtime, dir, tree, gate, adapter, runner, sent, sessions, startSettled, hasStarted: () => started,
    offer, cancel, terminals, events, trace, assertReaped };
  cases.push(c);
  return c;
}
afterEach(async () => {
  try {
    for (const c of cases.splice(0)) {
      await fs.writeFile(c.gate, 'release');
      c.runner.stopAcceptingOffers();
      if (c.hasStarted()) await c.startSettled.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      await c.runner.shutdownActiveTasks('test cleanup');
      await Promise.all(c.sessions.map(session => session.close()));
      await fs.rm(c.dir, { recursive: true, force: true });
    }
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
function expectNoErrors(c: Awaited<ReturnType<typeof setup>>) { expect(c.events().filter(event => event.type === 'error')).toEqual([]); }
function expectUsage(c: Awaited<ReturnType<typeof setup>>, promptTokens: number, completionTokens: number) {
  expect(c.terminals()).toHaveLength(1);
  expect(c.terminals()[0]?.payload).toMatchObject({ usage: { runtime: c.runtime, promptTokens, completionTokens } });
}

describe.each(['claude', 'codex', 'pi'] as const)('TaskRunner through native %s and an owned fixture tree', runtime => {
  it('cancels a queued offer without spawning; duplicate cancels are inert', async () => {
    const c = await setup(runtime, 'stream');
    await c.cancel(); await c.cancel(); await c.offer();
    expect(c.sent.map(event => event.type)).toEqual(['task.decline']);
    expect(c.adapter.prepare).not.toHaveBeenCalled(); expect(c.sessions).toHaveLength(0);
    await expect(fs.stat(c.tree)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('withdraws in-flight pre-claim admission without starting a process', async () => {
    const c = await setup(runtime, 'stream');
    const entered = deferred(); const release = deferred();
    const detect = c.adapter.detect.bind(c.adapter);
    vi.spyOn(c.adapter, 'detect').mockImplementation(async () => { entered.resolve(); await release.promise; return detect(); });
    const offered = c.offer(); await entered.promise; await c.cancel(); release.resolve(); await offered;
    expect(c.sent.map(event => event.type)).toEqual(['task.decline']); expect(c.sessions).toHaveLength(0);
    await expect(fs.stat(c.tree)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels gated native startup and reaps the late-returning owner once', async () => {
    const c = await setup(runtime, 'startup'); const offered = c.offer();
    await vi.waitFor(async () => expect(await c.trace()).toContain('startup'));
    expect(c.runner.activeTaskCount).toBe(0);
    await c.cancel(); await offered; await fs.writeFile(c.gate, 'release'); await c.startSettled.promise;
    await new Promise<void>(resolve => setImmediate(resolve)); // publish the wrapper's cleanup receipt
    await c.cancel(); // deterministic retry after the retained startup has settled
    expect(c.terminals().map(event => event.type)).toEqual(['task.cancelled']);
    expect(c.sent.some(event => event.type === 'task.started')).toBe(false);
    expectNoErrors(c); await c.assertReaped();
  });

  it('shutdown exposes a gated startup owner and reaps it on retry without a second terminal', async () => {
    const c = await setup(runtime, 'startup'); const offered = c.offer();
    await vi.waitFor(async () => expect(await c.trace()).toContain('startup'));
    c.runner.stopAcceptingOffers();
    await expect(c.runner.shutdownActiveTasks('operator')).rejects.toMatchObject({ name: 'RuntimeDisposalFailure' });
    await offered;
    expect(c.terminals()).toHaveLength(1);
    expect(c.terminals()[0]).toMatchObject({ type: 'task.fail', payload: { retryable: true } });
    await fs.writeFile(c.gate, 'release'); await c.startSettled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    await c.runner.shutdownActiveTasks('retry'); await c.cancel();
    expect(c.terminals()).toHaveLength(1); expectNoErrors(c); await c.assertReaped();
  });

  it('startup deadline publishes one failure and retains the late owner until its disposal receipt', async () => {
    const c = await setup(runtime, 'startup', { startupTimeoutMs: 1000 }); const offered = c.offer();
    await vi.waitFor(async () => expect(await c.trace()).toContain('startup'));
    await vi.waitFor(() => expect(c.terminals()).toHaveLength(1)); await offered;
    expect(c.terminals()[0]).toMatchObject({ type: 'task.fail', payload: { retryable: false } });
    expect(c.sent.some(event => event.type === 'task.started')).toBe(false);
    expect(c.runner.activeTaskCount).toBe(1);
    await fs.writeFile(c.gate, 'release'); await c.startSettled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    await c.runner.shutdownActiveTasks('deadline owner disposal'); await c.cancel();
    expect(c.terminals()).toHaveLength(1); expectNoErrors(c); await c.assertReaped();
  });

  it('delivers Host cancellation across the daemon transport to the native tree and returns metering once', async () => {
    const c = await setup(runtime, 'tool');
    const server = await TestServer.start();
    const daemon = createDaemonWithAdapters({
      productName: 'T1 cancellation integration', productId: 't1-native-host', serverUrl: server.url,
      workspaceRoot: path.join(c.dir, 'host-workspace'), storeDir: path.join(c.dir, 'host-store'),
      localAgentRelease: { version: '0.24.0-rc.1' }, runtimeEnvironment: { [runtime]: { allow: ['T1_*'] } },
    }, [c.adapter]);
    try {
      await daemon.pair('pairing-code'); await daemon.start();
      server.send(createEnvelope('task.offer', { instruction: 'Host cancellation', runtime, policy: { mode: 'auto' } },
        { taskId: 'host-task', seq: server.nextSeq() }));
      await server.waitFor(event => event.type === 'task.progress' && event.task_id === 'host-task'
        && event.payload.events.some(event => event.type === 'tool_use'));
      server.send(createEnvelope('task.cancel', { reason: 'Host stop' }, { taskId: 'host-task', seq: server.nextSeq() }));
      const terminal = await server.waitFor(event => event.type === 'task.cancelled' && event.task_id === 'host-task');
      expect(terminal).toMatchObject({ type: 'task.cancelled', payload: { usage: { runtime, promptTokens: 456, completionTokens: 29 } } });
      await daemon.stop();
      expect(server.received.filter(event => event.task_id === 'host-task' && ['task.complete', 'task.fail', 'task.cancelled'].includes(event.type))).toHaveLength(1);
      await c.assertReaped();
    } finally { await daemon.stop(); await server.close(); }
  });

  it.each(['stream', 'tool'])('cancels during %s, retains interrupt usage and deduplicates terminal work', async scenario => {
    const c = await setup(runtime, scenario); await c.offer();
    await vi.waitFor(() => expect(c.events().some(event => event.type === (scenario === 'tool' ? 'tool_use' : 'progress'))).toBe(true));
    const progressCount = c.sent.filter(event => event.type === 'task.progress').length;
    await Promise.all([c.cancel(), c.cancel()]); await c.cancel(); await c.offer();
    expect(c.terminals().map(event => event.type)).toEqual(['task.cancelled']); expectUsage(c, 456, 29); expectNoErrors(c);
    expect(c.sent.filter(event => event.type === 'task.progress')).toHaveLength(progressCount);
    expect((await c.trace()).filter(label => label === 'interrupt')).toHaveLength(1);
    expect((await c.trace()).filter(label => label === 'spawn')).toHaveLength(1);
    await c.assertReaped();
  });

  it('shutdown races cancel with one retryable terminal and preserved usage', async () => {
    const c = await setup(runtime, 'tool'); await c.offer();
    await vi.waitFor(() => expect(c.events().some(event => event.type === 'tool_use')).toBe(true));
    c.runner.stopAcceptingOffers(); await Promise.all([c.runner.shutdownActiveTasks('operator'), c.cancel()]);
    expect(c.terminals()[0], JSON.stringify(c.terminals())).toMatchObject({ type: 'task.fail', payload: { retryable: true } });
    expectUsage(c, 456, 29); expectNoErrors(c);
    await c.runner.shutdownActiveTasks('repeat'); await c.cancel(); expect(c.terminals()).toHaveLength(1); await c.assertReaped();
  });

  it('wall-clock timeout reaps with one non-retryable failure and final usage', async () => {
    const c = await setup(runtime, 'tool'); await c.offer({ maxDurationMs: 100 });
    await vi.waitFor(() => expect(c.terminals()).toHaveLength(1)); await vi.waitFor(() => expect(c.runner.activeTaskCount).toBe(0));
    expect(c.terminals()[0]).toMatchObject({ type: 'task.fail', payload: { retryable: false, reason: expect.stringContaining('maxDurationMs') } });
    expectUsage(c, 456, 29); expectNoErrors(c); await c.cancel(); expect(c.terminals()).toHaveLength(1); await c.assertReaped();
  });

  it.each(['no-ack', 'ack-only'])('%s interrupt reaps without a competing failure or fabricated usage', async scenario => {
    const c = await setup(runtime, scenario); await c.offer();
    await vi.waitFor(() => expect(c.events().some(event => event.type === 'progress')).toBe(true)); await c.cancel();
    expect(c.terminals().map(event => event.type)).toEqual(['task.cancelled']);
    if (runtime === 'claude') expect(c.terminals()[0]?.payload).not.toHaveProperty('usage'); else expectUsage(c, 123, 17);
    expectNoErrors(c); await c.assertReaped();
  });

  it('waits for usage arriving in a later native frame after the interrupt ACK', async () => {
    const c = await setup(runtime, 'delayed-result'); await c.offer();
    await vi.waitFor(() => expect(c.events().some(event => event.type === 'progress')).toBe(true));
    await c.cancel(); expect(c.terminals().map(event => event.type)).toEqual(['task.cancelled']);
    expectUsage(c, 456, 29); expectNoErrors(c); await c.assertReaped();
  });

  it('repeated cancel after completion cannot change its result or charge twice', async () => {
    const c = await setup(runtime, 'complete'); await c.offer(); await vi.waitFor(() => expect(c.runner.activeTaskCount).toBe(0));
    expect(c.terminals().map(event => event.type)).toEqual(['task.complete']); expectUsage(c, 123, 17);
    await Promise.all([c.cancel(), c.cancel(), c.runner.shutdownActiveTasks('already ended')]); await c.offer();
    expect(c.terminals()).toHaveLength(1); expectNoErrors(c); await c.assertReaped();
  });

  it('mid-turn native process exit yields one infrastructure failure and reaps descendants', async () => {
    const c = await setup(runtime, 'exit'); await c.offer();
    await vi.waitFor(() => expect(c.events().some(event => event.type === 'progress')).toBe(true));
    await fs.writeFile(c.gate, 'exit');
    await vi.waitFor(() => expect(c.terminals()).toHaveLength(1)); await vi.waitFor(() => expect(c.runner.activeTaskCount).toBe(0));
    // Codex deliberately classifies infrastructure failures non-retryable;
    // Pi/Claude use retryable. Keep each bundled adapter's existing policy.
    expect(c.terminals()[0], JSON.stringify(c.terminals())).toMatchObject({ type: 'task.fail', payload: { retryable: runtime !== 'codex' } });
    if (runtime !== 'claude') expectUsage(c, 123, 17);
    await c.cancel(); expect(c.terminals()).toHaveLength(1); await c.assertReaped();
  });

  it('native interruption alone retains the existing turn_end contract without inventing Host cancellation', async () => {
    const c = await setup(runtime, 'native-abort'); await c.offer();
    await vi.waitFor(() => expect(c.runner.activeTaskCount).toBe(0));
    // The frozen AgentEvent turn_end has no cancellation cause. Only a Host
    // task.cancel reserves task.cancelled; preserve the bundled contract here.
    expect(c.terminals().map(event => event.type)).toEqual(['task.complete']);
    expectUsage(c, runtime === 'claude' ? 456 : 123, runtime === 'claude' ? 29 : 17);
    await c.cancel(); expect(c.terminals()).toHaveLength(1); expectNoErrors(c); await c.assertReaped();
  });
});

/**
 * Two independent device processes against one Worker H Host (#794 D3, cross-process row). Each process has its own pairing
 * (enrollment), SDK store dir, workspace and Agent home, and a synthetic runtime. The machine identities are synthetic, so
 * this is two devices on one computer, not two computers. The runtime is the K8 stub: this records protocol evidence only,
 * with no model call.
 *
 * Bot A (the Main Bot) runs on device 1 and delegates to Bot B on device 2. B's reply, an Agent message that H's consumer
 * accepts, answers the delegation, and A's report Turn runs on device 1.
 */
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '@byok-sdk/client';
import * as runtimeAdapters from '@byok-sdk/client/adapters';
import { createTestKeychain } from '../../../scripts/testing/macos-keychain.mjs';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { createDeviceSession, deviceConfig, type DeviceEvent } from './device-session.js';
import { runDeviceRunner, runnerCommand, runnerOptions } from './device-runner.js';
import { hash, taskId, type ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { seedCollaboration } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from '@byok-sdk/example-hosted-bot-collaboration/src/layout';
import { openSubstrate, RUN, startDevice, startWorker, until, type DeviceProcess, type Substrate, type WorkerInstance } from './worker.test-support';

const OWNER = { id: 'owner', kind: 'human' } as const;
const runnerArgs = ['--server-url', 'http://127.0.0.1:1234', '--pairing-code', 'test-pairing-secret', '--root', '/tmp/runner', '--runtime', 'stub'];

describe('device runner boundaries', () => {
  it.each(['stub', 'real'])('selects %s explicitly and leaves OS identity and custody to the SDK', runtime => {
    const options = runnerOptions([...runnerArgs.slice(0, -1), runtime]);
    expect(options.runtime).toBe(runtime);
    expect(options.config).toMatchObject({ storeDir: path.resolve('/tmp/runner/sdk'), agentHome: { hostStorageRoot: path.resolve('/tmp/runner/homes') } });
    expect(options.config).not.toHaveProperty('machineId');
    expect(options.config).not.toHaveProperty('deviceCredentials');
  });
  it.each([
    [], [...runnerArgs.slice(0, -1), 'unknown'], [...runnerArgs, '--unknown', 'secret'],
    ['--server-url', 'invalid', ...runnerArgs.slice(2)],
    ...['ftp://host', 'https://user:secret@host', 'https://host/?secret=x', 'https://host/#secret'].map(url => ['--server-url', url, ...runnerArgs.slice(2)]),
  ].map(args => ({ args })))('rejects missing, unsupported or credential-bearing arguments (%#)', ({ args }) => {
    expect(() => runnerOptions(args)).toThrow();
  });
  it.each(['invalid secret', 'null', '{}', '{"type":"pair","code":"secret"}', '{"type":"finish","taskId":"x"}', '{"type":"stop","secret":"x"}'])
    ('rejects malformed or unsupported stdin commands (%#)', line => { expect(() => runnerCommand(line)).toThrow(); });

  it('forwards real adapter hooks and reports only task metadata, without running a model', async () => {
    let listener!: client.DaemonEventListener;
    let wrapped!: client.RuntimeAdapter;
    const send = vi.fn();
    const lease = vi.fn(), launch = vi.fn(), start = vi.fn(async () => ({ sessionRef: 'session' }));
    const operation = { acquireSessionLease: lease, resolveRuntimeLaunch: launch, start };
    const adapter = { descriptor: { id: 'pi' }, detect: vi.fn(), runtimeEnvironment: vi.fn(), projectMcpEnvironment: vi.fn(),
      prepare: vi.fn(async () => ({ kind: 'prepared', operation })) } as unknown as client.RuntimeAdapter;
    const factory = vi.spyOn(runtimeAdapters, 'createRuntimeAdapters').mockReturnValue([adapter]);
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockImplementation((_config, adapters) => {
      wrapped = adapters[0]!;
      return { subscribe: (callback: client.DaemonEventListener) => { listener = callback; return () => {}; }, stop: vi.fn() } as unknown as client.Daemon;
    });
    try {
      const device = createDeviceSession(deviceConfig('http://localhost', '/tmp/real-runner'), 'real', send);
      expect(factory).toHaveBeenCalledWith({});
      await wrapped.detect(); await wrapped.runtimeEnvironment(); wrapped.projectMcpEnvironment!({});
      const prepared = await wrapped.prepare({} as client.RuntimeAdapterPrepareInput);
      if (prepared.kind !== 'prepared') throw new Error('expected prepared');
      await prepared.operation.acquireSessionLease!('session');
      await prepared.operation.resolveRuntimeLaunch!({} as never);
      await prepared.operation.start({ manifest: { taskId: 'task', agentRef: { agentId: 'agent' } } } as client.RuntimeOperationStartInput);
      expect(lease.mock.contexts[0]).toBe(operation);
      expect(launch.mock.contexts[0]).toBe(operation);
      expect(start.mock.contexts[0]).toBe(operation);
      listener({ kind: 'completed', taskId: 'task', ts: '', summary: 'secret', sessionRef: 'secret' });
      listener({ kind: 'failed', taskId: 'task', ts: '', reason: 'secret', retryable: false });
      listener({ kind: 'cancelled', taskId: 'task', ts: '', reason: 'secret' });
      expect(send.mock.calls.map(([event]) => event)).toEqual([{ type: 'started', taskId: 'task', agentId: 'agent' },
        { type: 'finished', taskId: 'task' }, ...Array(2).fill({ type: 'error', message: 'runtime task did not complete' })]);
      await expect(device.finish('task', {})).rejects.toThrow('only available with the stub');
      vi.mocked(adapter.prepare).mockResolvedValueOnce({ kind: 'reject', reason: 'refused', retryable: false });
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'refused', retryable: false });
      await device.stop();
    } finally { compose.mockRestore(); factory.mockRestore(); }
  });

  it.each(['connecting', 'halted', 'crashed', 'timeout'])('waits for the SDK ready fact or fails on %s', async phase => {
    let reads = 0;
    const daemon = { subscribe: () => () => {}, pair: vi.fn(async () => ({ deviceId: 'device' })), start: vi.fn(), stop: vi.fn(),
      status: () => ({ lifecycle: phase === 'connecting' ? { phase: 'running', connection: ++reads > 1 ? 'open' : 'connecting' }
        : { phase: phase === 'timeout' ? 'running' : phase, connection: 'connecting' } }),
    } as unknown as client.Daemon;
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockReturnValue(daemon);
    const send = vi.fn();
    vi.useFakeTimers();
    try {
      const device = createDeviceSession(deviceConfig('http://localhost', '/tmp/ready-runner'), 'stub', send);
      const paired = device.pair('secret');
      const assertion = phase === 'connecting' ? expect(paired).resolves.toBeUndefined() : expect(paired).rejects.toThrow('did not become ready');
      await vi.advanceTimersByTimeAsync(30_025);
      await assertion;
      expect(send.mock.calls).toEqual(phase === 'connecting' ? [[{ type: 'ready', deviceId: 'device' }]] : []);
      await expect(device.finish('missing-task', {})).rejects.toThrow('no runtime session');
      await device.stop();
    } finally { vi.useRealTimers(); compose.mockRestore(); }
  });

  it.each(['stop', 'eof', 'signal', 'pre-aborted', 'invalid', 'halt', 'crash', 'pair-failure'])('stops and releases the runner on %s', async ending => {
    const input = new PassThrough(), output = new PassThrough(), controller = new AbortController();
    let listener!: client.DaemonEventListener;
    const finish = vi.fn(), stop = vi.fn(), unsubscribe = vi.fn();
    let paired!: () => void;
    const ready = new Promise<void>(resolve => { paired = resolve; });
    const pair = vi.fn(async () => { paired(); if (ending === 'pair-failure') throw new Error('pairing-secret'); });
    if (ending === 'pre-aborted') controller.abort();
    const running = runDeviceRunner(runnerArgs, input, output, controller.signal, (() => ({ pair, finish, stop,
      daemon: { subscribe: (callback: client.DaemonEventListener) => { listener = callback; return unsubscribe; } },
    })) as unknown as typeof createDeviceSession);
    const settled = expect(running);
    if (ending !== 'pre-aborted') await ready;
    else expect(pair).not.toHaveBeenCalled();
    if (ending === 'stop') input.write('{"type":"finish","taskId":"task","document":{}}\n{"type":"stop"}\n');
    if (ending === 'eof') input.end();
    if (ending === 'signal') controller.abort();
    if (ending === 'invalid') input.write('secret invalid JSON\n');
    if (ending === 'halt' || ending === 'crash') listener({ kind: 'lifecycle', ts: '', lifecycle: ending === 'halt'
      ? { phase: 'halted', reason: 'device_revoked' } : { phase: 'crashed' } } as client.DaemonEvent);
    if (['invalid', 'halt', 'crash', 'pair-failure'].includes(ending)) await settled.rejects.toThrow();
    else await settled.resolves.toBeUndefined();
    if (ending === 'stop') expect(finish).toHaveBeenCalledWith('task', {});
    expect(stop).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    input.destroy(); output.destroy();
  });
});

/** A Bot template with the K8 reply contract (K8 team.test-support.ts): each Turn's reply is a required Agent message. */
function replying(deviceId: string, agentId: string): ExecutionTemplate {
  const base = template(deviceId, agentId);
  return { ...base, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'h-worker' }, payload: { ...base.payload,
    messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65_536 } } };
}

describe.skipIf(!RUN)('two device processes against one Worker H Host (#794 D3)', () => {
  let substrate: Substrate;
  let worker: WorkerInstance | undefined;
  const devices: DeviceProcess[] = [];
  const scope = `worker-team-${randomUUID()}`;
  let token: string;

  beforeAll(async () => {
    substrate = await openSubstrate();
    await substrate.provision(scope, OWNER, { models: { default: template('pending', 'main') }, readOnlyToolsets: [] });
    worker = await startWorker(substrate);
    for (let i = 0; i < 2; i++) {
      const { code } = await worker.admin<{ code: string }>('/host/pairing-code', { scope });
      devices.push(await startDevice(worker.base, code));
    }
    const [one, two] = devices as [DeviceProcess, DeviceProcess];
    const a = replying(one.deviceId, 'agent-a'), b = replying(two.deviceId, 'agent-b');
    token = await substrate.provision(scope, OWNER, { models: { local: a, remote: b }, readOnlyToolsets: [] });
    await substrate.store.seed(scope, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
      // Each Bot's id is its Agent id, as the H sync re-projects the agentRef from it (#1358).
      const { main, ...bots } = state.team.bots;
      state.team.bots = { ...bots, 'agent-a': { ...main!, id: 'agent-a', model: 'local', execution: a },
        'agent-b': { ...main!, id: 'agent-b', name: 'B', role: 'Reviewer', mainBot: false, model: 'remote', execution: b } };
      state.turns.t1!.botId = 'agent-a';
    });
    for (const device of devices) await substrate.store.bindDevice(scope, device.deviceId);
  });
  afterAll(async () => {
    for (const device of devices) await device.stop();
    await worker?.dispose();
    await substrate?.dispose();
  });

  const pass = () => worker!.passes();
  const state = () => substrate.store.read(scope);
  const attempt = async (task: string) => (await substrate.pool.query<{ device_id: string; status: string }>(
    `SELECT device_id, status FROM "${substrate.sdkSchema}".task WHERE tenant_id = $1 AND task_id = $2`, [scope, task])).rows[0];
  const commands = async () => (await substrate.pool.query<{ key: string }>(
    `SELECT key FROM "${substrate.hSchema}".command WHERE scope = $1 ORDER BY key`, [storedKey(scope)])).rows.map(row => JSON.parse(row.key) as string);

  it('routes A -> B -> A across the two processes: each Turn runs on its Bot\'s device, and each result commits once', async () => {
    const [one, two] = devices as [DeviceProcess, DeviceProcess];
    expect(one.pid).not.toBe(two.pid);
    expect(one.deviceId).not.toBe(two.deviceId);

    const response = await worker!.input(token, 'agent-a', `k-${randomUUID()}`, 'Ask B to check the totals');
    expect(response.status).toBe(200);
    const { turnId: root } = await response.json() as { turnId: string };
    const rootTask = taskId(root, 0);
    await one.waitForStart(rootTask);
    await one.finish(rootTask, { delegate: [{ to: 'agent-b', request: 'Check the totals' }] });

    const delegationId = hash([rootTask, 'delegate', 0]), request = taskId(delegationId, 0);
    await until(async () => (await pass(), two.started.some(entry => entry.taskId === request) || undefined));
    expect((await state()).delegations[delegationId]).toMatchObject({ toDeviceId: two.deviceId, toAgentRef: { agentId: 'agent-b' } });
    expect(await attempt(request)).toMatchObject({ device_id: two.deviceId });
    await two.finish(request, {});

    const report = hash(['bot_reply', delegationId]), reportTask = taskId(report, 0);
    await until(async () => (await pass(), (await state()).delegations[delegationId]?.verdict === 'answered' || undefined));
    expect((await state()).delegations[delegationId]).toMatchObject({ verdict: 'answered', reply: request, replyTurnId: report });
    await until(async () => (await pass(), one.started.some(entry => entry.taskId === reportTask) || undefined));
    await one.finish(reportTask, {});
    await until(async () => (await pass(), (await state()).turns[report]?.status === 'succeeded' || undefined));

    // Each Turn ran on its own Bot's device process, once.
    expect(one.started.map(entry => entry.taskId)).toEqual([rootTask, reportTask]);
    expect(two.started.map(entry => entry.taskId)).toEqual([request]);
    expect(await attempt(reportTask)).toMatchObject({ device_id: one.deviceId });
    // One command record for each terminal outcome, and one for each Turn's reply message (`taskId:messageId`).
    const recorded = await commands();
    for (const task of [rootTask, request, reportTask]) {
      expect(recorded.filter(id => id === task), task).toHaveLength(1);
      expect(recorded.filter(id => id.startsWith(`${task}:`)), `${task} reply`).toHaveLength(1);
    }
    // Each device has its own Agent home: B's Agent never had a home on device 1, nor A's on device 2.
    const agents = async (device: DeviceProcess) => readdir(path.join(device.root, 'homes', 'agents')).catch(() => [] as string[]);
    expect(await agents(one)).toContain('agent-a');
    expect(await agents(two)).toContain('agent-b');
    expect(await agents(one)).not.toContain('agent-b');
    expect(await agents(two)).not.toContain('agent-a');
    await expect(access(path.join(two.root, 'sdk'))).resolves.toBeUndefined();
  });

  it('an instance destroyed after the consumer committed a reply: the device sends it again, and the decision stays', async () => {
    const [one] = devices as [DeviceProcess, DeviceProcess];
    worker = await restart({ fault: 'hang-after-consume' });
    const response = await worker.input(token, 'agent-a', `k-${randomUUID()}`, 'Answer directly');
    const { turnId } = await response.json() as { turnId: string };
    const task = taskId(turnId, 0);
    await until(async () => (await pass(), one.started.some(entry => entry.taskId === task) || undefined));
    // Without a wait for this finish: the device's reply request is the one that hangs.
    const finished = one.finish(task, {});
    await worker.waitForOutput(`[h-fault] hang-after-consume ${task}`);
    await worker.kill();
    const committed = (await commands()).filter(id => id.startsWith(`${task}:`));
    expect(committed).toHaveLength(1);
    worker = await restart();
    await finished;
    await until(async () => (await pass(), (await state()).turns[turnId]?.status === 'succeeded' || undefined));
    expect((await commands()).filter(id => id.startsWith(`${task}:`))).toEqual(committed);
    expect((await commands()).filter(id => id === task)).toHaveLength(1);
  });

  it('runs the JSON-lines stub runner with SDK machine identity and disposable custody against the local Host', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hw-runner-'));
    const keychain = process.platform === 'darwin' ? await createTestKeychain() : undefined;
    const input = new PassThrough(), output = new PassThrough();
    let printed = '';
    output.on('data', chunk => { printed += chunk.toString(); });
    const events = () => printed.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as DeviceEvent & { runtime: string });
    const runnerScope = `runner-${randomUUID()}`;
    const args = ['--server-url', worker!.base, '--root', root, '--runtime', 'stub'];
    await substrate.provision(runnerScope, OWNER, { models: { default: template('pending', 'main') }, readOnlyToolsets: [] });
    const { code } = await worker!.admin<{ code: string }>('/host/pairing-code', { scope: runnerScope });
    const running = runDeviceRunner([...args, '--pairing-code', code], input, output, new AbortController().signal,
      (config, runtime, send) => {
        expect(config.machineId).toBeUndefined();
        expect(config.deviceCredentials).toBeUndefined();
        return keychain ? createDeviceSession({ ...config, deviceCredentials: { macosKeychainPath: keychain.path } }, runtime, send)
          : createDeviceSession(config, runtime, send, { deviceCredentials: new InMemoryDeviceCredentialStore() });
      });
    // Attach failure handling before polling so a startup failure cannot become an unhandled rejection.
    let failure: unknown;
    void running.catch(error => { failure = error; });
    try {
      const ready = await until(async () => {
        if (failure) throw failure;
        return events().find(event => event.type === 'ready');
      });
      if (ready.type !== 'ready') throw new Error('expected ready');
      const deviceId = ready.deviceId;
      expect((await substrate.pool.query<{ machine_id: string }>(`SELECT machine_id FROM "${substrate.sdkSchema}".device WHERE device_id = $1`, [deviceId])).rows[0]?.machine_id)
        .toMatch(/^[a-f0-9]{64}$/u);
      await substrate.store.bindDevice(runnerScope, deviceId);
      const execution = replying(deviceId, 'main');
      const runnerToken = await substrate.provision(runnerScope, OWNER, { models: { default: execution }, readOnlyToolsets: [] });
      await substrate.store.seed(runnerScope, state => {
        seedCollaboration(state);
        Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
        state.team.bots.main!.execution = execution;
      });
      const response = await worker!.input(runnerToken, 'main', randomUUID(), 'Answer directly');
      const { turnId } = await response.json() as { turnId: string };
      const task = taskId(turnId, 0);
      await until(async () => (await pass(), events().find(event => event.type === 'started' && event.taskId === task)));
      input.write(JSON.stringify({ type: 'finish', taskId: task, document: {} }) + '\n');
      await until(async () => events().find(event => event.type === 'finished' && event.taskId === task));
      await until(async () => (await pass(), (await substrate.store.read(runnerScope)).turns[turnId]?.status === 'succeeded' || undefined));
      input.write('{"type":"stop"}\n');
      await running;
      expect(events()).toEqual([{ type: 'ready', deviceId, runtime: 'stub' },
        { type: 'started', taskId: task, agentId: 'main', runtime: 'stub' }, { type: 'finished', taskId: task, runtime: 'stub' }]);
      expect(printed).not.toContain(code);
      expect(printed).not.toMatch(/privateKey|accessToken|refreshToken/u);
    } finally {
      input.end();
      await running.catch(() => {});
      await keychain?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  async function restart(options: Parameters<typeof startWorker>[1] = {}) {
    return worker!.restart(options);
  }
});

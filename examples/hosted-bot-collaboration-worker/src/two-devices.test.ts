/**
 * Two independent device processes against one Worker H Host (#794 D3, cross-process row). Each process has its own pairing
 * (enrollment), SDK store dir, workspace and Agent home, and a synthetic runtime. The machine identities are synthetic, so
 * this is two devices on one computer, not two computers. The runtime is the K8 stub: this records protocol evidence only,
 * with no model call.
 *
 * Bot A (the Main Bot) runs on device 1 and delegates to Bot B on device 2. B's reply, an Agent message that H's consumer
 * accepts, answers the delegation, and A's report Turn runs on device 1.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { access, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '@byok-sdk/client';
import * as runtimeAdapters from '@byok-sdk/client/adapters';
import { createTestKeychain } from '../../../scripts/testing/macos-keychain.mjs';
import { InMemoryDeviceCredentialBackend } from '@byok-sdk/client/testing';
import { createDeviceSession, deviceConfig, localMemberApproval, sealedCore, type DeviceEvent } from './device-session.js';
import * as deviceMemberModule from '../../../packages/client/src/daemon/device-member';
import { DeviceMemberRecords } from '../../../packages/client/src/daemon/device-member-custody';
import { openRemoteCanaryDevice } from './remote-canary-device.test-support';
import { HostedMember } from '../../hosted-bot-collaboration/src/e2ee-member.test-support';
import { createByokPool, createPostgresCoreStores, migrate, migrationsDir } from '@byok-sdk/cloud-dataplane';
import { createDataplaneScope, createObjectStorageScope } from '../../../packages/cloud-dataplane/src/__tests__/support/dataplane';
import { startWranglerDev } from '../../../packages/cloud-dataplane/src/__tests__/support/wrangler';
import { CANARY_METHODS, decodeCanaryRpc, encodeCanaryRpc, type CanaryCloud } from '../../hosted-bot-collaboration/src/canary-cloud.test-support';
import type { ZeroHitSession } from '../../hosted-bot-collaboration/src/zero-hit-runtime.test-support';
import { runDeviceRunner, runnerCommand, runnerOptions } from './device-runner.js';
import { hash, taskId, type ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { seedCollaboration } from '@byok-sdk/example-bot-collaboration/test-support';
import { storedKey } from '@byok-sdk/example-hosted-bot-collaboration/src/layout';
import { openSubstrate, RUN, startDevice, startWorker, until, type DeviceProcess, type Substrate, type WorkerInstance } from './worker.test-support';

const OWNER = { id: 'owner', kind: 'human' } as const;
const runnerArgs = ['--server-url', 'http://127.0.0.1:1234', '--pairing-code', 'test-pairing-secret', '--root', '/tmp/runner', '--runtime', 'stub'];

describe('device runner boundaries', () => {
  it.each(['direct', 'symlink'])('keeps every stdout line JSON with SDK diagnostics through a %s entry', async mode => {
    const root = await mkdtemp(path.join(tmpdir(), 'hw-runner-entry-'));
    const entry = fileURLToPath(new URL('./device-runner.ts', import.meta.url));
    const preload = path.join(root, 'diagnostics.mjs');
    await writeFile(preload, `
      process.once('beforeExit', () => {
        console.log('SDK log diagnostic');
        console.info('[byok/client] E2EE member verified');
        console.debug('SDK debug diagnostic');
        process.stdout.write(JSON.stringify({ type: 'probe' }) + '\\n');
      });
    `);
    try {
      const directory = path.join(root, 'runner');
      if (mode === 'symlink') await symlink(path.dirname(entry), directory, 'junction');
      const target = mode === 'symlink' ? path.join(directory, 'device-runner.ts') : entry;
      const tsx = createRequire(import.meta.url).resolve('tsx');
      const result = await new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, ['--import', tsx, '--import', preload, target, '--runtime', 'invalid'], (error, stdout, stderr) => {
          resolve({ code: error?.code, stdout, stderr });
        });
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('device-runner failed; check arguments, local custody, runtime and Host state.');
      expect(result.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ type: 'probe' }]);
      for (const diagnostic of ['SDK log diagnostic', '[byok/client] E2EE member verified', 'SDK debug diagnostic']) {
        expect(result.stderr).toContain(diagnostic);
        expect(result.stdout).not.toContain(diagnostic);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['stub', 'real'])('selects %s explicitly and leaves OS identity and custody to the SDK', runtime => {
    const options = runnerOptions([...runnerArgs.slice(0, -1), runtime]);
    expect(options.runtime).toBe(runtime);
    expect(options.config).toMatchObject({ storeDir: path.resolve('/tmp/runner/sdk'), agentHome: { hostStorageRoot: path.resolve('/tmp/runner/homes') } });
    expect(options.config).not.toHaveProperty('machineId');
    expect(options.config).not.toHaveProperty('deviceCredentials');
  });
  it.each([
    [], [...runnerArgs, '--verification-secret', ''], [...runnerArgs.slice(0, -1), 'real', '--stub-canary'],
    [...runnerArgs.slice(0, -1), 'real', '--canary-controls'], [...runnerArgs, '--stub-canary', '--canary-controls'],
    [...runnerArgs.slice(0, -1), 'unknown'], [...runnerArgs, '--unknown', 'secret'],
    ['--server-url', 'invalid', ...runnerArgs.slice(2)],
    ...['ftp://host', 'https://user:secret@host', 'https://host/?secret=x', 'https://host/#secret'].map(url => ['--server-url', url, ...runnerArgs.slice(2)]),
  ].map(args => ({ args })))('rejects missing, unsupported or credential-bearing arguments (%#)', ({ args }) => {
    expect(() => runnerOptions(args)).toThrow();
  });
  it.each(['invalid secret', 'null', '{}', '{"type":"pair","code":"secret"}', '{"type":"finish","taskId":"x"}', '{"type":"stop","secret":"x"}',
    ...[{ type: 'canary', taskId: '', text: 'private', sealed: true }, { type: 'canary', taskId: 'x', sealed: true },
      { type: 'canary', taskId: 'x', text: 'private', sealed: 'yes' }, { type: 'canary', taskId: 'x', text: 'private', sealed: true, extra: true }].map(value => JSON.stringify(value))])
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
      return { subscribe: (callback: client.DaemonEventListener) => { listener = callback; return () => {}; }, stop: vi.fn(),
        pair: vi.fn(async () => ({ deviceId: 'device' })), start: vi.fn(),
        status: () => ({ lifecycle: { phase: 'running', connection: 'open' } }),
      } as unknown as client.Daemon;
    });
    try {
      const device = createDeviceSession(deviceConfig('http://localhost', '/tmp/real-runner'), 'real', send);
      expect(factory).toHaveBeenCalledWith({});
      await device.pair('code');
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
      expect(send.mock.calls.map(([event]) => event)).toEqual([{ type: 'ready', deviceId: 'device' }, { type: 'started', taskId: 'task', agentId: 'agent' },
        { type: 'finished', taskId: 'task' }, ...Array(2).fill({ type: 'error', taskId: 'task', message: 'runtime task did not complete' })]);
      await expect(device.finish('task', {})).rejects.toThrow('only available with the stub');
      await expect(device.canary('task', 'private', true)).rejects.toThrow('only available with the stub');
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
    let wrapped!: client.RuntimeAdapter;
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockImplementation((_config, adapters) => { wrapped = adapters[0]!; return daemon; });
    const send = vi.fn();
    vi.useFakeTimers();
    try {
      const device = createDeviceSession(deviceConfig('http://localhost', '/tmp/ready-runner'), 'stub', send);
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'member binding pending', retryable: false });
      const paired = device.pair('secret');
      const assertion = phase === 'connecting' ? expect(paired).resolves.toBeUndefined() : expect(paired).rejects.toThrow('did not become ready');
      await vi.advanceTimersByTimeAsync(30_025);
      await assertion;
      expect(daemon.pair).toHaveBeenCalledWith('secret', undefined);
      expect(send.mock.calls).toEqual(phase === 'connecting' ? [[{ type: 'ready', deviceId: 'device' }]] : []);
      if (phase === 'connecting') expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toMatchObject({ kind: 'prepared' });
      await expect(device.canary('missing-task', 'private', true)).rejects.toThrow('--canary-controls');
      await expect(device.finish('missing-task', {})).rejects.toThrow('no runtime session');
      await device.stop();
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'member binding failed', retryable: false });
    } finally { vi.useRealTimers(); compose.mockRestore(); }
  });

  it.each([true, false])('runs canary content steps after steer and approval (sealed=%s)', async sealed => {
    const root = await mkdtemp(path.join(tmpdir(), 'hw-canary-'));
    let wrapped!: client.RuntimeAdapter;
    const daemon = { subscribe: () => () => {}, stop: vi.fn(), pair: vi.fn(async () => ({ deviceId: 'device' })), start: vi.fn(),
      status: () => ({ activeTaskCount: 0, lifecycle: { phase: 'running', connection: 'open' } }),
    } as unknown as client.Daemon;
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockImplementation((_config, adapters) => { wrapped = adapters[0]!; return daemon; });
    const send = vi.fn(), approve = vi.fn(async () => ({ approved: true }));
    try {
      const device = createDeviceSession(deviceConfig('http://localhost', root), 'stub', send, {}, false, true);
      await device.pair('code');
      const prepared = await wrapped.prepare({} as client.RuntimeAdapterPrepareInput);
      if (prepared.kind !== 'prepared') throw new Error('expected prepared');
      const session = await prepared.operation.start({ kind: 'instruction', instruction: 'private canary',
        manifest: { taskId: 'task', cwd: root }, approvalChannel: { request: approve },
      } as unknown as client.RuntimeOperationStartInput) as ZeroHitSession;
      const emit = vi.spyOn(session, 'emit');
      vi.spyOn(session, 'finish').mockImplementation(async () => { session.closed = true; });
      await expect(device.canary('task', 'wrong input', sealed)).rejects.toThrow('did not open instruction');
      const running = device.canary('task', 'private', sealed);
      expect(approve).not.toHaveBeenCalled();
      await session.steer('Steer private');
      await running;
      expect(approve).toHaveBeenCalledWith('Approve private');
      expect(emit.mock.calls.map(([event]) => event)).toEqual([
        { type: 'progress', text: 'Progress private' }, { type: 'artifact', name: 'notes.txt', contentType: 'text/plain' },
        ...Array(2).fill({ type: 'progress', text: `private${'.'.repeat(sealed ? 140_000 : 60_000)}` }),
      ]);
      expect(await import('node:fs/promises').then(fs => fs.readFile(path.join(root, 'notes.txt'), 'utf8'))).toBe(`private${'.'.repeat(70_000)}`);
      expect(session.finish).toHaveBeenCalledWith({ text: 'private' });
      expect(send.mock.calls.at(-1)).toEqual([{ type: 'finished', taskId: 'task' }]);
      await device.stop();
    } finally { compose.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['instruction', 'prepared', 'failed-result'])('automatically echoes only an instruction and emits its UTF-8 hash: %s', async mode => {
    let wrapped!: client.RuntimeAdapter;
    const daemon = { subscribe: () => () => {}, stop: vi.fn(), pair: vi.fn(async () => ({ deviceId: 'device' })), start: vi.fn(),
      status: () => ({ lifecycle: { phase: 'running', connection: 'open' } }),
    } as unknown as client.Daemon;
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockImplementation((_config, adapters) => { wrapped = adapters[0]!; return daemon; });
    const output = new PassThrough(), text = 'private canary 你好\nsecond line';
    let printed = '';
    output.on('data', chunk => { printed += chunk.toString(); });
    try {
      expect(runnerOptions([...runnerArgs, '--stub-canary']).stubCanary).toBe(true);
      const device = createDeviceSession(deviceConfig('http://localhost', '/tmp/auto-canary'), 'stub',
        event => output.write(JSON.stringify(event) + '\n'), {}, true);
      await device.pair('code');
      const prepared = await wrapped.prepare({} as client.RuntimeAdapterPrepareInput);
      if (prepared.kind !== 'prepared') throw new Error('expected prepared');
      const session = await prepared.operation.start({ kind: mode === 'prepared' ? 'prepared' : 'instruction', instruction: text,
        manifest: { taskId: 'task' } } as unknown as client.RuntimeOperationStartInput) as ZeroHitSession;
      const finish = vi.spyOn(session, 'finish');
      if (mode === 'failed-result') finish.mockRejectedValue(new Error('private failure'));
      else finish.mockResolvedValue();
      const fail = vi.spyOn(session, 'fail');
      await new Promise(resolve => setImmediate(resolve));
      if (mode === 'prepared') { expect(finish).not.toHaveBeenCalled(); expect(fail).toHaveBeenCalledOnce(); }
      else expect(finish).toHaveBeenCalledExactlyOnceWith({ text });
      expect(printed.trim().split('\n').map(line => JSON.parse(line))).toEqual([
        { type: 'ready', deviceId: 'device' }, { type: 'started', taskId: 'task', agentId: '' },
        mode === 'instruction' ? { type: 'canary-result', taskId: 'task', sha256: createHash('sha256').update(text, 'utf8').digest('hex') }
          : { type: 'error', taskId: 'task', message: mode === 'prepared' ? 'stub canary requires an instruction task' : 'stub canary result failed' },
      ]);
      expect(printed).not.toContain(text);
      await device.stop();
    } finally { compose.mockRestore(); output.destroy(); }
  });

  it.each(['refused', 'missing-channel', 'aborted-steer', 'aborted-approval', 'closed'])('refuses incomplete canary execution: %s', async mode => {
    let wrapped!: client.RuntimeAdapter;
    const daemon = { subscribe: () => () => {}, stop: vi.fn(), pair: vi.fn(async () => ({ deviceId: 'device' })), start: vi.fn(),
      status: () => ({ lifecycle: { phase: 'running', connection: 'open' } }),
    } as unknown as client.Daemon;
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockImplementation((_config, adapters) => { wrapped = adapters[0]!; return daemon; });
    try {
      const device = createDeviceSession(deviceConfig('http://localhost', '/tmp/canary-refused'), 'stub', vi.fn(), {}, false, true);
      await device.pair('code');
      const prepared = await wrapped.prepare({} as client.RuntimeAdapterPrepareInput);
      if (prepared.kind !== 'prepared') throw new Error('expected prepared');
      const session = await prepared.operation.start({ kind: 'instruction', instruction: 'private', manifest: { taskId: 'task' },
        ...(mode === 'missing-channel' ? {} : { approvalChannel: { request: () => mode === 'aborted-approval'
          ? new Promise(() => {}) : Promise.resolve({ approved: false }) } }),
      } as unknown as client.RuntimeOperationStartInput) as ZeroHitSession;
      const controller = new AbortController();
      if (!['aborted-steer', 'closed'].includes(mode)) await session.steer('Steer private');
      session.closed = mode === 'closed';
      const running = device.canary('task', 'private', true, controller.signal);
      const assertion = expect(running).rejects.toThrow();
      if (mode.startsWith('aborted')) controller.abort();
      await assertion;
      await device.stop();
    } finally { compose.mockRestore(); }
  });

  it.each(['success', 'exited', 'error', 'bad-json', 'identity', 'mismatch', 'bad-mac'])('drives a remote hc device and cleans up on %s', async mode => {
    const core = await sealedCore();
    const cloud = { createPairingCode: vi.fn(async () => ({ code: 'pair-secret' })), appendMemberChainEntries: vi.fn() } as unknown as CanaryCloud;
    const member = await HostedMember.create(cloud, 'tenant' as never);
    const keys = (await core.openMemberKeyRecord(await core.generateMemberKeyRecord({ tenantId: 'tenant', deviceId: 'physical' })))!;
    const deviceBundle = await core.createMemberKeyBundle({ deviceId: 'physical', signingPublicJwk: keys.signing.publicJwk,
      signingPrivateKey: keys.signing.privateKey, kemPublicJwk: keys.kem.publicJwk, kemEpoch: keys.kem.epoch });
    const mac = await core.computeDevicePairingMac(member.pv, { tenantId: 'tenant', deviceId: 'physical', member: deviceBundle });
    cloud.readMemberKeyRegistration = vi.fn(async () => ({ member: deviceBundle, deviceMac: mode === 'bad-mac' ? 'invalid' : mac }));
    vi.spyOn(member, 'approve').mockResolvedValue(deviceBundle); vi.spyOn(member, 'putScope').mockResolvedValue();
    const create = vi.spyOn(HostedMember, 'create').mockResolvedValue(member);
    const code = (await core.memberApprovalCode('tenant', member.member.signingPublicJwk, deviceBundle.signingPublicJwk)).replaceAll(' ', '');
    const events: (DeviceEvent & { runtime?: string })[] = [{ type: 'paired', deviceId: 'physical', runtime: 'stub' },
      { type: 'ready', deviceId: mode === 'identity' ? 'other' : 'physical', runtime: 'stub' },
      { type: 'started', taskId: 'task', agentId: 'agent', runtime: 'stub' }];
    const hc = vi.fn(async (args: string[]) => {
      if (args[0] === 'run') return JSON.stringify({ address: 'device/t1' });
      if (args[0] === 'read') return mode === 'bad-json' ? 'private invalid response' : JSON.stringify({ text: [
        'SDK diagnostic', 'not json', '{broken', JSON.stringify({ type: 'canary', text: 'echoed input' }),
        ...(mode === 'exited' ? [] : mode === 'error' ? [JSON.stringify({ type: 'error', runtime: 'stub', message: 'private' })] : events.map(event => JSON.stringify(event))),
      ].join('\n') });
      if (args[0] === 'get') return JSON.stringify({ state: 'finished' });
      if (args[0] === 'wait') return JSON.stringify({ ended: true, exit_code: 0 });
      if (args[0] === 'send') {
        const command = JSON.parse(args[2]!) as { type: string };
        if (command.type === 'member-bundle') events.push({ type: 'approval-code', code: mode === 'mismatch' ? '0'.repeat(50) : code });
        if (command.type === 'canary') events.push({ type: 'finished', taskId: 'task', runtime: 'stub' });
      }
      return '{}';
    });
    try {
      const opened = openRemoteCanaryDevice(cloud, 'tenant' as never, 'https://host.invalid', { machine: 'device', cwd: '/sdk', root: '/root/device' }, hc);
      if (mode === 'success') {
        const device = await opened;
        await device.begin('task', 'private', true); await device.finish('task'); await device.close();
        expect(member.approve).toHaveBeenCalledWith('physical');
        expect(member.putScope).toHaveBeenCalledWith('scope-zero-hit', deviceBundle, ['task-input', 'task-output']);
        const sent = hc.mock.calls.map(([args]) => args).filter(args => args[0] === 'send').map(args => JSON.parse(args[2]!) as { type: string });
        expect(sent.map(command => command.type)).toEqual(['member-bundle', 'approve', 'canary', 'stop']);
        expect(hc.mock.calls[0]![0]).toEqual(['run', '--bg', '--json', '--no-notify', '--on', 'device', '--cwd', '/sdk/examples/hosted-bot-collaboration-worker',
          'node', '--import', 'tsx', 'src/device-runner.ts', '--server-url', 'https://host.invalid',
          '--pairing-code', 'pair-secret', '--verification-secret', member.verificationSecret, '--root', '/root/device', '--runtime', 'stub', '--canary-controls']);
      } else {
        await expect(opened).rejects.toThrow(/remote canary|canary device transport|remote device/);
        if (mode === 'mismatch') expect(hc).toHaveBeenCalledWith(['send', 'device/t1', '{"type":"reject"}']);
        if (mode !== 'identity') expect(member.approve).not.toHaveBeenCalled();
      }
      expect(hc).toHaveBeenCalledWith(['kill', 'device/t1']);
      expect(hc).toHaveBeenCalledWith(['rm', 'device/t1']);
    } finally { create.mockRestore(); }
  });

  it('computes the same approval code as the page and refuses private bundle fields', async () => {
    const core = await sealedCore();
    const bundle = async (deviceId?: string) => {
      const keys = (await core.openMemberKeyRecord(await core.generateMemberKeyRecord({ tenantId: 'tenant', ...(deviceId ? { deviceId } : {}) })))!;
      return core.createMemberKeyBundle({ signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey,
        kemPublicJwk: keys.kem.publicJwk, kemEpoch: keys.kem.epoch, ...(deviceId ? { deviceId } : {}) });
    };
    const browser = await bundle(), device = await bundle('physical');
    const read = vi.spyOn(DeviceMemberRecords.prototype, 'readState').mockResolvedValue({ tenantId: 'tenant', deviceId: 'physical', member: device });
    try {
      const config = deviceConfig('https://host.invalid', '/tmp/comparison');
      const expected = (await core.memberApprovalCode('tenant', browser.signingPublicJwk, device.signingPublicJwk)).replaceAll(' ', '');
      expect((await localMemberApproval(config, 'physical', browser)).code).toBe(expected);
      expect(expected).toMatch(/^\d{50}$/);
      for (const invalid of [{ ...browser, privateKey: 'never echo' }, { ...browser, signingPublicJwk: { ...browser.signingPublicJwk, d: 'never echo' } }]) {
        await expect(localMemberApproval(config, 'physical', invalid)).rejects.toThrow('valid public browser bundle');
      }
      expect(read).toHaveBeenCalledOnce();
      read.mockResolvedValueOnce(undefined);
      await expect(localMemberApproval(config, 'physical', browser)).rejects.toThrow('pinned SDK local member-state');
    } finally { read.mockRestore(); }
  });

  it.each(['stub', 'real', 'echo', 'controls'].flatMap(mode => ['approve', 'reject', 'early-approve', 'early-task', 'repeat-bundle'].map(ending => ({ mode, ending }))))
    ('gates every E2EE member resume: $mode / $ending', async ({ mode, ending }) => {
    const input = new PassThrough(), output = new PassThrough();
    let printed = '';
    output.on('data', chunk => { printed += chunk.toString(); });
    const pair = vi.fn(), start = vi.fn(), stop = vi.fn();
    const compareMember = vi.fn();
    const factory = ((_config: unknown, _runtime: unknown, send: (event: DeviceEvent) => void) => {
      compareMember.mockImplementation(async () => { send({ type: 'approval-code', code: '1'.repeat(50) }); });
      return { pair, start, stop, compareMember, daemon: { subscribe: () => () => {} } };
    }) as unknown as typeof createDeviceSession;
    const running = runDeviceRunner([...runnerArgs.slice(0, -1), mode === 'real' ? 'real' : 'stub', '--verification-secret', 'A'.repeat(26),
      ...(mode === 'echo' ? ['--stub-canary'] : mode === 'controls' ? ['--canary-controls'] : [])], input, output, new AbortController().signal, factory);
    const assertion = ['early-approve', 'early-task', 'repeat-bundle'].includes(ending) ? expect(running).rejects.toThrow() : expect(running).resolves.toBeUndefined();
    if (ending === 'early-approve') input.end('{"type":"approve"}\n');
    else if (ending === 'early-task') input.end('{"type":"finish","taskId":"task","document":{}}\n');
    else {
      input.write('{"type":"member-bundle","bundle":{}}\n');
      input.end(ending === 'repeat-bundle' ? '{"type":"member-bundle","bundle":{}}\n' : JSON.stringify({ type: ending }) + '\n');
    }
    await assertion;
    expect(pair).toHaveBeenCalledWith('test-pairing-secret', 'A'.repeat(26));
    expect(start).toHaveBeenCalledTimes(ending === 'approve' ? 1 : 0);
    if (!ending.startsWith('early')) expect(JSON.parse(printed.trim())).toEqual({ type: 'approval-code', code: '1'.repeat(50) });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('keeps the default stub capabilities unchanged', async () => {
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockReturnValue({ subscribe: () => () => {}, stop: vi.fn() } as unknown as client.Daemon);
    try {
      const device = createDeviceSession(deviceConfig('http://localhost', '/tmp/default-stub'), 'stub', vi.fn());
      expect(compose.mock.calls[0]![1][0]!.descriptor.capabilities).toMatchObject({ steer: false, approvalInteractive: false });
      await device.stop();
    } finally { compose.mockRestore(); }
  });

  it.each(['match', 'different', 'missing', 'missing-record', 'late-match', 'expired', 'interrupted', 'bound-before-ready', 'bound-startup-halted'])('binds local approval to the relayed public anchor: %s', async mode => {
    const fakeCloud = { appendMemberChainEntries: vi.fn() } as unknown as CanaryCloud;
    const browser = await HostedMember.create(fakeCloud, 'tenant' as never), other = await HostedMember.create(fakeCloud, 'tenant' as never);
    const state = { tenantId: 'tenant', deviceId: 'physical', member: { ...other.member, deviceId: 'physical' } };
    const read = vi.spyOn(DeviceMemberRecords.prototype, 'readState').mockResolvedValue(state);
    let connectionOpen = mode !== 'bound-before-ready';
    const daemon = { subscribe: () => () => {}, pair: vi.fn(async () => ({ deviceId: 'physical' })), start: vi.fn(), stop: vi.fn(),
      status: vi.fn(() => ({ lifecycle: mode === 'bound-startup-halted' ? { phase: 'halted', reason: 'device_revoked' }
        : { phase: 'running', connection: connectionOpen ? 'open' : 'connecting' } })),
    } as unknown as client.Daemon;
    let wrapped!: client.RuntimeAdapter;
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockImplementation((_config, adapters) => { wrapped = adapters[0]!; return daemon; }), send = vi.fn();
    try {
      vi.useFakeTimers();
      const pairedAt = Date.now();
      const device = createDeviceSession(deviceConfig('https://host.invalid', '/tmp/binding'), 'stub', send);
      await device.pair('code', browser.verificationSecret);
      expect(daemon.start).not.toHaveBeenCalled();
      await expect(device.start()).rejects.toThrow('comparison is required');
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'member binding failed', retryable: false });
      await device.pair('code', browser.verificationSecret);
      await device.compareMember(browser.member);
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'member binding pending', retryable: false });
      const key = mode === 'different' ? other.member.signingPublicJwk : browser.member.signingPublicJwk;
      read.mockImplementation(async () => mode === 'missing-record' ? undefined : { ...state,
        ...(mode === 'missing' || (mode === 'late-match' && Date.now() < pairedAt + 45_000) || mode === 'interrupted' ? {} : { anchor: {
          approverSigningPublicJwk: { y: key.y, x: key.x, crv: key.crv, kty: key.kty }, entry: { seq: 1, hash: `sha256:${'0'.repeat(64)}` },
        } }) });
      const controller = new AbortController();
      if (mode === 'expired') await vi.advanceTimersByTimeAsync(600_001);
      const started = device.start(controller.signal);
      const matches = mode === 'match' || mode === 'late-match' || mode === 'bound-before-ready';
      const assertion = matches ? expect(started).resolves.toBeUndefined()
        : expect(started).rejects.toThrow(mode === 'bound-startup-halted' ? 'did not become ready' : 'did not bind');
      if (mode === 'bound-before-ready') {
        await vi.advanceTimersByTimeAsync(1);
        expect(daemon.status).toHaveBeenCalled();
        expect(send.mock.calls.some(([event]) => event.type === 'ready')).toBe(false);
        expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'member binding pending', retryable: false });
        connectionOpen = true;
      }
      if (mode === 'late-match') {
        await vi.advanceTimersByTimeAsync(30_001);
        expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toMatchObject({ kind: 'reject', reason: 'member binding pending', retryable: false });
      }
      if (mode === 'interrupted') controller.abort();
      await vi.advanceTimersByTimeAsync(mode === 'missing' ? 600_001 : 15_025); await assertion;
      expect(send.mock.calls.some(([event]) => event.type === 'ready')).toBe(matches);
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toMatchObject(matches ? { kind: 'prepared' }
        : { kind: 'reject', reason: 'member binding failed', retryable: false });
      if (mode === 'bound-startup-halted') {
        expect(daemon.status).toHaveBeenCalled();
        expect(daemon.stop).not.toHaveBeenCalled();
      } else if (!matches) {
        expect(daemon.stop).toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith({ type: 'error', message: 'member relay did not bind the locally approved browser key' });
      }
      await device.stop();
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'member binding failed', retryable: false });
    } finally { vi.useRealTimers(); read.mockRestore(); compose.mockRestore(); }
  });

  it.each([undefined, 0, -1, Infinity, NaN])('fails closed for an invalid pinned pairing TTL: %s', async ttl => {
    const ttlRead = vi.spyOn(deviceMemberModule, 'PAIRING_VERIFICATION_TTL_MS', 'get').mockReturnValue(ttl as number);
    let wrapped!: client.RuntimeAdapter;
    const daemon = { subscribe: () => () => {}, pair: vi.fn(), stop: vi.fn() } as unknown as client.Daemon;
    const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockImplementation((_config, adapters) => { wrapped = adapters[0]!; return daemon; });
    try {
      const device = createDeviceSession(deviceConfig('https://host.invalid', '/tmp/ttl'), 'stub', vi.fn());
      await expect(device.pair('code', 'A'.repeat(26))).rejects.toThrow('pinned SDK pairing-verification TTL');
      expect(daemon.pair).not.toHaveBeenCalled();
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'member binding failed', retryable: false });
      await device.stop();
    } finally { ttlRead.mockRestore(); compose.mockRestore(); }
  });

  it.skipIf(process.platform === 'win32').each(['canary', 'private-bundle', 'interrupt'])('keeps a real PTY free of input and restores raw mode: %s', async mode => {
    const root = await mkdtemp(path.join(tmpdir(), 'hw-tty-')), fixture = path.join(root, 'probe.mjs');
    const entry = new URL('./device-runner.ts', import.meta.url).href;
    const secret = `not-in-terminal-${randomUUID()}`;
    const args = [...runnerArgs, '--canary-controls', ...(mode === 'private-bundle' ? ['--verification-secret', 'A'.repeat(26)] : [])];
    await writeFile(fixture, `
      import { runDeviceRunner, protectTerminalInput } from ${JSON.stringify(entry)};
      import { localMemberApproval } from ${JSON.stringify(new URL('./device-session.ts', import.meta.url).href)};
      const abort = new AbortController(), restore = protectTerminalInput(process.stdin, () => abort.abort());
      const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
      try { await runDeviceRunner(${JSON.stringify(args)}, process.stdin, process.stdout, abort.signal, (config, runtime, report) => ({
        daemon: { subscribe: () => () => {} }, stop: async () => {},
        pair: async (_code, pv) => report({ type: pv ? 'paired' : 'ready', deviceId: 'physical' }),
        compareMember: bundle => localMemberApproval(config, 'physical', bundle),
        canary: async taskId => report({ type: 'finished', taskId }),
      })); } catch { send({ type: 'error', message: 'control refused' }); }
      finally { restore(); send({ type: 'restored', raw: process.stdin.isRaw }); process.stdin.pause(); }
    `);
    const argv = [process.execPath, '--import', createRequire(import.meta.url).resolve('tsx'), fixture];
    const child = spawn('python3', ['-c', `
import os, pty, select, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if master in readable:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in readable:
        data = os.read(0, 65536)
        if not data:
            break
        os.write(master, data)
os.close(master)
sys.exit(child.wait())
`, ...argv]);
    let printed = '', sent = false;
    child.stderr.on('data', chunk => { printed += chunk.toString(); });
    child.stdout.on('data', chunk => {
      printed += chunk.toString();
      if (!sent && printed.includes(`"type":"${mode === 'private-bundle' ? 'paired' : 'ready'}"`)) {
        sent = true;
        child.stdin.write(mode === 'interrupt' ? '\x03' : JSON.stringify(mode === 'private-bundle'
          ? { type: 'member-bundle', bundle: { privateKey: secret } } : { type: 'canary', taskId: 'task', text: secret, sealed: true }) + '\r' +
          (mode === 'canary' ? '{"type":"stop"}\r' : ''));
      }
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      expect(code, printed).toBe(0); expect(sent).toBe(true);
      expect(printed).not.toContain(secret); expect(printed).not.toContain('privateKey');
      expect(printed).toContain('"type":"restored","raw":false');
      expect(printed).toContain(mode === 'private-bundle' ? '"type":"error"' : mode === 'canary' ? '"type":"finished"' : '"type":"restored"');
    } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['stop', 'eof', 'signal', 'pre-aborted', 'invalid', 'halt', 'crash', 'pair-failure'])('stops and releases the runner on %s', async ending => {
    const input = new PassThrough(), output = new PassThrough(), controller = new AbortController();
    let listener!: client.DaemonEventListener;
    const finish = vi.fn(), canary = vi.fn(), stop = vi.fn(), unsubscribe = vi.fn();
    let paired!: () => void;
    const ready = new Promise<void>(resolve => { paired = resolve; });
    const pair = vi.fn(async () => { paired(); if (ending === 'pair-failure') throw new Error('pairing-secret'); });
    if (ending === 'pre-aborted') controller.abort();
    const running = runDeviceRunner([...runnerArgs, '--canary-controls'], input, output, controller.signal, (() => ({ pair, finish, canary, stop,
      daemon: { subscribe: (callback: client.DaemonEventListener) => { listener = callback; return unsubscribe; } },
    })) as unknown as typeof createDeviceSession);
    const settled = expect(running);
    if (ending !== 'pre-aborted') await ready;
    else expect(pair).not.toHaveBeenCalled();
    if (ending === 'stop') input.write('{"type":"canary","taskId":"task","text":"private","sealed":true}\n{"type":"finish","taskId":"task","document":{}}\n{"type":"stop"}\n');
    if (ending === 'eof') input.end();
    if (ending === 'signal') controller.abort();
    if (ending === 'invalid') input.write('secret invalid JSON\n');
    if (ending === 'halt' || ending === 'crash') listener({ kind: 'lifecycle', ts: '', lifecycle: ending === 'halt'
      ? { phase: 'halted', reason: 'device_revoked' } : { phase: 'crashed' } } as client.DaemonEvent);
    if (['invalid', 'halt', 'crash', 'pair-failure'].includes(ending)) await settled.rejects.toThrow();
    else await settled.resolves.toBeUndefined();
    if (ending === 'stop') {
      expect(pair).toHaveBeenCalledWith('test-pairing-secret', undefined);
      expect(canary).toHaveBeenCalledWith('task', 'private', true, expect.any(AbortSignal));
      expect(finish).toHaveBeenCalledWith('task', {});
    }
    expect(stop).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    input.destroy(); output.destroy();
  });
});

it.skipIf(!RUN || process.env.BYOK_TEST_WORKER_SEALED_CANARY !== '1').each(['controls', 'echo', 'delayed-match', 'delayed-mismatch'])('executes a sealed canary over runner stdin with member pairing and JSON-only events (mode=%s)', async mode => {
  const automatic = mode !== 'controls', delayed = mode.startsWith('delayed');
  const scope = await createDataplaneScope(), storage = await createObjectStorageScope();
  const pool = createByokPool({ connectionString: scope.connectionString });
  const root = await mkdtemp(path.join(tmpdir(), 'hw-sealed-runner-'));
  const keychain = process.platform === 'darwin' ? await createTestKeychain() : undefined;
  const input = new PassThrough(), output = new PassThrough();
  const controller = new AbortController();
  let printed = '', failure: unknown;
  output.on('data', chunk => { printed += chunk.toString(); });
  const events = () => printed.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as DeviceEvent & { runtime: string });
  let worker: Awaited<ReturnType<typeof startWranglerDev>> | undefined, running: Promise<void> | undefined;
  let session: ReturnType<typeof createDeviceSession> | undefined, wrapped!: client.RuntimeAdapter;
  const originalCompose = client.createDaemonWithAdapters;
  const compose = vi.spyOn(client, 'createDaemonWithAdapters').mockImplementation((config, adapters, overrides) => {
    wrapped = adapters[0]!;
    return originalCompose(config, adapters, overrides);
  });
  try {
    await migrate(pool, migrationsDir());
    const { signingClock: _clock, ...objectStorage } = storage.config;
    worker = await startWranglerDev(fileURLToPath(new URL('./fixtures/sealed-canary', import.meta.url)),
      [`BYOK_CANARY_STORAGE:${JSON.stringify(objectStorage)}`], { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BYOK_PG: scope.connectionString });
    const cloud = Object.fromEntries(CANARY_METHODS.map(method => [method, async (...args: unknown[]) => {
      const response = await fetch(`${worker!.base}/probe/call`, { method: 'POST', body: encodeCanaryRpc({ method, args }) });
      expect(response.ok).toBe(true);
      return (decodeCanaryRpc(await response.text()) as { value: unknown }).value;
    }])) as CanaryCloud;
    const tenant = `runner-${randomUUID()}` as Parameters<CanaryCloud['createPairingCode']>[0];
    const core = createPostgresCoreStores({ pool, clock: { now: () => new Date() }, objectStorage: storage.config });
    await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
      maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
    const member = await HostedMember.create(cloud, tenant);
    const { code } = await cloud.createPairingCode(tenant, { productId: 'hosted-collaboration-worker' });
    running = runDeviceRunner(['--server-url', worker.base, '--pairing-code', code, '--verification-secret', member.verificationSecret,
      '--root', root, '--runtime', 'stub', ...(automatic ? ['--stub-canary'] : ['--canary-controls'])], input, output, controller.signal,
    (config, runtime, send, overrides, stubCanary, canaryControls) => {
      session = createDeviceSession(keychain ? { ...config, deviceCredentials: { macosKeychainPath: keychain.path } } : config,
        runtime, send, overrides, stubCanary, canaryControls);
      return session;
    });
    void running.catch(error => { failure = error; });
    const wait = (type: DeviceEvent['type']) => until(async () => { if (failure) throw failure; return events().find(event => event.type === type); });
    const paired = await wait('paired');
    if (paired.type !== 'paired') throw new Error('expected paired');
    const { deviceId } = paired;
    const compared = mode === 'delayed-mismatch' ? await HostedMember.create({ appendMemberChainEntries: vi.fn() } as unknown as CanaryCloud, tenant) : member;
    {
      expect(events().some(event => event.type === 'ready')).toBe(false);
      input.write(JSON.stringify({ type: 'member-bundle', bundle: compared.member }) + '\n');
      const codeEvent = await wait('approval-code');
      const registration = await cloud.readMemberKeyRegistration(tenant, deviceId);
      const core = await sealedCore();
      expect(codeEvent).toEqual({ type: 'approval-code', code: (await core.memberApprovalCode(tenant,
        compared.member.signingPublicJwk, registration!.member.signingPublicJwk)).replaceAll(' ', '') });
      input.write('{"type":"approve"}\n');
    }
    let earlyTask: string | undefined;
    if (delayed) {
      await until(async () => {
        const lifecycle = session!.daemon.status().lifecycle;
        return lifecycle.phase === 'running' && lifecycle.connection === 'open' || undefined;
      });
      earlyTask = `task-${randomUUID()}`;
      const early = template(deviceId, `agent-${randomUUID()}`);
      await cloud.submitAgentExecution(tenant, { taskId: earlyTask, deviceId, payload: early.payload });
      const offeredTask = earlyTask;
      const refused = await until(async () => (await cloud.readDeviceTerminal(tenant, offeredTask))?.envelope);
      expect(refused.type).toBe('task.decline');
      expect(refused.payload).toMatchObject({ reason: 'member binding pending', retryable: false });
      expect((await cloud.readTaskAttempt(tenant, earlyTask))?.status).toBe('failed');
      await wait('error');
      expect(events().filter(event => event.type === 'error')).toEqual([
        { type: 'error', taskId: earlyTask, message: 'runtime task did not complete', runtime: 'stub' },
      ]);
      expect(events().some(event => event.type === 'started')).toBe(false);
    }
    await member.putScope('scope-zero-hit', await member.approve(deviceId), ['task-input', 'task-output']);
    if (mode === 'delayed-mismatch') {
      await expect(running).rejects.toThrow('did not bind');
      expect(session!.daemon.status().lifecycle.phase).not.toBe('running');
      expect(events().some(event => event.type === 'started' || event.type === 'ready')).toBe(false);
      expect(events()).toContainEqual({ type: 'error', message: 'member relay did not bind the locally approved browser key', runtime: 'stub' });
      expect(await wrapped.prepare({} as client.RuntimeAdapterPrepareInput)).toEqual({ kind: 'reject', reason: 'member binding failed', retryable: false });
      return;
    }
    await wait('ready');
    await until(async () => (await cloud.listDevices(tenant)).find(device => device.deviceId === deviceId)?.capabilities?.includes('sealed-payload-v1') || undefined);
    const task = `task-${randomUUID()}`, text = `private-你好-${randomUUID()}`, execution = template(deviceId, `agent-${randomUUID()}`);
    const { instruction: _instruction, ...payload } = execution.payload;
    await cloud.submitSealedAgentExecution(tenant, { taskId: task, deviceId, payload: { ...payload, terminalProjection: payload.terminalProjection!,
      sealing: member.sealing, sealed: await member.seal('task.offer', { taskId: task }, deviceId, payload.agentRef, { instruction: text }) } });
    await wait('started');
    if (!automatic) {
      input.write(JSON.stringify({ type: 'canary', taskId: task, text, sealed: true }) + '\n');
      await until(async () => (await cloud.readTaskAttempt(tenant, task))?.status === 'running' || undefined);
      const steerId = randomUUID();
      await cloud.steerSealedTask(tenant, task, { steerId, sealed: await member.seal('task.steer', { taskId: task, steerId }, deviceId, payload.agentRef, { text: `Steer ${text}` }) });
      const approvalId = await until(async () => {
        if (failure) throw failure;
        const event = (await cloud.readApprovalTimeline(tenant, task))?.entries.find(entry => entry.event.type === 'approval_requested')?.event;
        return (event as { approvalId?: string } | undefined)?.approvalId;
      });
      await cloud.approveTask(tenant, task, { approvalId });
    }
    await wait('finished');
    const terminal = await until(async () => (await cloud.readDeviceTerminal(tenant, task))?.envelope);
    expect(terminal.type).toBe('task.complete');
    if (earlyTask) {
      expect((await cloud.readDeviceTerminal(tenant, earlyTask))?.envelope).toMatchObject({
        type: 'task.decline', payload: { reason: 'member binding pending', retryable: false },
      });
      expect((await cloud.readTaskAttempt(tenant, earlyTask))?.status).toBe('failed');
      expect(events().filter(event => event.type === 'started').map(event => event.taskId)).toEqual([task]);
    }
    if (automatic) {
      const { ciphertext, ...header } = (terminal.payload as { sealed: { ciphertext: string } }).sealed;
      const opened = await member.open('task.complete', { taskId: task }, deviceId, payload.agentRef,
        { header, ciphertext: Buffer.from(ciphertext, 'base64url') });
      expect(opened).toHaveProperty('document.text', text);
      expect(events().find(event => event.type === 'canary-result')).toEqual({ type: 'canary-result', taskId: task,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'), runtime: 'stub' });
    } else expect(terminal.payload).toHaveProperty('sealed.ciphertextRef');
    input.write('{"type":"stop"}\n'); await running;
    expect(events().map(event => event.type)).toEqual(['paired', 'approval-code', ...(delayed ? ['error'] : []), 'ready', 'started', ...(automatic ? ['canary-result'] : []), 'finished']);
    for (const secret of [text, code, member.verificationSecret]) expect(printed).not.toContain(secret);
  } finally {
    controller.abort(); input.end(); await running?.catch(() => {});
    await worker?.stop(); await keychain?.dispose(); await rm(root, { recursive: true, force: true });
    await pool.end(); await scope.dispose(); compose.mockRestore();
  }
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
          : createDeviceSession(config, runtime, send, { deviceCredentials: new InMemoryDeviceCredentialBackend() });
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

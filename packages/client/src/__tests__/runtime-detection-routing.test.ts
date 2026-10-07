import { createEnvelope } from '@byok-sdk/protocol';
import { runStatusCommand } from '../bin/commands/status';
import { runDoctorCommand } from '../bin/commands/doctor';
import { diagnoseDevice } from '../diagnostics/device-doctor';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runRuntimesCommand } from '../bin/commands/runtimes';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { validateRuntimeDetectResult } from '../runtime-detection';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const dirs: string[] = [];
const daemons: Daemon[] = [];
const servers: TestServer[] = [];
async function config(): Promise<DaemonConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-detect-routing-'));
  dirs.push(root);
  return { localAgentRelease: { version: '0.0.0-test' }, productName: 'Observation', productId: 'observation',
    workspaceRoot: root, storeDir: path.join(root, 'store'), serverUrl: 'http://example.invalid', runtimeAllowlist: ['codex'] };
}
function refusingAdapter() {
  const adapter = new StubRuntimeAdapter('codex');
  adapter.detect = vi.fn(async () => ({ kind: 'refused' as const, reason: 'app_server_unavailable' as const }));
  return adapter;
}
afterEach(async () => {
  await Promise.all(daemons.splice(0).map(d => d.stop()));
  await Promise.all(servers.splice(0).map(s => s.close()));
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

it('retains the SDK finite refusal through the strict decoder', () => {
  expect(validateRuntimeDetectResult({ kind: 'refused', reason: 'app_server_unavailable' })).toEqual({ kind: 'refused', reason: 'app_server_unavailable' });
});
it('refuses the removed attestation refusal reasons', () => {
  for (const reason of ['install_record_mismatch', 'installation_observation_unsupported', 'native_identity_mismatch']) {
    expect(() => validateRuntimeDetectResult({ kind: 'refused', reason })).toThrow('invalid runtime detection result');
  }
});
it('the runtimes command reports a refused adapter by its finite reason', async () => {
  const cfg = await config();
  const lines: string[] = [];
  await runRuntimesCommand(cfg, { adapters: [refusingAdapter()], log: line => lines.push(line) });
  expect(lines).toEqual(['codex: refused:app_server_unavailable']);
});
it('real daemon registration does not advertise a refused runtime', async () => {
  const cfg = await config();
  const server = await TestServer.start(); servers.push(server);
  cfg.serverUrl = server.url;
  const adapter = refusingAdapter();
  const daemon = createDaemonWithAdapters(cfg, [adapter]);
  daemons.push(daemon);
  await daemon.pair('pairing-code'); await daemon.start();
  const hello = await server.waitFor(e => e.type === 'conn.hello');
  if (hello.type !== 'conn.hello') throw new Error('wrong envelope');
  expect(hello.payload.runtimes).toEqual([]);
  expect(adapter.detect).toHaveBeenCalled();
});

it.each(['explicit', 'automatic'] as const)('real TaskRunner %s selection declines a refused runtime without starting it', async mode => {
  const cfg = await config(); const server = await TestServer.start(); servers.push(server); cfg.serverUrl = server.url;
  const adapter = refusingAdapter();
  const daemon = createDaemonWithAdapters(cfg, [adapter]); daemons.push(daemon);
  await daemon.pair('pairing-code'); await daemon.start();
  const before = vi.mocked(adapter.detect).mock.calls.length;
  server.send(createEnvelope('task.offer', { instruction: 'no start', ...(mode === 'explicit' ? { runtime: 'codex' as const } : {}) },
    { taskId: `refuse-${mode}`, seq: server.nextSeq() }));
  const declined = await server.waitFor(e => e.type === 'task.decline');
  expect(declined.payload).toMatchObject({ retryable: true }); // diagnostic reason does not rewrite task policy
  expect(vi.mocked(adapter.detect).mock.calls.length).toBe(before + 1);
  expect(adapter.startCalls).toHaveLength(0);
});
it('projects finite refusal through status and public doctor without private information', async () => {
  const cfg = await config(); const adapter = refusingAdapter();
  const lines: string[] = []; const connectControl = async () => ({ ok: false as const, reason: 'offline' });
  await runStatusCommand(cfg, { adapters: [adapter], log: line => lines.push(line), connectControl });
  expect(lines).toContain('runtimes: codex=refused:app_server_unavailable');
  const snapshot = await diagnoseDevice(cfg, { adapters: [adapter] });
  expect(snapshot.runtimes[0]).toMatchObject({ outcome: 'refused', reason: 'app_server_unavailable', present: false });
  expect(snapshot.checks.find(c => c.id === 'runtimes')?.summary).toContain('refused:app_server_unavailable=1');
  const json: string[] = [];
  await runDoctorCommand(cfg, { adapters: [adapter], connectControl, json: true, log: line => json.push(line) });
  expect(JSON.parse(json[0]!).diagnostics.runtimes[0].reason).toBe('app_server_unavailable');
});
it.each([
  { kind: 'refused' }, { kind: 'refused', reason: 'PRIVATE_SENTINEL' },
  { kind: 'refused', reason: 'app_server_unavailable', path: 'PRIVATE_SENTINEL' },
  { kind: 'available', reason: 'app_server_unavailable' }, { kind: 'timeout', reason: 'app_server_unavailable' },
])('strictly rejects malformed refusal %j', value => {
  expect(() => validateRuntimeDetectResult(value)).toThrow('invalid runtime detection result');
});

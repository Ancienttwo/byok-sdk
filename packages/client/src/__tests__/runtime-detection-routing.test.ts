import { createEnvelope } from '@byok-sdk/protocol';
import type { RuntimeAdapter, RuntimeInstallationObservationContext } from '../types';
import { runStatusCommand } from '../bin/commands/status';
import { runDoctorCommand } from '../bin/commands/doctor';
import { diagnoseDevice } from '../diagnostics/device-doctor';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { runRuntimesCommand } from '../bin/commands/runtimes';
import { createDaemon, createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
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
    workspaceRoot: root, storeDir: path.join(root, 'store'), serverUrl: 'http://example.invalid', runtimeAllowlist: ['pi'],
    toolImplementationAuthority: { resolve: vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'install_record_mismatch' as const })) } };
}
afterEach(async () => {
  await Promise.all(daemons.splice(0).map(d => d.stop()));
  await Promise.all(servers.splice(0).map(s => s.close()));
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

it('retains the SDK finite refusal through the strict decoder', () => {
  expect(validateRuntimeDetectResult({ kind: 'refused', reason: 'install_record_mismatch' })).toEqual({ kind: 'refused', reason: 'install_record_mismatch' });
});
it('configured CLI Pi reaches selected authority and never dev discovery', async () => {
  const cfg = await config();
  const resolveBin = vi.fn(() => { throw new Error('PRIVATE_SENTINEL'); });
  const lines: string[] = [];
  await runRuntimesCommand(cfg, { adapters: [new PiAdapter({ resolveBin })], log: line => lines.push(line) });
  expect(lines).toEqual(['pi: refused:install_record_mismatch']);
  expect(cfg.toolImplementationAuthority!.resolve).toHaveBeenCalledTimes(1);
  expect(resolveBin).not.toHaveBeenCalled();
});
it('configured injected adapter without installed observation refuses without invoking old detect', async () => {
  const cfg = await config();
  const adapter = new StubRuntimeAdapter('pi');
  adapter.detect = vi.fn(async () => ({ kind: 'available' as const }));
  const lines: string[] = [];
  await runRuntimesCommand(cfg, { adapters: [adapter], log: line => lines.push(line) });
  expect(lines).toEqual(['pi: refused:installation_observation_unsupported']);
  expect(adapter.detect).not.toHaveBeenCalled();
  expect(cfg.toolImplementationAuthority!.resolve).not.toHaveBeenCalled();
});
it.each(['default', 'injected'] as const)('real %s daemon registration does not advertise refused Pi', async mode => {
  const cfg = await config();
  const server = await TestServer.start(); servers.push(server);
  cfg.serverUrl = server.url;
  vi.stubEnv('BYOK_PI_BIN', fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url)));
  const adapter = new StubRuntimeAdapter('pi');
  adapter.detect = vi.fn(async () => ({ kind: 'available' as const }));
  const daemon = mode === 'default' ? createDaemon(cfg) : createDaemonWithAdapters(cfg, [adapter]);
  daemons.push(daemon);
  await daemon.pair('pairing-code'); await daemon.start();
  const hello = await server.waitFor(e => e.type === 'conn.hello');
  if (hello.type !== 'conn.hello') throw new Error('wrong envelope');
  expect(hello.payload.runtimes).toEqual([]);
  if (mode === 'default') expect(cfg.toolImplementationAuthority!.resolve).toHaveBeenCalledTimes(1);
  else expect(adapter.detect).not.toHaveBeenCalled();
});
it('unconfigured custom observation remains an explicit independent lane', async () => {
  const cfg = await config(); delete cfg.toolImplementationAuthority;
  const lines: string[] = [];
  await runRuntimesCommand(cfg, { adapters: [new StubRuntimeAdapter('pi')], log: line => lines.push(line) });
  expect(lines[0]).toContain('pi: present');
});

it.each(['explicit', 'automatic'] as const)('real TaskRunner %s selection uses installed observation without a lane substitution', async mode => {
  const cfg = await config(); const server = await TestServer.start(); servers.push(server); cfg.serverUrl = server.url;
  const base = new StubRuntimeAdapter('pi');
  const detect = vi.fn(async () => ({ kind: 'available' as const }));
  const installed = vi.fn(async (context: RuntimeInstallationObservationContext) => {
    expect(context).toEqual({ authority: cfg.toolImplementationAuthority, scope: 'enabled-top-level' });
    return { kind: 'refused' as const, reason: 'install_record_mismatch' as const };
  });
  const adapter: RuntimeAdapter = Object.assign(base, { detect, detectInstallation: installed });
  const daemon = createDaemonWithAdapters(cfg, [adapter]); daemons.push(daemon);
  await daemon.pair('pairing-code'); await daemon.start();
  expect(installed).toHaveBeenCalledTimes(1);
  server.send(createEnvelope('task.offer', { instruction: 'no start', policy: { mode: 'auto' }, ...(mode === 'explicit' ? { runtime: 'pi' as const } : {}) },
    { taskId: `refuse-${mode}`, seq: server.nextSeq() }));
  const declined = await server.waitFor(e => e.type === 'task.decline');
  expect(declined.payload).toMatchObject({ retryable: true }); // diagnostic reason does not rewrite task policy
  expect(installed).toHaveBeenCalledTimes(2); expect(detect).not.toHaveBeenCalled(); expect(base.startCalls).toHaveLength(0);
});
it('projects finite refusal through status and public doctor without private information', async () => {
  const cfg = await config(); const adapter = new StubRuntimeAdapter('pi');
  const lines: string[] = []; const connectControl = async () => ({ ok: false as const, reason: 'offline' });
  await runStatusCommand(cfg, { adapters: [adapter], log: line => lines.push(line), connectControl });
  expect(lines).toContain('runtimes: pi=refused:installation_observation_unsupported');
  const snapshot = await diagnoseDevice(cfg, { adapters: [adapter] });
  expect(snapshot.runtimes[0]).toMatchObject({ outcome: 'refused', reason: 'installation_observation_unsupported', present: false });
  expect(snapshot.checks.find(c => c.id === 'runtimes')?.summary).toContain('refused:installation_observation_unsupported=1');
  const json: string[] = [];
  await runDoctorCommand(cfg, { adapters: [adapter], connectControl, json: true, log: line => json.push(line) });
  expect(JSON.parse(json[0]!).diagnostics.runtimes[0].reason).toBe('installation_observation_unsupported');
});
it.each([
  { kind: 'refused' }, { kind: 'refused', reason: 'PRIVATE_SENTINEL' },
  { kind: 'refused', reason: 'install_record_mismatch', path: 'PRIVATE_SENTINEL' },
  { kind: 'available', reason: 'install_record_mismatch' }, { kind: 'timeout', reason: 'install_record_mismatch' },
])('strictly rejects malformed refusal %j', value => {
  expect(() => validateRuntimeDetectResult(value)).toThrow('invalid runtime detection result');
});

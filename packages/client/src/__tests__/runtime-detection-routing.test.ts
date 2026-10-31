import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
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
import { createDaemonRecordProjector } from '../daemon/daemon-record';
import { appendAuditRecord } from '../daemon/audit-log';
import { projectRuntimeObservation, validateRuntimeDetectResult } from '../runtime-detection';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

const dirs: string[] = [];
const daemons: Daemon[] = [];
const servers: TestServer[] = [];
async function config(): Promise<DaemonConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-detect-routing-'));
  dirs.push(root);
  return { localAgentRelease: { version: '0.0.0-test' }, productName: 'Observation', productId: 'observation',
    storeDir: path.join(root, 'store'), serverUrl: 'http://example.invalid', runtimeAllowlist: ['codex'] };
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
  expect(validateRuntimeDetectResult({ kind: 'refused', reason: 'acp_unavailable' })).toEqual({ kind: 'refused', reason: 'acp_unavailable' });
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
  const daemon = createDaemonWithAdapters({agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },  storage: { scratchRoot: testScratchRoot() }, ...(cfg) }, [adapter]);
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
  const daemon = createDaemonWithAdapters({agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },  storage: { scratchRoot: testScratchRoot() }, ...(cfg) }, [adapter]); daemons.push(daemon);
  await daemon.pair('pairing-code'); await daemon.start();
  const before = vi.mocked(adapter.detect).mock.calls.length;
  server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'no start', ...(mode === 'explicit' ? { runtime: 'codex' as const } : {}) },
    { taskId: `refuse-${mode}`, seq: server.nextSeq() }));
  const declined = await server.waitFor(e => e.type === 'task.decline');
  expect(declined.payload).toMatchObject({
    retryable: true, // diagnostic reason does not rewrite task policy
    code: 'runtime_unavailable',
    runtimeUnavailable: { cause: mode === 'explicit' ? 'app_server_unavailable' : 'none_available' },
  });
  expect(vi.mocked(adapter.detect).mock.calls.length).toBe(before + 1);
  expect(adapter.startCalls).toHaveLength(0);
});
it('maps every explicit detection failure to its typed cause and retryable default', async () => {
  const cfg = await config(); const server = await TestServer.start(); servers.push(server); cfg.serverUrl = server.url;
  const adapter = new StubRuntimeAdapter('codex');
  const daemon = createDaemonWithAdapters({agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },  storage: { scratchRoot: testScratchRoot() }, ...(cfg) }, [adapter]); daemons.push(daemon);
  await daemon.pair('pairing-code'); await daemon.start();
  const cases = [
    [{ kind: 'not-found' } as const, 'not_installed', true],
    [{ kind: 'not-executable' } as const, 'not_executable', true],
    [{ kind: 'timeout' } as const, 'probe_timeout', true],
    [{ kind: 'probe-failed' } as const, 'probe_failed', true],
    [{ kind: 'refused', reason: 'app_server_unavailable' } as const, 'app_server_unavailable', true],
    [{ kind: 'refused', reason: 'acp_unavailable' } as const, 'acp_unavailable', true],
    [{ kind: 'refused', reason: 'platform_unsupported' } as const, 'platform_unsupported', true],
    [{ kind: 'refused', reason: 'runtime_environment_unavailable', code: 'timeout' } as const, 'environment_unavailable', false],
  ] as const;
  for (const [detection, cause, retryable] of cases) {
    adapter.detect = async () => detection;
    const taskId = `cause-${cause}`;
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'no start', runtime: 'codex' }, { taskId, seq: server.nextSeq() }));
    const declined = await server.waitFor(e => e.type === 'task.decline' && e.task_id === taskId);
    expect(declined.payload).toMatchObject({ code: 'runtime_unavailable', retryable, runtimeUnavailable: { cause } });
    if (cause === 'environment_unavailable') {
      expect((declined.payload as { runtimeUnavailable?: { code?: string } }).runtimeUnavailable?.code).toBe('timeout');
    }
  }
  expect(adapter.startCalls).toHaveLength(0);
});

it('types allowlist and unknown-runtime declines without changing their text or retryability', async () => {
  const cfg = await config(); cfg.runtimeAllowlist = ['codex', 'claude'];
  const server = await TestServer.start(); servers.push(server); cfg.serverUrl = server.url;
  const adapter = new StubRuntimeAdapter('codex');
  const daemon = createDaemonWithAdapters({agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },  storage: { scratchRoot: testScratchRoot() }, ...(cfg) }, [adapter]); daemons.push(daemon);
  await daemon.pair('pairing-code'); await daemon.start();
  const cases = [
    ['pi', 'runtime_not_allowed', 'is not in this device\'s runtime allowlist'],
    ['claude', 'runtime_not_configured', 'unknown runtime'],
  ] as const;
  for (const [requested, cause, text] of cases) {
    const taskId = `policy-${cause}`;
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'no start', runtime: requested }, { taskId, seq: server.nextSeq() }));
    const declined = await server.waitFor(e => e.type === 'task.decline' && e.task_id === taskId);
    expect(declined.payload).toMatchObject({ code: 'runtime_unavailable', retryable: false, runtimeUnavailable: { cause } });
    expect((declined.payload as { reason?: string }).reason).toContain(text);
  }
  expect(adapter.startCalls).toHaveLength(0);
});

it('reports none_available when automatic selection exhausts every candidate', async () => {
  const cfg = await config(); const server = await TestServer.start(); servers.push(server); cfg.serverUrl = server.url;
  const adapter = new StubRuntimeAdapter('codex', { kind: 'not-found' });
  const daemon = createDaemonWithAdapters({agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },  storage: { scratchRoot: testScratchRoot() }, ...(cfg) }, [adapter]); daemons.push(daemon);
  await daemon.pair('pairing-code'); await daemon.start();
  server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'no start' }, { taskId: 'auto-none', seq: server.nextSeq() }));
  const declined = await server.waitFor(e => e.type === 'task.decline' && e.task_id === 'auto-none');
  expect(declined.payload).toMatchObject({ code: 'runtime_unavailable', retryable: true, runtimeUnavailable: { cause: 'none_available' } });
  expect(adapter.startCalls).toHaveLength(0);
});

it('projects finite refusal through status and public doctor without private information', async () => {
  const cfg = await config(); const adapter = refusingAdapter();
  const lines: string[] = []; const connectControl = async () => ({ ok: false as const, reason: 'offline' });
  await appendAuditRecord(cfg.storeDir!, createDaemonRecordProjector().project({ kind: 'runtimes-detected', ts: '2026-10-14T00:00:00.000Z', runtimes: [projectRuntimeObservation(adapter.descriptor, await adapter.detect())] })[0]!);
  await runStatusCommand(cfg, { log: line => lines.push(line), connectControl });
  expect(lines).toContain('runtimes: last-known codex=refused:app_server_unavailable at=2026-10-14T00:00:00.000Z');
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

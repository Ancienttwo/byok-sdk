import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectControlClient, requestRuntimeModels, requestRuntimeUsage } from '../daemon/control-client';
import type { RuntimeAccountUsage, RuntimeListModelsOptions, RuntimeReadOptions } from '../runtime/runtime-reader-types.js';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { RUNTIMES_ENVIRONMENT_METHOD } from '../daemon/control-protocol';
import { composeRuntimeEnvironment, RuntimeEnvironmentUnavailableError, type RuntimeEnvironment } from '../runtime/environment';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * #1095: `runtimes.environment` builds every adapter's environment on demand
 * and answers with its report only, so no value crosses the control socket.
 */

let server: TestServer;
let daemon: Daemon | undefined;
let storeDir: string;

beforeEach(async () => {
  server = await TestServer.start();
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-runtimes-env-'));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await server.close();
  await fs.rm(storeDir, { recursive: true, force: true });
});

it('answers each adapter build as names and sources, a capture failure as its code, anything else as failed', async () => {
  const live = {
    PATH: '/usr/bin', HOST_PASSED_SENTINEL: 'passed-value-sentinel', HOST_ONLY_SENTINEL: 'host-value-sentinel',
    BYOK_TOOL_AUTHORIZATION_GATE: 'live-gate-token-value-sentinel',
  };
  const shell = {
    PATH: '/opt/homebrew/bin:/usr/bin', SHELL_ONLY_SENTINEL: 'shell-value-sentinel', CLAUDECODE: '1',
    BYOK_TOOL_AUTHORIZATION_GATE: 'shell-gate-token-value-sentinel', BYOK_STORE_DIR: 'store-dir-value-sentinel',
  };
  const built = new StubRuntimeAdapter('claude');
  built.runtimeEnvironment = async () => composeRuntimeEnvironment({
    policy: { pass: ['HOST_PASSED_SENTINEL'] },
    snapshot: { status: { source: 'login-shell', shell: 'zsh', durationMs: 1 }, env: shell },
    live,
    platform: 'darwin',
  });
  const unavailable = new StubRuntimeAdapter('codex');
  unavailable.runtimeEnvironment = async () => { throw new RuntimeEnvironmentUnavailableError('timeout'); };
  const failed = new StubRuntimeAdapter('pi');
  failed.runtimeEnvironment = async () => { throw new Error('failed-message-sentinel'); };

  daemon = createDaemonWithAdapters({
    agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY }, storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, storeDir,
  }, [built, unavailable, failed]);
  await daemon.pair('code');
  await daemon.start();

  const connection = await connectControlClient({ storeDir, productId: 'test-product' });
  if (!connection.ok) throw new Error('expected the control socket');
  try {
    const result = await connection.client.request<unknown>(RUNTIMES_ENVIRONMENT_METHOD);
    expect(result).toEqual({
      runtimes: [
        {
          runtimeId: 'claude',
          status: 'built',
          names: [
            { name: 'HOST_PASSED_SENTINEL', source: 'pass' },
            { name: 'NO_PROXY', source: 'sdk' },
            { name: 'PATH', source: 'login-shell' },
            { name: 'SHELL_ONLY_SENTINEL', source: 'login-shell' },
            { name: 'no_proxy', source: 'sdk' },
          ],
          removed: [
            { name: 'BYOK_STORE_DIR', rule: 'deny' },
            { name: 'BYOK_TOOL_AUTHORIZATION_GATE', rule: 'deny' },
            { name: 'CLAUDECODE', rule: 'deny' },
          ],
        },
        { runtimeId: 'codex', status: 'unavailable', code: 'timeout' },
        { runtimeId: 'pi', status: 'failed' },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const value of [
      'passed-value-sentinel', 'host-value-sentinel', 'shell-value-sentinel', '/opt/homebrew/bin', 'failed-message-sentinel', 'HOST_ONLY_SENTINEL',
      'live-gate-token-value-sentinel', 'shell-gate-token-value-sentinel', 'host-toolset-value-sentinel',
    ]) {
      expect(serialized).not.toContain(value);
    }
  } finally {
    connection.client.close();
  }
});

it('sends only name and source, name and rule, whatever else a custom adapter puts into its report', async () => {
  // Structural typing lets a custom adapter return report entries with more fields than the type names.
  const names = [{ name: 'ACME_API_KEY', source: 'pass' as const, value: 'NAME_VALUE_SENTINEL' }];
  const removed = [{ name: 'BYOK_SECRET', rule: 'deny' as const, value: 'REMOVED_VALUE_SENTINEL' }];
  const lanes = [
    { lane: 'pi-prepared' as const, narrowedBy: 'sdk' as const, removed: ['ACME_API_KEY'], value: 'LANE_VALUE_SENTINEL' },
    { lane: 'pi-keys-profile' as const, narrowedBy: 'keys-launcher' as const, removed: ['LANE_NAME_SENTINEL'] },
  ];
  const rich: RuntimeEnvironment = { env: { ACME_API_KEY: 'NAME_VALUE_SENTINEL' }, report: { names, removed, lanes } };
  const adapter = new StubRuntimeAdapter('claude');
  adapter.runtimeEnvironment = async () => rich;
  daemon = createDaemonWithAdapters({
    agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY }, storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, storeDir,
  }, [adapter]);
  await daemon.pair('code');
  await daemon.start();

  const connection = await connectControlClient({ storeDir, productId: 'test-product' });
  if (!connection.ok) throw new Error('expected the control socket');
  try {
    const result = await connection.client.request<unknown>(RUNTIMES_ENVIRONMENT_METHOD);
    expect(result).toEqual({
      runtimes: [{
        runtimeId: 'claude', status: 'built', names: [{ name: 'ACME_API_KEY', source: 'pass' }], removed: [{ name: 'BYOK_SECRET', rule: 'deny' }],
        lanes: [{ lane: 'pi-prepared', narrowedBy: 'sdk', removed: ['ACME_API_KEY'] }, { lane: 'pi-keys-profile', narrowedBy: 'keys-launcher' }],
      }],
    });
    const serialized = JSON.stringify(result);
    for (const value of ['NAME_VALUE_SENTINEL', 'REMOVED_VALUE_SENTINEL', 'LANE_VALUE_SENTINEL', 'LANE_NAME_SENTINEL']) expect(serialized).not.toContain(value);
  } finally {
    connection.client.close();
  }
});

it('forwards on-demand catalog and usage reads on a paired host and keeps them out of SaaS discovery', async () => {
  const calls: Array<{ operation: string; signal?: AbortSignal; refresh?: boolean; allowPrintMode?: boolean }> = [];
  let usage: RuntimeAccountUsage = { kind: 'available', plan: 'test-private-plan', rateLimited: false, windows: [{ label: 'week', usedRatio: 0.37 }] };
  const catalog = { kind: 'ok', models: [{ id: 'model-a', effortLevels: ['low', 'high'], defaultEffort: 'low' },
    { id: 'model-b', effortUnavailableReason: 'Native model selection did not return a confirmed effort menu.' }] } as const;
  const adapter = Object.assign(new StubRuntimeAdapter('claude'), {
    async listModels(options: RuntimeListModelsOptions) { calls.push({ operation: 'models', ...options }); return catalog; },
    async accountUsage(options: RuntimeReadOptions) { calls.push({ operation: 'usage', ...options }); return usage; },
  });
  daemon = createDaemonWithAdapters({
    agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY }, storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, storeDir,
  }, [adapter]);
  await daemon.pair('code');
  await daemon.start();
  await vi.waitFor(() => expect(server.received.some(envelope => envelope.type === 'conn.hello')).toBe(true));
  expect(calls).toEqual([]);
  const connection = await connectControlClient({ storeDir, productId: 'test-product' });
  if (!connection.ok) throw new Error('expected the control socket');
  try {
    await expect(requestRuntimeModels(connection.client, 'claude', true)).resolves.toEqual(catalog);
    await expect(requestRuntimeUsage(connection.client, 'claude')).resolves.toEqual(usage);
    usage = { kind: 'reauth_required', reason: 'not_authenticated' };
    await expect(requestRuntimeUsage(connection.client, 'claude')).resolves.toEqual(usage);
    usage = { kind: 'unavailable', reason: 'access_token_expired' };
    await expect(requestRuntimeUsage(connection.client, 'claude')).resolves.toEqual(usage);
    await expect(connection.client.request('runtimes.usage', { runtimeId: 'claude', refresh: true })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(requestRuntimeUsage(connection.client, 'claude', true)).resolves.toEqual(usage);
    await expect(connection.client.request('runtimes.usage', { runtimeId: 'claude', allowPrintMode: 'true' })).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls.map(({ signal, ...options }) => options)).toEqual([
      { operation: 'models', refresh: true }, { operation: 'usage' }, { operation: 'usage' }, { operation: 'usage' },
      { operation: 'usage', allowPrintMode: true },
    ]);
    expect(calls.every(call => call.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.stringify(server.received)).not.toMatch(/test-private-plan|usedRatio|effortLevels|accountUsage/);
  } finally {
    connection.client.close();
  }
});

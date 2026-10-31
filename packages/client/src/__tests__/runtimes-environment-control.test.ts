import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { connectControlClient } from '../daemon/control-client';
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
  const live = { PATH: '/usr/bin', HOST_PASSED_SENTINEL: 'passed-value-sentinel', HOST_ONLY_SENTINEL: 'host-value-sentinel' };
  const shell = { PATH: '/opt/homebrew/bin:/usr/bin', SHELL_ONLY_SENTINEL: 'shell-value-sentinel', CLAUDECODE: '1' };
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
          removed: [{ name: 'CLAUDECODE', rule: 'deny' }],
        },
        { runtimeId: 'codex', status: 'unavailable', code: 'timeout' },
        { runtimeId: 'pi', status: 'failed' },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const value of ['passed-value-sentinel', 'host-value-sentinel', 'shell-value-sentinel', '/opt/homebrew/bin', 'failed-message-sentinel', 'HOST_ONLY_SENTINEL']) {
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
  const rich: RuntimeEnvironment = { env: { ACME_API_KEY: 'NAME_VALUE_SENTINEL' }, report: { names, removed } };
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
      runtimes: [{ runtimeId: 'claude', status: 'built', names: [{ name: 'ACME_API_KEY', source: 'pass' }], removed: [{ name: 'BYOK_SECRET', rule: 'deny' }] }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('NAME_VALUE_SENTINEL');
    expect(serialized).not.toContain('REMOVED_VALUE_SENTINEL');
  } finally {
    connection.client.close();
  }
});

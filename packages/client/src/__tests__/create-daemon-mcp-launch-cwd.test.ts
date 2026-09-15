import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { resolveTrustedLaunchCwd } from '../daemon/trusted-launch-cwd';
import type { RuntimeCapabilities } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * `DaemonConfig.mcpLaunchCwd` — the operator's input to the MCP toolset launch
 * boundary (`daemon/trusted-launch-cwd.ts`), which until this slice existed
 * only on `TaskRunnerDeps` and was therefore reachable only by an embedder
 * composing its own `TaskRunner`.
 *
 * Two things are pinned here and nowhere else: a configured directory actually
 * reaches the resolver (rather than being accepted and dropped, which would
 * leave the host silently on the platform default it configured its way off
 * of), and a `launcherInterpreter` that cannot work is a CONSTRUCTION error —
 * the same discipline `deviceAssertion` follows — instead of a spawn failure
 * inside the first task that needed a launcher-wrapped runtime.
 */

/** A pi-shaped stub: projects toolsets, grants their tools itself, so no offer waits on a `tools/list` probe. */
const TOOLSET_CAPABLE: RuntimeCapabilities = {
  steer: true,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  permissionModes: ['auto'],
};

async function tmpDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

/**
 * A directory this machine really does accept as a launch boundary AND that is
 * not the platform default — so "the configured directory was used" cannot be
 * confused with "the default happened to be right". Resolved through the real
 * resolver rather than hard-coded, because a host where the candidate does not
 * pass must SKIP rather than assert something the daemon would have refused.
 */
const NON_DEFAULT_TRUSTED_DIR = await (async (): Promise<string | undefined> => {
  if (process.platform === 'win32') return undefined;
  for (const candidate of ['/usr', '/opt', '/Library', '/bin']) {
    const resolved = await resolveTrustedLaunchCwd({ dir: candidate });
    if (resolved.kind === 'resolved') return resolved.dir;
  }
  return undefined;
})();

describe('createDaemonWithAdapters: DaemonConfig.mcpLaunchCwd validation', () => {
  async function buildConfig(mcpLaunchCwd?: DaemonConfig['mcpLaunchCwd']): Promise<DaemonConfig> {
    return {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Test Product',
      productId: 'test-product-mcp-launch-cwd',
      serverUrl: 'http://localhost:1',
      workspaceRoot: await tmpDir('byok-launch-cwd-workspace-'),
      storeDir: await tmpDir('byok-launch-cwd-store-'),
      ...(mcpLaunchCwd === undefined ? {} : { mcpLaunchCwd }),
    };
  }

  it('rejects a relative configured directory synchronously', async () => {
    const config = await buildConfig({ dir: 'relative/release' });
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()]))
      .toThrow(/mcpLaunchCwd\.dir must be an absolute directory path/);
  });

  it('rejects a launcherInterpreter that does not exist', async () => {
    // An attested interpreter is the operator's statement that a real Node
    // lives there. If it does not, the first launcher-wrapped runtime would
    // fail to spawn long after anyone could connect that to this config.
    const absent = path.join(await tmpDir('byok-launch-cwd-interp-'), 'node');
    const config = await buildConfig({ launcherInterpreter: absent });
    expect(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()]))
      .toThrow(/launcherInterpreter .* does not exist/);
  });

  it('rejects a relative launcherInterpreter, and one that is not a regular file', async () => {
    const relative = await buildConfig({ launcherInterpreter: 'node' });
    expect(() => createDaemonWithAdapters(relative, [new StubRuntimeAdapter()]))
      .toThrow(/launcherInterpreter must be an absolute executable path/);

    const directory = await buildConfig({ launcherInterpreter: await tmpDir('byok-launch-cwd-notafile-') });
    expect(() => createDaemonWithAdapters(directory, [new StubRuntimeAdapter()]))
      .toThrow(/launcherInterpreter .* is not a regular file/);
  });

  it('accepts this process own executable as an attested interpreter, and an absent section', async () => {
    const attested = await buildConfig({ launcherInterpreter: process.execPath });
    expect(() => createDaemonWithAdapters(attested, [new StubRuntimeAdapter()])).not.toThrow();

    const unset = await buildConfig(undefined);
    expect(() => createDaemonWithAdapters(unset, [new StubRuntimeAdapter()])).not.toThrow();
  });
});

describe('createDaemon MCP launch boundary: the configured directory reaches the resolver', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function startDaemon(mcpLaunchCwd?: DaemonConfig['mcpLaunchCwd']): Promise<StubRuntimeAdapter> {
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available', version: '0.0.0' }, TOOLSET_CAPABLE, false);
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product-mcp-launch-cwd-offer',
        serverUrl: server.url,
        workspaceRoot: await tmpDir('byok-launch-cwd-offer-workspace-'),
        storeDir: await tmpDir('byok-launch-cwd-offer-store-'),
        mcpToolsets: { salesko: { mcpServers: { salesko: { command: '/opt/salesko/bin/mcp' } } } },
        ...(mcpLaunchCwd === undefined ? {} : { mcpLaunchCwd }),
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return adapter;
  }

  function offerWithToolsets(taskId: string): void {
    server.send(
      createEnvelope(
        'task.offer_with_toolsets',
        { instruction: 'x', policy: { mode: 'auto' }, runtime: 'pi', requiredToolsets: ['salesko'] },
        { taskId, seq: server.nextSeq() },
      ),
    );
  }

  it.skipIf(NON_DEFAULT_TRUSTED_DIR === undefined)(
    'launches the toolset server in the operator-configured directory, not the platform default',
    async () => {
      const adapter = await startDaemon({ dir: NON_DEFAULT_TRUSTED_DIR });
      offerWithToolsets('task-configured-launch-cwd');
      await server.waitFor((envelope) => envelope.type === 'task.started');

      expect(adapter.startCalls[0]?.ctx.mcpLaunch).toEqual({ cwd: NON_DEFAULT_TRUSTED_DIR });
      // The platform default is a different directory, so the assertion above
      // is about the configured value rather than a coincidence.
      expect(NON_DEFAULT_TRUSTED_DIR).not.toBe('/');
      // The runtime CLI itself keeps its own writable workspace — only its MCP
      // server children move.
      expect(adapter.startCalls[0]?.ctx.workspaceDir).not.toBe(NON_DEFAULT_TRUSTED_DIR);
    },
  );

  it('declines non-retryably when the configured directory fails the boundary this uid can write', async () => {
    // The strongest evidence that the config is consulted at all: a directory
    // the platform default would never be. If `createDaemon` dropped the
    // section, this offer would have started in `/` and passed.
    const adapter = await startDaemon({ dir: await tmpDir('byok-launch-cwd-writable-') });
    offerWithToolsets('task-writable-launch-cwd');

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline');
    expect(decline.payload).toMatchObject({ retryable: false });
    expect(JSON.stringify(decline.payload)).toContain('configured_dir_owned_by_current_uid');
    expect(adapter.startCalls).toHaveLength(0);
  });
});

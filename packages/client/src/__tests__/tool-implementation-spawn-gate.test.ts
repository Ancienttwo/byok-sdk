import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { McpAuthorityError, probeMcpServer } from '../daemon/mcp-tools-probe';
import {
  parseToolImplementationIdentity,
  realToolImplementationFsProbe,
  type ToolImplementationAttestedV1,
  type ToolImplementationAuthority,
  type ToolImplementationFsProbe,
  type ToolImplementationIdentityV1,
} from '../daemon/tool-implementation-identity';
import { BYOK_PI_MCP_CONFIG_PATH } from '../adapters/pi/mcp-config';
import { observeMcpServer, type McpToolsetServerObservation } from '../mcp';
import type { McpToolsetConfig, RuntimeCapabilities } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { observationOf } from './fixtures/mcp-observation';
import { trustedCwd } from './fixtures/launch-cwd';

/**
 * The two production spawn points of one task's MCP toolset servers, and the
 * one identity they must both be talking about.
 *
 * `TaskRunner` resolves an implementation identity per projected server ONCE,
 * beside the launch binding. From there it reaches the admission probe
 * directly, and the Pi extension's pool through the task-scoped configuration
 * the adapter writes. Either link can be cut without breaking a compile, so
 * both are asserted here: the first two cases fail if the runner stops feeding
 * the probe or stops feeding `startInput`, and the extension cases fail if the
 * adapter stops writing the identities or the pool stops re-measuring them.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const ENV = { PATH: process.env.PATH ?? '' } as const;

const MCP_CAPABLE: RuntimeCapabilities = {
  steer: false,
  resume: true,
  approvalInteractive: true,
  mcpToolsets: true,
  permissionModes: ['auto', 'confirm'],
};

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used'); },
  uploadArtifact: async () => { throw new Error('not used'); },
};

const dirs: string[] = [];

async function tempDir(prefix = 'byok-impl-gate-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  // `maxRetries`: a cancelled task's own teardown may still be writing under
  // the store directory when this runs, and a removal that loses that race is
  // a flaky suite rather than a finding.
  await Promise.all(dirs.splice(0).map(
    (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
});

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * An attested identity for a REAL file on this machine, built the way the pi
 * adapter's task-scoped file is read back: through the module's own parser,
 * from the file's actual stat tuple and actual digest.
 *
 * Nothing here is invented — that is the point. The reverification these tests
 * exercise compares the identity against the filesystem, so a fabricated tuple
 * or digest would make every case fail for the wrong reason.
 */
async function attestReal(installPath: string): Promise<ToolImplementationAttestedV1> {
  const stats = await realToolImplementationFsProbe.lstat(installPath);
  const digest = await realToolImplementationFsProbe.digest(installPath);
  const identity = parseToolImplementationIdentity({
    kind: 'attested',
    authority: 'host-install-record',
    manifestRevision: 'fixture@1',
    form: 'compiled-executable',
    installPath,
    closureDigest: digest,
    closureKind: 'artifact',
    launchArgv: [],
    launchCwd: '/',
    launchEnvNamesDigest: 'a'.repeat(64),
    loaderEnvValuesDigest: 'b'.repeat(64),
    installStat: {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
    },
  });
  expect(identity?.kind).toBe('attested');
  return identity as ToolImplementationAttestedV1;
}

// ---------------------------------------------------------------------------
// Chain one and two: one resolve per server, consumed by both spawn points
// ---------------------------------------------------------------------------

/**
 * The seam that lets a non-root test exercise the ownership rule
 * `resolveToolImplementationIdentity` enforces at resolve; see
 * `daemon/tool-implementation-identity.ts`. Only ownership is overridden —
 * every other fact is read off the real file.
 */
function rootOwnedProbe(): ToolImplementationFsProbe {
  return {
    async lstat(target) {
      const real = await realToolImplementationFsProbe.lstat(target);
      return { ...real, uid: 0, mode: real.mode & ~0o222 };
    },
    realpath: (target) => realToolImplementationFsProbe.realpath(target),
    digest: (target) => realToolImplementationFsProbe.digest(target),
  };
}

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  toolsets: ReadonlyMap<string, McpToolsetConfig>,
  extra: Partial<TaskRunnerDeps>,
  probe: NonNullable<TaskRunnerDeps['mcpToolsetToolsProbe']>,
): Promise<TaskRunner> {
  return new TaskRunner({
    mcpToolsetToolsProbe: probe,
    adapters: [adapter],
    workspaceRoot: await tempDir('byok-impl-gate-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => sent.push(envelope),
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tempDir('byok-impl-gate-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    getMcpToolsets: () => toolsets,
    ...extra,
  });
}

const TOOLSETS: ReadonlyMap<string, McpToolsetConfig> = new Map([
  ['salesko', { mcpServers: { salesko: { command: '/opt/salesko/bin/mcp', args: ['--stdio'] } } }],
]);

async function offer(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(createEnvelope(
    'task.offer_with_toolsets',
    { instruction: 'x', policy: { mode: 'auto' }, runtime: 'claude', requiredToolsets: ['salesko'] },
    { taskId, seq: 1 },
  ));
}

describe('one resolve per server reaches both spawn points', () => {
  it('hands the probe and the adapter the SAME identity, resolved once', async () => {
    const adapter = new StubRuntimeAdapter('claude', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const artifact = path.join(await tempDir(), 'salesko-mcp');
    await fs.writeFile(artifact, '#!/bin/sh\nexec true\n');
    const digest = await realToolImplementationFsProbe.digest(artifact);
    const authority: ToolImplementationAuthority = {
      resolve: vi.fn(async (input) => {
        // The locator carries what the operator configured, not a guess.
        expect(input).toMatchObject({
          toolsetId: 'salesko',
          serverName: 'salesko',
          command: '/opt/salesko/bin/mcp',
          args: ['--stdio'],
        });
        expect(input.launch.launchCwd).toBe(await trustedCwd());
        return {
          kind: 'attested',
          authority: 'host-install-record',
          manifestRevision: 'salesko@2026.9.1',
          form: 'compiled-executable',
          installPath: artifact,
          closureDigest: digest,
          closureKind: 'artifact',
          launchArgv: ['--stdio'],
          launchCwd: '/',
          launchEnvNamesDigest: 'c'.repeat(64),
          loaderEnvValuesDigest: 'd'.repeat(64),
        } as never;
      }),
    };
    const seen: Array<ToolImplementationIdentityV1 | undefined> = [];
    const runner = await makeRunner(
      adapter,
      sent,
      TOOLSETS,
      { toolImplementationAuthority: authority, toolImplementationFsProbe: rootOwnedProbe() },
      async (serverName, _server, options) => {
        seen.push(options.implementation);
        return observationOf({ [serverName]: ['find_leads'] })[serverName]!;
      },
    );
    await offer(runner, 'task-impl-both');

    expect(authority.resolve).toHaveBeenCalledTimes(1);
    // Spawn point one: the probe received the identity.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('attested');
    // Spawn point two: the adapter received the SAME value, so the identity
    // written into the task-scoped MCP config is the one the probe used.
    const carried = adapter.startCalls[0]?.ctx.mcpToolImplementations;
    expect(carried).toEqual({ salesko: seen[0] });
    expect((carried!.salesko as ToolImplementationAttestedV1).installStat.uid).toBe(0);
    // SDK-measured, not resolver-supplied: the resolver's record carried no
    // stat tuple at all.
    expect((carried!.salesko as ToolImplementationAttestedV1).closureDigest).toMatch(SHA256_HEX);

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-impl-both', seq: 2 }));
  });

  it('resolves resolver_unconfigured for every server when no authority is wired, and still admits the task', async () => {
    const adapter = new StubRuntimeAdapter('claude', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const seen: Array<ToolImplementationIdentityV1 | undefined> = [];
    const runner = await makeRunner(adapter, sent, TOOLSETS, {}, async (serverName, _server, options) => {
      seen.push(options.implementation);
      return observationOf({ [serverName]: ['find_leads'] })[serverName]!;
    });
    await offer(runner, 'task-impl-none');

    expect(seen).toEqual([{ kind: 'unavailable', reason: 'resolver_unconfigured' }]);
    expect(adapter.startCalls[0]?.ctx.mcpToolImplementations)
      .toEqual({ salesko: { kind: 'unavailable', reason: 'resolver_unconfigured' } });
    // Nothing was claimed, so nothing is refused: an unconfigured daemon
    // proves nothing about its executors and runs the task anyway.
    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-impl-none', seq: 2 }));
  });
});

// ---------------------------------------------------------------------------
// Spawn point one: the admission probe
// ---------------------------------------------------------------------------

describe('the admission probe re-measures an attested server before spawning it', () => {
  async function artifactCopy(): Promise<string> {
    const target = path.join(await tempDir(), 'fixture-server.mjs');
    await fs.copyFile(FIXTURE, target);
    return target;
  }

  function spec(script: string) {
    return { command: process.execPath, args: [script, '{}'] };
  }

  it('observes the server when the artifact still measures the way it was attested', async () => {
    const script = await artifactCopy();
    const observation = await probeMcpServer('salesko', spec(script), {
      env: ENV,
      timeoutMs: 15_000,
      implementation: await attestReal(script),
    });
    expect(observation.tools.map((tool) => tool.name)).toContain('echo');
  }, 30_000);

  it('refuses the spawn when one byte of the artifact is rewritten after it was attested', async () => {
    const script = await artifactCopy();
    const identity = await attestReal(script);
    await fs.appendFile(script, '// one more byte\n');
    await expect(probeMcpServer('salesko', spec(script), {
      env: ENV,
      timeoutMs: 15_000,
      implementation: identity,
    })).rejects.toThrow(McpAuthorityError);
    await expect(probeMcpServer('salesko', spec(script), {
      env: ENV,
      timeoutMs: 15_000,
      implementation: identity,
    })).rejects.toThrow(/install_record_mismatch/u);
  }, 30_000);

  it('refuses the spawn on an mtime-only change, with the bytes untouched', async () => {
    const script = await artifactCopy();
    const identity = await attestReal(script);
    const moved = new Date(Date.now() + 120_000);
    await fs.utimes(script, moved, moved);
    expect(await realToolImplementationFsProbe.digest(script)).toBe(identity.closureDigest);
    await expect(probeMcpServer('salesko', spec(script), {
      env: ENV,
      timeoutMs: 15_000,
      implementation: identity,
    })).rejects.toThrow(/install_record_mismatch/u);
  }, 30_000);

  it('refuses the spawn when the bytes changed and every stat field was restored', async () => {
    // The case the stat tuple alone would miss and the digest catches: an
    // in-place overwrite of the same LENGTH, with the mtime put back.
    const script = await artifactCopy();
    // Pinned to a whole millisecond BEFORE attesting, so restoring it below
    // restores the exact value that was measured rather than a rounded one.
    const pinned = new Date(Date.now() - 60_000);
    await fs.utimes(script, pinned, pinned);
    const identity = await attestReal(script);
    const original = await fs.readFile(script, 'utf8');
    const tampered = `${original.slice(0, original.length - 2)}//`;
    expect(tampered.length).toBe(original.length);
    const handle = await fs.open(script, 'r+');
    await handle.write(tampered, 0, 'utf8');
    await handle.close();
    await fs.utimes(script, pinned, pinned);
    const after = await realToolImplementationFsProbe.lstat(script);
    // Non-vacuous: every field the tuple compares really is back where it was,
    // so only the content digest can be what refuses this spawn.
    expect(after.mtimeMs).toBe(identity.installStat.mtimeMs);
    expect(after.size).toBe(identity.installStat.size);
    expect(after.ino).toBe(identity.installStat.ino);
    await expect(probeMcpServer('salesko', spec(script), {
      env: ENV,
      timeoutMs: 15_000,
      implementation: identity,
    })).rejects.toThrow(/reverify_failed/u);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Spawn point two: the Pi extension's server pool
// ---------------------------------------------------------------------------

interface RegisteredTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

async function loadExtension(
  script: string,
  toolImplementations: Record<string, unknown> | undefined,
): Promise<RegisteredTool[]> {
  const observed = await observeMcpServer('salesko', { command: process.execPath, args: [script, '{}'] }, {
    env: ENV,
    timeoutMs: 15_000,
  });
  const observation: Record<string, McpToolsetServerObservation> = {
    salesko: { ...observed, toolsetId: 'salesko.v1' },
  };
  const configPath = path.join(await tempDir(), 'mcp-config.json');
  await fs.writeFile(configPath, JSON.stringify({
    mcpServers: { salesko: { command: process.execPath, args: [script, '{}'] } },
    observation,
    permissionMode: 'auto',
    launchCwd: await trustedCwd(),
    ...(toolImplementations === undefined ? {} : { toolImplementations }),
  }));
  process.env[BYOK_PI_MCP_CONFIG_PATH] = configPath;
  const tools: RegisteredTool[] = [];
  const extension = await import('../adapters/pi/mcp-extension');
  extension.default({
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    on: () => {},
  } as never);
  return tools;
}

describe('the Pi extension re-measures an attested server before opening it', () => {
  const configPathBefore = process.env[BYOK_PI_MCP_CONFIG_PATH];

  afterEach(() => {
    if (configPathBefore === undefined) delete process.env[BYOK_PI_MCP_CONFIG_PATH];
    else process.env[BYOK_PI_MCP_CONFIG_PATH] = configPathBefore;
  });

  async function artifactCopy(): Promise<string> {
    const target = path.join(await tempDir(), 'fixture-server.mjs');
    await fs.copyFile(FIXTURE, target);
    return target;
  }

  it('calls the tool when the artifact still measures the way the daemon attested it', async () => {
    const script = await artifactCopy();
    const tools = await loadExtension(script, { salesko: await attestReal(script) });
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    const result = await echo.execute('call-1', { text: 'hello' }, undefined);
    expect(result.content).toEqual([{ type: 'text', text: 'byok-fixture:echo:{"text":"hello"}' }]);
  }, 30_000);

  it('refuses to open the server when the artifact changed after the daemon attested it', async () => {
    const script = await artifactCopy();
    const identity = await attestReal(script);
    // A trailing comment: the server still starts and still answers, so the
    // refusal below can only be the reverification and not a broken fixture.
    await fs.appendFile(script, '// tampered\n');
    const tools = await loadExtension(script, { salesko: identity });
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    await expect(echo.execute('call-1', { text: 'hello' }, undefined))
      .rejects.toThrow(/install_record_mismatch/u);
  }, 30_000);

  it('opens the server normally when the daemon attested nothing about it', async () => {
    const script = await artifactCopy();
    const tools = await loadExtension(script, { salesko: { kind: 'unavailable', reason: 'resolver_unconfigured' } });
    const echo = tools.find((tool) => tool.name === 'mcp__salesko__echo')!;
    const result = await echo.execute('call-1', { text: 'hi' }, undefined);
    expect(result.content).toEqual([{ type: 'text', text: 'byok-fixture:echo:{"text":"hi"}' }]);
  }, 30_000);

  it('refuses the whole task configuration rather than dropping an identity it cannot read', async () => {
    const script = await artifactCopy();
    const attested = await attestReal(script);
    await expect(loadExtension(script, { salesko: { ...attested, trusted: true } }))
      .rejects.toThrow(/toolImplementations\.salesko is not an implementation identity this SDK issued/u);
    await expect(loadExtension(script, { unprojected: attested }))
      .rejects.toThrow(/toolImplementations\.unprojected names a server this task does not project/u);
  }, 30_000);
});

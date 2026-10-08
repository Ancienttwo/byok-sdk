import { fileURLToPath } from 'node:url';
import { spawn as realSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';
import type { Session } from '../types';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { observationOf } from './fixtures/mcp-observation';
import {
  projectMcpTools,
  qualifiedMcpToolName,
  type McpToolsetServerObservation,
} from '../mcp';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
/** A product Pi asset root that holds the SDK asset manifest: the built package assets. */
const PRODUCT_ASSETS = fileURLToPath(new URL('../../dist/assets/', import.meta.url));

function fakePiAdapter(): PiAdapter {
  return new PiAdapter({
    resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
  });
}

async function takeEvents(session: Session, count: number): Promise<AgentEvent[]> {
  const results: AgentEvent[] = [];
  for await (const event of session.events) {
    results.push(event);
    if (results.length >= count) break;
  }
  return results;
}

async function makeCtx(env: NodeJS.ProcessEnv = process.env): Promise<PreparedOperationResources> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-adapter-test-'));
  return { workspaceDir, env };
}

async function startAdapter(adapter: PiAdapter, task: TaskOfferPayload, resources: PreparedOperationResources): Promise<Session> {
  return startPreparedOperation(adapter, task, resources);
}

const baseTask: TaskOfferPayload = {
  instruction: 'say hi',
};

describe('PiAdapter against the fake-pi fixture', () => {
  const openSessions: Session[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(openSessions.splice(0).map((s) => s.close()));
  });

  it('detect() reports present + version from the fake binary', async () => {
    const adapter = fakePiAdapter();
    const result = await adapter.detect();
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') throw new Error('expected available runtime');
    expect(result.version).toBe('0.0.0-fake');
  });

  it('detects a package script without execute permission, preserving its version', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi package 空間 '));
    try {
      const script = path.join(dir, 'entry.mjs');
      await fs.writeFile(script, "if (process.argv[2] !== '--version') process.exit(2); console.log('package-v1');", { mode: 0o600 });
      const result = await new PiAdapter({ resolveBin: () => ({ command: script, source: 'package' }) }).detect();
      expect(result).toMatchObject({ kind: 'available', version: 'package-v1' });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('starts direct package RPC through the interpreter, including a spaced script path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi package 空間 '));
    let session: Session | undefined;
    try {
      const script = path.join(dir, 'entry.mjs');
      await fs.copyFile(FIXTURE_PATH, script);
      await fs.chmod(script, 0o600);
      await fs.copyFile(path.join(path.dirname(FIXTURE_PATH), 'process-tree-receipt.mjs'), path.join(dir, 'process-tree-receipt.mjs'));
      const adapter = new PiAdapter({ resolveBin: () => ({ command: script, source: 'package' }) });
      session = await startAdapter(adapter, baseTask, { workspaceDir: dir, env: process.env });
      expect(session.sessionRef.length).toBeGreaterThan(0);
      expect(await takeEvents(session, 5)).toHaveLength(5);
    } finally { await session?.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('detect() reports probe-failed when a bundle cannot resolve its required external pi sidecar', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => {
        throw new Error('required pi sidecar is not embedded');
      },
    });
    await expect(adapter.detect()).resolves.toEqual({ kind: 'probe-failed' });
  });

  it('start() fails closed when the required package or explicit sidecar cannot resolve', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => {
        throw new Error('required pi runtime is unavailable');
      },
    });
    await expect(startAdapter(adapter, baseTask, await makeCtx())).rejects.toThrow(/required pi runtime is unavailable/);
  });

  it('start() drives the canned prompt sequence into normalized AgentEvents', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    expect(typeof session.sessionRef).toBe('string');
    expect(session.sessionRef.length).toBeGreaterThan(0);

    const events = await takeEvents(session, 7);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' }, toolCallId: 'call_1' },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] } }, toolCallId: 'call_1', isError: false,
      },
      { type: 'progress', text: 'Hello ' },
      { type: 'progress', text: 'world' },
      // The assistant message_end's native usage: prompt = input + cacheRead + cacheWrite.
      { type: 'usage', inputTokens: 120, cachedInputTokens: 30, outputTokens: 12, totalTokens: 132 },
      { type: 'usage', contextTokens: 0, contextWindow: 1000000, contextSource: 'estimate' },
      { type: 'turn_end' },
    ]);
  });

  it('classifies spawn unavailability as typed start infrastructure retryable', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn: (() => {
        throw new Error('spawn ENOENT');
      }) as never,
    });
    let failure: unknown;
    try {
      await startAdapter(adapter, baseTask, await makeCtx());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'start', category: 'infrastructure', retry: 'retryable' });
  });

  it('routes an authoritative BYOK selection through the credential launcher without a key in argv or env', async () => {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawnFn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      calls.push({ command, args: [...args], env: options?.env ?? {} });
      const separator = args.indexOf('--');
      return realSpawn(FIXTURE_PATH, args.slice(separator + 1), options);
    }) as never;
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn,
      byokLauncher: {
        command: '/opt/byok-pi-provider-launcher',
        profileDbPath: '/private/providers.sqlite',
        sessionDir: '/private/pi-sessions',
      },
    });
    const task: TaskOfferPayload = {
      ...baseTask,
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
    };
    const ctx = await makeCtx({ ...process.env, OPENAI_API_KEY: 'sk-sentinel' });
    const session = await startAdapter(adapter, task, ctx);
    openSessions.push(session);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/opt/byok-pi-provider-launcher');
    expect(calls[0]?.args).toEqual([
      '--pi-bin',
      FIXTURE_PATH,
      '--profile-db',
      '/private/providers.sqlite',
      '--session-dir',
      '/private/pi-sessions',
      '--provider',
      'openai',
      '--model',
      'gpt-5.2',
      '--runtime-entry', 'pi-rpc',
      // The Pi process starts in the session cwd, as in OAR.
      '--pi-cwd', await fs.realpath(ctx.workspaceDir),
      '--pi-projection-dir', expect.any(String),
      '--pi-config-digest', expect.stringMatching(/^[0-9a-f]{64}$/),
      '--',
      '--config', expect.any(String),
      '--mode',
      'rpc',
    ]);
    expect(JSON.stringify(calls[0])).not.toContain('sk-sentinel');
    expect(calls[0]?.env.OPENAI_API_KEY).toBeUndefined();
    await expect(session.followUp({
      instruction: 'switch provider',
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
      },
    })).rejects.toThrow(/cannot change its authoritative BYOK provider\/model/);
  });

  it('projects an explicit macOS keychain path to the launcher argv unchanged', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      calls.push({ command, args: [...args] });
      const separator = args.indexOf('--');
      return realSpawn(FIXTURE_PATH, args.slice(separator + 1), options);
    }) as never;
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn,
      byokLauncher: {
        command: '/opt/byok-pi-provider-launcher',
        profileDbPath: '/private/providers.sqlite',
        sessionDir: '/private/pi-sessions',
        macosKeychainPath: '/Users/test/Library/Keychains/login.keychain-db',
      },
    });
    const task: TaskOfferPayload = {
      ...baseTask,
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
    };

    const ctx = await makeCtx();
    const session = await startAdapter(adapter, task, ctx);
    openSessions.push(session);

    expect(calls).toEqual([{
      command: '/opt/byok-pi-provider-launcher',
      args: [
        '--pi-bin',
        FIXTURE_PATH,
        '--profile-db',
        '/private/providers.sqlite',
        '--session-dir',
        '/private/pi-sessions',
        '--macos-keychain-path',
        '/Users/test/Library/Keychains/login.keychain-db',
        '--provider',
        'openai',
        '--model',
        'gpt-5.2',
        '--runtime-entry', 'pi-rpc',
        '--pi-cwd', await fs.realpath(ctx.workspaceDir),
        '--pi-projection-dir', expect.any(String),
      '--pi-config-digest', expect.stringMatching(/^[0-9a-f]{64}$/),
        '--',
        '--config', expect.any(String),
        '--mode',
        'rpc',
      ],
    }]);
  });

  // A single-file/SEA product re-enters its own executable for Pi, the same
  // way it does for every other SDK-reserved helper. No installed Pi package
  // is resolved.
  it('re-enters the product executable through the reserved helper in the ordinary lane', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      calls.push({ command, args: [...args] });
      return realSpawn(FIXTURE_PATH, args.slice(2), options);
    }) as never;
    const adapter = new PiAdapter({
      resolveBin: () => { throw new Error('a single-file product resolves no installed Pi package'); },
      spawnFn,
      sdkHelperHost: { mode: 'self-executable' },
    });
    const ctx = await makeCtx({ ...process.env, PI_PACKAGE_DIR: PRODUCT_ASSETS });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['__byok_sdk_helper', 'pi-rpc', expect.stringMatching(/^--config-digest=[0-9a-f]{64}$/)]);
    expect(calls[0]?.args.slice(3)).toEqual(['--config', expect.any(String), '--mode', 'rpc']);
  });

  it('re-enters the product executable through the reserved helper in the BYOK keys lane', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      calls.push({ command, args: [...args] });
      return realSpawn(FIXTURE_PATH, args.slice(args.indexOf('--') + 1), options);
    }) as never;
    const adapter = new PiAdapter({
      resolveBin: () => { throw new Error('a single-file product resolves no installed Pi package'); },
      spawnFn,
      sdkHelperHost: { mode: 'self-executable', executable: '/product/runtime', entry: '/product/release/sdk.js' },
      byokLauncher: { command: '/opt/byok-pi-provider-launcher', profileDbPath: '/private/providers.sqlite', sessionDir: '/private/pi-sessions' },
    });
    const task: TaskOfferPayload = { ...baseTask, dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'openai', modelId: 'gpt-5.2' } };
    const ctx = await makeCtx({ ...process.env, PI_PACKAGE_DIR: PRODUCT_ASSETS });
    const session = await startAdapter(adapter, task, ctx);
    openSessions.push(session);
    const args = calls[0]?.args ?? [];
    expect(calls[0]?.command).toBe('/opt/byok-pi-provider-launcher');
    expect(args.slice(0, 2)).toEqual(['--pi-bin', '/product/runtime']);
    expect(args.slice(args.indexOf('--pi-entry'), args.indexOf('--pi-entry') + 4))
      .toEqual(['--pi-entry', '/product/release/sdk.js', '--pi-fixed-args', JSON.stringify(['__byok_sdk_helper', 'pi-rpc'])]);
  });

  it('reports the bundled Pi pin for a single-file product without a version child', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => { throw new Error('a single-file product resolves no installed Pi package'); },
      sdkHelperHost: { mode: 'self-executable' },
    });
    vi.stubEnv('PI_PACKAGE_DIR', PRODUCT_ASSETS);
    await expect(adapter.detect()).resolves.toMatchObject({ kind: 'available', version: resolvePiRuntimeIdentity().version });
    expect(() => new PiAdapter({ sdkHelperHost: { mode: 'self-executable', executable: 'relative' } })).toThrow(/absolute executable path/);
  });

  // L3: an asset root without the SDK manifest is reported early, not as an
  // opaque ENOENT inside the Pi child.
  it('reports a single-file product without its Pi asset manifest as not-found and refuses its launch with the reason', async () => {
    const bundle = new PiAdapter({ sdkHelperHost: { mode: 'self-executable', executable: process.execPath, entry: '/product/sdk.js' } });
    vi.stubEnv('PI_PACKAGE_DIR', '');
    await expect(bundle.detect()).resolves.toEqual({ kind: 'not-found' });
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-empty-pi-assets-'));
    try {
      vi.stubEnv('PI_PACKAGE_DIR', empty);
      await expect(bundle.detect()).resolves.toEqual({ kind: 'not-found' });
      const compiled = new PiAdapter({ sdkHelperHost: { mode: 'self-executable', executable: path.join(empty, 'product') } });
      vi.stubEnv('PI_PACKAGE_DIR', '');
      await expect(compiled.detect()).resolves.toEqual({ kind: 'not-found' });
    } finally { await fs.rm(empty, { recursive: true, force: true }); }
    const prepared = await bundle.prepare({ offer: { instruction: 'Never sent' }, descriptor: bundle.descriptor, requiredToolsetIds: [] });
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    await expect(prepared.operation.resolveRuntimeLaunch!({ kind: 'instruction', cwd: os.tmpdir(), env: {}, projectionRoot: path.join(os.tmpdir(), 'byok-unused-projections') }))
      .rejects.toMatchObject({ name: 'RuntimeExecutionFailure', phase: 'start', message: 'pi_bundled_assets_unavailable: an interpreter + bundle product must set PI_PACKAGE_DIR to its Pi asset root' });
  });

  it('validates the BYOK launcher at construction before prepare or spawn', () => {
    const spawnFn = (() => {
      throw new Error('spawn must not be reached');
    }) as never;
    const baseLauncher = {
      command: '/opt/byok-pi-provider-launcher',
      profileDbPath: '/private/providers.sqlite',
      sessionDir: '/private/pi-sessions',
    };

    expect(() => new PiAdapter({
      spawnFn,
      byokLauncher: { ...baseLauncher, macosKeychainPath: 'login.keychain-db' },
    })).toThrow(/macosKeychainPath must be an absolute path/);
    expect(() => new PiAdapter({
      spawnFn,
      byokLauncher: { ...baseLauncher, macosKeychainPath: '' },
    })).toThrow(/macosKeychainPath must be a non-empty single-line string/);
    expect(() => new PiAdapter({
      spawnFn,
      byokLauncher: { ...baseLauncher, macosKeychainPath: '/private/login\n.keychain-db' },
    })).toThrow(/macosKeychainPath must be a non-empty single-line string/);
    // Every reserved flag, not just the one: `--runtime-entry` is what selects
    // the delegated-argv grammar the keys launcher applies, so a host-supplied
    // copy of it would decide whether a prepared host or an rpc child is
    // parented — the same class of override as `--pi-bin` or `--provider`.
    for (const reserved of [
      '--', '--pi-bin', '--pi-entry', '--pi-cwd', '--pi-projection-dir', '--pi-config-digest',
      '--runtime-entry', '--profile-db', '--session-dir', '--macos-keychain-path',
      '--secret-service-prefix', '--provider', '--model', '--profile-revision',
      '--profile-hash', '--required-capabilities', '--validate-only',
    ]) {
      expect(() => new PiAdapter({
        spawnFn,
        byokLauncher: { ...baseLauncher, args: [reserved, '/private/other.value'] },
      })).toThrow(new RegExp(`reserved launcher argument ${reserved}`));
    }
  });

  it('fails closed before spawn when a BYOK selection has no credential launcher', async () => {
    const task: TaskOfferPayload = {
      ...baseTask,
      dispatchSelection: {
        lane: 'byok',
        runtimeId: 'pi',
        providerId: 'openai',
        modelId: 'gpt-5.2',
      },
    };
    await expect(startAdapter(fakePiAdapter(), task, await makeCtx())).rejects.toThrow(
      /requires a configured credential-custody launcher/,
    );
  });

  it('FAKE_PI_ARTIFACT_NAME drives a >64KB file write + an artifact AgentEvent (M1-4 blob-path e2e fixture)', async () => {
    const adapter = fakePiAdapter();
    const artifactName = 'big-artifact.bin';
    const size = 70000; // > the 64KB inline-artifact limit
    const ctx = await makeCtx({
      ...process.env,
      FAKE_PI_ARTIFACT_NAME: artifactName,
      FAKE_PI_ARTIFACT_SIZE: String(size),
    });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 7);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' }, toolCallId: 'call_1' },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] } }, toolCallId: 'call_1', isError: false,
      },
      { type: 'tool_use', tool: 'write', input: { path: artifactName, content: `<${size} bytes written by fake-pi>` }, toolCallId: 'call_artifact' },
      {
        type: 'tool_result',
        tool: 'write',
        output: { result: { content: [{ type: 'text', text: `Successfully wrote ${size} bytes to ${artifactName}` }] } }, toolCallId: 'call_artifact', isError: false,
      },
      { type: 'artifact', name: artifactName, contentType: 'application/octet-stream' },
      { type: 'progress', text: 'Hello ' },
      { type: 'progress', text: 'world' },
    ]);

    const written = await fs.readFile(path.join(ctx.workspaceDir, artifactName));
    expect(written.length).toBe(size);
  });

  it('FAKE_PI_HANG_AFTER_TOOL keeps the session Running past the tool call; interrupt()+close() still tear it down cleanly (M1-4 cancel-path e2e fixture)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_HANG_AFTER_TOOL: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 2);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' }, toolCallId: 'call_1' },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] } }, toolCallId: 'call_1', isError: false,
      },
    ]);

    // No turn_end ever arrives on its own — the daemon's cancel path doesn't
    // wait on it; interrupt() (best-effort) + close() (SIGTERM) must still
    // resolve cleanly, exactly as `TaskRunner.handleCancel`/`finish` rely on.
    await expect(session.interrupt()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('start() with no sessionRef resolves pi\'s real minted session id via get_state (not a locally-generated UUID)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_SESSION_ID: 'fixture-minted-session-xyz' });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    expect(session.sessionRef).toBe('fixture-minted-session-xyz');
  });

  it('fails closed (never a fabricated UUID) when get_state cannot yield an authoritative session id (finding F8)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_GET_STATE_FAIL: '1' });
    await expect(startAdapter(adapter, baseTask, ctx)).rejects.toThrow(/did not yield an authoritative session id/);
  });

  it('emits the native retry diagnostic, then terminates with typed semantic non-retryable failure', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_AUTO_RETRY_FAIL: '1' });
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);
    const iterator = session.events[Symbol.asyncIterator]();
    const events = [];
    let failure: unknown;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
      }
    } catch (error) {
      failure = error;
    }
    expect(events).toContainEqual({ type: 'error', message: 'provider still unavailable' });
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ phase: 'run', category: 'semantic', retry: 'non-retryable' });
  });

  it('a task.offer carrying a known sessionRef resumes it via the real `--session <id>` flag', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_SESSION_ID: 'resume-me-123' });
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'resume-me-123' };
    const session = await startAdapter(adapter, task, ctx);
    openSessions.push(session);
    expect(session.sessionRef).toBe('resume-me-123');
  });

  it('an unresolvable sessionRef surfaces pi\'s real resume rejection as a clean start() failure, not a hang (empirically confirmed against real pi: "No session found matching ...", exit 1)', async () => {
    const adapter = fakePiAdapter();
    // FAKE_PI_SESSION_ID defaults to 'fake-session-1' — this ref never matches it.
    const ctx = await makeCtx();
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'some-other-unknown-id' };
    await expect(startAdapter(adapter, task, ctx)).rejects.toThrow(/No session found matching/);
  });

  it('interrupt() sends abort and the fake pi settles afterward', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    await takeEvents(session, 5); // drain the initial prompt's events first
    await expect(session.interrupt()).resolves.toBeUndefined();

    const postAbort = await takeEvents(session, 2);
    expect(postAbort).toEqual([{ type: 'usage', contextTokens: 0, contextWindow: 1000000, contextSource: 'estimate' }, { type: 'turn_end' }]);
  });

  it('surfaces a missing-API-key rejection from the initial prompt as a clean start() failure', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_NO_KEY: '1' });
    await expect(startAdapter(adapter, baseTask, ctx)).rejects.toThrow(/No API key found/);
  });

  it('carries the session cwd for a task whose only MCP server is a reserved SDK helper', async () => {
    // The reserved helpers (memory, messaging) are MCP server children like
    // any projected toolset server, and pi's own extension opens them from
    // this config — so the cwd has to be in the file even when the device
    // projected no host toolset at all.
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawnFn = ((_command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      calls.push({ args: [...args], env: options?.env ?? {} });
      return realSpawn(FIXTURE_PATH, args, options);
    }) as never;
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn,
    });
    const ctx = await makeCtx();
    ctx.mcpServers = { byokagentmemory: { command: '/opt/byok-agent-memory-mcp' } };

    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    const configPath = calls[0]?.args[calls[0]!.args.indexOf('--config') + 1];
    if (typeof configPath !== 'string') throw new Error('missing pi mcp config path');
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).mcp).toMatchObject({
      mcpServers: { byokagentmemory: { command: '/opt/byok-agent-memory-mcp' } },
      // `mcp-extension.ts` refuses to open any server without this and passes
      // it straight to `spawn` as the child's cwd (`pi-mcp-launch-cwd.test.ts`
      // reads it back out of a real child). It is the session cwd, as in OAR.
      launchCwd: ctx.workspaceDir,
    });

    await session.close();
    openSessions.splice(openSessions.indexOf(session), 1);
  });

  it('loads bundled web access, subagents, and an isolated task-scoped MCP config, then removes the config on close', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawnFn = ((_command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
      calls.push({ args: [...args], env: options?.env ?? {} });
      return realSpawn(FIXTURE_PATH, args, options);
    }) as never;
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn,
    });
    const ctx = await makeCtx();
    ctx.mcpServers = {
      docs: { command: '/opt/docs-mcp', args: ['--readonly'], env: { BYOK_AGENT_MESSAGE_CONTEXT: 'sealed-context' } },
    };
    ctx.mcpToolsetTools = observationOf({ docs: ['search_docs'] });

    const session = await startAdapter(adapter, baseTask, ctx);
    openSessions.push(session);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      expect.stringMatching(/^--config-digest=[0-9a-f]{64}$/),
      '--config', expect.any(String),
      '--mode',
      'rpc',
    ]);
    const configPath = calls[0]?.args[calls[0]!.args.indexOf('--config') + 1];
    expect(typeof configPath).toBe('string');
    expect(calls[0]?.env.BYOK_PI_PERMISSION_MODE).toBeUndefined();
    // The daemon's observation travels WITH the servers: the extension
    // registers exactly these tools and discovers none of its own.
    expect(JSON.parse(await fs.readFile(configPath as string, 'utf8')).mcp).toEqual({
      mcpEnv: projectPiMcpEnvironment(ctx.env),
      mcpServers: {
        docs: { command: '/opt/docs-mcp', args: ['--readonly'], env: { BYOK_AGENT_MESSAGE_CONTEXT: 'sealed-context' } },
      },
      observation: observationOf({ docs: ['search_docs'] }),
      // pi's own extension opens these servers, so the operator's
      // command/args are untouched and the session cwd travels beside them —
      // it reaches `spawn` as `cwd`.
      launchCwd: ctx.workspaceDir,
    });

    await session.close();
    openSessions.splice(openSessions.indexOf(session), 1);
    await expect(fs.access(configPath as string)).rejects.toThrow();
  });

  it('fails non-retryably when the tool observation drifts between prepare() and start()', async () => {
    // pi bakes no grant into a CLI argument — the task-scoped MCP config the
    // extension registers from IS the grant — so without a re-check at start()
    // a caller could hand start() a widened observation and the child would
    // register tools nobody admitted this task for. The refusal lands before
    // the config is written and before anything is spawned.
    const calls: string[][] = [];
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'env' }),
      spawnFn: ((_command: string, args: string[]) => {
        calls.push([...args]);
        throw new Error('spawn must not be reached');
      }) as never,
    });
    const ctx = await makeCtx();
    ctx.mcpServers = { docs: { command: '/opt/docs-mcp' } };
    ctx.mcpToolsetTools = observationOf({ docs: ['search_docs'] });
    ctx.startMcpToolsetTools = observationOf({ docs: ['search_docs', 'peek_docs'] });

    await expect(startAdapter(adapter, baseTask, ctx)).rejects.toMatchObject({
      category: 'authority',
      retry: 'non-retryable',
      message: expect.stringContaining('different MCP toolset tool authority'),
    });
    // The widened observation never reached a process.
    expect(calls).toHaveLength(0);
  });

  it('consumes the daemon observation, like every other toolset-capable adapter', () => {
    // Pi registers one tool per observed MCP tool with that tool's real
    // schema, so it needs the observation the daemon takes before admission.
    expect(fakePiAdapter().descriptor.requiresMcpToolsetToolObservation).toBe(true);
  });

  it('rejects an ungrantable projected server name before anything is spawned', async () => {
    // claude and codex refuse this in prepare() because they interpolate the
    // name into a CLI grant. pi refuses it for its own reason: the projection
    // the extension registers from applies the same name rule, so the failure
    // would otherwise land at extension load inside an already-claimed task's
    // child, where only its stderr carries the message.
    const adapter = new PiAdapter({
      resolveBin: () => { throw new Error('resolveBin must not be reached'); },
      spawnFn: (() => { throw new Error('spawn must not be reached'); }) as never,
    });
    const offer: TaskOfferPayload = { ...baseTask };
    const rejection = await adapter.prepare({
      offer,
      descriptor: adapter.descriptor,
      requiredToolsetIds: ['docs'],
      mcpServers: { 'docs.read.v1': { command: '/opt/docs-mcp' } },
      mcpToolsetTools: observationOf({ 'docs.read.v1': ['search_docs'] }),
    });
    expect(rejection).toMatchObject({
      kind: 'reject',
      retryable: false,
      reason: expect.stringMatching(/pi adapter cannot register projected MCP toolset tools/u),
    });
    expect((rejection as { reason: string }).reason).toMatch(/docs\.read\.v1/u);
  });

  it('rejects a projected server the daemon never observed, before anything is spawned', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => { throw new Error('resolveBin must not be reached'); },
      spawnFn: (() => { throw new Error('spawn must not be reached'); }) as never,
    });
    const offer: TaskOfferPayload = { ...baseTask };
    const rejection = await adapter.prepare({
      offer,
      descriptor: adapter.descriptor,
      requiredToolsetIds: ['docs'],
      mcpServers: { docs: { command: '/opt/docs-mcp' } },
    });
    // The extension refuses to discover a projected server's tools itself; the
    // adapter must not hand it a task that can only end that way.
    expect(rejection).toMatchObject({ kind: 'reject', retryable: false });
    expect((rejection as { reason: string }).reason).toMatch(/no tools\/list observation/u);
  });

  it('accepts a toolset offer and hands the observation to the extension', async () => {
    const adapter = fakePiAdapter();
    const offer: TaskOfferPayload = { ...baseTask };
    await expect(adapter.prepare({
      offer,
      descriptor: adapter.descriptor,
      requiredToolsetIds: ['docs'],
      mcpServers: { docs: { command: '/opt/docs-mcp' } },
      mcpToolsetTools: observationOf({ docs: ['search_docs'] }),
    })).resolves.toMatchObject({ kind: 'prepared' });
  });

  it('prepares a valid blob-ref without fetching it; TaskRunner resolves its string after claim', async () => {
    const adapter = fakePiAdapter();
    const task: TaskOfferPayload = {
      ...baseTask,
      instruction: { blobRef: { blobId: 'b1', contentHash: `sha256:${'0'.repeat(64)}`, size: 10, contentType: 'text/plain' } },
    };
    await expect(adapter.prepare({
      offer: task,
      descriptor: adapter.descriptor,
      requiredToolsetIds: [],
    })).resolves.toMatchObject({ kind: 'prepared' });
  });

  it('descriptor advertises exactly what the adapter can express', () => {
    const adapter = fakePiAdapter();
    expect(adapter.descriptor.capabilities).toEqual({
      steer: true,
      resume: true,
      mcpToolsets: true,
      // S0/H-002: pi has no needs_approval notion at all
      // (`PiSession.resolveApproval` throws unconditionally).
      approvalInteractive: false,
    });
  });
});

describe('PiAdapter against the pinned package runtime (no network/API key required)', () => {
  it('detect() reads back the pinned executable version', async () => {
    const adapter = new PiAdapter();
    const result = await adapter.detect();
    // The pin is an npm alias onto the SDK's Pi fork, so the executable reports
    // the fork's own version; the client manifest is the one authority for it.
    expect(result).toMatchObject({ kind: 'available', version: resolvePiRuntimeIdentity().version });
  });
});

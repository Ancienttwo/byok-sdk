import type { RuntimeTaskInput } from '../types';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { CodexAdapter, codexProbeTimeouts } from '../adapters/codex/codex-adapter';
import { observeAdmissionDetection } from '../runtime-detection';
import { createCodexAgentHome } from '../adapters/codex/agent-user-context';
import * as ownedRuntimeHome from '../adapters/owned-runtime-home';
import type { Session, MessageDraftDelta } from '../types';
import {
  RuntimeExecutionFailure,
  RuntimeDisposalFailure,
  RuntimeStartupDisposalFailure,
  projectRuntimeBoundaryFailure,
} from '../runtime-failure';
import { TASK_FAIL_REASON_MAX_BYTES, createEnvelope, decodeEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import {
  startPreparedOperation,
  type PreparedOperationResources,
} from './fixtures/prepared-operation';
import * as processTree from '../adapters/process-tree';
import { observationOf } from './fixtures/mcp-observation';
import { captureProcessIdentity, expectProcessNotLive } from './support/process-liveness';
import { CodexProjection } from '../adapters/codex/projection';
import * as vendoredProjection from '../../vendor/oar/19ccd9a/runtimes/codex/projection';

const CODEX_TARGET = { lane: 'harness', harnessId: 'codex', selection: { mode: 'device-default' } } as const;
const SUBSCRIPTION_TARGET = { lane: 'harness', harnessId: 'codex', selection: { mode: 'subscription', modelId: 'wanted' } } as const;
const fixture = fileURLToPath(
  new URL('./fixtures/fake-codex.mjs', import.meta.url),
);
const sessions: Session[] = [];
const dirs: string[] = [];
const task: RuntimeTaskInput = { target: CODEX_TARGET,
  instruction: 'hello',
};
function adapter(options: ConstructorParameters<typeof CodexAdapter>[0] = {}) {
  return new CodexAdapter({
    resolveBin: () => ({ command: fixture, source: 'path' }),
    ...options,
  });
}
async function ctx(
  env: NodeJS.ProcessEnv = {},
): Promise<PreparedOperationResources> {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'byok-codex-app-'),
  );
  dirs.push(workspaceDir);
  return {
    workspaceDir,
    env: { PATH: process.env.PATH, HOME: os.homedir(), ...env },
  };
}
async function open(
  a = adapter(),
  offer = task,
  resources?: PreparedOperationResources,
) {
  const session = await startPreparedOperation(
    a,
    offer,
    resources ?? (await ctx()),
  );
  sessions.push(session);
  return session;
}
/** Records the pid of each app-server the adapter spawns. */
function tracked() {
  const pids: number[] = [];
  const spawnFn = ((cmd: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    const child = spawn(cmd, args, options);
    if (child.pid !== undefined) pids.push(child.pid);
    return child;
  }) as typeof spawn;
  return { pids, spawnFn };
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
async function turn(s: Session) {
  const out: Array<AgentEvent | MessageDraftDelta> = [];
  for await (const e of s.events) {
    out.push(e);
    if (e.type === 'turn_end') break;
  }
  return out;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    await fs.rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('Codex persistent app-server adapter', () => {
  it('detects the pinned version, app-server and native auth', async () => {
    expect(await adapter().detect()).toEqual({
      kind: 'available',
      version: 'codex-cli 0.169.0',
      authPresent: true,
      sessionCapabilities: { images: true, steer: true },
      executablePath: fixture,
      executableSource: 'config',
      versionVerdict: { state: 'allow', qualifiedVersion: '0.169.0' },
    });
  });
  it('keeps not-logged-in detection honest', async () => {
    vi.stubEnv('FAKE_CODEX_LOGGED_IN', '0');
    expect(await adapter().detect()).toMatchObject({
      kind: 'available',
      authPresent: false,
    });
  });
  it.each([
    ['codex-cli 0.160.0', 'Logged in using an API key - sk-placeholder'],
    ['codex-cli 0.164.0', 'API key configured - sk-placeholder\nAuthentication is checked when you send a request.'],
  ])('detects configured API-key auth for %s from the successful status exit', async (version, output) => {
    vi.stubEnv('FAKE_CODEX_VERSION', version);
    vi.stubEnv('FAKE_CODEX_LOGIN_STATUS_OUTPUT', output);
    expect(await adapter().detect()).toMatchObject({
      kind: 'available',
      version,
      authPresent: true,
    });
  });
  it('keeps a failed login status unauthenticated regardless of its display text', async () => {
    vi.stubEnv('FAKE_CODEX_LOGGED_IN', '0');
    vi.stubEnv('FAKE_CODEX_LOGIN_STATUS_OUTPUT', 'Logged in using ChatGPT');
    expect(await adapter().detect()).toMatchObject({
      kind: 'available',
      authPresent: false,
    });
  });
  it('declares steer, resume, no interactive approval and YOLO-only auto', () => {
    expect(adapter().descriptor.capabilities).toEqual({
      steer: true,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
      messageDraft: true,
      preparedLane: false,
      isolation: { userInstructions: false, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false, userMcpServers: false, sessionPersistence: false },
    });
    // Codex reads MCP tools itself; the daemon takes no tools/list observation for it.
    expect(adapter().descriptor.requiresMcpToolsetToolObservation).not.toBe(true);
  });
  it.each(['codex-cli 0.161.0', 'codex-cli 1.0.0', 'codex-cli 0.159.1', 'codex-cli 0.169.0-alpha.1', 'codex 0.161.0'])('detect admits unqualified version %j with a warn verdict, never a refusal', async (output) => {
    vi.stubEnv('FAKE_CODEX_VERSION', output);
    expect(await adapter().detect()).toMatchObject({
      kind: 'available',
      version: output,
      versionVerdict: { state: 'warn', qualifiedVersion: '0.169.0' },
    });
  });
  it.each([
    ['0.47.0', [], 'prepared'],
    ['0.47.0', ['host-tools'], 'reject'],
    ['0.48.0-rc.1', ['host-tools'], 'reject'],
    ['0.48.0', ['host-tools'], 'prepared'],
  ] as const)('applies the toolset floor to Codex %s with required toolsets %j', async (version, requiredToolsetIds, kind) => {
    vi.stubEnv('FAKE_CODEX_VERSION', `codex-cli ${version}`);
    const runtime = adapter();
    const result = await runtime.prepare({
      offer: { target: CODEX_TARGET, instruction: 'hello' },
      descriptor: runtime.descriptor,
      requiredToolsetIds,
    });
    expect(result.kind).toBe(kind);
    if (result.kind === 'reject') expect(result.reason).toContain('codex_mcp_tool_allowlist_unsupported: task MCP tools require Codex CLI 0.48.0 or later');
  });
  it('detect admits the qualified version with an allow verdict', async () => {
    expect(await adapter().detect()).toMatchObject({
      kind: 'available', version: 'codex-cli 0.169.0',
      versionVerdict: { state: 'allow', qualifiedVersion: '0.169.0' },
    });
  });
  it('keeps the Host policy as the whole effective descriptor policy, replacing the default', async () => {
    const versionPolicy = {
      qualifiedVersion: '0.169.0',
      unqualified: 'allow' as const,
      block: [{ kind: 'exact' as const, version: '0.161.0' }],
    };
    const host = adapter({ versionPolicy });
    expect(host.descriptor.versionPolicy).toEqual(versionPolicy);
    expect(host.descriptor.versionPolicy).not.toHaveProperty('warn');
    expect(adapter().descriptor.versionPolicy).toEqual({ qualifiedVersion: '0.169.0', unqualified: 'warn' });
    vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.161.0');
    expect(await host.detect()).toMatchObject({
      versionVerdict: { state: 'block', qualifiedVersion: '0.169.0', matched: '0.161.0' },
    });
  });
  it.each([
    ['codex-cli 0.47.0', 'reject'],
    ['codex-cli 0.48.0-alpha.1', 'reject'],
    ['codex-cli 0.48.0', 'prepared'],
    ['codex-cli development', 'reject'],
  ])('applies the MCP allowlist floor at prepare for %s', async (version, kind) => {
    vi.stubEnv('FAKE_CODEX_VERSION', version);
    const runtime = adapter();
    const prepare = { offer: task, descriptor: runtime.descriptor };
    const required = await runtime.prepare({ ...prepare, requiredToolsetIds: ['receipt'] });
    expect(required.kind).toBe(kind);
    if (kind === 'reject') {
      expect(required).toEqual({ kind: 'reject', retryable: false,
        reason: 'codex_mcp_tool_allowlist_unsupported: task MCP tools require Codex CLI 0.48.0 or later' });
    }
    expect(await runtime.prepare({ ...prepare, requiredToolsetIds: [] })).toMatchObject({ kind: 'prepared' });
  });
  it.skipIf(process.platform === 'win32')('opens the executable probed during prepare even when the start PATH differs', async () => {
    const resources = await ctx();
    const probedDir = path.join(resources.workspaceDir, 'probed');
    const startDir = path.join(resources.workspaceDir, 'start');
    const probed = path.join(probedDir, 'codex');
    await fs.mkdir(probedDir);
    await fs.mkdir(startDir);
    await fs.symlink(fixture, probed);
    await fs.writeFile(path.join(startDir, 'codex'), '#!/bin/sh\nexit 86\n', { mode: 0o755 });
    const runtimePath = process.env.PATH ?? '';
    vi.stubEnv('BYOK_CODEX_BIN', 'codex');
    vi.stubEnv('PATH', `${probedDir}:${runtimePath}`);
    const commands: string[] = [];
    const spawnFn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      commands.push(command);
      return spawn(command, args, options);
    }) as typeof spawn;
    const runtime = new CodexAdapter({ runtimeEnvironment: { base: 'allowlist' }, spawnFn });
    resources.env.PATH = `${startDir}:${runtimePath}`;
    resources.mcpServers = { host: { command: '/fixture/server' } };
    expect((await turn(await open(runtime, task, resources))).at(-1)).toEqual({ type: 'turn_end' });
    expect(commands).toEqual([probed]);
  });
  const prepareInput = (runtime: CodexAdapter) => ({ offer: { target: CODEX_TARGET, instruction: 'hello' }, descriptor: runtime.descriptor, requiredToolsetIds: [] });
  it('#2468: an `app-server --help` past its deadline is a timeout in detect and a retryable prepare refusal', async () => {
    vi.stubEnv('FAKE_CODEX_APP_SERVER_HELP_HANG', '1');
    const runtime = adapter();
    codexProbeTimeouts.override(runtime, { appServerHelp: 200 });
    expect(await runtime.detect()).toEqual({ kind: 'timeout' });
    expect(await runtime.prepare(prepareInput(runtime)))
      .toEqual({ kind: 'reject', reason: 'codex installation refused: timeout', retryable: true });
  });
  it('#2468: aborting prepare() stops its hung installation probe with the abort reason', async () => {
    const pidFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-probe-')), 'pid');
    dirs.push(path.dirname(pidFile));
    vi.stubEnv('FAKE_CODEX_APP_SERVER_HELP_HANG', '1');
    vi.stubEnv('FAKE_CODEX_HANG_PID_FILE', pidFile);
    const runtime = adapter();
    const controller = new AbortController();
    const pending = runtime.prepare({ ...prepareInput(runtime), signal: controller.signal });
    const pid = await vi.waitFor(async () => {
      const value = Number(await fs.readFile(pidFile, 'utf8'));
      expect(value).toBeGreaterThan(0);
      return value;
    }, { timeout: 5_000 });
    const child = captureProcessIdentity(pid);
    const reason = new Error('offer cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expectProcessNotLive(child));
  });
  it('#2468: a `login status` past its deadline is a timeout in detect, and prepare does not run it again', async () => {
    vi.stubEnv('FAKE_CODEX_LOGIN_HANG', '1');
    const runtime = adapter();
    codexProbeTimeouts.override(runtime, { authStatus: 200 });
    expect(await runtime.detect()).toEqual({ kind: 'timeout' });
    // A 60 s hang would exceed the per-test timeout if prepare() ran `login status`.
    codexProbeTimeouts.override(runtime, { authStatus: 60_000 });
    expect(await runtime.prepare(prepareInput(runtime))).toMatchObject({ kind: 'prepared' });
  });
  it('#2469: detect(signal) rethrows a pre-aborted reason and stops a hung `login status` on abort', async () => {
    const reason = new Error('doctor cancelled');
    await expect(adapter().detect(AbortSignal.abort(reason))).rejects.toBe(reason);
    // Even with no codex to find: the abort wins over `not-found`.
    await expect(adapter({ resolveBin: () => ({ command: 'byok-no-such-codex', source: 'path' }) }).detect(AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(adapter().prepare({ ...prepareInput(adapter()), signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const pidFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-login-')), 'pid');
    dirs.push(path.dirname(pidFile));
    vi.stubEnv('FAKE_CODEX_LOGIN_HANG', '1');
    vi.stubEnv('FAKE_CODEX_HANG_PID_FILE', pidFile);
    const controller = new AbortController();
    const pending = adapter().detect(controller.signal);
    const pid = await vi.waitFor(async () => {
      const value = Number(await fs.readFile(pidFile, 'utf8'));
      expect(value).toBeGreaterThan(0);
      return value;
    }, { timeout: 5_000 });
    const child = captureProcessIdentity(pid);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expectProcessNotLive(child));
  });
  it('#2469: prepare() reuses this adapter\'s admission observation once, opens its verified executable, and otherwise probes afresh', async () => {
    const log = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-probes-')), 'probes');
    dirs.push(path.dirname(log));
    vi.stubEnv('FAKE_CODEX_PROBE_LOG', log);
    const probes = async () => {
      const lines = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      await fs.rm(log, { force: true });
      return lines;
    };
    const commands: string[] = [];
    const spawnFn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      commands.push(command);
      return spawn(command, args, options);
    }) as typeof spawn;
    const runtime = adapter({ spawnFn });
    const detected = await observeAdmissionDetection(runtime);
    if (detected.kind !== 'available') throw new Error('fixture codex is unavailable');
    expect(await probes()).toEqual(['--version', 'app-server --help']);
    expect(await runtime.prepare({ ...prepareInput(runtime), detected }))
      .toMatchObject({ kind: 'prepared', detected: { version: 'codex-cli 0.169.0' } });
    expect(await probes()).toEqual([]);
    // One observation serves one prepare(): the same object again probes afresh.
    expect(await runtime.prepare({ ...prepareInput(runtime), detected })).toMatchObject({ kind: 'prepared' });
    expect(await probes()).toEqual(['--version', 'app-server --help']);
    const admitted = await observeAdmissionDetection(runtime);
    await probes();
    expect((await turn(await open(runtime, task, { ...await ctx(), detected: admitted }))).at(-1)).toEqual({ type: 'turn_end' });
    expect(commands).toEqual([fixture]);
    expect(await probes()).toEqual([]);
    // A copy, a plain object, or another adapter's observation carries no verified invocation.
    for (const forged of [{ ...admitted }, { kind: 'available', executableSource: 'config' } as const, await observeAdmissionDetection(adapter())]) {
      await probes();
      expect(await runtime.prepare({ ...prepareInput(runtime), detected: forged })).toMatchObject({ kind: 'prepared' });
      expect(await probes()).toEqual(['--version', 'app-server --help']);
    }
    // A forged observation cannot skip the version floor a fresh probe applies.
    vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.47.0');
    expect(await runtime.prepare({ ...prepareInput(runtime), requiredToolsetIds: ['receipt'], detected: { kind: 'available', version: 'codex-cli 0.169.0' } }))
      .toMatchObject({ kind: 'reject', reason: expect.stringContaining('codex_mcp_tool_allowlist_unsupported') });
    vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.169.0');
    await probes();
    expect(await runtime.prepare(prepareInput(runtime))).toMatchObject({ kind: 'prepared' });
    expect(await probes()).toEqual(['--version', 'app-server --help']);
  });
  it('detect refuses a missing app-server subcommand', async () => {
    vi.stubEnv('FAKE_CODEX_NO_APP_SERVER', '1');
    expect(await adapter().detect()).toEqual({
      kind: 'refused',
      reason: 'app_server_unavailable',
    });
  });
  it('opens a native thread and projects structured command/progress/usage before terminal', async () => {
    const s = await open();
    expect(s.sessionRef).toBe('fake-thread-1');
    const events = await turn(s);
    expect(events).toContainEqual({
      type: 'tool_use',
      tool: 'command_execution',
      toolCallId: 'cmd-1',
      input: { command: 'echo hello' },
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      tool: 'command_execution',
      toolCallId: 'cmd-1',
      output: {
        command: 'echo hello',
        aggregatedOutput: 'hello\n',
        exitCode: 0,
        status: 'completed',
      },
    });
    expect(events).toContainEqual({
      type: 'progress',
      text: 'hello from fake codex',
    });
    expect(events.slice(-2)).toEqual([
      {
        type: 'usage',
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 2,
        contextTokens: 110, contextWindow: 10000, contextSource: 'provider',
      },
      { type: 'turn_end' },
    ]);
  });
  it('passes native local image paths on prompt and steer', async () => {
    const resources = await ctx({ FAKE_CODEX_HANG: '1' });
    const receipt = path.join(resources.workspaceDir, 'images-rpc.jsonl');
    const imagePath = path.join(resources.workspaceDir, 'fixture.png');
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    await fs.writeFile(imagePath, Buffer.from(base64, 'base64'));
    resources.env.FAKE_CODEX_RPC_RECEIPT = receipt;
    const images = [{ path: imagePath, mediaType: 'image/png' }];
    const session = await open(adapter(), { ...task, images }, resources);
    await session.steer('look again', { images });
    const raw = await fs.readFile(receipt, 'utf8');
    const frames = raw.trim().split('\n').map(line => JSON.parse(line));
    for (const method of ['turn/start', 'turn/steer']) {
      expect(frames.find(frame => frame.method === method)?.params.input).toContainEqual({ type: 'localImage', path: imagePath });
    }
    expect(raw).not.toContain(base64);
  });

  it.each([undefined, 'fake-thread-1'])('applies the exact effort before prompting (resume=%s)', async sessionRef => {
    const resources = await ctx();
    const receipt = path.join(resources.workspaceDir, 'effort-rpc.jsonl');
    resources.env.FAKE_CODEX_RPC_RECEIPT = receipt;
    await turn(await open(adapter(), { ...task, effort: 'high', sessionRef }, resources));
    const frames = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const method = sessionRef ? 'thread/settings/update' : 'thread/start';
    const applied = frames.findIndex(frame => frame.method === method);
    expect(applied).toBeGreaterThanOrEqual(0);
    expect(applied).toBeLessThan(frames.findIndex(frame => frame.method === 'turn/start'));
    expect(frames[applied].params).toMatchObject(sessionRef ? { threadId: sessionRef, effort: 'high' } : { config: { model_reasoning_effort: 'high' } });
  });

  it.each([undefined, 'fake-thread-1'])('fails before prompting when Codex reports a different effort (resume=%s)', async sessionRef => {
    const resources = await ctx({ FAKE_CODEX_EFFORT_READBACK: 'low' });
    const receipt = path.join(resources.workspaceDir, 'effort-rpc.jsonl');
    resources.env.FAKE_CODEX_RPC_RECEIPT = receipt;
    await expect(open(adapter(), { ...task, effort: 'high', sessionRef }, resources)).rejects.toMatchObject({
      phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' },
    });
    expect(await fs.readFile(receipt, 'utf8')).not.toContain('turn/start');
  });

  it('uses thread/resume without migrating thread identity', async () => {
    const s = await open(adapter(), { ...task, sessionRef: 'fake-thread-1' });
    expect(s.sessionRef).toBe('fake-thread-1');
    await turn(s);
  });
  it('refuses an unresolvable resume without hanging or fabricating id', async () => {
    const failure = await open(adapter(), { ...task, sessionRef: 'absent' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({
      phase: 'start',
      retry: 'non-retryable',
      message: expect.stringContaining('no rollout found'),
    });
  });
  it('keeps an unmatched resume failure retryable infrastructure', async () => {
    const failure = await open(
      adapter(),
      { ...task, sessionRef: 'absent' },
      await ctx({ FAKE_CODEX_RESUME_ERROR_CODE: '-32000' }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({
      phase: 'start',
      retry: 'retryable',
      message: expect.stringContaining('no rollout found'),
    });
  });
  it('rejects a resumed reply with a different authoritative thread id', async () => {
    await expect(
      open(
        adapter(),
        { ...task, sessionRef: 'fake-thread-1' },
        await ctx({ FAKE_CODEX_REPORTED_THREAD_ID: 'other' }),
      ),
    ).rejects.toThrow('different thread id');
  });
  it('does not fabricate a missing thread id', async () => {
    await expect(
      open(adapter(), task, await ctx({ FAKE_CODEX_NO_THREAD_STARTED: '1' })),
    ).rejects.toThrow('no thread id');
  });
  it('startup crash gives typed failure and owned teardown', async () => {
    await expect(
      open(
        adapter(),
        task,
        await ctx({ FAKE_CODEX_CRASH_WITH_STDERR: 'crash' }),
      ),
    ).rejects.toBeInstanceOf(RuntimeExecutionFailure);
  });
  it('redacts token shapes in the app-server stderr diagnostic and bounds the wire reason (#1124)', async () => {
    const key = ['sk', 'proj', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6'].join('-');
    const stderr = `Authorization: Bearer opaqueBearerValue0123 OPENAI_API_KEY=${key} ${'e'.repeat(16 * 1024)}`;
    const failure = await open(adapter(), task, await ctx({ FAKE_CODEX_CRASH_WITH_STDERR: stderr }))
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toHaveProperty('message', expect.stringContaining('OPENAI_API_KEY=[redacted]'));
    expect(failure).not.toHaveProperty('message', expect.stringContaining(key));
    const projection = projectRuntimeBoundaryFailure(failure, 'start');
    const wire = encodeEnvelope(createEnvelope('task.fail', { reason: projection.reason, retryable: projection.retryable },
      { taskId: '7c5b6b0e-7d0b-4d5f-9b0a-2b9f8b4f0c11' }));
    expect(wire).not.toContain(key);
    expect(wire).not.toContain('opaqueBearerValue0123');
    const reason = (decodeEnvelope(wire).payload as { reason: string }).reason;
    expect(reason).toMatch(/Authorization: \[redacted\] OPENAI_API_KEY=\[redacted\] e+\u2026\[truncated \d+ bytes\]$/u);
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(TASK_FAIL_REASON_MAX_BYTES);
  });
  it.each(['in an agent message frame', 'on stderr'])('#2493: redacts MCP env values echoed %s, whatever their names, raw and encoded once or twice', async (where) => {
    const credentials = ['abc12345', '/opt/service/secret-path-123', 'long"quoted\\secret-123'] as const;
    const mcpServers = { local: { command: '/fixture/server', env: { HOST_ACCESS: credentials[0], SERVICE_REF: credentials[1], LOGIN_BLOB: credentials[2], DEBUG: '1', NODE_ENV: 'production' } } };
    const escape = (value: string) => JSON.stringify(value).slice(1, -1);
    let text: string;
    if (where === 'on stderr') {
      const echoed = JSON.stringify(mcpServers);
      const resources = { ...await ctx({ FAKE_CODEX_CRASH_WITH_STDERR: `mcp ${echoed} ${JSON.stringify(echoed)}` }), mcpServers };
      const failure = await open(adapter(), task, resources).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({ phase: 'start' });
      text = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
    } else {
      text = JSON.stringify(await turn(await open(adapter(), task, { ...await ctx({ FAKE_CODEX_ECHO_MCP: '1' }), mcpServers })));
    }
    expect(text).toContain('mcp ');
    // The serialized output adds one level of escaping over the native text, which holds up to two.
    for (const secret of credentials) {
      for (const form of [secret, escape(secret), escape(escape(secret)), escape(escape(escape(secret)))]) expect(text).not.toContain(form);
    }
    // A value under eight characters or of plain words is not redacted, so DEBUG=1 and NODE_ENV=production stay readable.
    expect(text).toMatch(/DEBUG\\*":\\*"1\\*"/);
    expect(text).toMatch(/NODE_ENV\\*":\\*"production\\*"/);
  });
  it('marks an app-server exit during the open runtime_exited, and an open it did not end unknown (#869)', async () => {
    await expect(open(adapter(), task, await ctx({ FAKE_CODEX_CRASH_WITH_STDERR: 'crash' }))).rejects.toMatchObject({
      phase: 'start', message: expect.stringMatching(/crash/), failure: { class: 'runtime_exited' },
    });
    // The kernel kills the app-server itself when the open reply has no thread id.
    await expect(open(adapter(), task, await ctx({ FAKE_CODEX_NO_THREAD_STARTED: '1' }))).rejects.toMatchObject({
      phase: 'start', message: expect.stringMatching(/no thread id/), failure: { class: 'unknown' },
    });
    await expect(open(adapter({ operationTimeoutMs: 300 }), task, await ctx({ FAKE_CODEX_HANG_BEFORE_THREAD: '1' }))).rejects.toMatchObject({
      phase: 'start', message: expect.stringMatching(/timed out/), failure: { class: 'unknown' },
    });
  });
  it('uses the sealed cwd with no exec skip-git arguments', async () => {
    const captures: string[][] = [];
    const resources = await ctx();
    const s = await open(
      adapter({
        spawnFn: ((
          cmd: string,
          args: string[],
          opts: Parameters<typeof spawn>[2],
        ) => {
          captures.push(args);
          return spawn(cmd, args, opts);
        }) as typeof spawn,
      }),
      task,
      resources,
    );
    await turn(s);
    expect(captures[0]).toContain('app-server');
    expect(captures[0]).not.toContain('exec');
    expect(captures[0]).not.toContain('--skip-git-repo-check');
  });
  it('makes the Agent home the Codex project root for a memory-reader run directory only (#317)', async () => {
    // Codex reads AGENTS.md from its project root down to cwd. Without a
    // marker in an ancestor it reads cwd only, so a reader in
    // `<home>/.byok/runs/<taskId>/` would miss the home's persona.
    const capture = async (reader: boolean): Promise<string[]> => {
      const captures: string[][] = [];
      const resources = await ctx();
      if (reader) {
        const runDir = path.join(resources.workspaceDir, '.byok', 'runs', 'reader-task');
        await fs.mkdir(runDir, { recursive: true });
        resources.reader = { canonicalHome: resources.workspaceDir };
        resources.workspaceDir = runDir;
      }
      const s = await open(
        adapter({
          spawnFn: ((cmd: string, args: string[], opts: Parameters<typeof spawn>[2]) => {
            captures.push(args);
            return spawn(cmd, args, opts);
          }) as typeof spawn,
        }),
        task,
        resources,
      );
      await turn(s);
      return captures[0]!;
    };
    const readerArgs = await capture(true);
    const markerIndex = readerArgs.indexOf('project_root_markers=[".byok"]');
    expect(markerIndex).toBeGreaterThan(0);
    expect(readerArgs[markerIndex - 1]).toBe('-c');
    expect(readerArgs.indexOf('--listen')).toBeGreaterThan(markerIndex);
    expect((await capture(false)).join(' ')).not.toContain('project_root_markers');
  });
  it('passes model in the authoritative thread/start payload, not CLI argv', async () => {
    const resources = await ctx();
    const file = path.join(resources.workspaceDir, 'rpc.jsonl');
    resources.env.FAKE_CODEX_RPC_RECEIPT = file;
    const s = await open(
      adapter(),
      {
        ...task,
        target: SUBSCRIPTION_TARGET,
      },
      resources,
    );
    await turn(s);
    const frames = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const methods = frames.map(frame => frame.method);
    expect(methods.indexOf('account/read')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('account/read')).toBeLessThan(methods.indexOf('thread/start'));
    expect(frames.find((f) => f.method === 'thread/start').params.model).toBe('wanted');
  });

  it.each(['chatgpt', 'apiKey'])('disables plugins and memories in the inherit subscription probe for a %s account', async accountType => {
    const userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-inherit-'));
    dirs.push(userHome);
    const resources = await ctx({ CODEX_HOME: userHome, FAKE_CODEX_ACCOUNT_TYPE: accountType });
    await fs.writeFile(path.join(userHome, 'config.toml'), '[features]\nplugins = true\nmemories = true\n');
    resources.agentHome = resources.workspaceDir;
    const launches: Array<{ args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    const a = adapter({ spawnFn: ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      launches.push({ args, cwd: options?.cwd as string | undefined, env: options?.env });
      return spawn(command, args, options);
    }) as typeof spawn });
    const result = open(a, { ...task, target: SUBSCRIPTION_TARGET }, resources);
    const executionArgs = ['app-server', '-c', 'sandbox_mode="danger-full-access"', '--listen', 'stdio://'];
    if (accountType === 'chatgpt') {
      await turn(await result);
      expect(launches).toHaveLength(2);
      expect(launches[1]?.args).toEqual(executionArgs);
      expect(launches[0]?.env).toEqual(launches[1]?.env);
      expect(launches[0]?.cwd).toBe(launches[1]?.cwd);
    } else {
      await expect(result).rejects.toMatchObject({ retry: 'non-retryable', failure: { class: 'invalid_request' } });
      expect(launches).toHaveLength(1);
    }
    expect(launches[0]?.args).toEqual([
      ...executionArgs.slice(0, -2), '-c', 'features.plugins=false', '-c', 'features.memories=false', ...executionArgs.slice(-2),
    ]);
    expect(launches[0]?.env?.CODEX_HOME).toBe(userHome);
    expect(launches[0]?.cwd).toBe(resources.workspaceDir);
  });

  it.each(['apiKey', 'amazonBedrock', 'absent'])('declines Codex subscription at admission for a %s account', async accountType => {
    const resources = await ctx({ FAKE_CODEX_ACCOUNT_TYPE: accountType, OPENAI_API_KEY: 'host-provider-key' });
    const receipt = path.join(resources.workspaceDir, 'admission.jsonl');
    resources.env.FAKE_CODEX_RPC_RECEIPT = receipt;
    const owned = tracked();
    await expect(open(adapter({ spawnFn: owned.spawnFn }), { ...task, target: SUBSCRIPTION_TARGET }, resources))
      .rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' } });
    const methods = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
    expect(methods).toEqual(['initialize', 'initialized', 'account/read']);
    expect(owned.pids).toHaveLength(1);
    expectProcessNotLive(owned.pids[0]!);
  });

  it('refuses a changed Codex account before opening a subscription thread', async () => {
    const resources = await ctx();
    const receipt = path.join(resources.workspaceDir, 'execution.jsonl');
    resources.env.FAKE_CODEX_RPC_RECEIPT = receipt;
    let starts = 0;
    const a = adapter({ spawnFn: ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(command, args, {
      ...options, env: { ...options?.env, FAKE_CODEX_ACCOUNT_TYPE: ++starts === 1 ? 'chatgpt' : 'apiKey' },
    })) as typeof spawn });
    await expect(open(a, { ...task, target: SUBSCRIPTION_TARGET }, resources)).rejects.toMatchObject({
      phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' },
    });
    const methods = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
    expect(methods.filter(method => method === 'account/read')).toHaveLength(2);
    expect(methods).not.toContain('thread/start');
  });
  it('followUp uses one persistent process and the same event stream', async () => {
    let starts = 0;
    const s = await open(
      adapter({
        spawnFn: ((...args: Parameters<typeof spawn>) => {
          starts++;
          return spawn(...args);
        }) as typeof spawn,
      }),
    );
    await turn(s);
    await s.followUp({ ...task, instruction: 'next' });
    expect((await turn(s)).at(-1)?.type).toBe('turn_end');
    expect(starts).toBe(1);
  });
  it('followUp rejects blob-ref input without touching the open session', async () => {
    const s = await open();
    await turn(s);
    await expect(
      s.followUp({ ...task, instruction: { blobId: 'b' } as never }),
    ).rejects.toThrow('string');
    await s.followUp({ ...task, instruction: 'valid' });
    await turn(s);
  });
  it('projection failures are typed run authority failures, not swallowed observer exceptions', async () => {
    const s = await open(
      adapter(),
      task,
      await ctx({ FAKE_CODEX_MISSING_TOOL_ID: '1' }),
    );
    await expect(turn(s)).rejects.toMatchObject({
      phase: 'run',
      retry: 'non-retryable',
    });
  });
  it('turn failure exposes error then typed semantic terminal failure', async () => {
    const s = await open(
      adapter(),
      task,
      await ctx({
        FAKE_CODEX_TURN_FAILS: '1',
        FAKE_CODEX_FAIL_MESSAGE: 'quota',
      }),
    );
    const out: Array<AgentEvent | MessageDraftDelta> = [];
    await expect(
      (async () => {
        for await (const e of s.events) out.push(e);
      })(),
    ).rejects.toMatchObject({ retry: 'non-retryable' });
    expect(out.some((e) => e.type === 'error' && e.message === 'quota')).toBe(
      true,
    );
    expect(out.some((e) => e.type === 'turn_end')).toBe(false);
  });
  it('projects the reset of a native Codex account quota window', async () => {
    const s = await open(adapter(), task, await ctx({
      FAKE_CODEX_TURN_FAILS: '1',
      FAKE_CODEX_ERROR_INFO: '"usageLimitExceeded"',
      FAKE_CODEX_QUOTA_RESET_AT: '1795068000',
    }));
    await expect(turn(s)).rejects.toMatchObject({
      phase: 'run', failure: { class: 'quota', resetsAt: '2026-11-19T06:00:00.000Z' },
    });
  });

  it('unexpected process exit closes the stream with a typed non-retryable run failure', async () => {
    const s = await open(
      adapter(),
      task,
      await ctx({ FAKE_CODEX_EXIT_NO_TERMINAL: '1' }),
    );
    await expect(turn(s)).rejects.toMatchObject({ phase: 'run', retry: 'non-retryable' });
  });
  it.each([
    ['usageLimitExceeded', '"usageLimitExceeded"', { class: 'quota' }],
    ['rateLimitExceeded', '"rateLimitExceeded"', { class: 'rate_limited' }],
    ['unauthorized', '"unauthorized"', { class: 'auth' }],
    ['a 404 transport failure', '{"responseStreamConnectionFailed":{"httpStatusCode":404}}', { class: 'model_unavailable' }],
    ['no codexErrorInfo', undefined, { class: 'unknown' }],
  ] as const)('classifies a failed turn with %s from codexErrorInfo, reason unchanged (#869)', async (_label, info, failure) => {
    const s = await open(adapter(), task, await ctx({
      FAKE_CODEX_TURN_FAILS: '1',
      FAKE_CODEX_FAIL_MESSAGE: 'provider said no',
      ...(info === undefined ? {} : { FAKE_CODEX_ERROR_INFO: info }),
    }));
    const thrown = await turn(s).then(() => undefined, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(RuntimeExecutionFailure);
    expect((thrown as RuntimeExecutionFailure).failure).toEqual(failure);
    expect((thrown as RuntimeExecutionFailure).message).toBe('provider said no');
  });
  it.each([
    ['Anthropic limit wording', { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, { class: 'unknown' }],
    ['an invalid_request_error type', { type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } }, { class: 'invalid_request' }],
    ['context overflow wording', { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } }, { class: 'unknown' }],
    ['an error code', { error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' } }, { class: 'quota' }],
    ['a structured quota reset', { error: { type: 'usage_limit_reached', resets_at: 1795068000 } }, { class: 'quota', resetsAt: '2026-11-19T06:00:00.000Z' }],
  ] as const)('classifies codexErrorInfo other with %s from the body, sending unknown for a text rule (#869)', async (_label, body, failure) => {
    const message = JSON.stringify(body);
    const s = await open(adapter(), task, await ctx({
      FAKE_CODEX_TURN_FAILS: '1',
      FAKE_CODEX_FAIL_MESSAGE: message,
      FAKE_CODEX_ERROR_INFO: '"other"',
    }));
    const thrown = await turn(s).then(() => undefined, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(RuntimeExecutionFailure);
    expect(thrown).toMatchObject({ retry: 'non-retryable', message });
    expect((thrown as RuntimeExecutionFailure).failure).toEqual(failure);
  });
  it('marks an app-server exit before the terminal runtime_exited (#869)', async () => {
    const s = await open(adapter(), task, await ctx({ FAKE_CODEX_EXIT_NO_TERMINAL: '1' }));
    await expect(turn(s)).rejects.toMatchObject({ failure: { class: 'runtime_exited' } });
  });
  it('file changes produce real workspace-relative artifacts', async () => {
    const resources = await ctx({
      FAKE_CODEX_ARTIFACT_NAME: 'result.md',
      FAKE_CODEX_ARTIFACT_CONTENT: 'content',
    });
    const s = await open(adapter(), task, resources);
    expect(await turn(s)).toContainEqual({
      type: 'artifact',
      name: 'result.md',
      contentType: 'text/markdown',
    });
    expect(
      await fs.readFile(path.join(resources.workspaceDir, 'result.md'), 'utf8'),
    ).toBe('content');
  });
  it('steer reaches the runtime with its exact active expectedTurnId', async () => {
    const resources = await ctx({ FAKE_CODEX_HANG: '1' });
    const file = path.join(resources.workspaceDir, 'rpc');
    resources.env.FAKE_CODEX_RPC_RECEIPT = file;
    const s = await open(adapter(), task, resources);
    await s.steer('redirect');
    const frames = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.find((f) => f.method === 'turn/steer')).toMatchObject({
      params: {
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'redirect' }],
      },
    });
  });
  it('interrupt performs turn/interrupt and closes outstanding tools as interrupted', async () => {
    const s = await open(adapter(), task, await ctx({ FAKE_CODEX_HANG: '1' }));
    await new Promise((r) => setTimeout(r, 30));
    await s.interrupt();
    const events = await turn(s);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        output: expect.objectContaining({ status: 'interrupted' }),
      }),
    );
  });
  it('settles an interrupt from the root when redacted root and child IDs coincide', async () => {
    const first = 'synthetic-root-api-key';
    const second = 'synthetic-child-api-key';
    const resources = await ctx({
      OPENAI_API_KEY: first, FIXTURE_TOKEN: second, FAKE_CODEX_HANG: '1',
      FAKE_CODEX_THREAD_ID: `fixture-${first}`, FAKE_CODEX_CHILD_COMPLETES_FIRST: `fixture-${second}`,
    });
    const session = await open(adapter(), task, resources);
    const events = session.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: 'tool_use' });
    await session.interrupt();
    expect((await events.next()).value).toMatchObject({ type: 'tool_result', output: { status: 'interrupted' } });
    expect((await events.next()).value).toEqual({ type: 'turn_end' });
    await events.return?.();
  });
  it.skipIf(process.platform === 'win32')('reaps the aborted turn child and keeps the attached stdio MCP process for follow-up', async () => {
    const resources = await ctx();
    const receipt = path.join(resources.workspaceDir, 'turn-processes.json');
    const audit = path.join(resources.workspaceDir, 'mcp.jsonl');
    resources.env.FAKE_CODEX_ABORT_TREE = receipt;
    resources.mcpServers = { host: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/toolset-echo-mcp.mjs', import.meta.url)), audit] } };
    // Readiness is part of thread open. The fixture receives the follow-up on the same app-server.
    const s = await open(adapter(), task, resources);
    await expect.poll(async () => fs.stat(receipt).then(() => true, () => false)).toBe(true);
    const pids = JSON.parse(await fs.readFile(receipt, 'utf8')) as { child: number; mcp: number };
    expect(gone(pids.child)).toBe(false);
    expect(gone(pids.mcp)).toBe(false);
    const child = captureProcessIdentity(pids.child);
    await s.interrupt();
    expect(await turn(s)).toContainEqual({ type: 'turn_end' });
    await vi.waitFor(() => expectProcessNotLive(child));
    expect(gone(pids.mcp)).toBe(false);
    await s.followUp(task);
    expect(await turn(s)).toContainEqual(expect.objectContaining({ type: 'tool_result', toolCallId: 'mcp-after-abort',
      output: expect.objectContaining({ result: expect.objectContaining({ content: [{ type: 'text', text: 'byok-echo:after abort' }] }) }),
    }));
    expect(gone(pids.mcp)).toBe(false);
  });
  it('late interrupt has a deadline and terminates the affected session', async () => {
    const s = await open(
      adapter({ interruptTimeoutMs: 30 }),
      task,
      await ctx({ FAKE_CODEX_HANG: '1', FAKE_CODEX_LATE_INTERRUPT: '1' }),
    );
    await expect(s.interrupt()).rejects.toThrow('late interrupt timed out');
    await expect(turn(s)).rejects.toBeInstanceOf(RuntimeExecutionFailure);
  });
  it.each([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
    'item/tool/call',
    'unrecognized',
  ])('server request %s settles without hanging', async (method) => {
    const resources = await ctx({ FAKE_CODEX_SERVER_REQUEST: method });
    const file = path.join(resources.workspaceDir, 'rpc');
    resources.env.FAKE_CODEX_RPC_RECEIPT = file;
    const s = await open(adapter(), task, resources);
    await turn(s);
    // The fixture finishes the turn without waiting for the reply, and logs
    // the reply only when it reads it from stdin, so poll the receipt.
    await vi.waitFor(async () => {
      const frames = (await fs.readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        frames.find((f) => f.id === 'server-req' && !f.method),
      ).toBeDefined();
    });
  });
  it('elides the oldest native payloads past the retention limit and keeps the session open (#1932)', async () => {
    const s = await open(adapter({ maxRetainedBytes: 1 }));
    expect((await turn(s)).at(-1)).toMatchObject({ type: 'turn_end' });
    const records = (s as unknown as { raw: { records(): readonly { body: { elided?: true } }[] } }).raw.records();
    expect(records.some(record => record.body.elided === true)).toBe(true);
  });
  it('a failing record consumer fails the session although the kernel swallows observer errors', async () => {
    const { pids, spawnFn } = tracked();
    const s = await open(adapter({ spawnFn }), task, await ctx({ FAKE_CODEX_HANG: '1' }));
    vi.spyOn(CodexProjection.prototype, 'consume').mockImplementation(() => { throw new Error('projection failed'); });
    // The fixture keeps writing the hanging turn; any later record reaches the failing consumer.
    await s.steer('next').catch(() => {});
    const failure = await turn(s).then(() => undefined, (error) => error);
    expect(failure).toMatchObject({ message: 'projection failed' });
    await s.close();
    await vi.waitFor(() => expectProcessNotLive(pids[0]!));
  });
  it('a vendored fold failure during a turn kills the app-server and keeps the fold reason, unknown (#869)', async () => {
    const { pids, spawnFn } = tracked();
    const s = await open(adapter({ spawnFn }), task, await ctx({ FAKE_CODEX_HANG: '1' }));
    vi.spyOn(vendoredProjection, 'foldCodexNotification').mockImplementation(() => { throw new Error('projection failed'); });
    await s.steer('next').catch(() => {});
    const failure = await turn(s).then(() => undefined, (error) => error);
    expect(failure).toMatchObject({ message: 'projection failed', failure: { class: 'unknown' } });
    await s.close();
    await vi.waitFor(() => expectProcessNotLive(pids[0]!));
  });
  it('a record consumer that fails on the record of an exit the app-server made on its own keeps runtime_exited (#869)', async () => {
    const consume = CodexProjection.prototype.consume;
    vi.spyOn(CodexProjection.prototype, 'consume').mockImplementation(function (this: CodexProjection, ...args: Parameters<CodexProjection['consume']>) {
      const record = args[1] as { kind: string; body: { kind?: string } };
      if (record.kind === 'response' && record.body.kind === 'exited') throw new Error('projection failed on the exit record');
      return consume.apply(this, args);
    });
    const s = await open(adapter(), task, await ctx({ FAKE_CODEX_EXIT_NO_TERMINAL: '1' }));
    await expect(turn(s)).rejects.toMatchObject({
      message: 'projection failed on the exit record', failure: { class: 'runtime_exited' },
    });
  });
  it('rejects an invalid operation timeout', () => {
    for (const operationTimeoutMs of [0, -1, Infinity, Number.NaN, 2_147_483_648])
      expect(() => adapter({ operationTimeoutMs })).toThrow('invalid Codex operation timeout');
  });
  it.each([
    ['open', { FAKE_CODEX_HANG_BEFORE_THREAD: '1' }, 300],
    ['prompt', { FAKE_CODEX_HANG_TURN_START: '1' }, 3000],
  ] as const)('fails the start and kills the app-server when the %s gets no reply within the deadline', async (operation, env, operationTimeoutMs) => {
    const { pids, spawnFn } = tracked();
    const started = Date.now();
    const error = await open(adapter({ operationTimeoutMs, spawnFn }), task, await ctx(env)).catch((caught) => caught);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({
      phase: 'start',
      retry: operation === 'open' ? 'retryable' : 'non-retryable',
      message: `codex ${operation} timed out after ${operationTimeoutMs}ms`,
    });
    expect(Date.now() - started).toBeLessThan(operationTimeoutMs + 10_000);
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => expectProcessNotLive(pids[0]!));
  });
  it('keeps the class of a failure that halted the record stream during the start (#869)', async () => {
    const consume = CodexProjection.prototype.consume;
    let failedTurnSeen = false;
    // The consumer fails on the first record after the failed turn, which has already classed the session.
    vi.spyOn(CodexProjection.prototype, 'consume').mockImplementation(function (this: CodexProjection, ...args: Parameters<CodexProjection['consume']>) {
      if (failedTurnSeen) throw new Error('projection failed');
      const result = consume.apply(this, args);
      const body = (args[1] as { body?: { origin?: string; type?: string } }).body;
      if (body?.origin === 'byok-native' && body.type === 'turn/completed') failedTurnSeen = true;
      return result;
    });
    const error = await open(adapter({ operationTimeoutMs: 3000 }), task, await ctx({
      FAKE_CODEX_FAIL_IN_START: '1',
      FAKE_CODEX_ERROR_INFO: '"usageLimitExceeded"',
    })).catch((caught) => caught);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'start', failure: { class: 'quota' } });
  });
  it('fails the session and kills the app-server when a steer gets no reply within the deadline', async () => {
    const { pids, spawnFn } = tracked();
    const s = await open(adapter({ operationTimeoutMs: 3000, spawnFn }), task, await ctx({ FAKE_CODEX_HANG: '1', FAKE_CODEX_HANG_STEER: '1' }));
    await expect(s.steer('redirect')).rejects.toThrow('codex steer timed out after 3000ms');
    await expect(turn(s)).rejects.toMatchObject({ message: 'codex steer timed out after 3000ms' });
    await s.close();
    await vi.waitFor(() => expectProcessNotLive(pids[0]!));
  });
  it('close joins a pending persistent followUp and rejects its RPC instead of leaving it hanging', async () => {
    const s = await open(
      adapter(),
      task,
      await ctx({ FAKE_CODEX_HANG_FOLLOWUP: '1' }),
    );
    await turn(s);
    const pending = s.followUp(task).catch((error) => error);
    await new Promise((r) => setTimeout(r, 30));
    await s.close();
    expect(await pending).toBeInstanceOf(RuntimeExecutionFailure);
  });
  it('failed startup retains a retryable owner until owned disposal is proven', async () => {
    const disposal = new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: 'fixture disposal failure',
    });
    const spy = vi
      .spyOn(processTree, 'disposeOwnedProcessTree')
      .mockRejectedValueOnce(disposal)
      .mockRejectedValueOnce(disposal);
    const error = await open(
      adapter(),
      task,
      await ctx({ FAKE_CODEX_NO_THREAD_STARTED: '1' }),
    ).catch((error) => error);
    try {
      expect(error).toBeInstanceOf(RuntimeStartupDisposalFailure);
    } finally {
      spy.mockRestore();
      if (error instanceof RuntimeStartupDisposalFailure)
        await error.retryDisposal();
    }
  });
  it('close is idempotent and joins the owned process receipt', async () => {
    const s = await open(adapter(), task, await ctx({ FAKE_CODEX_HANG: '1' }));
    await s.close();
    await s.close();
  });
  it('passes reserved MCP servers in the thread config, never in argv or the process env', async () => {
    const captured: string[][] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const receipt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-mcp-')), 'frames.jsonl');
    const resources = await ctx({
      FAKE_CODEX_MCP_TOOL_CALL: 'byokagentmessage/send_agent_message',
      FAKE_CODEX_RPC_RECEIPT: receipt,
    });
    resources.mcpServers = {
      byokagentmessage: {
        command: '/fixture/server',
        env: { SERVER_ONLY: 'secret' },
      },
    };
    const s = await open(
      adapter({
        spawnFn: ((
          cmd: string,
          args: string[],
          options: Parameters<typeof spawn>[2],
        ) => {
          captured.push(args);
          envs.push(options?.env ?? {});
          return spawn(cmd, args, options);
        }) as typeof spawn,
      }),
      task,
      resources,
    );
    await turn(s);
    await s.followUp(task);
    await turn(s);
    expect(captured).toHaveLength(1);
    const frames = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; params?: { config?: { mcp_servers?: unknown } } });
    expect(frames.find((frame) => frame.method === 'thread/start')?.params?.config?.mcp_servers).toEqual({
      byokagentmessage: { command: '/fixture/server', args: [], env: { SERVER_ONLY: 'secret' }, enabled: true, enabled_tools: ['send_agent_message'], tools: { send_agent_message: { approval_mode: 'approve' } } },
    });
    // Helper grants stay in thread configuration, never process arguments.
    expect(captured[0]!.some((arg) => arg.includes('mcp_servers') || arg.includes('enabled_tools') || arg.includes('approval_mode'))).toBe(false);
    expect(Object.values(envs[0]!).some((value) => value?.includes('secret'))).toBe(false);
  });
  it('opens with a projected MCP server carrying no tool grants', async () => {
    const resources = await ctx();
    resources.mcpServers = { host: { command: '/fixture/server' } };
    resources.mcpToolsetTools = observationOf({ host: ['echo'] });
    const s = await open(adapter(), task, resources);
    await turn(s);
  });
});

describe('CodexAdapter agentUserMcpServers (#935)', () => {
  // The user's effective config: a stdio server, a dotted name, a connector and a plugin.
  const USER_CONFIG = {
    model: 'user-model',
    mcp_servers: { gmail: { command: 'gmail-mcp', enabled: true }, 'notes.v2': { command: 'notes-mcp' } },
    apps: { gmail_connector: { enabled: true } },
    plugins: { 'notion@market': { enabled: true } },
  };
  const HOST = { command: process.execPath, args: ['host-mcp.js'] };
  /** An Agent writer task with one host toolset server; `rpc` lists every request the fake received. */
  async function agentCtx(env: NodeJS.ProcessEnv = {}, agent = true) {
    const resources = await ctx({ FAKE_CODEX_USER_CONFIG: JSON.stringify(USER_CONFIG), ...env });
    const home = await fs.realpath(resources.workspaceDir);
    const file = path.join(home, 'rpc.jsonl');
    resources.env.FAKE_CODEX_RPC_RECEIPT = file;
    const rpc = async () => (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(frame => frame.id !== undefined && typeof frame.method === 'string');
    return {
      resources: { ...resources, workspaceDir: home, ...(agent ? { agentHome: home } : {}), mcpServers: { host: HOST }, mcpToolsetTools: observationOf({ host: ['echo'] }) },
      rpc,
    };
  }

  it('validates the option', () => {
    expect(() => adapter({ agentUserMcpServers: 'strict' as never })).toThrow(new TypeError('CodexAdapterOptions.agentUserMcpServers must be inherit or excluded'));
  });

  it.each([undefined, 'fake-thread-1'])('disables every user server, connectors and plugins and reads the thread back (resume=%s)', async (sessionRef) => {
    const { resources, rpc } = await agentCtx();
    const s = await open(adapter({ agentUserMcpServers: 'excluded' }), { ...task, ...(sessionRef === undefined ? {} : { sessionRef }) }, resources);
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
    const frames = await rpc();
    const method = sessionRef === undefined ? 'thread/start' : 'thread/resume';
    expect(frames.map(frame => frame.method).slice(0, 4)).toEqual(['initialize', 'config/read', method, 'mcpServerStatus/list']);
    expect(frames[1].params).toEqual({ cwd: resources.workspaceDir, includeLayers: false });
    const open_ = frames[2].params;
    // The user's model and sandbox still apply: the open sets neither.
    expect(open_).not.toHaveProperty('model');
    expect(open_.config).toEqual({
      mcp_servers: { gmail: { enabled: false }, 'notes.v2': { enabled: false }, host: { command: process.execPath, args: ['host-mcp.js'], enabled: true, enabled_tools: [] } },
      features: { apps: false, plugins: false },
    });
    expect(frames[3].params).toEqual({ threadId: 'fake-thread-1', detail: 'toolsAndAuthOnly' });
  });

  it.each(['inherit', 'excluded'] as const)('refuses a task server name collision before opening the thread under %s', async (agentUserMcpServers) => {
    const { resources, rpc } = await agentCtx({ FAKE_CODEX_USER_CONFIG: JSON.stringify({ mcp_servers: { host: { command: 'user-host', tools: { echo: { approval_mode: 'approve' } } } } }) });
    const error = await startPreparedOperation(adapter({ agentUserMcpServers }), task, resources).catch(e => e);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'unknown' },
      message: 'codex_mcp_server_name_collision: user MCP servers share a name with task servers: host. Rename either server and try again.' });
    expect((await rpc()).map(frame => frame.method)).toEqual(['initialize', 'config/read']);
  });

  it('fails the start when the thread still runs a server outside the task', async () => {
    const extra = [{ name: 'codex_apps', runtimeStatus: 'connected', pluginId: null }, { name: 'gdrive', runtimeStatus: 'starting', pluginId: 'drive@market' }];
    const { resources } = await agentCtx({ FAKE_CODEX_STATUS_EXTRA: JSON.stringify(extra) });
    const error = await startPreparedOperation(adapter({ agentUserMcpServers: 'excluded' }), task, resources).catch(e => e);
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'unknown' },
      message: 'codex Agent thread still runs MCP servers outside the task: codex_apps, gdrive (plugin drive@market)' });
  });

  it('preserves unrelated user configuration under inherit and for non-Agent tasks', async () => {
    for (const [options, agent] of [[{}, true], [{ agentUserMcpServers: 'inherit' as const }, true], [{ agentUserMcpServers: 'excluded' as const }, false]] as const) {
      const { resources, rpc } = await agentCtx({}, agent);
      await turn(await open(adapter(options), task, resources));
      const frames = await rpc();
      expect(frames.map(frame => frame.method).slice(0, 3)).toEqual(['initialize', 'config/read', 'thread/start']);
      expect(frames.map(frame => frame.method)).not.toContain('mcpServerStatus/list');
      expect(frames[2].params.config).toEqual({ mcp_servers: { host: { command: process.execPath, args: ['host-mcp.js'], enabled: true, enabled_tools: [] } } });
    }
  });
});

describe('CodexAdapter agentUserContext (#1565)', () => {
  /** A user CODEX_HOME with every linked entry and the entries that stay out. */
  async function userHome() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-user-')));
    dirs.push(root);
    for (const name of ['auth.json', 'config.toml', 'hooks.json', 'AGENTS.md', 'AGENTS.override.md']) await fs.writeFile(path.join(root, name), '{}');
    for (const name of ['rules', 'skills', 'memories']) await fs.mkdir(path.join(root, name));
    return root;
  }

  it('validates the option', () => {
    expect(() => adapter({ agentUserContext: 'strict' as never })).toThrow(new TypeError('CodexAdapterOptions.agentUserContext must be inherit or excluded'));
  });

  it('runs an Agent task in an SDK home of links to the login, configuration, guardrails and the Agent\'s own thread store', async () => {
    const user = await userHome();
    const resources = await ctx({ CODEX_HOME: user, FAKE_CODEX_USER_CONFIG: JSON.stringify({ cli_auth_credentials_store: 'file' }) });
    const receipt = path.join(user, '..', `${path.basename(user)}.home.json`);
    resources.env.FAKE_CODEX_HOME_RECEIPT = receipt;
    resources.env.FAKE_CODEX_RPC_RECEIPT = `${receipt}.rpc`;
    await turn(await open(adapter({ agentUserContext: 'excluded' }), task, { ...resources, agentHome: resources.workspaceDir }));
    const { home, entries } = JSON.parse(await fs.readFile(receipt, 'utf8'));
    expect(home).not.toBe(user);
    const store = path.join(resources.workspaceDir, '.byok', 'codex');
    expect(entries).toEqual({ ...Object.fromEntries(['auth.json', 'config.toml', 'hooks.json', 'rules'].map(name => [name, path.join(user, name)])),
      sessions: path.join(store, 'sessions'), archived_sessions: path.join(store, 'archived_sessions') });
    expect(await fs.readdir(user)).not.toContain('sessions');
    const methods = (await fs.readFile(`${receipt}.rpc`, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(frame => frame.id !== undefined && typeof frame.method === 'string').map(frame => frame.method);
    expect(methods.slice(0, 3)).toEqual(['initialize', 'config/read', 'thread/start']);
  });

  it.each(['chatgpt', 'apiKey'])('starts the subscription probe under the execution isolation for a %s account', async accountType => {
    const user = await userHome();
    const resources = await ctx({ CODEX_HOME: user, FAKE_CODEX_ACCOUNT_TYPE: accountType, OPENAI_API_KEY: 'host-provider-key',
      FAKE_CODEX_USER_CONFIG: JSON.stringify({ cli_auth_credentials_store: 'file' }) });
    resources.reader = { canonicalHome: resources.workspaceDir };
    resources.workspaceDir = path.join(resources.workspaceDir, '.byok', 'runs', 'subscription');
    await fs.mkdir(resources.workspaceDir, { recursive: true });
    const launches: Array<{ args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    const a = adapter({ agentUserContext: 'excluded', agentUserMcpServers: 'excluded', sandbox: 'read-only',
      spawnFn: ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
        launches.push({ args, cwd: options?.cwd as string | undefined, env: options?.env });
        return spawn(command, args, options);
      }) as typeof spawn });
    const result = open(a, { ...task, target: SUBSCRIPTION_TARGET }, resources);
    if (accountType === 'chatgpt') {
      await turn(await result);
      expect(launches).toHaveLength(2);
      expect(launches[0]).toEqual(launches[1]);
    } else {
      await expect(result).rejects.toMatchObject({ retry: 'non-retryable', failure: { class: 'invalid_request' } });
      expect(launches).toHaveLength(1);
    }
    expect(launches[0]?.cwd).toBe(resources.workspaceDir);
    expect(launches[0]?.args).toEqual(expect.arrayContaining([
      'sandbox_mode="read-only"', 'project_root_markers=[".byok"]', 'features.plugins=false', 'features.memories=false',
    ]));
    expect(launches[0]?.env?.CODEX_HOME).toMatch(/codex-home$/u);
    expect(launches[0]?.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it('refuses a credential store other than file before the thread opens', async () => {
    const resources = await ctx({ CODEX_HOME: await userHome(), FAKE_CODEX_USER_CONFIG: JSON.stringify({ cli_auth_credentials_store: 'keyring' }) });
    const error = await startPreparedOperation(adapter({ agentUserContext: 'excluded' }), task, { ...resources, agentHome: resources.workspaceDir }).catch(e => e);
    expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable',
      message: 'codex Agent user context exclusion refused: cli_auth_credentials_store is keyring; an SDK-owned CODEX_HOME supports file credentials only' });
  });

  const refusals: ReadonlyArray<readonly [reason: string, prepare: (user: string, home: string) => Promise<unknown>, agentHome: string | undefined]> = [
    ['the task has no sealed Agent home for its thread store', async () => {}, undefined],
    ['the user CODEX_HOME does not exist', async (user: string) => fs.rm(user, { recursive: true }), 'agent-home'],
    ['the user CODEX_HOME has no auth.json; log in to Codex with file credentials first', async (user: string) => fs.rm(path.join(user, 'auth.json')), 'agent-home'],
    // An earlier task may have redirected its own store to the user's thread store.
    ...[['.byok', 'codex'], ['.byok', 'codex', 'sessions'], ...(process.platform === 'darwin' ? [['.BYOK', 'codex']] : [])].map(at => [
      'the Agent home thread store is not a real directory inside the Agent home',
      async (user: string, home: string) => {
        await fs.mkdir(path.join(user, 'sessions'));
        await fs.mkdir(path.join(home, ...at.slice(0, -1)), { recursive: true });
        await fs.symlink(at.length === 3 ? path.join(user, 'sessions') : user, path.join(home, ...at), 'dir');
      },
      'agent-home',
    ] as const),
  ];
  it.each(refusals)('refuses when %s', async (reason, remove, agentHome) => {
    const user = await userHome();
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-sdk-')));
    dirs.push(dir);
    const home = agentHome && path.join(dir, agentHome);
    if (home !== undefined) await fs.mkdir(home);
    await remove(user, home!);
    await expect(createCodexAgentHome({ CODEX_HOME: user }, dir, home)).rejects.toMatchObject({ phase: 'start', retry: 'non-retryable',
      message: `codex Agent user context exclusion refused: ${reason}` });
  });

  it('refuses on Windows when the account may not create a symbolic link', async () => {
    const user = await userHome();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-sdk-'));
    dirs.push(dir);
    vi.spyOn(fs, 'symlink').mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    await expect(createCodexAgentHome({ CODEX_HOME: user }, dir, path.join(dir, 'agent-home'), 'win32')).rejects.toMatchObject({
      message: "codex Agent user context exclusion refused: Windows refused to create a symbolic link (EPERM); turn on Developer Mode, run the daemon as an administrator, or set agentUserContext to 'inherit' on this device" });
  });

  it('refuses detection when the SDK-owned home cannot be built, probing only under excluded (#2241)', async () => {
    const probe = vi.spyOn(ownedRuntimeHome, 'ownedRuntimeHomeLinksAvailable').mockResolvedValue(false);
    expect(await adapter().detect()).toMatchObject({ kind: 'available' });
    expect(probe).not.toHaveBeenCalled();
    expect(await adapter({ agentUserContext: 'excluded' }).detect()).toEqual({ kind: 'refused', reason: 'agent_user_context_unavailable' });
    probe.mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }));
    expect(await adapter({ agentUserContext: 'excluded' }).detect()).toEqual({ kind: 'probe-failed' });
  });

  it('probes a file link once per process on Windows only and removes the probe files', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-probe-')));
    dirs.push(tmp);
    vi.spyOn(os, 'tmpdir').mockReturnValue(tmp);
    const symlink = vi.spyOn(fs, 'symlink');
    expect(await ownedRuntimeHome.ownedRuntimeHomeLinksAvailable('darwin')).toBe(true);
    expect(symlink).not.toHaveBeenCalled();
    // An unexpected error is not an answer: it rejects and is not cached.
    symlink.mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }));
    await expect(ownedRuntimeHome.ownedRuntimeHomeLinksAvailable('win32')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fs.readdir(tmp)).toEqual([]);
    symlink.mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    expect(await ownedRuntimeHome.ownedRuntimeHomeLinksAvailable('win32')).toBe(false);
    expect(await fs.readdir(tmp)).toEqual([]);
    expect(await ownedRuntimeHome.ownedRuntimeHomeLinksAvailable('win32')).toBe(false);
    expect(symlink).toHaveBeenCalledTimes(2);
  });
});

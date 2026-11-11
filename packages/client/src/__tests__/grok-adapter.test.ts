import { acquireAgySessionRetention, agySessionStoreOf } from '../util/agy-session-retention';
import { PathMutationGateBusyError } from '../util/path-mutation-gate';
import type { RuntimeTaskInput } from '../types';
import { fileURLToPath } from 'node:url';
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { PolicyUnsupportedError, SteerUnsupportedError, type McpToolsetToolObservation, type RuntimeAdapter, type Session } from '../types';
import { RuntimeDisposalFailure, RuntimeExecutionFailure } from '../runtime-failure';
import * as processTree from '../adapters/process-tree';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { GrokProjection } from '../adapters/grok/projection';
import { AgyAdapter, type AgyAdapterOptions } from '../adapters/antigravity/agy-adapter';
import { agyAdapterWithEndpoint } from '../adapters/antigravity/agy-endpoint';
import { agyMcpEventIdentities } from '../adapters/antigravity/projection';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const sessions: Session[] = [];
const dirs: string[] = [];

function adapter(options: ConstructorParameters<typeof GrokAdapter>[0] = {}) {
  return new GrokAdapter({ resolveBin: () => ({ command: fixture, source: 'path' }), ...options });
}
async function tempDir(prefix = 'byok-grok-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
async function ctx(env: NodeJS.ProcessEnv = {}): Promise<PreparedOperationResources & { log: string }> {
  const workspaceDir = await tempDir();
  const log = path.join(workspaceDir, '.agent.log');
  return { workspaceDir, log, env: { PATH: process.env.PATH, HOME: os.homedir(), FAKE_ACP_LOG: log, ...env } };
}
function facts(log: string): Array<Record<string, any>> {
  return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
async function open(a: RuntimeAdapter, offer: RuntimeTaskInput, resources: PreparedOperationResources): Promise<Session> {
  const session = await startPreparedOperation(a, offer, resources);
  sessions.push(session);
  return session;
}
async function turn(s: Session): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of s.events) {
    if (e.type === 'message_draft_delta') continue; // Display-only; the draft lane has its own tests.
    out.push(e);
    if (e.type === 'turn_end') break;
  }
  return out;
}
async function failureOf(s: Session): Promise<unknown> {
  try { await turn(s); } catch (error) { return error; }
  throw new Error('the turn did not fail');
}
const usage = { type: 'usage', inputTokens: 100, cachedInputTokens: 64, outputTokens: 7, contextTokens: 1001, contextSource: 'provider' } as const;

const GEMINI_URL = 'http://127.0.0.1:9';
const agyCtx = (env: NodeJS.ProcessEnv = {}) => ctx({ GEMINI_API_KEY: 'task-key', ...env });
const mcpServer = (serverName: string, ...names: string[]): McpToolsetToolObservation[string] => ({
  serverName, toolsetId: `set.${serverName}`, serverInfo: { name: serverName, version: '1' }, protocolVersion: '2025-06-18',
  tools: names.map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
});
function agy(home: string, options: Partial<AgyAdapterOptions> = {}): AgyAdapter {
  return agyAdapterWithEndpoint(new AgyAdapter({ home, resolveBin: () => ({ command: fixture, source: 'path' }), runtimeEnvironment: { base: 'allowlist', pass: ['FAKE_ACP_*', 'GEMINI_*', 'GOOGLE_*', 'AGY_*'] }, ...options }), GEMINI_URL);
}
async function agyVersion(version: string) {
  vi.stubEnv('FAKE_ACP_VERSION', version);
  return tempDir('byok-agy-');
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(s => s.close()));
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('GrokAdapter detection', () => {
  it('reports the version, an unqualified-version advisory and the API-key login signal', async () => {
    vi.stubEnv('XAI_API_KEY', 'xai-fixture-key');
    expect(await adapter().detect()).toEqual({
      kind: 'available', version: 'grok 1.0.62 (fixture)', authPresent: true,
      executablePath: fixture, executableSource: 'config',
      advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '1.0.52' },
      versionVerdict: { state: 'warn', qualifiedVersion: '1.0.52' },
    });
  });

  it('reads only the existence of $GROK_HOME/auth.json', async () => {
    const home = await tempDir();
    vi.stubEnv('XAI_API_KEY', '');
    vi.stubEnv('GROK_HOME', home);
    vi.stubEnv('FAKE_ACP_VERSION', 'grok 1.0.52 (fixture)');
    expect(await adapter().detect()).toEqual({
      kind: 'available', version: 'grok 1.0.52 (fixture)', authPresent: false,
      executablePath: fixture, executableSource: 'config',
      versionVerdict: { state: 'allow', qualifiedVersion: '1.0.52' },
    });
    await fs.writeFile(path.join(home, 'auth.json'), 'not read');
    await fs.chmod(path.join(home, 'auth.json'), 0o000);
    expect(await adapter().detect()).toMatchObject({ authPresent: true });
  });

  it('refuses a CLI without stdio ACP mode and reports a missing binary', async () => {
    vi.stubEnv('FAKE_ACP_NO_STDIO', '1');
    expect(await adapter().detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable' });
    expect(await new GrokAdapter({ resolveBin: () => ({ command: '/nonexistent/grok', source: 'path' }) }).detect()).toEqual({ kind: 'not-found' });
  });
});

describe('GrokAdapter sessions', () => {
  it('declares resume and MCP toolsets, no steer, no approvals and no dispatch selection', async () => {
    const a = adapter();
    expect(a.descriptor).toEqual({
      id: 'grok', supportsDispatchSelection: false, requiresMcpToolsetToolObservation: false, platforms: ['darwin', 'linux'],
      versionPolicy: { qualifiedVersion: '1.0.52', unqualified: 'warn' },
      capabilities: {
        steer: false, resume: true, approvalInteractive: false, mcpToolsets: true, messageDraft: true, preparedLane: false,
        isolation: { userInstructions: false, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false, userMcpServers: false, sessionPersistence: false },
      },
    });
  });

  it('runs one owned ACP agent with the exact env and closes the reply with the turn', async () => {
    vi.stubEnv('BYOK_GROK_AMBIENT_SECRET', 'must not inherit');
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'hello' }, resources);
    expect(s.sessionRef).toBe('fake-grok-session');
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'echo:hello' }, usage, { type: 'turn_end' }]);
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    expect(started!.argv).toEqual(['agent', '--always-approve', '--no-leader', 'stdio']);
    expect(await fs.realpath(started!.cwd)).toBe(await fs.realpath(resources.workspaceDir));
    expect(started!.env).not.toHaveProperty('BYOK_GROK_AMBIENT_SECRET');
    expect(started!.env.FAKE_ACP_LOG).toBe(resources.log);
    expect(facts(resources.log).find(fact => fact.kind === 'open')?.method).toBe('session/new');
  });

  it('closes a text run at each tool call and reports tool results', async () => {
    const s = await open(adapter(), { instruction: 'tool' }, await ctx());
    expect(await turn(s)).toEqual([
      { type: 'progress', text: 'Let me look. ' },
      { type: 'tool_use', tool: 'run_terminal_command', toolCallId: 'call-1', input: { command: 'ls' } },
      { type: 'tool_result', tool: 'run_terminal_command', toolCallId: 'call-1', output: { content: [{ type: 'text', text: 'a.txt' }], exitCode: 0 } },
      { type: 'progress', text: 'Found a.txt.' },
      usage,
      { type: 'turn_end' },
    ]);
    await s.followUp({ instruction: 'tool-failed' });
    expect(await turn(s)).toEqual([
      { type: 'tool_use', tool: 'read_file', toolCallId: 'call-2', input: { target_file: 'missing' } },
      { type: 'tool_result', tool: 'read_file', toolCallId: 'call-2', output: { content: [{ type: 'text', text: 'not found' }] }, isError: true },
      { type: 'progress', text: 'No file.' },
      { ...usage, contextTokens: 1002 },
      { type: 'turn_end' },
    ]);
  });

  it('keeps a tool input past OAR\'s text cap whole and leaves a non-object input unknown', async () => {
    const s = await open(adapter(), { instruction: 'tool-inputs' }, await ctx());
    expect((await turn(s)).slice(0, 2)).toEqual([
      { type: 'tool_use', tool: 'run_terminal_command', toolCallId: 'call-long', input: { command: `echo ${'a'.repeat(12_000)}; git push origin main` } },
      { type: 'tool_use', tool: 'run_terminal_command', toolCallId: 'call-text' },
    ]);
  });

  it('keeps sub-agent text and tools out of the parent reply', async () => {
    const s = await open(adapter(), { instruction: 'child' }, await ctx());
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'parent-answer' }, usage, { type: 'turn_end' }]);
  });

  it('runs a hosted terminal command and attaches task MCP servers on open', async () => {
    const resources = await ctx();
    const server = { command: process.execPath, args: ['mcp.js'], env: { MCP_TOKEN: 'mcp-fixture-secret-value' } };
    const s = await open(adapter(), { instruction: 'terminal' }, { ...resources, mcpServers: { 'aiphabee-bot-chat': server } });
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'terminal:terminal-ok' }, usage, { type: 'turn_end' }]);
    expect(facts(resources.log).find(fact => fact.kind === 'open')?.params.mcpServers).toEqual([
      { name: 'aiphabee-bot-chat', command: process.execPath, args: ['mcp.js'], env: [{ name: 'MCP_TOKEN', value: 'mcp-fixture-secret-value' }] },
    ]);
  });

  it('sets the four compatibility variables on the agent process only when asked, and on no hosted terminal command (#634)', async () => {
    expect(() => adapter({ compatInstructions: 'off' as never })).toThrow(TypeError);
    for (const options of [{}, { compatInstructions: 'inherit' as const }]) {
      const plain = await ctx();
      await turn(await open(adapter(options), { instruction: 'hello' }, plain));
      expect(Object.keys(facts(plain.log).find(fact => fact.kind === 'start')!.env).filter(name => name.startsWith('GROK_'))).toEqual([]);
    }
    const resources = await ctx();
    const s = await open(adapter({ compatInstructions: 'disabled' }), { instruction: 'terminal-compat' }, resources);
    // The hosted terminal command keeps the task env: none of the four variables reaches it.
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'terminal:unset,unset,unset,unset' }, usage, { type: 'turn_end' }]);
    expect(facts(resources.log).find(fact => fact.kind === 'start')!.env).toMatchObject({
      GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0', GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_RULES_ENABLED: '0',
    });
  });

  it('resumes the exact native session and fails closed on a missing one', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'again', sessionRef: 'fake-grok-session' }, resources);
    expect(s.sessionRef).toBe('fake-grok-session');
    await turn(s);
    expect(facts(resources.log).find(fact => fact.kind === 'open')).toMatchObject({ method: 'session/resume', params: { sessionId: 'fake-grok-session' } });
    const missing = await startPreparedOperation(adapter(), { instruction: 'again', sessionRef: 'gone' }, await ctx()).catch(error => error);
    expect(missing).toBeInstanceOf(RuntimeExecutionFailure);
    expect(missing).toMatchObject({ phase: 'start', retry: 'non-retryable' });
  });

  it('selects the adapter model and fails closed on a refused model or login', async () => {
    const resources = await ctx();
    const s = await open(adapter({ model: 'grok-fixture' }), { instruction: 'hello' }, resources);
    await turn(s);
    expect(facts(resources.log).find(fact => fact.kind === 'model')?.params).toMatchObject({ sessionId: 'fake-grok-session', modelId: 'grok-fixture' });
    const refusedModel = await startPreparedOperation(adapter({ model: 'no-such-model' }), { instruction: 'x' }, await ctx()).catch(error => error);
    expect(refusedModel).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    const refusedLogin = await startPreparedOperation(adapter(), { instruction: 'x' }, await ctx({ FAKE_ACP_AUTH: 'refuse' })).catch(error => error);
    expect(refusedLogin).toMatchObject({ phase: 'start', retry: 'non-retryable' });
  });

  it('rejects steer with the typed error and a follow-up that names a selection', async () => {
    const s = await open(adapter(), { instruction: 'hello' }, await ctx());
    await turn(s);
    await expect(s.steer('x')).rejects.toBeInstanceOf(SteerUnsupportedError);
    await expect(s.followUp({ instruction: 'x', dispatchSelection: { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'm' } }))
      .rejects.toThrow('takes no dispatch selection');
  });

  it('interrupts through session/cancel and ends the turn with the cancelled answer', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'hold' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    await s.interrupt();
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(true);
    expect(await turn(s)).toEqual([usage, { type: 'turn_end' }]);
  });

  // OAR 0.99 adopts a turn Grok runs on its own as the active turn (native-turns.ts) and refuses a prompt as busy meanwhile.
  async function ownTurnStarted(s: Session): Promise<void> {
    for await (const e of s.events) if (e.type === 'message_draft_delta' && e.text === 'background') return;
  }
  const prompts = (log: string) => facts(log).filter(fact => fact.kind === 'prompt').map(fact => String(fact.text).trim().split('\n').at(-1));

  it('holds a follow-up while Grok runs its own turn and runs it as the task turn when that turn closes', async () => {
    const gate = path.join(await tempDir(), 'gate');
    const resources = await ctx({ FAKE_ACP_OWN_TURN_GATE: gate });
    const s = await open(adapter(), { instruction: 'own-turn' }, resources);
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
    await ownTurnStarted(s);
    await s.followUp({ instruction: 'hello' });
    expect(prompts(resources.log)).toEqual(['own-turn']);
    await fs.writeFile(gate, '');
    // Grok's turn end is no task turn end; the drained prompt's turn_active has no input id and is the task's.
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'background' }, { type: 'progress', text: 'echo:hello' }, { ...usage, contextTokens: 1002 }, { type: 'turn_end' }]);
    expect(prompts(resources.log)).toEqual(['own-turn', 'hello']);
  });

  it('takes a held follow-up back on interrupt, so Grok never receives it', async () => {
    const gate = path.join(await tempDir(), 'gate');
    const resources = await ctx({ FAKE_ACP_OWN_TURN_GATE: gate });
    const s = await open(adapter(), { instruction: 'own-turn' }, resources);
    await turn(s);
    await ownTurnStarted(s);
    await s.followUp({ instruction: 'never-sent' });
    await s.interrupt();
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(false);
    expect(await turn(s)).toEqual([{ type: 'turn_end' }]);
    await fs.writeFile(gate, '');
    await s.followUp({ instruction: 'hello' });
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
    expect(prompts(resources.log)).toEqual(['own-turn', 'hello']);
  });

  it('fails the session on a Grok turn end while no turn is open', async () => {
    const s = await open(adapter(), { instruction: 'stray-end' }, await ctx());
    await turn(s);
    expect(await failureOf(s)).toMatchObject({ message: 'grok reported a turn end with no turn open' });
  });

  // #1297: the tool left the agent's group and the cancel orphaned it, so it is below the agent in no read at close.
  it.skipIf(process.platform === 'win32')('close ends a setsid tool that the native cancel orphaned', async () => {
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const until = async (done: () => boolean): Promise<void> => {
      for (const deadline = Date.now() + 5_000; !done(); await new Promise(resolve => setTimeout(resolve, 20))) {
        if (Date.now() > deadline) throw new Error('condition not met within 5 s');
      }
    };
    // Only the read before the cancel may see the tool, never the periodic observation.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const resources = await ctx();
    const treeFile = path.join(resources.workspaceDir, 'tool-tree.json');
    const s = await open(adapter(), { instruction: 'orphan-tool' }, { ...resources, env: { ...resources.env, FAKE_ACP_TOOL_TREE: treeFile } });
    await until(() => { try { return JSON.parse(readFileSync(treeFile, 'utf8')).grandchildPid > 0; } catch { return false; } });
    const { descendantPid: parent, grandchildPid: tool } = JSON.parse(readFileSync(treeFile, 'utf8')) as { descendantPid: number; grandchildPid: number };
    try {
      await s.interrupt();
      await until(() => !alive(parent));
      expect(alive(tool)).toBe(true);
      await s.close();
      expect(alive(tool)).toBe(false);
    } finally {
      vi.useRealTimers();
      if (alive(tool)) process.kill(tool, 'SIGKILL');
    }
  });

  it('refuses the interrupt and sends no native cancel when the agent\'s descendants cannot be read first', async () => {
    vi.spyOn(processTree, 'rememberOwnedDescendants').mockImplementation(() => { throw new Error('Process table ps: timeout after 5000 ms'); });
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'hold' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    await expect(s.interrupt()).rejects.toMatchObject({ message: 'grok interrupt refused: Process table ps: timeout after 5000 ms' });
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(false);
  });

  it('fails the session when the cancel is not answered within the interrupt bound', async () => {
    const resources = await ctx();
    const s = await open(adapter({ interruptTimeoutMs: 200 }), { instruction: 'hold-silent' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    await expect(s.interrupt()).rejects.toThrow('grok interrupt timed out');
    expect(await failureOf(s)).toMatchObject({ phase: 'run', retry: 'non-retryable' });
  });

  it('maps prompt errors to semantic failures, retryable only when rate limited', async () => {
    const failed = await failureOf(await open(adapter(), { instruction: 'fail' }, await ctx()));
    expect(failed).toMatchObject({ phase: 'run', retry: 'non-retryable', message: 'Internal error' });
    const limited = await failureOf(await open(adapter(), { instruction: 'rate-limited' }, await ctx()));
    expect(limited).toMatchObject({ phase: 'run', retry: 'retryable' });
  });

  it('passes the vendored OAR failure class through, with the reason unchanged (#869)', async () => {
    const classOf = async (instruction: string) => {
      const failed = await failureOf(await open(adapter(), { instruction }, await ctx()));
      return { failure: (failed as RuntimeExecutionFailure).failure, message: (failed as RuntimeExecutionFailure).message };
    };
    // -32003 covers every 429, a usage limit included: Grok cannot show quota.
    expect(await classOf('rate-limited')).toEqual({ failure: { class: 'rate_limited' }, message: 'Rate limited' });
    expect(await classOf('retry-failed:auth')).toEqual({ failure: { class: 'auth' }, message: 'Internal error' });
    expect(await classOf('retry-failed:context_length')).toEqual({ failure: { class: 'input_too_large' }, message: 'Internal error' });
    // A failed prompt that is not a process exit, -32000 or -32003, and whose last ended retry_state is missing or
    // has an error_type outside Grok's table, names no cause: OAR's text rule reads "Internal error" as `provider`,
    // which is not structured evidence.
    expect(await classOf('fail')).toEqual({ failure: { class: 'unknown' }, message: 'Internal error' });
    expect(await classOf('retry-failed:network')).toEqual({ failure: { class: 'unknown' }, message: 'Internal error' });
    expect((await failureOf(await open(adapter(), { instruction: 'exit' }, await ctx())) as RuntimeExecutionFailure).failure).toEqual({ class: 'runtime_exited' });
    const refusedLogin = await startPreparedOperation(adapter(), { instruction: 'x' }, await ctx({ FAKE_ACP_AUTH: 'refuse' })).catch(error => error);
    expect(refusedLogin).toMatchObject({ phase: 'start', failure: { class: 'auth' } });
    const refusedModel = await startPreparedOperation(adapter({ model: 'no-such-model' }), { instruction: 'x' }, await ctx()).catch(error => error);
    expect(refusedModel).toMatchObject({ phase: 'start', failure: { class: 'model_unavailable' } });
  });

  it('marks an agent exit during the open runtime_exited, and an open it did not end unknown (#869)', async () => {
    await expect(startPreparedOperation(adapter(), { instruction: 'x' }, await ctx({ FAKE_ACP_INITIALIZE: 'exit' }))).rejects.toMatchObject({
      phase: 'start', failure: { class: 'runtime_exited' },
    });
    // The kernel kills the agent itself after the refused initialize.
    await expect(startPreparedOperation(adapter(), { instruction: 'x' }, await ctx({ FAKE_ACP_INITIALIZE: 'error' }))).rejects.toMatchObject({
      phase: 'start', message: 'Internal error', failure: { class: 'unknown' },
    });
  });

  it('sends unknown for a class OAR took from error text, keeping the retry it derives (#869)', async () => {
    const failed = await failureOf(await open(adapter(), { instruction: 'fail-text:429 rate limit' }, await ctx()));
    expect(failed).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failed).toMatchObject({ phase: 'run', retry: 'retryable', message: 'Internal error: 429 rate limit' });
    expect((failed as RuntimeExecutionFailure).failure).toEqual({ class: 'unknown' });
  });

  it('fails the session and ends the agent when retained records exceed the byte budget', async () => {
    const resources = await ctx();
    // 'huge' streams 256 KiB of text: the open fits the budget, the turn does not.
    const failure = await open(adapter({ maxRetainedBytes: 64 * 1024 }), { instruction: 'huge' }, resources)
      .then(failureOf, (error) => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ message: 'grok retained record byte budget exceeded' });
    await Promise.all(sessions.map(s => s.close()));
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    if (process.platform !== 'win32') await vi.waitFor(() => expect(() => process.kill(started!.pid, 0)).toThrow());
  });

  it('a failing record consumer fails the session although the kernel swallows observer errors', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'hold-silent' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    vi.spyOn(GrokProjection.prototype, 'consume').mockImplementation(() => { throw new Error('projection failed'); });
    // The cancel request is the next record: the failing consumer sees it.
    await s.interrupt().catch(() => {});
    expect(await failureOf(s)).toMatchObject({ message: 'projection failed' });
    await s.close();
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    if (process.platform !== 'win32') await vi.waitFor(() => expect(() => process.kill(started!.pid, 0)).toThrow());
  });

  it('fails as infrastructure when the agent exits on its own', async () => {
    const failure = await failureOf(await open(adapter(), { instruction: 'exit' }, await ctx()));
    expect(failure).toMatchObject({ message: 'grok agent exited' });
  });

  it('reports a failed terminal reap from close, even after the agent failed, and retries it', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'terminal-hang' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'terminal')).toBe(true));
    const real = processTree.disposeOwnedProcessTree;
    let failed = false;
    const spy = vi.spyOn(processTree, 'disposeOwnedProcessTree').mockImplementation(async (options) => {
      if (options.label === 'acp terminal' && !failed) {
        failed = true;
        throw new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'acp terminal tree did not quiesce' });
      }
      return real(options);
    });
    // A prior failure must not hide the reap failure.
    await s.interrupt().catch(() => {});
    await expect(s.close()).rejects.toBeInstanceOf(RuntimeDisposalFailure);
    await s.close();
    expect(spy.mock.calls.filter(([options]) => options.label === 'acp terminal').length).toBeGreaterThanOrEqual(2);
  });

  it('closes idempotently during an active turn and ends the agent process', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'hold-silent' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    await Promise.all([s.close(), s.close()]);
    await s.close();
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    if (process.platform !== 'win32') expect(() => process.kill(started!.pid, 0)).toThrow();
  });
});

describe('GrokAdapter agentUserMcpServers (#935)', () => {
  const MCP_OFF = { GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_MANAGED_MCPS_ENABLED: '0' };
  /** An Agent writer task: the cwd is the sealed home, by its real path. */
  async function agentCtx(env: NodeJS.ProcessEnv = {}): Promise<PreparedOperationResources & { log: string }> {
    const resources = await ctx(env);
    const home = await fs.realpath(resources.workspaceDir);
    return { ...resources, workspaceDir: home, agentHome: home };
  }
  const kinds = (log: string) => facts(log).map(fact => fact.kind).filter(kind => kind === 'inspect' || kind === 'start');

  it('validates the option', () => {
    expect(() => adapter({ agentUserMcpServers: 'strict' as never })).toThrow(new TypeError('GrokAdapterOptions.agentUserMcpServers must be inherit or excluded'));
  });

  it('inspects with the agent cwd and env, then starts the agent with the three variables', async () => {
    const resources = await agentCtx();
    const s = await open(adapter({ agentUserMcpServers: 'excluded', compatInstructions: 'disabled' }), { instruction: 'hello' }, resources);
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'echo:hello' }, usage, { type: 'turn_end' }]);
    expect(kinds(resources.log)).toEqual(['inspect', 'start']);
    const [inspect, started] = [facts(resources.log).find(fact => fact.kind === 'inspect')!, facts(resources.log).find(fact => fact.kind === 'start')!];
    expect(inspect.argv).toEqual(['inspect', '--json']);
    expect(await fs.realpath(inspect.cwd)).toBe(resources.workspaceDir);
    for (const env of [inspect.env, started.env]) {
      expect(env).toMatchObject({ ...MCP_OFF, GROK_CLAUDE_RULES_ENABLED: '0', FAKE_ACP_LOG: resources.log });
    }
  });

  it('runs inspect through a custom spawnFn with the command, cwd and env of the agent', async () => {
    const resources = await agentCtx();
    const calls: { command: string; args: readonly string[]; cwd: unknown; env: unknown }[] = [];
    const spawnFn: typeof spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env });
      return spawn(command, args, options);
    }) as typeof spawn;
    await turn(await open(adapter({ agentUserMcpServers: 'excluded', spawnFn }), { instruction: 'hello' }, resources));
    const [inspect, agent] = [calls.find(call => call.args[0] === 'inspect')!, calls.find(call => call.args[0] === 'agent')!];
    expect(calls.indexOf(inspect)).toBeLessThan(calls.indexOf(agent));
    expect(inspect).toEqual({ command: agent.command, args: ['inspect', '--json'], cwd: agent.cwd, env: agent.env });
    expect(inspect.env).toMatchObject(MCP_OFF);
  });

  it('fails before the agent starts when inspect lists a server outside the task, or fails', async () => {
    const listed = JSON.stringify({
      mcpServers: [
        { name: 'gmail', transport: 'stdio', target: 'gmail-mcp', source: { type: 'configToml', path: '/home/user/.grok/config.toml' } },
        { name: 'claude_notes', transport: 'stdio', target: 'n', source: { type: 'claudeJson', path: '/home/user/.claude.json' }, disabled: true, compatibilityStatus: 'disabled', vendor: 'claude' },
      ],
      plugins: [],
    });
    for (const [inspect, reason] of [
      [listed, 'grok Agent user MCP server exclusion refused: Grok still loads MCP servers outside the task: gmail (configToml)'],
      ['fail', 'grok Agent user MCP server exclusion refused: grok inspect failed'],
    ] as const) {
      const resources = await agentCtx({ FAKE_ACP_INSPECT: inspect });
      const error = await startPreparedOperation(adapter({ agentUserMcpServers: 'excluded' }), { instruction: 'hello' }, resources).catch(e => e);
      expect(error).toBeInstanceOf(RuntimeExecutionFailure);
      expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable', message: reason, failure: { class: 'unknown' } });
      expect(kinds(resources.log)).toEqual(['inspect']);
    }
  });

  it('changes nothing under inherit or for a task that is not an Agent task', async () => {
    for (const [options, agent] of [[{}, true], [{ agentUserMcpServers: 'inherit' as const }, true], [{ agentUserMcpServers: 'excluded' as const }, false]] as const) {
      const resources = agent ? await agentCtx() : await ctx();
      await turn(await open(adapter(options), { instruction: 'hello' }, resources));
      expect(kinds(resources.log)).toEqual(['start']);
      expect(Object.keys(facts(resources.log).find(fact => fact.kind === 'start')!.env).filter(name => name.startsWith('GROK_'))).toEqual([]);
    }
  });
});

describe('AgyAdapter', () => {
  it('owns a home that is not the user\'s and refuses an upstream carrying credentials', () => {
    expect(() => new AgyAdapter({ home: 'relative' })).toThrow(/absolute/);
    expect(() => new AgyAdapter({ home: os.homedir() })).toThrow(/user's home/);
    expect(() => new AgyAdapter({ home: path.join(os.homedir(), '.gemini', 'x') })).toThrow(/user's home/);
    expect(() => agyAdapterWithEndpoint(new AgyAdapter({ home: '/owned' }), 'http://user:pw@127.0.0.1:9')).toThrow(/credentials/);
    expect(() => agyAdapterWithEndpoint(new AgyAdapter({ home: '/owned' }), 'http://127.0.0.1:9?key=x')).toThrow(/query/);
    expect(new AgyAdapter({ home: '/owned' }).descriptor).toMatchObject({ id: 'agy', platforms: ['darwin', 'linux', 'win32'] });
  });

  it('detect refuses a CLI without native ACP, a prerelease and an extra notice, and writes the native settings', async () => {
    const home = await agyVersion('1.4.9');
    expect(await agy(home).detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable' });
    vi.stubEnv('FAKE_ACP_VERSION', '1.5.0-rc.1');
    expect(await agy(home).detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable' });
    vi.stubEnv('FAKE_ACP_VERSION', '1.5.0\nupdate available');
    expect(await agy(home).detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable' });
    vi.stubEnv('FAKE_ACP_VERSION', '1.5.0');
    expect(await agy(home).detect()).toMatchObject({ kind: 'available', version: '1.5.0' });
    expect(JSON.parse(readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')))
      .toEqual({ modelProvider: 'gemini', setupComplete: true, onboardingComplete: true });
  });

  it('runs agy on the owned home behind the local proxy, with a session token in place of the key', async () => {
    const home = await agyVersion('1.5.1');
    vi.stubEnv('GEMINI_API_KEY', 'host-key');
    vi.stubEnv('GOOGLE_API_KEY', 'host-key-2');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://elsewhere.test');
    vi.stubEnv('AGY_ADC_AUTH', '1');
    const resources = await agyCtx({ GEMINI_HOME: '/user/.gemini', XDG_CONFIG_HOME: '/user/.config', XDG_RUNTIME_DIR: '/run/user/1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus', APPDATA: '/user/roaming' });
    const s = await open(agy(home, { model: 'gemini-3.8-flash' }), { instruction: 'hello' }, resources);
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'echo:hello' }, { type: 'turn_end' }]);
    const start = facts(resources.log).find(fact => fact.kind === 'start')!;
    expect(start.argv).toEqual(['acp', '--dangerously-skip-permissions', '--process-per-session', '--disable-telemetry']);
    expect(start.env).toMatchObject({
      HOME: home, USERPROFILE: home, GEMINI_HOME: path.join(home, '.gemini'), AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    });
    expect(start.env.GOOGLE_GEMINI_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(start.env.GEMINI_API_KEY).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(start.env)).not.toContain('task-key');
    expect(start.env.GOOGLE_API_KEY).toBeUndefined();
    expect(start.env.AGY_ADC_AUTH).toBeUndefined();
    expect(start.env).toMatchObject({
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, 'no-session-bus')}`,
    });
    for (const name of ['XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR']) expect(start.env[name]).toBeUndefined();
    expect(facts(resources.log).find(fact => fact.kind === 'config')?.params).toMatchObject({ configId: 'model', value: 'gemini-3.8-flash' });
  });

  it('projects native tool names, the classified command and path keys, and an exact MCP identity', async () => {
    const home = await agyVersion('1.5.1');
    const s = await open(agy(home), { instruction: 'agy-tools' }, { ...await agyCtx(), mcpToolsetTools: { 'market.feed': mcpServer('market.feed', 'quote') } });
    const events = await turn(s);
    expect(events.find(event => event.type === 'tool_use' && event.tool === 'run_command')).toMatchObject({ input: { command: 'rm -rf build', CommandLine: 'rm -rf build' } });
    const tool = (id: string) => events.find(event => event.type === 'tool_use' && event.toolCallId === id) as Extract<AgentEvent, { type: 'tool_use' }>;
    // OAR's own input text stops at 10,000 characters, far short of this Content.
    expect(tool('agy-3').input).toMatchObject({ path: '/home/u/.zshrc' });
    expect(tool('agy-4').input).toMatchObject({ path: '/home/u/e.txt' });
    expect(tool('agy-5').input).toMatchObject({ path: '/home/u/r.txt' });
    expect(tool('agy-6').input).toBeUndefined();
    const mcp = { server: 'market.feed', tool: 'quote' };
    expect(events.find(event => event.type === 'tool_use' && event.tool === 'mcp_market.feed_quote')).toMatchObject({ mcp });
    expect(events.find(event => event.type === 'tool_result' && event.tool === 'mcp_market.feed_quote')).toMatchObject({ mcp });
  });

  it('gives an agy MCP name two tools share no identity', () => {
    const identities = agyMcpEventIdentities({ a: mcpServer('a', 'b_c'), a_b: mcpServer('a_b', 'c', 'd') });
    expect(identities.has('mcp_a_b_c')).toBe(false);
    expect(identities.get('mcp_a_b_d')).toEqual({ server: 'a_b', tool: 'd' });
  });

  it('refuses an MCP entry carrying env as a non-retryable authority failure', async () => {
    const home = await agyVersion('1.5.1');
    const failure = await open(agy(home), { instruction: 'hello' }, { ...await agyCtx(), mcpServers: { host: { command: 'server', env: { TOKEN: 'x' } } } }).catch(error => error);
    expect(failure).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    expect(String(failure.message)).toContain('it attaches no entry with env or headers');
  });

  it('resumes only on a listed saved cwd', async () => {
    const home = await agyVersion('1.5.1');
    const unlisted = await open(agy(home), { instruction: 'again', sessionRef: 'fake-grok-session' }, await agyCtx()).catch(error => error);
    expect(unlisted).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    const resources = await agyCtx();
    const s = await open(agy(home), { instruction: 'again', sessionRef: 'fake-grok-session' }, { ...resources, env: { ...resources.env, FAKE_ACP_LISTED_CWD: resources.workspaceDir } });
    expect(s.sessionRef).toBe('fake-grok-session');
    expect(facts(resources.log).find(fact => fact.kind === 'open')).toMatchObject({ method: 'session/resume' });
  });

  it('appends the persona only for a reader, and again on resume, because agy replaces its append on every open', async () => {
    const home = await agyVersion('1.5.1');
    const agentHome = await fs.realpath(await tempDir('byok-agy-home-'));
    await fs.writeFile(path.join(agentHome, 'AGENTS.md'), 'Persona rules');
    const run = path.join(agentHome, '.byok', 'runs', 'run-1');
    await fs.mkdir(run, { recursive: true });
    const reader = await agyCtx();
    await turn(await open(agy(home), { instruction: 'again', sessionRef: 'fake-grok-session' }, {
      ...reader, workspaceDir: run, reader: { canonicalHome: agentHome }, env: { ...reader.env, FAKE_ACP_LISTED_CWD: run },
    }));
    expect(facts(reader.log).find(fact => fact.kind === 'open')?.params._meta).toEqual({ antigravity: { systemPrompt: { append: 'Persona rules' } } });
    const writer = await agyCtx();
    await turn(await open(agy(home), { instruction: 'hello' }, { ...writer, workspaceDir: agentHome, agentHome }));
    expect(facts(writer.log).find(fact => fact.kind === 'open')?.params._meta).toBeUndefined();
  });

  it('fails a task without a key as authority, and one whose proxy cannot start as retryable, before agy runs', async () => {
    const home = await agyVersion('1.5.1');
    const resources = await ctx();
    expect(await open(agy(home), { instruction: 'hello' }, resources).catch(error => error)).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    const refused = await agyCtx();
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
      process.nextTick(() => this.emit('error', new Error('no port')));
      return this;
    });
    expect(await open(agy(home), { instruction: 'hello' }, refused).catch(error => error)).toMatchObject({ phase: 'start', retry: 'retryable' });
    listen.mockRestore();
    expect(existsSync(resources.log) || existsSync(refused.log)).toBe(false);
  });

  it('closes the proxy when agy exits', async () => {
    const resources = await agyCtx();
    await turn(await open(agy(await agyVersion('1.5.1')), { instruction: 'hello' }, resources));
    const start = facts(resources.log).find(fact => fact.kind === 'start')!;
    await expect(fetch(start.env.GOOGLE_GEMINI_BASE_URL)).rejects.toThrow();
  });

  it('still sends session/close and disposes the process and proxy when the process table cannot be read at the stop, and stops again on the close', async () => {
    const home = await agyVersion('1.5.1');
    const observe = vi.spyOn(processTree, 'rememberOwnedDescendants').mockImplementation(() => { throw new Error('Process table ps: timeout after 5000 ms'); });
    const resources = await agyCtx();
    const s = await open(agy(home), { instruction: 'hello' }, resources);
    expect(await failureOf(s)).toMatchObject({ message: 'Process table ps: timeout after 5000 ms' });
    expect(facts(resources.log).some(fact => fact.kind === 'close')).toBe(true);
    const start = facts(resources.log).find(fact => fact.kind === 'start')!;
    expect(() => process.kill(start.pid, 0)).toThrow();
    await expect(fetch(start.env.GOOGLE_GEMINI_BASE_URL)).rejects.toThrow();
    await s.close();
    expect(observe).toHaveBeenCalledTimes(2); // The failed stop is not remembered: the close stops again.
  });

  it('leases a resumed session against the store sweep, and only that session', async () => {
    const adapter = agy(await agyVersion('1.5.1'));
    const store = agySessionStoreOf(adapter)!;
    const prepared = await adapter.prepare({ offer: { instruction: 'x' } } as never);
    if (prepared.kind !== 'prepared') throw new Error('agy did not prepare');
    const lease = await prepared.operation.acquireSessionLease!('session-a');
    await expect(acquireAgySessionRetention(store, 'session-a')).rejects.toBeInstanceOf(PathMutationGateBusyError);
    await (await acquireAgySessionRetention(store, 'session-b')).release();
    await lease!.release();
  });

  it('kills a daemon that left the process group before it reports turn_end', async () => {
    const home = await agyVersion('1.5.1');
    const resources = await agyCtx();
    const pidFile = path.join(resources.workspaceDir, 'daemon.pid');
    const s = await open(agy(home), { instruction: `agy-daemon:${pidFile}` }, resources);
    for await (const event of s.events) if (event.type === 'turn_end') break;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    await expect(s.followUp({ instruction: 'x' })).rejects.toBeInstanceOf(PolicyUnsupportedError);
  });

  it('answers a writer with allow_once, and fails a reader the model never answered after a reject_once', async () => {
    const home = await agyVersion('1.5.1');
    const outside = path.join(os.tmpdir(), 'byok-agy-outside.txt');
    const writer = await agyCtx();
    await turn(await open(agy(home), { instruction: `agy-ask:edit:${outside}` }, writer));
    expect(facts(writer.log).find(fact => fact.kind === 'permission')?.answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    const agentHome = await fs.realpath(await tempDir('byok-agy-home-'));
    const run = path.join(agentHome, '.byok', 'runs', 'adapter-unit-test');
    await fs.mkdir(run, { recursive: true });
    const reader = (resources: Awaited<ReturnType<typeof ctx>>) => ({ ...resources, workspaceDir: run, reader: { canonicalHome: agentHome } });
    const read = await agyCtx();
    await turn(await open(agy(home), { instruction: `agy-ask:read:${path.join(agentHome, 'MEMORY.md')}` }, reader(read)));
    expect(facts(read.log).find(fact => fact.kind === 'permission')?.answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    const write = await agyCtx();
    const failure = await failureOf(await open(agy(home), { instruction: `agy-ask:edit:${path.join(agentHome, 'MEMORY.md')}` }, reader(write)));
    expect(failure).toMatchObject({ retry: 'non-retryable', message: expect.stringContaining('refused write') });
    expect(facts(write.log).find(fact => fact.kind === 'permission')?.answer).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('steers the active turn through ACP', async () => {
    const home = await agyVersion('1.5.1');
    const resources = await agyCtx();
    const s = await open(agy(home), { instruction: 'steer-first' }, resources);
    await s.steer('steer-second');
    await turn(s);
    expect(facts(resources.log).filter(fact => fact.kind === 'prompt').map(fact => fact.text)).toContain('steer-second');
  });

  it('refuses a steer after the turn ends as an infrastructure failure', async () => {
    const s = await open(agy(await agyVersion('1.5.1')), { instruction: 'hello' }, await agyCtx());
    await turn(s);
    await expect(s.steer('late')).rejects.toMatchObject({ message: 'runtime exited' });
  });
});

import { acquireAgySessionRetention, agySessionStoreOf } from '../util/agy-session-retention';
import { PathMutationGateBusyError } from '../util/path-mutation-gate';
import type { RuntimeTaskInput } from '../types';
import { fileURLToPath } from 'node:url';
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, promises as fs, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { createGrokAgentHome, grokUserInstructionsRefusal } from '../adapters/grok/agent-user-context';
import { HELD_LOGIN_RESOLUTION } from '../adapters/grok/held-login';
import { PolicyUnsupportedError, SteerUnsupportedError, type McpToolsetToolObservation, type RuntimeAdapter, type Session } from '../types';
import { RuntimeDisposalFailure, RuntimeExecutionFailure } from '../runtime-failure';
import * as processTree from '../adapters/process-tree';
import { testScratchOwner } from './fixtures/execution-scratch';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { captureProcessIdentity, expectProcessNotLive, isProcessLive, type ProcessIdentity } from './support/process-liveness';
import { GrokProjection } from '../adapters/grok/projection';
import { AgyAdapter, type AgyAdapterOptions } from '../adapters/antigravity/agy-adapter';
import { agyAdapterWithEndpoint } from '../adapters/antigravity/agy-endpoint';
import { agyMcpEventIdentities } from '../adapters/antigravity/projection';

const GROK_TARGET = { lane: 'harness', harnessId: 'grok', selection: { mode: 'device-default' } } as const;

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
const agyCtx = (env: NodeJS.ProcessEnv = {}) => ctx({ GEMINI_API_KEY: 'ambient-task-key', FAKE_ACP_MODEL_CATALOG: 'gemini-3.8-flash', ...env });
const mcpServer = (serverName: string, ...names: string[]): McpToolsetToolObservation[string] => ({
  serverName, toolsetId: `set.${serverName}`, serverInfo: { name: serverName, version: '1' }, protocolVersion: '2025-06-18',
  tools: names.map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
});
function agy(home: string, options: Partial<AgyAdapterOptions> = {}): AgyAdapter {
  return agyAdapterWithEndpoint(new AgyAdapter({ resolveKey: async () => 'agy-task-resolver-key-fixture', home, resolveBin: () => ({ command: fixture, source: 'path' }), runtimeEnvironment: { base: 'allowlist', pass: ['FAKE_ACP_*', 'GEMINI_*', 'GOOGLE_*', 'AGY_*'] }, ...options }), GEMINI_URL);
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
  it('reports the version and unqualified-version warning without using a Host API key as a login signal', async () => {
    vi.stubEnv('XAI_API_KEY', 'xai-fixture-key');
    vi.stubEnv('GROK_HOME', await tempDir());
    expect(await adapter().detect()).toEqual({
      kind: 'available', version: 'grok 1.0.62 (fixture)', authPresent: false,
      sessionCapabilities: { images: true, steer: false },
      executablePath: fixture, executableSource: 'config',
      versionVerdict: { state: 'warn', qualifiedVersion: '1.0.77' },
    });
  });

  it('reads only the existence of $GROK_HOME/auth.json', async () => {
    const home = await tempDir();
    vi.stubEnv('XAI_API_KEY', '');
    vi.stubEnv('GROK_HOME', home);
    vi.stubEnv('FAKE_ACP_VERSION', 'grok 1.0.77 (fixture)');
    expect(await adapter().detect()).toEqual({
      kind: 'available', version: 'grok 1.0.77 (fixture)', authPresent: false,
      sessionCapabilities: { images: true, steer: false },
      executablePath: fixture, executableSource: 'config',
      versionVerdict: { state: 'allow', qualifiedVersion: '1.0.77' },
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

async function readProbes(log: string): Promise<string[]> {
  const lines = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  await fs.rm(log, { force: true });
  return lines;
}
async function expectAbortStopsHungHelp(detect: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const reason = new Error('offer cancelled');
  await expect(detect(AbortSignal.abort(reason))).rejects.toBe(reason);
  const pidFile = path.join(await tempDir('byok-acp-help-'), 'pid');
  vi.stubEnv('FAKE_ACP_HELP_HANG_PID_FILE', pidFile);
  const controller = new AbortController();
  const pending = detect(controller.signal);
  const pid = await vi.waitFor(async () => {
    const value = Number(await fs.readFile(pidFile, 'utf8'));
    expect(value).toBeGreaterThan(0);
    return value;
  }, { timeout: 5_000 });
  const child = captureProcessIdentity(pid);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  await vi.waitFor(() => expectProcessNotLive(child));
}

describe('GrokAdapter detect signal and prepare reuse (#2469)', () => {
  it('detect(signal) rethrows a pre-aborted reason and stops a hung `agent stdio --help` on abort', async () => {
    await expectAbortStopsHungHelp(signal => adapter().detect(signal));
  });

  it('prepare() reuses the admission observation of the same executable and otherwise probes afresh', async () => {
    const log = path.join(await tempDir(), 'probes');
    vi.stubEnv('FAKE_ACP_PROBE_LOG', log);
    const runtime = adapter();
    const detected = await runtime.detect();
    if (detected.kind !== 'available') throw new Error('fixture grok is unavailable');
    expect(await readProbes(log)).toEqual(['--version', 'agent stdio --help']);
    const input = { offer: { target: GROK_TARGET, instruction: 'x' }, descriptor: runtime.descriptor, requiredToolsetIds: [] };
    expect(await runtime.prepare({ ...input, detected })).toMatchObject({ kind: 'prepared', detected: { version: detected.version } });
    expect(await readProbes(log)).toEqual([]);
    expect(await runtime.prepare({ ...input, detected: { ...detected, executablePath: '/elsewhere/grok' } })).toMatchObject({ kind: 'prepared' });
    expect(await readProbes(log)).toEqual(['--version', 'agent stdio --help']);
    expect(await runtime.prepare(input)).toMatchObject({ kind: 'prepared' });
    expect(await readProbes(log)).toEqual(['--version', 'agent stdio --help']);
    // A plain object never skips the probe, and a refusing CLI still refuses.
    vi.stubEnv('FAKE_ACP_NO_STDIO', '1');
    expect(await runtime.prepare({ ...input, detected: { kind: 'available', executableSource: 'config' } }))
      .toEqual({ kind: 'reject', reason: 'grok installation refused: acp_unavailable', retryable: false });
  });

  it('prepare() launches the command its observation probed, even when the resolver now answers another', async () => {
    let calls = 0;
    const resolveBin = () => ({ command: calls++ % 2 === 0 ? fixture : path.join(os.tmpdir(), 'byok-no-such-grok-b'), source: 'path' as const });
    const runtime = adapter({ resolveBin });
    const detected = await runtime.detect();
    expect(detected).toMatchObject({ kind: 'available', executablePath: fixture });
    expect(await turn(await open(runtime, { target: GROK_TARGET, instruction: 'hello' }, { ...await ctx(), detected }))).toContainEqual({ type: 'turn_end' });
    expect(calls).toBe(1);
    calls = 0;
    expect(await turn(await open(runtime, { target: GROK_TARGET, instruction: 'hello' }, await ctx()))).toContainEqual({ type: 'turn_end' });
    expect(calls).toBe(1);
  });
});

describe('GrokAdapter sessions', () => {
  it('declares resume and MCP toolsets, no steer, no approvals and no dispatch selection', async () => {
    const a = adapter();
    expect(a.descriptor).toEqual({
      id: 'grok', selectionModes: ['device-default', 'adapter-model'], supportsEffort: true, requiresMcpToolsetToolObservation: false, platforms: ['darwin', 'linux'],
      versionPolicy: { qualifiedVersion: '1.0.77', unqualified: 'warn' },
      capabilities: {
        steer: false, resume: true, approvalInteractive: false, mcpToolsets: true, messageDraft: true, preparedLane: false,
        isolation: { userInstructions: false, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false, userMcpServers: false, sessionPersistence: false },
      },
    });
  });

  it('runs one owned ACP agent with the exact env and closes the reply with the turn', async () => {
    vi.stubEnv('BYOK_GROK_AMBIENT_SECRET', 'must not inherit');
    const resources = await ctx({ XAI_API_KEY: 'host-key', OPENAI_API_KEY: 'another-host-key' });
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'hello' }, resources);
    expect(s.sessionRef).toBe('fake-grok-session');
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'echo:hello' }, usage, { type: 'turn_end' }]);
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    expect(started!.argv).toEqual(['agent', '--always-approve', '--no-leader', 'stdio']);
    expect(await fs.realpath(started!.cwd)).toBe(await fs.realpath(resources.workspaceDir));
    expect(started!.env).not.toHaveProperty('BYOK_GROK_AMBIENT_SECRET');
    expect(started!.env).not.toHaveProperty('XAI_API_KEY');
    expect(started!.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(started!.env.FAKE_ACP_LOG).toBe(resources.log);
    expect(facts(resources.log).find(fact => fact.kind === 'open')?.method).toBe('session/new');
  });

  it('closes a text run at each tool call and reports tool results', async () => {
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'tool' }, await ctx());
    expect(await turn(s)).toEqual([
      { type: 'progress', text: 'Let me look. ' },
      { type: 'tool_use', tool: 'run_terminal_command', toolCallId: 'call-1', input: { command: 'ls' } },
      { type: 'tool_result', tool: 'run_terminal_command', toolCallId: 'call-1', output: { content: [{ type: 'text', text: 'a.txt' }], exitCode: 0 } },
      { type: 'progress', text: 'Found a.txt.' },
      usage,
      { type: 'turn_end' },
    ]);
    await s.followUp({ target: GROK_TARGET, instruction: 'tool-failed' });
    expect(await turn(s)).toEqual([
      { type: 'tool_use', tool: 'read_file', toolCallId: 'call-2', input: { target_file: 'missing' } },
      { type: 'tool_result', tool: 'read_file', toolCallId: 'call-2', output: { content: [{ type: 'text', text: 'not found' }] }, isError: true },
      { type: 'progress', text: 'No file.' },
      { ...usage, contextTokens: 1002 },
      { type: 'turn_end' },
    ]);
  });

  it('keeps a tool input past OAR\'s text cap whole and leaves a non-object input unknown', async () => {
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'tool-inputs' }, await ctx());
    expect((await turn(s)).slice(0, 2)).toEqual([
      { type: 'tool_use', tool: 'run_terminal_command', toolCallId: 'call-long', input: { command: `echo ${'a'.repeat(12_000)}; git push origin main` } },
      { type: 'tool_use', tool: 'run_terminal_command', toolCallId: 'call-text' },
    ]);
  });

  it('attributes the Grok subagent lifecycle and keeps its text distinct from the parent reply', async () => {
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'child' }, await ctx());
    const agentPath = ['fake-child'];
    const toolCallId = JSON.stringify([agentPath, 'child-call']);
    expect(await turn(s)).toEqual([
      { type: 'subagent_start', agentPath },
      { type: 'progress', text: 'child-says-hi', agentPath },
      { type: 'tool_use', tool: 'read_file', toolCallId, agentPath, input: {} },
      { type: 'tool_result', tool: 'read_file', toolCallId, agentPath, output: {} },
      { type: 'usage', inputTokens: 12, outputTokens: 3, contextTokens: 17, contextWindow: 1000, contextSource: 'provider', agentPath },
      { type: 'subagent_end', agentPath },
      { type: 'progress', text: 'parent-answer' }, usage, { type: 'turn_end' },
    ]);
  });

  it('runs a hosted terminal command and attaches task MCP servers on open', async () => {
    const resources = await ctx();
    const server = { command: process.execPath, args: ['mcp.js'], env: { MCP_TOKEN: 'mcp-fixture-secret-value' } };
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'terminal' }, { ...resources, mcpServers: { 'aiphabee-bot-chat': server } });
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'terminal:terminal-ok' }, usage, { type: 'turn_end' }]);
    expect(facts(resources.log).find(fact => fact.kind === 'open')?.params.mcpServers).toEqual([
      { name: 'aiphabee-bot-chat', command: process.execPath, args: ['mcp.js'], env: [{ name: 'MCP_TOKEN', value: 'mcp-fixture-secret-value' }] },
    ]);
  });

  it('sets the four compatibility variables on the agent process only when asked, and on no hosted terminal command (#634)', async () => {
    expect(() => adapter({ compatInstructions: 'off' as never })).toThrow(TypeError);
    for (const options of [{}, { compatInstructions: 'inherit' as const }]) {
      const plain = await ctx();
      await turn(await open(adapter(options), { target: GROK_TARGET, instruction: 'hello' }, plain));
      expect(Object.keys(facts(plain.log).find(fact => fact.kind === 'start')!.env).filter(name => name.startsWith('GROK_'))).toEqual(['GROK_DISABLE_AUTOUPDATER']);
    }
    const resources = await ctx();
    const s = await open(adapter({ compatInstructions: 'disabled' }), { target: GROK_TARGET, instruction: 'terminal-compat' }, resources);
    // The hosted terminal command keeps the task env: none of the four variables reaches it.
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'terminal:unset,unset,unset,unset' }, usage, { type: 'turn_end' }]);
    expect(facts(resources.log).find(fact => fact.kind === 'start')!.env).toMatchObject({
      GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0', GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_RULES_ENABLED: '0',
    });
  });

  it('resumes the exact native session and fails closed on a missing one', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'again', sessionRef: 'fake-grok-session' }, resources);
    expect(s.sessionRef).toBe('fake-grok-session');
    await turn(s);
    expect(facts(resources.log).find(fact => fact.kind === 'open')).toMatchObject({ method: 'session/resume', params: { sessionId: 'fake-grok-session' } });
    const missing = await startPreparedOperation(adapter(), { target: GROK_TARGET, instruction: 'again', sessionRef: 'gone' }, await ctx()).catch(error => error);
    expect(missing).toBeInstanceOf(RuntimeExecutionFailure);
    expect(missing).toMatchObject({ phase: 'start', retry: 'non-retryable' });
  });

  it.each([undefined, 'fake-grok-session'])('selects the per-task Grok model and effort before prompt (resume=%s)', async sessionRef => {
    const resources = await ctx({ FAKE_ACP_EFFORT_MENU: '1' });
    const runtime = adapter({ model: 'boot-model' });
    const target = { ...GROK_TARGET, selection: { mode: 'adapter-model', modelId: 'task-model' } } as const;
    await turn(await open(runtime, { target, instruction: 'hello', effort: 'high', sessionRef }, resources));
    const log = facts(resources.log);
    expect(log.find(row => row.kind === 'model')?.params.modelId).toBe('task-model');
    expect(log.find(row => row.kind === 'config')?.params).toMatchObject({ configId: 'reasoning_effort', value: 'high' });
    expect(log.findIndex(row => row.kind === 'config')).toBeLessThan(log.findIndex(row => row.kind === 'prompt'));
  });

  it.each([undefined, 'fake-grok-session'])('fails before prompting when Grok refuses effort (resume=%s)', async sessionRef => {
    const resources = await ctx({ FAKE_ACP_EFFORT_MENU: '1' });
    await expect(open(adapter(), { target: GROK_TARGET, instruction: 'hello', effort: 'refused', sessionRef }, resources))
      .rejects.toMatchObject({ phase: 'start', retry: 'non-retryable', failure: { class: 'invalid_request' } });
    expect(facts(resources.log).some(row => row.kind === 'prompt')).toBe(false);
  });

  it('selects the adapter model and fails closed on a refused model or login', async () => {
    const resources = await ctx();
    const s = await open(adapter({ model: 'grok-fixture' }), { target: GROK_TARGET, instruction: 'hello' }, resources);
    await turn(s);
    expect(facts(resources.log).find(fact => fact.kind === 'model')?.params).toMatchObject({ sessionId: 'fake-grok-session', modelId: 'grok-fixture' });
    const refusedModel = await startPreparedOperation(adapter({ model: 'no-such-model' }), { target: GROK_TARGET, instruction: 'x' }, await ctx()).catch(error => error);
    expect(refusedModel).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    const refusedLogin = await startPreparedOperation(adapter(), { target: GROK_TARGET, instruction: 'x' }, await ctx({ FAKE_ACP_AUTH: 'refuse' })).catch(error => error);
    expect(refusedLogin).toMatchObject({ phase: 'start', retry: 'non-retryable' });
  });

  it('rejects steer with the typed error and a follow-up that names a selection', async () => {
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'hello' }, await ctx());
    await turn(s);
    await expect(s.steer('x')).rejects.toBeInstanceOf(SteerUnsupportedError);
    await expect(s.followUp({ instruction: 'x', target: { lane: 'harness', harnessId: 'codex', selection: { mode: 'subscription', modelId: 'm' } } }))
      .rejects.toThrow('cannot change credential source');
  });

  it('interrupts through session/cancel and ends the turn with the cancelled answer', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'hold' }, resources);
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
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'own-turn' }, resources);
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
    await ownTurnStarted(s);
    await s.followUp({ target: GROK_TARGET, instruction: 'hello' });
    expect(prompts(resources.log)).toEqual(['own-turn']);
    await fs.writeFile(gate, '');
    // Grok's turn end is no task turn end; the drained prompt's turn_active has no input id and is the task's.
    // Grok's own ledger (50/5) is counted once, with the task turn's (100/7).
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'background' }, { type: 'progress', text: 'echo:hello' }, { ...usage, inputTokens: 150, outputTokens: 12, contextTokens: 1002 }, { type: 'turn_end' }]);
    expect(prompts(resources.log)).toEqual(['own-turn', 'hello']);
  });

  it('takes a held follow-up back on interrupt, so Grok never receives it', async () => {
    const gate = path.join(await tempDir(), 'gate');
    const resources = await ctx({ FAKE_ACP_OWN_TURN_GATE: gate });
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'own-turn' }, resources);
    await turn(s);
    await ownTurnStarted(s);
    await s.followUp({ target: GROK_TARGET, instruction: 'never-sent' });
    await s.interrupt();
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(false);
    expect(await turn(s)).toEqual([{ type: 'turn_end' }]);
    await fs.writeFile(gate, '');
    await s.followUp({ target: GROK_TARGET, instruction: 'hello' });
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
    expect(prompts(resources.log)).toEqual(['own-turn', 'hello']);
  });

  it('takes back a follow-up interrupted in the same tick, while its prompt is still in flight', async () => {
    const gate = path.join(await tempDir(), 'gate');
    const resources = await ctx({ FAKE_ACP_OWN_TURN_GATE: gate });
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'own-turn' }, resources);
    await turn(s);
    await ownTurnStarted(s);
    const f = s.followUp({ target: GROK_TARGET, instruction: 'never-sent' });
    await s.interrupt();
    await f;
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(false);
    expect(await turn(s)).toEqual([{ type: 'turn_end' }]);
    await fs.writeFile(gate, '');
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'own-ended')).toBe(true));
    expect(prompts(resources.log)).toEqual(['own-turn']);
  });

  it('holds a follow-up behind a Grok turn that OAR reports after the task turn closes', async () => {
    const gate = path.join(await tempDir(), 'gate');
    const resources = await ctx({ FAKE_ACP_OWN_TURN_GATE: gate });
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'own-turn-deferred' }, resources);
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
    await s.followUp({ target: GROK_TARGET, instruction: 'hello' });
    expect(prompts(resources.log)).toEqual(['own-turn-deferred']);
    await fs.writeFile(gate, '');
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'echo:hello' }, { ...usage, contextTokens: 1002 }, { type: 'turn_end' }]);
  });

  it('sends no cancel once Grok runs another prompt, and ends the task turn with its own answer (#1942)', async () => {
    const gate = path.join(await tempDir(), 'gate');
    const resources = await ctx({ FAKE_ACP_OWN_TURN_GATE: gate });
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'own-turn-switch' }, resources);
    const projection = (s as unknown as { projection: { sdkPromptSuperseded: boolean } }).projection;
    await vi.waitFor(() => expect(projection.sdkPromptSuperseded).toBe(true));
    const interrupted = s.interrupt();
    await fs.writeFile(gate, '');
    await interrupted;
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(false);
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
  });

  it('a replayed queue report naming another prompt does not stop the interrupt cancel (#1942)', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'replayed-queue' }, resources);
    const events = s.events[Symbol.asyncIterator]();
    // The draft follows the replayed report, so reading it proves the report was consumed.
    expect((await events.next()).value).toMatchObject({ type: 'message_draft_delta', text: 'first' });
    const projection = (s as unknown as { projection: GrokProjection }).projection;
    expect(projection.sdkPromptSuperseded).toBe(false);
    await s.interrupt();
    await events.return?.();
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(true);
  });
  it('cancels a held follow-up that the drain already sent', async () => {
    const gate = path.join(await tempDir(), 'gate');
    const resources = await ctx({ FAKE_ACP_OWN_TURN_GATE: gate });
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'own-turn' }, resources);
    await turn(s);
    await ownTurnStarted(s);
    await s.followUp({ target: GROK_TARGET, instruction: 'hold' });
    await fs.writeFile(gate, '');
    await vi.waitFor(() => expect(prompts(resources.log)).toEqual(['own-turn', 'hold']));
    await s.interrupt();
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(true);
    expect((await turn(s)).at(-1)).toEqual({ type: 'turn_end' });
  });

  it('fails the session on a Grok turn end while no turn is open', async () => {
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'stray-end' }, await ctx());
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
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'orphan-tool' }, { ...resources, env: { ...resources.env, FAKE_ACP_TOOL_TREE: treeFile } });
    await until(() => { try { return JSON.parse(readFileSync(treeFile, 'utf8')).grandchildPid > 0; } catch { return false; } });
    const { descendantPid: parent, grandchildPid: tool } = JSON.parse(readFileSync(treeFile, 'utf8')) as { descendantPid: number; grandchildPid: number };
    const toolIdentity = captureProcessIdentity(tool);
    try {
      const parentIdentity = captureProcessIdentity(parent);
      await s.interrupt();
      await until(() => !isProcessLive(parentIdentity));
      expect(alive(tool)).toBe(true);
      await s.close();
      expectProcessNotLive(toolIdentity);
    } finally {
      vi.useRealTimers();
      if (isProcessLive(toolIdentity)) process.kill(tool, 'SIGKILL');
    }
  });

  it('refuses the interrupt and sends no native cancel when the agent\'s descendants cannot be read first', async () => {
    vi.spyOn(processTree, 'rememberOwnedDescendants').mockImplementation(() => { throw new Error('Process table ps: timeout after 5000 ms'); });
    const resources = await ctx();
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'hold' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    await expect(s.interrupt()).rejects.toMatchObject({ message: 'grok interrupt refused: Process table ps: timeout after 5000 ms' });
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(false);
  });

  it('fails the session when the cancel is not answered within the interrupt bound', async () => {
    const resources = await ctx();
    const s = await open(adapter({ interruptTimeoutMs: 200 }), { target: GROK_TARGET, instruction: 'hold-silent' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    await expect(s.interrupt()).rejects.toThrow('grok interrupt timed out');
    expect(await failureOf(s)).toMatchObject({ phase: 'run', retry: 'non-retryable' });
  });

  it('maps prompt errors to semantic failures, retryable only when rate limited', async () => {
    const failed = await failureOf(await open(adapter(), { target: GROK_TARGET, instruction: 'fail' }, await ctx()));
    expect(failed).toMatchObject({ phase: 'run', retry: 'non-retryable', message: 'Internal error' });
    const limited = await failureOf(await open(adapter(), { target: GROK_TARGET, instruction: 'rate-limited' }, await ctx()));
    expect(limited).toMatchObject({ phase: 'run', retry: 'retryable' });
  });

  it('passes the vendored OAR failure class through, with the reason unchanged (#869)', async () => {
    const classOf = async (instruction: string) => {
      const failed = await failureOf(await open(adapter(), { target: GROK_TARGET, instruction }, await ctx()));
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
    expect((await failureOf(await open(adapter(), { target: GROK_TARGET, instruction: 'exit' }, await ctx())) as RuntimeExecutionFailure).failure).toEqual({ class: 'runtime_exited' });
    const refusedLogin = await startPreparedOperation(adapter(), { target: GROK_TARGET, instruction: 'x' }, await ctx({ FAKE_ACP_AUTH: 'refuse' })).catch(error => error);
    expect(refusedLogin).toMatchObject({ phase: 'start', failure: { class: 'auth' } });
    const refusedModel = await startPreparedOperation(adapter({ model: 'no-such-model' }), { target: GROK_TARGET, instruction: 'x' }, await ctx()).catch(error => error);
    expect(refusedModel).toMatchObject({ phase: 'start', failure: { class: 'model_unavailable' } });
  });

  it('marks an agent exit during the open runtime_exited, and an open it did not end unknown (#869)', async () => {
    await expect(startPreparedOperation(adapter(), { target: GROK_TARGET, instruction: 'x' }, await ctx({ FAKE_ACP_INITIALIZE: 'exit' }))).rejects.toMatchObject({
      phase: 'start', failure: { class: 'runtime_exited' },
    });
    // The kernel kills the agent itself after the refused initialize.
    await expect(startPreparedOperation(adapter(), { target: GROK_TARGET, instruction: 'x' }, await ctx({ FAKE_ACP_INITIALIZE: 'error' }))).rejects.toMatchObject({
      phase: 'start', message: 'Internal error', failure: { class: 'unknown' },
    });
  });

  it('sends unknown for a class OAR took from error text, keeping the retry it derives (#869)', async () => {
    const failed = await failureOf(await open(adapter(), { target: GROK_TARGET, instruction: 'fail-text:429 rate limit' }, await ctx()));
    expect(failed).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failed).toMatchObject({ phase: 'run', retry: 'retryable', message: 'Internal error: 429 rate limit' });
    expect((failed as RuntimeExecutionFailure).failure).toEqual({ class: 'unknown' });
  });

  it('elides the oldest native payloads past the retention limit and completes the turn (#1932)', async () => {
    const resources = await ctx();
    // 'huge' streams 256 KiB of text: the open fits the limit, the turn does not.
    const s = await open(adapter({ maxRetainedBytes: 64 * 1024 }), { target: GROK_TARGET, instruction: 'huge' }, resources);
    const events = await turn(s);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(events.some(e => e.type === 'progress' && e.text.length === 256 * 1024)).toBe(true);
    const records = (s as unknown as { raw: { records(): readonly { body: { elided?: true } }[] } }).raw.records();
    expect(records.some(record => record.body.elided === true)).toBe(true);
  });

  it('a failing record consumer fails the session although the kernel swallows observer errors', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'hold-silent' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    vi.spyOn(GrokProjection.prototype, 'consume').mockImplementation(() => { throw new Error('projection failed'); });
    // The cancel request is the next record: the failing consumer sees it.
    await s.interrupt().catch(() => {});
    expect(await failureOf(s)).toMatchObject({ message: 'projection failed' });
    await s.close();
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    if (process.platform !== 'win32') await vi.waitFor(() => expectProcessNotLive(started!.pid));
  });

  it('fails as infrastructure when the agent exits on its own', async () => {
    const failure = await failureOf(await open(adapter(), { target: GROK_TARGET, instruction: 'exit' }, await ctx()));
    expect(failure).toMatchObject({ message: 'grok agent exited' });
  });

  it('reports a failed terminal reap from close, even after the agent failed, and retries it', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'terminal-hang' }, resources);
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
    const s = await open(adapter(), { target: GROK_TARGET, instruction: 'hold-silent' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    const identity = captureProcessIdentity(started!.pid);
    await Promise.all([s.close(), s.close()]);
    await s.close();
    if (process.platform !== 'win32') expectProcessNotLive(identity);
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
    const s = await open(adapter({ agentUserMcpServers: 'excluded', compatInstructions: 'disabled' }), { target: GROK_TARGET, instruction: 'hello' }, resources);
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
    await turn(await open(adapter({ agentUserMcpServers: 'excluded', spawnFn }), { target: GROK_TARGET, instruction: 'hello' }, resources));
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
      const error = await startPreparedOperation(adapter({ agentUserMcpServers: 'excluded' }), { target: GROK_TARGET, instruction: 'hello' }, resources).catch(e => e);
      expect(error).toBeInstanceOf(RuntimeExecutionFailure);
      expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable', message: reason, failure: { class: 'unknown' } });
      expect(kinds(resources.log)).toEqual(['inspect']);
    }
  });

  it('changes nothing under inherit or for a task that is not an Agent task', async () => {
    for (const [options, agent] of [[{}, true], [{ agentUserMcpServers: 'inherit' as const, agentUserContext: 'inherit' as const }, true], [{ agentUserMcpServers: 'excluded' as const, agentUserContext: 'excluded' as const }, false]] as const) {
      const resources = agent ? await agentCtx() : await ctx();
      await turn(await open(adapter(options), { target: GROK_TARGET, instruction: 'hello' }, resources));
      expect(kinds(resources.log)).toEqual(['start']);
      expect(Object.keys(facts(resources.log).find(fact => fact.kind === 'start')!.env).filter(name => name.startsWith('GROK_'))).toEqual(['GROK_DISABLE_AUTOUPDATER']);
    }
  });
});

describe('GrokAdapter agentUserContext (#2239)', () => {
  const PREFIX = 'grok Agent user context exclusion refused';
  /** An Agent writer task whose user GROK_HOME holds a login, a config, instructions and rules. */
  async function agentCtx(env: NodeJS.ProcessEnv = {}, login = true) {
    const user = await tempDir('byok-grok-user-');
    await fs.mkdir(path.join(user, 'rules'));
    await Promise.all([
      ...(login ? [fs.writeFile(path.join(user, 'auth.json'), '{}')] : []),
      fs.writeFile(path.join(user, 'config.toml'), ''), fs.writeFile(path.join(user, 'AGENTS.md'), 'user'), fs.writeFile(path.join(user, 'rules', 'r.md'), 'rule'),
    ]);
    const resources = await ctx({ GROK_HOME: user, ...env });
    const home = await fs.realpath(resources.workspaceDir);
    return { ...resources, workspaceDir: home, agentHome: home, user };
  }

  it('validates the option and declares userInstructions only under excluded', () => {
    expect(() => adapter({ agentUserContext: 'strict' as never })).toThrow(new TypeError('GrokAdapterOptions.agentUserContext must be inherit or excluded'));
    expect(adapter().descriptor.capabilities.isolation?.userInstructions).toBe(false);
    expect(adapter({ agentUserContext: 'excluded' }).descriptor.capabilities.isolation?.userInstructions).toBe(true);
  });

  it('runs inspect and the agent in an SDK-owned GROK_HOME that links the login and configuration, and keeps sessions in the Agent home', async () => {
    const resources = await agentCtx();
    let seen: string[] = [];
    const spawnFn: typeof spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
      // The scratch home is released at close, so its entries are read while the agent starts.
      if (args[0] === 'agent') seen = readdirSync(String(options.env!.GROK_HOME)).sort().map(name => `${name}->${readlinkSync(path.join(String(options.env!.GROK_HOME), name))}`);
      return spawn(command, args, options);
    }) as typeof spawn;
    await turn(await open(adapter({ agentUserContext: 'excluded', spawnFn }), { target: GROK_TARGET, instruction: 'hello' }, resources));
    const user = await fs.realpath(resources.user);
    expect(seen).toEqual([
      `auth.json->${path.join(user, 'auth.json')}`, `config.toml->${path.join(user, 'config.toml')}`,
      `sessions->${path.join(resources.agentHome, '.byok', 'grok', 'sessions')}`,
    ]);
    const [inspect, started] = [facts(resources.log).find(fact => fact.kind === 'inspect')!, facts(resources.log).find(fact => fact.kind === 'start')!];
    expect(inspect.env.GROK_HOME).toBe(started.env.GROK_HOME);
    expect(started.env.GROK_HOME).not.toBe(resources.user);
    expect(started.env).toMatchObject({ GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0', GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_RULES_ENABLED: '0' });
  });

  const extra = JSON.stringify({ mcpServers: [], plugins: [], externalCompat: { cells: [] },
    projectInstructions: [{ path: '/rules/extra.md', scope: 'global', fileType: 'rules' }, { path: '/w/AGENTS.md', scope: 'project', fileType: 'agents_md' }] });
  it.each([
    ['inspect lists a user instruction file', { FAKE_ACP_INSPECT: extra }, true, 'Grok still loads 1 user instruction file outside the task, such as [paths] extra_rule_dirs'],
    ['inspect fails', { FAKE_ACP_INSPECT: 'fail' }, true, 'grok inspect failed'],
    ['the user GROK_HOME has no login', { XAI_API_KEY: 'host-key' }, false, 'the user GROK_HOME has no auth.json'],
  ] as const)('fails before the agent starts when %s', async (_, env, login, reason) => {
    const resources = await agentCtx(env, login);
    const error = await startPreparedOperation(adapter({ agentUserContext: 'excluded' }), { target: GROK_TARGET, instruction: 'hello' }, resources).catch(e => e);
    expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable', message: `${PREFIX}: ${reason}` });
    expect(existsSync(resources.log) && facts(resources.log).some(fact => fact.kind === 'start')).toBe(false);
  });

  it('judges each instruction by its own vendor, disabled and compatibilityStatus, never by its directory', async () => {
    const judge = (...entries: object[]) => grokUserInstructionsRefusal(JSON.stringify({ projectInstructions: entries.map(entry => ({ scope: 'global', ...entry })) }));
    const off = { vendor: 'claude', disabled: true, compatibilityStatus: 'disabled' };
    const loads = (n: number) => `${PREFIX}: Grok still loads ${n} user instruction file${n === 1 ? '' : 's'} outside the task, such as [paths] extra_rule_dirs`;
    expect(await judge({ path: '/home/u/.claude/CLAUDE.md', ...off }, { path: '/w/AGENTS.md', scope: 'project' })).toBeUndefined();
    // Grok 1.0.77 with extra_rule_dirs = ["~/.claude"]: the directory's files are listed without a vendor.
    expect(await judge({ path: '/home/u/.claude/extra.md', fileType: 'rules' }, { path: '/home/u/.claude/rules/c.md', ...off })).toBe(loads(1));
    expect(await judge({ path: '/home/u/.claude/extra.md', vendor: 'claude', disabled: false, compatibilityStatus: 'enabled' })).toBe(loads(1));
    // Contradictory or partial marks count as loaded.
    expect(await judge({ path: '/a', vendor: 'claude', disabled: true, compatibilityStatus: 'enabled' }, { path: '/b', vendor: 'cursor', compatibilityStatus: 'disabled' }, { path: '/c', vendor: 'grok', disabled: true, compatibilityStatus: 'disabled' })).toBe(loads(3));
    expect(await judge({ path: '/a', vendor: 'claude', disabled: 'yes' })).toBe(`${PREFIX}: grok inspect failed`);
    expect(await grokUserInstructionsRefusal('{"mcpServers":[]}')).toBe(`${PREFIX}: grok inspect failed`);
  });

  it('refuses on Windows before it creates the home or any link', async () => {
    const resources = await agentCtx();
    const dir = await tempDir('byok-grok-sdk-');
    await expect(createGrokAgentHome({ GROK_HOME: resources.user }, dir, resources.agentHome, 'win32')).rejects.toMatchObject({
      phase: 'start', retry: 'non-retryable', message: `${PREFIX}: the SDK-owned GROK_HOME is not supported on Windows` });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('keeps a login Grok wrote over the link in the execution scratch, and refuses every Grok start until it is gone', async () => {
    const resources = await agentCtx(), owner = testScratchOwner(), first = await owner.create();
    const s = await open(adapter({ agentUserContext: 'excluded' }), { target: GROK_TARGET, instruction: 'hello' }, { ...resources, scratch: first });
    await turn(s);
    // A refresh written by rename leaves a regular file where the link was.
    const auth = path.join(first.sdkDir, 'grok-home', 'auth.json');
    await fs.unlink(auth);
    await fs.writeFile(auth, 'refreshed', { mode: 0o600 });
    await expect(s.close()).rejects.toMatchObject({ name: 'RuntimeDisposalFailure', stage: 'cleanup', message: expect.stringContaining(auth) });
    expect(await fs.readFile(auth, 'utf8')).toBe('refreshed');
    expect((await fs.stat(auth)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(auth))).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(path.join(resources.user, 'auth.json'), 'utf8')).toBe('{}');
    // Any Grok task on the device refuses, here one that inherits the user context.
    const refused = await startPreparedOperation(adapter(), { target: GROK_TARGET, instruction: 'hello' }, { ...resources, scratch: await owner.create() }).catch(e => e);
    expect(refused).toMatchObject({ phase: 'start', retry: 'non-retryable', message: `grok start refused: a login Grok wrote over the linked auth.json is held at ${auth}; ${HELD_LOGIN_RESOLUTION}; until then every Grok task on this device refuses` });
    await fs.rm(auth);
    await turn(await open(adapter(), { target: GROK_TARGET, instruction: 'hello' }, { ...resources, scratch: await owner.create() }));
    await expect(s.close()).resolves.toBeUndefined();
    expect(existsSync(first.sdkDir)).toBe(false);
  });

  it('refuses a session store that is not a real directory inside the Agent home', async () => {
    const resources = await agentCtx();
    await fs.mkdir(path.join(resources.agentHome, '.byok'), { recursive: true });
    await fs.symlink(resources.user, path.join(resources.agentHome, '.byok', 'grok'), 'dir');
    const error = await startPreparedOperation(adapter({ agentUserContext: 'excluded' }), { target: GROK_TARGET, instruction: 'hello' }, resources).catch(e => e);
    expect(error).toMatchObject({ phase: 'start', retry: 'non-retryable', message: `${PREFIX}: the Agent home session store is not a real directory inside the Agent home` });
  });
  it('starts every agent with GROK_DISABLE_AUTOUPDATER=1, which the task env cannot override (#2269)', async () => {
    const modes = [
      [{}, false], [{ compatInstructions: 'disabled' as const }, false], [{}, true], [{ agentUserMcpServers: 'excluded' as const }, true],
      [{ agentUserContext: 'excluded' as const }, true], [{ agentUserMcpServers: 'excluded' as const, agentUserContext: 'excluded' as const }, true],
    ] as const;
    for (const value of ['0', '']) {
      for (const [options, agent] of modes) {
        const resources = agent ? await agentCtx({ GROK_DISABLE_AUTOUPDATER: value }) : await ctx({ GROK_DISABLE_AUTOUPDATER: value });
        await turn(await open(adapter(options), { target: GROK_TARGET, instruction: 'hello' }, resources));
        expect(facts(resources.log).find(fact => fact.kind === 'start')!.env.GROK_DISABLE_AUTOUPDATER, JSON.stringify({ options, agent, value })).toBe('1');
      }
    }
  });
});

const AGY_TARGET = { lane: 'harness', harnessId: 'agy', selection: { mode: 'byok', providerId: 'google', modelId: 'gemini-3.8-flash' } } as const;

describe('AgyAdapter', () => {
  it('owns a home that is not the user\'s and refuses an upstream carrying credentials', () => {
    expect(() => new AgyAdapter({ resolveKey: async () => 'agy-task-resolver-key-fixture', home: 'relative' })).toThrow(/absolute/);
    expect(() => new AgyAdapter({ resolveKey: async () => 'agy-task-resolver-key-fixture', home: os.homedir() })).toThrow(/user's home/);
    expect(() => new AgyAdapter({ resolveKey: async () => 'agy-task-resolver-key-fixture', home: path.join(os.homedir(), '.gemini', 'x') })).toThrow(/user's home/);
    expect(() => agyAdapterWithEndpoint(new AgyAdapter({ resolveKey: async () => 'agy-task-resolver-key-fixture', home: '/owned' }), 'http://user:pw@127.0.0.1:9')).toThrow(/credentials/);
    expect(() => agyAdapterWithEndpoint(new AgyAdapter({ resolveKey: async () => 'agy-task-resolver-key-fixture', home: '/owned' }), 'http://127.0.0.1:9?key=x')).toThrow(/query/);
    expect(() => new AgyAdapter({ home: '/owned' } as AgyAdapterOptions)).toThrow(/resolveKey must be a function/);
    expect(new AgyAdapter({ resolveKey: async () => 'agy-task-resolver-key-fixture', home: '/owned' }).descriptor).toMatchObject({ id: 'agy', platforms: ['darwin', 'linux', 'win32'] });
  });

  it('#2469: detect(signal) rethrows a pre-aborted reason before writing the home', async () => {
    const home = await agyVersion('1.5.0');
    const reason = new Error('offer cancelled');
    await expect(agy(home).detect(AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(existsSync(path.join(home, '.gemini'))).toBe(false);
  });

  it('#2469: prepare() launches the command its observation probed, even when the resolver now answers another', async () => {
    const home = await agyVersion('1.5.18');
    let calls = 0;
    const resolveBin = () => ({ command: calls++ % 2 === 0 ? fixture : path.join(os.tmpdir(), 'byok-no-such-agy-b'), source: 'path' as const });
    const runtime = agy(home, { resolveBin });
    const detected = await runtime.detect();
    expect(detected).toMatchObject({ kind: 'available', executablePath: fixture });
    expect(await turn(await open(runtime, { target: AGY_TARGET, instruction: 'hello' }, { ...await agyCtx(), detected }))).toContainEqual({ type: 'turn_end' });
    expect(calls).toBe(1);
    calls = 0;
    expect(await turn(await open(runtime, { target: AGY_TARGET, instruction: 'hello' }, await agyCtx()))).toContainEqual({ type: 'turn_end' });
    expect(calls).toBe(1);
  });

  it('#2469: a plain object never skips the version refusal', async () => {
    const home = await agyVersion('1.4.9');
    expect(await agy(home).prepare({ offer: { target: AGY_TARGET, instruction: 'x' }, descriptor: agy(home).descriptor, requiredToolsetIds: [], detected: { kind: 'available', version: '1.5.18' } }))
      .toEqual({ kind: 'reject', reason: 'agy installation refused: acp_unavailable', retryable: false });
  });

  it('#2469: prepare() reuses the admission observation of the same executable and otherwise probes afresh', async () => {
    const home = await agyVersion('1.5.0');
    const log = path.join(await tempDir(), 'probes');
    vi.stubEnv('FAKE_ACP_PROBE_LOG', log);
    const runtime = agy(home);
    const detected = await runtime.detect();
    if (detected.kind !== 'available') throw new Error('fixture agy is unavailable');
    expect(await readProbes(log)).toEqual(['--version']);
    const input = { offer: { target: AGY_TARGET, instruction: 'x' }, descriptor: runtime.descriptor, requiredToolsetIds: [] };
    expect(await runtime.prepare({ ...input, detected })).toMatchObject({ kind: 'prepared', detected: { version: detected.version } });
    expect(await readProbes(log)).toEqual([]);
    expect(await runtime.prepare(input)).toMatchObject({ kind: 'prepared' });
    expect(await readProbes(log)).toEqual(['--version']);
  });

  it('detect refuses a CLI without native ACP, a prerelease and an extra notice, and writes the native settings', async () => {
    const home = await agyVersion('1.4.9');
    expect(await agy(home).detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable', unsupportedVersion: { installedVersion: '1.4.9', requiredVersion: '1.5.0' } });
    vi.stubEnv('FAKE_ACP_VERSION', '1.5.0-rc.1');
    expect(await agy(home).detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable', unsupportedVersion: { installedVersion: '1.5.0-rc.1', requiredVersion: '1.5.0' } });
    vi.stubEnv('FAKE_ACP_VERSION', '1.5.0\nupdate available');
    expect(await agy(home).detect()).toEqual({ kind: 'refused', reason: 'acp_unavailable', unsupportedVersion: { requiredVersion: '1.5.0' } });
    vi.stubEnv('FAKE_ACP_VERSION', '1.5.0');
    const resolveKey = vi.fn(async () => 'agy-task-resolver-key-fixture');
    const result = await agy(home, { resolveKey }).detect();
    expect(result).toMatchObject({ kind: 'available', version: '1.5.0' });
    expect(result).not.toHaveProperty('authPresent');
    expect(resolveKey).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')))
      .toEqual({ modelProvider: 'gemini', setupComplete: true, onboardingComplete: true });
  });

  it('projects the native Antigravity quota reset into the runtime failure', async () => {
    const adapter = agy(await agyVersion('1.5.18'));
    const before = Date.now();
    const error = await failureOf(await open(adapter, { target: AGY_TARGET, instruction: 'agy-quota' }, await agyCtx()));
    expect(error).toBeInstanceOf(RuntimeExecutionFailure);
    const failure = (error as RuntimeExecutionFailure).failure;
    expect(failure).toMatchObject({ class: 'quota', resetsAt: expect.any(String) });
    const reset = Date.parse(failure.class === 'quota' && typeof failure.resetsAt === 'string' ? failure.resetsAt : '');
    const delay = 3_723_000;
    expect(reset).toBeGreaterThanOrEqual(before + delay);
    expect(reset).toBeLessThanOrEqual(Date.now() + delay);
  });

  it('runs agy on the owned home behind the local proxy, with a session token in place of the key', async () => {
    const home = await agyVersion('1.5.18');
    vi.stubEnv('GEMINI_API_KEY', 'host-key');
    vi.stubEnv('GOOGLE_API_KEY', 'host-key-2');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://elsewhere.test');
    vi.stubEnv('AGY_ADC_AUTH', '1');
    const resources = await agyCtx({ FAKE_ACP_MODEL_CATALOG: 'gemini-3.5-pro,gemini-3.8-flash', GEMINI_HOME: '/user/.gemini', XDG_CONFIG_HOME: '/user/.config', XDG_RUNTIME_DIR: '/run/user/1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus', APPDATA: '/user/roaming' });
    const s = await open(agy(home, { model: 'gemini-3.8-flash' }), { target: AGY_TARGET, instruction: 'hello' }, resources);
    expect(await turn(s)).toEqual([{ type: 'progress', text: 'echo:hello' }, { type: 'turn_end' }]);
    const start = facts(resources.log).find(fact => fact.kind === 'start')!;
    expect(start.argv).toEqual(['acp', '--dangerously-skip-permissions', '--process-per-session', '--gemini-dir', path.join(home, '.gemini'), '--disable-telemetry']);
    expect(start.env).toMatchObject({
      HOME: home, USERPROFILE: home, GEMINI_HOME: path.join(home, '.gemini'), AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    });
    expect(start.env.GOOGLE_GEMINI_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(start.env.GEMINI_API_KEY).toMatch(/^[\w-]{43}$/);
    expect(start.env.GEMINI_API_KEY).not.toBe('ambient-task-key');
    expect(JSON.stringify(start.env)).not.toContain('agy-task-resolver-key-fixture');
    expect(process.env.GEMINI_API_KEY).toBe('host-key');
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
    const home = await agyVersion('1.5.18');
    const s = await open(agy(home), { target: AGY_TARGET, instruction: 'agy-tools' }, { ...await agyCtx(), mcpToolsetTools: { 'market.feed': mcpServer('market.feed', 'quote') } });
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
    const home = await agyVersion('1.5.18');
    const failure = await open(agy(home), { target: AGY_TARGET, instruction: 'hello' }, { ...await agyCtx(), mcpServers: { host: { command: 'server', env: { TOKEN: 'x' } } } }).catch(error => error);
    expect(failure).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    expect(String(failure.message)).toContain('it attaches no entry with env or headers');
  });

  it.each([undefined, 'fake-grok-session'])('uses the per-task Antigravity model and effort (resume=%s)', async sessionRef => {
    const home = await agyVersion('1.5.18');
    const resources = await agyCtx({ FAKE_ACP_MODEL_CATALOG: 'boot-model,task-model', FAKE_ACP_EFFORT_MENU: '1' });
    resources.env.FAKE_ACP_LISTED_CWD = resources.workspaceDir;
    const runtime = agy(home, { model: 'boot-model' });
    const target = { ...AGY_TARGET, selection: { ...AGY_TARGET.selection, modelId: 'task-model' } };
    await turn(await open(runtime, { target, instruction: 'hello', effort: 'high', sessionRef }, resources));
    expect(facts(resources.log).filter(row => row.kind === 'config').map(row => row.params.value)).toEqual(['task-model', 'high']);
  });

  it('resumes only on a listed saved cwd', async () => {
    const home = await agyVersion('1.5.18');
    const unlisted = await open(agy(home), { target: AGY_TARGET, instruction: 'again', sessionRef: 'fake-grok-session' }, await agyCtx()).catch(error => error);
    expect(unlisted).toMatchObject({ phase: 'start', retry: 'non-retryable' });
    const resources = await agyCtx();
    const s = await open(agy(home), { target: AGY_TARGET, instruction: 'again', sessionRef: 'fake-grok-session' }, { ...resources, env: { ...resources.env, FAKE_ACP_LISTED_CWD: resources.workspaceDir } });
    expect(s.sessionRef).toBe('fake-grok-session');
    expect(facts(resources.log).find(fact => fact.kind === 'open')).toMatchObject({ method: 'session/resume' });
  });

  it('appends the persona only for a reader, and again on resume, because agy replaces its append on every open', async () => {
    const home = await agyVersion('1.5.18');
    const agentHome = await fs.realpath(await tempDir('byok-agy-home-'));
    await fs.writeFile(path.join(agentHome, 'AGENTS.md'), 'Persona rules');
    const run = path.join(agentHome, '.byok', 'runs', 'run-1');
    await fs.mkdir(run, { recursive: true });
    const reader = await agyCtx();
    await turn(await open(agy(home), { target: AGY_TARGET, instruction: 'again', sessionRef: 'fake-grok-session' }, {
      ...reader, workspaceDir: run, reader: { canonicalHome: agentHome }, env: { ...reader.env, FAKE_ACP_LISTED_CWD: run },
    }));
    expect(facts(reader.log).find(fact => fact.kind === 'open')?.params._meta).toEqual({ antigravity: { systemPrompt: { append: 'Persona rules' } } });
    const writer = await agyCtx();
    await turn(await open(agy(home), { target: AGY_TARGET, instruction: 'hello' }, { ...writer, workspaceDir: agentHome, agentHome }));
    expect(facts(writer.log).find(fact => fact.kind === 'open')?.params._meta).toBeUndefined();
  });

  it('fails a task without a key as authority, and one whose proxy cannot start as retryable, before agy runs', async () => {
    const home = await agyVersion('1.5.18');
    const resources = await agyCtx();
    expect(await open(agy(home, { resolveKey: async () => '' }), { target: AGY_TARGET, instruction: 'hello' }, resources).catch(error => error)).toMatchObject({
      phase: 'start', retry: 'non-retryable', failure: { class: 'auth' }, message: expect.stringContaining('at least 20 characters'),
    });
    const refused = await agyCtx();
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
      process.nextTick(() => this.emit('error', new Error('no port')));
      return this;
    });
    expect(await open(agy(home), { target: AGY_TARGET, instruction: 'hello' }, refused).catch(error => error)).toMatchObject({ phase: 'start', retry: 'retryable' });
    listen.mockRestore();
    expect(existsSync(resources.log) || existsSync(refused.log)).toBe(false);
  });

  it('rejects a key Node cannot send as an HTTP header before allocating the proxy', async () => {
    const home = await agyVersion('1.5.18');
    const resources = await agyCtx();
    const listen = vi.spyOn(Server.prototype, 'listen');
    try {
      await expect(open(agy(home, { resolveKey: async () => 'invalid-💥-http-header-key-fixture' }), { target: AGY_TARGET, instruction: 'hello' }, resources)).rejects.toMatchObject({
        phase: 'start', retry: 'non-retryable', failure: { class: 'auth' }, message: 'agy provider API key resolution failed',
      });
      expect(listen).not.toHaveBeenCalled();
      expect(existsSync(resources.log)).toBe(false);
    } finally {
      listen.mockRestore();
    }
  });

  it('closes a proxy whose listener opens after startup is cancelled', async () => {
    const home = await agyVersion('1.5.18');
    const resources = await agyCtx();
    const controller = new AbortController();
    const closing = vi.spyOn(Server.prototype, 'close');
    const listen = Server.prototype.listen;
    const listening = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server, ...args: unknown[]) {
      controller.abort();
      return Reflect.apply(listen, this, args) as Server;
    });
    try {
      await expect(open(agy(home), { target: AGY_TARGET, instruction: 'hello' }, { ...resources, signal: controller.signal })).rejects.toThrow('agy start was aborted');
      expect(closing).toHaveBeenCalledOnce();
      expect(existsSync(resources.log)).toBe(false);
    } finally {
      listening.mockRestore();
      closing.mockRestore();
    }
  });

  it('closes the proxy when agy exits', async () => {
    const resources = await agyCtx();
    await turn(await open(agy(await agyVersion('1.5.18')), { target: AGY_TARGET, instruction: 'hello' }, resources));
    const start = facts(resources.log).find(fact => fact.kind === 'start')!;
    await expect(fetch(start.env.GOOGLE_GEMINI_BASE_URL)).rejects.toThrow();
  });

  it('still sends session/close and disposes the process and proxy when the process table cannot be read at the stop, and stops again on the close', async () => {
    const home = await agyVersion('1.5.18');
    const observe = vi.spyOn(processTree, 'rememberOwnedDescendants').mockImplementation(() => { throw new Error('Process table ps: timeout after 5000 ms'); });
    const resources = await agyCtx();
    const s = await open(agy(home), { target: AGY_TARGET, instruction: 'hello' }, resources);
    expect(await failureOf(s)).toMatchObject({ message: 'Process table ps: timeout after 5000 ms' });
    expect(facts(resources.log).some(fact => fact.kind === 'close')).toBe(true);
    const start = facts(resources.log).find(fact => fact.kind === 'start')!;
    expectProcessNotLive(start.pid);
    await expect(fetch(start.env.GOOGLE_GEMINI_BASE_URL)).rejects.toThrow();
    await s.close();
    expect(observe).toHaveBeenCalledTimes(2); // The failed stop is not remembered: the close stops again.
  });

  it('leases a resumed session against the store sweep, and only that session', async () => {
    const adapter = agy(await agyVersion('1.5.18'));
    const store = agySessionStoreOf(adapter)!;
    const prepared = await adapter.prepare({ offer: { target: AGY_TARGET, instruction: 'x' } } as never);
    if (prepared.kind !== 'prepared') throw new Error('agy did not prepare');
    const lease = await prepared.operation.acquireSessionLease!('session-a');
    await expect(acquireAgySessionRetention(store, 'session-a')).rejects.toBeInstanceOf(PathMutationGateBusyError);
    await (await acquireAgySessionRetention(store, 'session-b')).release();
    await lease!.release();
  });

  it('kills a daemon that left the process group before it reports turn_end', async () => {
    const home = await agyVersion('1.5.18');
    const resources = await agyCtx();
    const pidFile = path.join(resources.workspaceDir, 'daemon.pid');
    const remember = processTree.rememberOwnedDescendants;
    let daemon: ProcessIdentity | undefined;
    const observe = vi.spyOn(processTree, 'rememberOwnedDescendants').mockImplementation(child => {
      if (daemon === undefined && existsSync(pidFile)) daemon = captureProcessIdentity(Number(readFileSync(pidFile, 'utf8')));
      remember(child);
    });
    try {
      const s = await open(agy(home), { target: AGY_TARGET, instruction: `agy-daemon:${pidFile}` }, resources);
      for await (const event of s.events) if (event.type === 'turn_end') break;
      if (daemon === undefined) throw new Error('The daemon was never observed before disposal');
      expectProcessNotLive(daemon);
      await expect(s.followUp({ target: AGY_TARGET, instruction: 'x' })).rejects.toBeInstanceOf(PolicyUnsupportedError);
    } finally {
      observe.mockRestore();
    }
  });

  it('answers a writer with allow_once, and fails a reader the model never answered after a reject_once', async () => {
    const home = await agyVersion('1.5.18');
    const outside = path.join(os.tmpdir(), 'byok-agy-outside.txt');
    const writer = await agyCtx();
    await turn(await open(agy(home), { target: AGY_TARGET, instruction: `agy-ask:edit:${outside}` }, writer));
    expect(facts(writer.log).find(fact => fact.kind === 'permission')?.answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    const agentHome = await fs.realpath(await tempDir('byok-agy-home-'));
    const run = path.join(agentHome, '.byok', 'runs', 'adapter-unit-test');
    await fs.mkdir(run, { recursive: true });
    const reader = (resources: Awaited<ReturnType<typeof ctx>>) => ({ ...resources, workspaceDir: run, reader: { canonicalHome: agentHome } });
    const read = await agyCtx();
    await turn(await open(agy(home), { target: AGY_TARGET, instruction: `agy-ask:read:${path.join(agentHome, 'MEMORY.md')}` }, reader(read)));
    expect(facts(read.log).find(fact => fact.kind === 'permission')?.answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    const write = await agyCtx();
    const failure = await failureOf(await open(agy(home), { target: AGY_TARGET, instruction: `agy-ask:edit:${path.join(agentHome, 'MEMORY.md')}` }, reader(write)));
    expect(failure).toMatchObject({ retry: 'non-retryable', message: expect.stringContaining('refused write') });
    expect(facts(write.log).find(fact => fact.kind === 'permission')?.answer).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('steers the active turn through ACP', async () => {
    const home = await agyVersion('1.5.18');
    const resources = await agyCtx();
    const s = await open(agy(home), { target: AGY_TARGET, instruction: 'steer-first' }, resources);
    await s.steer('steer-second');
    await turn(s);
    expect(facts(resources.log).filter(fact => fact.kind === 'prompt').map(fact => fact.text)).toContain('steer-second');
  });

  it('refuses an input past agy\'s 185,000-byte bound before the call, with OAR\'s input_too_large class', async () => {
    const resources = await agyCtx();
    const instruction = 'x'.repeat(185_001);
    await expect(startPreparedOperation(agy(await agyVersion('1.5.18')), { target: AGY_TARGET, instruction }, resources)).rejects.toMatchObject({
      phase: 'start', retry: 'non-retryable', failure: { class: 'input_too_large' },
      message: "input is 185001 bytes, over OAR's 185000-byte bound for one input to this runtime, which cuts a longer one without saying so",
    });
    expect(facts(resources.log).filter(fact => fact.kind === 'prompt')).toEqual([]);
  });

  it('refuses a steer after the turn ends as an infrastructure failure', async () => {
    const s = await open(agy(await agyVersion('1.5.18')), { target: AGY_TARGET, instruction: 'hello' }, await agyCtx());
    await turn(s);
    await expect(s.steer('late')).rejects.toMatchObject({ message: 'runtime exited' });
  });
});

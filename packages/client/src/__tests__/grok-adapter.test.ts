import { fileURLToPath } from 'node:url';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { SteerUnsupportedError, type Session } from '../types';
import { RuntimeDisposalFailure, RuntimeExecutionFailure } from '../runtime-failure';
import * as processTree from '../adapters/process-tree';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { GrokProjection } from '../adapters/grok/projection';

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
async function open(a: GrokAdapter, offer: TaskOfferPayload, resources: PreparedOperationResources): Promise<Session> {
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
      advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '1.0.52' },
    });
  });

  it('reads only the existence of $GROK_HOME/auth.json', async () => {
    const home = await tempDir();
    vi.stubEnv('XAI_API_KEY', '');
    vi.stubEnv('GROK_HOME', home);
    vi.stubEnv('FAKE_ACP_VERSION', 'grok 1.0.52 (fixture)');
    expect(await adapter().detect()).toEqual({ kind: 'available', version: 'grok 1.0.52 (fixture)', authPresent: false });
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
      capabilities: { steer: false, resume: true, approvalInteractive: false, mcpToolsets: true, messageDraft: true },
    });
    const prepared = await a.prepare({
      offer: { instruction: 'x', dispatchSelection: { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'm' } },
      descriptor: a.descriptor, requiredToolsetIds: [],
    });
    expect(prepared).toEqual({ kind: 'reject', reason: 'grok cannot execute a dispatch selection', retryable: false });
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
      { type: 'tool_use', tool: 'run_terminal_command', toolCallId: 'call-1', input: '{"command":"ls"}' },
      { type: 'tool_result', tool: 'run_terminal_command', toolCallId: 'call-1', output: { content: [{ type: 'text', text: 'a.txt' }], exitCode: 0 } },
      { type: 'progress', text: 'Found a.txt.' },
      usage,
      { type: 'turn_end' },
    ]);
    await s.followUp({ instruction: 'tool-failed' });
    expect(await turn(s)).toEqual([
      { type: 'tool_use', tool: 'read_file', toolCallId: 'call-2', input: '{"path":"missing"}' },
      { type: 'tool_result', tool: 'read_file', toolCallId: 'call-2', output: { content: [{ type: 'text', text: 'not found' }] }, isError: true },
      { type: 'progress', text: 'No file.' },
      { ...usage, contextTokens: 1002 },
      { type: 'turn_end' },
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
    expect(missing).toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable' });
  });

  it('selects the adapter model and fails closed on a refused model or login', async () => {
    const resources = await ctx();
    const s = await open(adapter({ model: 'grok-fixture' }), { instruction: 'hello' }, resources);
    await turn(s);
    expect(facts(resources.log).find(fact => fact.kind === 'model')?.params).toMatchObject({ sessionId: 'fake-grok-session', modelId: 'grok-fixture' });
    const refusedModel = await startPreparedOperation(adapter({ model: 'no-such-model' }), { instruction: 'x' }, await ctx()).catch(error => error);
    expect(refusedModel).toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable' });
    const refusedLogin = await startPreparedOperation(adapter(), { instruction: 'x' }, await ctx({ FAKE_ACP_AUTH: 'refuse' })).catch(error => error);
    expect(refusedLogin).toMatchObject({ phase: 'start', category: 'authority', retry: 'non-retryable' });
  });

  it('rejects steer with the typed error and a follow-up that names a selection', async () => {
    const s = await open(adapter(), { instruction: 'hello' }, await ctx());
    await turn(s);
    await expect(s.steer('x')).rejects.toBeInstanceOf(SteerUnsupportedError);
    await expect(s.followUp({ instruction: 'x', dispatchSelection: { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'm' } }))
      .rejects.toThrow('takes no dispatch selection');
    await expect(s.resolveApproval(true)).rejects.toThrow('no interactive approval');
  });

  it('interrupts through session/cancel and ends the turn with the cancelled answer', async () => {
    const resources = await ctx();
    const s = await open(adapter(), { instruction: 'hold' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    await s.interrupt();
    expect(facts(resources.log).some(fact => fact.kind === 'cancel')).toBe(true);
    expect(await turn(s)).toEqual([usage, { type: 'turn_end' }]);
  });

  it('fails the session when the cancel is not answered within the interrupt bound', async () => {
    const resources = await ctx();
    const s = await open(adapter({ interruptTimeoutMs: 200 }), { instruction: 'hold-silent' }, resources);
    await vi.waitFor(() => expect(facts(resources.log).some(fact => fact.kind === 'prompt')).toBe(true));
    await expect(s.interrupt()).rejects.toThrow('grok interrupt timed out');
    expect(await failureOf(s)).toMatchObject({ category: 'infrastructure' });
  });

  it('maps prompt errors to semantic failures, retryable only when rate limited', async () => {
    const failed = await failureOf(await open(adapter(), { instruction: 'fail' }, await ctx()));
    expect(failed).toMatchObject({ phase: 'run', category: 'semantic', retry: 'non-retryable', message: 'Internal error' });
    const limited = await failureOf(await open(adapter(), { instruction: 'rate-limited' }, await ctx()));
    expect(limited).toMatchObject({ phase: 'run', category: 'semantic', retry: 'retryable' });
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
    // A -32603 with no retry_state, or with an error_type OAR does not map, names no cause:
    // OAR's text rule reads "Internal error" as `provider`, which is not structured evidence.
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
      phase: 'start', category: 'infrastructure', failure: { class: 'runtime_exited' },
    });
    // The kernel kills the agent itself after the refused initialize.
    await expect(startPreparedOperation(adapter(), { instruction: 'x' }, await ctx({ FAKE_ACP_INITIALIZE: 'error' }))).rejects.toMatchObject({
      phase: 'start', message: 'Internal error', failure: { class: 'unknown' },
    });
  });

  it('sends unknown for a class OAR took from error text, keeping the retry it derives (#869)', async () => {
    const failed = await failureOf(await open(adapter(), { instruction: 'fail-text:429 rate limit' }, await ctx()));
    expect(failed).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failed).toMatchObject({ phase: 'run', category: 'semantic', retry: 'retryable', message: 'Internal error: 429 rate limit' });
    expect((failed as RuntimeExecutionFailure).failure).toEqual({ class: 'unknown' });
  });

  it('fails the session and ends the agent when retained records exceed the byte budget', async () => {
    const resources = await ctx();
    // 'huge' streams 256 KiB of text: the open fits the budget, the turn does not.
    const failure = await open(adapter({ maxRetainedBytes: 64 * 1024 }), { instruction: 'huge' }, resources)
      .then(failureOf, (error) => error);
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ category: 'infrastructure', message: 'grok retained record byte budget exceeded' });
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
    expect(await failureOf(s)).toMatchObject({ category: 'infrastructure', message: 'projection failed' });
    await s.close();
    const [started] = facts(resources.log).filter(fact => fact.kind === 'start');
    if (process.platform !== 'win32') await vi.waitFor(() => expect(() => process.kill(started!.pid, 0)).toThrow());
  });

  it('fails as infrastructure when the agent exits on its own', async () => {
    const failure = await failureOf(await open(adapter(), { instruction: 'exit' }, await ctx()));
    expect(failure).toMatchObject({ category: 'infrastructure', message: 'grok agent exited' });
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

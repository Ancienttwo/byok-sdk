import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import type { CloudDoErrorCode } from '../src/errors';

const KEY = 'Primary~0123456789ABCDEFGHIJKLMNOP';
const SECONDARY = 'Secondary~0123456789QRSTUVWXYZabcd';
const SKILL = 'load_financial_analysis_skill';
const SAFE_PREFIX = 'The request is reading trusted financial analysis guidance. '.repeat(12);
interface ToolCall { name: string; args: Record<string, unknown>; id?: string }
interface ProviderMessage { role: string; content: string; tool_calls?: unknown[] }
interface ProviderBody { messages: ProviderMessage[]; tools?: { function: { name: string; parameters: unknown } }[] }
interface ProviderCall { url: string; body: ProviderBody }
interface ProviderScenario {
  calls?: ToolCall[][];
  wire?: string;
  prefix?: boolean;
  repeatedSkill?: boolean;
  finalAt?: number;
}
let mf: Miniflare;
let script: string;
let persist: string;
let serial = 0;
let instructions = '';
let scenario: ProviderScenario = {};
const calls: ProviderCall[] = [];
const logs: string[] = [];
class AuditLog extends Log { constructor() { super(LogLevel.ERROR); } protected override log(message: string) { logs.push(message); } }
const sse = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const done = 'data: [DONE]\n\n';
function wireToolCalls(tools: ToolCall[]) {
  return sse({ tool_calls: tools.map((call, index) => ({ index, id: call.id ?? `raw_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls') + done;
}
function runtime() {
  return new Miniflare({ resourcePersistencePath: persist, log: new AuditLog(), workers: [{ config: {
    name: 'cloud-session-runtime', type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
    exports: { SessionAuditDO: { type: 'durable-object', storage: 'sqlite' } },
    env: { AGENTS: { type: 'durable-object', workerName: 'cloud-session-runtime', exportName: 'SessionAuditDO' },
      AIPHABEE_ZAI_API_KEY: { type: 'text', value: KEY }, AIPHABEE_DEEPSEEK_API_KEY: { type: 'text', value: SECONDARY } },
  }, dev: { outboundService: { type: 'node-handler', handler: async (request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    for await (const chunk of request) text += chunk.toString();
    const body = JSON.parse(text) as ProviderBody;
    const index = calls.length;
    calls.push({ url: String(request.headers['mf-original-url']), body });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (scenario.wire !== undefined && index === 0) { response.end(scenario.wire); return; }
    const selected = scenario.calls?.[index] ?? (scenario.repeatedSkill && index !== scenario.finalAt ? [{ name: SKILL, args: {} }] : index === 0 && !scenario.calls ? [{ name: SKILL, args: {} }] : undefined);
    if (selected) {
      response.end((scenario.prefix ? sse({ content: SAFE_PREFIX }) : '') + wireToolCalls(selected));
      return;
    }
    // The external provider fixture derives its answer from actual native tool results in the request.
    const results = body.messages.filter(message => message.role === 'tool').map(message => { try { return JSON.parse(message.content); } catch { return undefined; } });
    const skill = results.find(value => value?.ok === true && typeof value.data?.instructions === 'string');
    const catalog = results.find(value => value?.ok === true && Array.isArray(value.data?.rows));
    const answer = skill ? `${skill.data.instructions.slice(0, 96)} Catalog: ${skill.data.tool_catalog.map((tool: { name: string }) => tool.name).join(', ')}.`
      : catalog ? `Read ${catalog.data.rows.length} document catalog rows.` : 'No trusted result was available.';
    response.end(sse({ content: answer }, 'stop') + done);
  } } } }] });
}

beforeAll(async () => {
  instructions = await readFile(path.resolve(import.meta.dirname, 'fixtures/financial-analysis.md'), 'utf8');
  const bundled = await build({ entryPoints: [path.resolve(import.meta.dirname, 'session-runtime-worker.ts')], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
    define: { __FINANCIAL_ANALYSIS_SKILL__: JSON.stringify(instructions) }, write: false });
  script = bundled.outputFiles![0]!.text;
  persist = await mkdtemp(path.join(os.tmpdir(), 'byok-session-runtime-'));
  mf = runtime(); await mf.ready;
});
afterAll(async () => { await mf?.dispose(); if (persist) await rm(persist, { recursive: true, force: true }); });
beforeEach(() => { calls.length = 0; logs.length = 0; scenario = {}; });

async function rpc(name: string, operation: string, extra: Record<string, unknown> = {}) {
  const worker = await mf.getWorker('cloud-session-runtime');
  return worker.fetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, ...extra }) });
}
async function json<T = Record<string, unknown>>(name: string, operation: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response = await rpc(name, operation, extra);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as T;
}
async function setup(extra: Record<string, unknown> = {}, controls: Record<string, unknown> = {}) {
  const name = `session-${++serial}`;
  const config = { identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: 'fixture-session' },
    principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' }, scopes: ['read:fixture'], dispatcherId: 'fixture-documents', ...extra };
  await json(name, 'setup', { config, controls });
  return name;
}
async function dump(name: string) { return json<Record<string, Record<string, unknown>[]>>(name, 'dump'); }
function events(text: string): Record<string, unknown>[] { return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))); }
const errorEvent = (code: string) => ({ type: 'error', code, retryable: false });
async function run(name: string) { return (await rpc(name, 'submit', { input: { instruction: 'Read the trusted financial analysis skill and its current tool catalog.' } })).text(); }
function nativeRows(rows: Record<string, Record<string, unknown>[]>) { return Object.fromEntries(Object.entries(rows).filter(([table]) => table.startsWith('pi_'))); }
function nativeTasks(rows: Record<string, Record<string, unknown>[]>) { return (rows.pi_tasks ?? []).map(row => JSON.parse(String(row.record)) as { id: number; kind: string; abortRequested: boolean; state: { status: string; outcome?: { status: string; error?: { message: string } } } }); }
function assertNoSecrets(...values: unknown[]) {
  const text = JSON.stringify(values);
  for (const key of [KEY, SECONDARY]) for (const secret of [key, ...Array.from({ length: key.length - 15 }, (_, i) => key.slice(i, i + 16))]) {
    for (const form of [secret, btoa(secret), encodeURIComponent(secret)]) expect(text).not.toContain(form);
  }
}
async function waitDispatched(name: string, count: number) { await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(count)); }
async function restart() { await mf.dispose(); mf = runtime(); await mf.ready; }

describe('cloud session native model → tool → model in workerd', () => {
  for (const field of ['description', 'schema'] as const) it(`rejects a credential-bearing tool ${field} before native schema intake`, async () => {
    const name = `metadata-rejection-${++serial}`;
    const config = { identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: 'fixture-session' },
      principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' }, scopes: ['read:fixture'], dispatcherId: 'fixture-documents' };
    const response = await rpc(name, 'setup', { config, controls: { leakedToolMetadata: field } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'CLOUD_USER_CREDENTIAL_REJECTED', retryable: false } });
    const rows = await dump(name);
    expect(Object.keys(nativeRows(rows))).toEqual([]);
    expect(rows.cloud_invocations).toBeUndefined();
    expect(calls).toHaveLength(0);
    assertNoSecrets(rows, logs);
  });

  it('loads the actual Aiphabee document, persists one ledger result, and returns it in the next native request', async () => {
    const name = await setup();
    const text = await run(name);
    expect(events(text).at(-1)).toMatchObject({ type: 'done' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.tools?.map(tool => tool.function.name)).toContain(SKILL);
    const toolResult = calls[1]!.body.messages.find(message => message.role === 'tool');
    expect(toolResult).toBeDefined();
    const loaded = JSON.parse(toolResult!.content);
    expect(loaded.data.instructions).toBe(instructions);
    expect(loaded.data.tool_catalog.map((tool: { name: string }) => tool.name)).toEqual([SKILL, 'search_f10_datasets', 'query_f10_dataset', 'get_ipo_profile']);
    const rows = await dump(name);
    expect(rows.cloud_invocations).toMatchObject([{ toolName: SKILL, state: 'succeeded', replay: 'safe', replayCount: 0 }]);
    expect(rows.fixture_dispatches).toMatchObject([{ toolName: SKILL, completed: 1 }]);
    expect(JSON.stringify(nativeRows(rows))).toContain('call_1');
    expect(JSON.stringify(nativeRows(rows))).not.toContain('raw_0');
    assertNoSecrets(text, rows, calls.map(call => call.body), logs);
  });

  it('reads the genuine catalog using interleaved two-call arguments and native results', async () => {
    scenario = { wire: sse({ tool_calls: [
      { index: 1, id: 'second', type: 'function', function: { name: 'search_f10_datasets', arguments: '{"query":"fin' } },
      { index: 0, id: 'first', type: 'function', function: { name: SKILL, arguments: '{' } },
    ] }) + sse({ tool_calls: [{ index: 0, function: { arguments: '}' } }, { index: 1, function: { arguments: 'ancial"}' } }] }, 'tool_calls') + done };
    const name = await setup();
    const text = await run(name);
    expect(events(text).at(-1)).toMatchObject({ type: 'done' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.messages.filter(message => message.role === 'tool')).toHaveLength(2);
    expect((await dump(name)).fixture_dispatches).toHaveLength(2);
  });

  for (const field of ['id', 'name', 'argument value', 'argument key'] as const) {
    for (const encoding of ['raw', 'base64', 'percent', 'unicode'] as const) it(`rejects ${encoding} secret in ${field} before every native SQLite intake`, async () => {
      const name = await setup();
      const value = encoding === 'base64' ? btoa(SECONDARY) : encoding === 'percent' ? encodeURIComponent(SECONDARY) : SECONDARY;
      const toolCall = { index: 0, id: field === 'id' ? value : 'safe-id', type: 'function', function: { name: field === 'name' ? value : 'search_f10_datasets',
        arguments: JSON.stringify(field === 'argument key' ? { [value]: 'financial' } : { query: field === 'argument value' ? value : 'financial' }) } };
      let wire = sse({ tool_calls: [toolCall] }, 'tool_calls') + done;
      if (encoding === 'unicode') {
        const escaped = Array.from(SECONDARY, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
        if (field === 'id' || field === 'name') wire = wire.replace(JSON.stringify(SECONDARY), `"${escaped}"`);
        else {
          const args = field === 'argument key' ? `{"${escaped}":"financial"}` : `{"query":"${escaped}"}`;
          wire = sse({ tool_calls: [{ ...toolCall, function: { ...toolCall.function, arguments: args.slice(0, 17) } }] })
            + sse({ tool_calls: [{ index: 0, function: { arguments: args.slice(17) } }] }, 'tool_calls') + done;
        }
      }
      scenario = { wire };
      const text = await run(name);
      expect(events(text).at(-1)).toEqual(errorEvent('CLOUD_MODEL_RESPONSE_REJECTED'));
      const rows = await dump(name);
      expect(rows.fixture_dispatches).toHaveLength(0);
      expect(rows.cloud_invocations).toHaveLength(0);
      expect(JSON.stringify(nativeRows(rows))).not.toContain('"type":"toolCall"');
      assertNoSecrets(rows, text, logs);
    });
  }

  for (const test of [
    { label: 'unknown tool', wire: wireToolCalls([{ name: 'not_offered', args: {} }]), absent: 'not_offered' },
    { label: 'unknown argument', wire: wireToolCalls([{ name: SKILL, args: { unexpected: true } }]), absent: 'unexpected' },
    { label: 'invalid JSON arguments', wire: sse({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: SKILL, arguments: '{' } }] }, 'tool_calls') + done, absent: '"type":"toolCall"' },
    { label: 'incomplete call EOF', wire: sse({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: SKILL, arguments: '{' } }] }), absent: '"type":"toolCall"' },
    { label: 'user-key-shaped arguments', wire: wireToolCalls([{ name: 'search_f10_datasets', args: { query: 'sk-proj-UserSecret0123456789abcdef' } }]), absent: 'sk-proj-UserSecret0123456789abcdef' },
  ]) it(`rejects ${test.label} before native dispatch or stored tool input`, async () => {
    const name = await setup(); scenario = { wire: test.wire };
    const text = await run(name);
    expect(events(text).at(-1)).toMatchObject({ type: 'error' });
    const rows = await dump(name);
    expect(rows.fixture_dispatches).toHaveLength(0);
    expect(JSON.stringify(nativeRows(rows))).not.toContain(test.absent);
  });

  for (const field of ['metadata', 'progress']) it(`rejects resolver envelope ${field} secrets before ledger and native tool result`, async () => {
    const name = await setup({}, { leakedField: field });
    const text = await run(name);
    expect(events(text).at(-1)).toEqual(errorEvent('CLOUD_MODEL_RESPONSE_REJECTED'));
    const rows = await dump(name);
    expect(rows.cloud_invocations).toMatchObject([{ state: 'failed', resultJson: null, errorCode: 'CLOUD_MODEL_RESPONSE_REJECTED' }]);
    assertNoSecrets(rows, text, logs);
  });

  it('fails a real loader result without usage.credits and prevents subsequent provider use', async () => {
    const name = await setup({}, { missingUsage: true });
    const text = await run(name);
    expect(events(text).at(-1)).toEqual(errorEvent('CLOUD_TOOL_USAGE_INVALID'));
    expect(calls).toHaveLength(1);
    expect((await dump(name)).cloud_invocations).toMatchObject([{ state: 'failed', resultJson: null, errorCode: 'CLOUD_TOOL_USAGE_INVALID' }]);
  });

  it('rejects a real multi-row document result above 48,000 bytes while a sibling skill call succeeds, then sends no next request', async () => {
    const name = await setup({}, { pauseName: 'query_f10_dataset' });
    scenario = { calls: [[{ name: 'query_f10_dataset', args: { dataset_ref: 'financial-analysis', limit: 8 } }, { name: SKILL, args: {} }]] };
    const processing = run(name);
    try {
      await vi.waitFor(async () => expect((await dump(name)).cloud_invocations).toContainEqual(expect.objectContaining({ toolName: SKILL, state: 'succeeded' })));
    } finally { await json(name, 'release'); }
    const text = await processing;
    expect(events(text).at(-1)).toEqual(errorEvent('CLOUD_TOOL_RESULT_LIMIT'));
    expect(calls).toHaveLength(1);
    const rows = await dump(name);
    expect(rows.fixture_dispatches).toHaveLength(2);
    expect(rows.cloud_invocations).toContainEqual(expect.objectContaining({ toolName: SKILL, state: 'succeeded' }));
    expect(rows.cloud_invocations).toContainEqual(expect.objectContaining({ toolName: 'query_f10_dataset', state: 'failed', resultJson: null, errorCode: 'CLOUD_TOOL_RESULT_LIMIT' }));
    expect(rows.cloud_executions).toMatchObject([{ fatalCode: 'CLOUD_TOOL_RESULT_LIMIT' }]);
    const nextGeneration = nativeTasks(rows).filter(task => task.kind === 'pi.generation').at(-1)!;
    expect(nextGeneration.state).toMatchObject({ status: 'terminal', outcome: { status: 'failed', error: { message: 'CLOUD_TOOL_RESULT_LIMIT' } } });
    expect(nextGeneration.abortRequested).toBe(false);
  });

  for (const code of ['CLOUD_EXECUTION_INTERRUPTED', 'CLOUD_TOOL_RESULT_LIMIT', 'CLOUD_STEP_LIMIT', 'CLOUD_TOOL_LIMIT'] as const satisfies readonly CloudDoErrorCode[]) it(`real scheduler keeps the native cancel signal live while the send gate fails with ${code}`, async () => {
    const name = await setup();
    const result = await json<{ liveSignal: boolean; dump: Record<string, Record<string, unknown>[]> }>(name, 'gate', { code });
    expect(result.liveSignal).toBe(true);
    expect(calls).toHaveLength(0);
    expect(nativeTasks(result.dump).find(task => task.kind === 'pi.generation')).toMatchObject({ kind: 'pi.generation', abortRequested: false, state: { status: 'terminal', outcome: { status: 'failed', error: { message: code } } } });
    expect(JSON.stringify(nativeRows(result.dump))).toContain(code);
  });
});

describe('native session limits and late results', () => {
  it('accepts eight model steps and blocks the ninth at the transport gate', async () => {
    const name = await setup(); scenario = { repeatedSkill: true, finalAt: 7 };
    expect(events(await run(name)).at(-1)).toMatchObject({ type: 'done' });
    expect(calls).toHaveLength(8);
    const second = await setup(); calls.length = 0; scenario = { repeatedSkill: true };
    expect(events(await run(second)).at(-1)).toEqual(errorEvent('CLOUD_STEP_LIMIT'));
    expect(calls).toHaveLength(8);
    expect((await dump(second)).cloud_executions).toMatchObject([{ steps: 8, fatalCode: 'CLOUD_STEP_LIMIT' }]);
  });

  it('accepts twelve native tool calls and blocks the thirteenth before dispatch', async () => {
    const group = () => Array.from({ length: 4 }, () => ({ name: SKILL, args: {} }));
    const name = await setup(); scenario = { calls: [group(), group(), group()] };
    expect(events(await run(name)).at(-1)).toMatchObject({ type: 'done' });
    expect((await dump(name)).fixture_dispatches).toHaveLength(12);
    const second = await setup(); calls.length = 0; scenario = { calls: [group(), group(), group(), [{ name: SKILL, args: {} }]] };
    expect(events(await run(second)).at(-1)).toEqual(errorEvent('CLOUD_TOOL_LIMIT'));
    expect(calls).toHaveLength(4);
    const rows = await dump(second);
    expect(rows.fixture_dispatches).toHaveLength(12);
    expect(rows.cloud_executions).toMatchObject([{ tools: 12, fatalCode: 'CLOUD_TOOL_LIMIT' }]);
  });

  it('rejects a second session submission while the first waits on a genuine read', async () => {
    const name = await setup({}, { pause: true });
    const first = run(name);
    try {
      await waitDispatched(name, 1);
      const second = await rpc(name, 'submit', { input: { instruction: 'Read the skill again.' } });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: { code: 'CLOUD_TOOL_BUSY', retryable: false } });
      expect(calls).toHaveLength(1);
    } finally { await json(name, 'release'); }
    expect(events(await first).at(-1)).toMatchObject({ type: 'done' });
  });

  it('rejects the fifth concurrent read before its resolver begins', async () => {
    const name = await setup({}, { pause: true });
    scenario = { calls: [Array.from({ length: 5 }, () => ({ name: SKILL, args: {} }))] };
    const processing = run(name);
    try {
      await waitDispatched(name, 4);
      await vi.waitFor(async () => expect((await dump(name)).cloud_invocations).toContainEqual(expect.objectContaining({ state: 'failed', errorCode: 'CLOUD_TOOL_BUSY' })));
      expect(calls).toHaveLength(1);
    } finally { await json(name, 'release'); }
    expect(events(await processing).at(-1)).toEqual(errorEvent('CLOUD_TOOL_BUSY'));
    expect((await dump(name)).fixture_dispatches).toHaveLength(4);
  });

  for (const { limits, code } of [
    { limits: { callTimeoutMs: 80, turnTimeoutMs: 2_000 }, code: 'CLOUD_TOOL_TIMEOUT' },
    { limits: { callTimeoutMs: 2_000, turnTimeoutMs: 150 }, code: 'CLOUD_EXECUTION_TIMEOUT' },
  ]) it(`discards the genuine resolver result that arrives after ${code}`, async () => {
    const name = await setup({ limits }, { pause: true });
    const processing = run(name);
    await waitDispatched(name, 1);
    const text = await processing;
    expect(events(text).at(-1)).toEqual(errorEvent(code));
    await json(name, 'release');
    await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toMatchObject([{ completed: 1 }]));
    const rows = await dump(name);
    expect(rows.cloud_invocations).toMatchObject([{ state: 'timed_out', resultJson: null, errorCode: code }]);
    expect(JSON.stringify(nativeRows(rows))).not.toContain('"instructions":');
    expect(calls).toHaveLength(1);
  });

  it('stops the native next generation after a timed-out call even when its sibling already succeeded', async () => {
    const name = await setup({ limits: { callTimeoutMs: 180, turnTimeoutMs: 2_000 } }, { pauseName: 'query_f10_dataset' });
    scenario = { calls: [[{ name: SKILL, args: {} }, { name: 'query_f10_dataset', args: { dataset_ref: 'financial-analysis', limit: 1 } }]] };
    const processing = run(name);
    try {
      await vi.waitFor(async () => expect((await dump(name)).cloud_invocations).toContainEqual(expect.objectContaining({ toolName: SKILL, state: 'succeeded' })));
      expect(events(await processing).at(-1)).toEqual(errorEvent('CLOUD_TOOL_TIMEOUT'));
    } finally { await json(name, 'release'); }
    const rows = await dump(name);
    expect(rows.cloud_invocations).toContainEqual(expect.objectContaining({ toolName: 'query_f10_dataset', state: 'timed_out', resultJson: null }));
    expect(calls).toHaveLength(1);
  });

  it('discards a genuine read result after the HTTP client disconnects', async () => {
    const name = await setup({}, { pause: true }); scenario = { prefix: true };
    const response = await mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation: 'submit', input: { instruction: 'Read the skill.' } }) });
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('text_delta');
      await waitDispatched(name, 1);
      await reader.cancel();
      await vi.waitFor(async () => expect((await dump(name)).cloud_invocations).toContainEqual(expect.objectContaining({ state: 'aborted', resultJson: null })));
    } finally { await json(name, 'release'); await reader.cancel(); }
    await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toMatchObject([{ completed: 1 }]));
    const rows = await dump(name);
    expect(JSON.stringify(nativeRows(rows))).not.toContain('"instructions":');
    expect(calls).toHaveLength(1);
  });

  for (const extra of [{ principal: { accountId: 'other-account', workspaceId: 'fixture-workspace', channel: 'api' } }, { scopes: [] }]) it('keeps trusted principal and scope failures outside resolver execution', async () => {
    const name = await setup(extra);
    expect(events(await run(name)).at(-1)).toEqual(errorEvent('CLOUD_TOOL_NOT_AVAILABLE'));
    expect((await dump(name)).fixture_dispatches).toHaveLength(0);
  });
  it('keeps a not-ready data source outside resolver execution', async () => {
    const name = await setup({}, { readiness: false });
    expect(events(await run(name)).at(-1)).toEqual(errorEvent('CLOUD_TOOL_NOT_AVAILABLE'));
    expect((await dump(name)).fixture_dispatches).toHaveLength(0);
  });
});

describe('full workerd restart and genuine native task checkpoints', () => {
  for (const seed of [
    { phase: 'request', ledger: false }, { phase: 'call', ledger: false }, { phase: 'execute', ledger: true },
  ] as const) it(`blocks old native ${seed.phase} during resume → abort mark pause`, async () => {
    const name = await setup();
    const seeded = await json<{ taskId: number; conversationId: number; invocationId?: string }>(name, 'seed', { seed });
    await restart();
    const opened = await json<{ elapsed: number; recovering: boolean }>(name, 'open-recovery', { race: true });
    expect(opened.elapsed).toBeLessThan(1_500);
    expect(opened.recovering).toBe(true);
    try {
      await vi.waitFor(async () => {
        const status = await json<{ resumed: number; beforeRequestSignals: boolean[]; toolSignals: boolean[] }>(name, 'race-status');
        expect(status.resumed).toBeGreaterThan(0);
        if (seed.phase === 'request') expect(status.beforeRequestSignals).toEqual([false]);
        if (seed.phase === 'call') expect(status.toolSignals).toEqual([false]);
        const row = nativeTasks(await dump(name)).find(task => task.id === seeded.taskId)!;
        expect(row.state.status).toBe('terminal');
        expect(row.abortRequested).toBe(false);
        if (seed.phase === 'request') expect(row.state.outcome).toMatchObject({ status: 'failed', error: { message: 'CLOUD_EXECUTION_INTERRUPTED' } });
      });
      expect(calls).toHaveLength(0);
      expect((await dump(name)).fixture_dispatches).toHaveLength(0);
    } finally { await json(name, 'release-race'); }
    expect((await json(name, 'ready')).recovering).toBe(false);
    const rows = await dump(name);
    expect(rows.cloud_executions).toMatchObject([{ fatalCode: 'CLOUD_EXECUTION_INTERRUPTED' }]);
    if (seed.phase === 'execute') {
      expect(rows.fixture_dispatches).toHaveLength(1);
      expect(rows.cloud_invocations).toMatchObject([{ replayCount: 1, state: 'succeeded' }]);
      expect(JSON.stringify(nativeRows(rows))).toContain('interrupted');
    } else expect(rows.fixture_dispatches).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toContain('execute(context');
  });

  it('keeps a blocked native idle wait outside bounded initialization and withholds new submissions', async () => {
    const name = await setup(); await json(name, 'seed', { seed: { phase: 'request', ledger: false } });
    await restart();
    const opened = await json<{ elapsed: number; recovering: boolean }>(name, 'open-recovery', { race: 'idle' });
    expect(opened.elapsed).toBeLessThan(1_500);
    expect(opened.recovering).toBe(true);
    let admitted = false;
    const submission = rpc(name, 'submit', { input: { instruction: 'Read fresh financial guidance.' } }).then(async response => { admitted = true; return response.text(); });
    try {
      await vi.waitFor(async () => expect((await json(name, 'race-status')).resumed).toBeGreaterThan(0));
      expect(admitted).toBe(false);
      expect(calls).toHaveLength(0);
      expect((await dump(name)).cloud_executions).toHaveLength(1);
    } finally { await json(name, 'release-race'); }
    expect(events(await submission).at(-1)).toMatchObject({ type: 'done' });
    expect(calls).toHaveLength(2);
  });

  it('reconstructs the dispatcher from persisted data and never replays a settled row on a second restart', async () => {
    const name = await setup(); await json(name, 'seed', { seed: { phase: 'execute', ledger: true } });
    await restart(); await json(name, 'ready');
    expect((await dump(name)).fixture_dispatches).toHaveLength(1);
    await restart(); await json(name, 'ready');
    const rows = await dump(name);
    expect(rows.fixture_dispatches).toHaveLength(1);
    expect(rows.cloud_invocations).toMatchObject([{ state: 'succeeded', replayCount: 1 }]);
    expect(calls).toHaveLength(0);
    assertNoSecrets(rows, logs);
  });

  it('never automatically replays a live IPO tool outside the frozen list', async () => {
    const name = await setup(); await json(name, 'seed', { seed: { phase: 'execute', toolName: 'get_ipo_profile', ledger: true } });
    await restart(); await json(name, 'ready');
    const rows = await dump(name);
    expect(rows.fixture_dispatches).toHaveLength(0);
    expect(rows.cloud_invocations).toMatchObject([{ toolName: 'get_ipo_profile', replay: 'unsafe', state: 'interrupted', replayCount: 0 }]);
    expect(calls).toHaveLength(0);
  });

  it('claims replay durably and refuses a second dispatch after a restart interrupts that replay', async () => {
    const name = await setup(); await json(name, 'seed', { seed: { phase: 'execute', ledger: true } });
    await restart(); await json(name, 'controls', { controls: { pause: true } });
    const opened = await json(name, 'open-recovery');
    expect(opened.recovering).toBe(true);
    await waitDispatched(name, 1);
    expect((await dump(name)).cloud_invocations).toMatchObject([{ replayCount: 1, state: 'running' }]);
    await restart(); await json(name, 'ready');
    const rows = await dump(name);
    expect(rows.fixture_dispatches).toHaveLength(1);
    expect(rows.cloud_invocations).toMatchObject([{ state: 'failed', replayCount: 1 }]);
    expect(calls).toHaveLength(0);
  });
});


describe('native session identity and consumer authorization', () => {
  const identity = { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: 'fixture-session' };
  it('uses four tuple fields and a digest distinct from the three-field agent key', async () => {
    const names = await json<{ agent: string; session: string }>('identity', 'identity-name', { identity });
    expect(names.agent).toMatch(/^agent:[a-f0-9]{64}$/);
    expect(names.session).toMatch(/^session:[a-f0-9]{64}$/);
    expect(names.agent.split(':')[1]).not.toBe(names.session.split(':')[1]);
    expect(await json('identity', 'identity-name', { identity })).toEqual(names);
    for (const field of Object.keys(identity)) {
      const changed = await json<{ session: string }>('identity', 'identity-name', { identity: { ...identity, [field]: 'different' } });
      expect(changed.session).not.toBe(names.session);
    }
  });

  it('keeps delimiter-bearing and Unicode identities in separate real namespace objects', async () => {
    const identities = [
      { ...identity, workspaceId: 'a:b', agentId: 'c', sessionId: '会话:甲' },
      { ...identity, workspaceId: 'a', agentId: 'b:c', sessionId: '会话:甲' },
      { ...identity, workspaceId: '工作:区', agentId: '分析员', sessionId: '会话:甲' },
      { ...identity, workspaceId: '工作:区', agentId: '分析员', sessionId: '会话:乙' },
    ];
    const actual = [];
    for (const [index, item] of identities.entries()) {
      const value = await json<{ id: string; byId: string; namespaceLookups: number; entries: string[] }>('identity', 'identity-lookup', { identity: item, text: `isolated record ${index}` });
      expect(value.namespaceLookups).toBe(1);
      expect(value.id).toBe(value.byId);
      expect(value.entries).toEqual([`isolated record ${index}`]);
      actual.push(value.id);
    }
    expect(new Set(actual).size).toBe(identities.length);
    expect(calls).toHaveLength(0);
  });

  it('rejects a wrong tenant before any real namespace lookup or object initialization', async () => {
    const deniedIdentity = { ...identity, tenantId: 'unauthorized-tenant', sessionId: `denied-${++serial}` };
    const response = await rpc('identity', 'identity-lookup', { identity: deniedIdentity, text: 'must not persist' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'FORBIDDEN', namespaceLookups: 0 });
    const names = await json<{ session: string }>('identity', 'identity-name', { identity: deniedIdentity });
    expect(await dump(names.session)).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe('dispatcher reconstruction failures after a full workerd restart', () => {
  for (const corruption of ['unknown', 'missing']) it(`settles an old safe invocation without dispatch when ${corruption} persisted dispatcher data cannot be reconstructed`, async () => {
    const name = await setup();
    await json(name, 'seed', { seed: { phase: 'execute', ledger: true } });
    await json(name, 'corrupt-config', { corruption });
    await restart();
    expect((await json(name, 'ready')).recovering).toBe(false);
    const rows = await dump(name);
    expect(rows.fixture_dispatches).toHaveLength(0);
    expect(rows.cloud_invocations).toMatchObject([{ replay: 'safe', replayCount: 1, state: 'failed', resultJson: null, errorCode: 'CLOUD_EXECUTION_INTERRUPTED' }]);
    expect(rows.cloud_invocations!.filter(row => row.state === 'accepted' || row.state === 'running')).toHaveLength(0);
    expect(calls).toHaveLength(0);
    const fresh = await rpc(name, 'submit', { input: { instruction: 'Read fresh financial guidance.' } });
    expect(fresh.status).toBe(400);
    expect(await fresh.json()).toEqual({ error: { code: 'CLOUD_TOOL_NOT_AVAILABLE', retryable: false } });
    expect(calls).toHaveLength(0);
    expect((await dump(name)).fixture_dispatches).toHaveLength(0);
  });
});


const HOSTILE_TOKEN = 'ghp_ReviewOpaque1234567890abcdefABCDEF';
const SQL_ERROR_MARKER = 'sql-error-args-marker';
function regressionEntries(rows: Record<string, Record<string, unknown>[]>) {
  return (rows.pi_entries ?? []).map(row => JSON.parse(String(row.record)) as {
    id: number; conversationId: number; kind: string; byTaskId?: number;
    model?: { role: string; stopReason?: string; errorMessage?: string; isError?: boolean; content: { type: string; text?: string }[] }[];
    data?: { diagnostics?: { severity: string; code: string; message: string }[] };
  });
}

describe('review finding 1: native error persistence regression guards', () => {
  it('keeps the genuine NOT_FOUND domain response nonfatal and preserves its valid billing metadata', async () => {
    const name = await setup();
    scenario = { calls: [[{ name: 'get_ipo_profile', args: { ipo_id: 'honeycomb' } }]] };
    const text = await run(name);
    expect(events(text).at(-1)).toMatchObject({ type: 'done' });
    expect(calls).toHaveLength(2);
    const rows = await dump(name);
    const invocation = rows.cloud_invocations![0]!;
    expect(invocation.state).toBe('succeeded');
    expect(JSON.parse(String(invocation.resultJson))).toEqual({ ok: false,
      error: { code: 'CLOUD_TOOL_NOT_AVAILABLE' }, usage: { credits: 0, rows: 0, cached: false } });
    expect(rows.cloud_executions).toMatchObject([{ fatalCode: null }]);
    const toolResult = regressionEntries(rows).find(entry => entry.kind === 'pi.tool-result')!;
    expect(toolResult.model![0]!.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'CLOUD_TOOL_NOT_AVAILABLE' } }) }]);
    assertNoSecrets(rows, calls.map(call => call.body), text);
  });

  it('replaces an explicitly marked upstream error envelope with one fixed cloud error before pi or the next model request', async () => {
    const name = await setup({}, { upstreamFault: 'error-envelope' });
    const text = await run(name);
    const rows = await dump(name);
    const native = JSON.stringify(nativeRows(rows));
    expect(native).not.toContain(HOSTILE_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(HOSTILE_TOKEN);
    expect(JSON.stringify(calls.map(call => call.body))).not.toContain(HOSTILE_TOKEN);
    expect(native).not.toContain('raw-upstream-error-');
    const result = regressionEntries(rows).find(entry => entry.kind === 'pi.tool-result');
    expect(result).toBeDefined();
    expect(result!.model![0]!.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'CLOUD_TOOL_FAILED' } }) }]);
    expect(events(text).at(-1)).toEqual(errorEvent('CLOUD_TOOL_FAILED'));
    expect(calls).toHaveLength(1);
  });

  it('keeps a real trusted dispatcher rejection and its cause out of native rows and provider input', async () => {
    const name = await setup({}, { upstreamFault: 'throw' });
    const text = await run(name);
    const rows = await dump(name);
    expect(JSON.stringify(nativeRows(rows))).not.toContain(HOSTILE_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(HOSTILE_TOKEN);
    expect(JSON.stringify(calls.map(call => call.body))).not.toContain(HOSTILE_TOKEN);
    expect(JSON.stringify(nativeRows(rows))).not.toContain('raw-dispatcher-');
    expect(JSON.stringify(nativeRows(rows))).toContain('CLOUD_TOOL_FAILED');
    expect(events(text).at(-1)).toEqual(errorEvent('CLOUD_TOOL_FAILED'));
    expect(calls).toHaveLength(1);
  });

  for (const sqlFailure of ['begin', 'finish', 'fatal'] as const) it(`contains a real SQLite ${sqlFailure} failure with hostile raw error text at the whole tool boundary`, async () => {
    const name = await setup({}, sqlFailure === 'begin' ? {} : { upstreamFault: 'throw' });
    await json(name, 'sql-failure', { sqlFailure });
    scenario = { calls: [[{ name: 'search_f10_datasets', args: { query: SQL_ERROR_MARKER } }]] };
    const text = await run(name);
    const rows = await dump(name);
    expect(JSON.stringify(nativeRows(rows))).not.toContain(HOSTILE_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(HOSTILE_TOKEN);
    expect(JSON.stringify(calls.map(call => call.body))).not.toContain(HOSTILE_TOKEN);
    expect(JSON.stringify(nativeRows(rows))).not.toContain('raw-rejection-');
    expect(JSON.stringify(nativeRows(rows))).toContain('CLOUD_TOOL_FAILED');
    expect(events(text).at(-1)).toEqual(errorEvent('CLOUD_TOOL_FAILED'));
    expect(calls).toHaveLength(1);
  });
});

describe('review finding 3: stale request partial recovery regression guard', () => {
  it('keeps stale recovery entries limited to native terminal cleanup and excludes old partials from a fresh conversation', async () => {
    const name = await setup();
    const partial = 'old-generation-partial-must-not-be-published';
    const seeded = await json<{ conversationId: number; taskId: number }>(name, 'seed', { seed: { phase: 'request', ledger: false, partial } });
    const before = await dump(name);
    const previous = regressionEntries(before).filter(entry => entry.kind === 'pi.assistant' && entry.conversationId === seeded.conversationId);
    expect(await json(name, 'live-audit', { conversationId: seeded.conversationId })).toMatchObject({ generation: { message: { content: [{ type: 'text', text: partial }] } } });
    await restart();
    await json(name, 'ready');
    const rows = await dump(name);
    const after = regressionEntries(rows).filter(entry => entry.kind === 'pi.assistant' && entry.conversationId === seeded.conversationId);
    const cleanup = after.filter(entry => !previous.some(old => old.id === entry.id));
    expect(cleanup.length).toBeGreaterThan(0);
    for (const entry of cleanup) {
      const message = entry.model![0]!;
      if (message.stopReason === 'aborted') expect(message.content).toEqual([{ type: 'text', text: partial }]);
      else {
        expect(message).toMatchObject({ stopReason: 'error', errorMessage: 'CLOUD_EXECUTION_INTERRUPTED', content: [] });
      }
    }
    const live = await json(name, 'live-audit', { conversationId: seeded.conversationId });
    expect(live.generation).toBeUndefined();
    expect(rows.cloud_executions).toMatchObject([{ fatalCode: 'CLOUD_EXECUTION_INTERRUPTED' }]);
    expect(nativeTasks(rows).find(task => task.id === seeded.taskId)!.state.status).toBe('terminal');
    expect(calls).toHaveLength(0);
    const fresh = events(await run(name)).at(-1)!;
    expect(fresh.type).toBe('done');
    expect(fresh.conversationId).not.toBe(seeded.conversationId);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls.map(call => call.body))).not.toContain(partial);
  });
});

describe('review finding 4: in-flight recovery attempt regression guard', () => {
  it('discards an original attempt after a real recovery claim without settlement, notification, or stale result data', async () => {
    const name = await setup({}, { pause: true });
    const processing = run(name);
    await waitDispatched(name, 1);
    const before = await dump(name);
    const row = before.cloud_invocations![0]!;
    const originalTask = (before.pi_tasks ?? []).map(value => JSON.parse(String(value.record)) as { id: number; kind: string; input: { assistant?: number; callId?: string } })
      .find(task => task.kind === 'pi.tool' && task.input.assistant === row.assistantEntryId && task.input.callId === row.toolCallId)!;
    expect(originalTask).toBeDefined();
    const claimed = await json<{ claimed: { invocationId: string; attempt: number; replayCount: number }[]; settled: unknown[] }>(name, 'claim-during-read');
    expect(claimed.claimed).toMatchObject([{ invocationId: row.invocationId, attempt: 2, replayCount: 1 }]);
    expect(claimed.settled).toEqual([]);
    await json(name, 'release');
    const text = await processing;
    const rows = await dump(name);
    expect(rows.cloud_invocations).toMatchObject([{ invocationId: row.invocationId, state: 'running', attempt: 2, replayCount: 1, resultJson: null }]);
    expect((await json<{ settled: unknown[] }>(name, 'settlement-audit')).settled).toEqual([]);
    const receipts = regressionEntries(rows).filter(entry => entry.kind === 'pi.tool-result' && entry.byTaskId === originalTask.id);
    for (const receipt of receipts) {
      expect(receipt.model![0]).toMatchObject({ role: 'toolResult', isError: true });
      expect(receipt.data!.diagnostics).toEqual([{ severity: 'error', code: 'aborted', message: `Tool ${SKILL} was aborted` }]);
    }
    expect(JSON.stringify(nativeRows(rows))).not.toContain('\\\"instructions\\\":');
    expect(JSON.stringify(calls.map(call => call.body))).not.toContain('\"instructions\":');
    expect(events(text).at(-1)).toEqual(errorEvent('CLOUD_EXECUTION_INTERRUPTED'));
    expect(calls).toHaveLength(1);
  });
});


describe('review finding 1: nested cloud error alias and malformed envelopes', () => {
  for (const upstreamFault of ['malformed-cloud-code', 'missing-ok-error', 'success-error'] as const) it(`rejects ${upstreamFault} from a real dispatcher before host, native, model, and SSE persistence`, async () => {
    const name = await setup({}, { upstreamFault });
    const text = await run(name);
    const rows = await dump(name);
    const evidence = JSON.stringify({ upstreamFault, providerCalls: calls.length, terminal: events(text).at(-1),
      hostErrorCodes: rows.cloud_invocations!.map(row => row.errorCode), fatalCodes: rows.cloud_executions!.map(row => row.fatalCode),
      nativeToolResults: regressionEntries(rows).filter(entry => entry.kind === 'pi.tool-result').map(entry => {
        const serialized = JSON.stringify(entry.model);
        const marker = serialized.indexOf(HOSTILE_TOKEN);
        return { isError: entry.model![0]!.isError, hasHostileToken: marker >= 0,
          tokenContext: marker < 0 ? null : serialized.slice(Math.max(0, marker - 48), marker + HOSTILE_TOKEN.length + 16) };
      }) });
    expect(JSON.stringify(nativeRows(rows)).includes(HOSTILE_TOKEN), evidence).toBe(false);
    expect(JSON.stringify(rows).includes(HOSTILE_TOKEN), evidence).toBe(false);
    expect(text.includes(HOSTILE_TOKEN), evidence).toBe(false);
    expect(JSON.stringify(calls.map(call => call.body)).includes(HOSTILE_TOKEN), evidence).toBe(false);
    expect(rows.cloud_invocations, evidence).toMatchObject([{ state: 'failed', resultJson: null, errorCode: 'CLOUD_TOOL_FAILED' }]);
    expect(rows.cloud_executions, evidence).toMatchObject([{ fatalCode: 'CLOUD_TOOL_FAILED' }]);
    expect(events(text).at(-1), evidence).toEqual(errorEvent('CLOUD_TOOL_FAILED'));
    expect(calls, evidence).toHaveLength(1);
  });
});

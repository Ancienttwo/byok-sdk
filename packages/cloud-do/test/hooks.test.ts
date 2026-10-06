import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createMockProvider } from './fixtures/mock-provider';
import { admitCloudDispatcher, dispatcherDigest, replayForTool, type CloudToolDefinition, type CloudToolDispatcher } from '../src/tools';

const KEY = 'Primary~0123456789ABCDEFGHIJKLMNOP';
const schema = { type: 'object' as const, properties: {}, additionalProperties: false };
const pure: CloudToolDefinition = { name: 'render_widget', execution: 'pure', description: 'Render a widget.', parameters: schema };
const dispatcher = (patch: Partial<CloudToolDispatcher> = {}): CloudToolDispatcher => ({ tools: [pure], pureTools: ['render_widget'], execute: async () => ({ ok: true }), ...patch });
let script: string;
const success = { ok: true, data: { envelope: { kind: 'widget', values: [1, 2] } }, usage: { credits: 0 } };
const failure = { ok: false, error: { code: 'WIDGET_INVALID', message: 'Drop this diagnostic.', data: { field: 'source' } }, data: { envelope: { status: 'failed' } }, usage: { credits: 0 } };
beforeAll(async () => {
  const instructions = await readFile(path.resolve(import.meta.dirname, 'fixtures/financial-analysis.md'), 'utf8');
  const bundled = await build({ entryPoints: [path.resolve(import.meta.dirname, 'hooks-worker.ts')], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], define: { __FINANCIAL_ANALYSIS_SKILL__: JSON.stringify(instructions) }, write: false });
  script = bundled.outputFiles![0]!.text;
});
const config = { identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: 'fixture-session' }, principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' }, scopes: ['read:fixture'], dispatcherId: 'fixture-documents' };

async function createHooksFixture() {
  const persist = await mkdtemp(path.join(os.tmpdir(), 'byok-hooks-'));
  const provider = createMockProvider();
  const requests = new AbortController();
  const pending = new Set<Promise<unknown>>();
  function owned<T>(request: Promise<T>): Promise<T> {
    pending.add(request);
    // Keep a rejection observed during timeout teardown without changing what
    // the test sees when it awaits the original operation.
    void request.then(() => pending.delete(request), () => pending.delete(request));
    return request;
  }
  let policy: Record<string, unknown> = {};
  let serial = 0;
  function runtime() {
    return new Miniflare({ resourcePersistencePath: persist, workers: [{ config: {
      name: 'cloud-hooks', type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
      exports: { HooksDO: { type: 'durable-object', storage: 'sqlite' } },
      env: { AGENTS: { type: 'durable-object', workerName: 'cloud-hooks', exportName: 'HooksDO' },
        AIPHABEE_ZAI_API_KEY: { type: 'text', value: KEY }, POLICY: { type: 'text', value: JSON.stringify(policy) } },
    }, dev: { outboundService: { type: 'node-handler', handler: provider.handle } } }] });
  }
  let mf = runtime();
  function rpc(name: string, operation: string, extra: Record<string, unknown> = {}) {
    requests.signal.throwIfAborted();
    return owned(mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, ...extra }), signal: requests.signal }));
  }
  function json(name: string, operation: string, extra: Record<string, unknown> = {}): Promise<any> {
    return owned((async () => {
      const response = await rpc(name, operation, extra); const text = await response.text();
      expect(response.status, text).toBe(200); return JSON.parse(text);
    })());
  }
  async function setup(control: Record<string, unknown> = {}, limits: Record<string, number> = {}) {
    const name = `hooks-${++serial}`; await json(name, 'setup', { config: { ...config, limits }, control }); return name;
  }
  async function restart(next: Record<string, unknown> = {}) {
    requests.signal.throwIfAborted();
    await mf.dispose();
    // A timed-out test can resume here after its fixture has been cleaned up.
    requests.signal.throwIfAborted();
    policy = next; mf = runtime(); await mf.ready;
  }
  async function dispose() {
    requests.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([provider.close(), mf.dispose(), Promise.allSettled(pending)]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('hooks fixture cleanup exceeded 5000ms')), 5_000); }),
      ]);
      await rm(persist, { recursive: true, force: true });
    } finally { clearTimeout(timer); }
  }
  try { await mf.ready; } catch (error) { await dispose(); throw error; }
  return { provider, rpc, json, setup, restart, dispose,
    dump: (name: string) => json(name, 'dump'),
    run: (name: string) => owned((async () => (await rpc(name, 'submit')).text())()),
    modelResults: () => provider.bodies.flatMap(body => body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))),
  };
}
const hooksTest = it.extend<{ hooks: Awaited<ReturnType<typeof createHooksFixture>> }>({
  hooks: async ({}, use) => {
    const fixture = await createHooksFixture();
    try { await use(fixture); } finally { await fixture.dispose(); }
  },
});
const toolEntries = (rows: any) => rows.pi_entries.map((row: any) => JSON.parse(row.record)).filter((entry: any) => entry.kind === 'pi.tool-result');
function assertClock(rows: any, row: any) { const event = rows.cloud_events.find((event: any) => event.eventKey === `tool:${row.invocationId}:settled`); expect(row.settledAt).toBe(event.createdAt); expect(row.settledEventSeq).toBe(event.seq); }

describe('cloud 4e-1 policy admission', () => {
  it('admits pure tools without a resolver and keeps them replay unsafe', () => { expect(admitCloudDispatcher(dispatcher()).tools).toEqual([pure]); expect(replayForTool(pure.name)).toBe('unsafe'); });
  for (const [label, patch] of [
    ['missing pure declaration', { pureTools: [] }], ['pure name collision', { pureTools: ['resolve_security'] }],
    ['pure resolver', { tools: [{ ...pure, resolverRpc: 'network' }] }], ['too many pure names', { pureTools: Array.from({ length: 9 }, (_, i) => `pure_${i}`) }],
    ['duplicate pure names', { pureTools: ['render_widget', 'render_widget'] }], ['invalid pure name', { pureTools: ['Render'] }],
    ['SDK map collision', { domainErrors: ['NOT_FOUND'] }], ['SDK prefix', { domainErrors: ['CLOUD_OTHER'] }],
    ['invalid domain code', { domainErrors: ['bad'] }], ['duplicate domain codes', { domainErrors: ['WIDGET_INVALID', 'WIDGET_INVALID'] }],
    ['too many domain codes', { domainErrors: Array.from({ length: 65 }, (_, i) => `ERROR_${i}`) }],
  ] as const) it(`rejects ${label}`, () => { expect(() => admitCloudDispatcher(dispatcher(patch))).toThrow('CLOUD_TOOL_NOT_AVAILABLE'); });
  it('defaults modelViews to false and freezes copied policy values', () => {
    const source = dispatcher(); const admitted = admitCloudDispatcher(source);
    expect(admitted.modelViews).toBe(false); expect(Object.isFrozen(admitted.tools[0]!.parameters)).toBe(true);
    expect(Object.isFrozen(admitted.pureTools)).toBe(true); expect(Object.isFrozen(admitted.domainErrors)).toBe(true);
    expect(admitted.tools[0]).not.toBe(source.tools[0]);
  });
  it('canonicalizes policy sets and schemas and hashes every listed policy input', async () => {
    const first = admitCloudDispatcher(dispatcher({ domainErrors: ['WIDGET_OTHER', 'WIDGET_INVALID'] }));
    const digest = await dispatcherDigest(first);
    expect(await dispatcherDigest(admitCloudDispatcher(dispatcher({ domainErrors: ['WIDGET_INVALID', 'WIDGET_OTHER'] })))).toBe(digest);
    for (const patch of [{ modelViews: true }, { domainErrors: ['WIDGET_INVALID'] }, { pureTools: ['render_widget', 'pure_other'] }, { tools: [{ ...pure, parameters: { ...schema, required: [] } }] }]) expect(await dispatcherDigest(admitCloudDispatcher(dispatcher(patch)))).not.toBe(digest);
  });
});

describe('cloud 4e-1 hooks in real workerd and pi Harness', () => {
  hooksTest('runs pure tools beside a live call with one fetch slot and preserves skill admission', async ({ hooks }) => {
    hooks.provider.reset([['get_financial_statements', 'render_widget'], ['load_financial_analysis_skill']]);
    const name = await hooks.setup({ pause: true, pauseName: 'get_financial_statements' }, { inlineFetches: 1 });
    const pending = hooks.run(name);
    await vi.waitFor(async () => {
      const rows = await hooks.dump(name);
      expect(rows.cloud_invocations.find((row: any) => row.toolName === 'get_financial_statements')?.state).toBe('running');
      expect(rows.cloud_invocations.find((row: any) => row.toolName === 'render_widget')?.state).toBe('succeeded');
    });
    await hooks.json(name, 'control', { control: { pause: false } }); expect(await pending).toContain('"type":"done"');
    const rows = await hooks.dump(name); expect(rows.fixture_dispatches).toHaveLength(3);
    expect(rows.cloud_invocations.map((row: any) => [row.toolName, row.replay, row.state])).toEqual([
      ['get_financial_statements', 'safe', 'succeeded'], ['render_widget', 'unsafe', 'succeeded'], ['load_financial_analysis_skill', 'safe', 'succeeded'],
    ]);
  });
  hooksTest('keeps declared failures non-fatal and preserves their projection and full ledger envelope', async ({ hooks }) => {
    const name = await hooks.setup({ result: failure }); expect(await hooks.run(name)).toContain('"type":"done"');
    expect(hooks.modelResults()).toEqual([{ ok: false, error: { code: 'WIDGET_INVALID', data: { field: 'source' } } }]);
    const rows = await hooks.dump(name); const row = rows.cloud_invocations[0];
    expect(row).toMatchObject({ state: 'succeeded', errorCode: null });
    const envelope = JSON.parse(row.resultJson); expect(envelope).toEqual({ ...failure, error: { code: 'WIDGET_INVALID', data: { field: 'source' } } });
    expect(JSON.parse(rows.cloud_projections[0].dataJson).data).toEqual(failure.data);
    expect((await hooks.json(name, 'read', { id: row.invocationId })).resultJson).toBe(row.resultJson);
    expect(toolEntries(rows)[0].model[0].isError).toBe(true); assertClock(rows, row);
  });
  for (const ok of [true, false]) hooksTest(`sends stored modelView for ok=${ok} and returns the full envelope to clients`, async ({ hooks }) => {
    const result = { ...(ok ? success : failure), modelView: { widget: 'summary', ok } };
    const name = await hooks.setup({ result }); expect(await hooks.run(name)).toContain('"type":"done"');
    expect(hooks.modelResults()).toEqual([result.modelView]); const rows = await hooks.dump(name);
    const row = await hooks.json(name, 'read', { id: rows.cloud_invocations[0].invocationId });
    expect(JSON.parse(row.resultJson)).toMatchObject({ data: result.data, modelView: result.modelView });
    expect(toolEntries(rows)[0].model[0].isError ?? false).toBe(!ok);
  });
  hooksTest('selects the same stored view on a settled safe invocation without another dispatch', async ({ hooks }) => {
    const name = await hooks.setup({ result: { ...success, modelView: { persisted: 'safe summary' } } });
    await hooks.json(name, 'replay'); const rows = await hooks.dump(name);
    expect(rows.fixture_dispatches).toHaveLength(0);
    expect(toolEntries(rows)[0].model[0]).toMatchObject({ role: 'toolResult', content: [{ type: 'text', text: '{"persisted":"safe summary"}' }] });
  });
  for (const [label, result, customPolicy, code] of [
    ['unflagged modelView', { ...success, modelView: null }, { modelViews: false }, 'CLOUD_TOOL_FAILED'],
    ['oversized error data', { ...failure, error: { code: 'WIDGET_INVALID', data: 'x'.repeat(2047) } }, {}, 'CLOUD_TOOL_RESULT_LIMIT'],
    ['oversized envelope and modelView', { ...success, data: { value: 'x'.repeat(24_000) }, modelView: 'y'.repeat(24_000) }, {}, 'CLOUD_TOOL_RESULT_LIMIT'],
    ['credential in modelView', { ...success, modelView: { key: KEY } }, {}, 'CLOUD_MODEL_RESPONSE_REJECTED'],
    ['credential in error data', { ...failure, error: { code: 'WIDGET_INVALID', data: { key: KEY } } }, {}, 'CLOUD_MODEL_RESPONSE_REJECTED'],
    ['credential in failed payload', { ...failure, data: { key: KEY } }, {}, 'CLOUD_MODEL_RESPONSE_REJECTED'],
  ] as const) hooksTest(`rejects ${label} before the next paid request`, async ({ hooks }) => {
    const name = await hooks.setup({ result, policy: customPolicy }); expect(await hooks.run(name)).toContain(code); expect(hooks.provider.bodies).toHaveLength(1);
    const rows = await hooks.dump(name); expect(rows.cloud_invocations[0]).toMatchObject({ state: 'failed', errorCode: code, resultJson: null });
    expect(JSON.stringify(rows)).not.toContain(KEY); assertClock(rows, rows.cloud_invocations[0]);
  });
  hooksTest('keeps undeclared errors fatal and preserves the existing fixed SDK ledger outcome', async ({ hooks }) => {
    const name = await hooks.setup({ result: { ...failure, error: { code: 'WIDGET_UNKNOWN' } } });
    expect(await hooks.run(name)).toContain('CLOUD_TOOL_FAILED'); expect(hooks.provider.bodies).toHaveLength(1);
    const rows = await hooks.dump(name); expect(rows.cloud_executions[0].fatalCode).toBe('CLOUD_TOOL_FAILED');
    expect(rows.cloud_invocations[0]).toMatchObject({ state: 'succeeded', errorCode: null });
    expect(JSON.parse(rows.cloud_invocations[0].resultJson)).toEqual({ ok: false, error: { code: 'CLOUD_TOOL_FAILED' }, usage: { credits: 0 } });
  });
  hooksTest('accepts exactly 2048 canonical bytes of declared error data', async ({ hooks }) => {
    const name = await hooks.setup({ result: { ...failure, error: { code: 'WIDGET_INVALID', data: 'é'.repeat(1023) } } });
    expect(await hooks.run(name)).toContain('"type":"done"'); expect(hooks.modelResults()[0].error.data).toBe('é'.repeat(1023));
  });
  hooksTest('rejects a fixed SDK map collision at configure', async ({ hooks }) => {
    const name = 'collision';
    const response = await hooks.rpc(name, 'setup', { config, control: { policy: { domainErrors: ['NOT_FOUND'] } } });
    expect(response.status).toBe(400); expect(await response.text()).toContain('CLOUD_TOOL_NOT_AVAILABLE'); expect(hooks.provider.bodies).toHaveLength(0);
  });
  hooksTest('interrupts pending pure calls on restart and does not replay them', async ({ hooks }) => {
    const name = await hooks.setup(); const seeded = await hooks.json(name, 'seed', { seed: { phase: 'execute', ledger: true, toolName: 'render_widget' } });
    await hooks.restart(); await hooks.json(name, 'ready'); const rows = await hooks.dump(name);
    expect(rows.fixture_dispatches).toHaveLength(0); expect(rows.cloud_invocations[0]).toMatchObject({ invocationId: seeded.invocationId, state: 'interrupted', replay: 'unsafe' }); assertClock(rows, rows.cloud_invocations[0]);
  });
  hooksTest('interrupts an actually dispatched pure call on restart without another consumer call', async ({ hooks }) => {
    const name = await hooks.setup({ pause: true }); const pending = hooks.run(name).catch(() => 'closed');
    await vi.waitFor(async () => expect((await hooks.dump(name)).fixture_dispatches).toHaveLength(1));
    await hooks.restart(); await pending; await hooks.json(name, 'ready'); const rows = await hooks.dump(name);
    expect(rows.fixture_dispatches).toHaveLength(1); expect(rows.fixture_dispatches[0].completed).toBe(0);
    expect(rows.cloud_invocations[0]).toMatchObject({ state: 'interrupted', replay: 'unsafe', replayCount: 0 }); assertClock(rows, rows.cloud_invocations[0]);
  });
  hooksTest('counts pure calls against the tool-call limit', async ({ hooks }) => {
    hooks.provider.reset([['render_widget'], ['render_widget']]); const name = await hooks.setup({}, { toolCalls: 1 });
    expect(await hooks.run(name)).toContain('CLOUD_TOOL_LIMIT'); expect((await hooks.dump(name)).fixture_dispatches).toHaveLength(1);
  });
  hooksTest('applies the call timeout to a paused pure tool', async ({ hooks }) => {
    const name = await hooks.setup({ pause: true }, { callTimeoutMs: 50 }); expect(await hooks.run(name)).toContain('CLOUD_TOOL_TIMEOUT');
    const rows = await hooks.dump(name); expect(rows.cloud_invocations[0]).toMatchObject({ state: 'timed_out', resultJson: null }); assertClock(rows, rows.cloud_invocations[0]);
  });
  hooksTest('replays the skill safely with its full stored modelView and source clock', async ({ hooks }) => {
    const name = await hooks.setup(); await hooks.json(name, 'seed', { seed: { phase: 'execute', ledger: true } });
    await hooks.restart(); await hooks.json(name, 'control', { control: { result: { ...success, modelView: { safe: 'recovery' } } } }); await hooks.json(name, 'ready');
    const rows = await hooks.dump(name); expect(rows.fixture_dispatches).toHaveLength(1); expect(JSON.parse(rows.cloud_invocations[0].resultJson).modelView).toEqual({ safe: 'recovery' }); expect(rows.cloud_invocations[0]).toMatchObject({ replayCount: 1, state: 'succeeded' }); assertClock(rows, rows.cloud_invocations[0]);
  });
  for (const [label, nextPolicy] of [['modelViews', { modelViews: false }], ['domainErrors', { domainErrors: ['WIDGET_OTHER'] }], ['pureTools', { pureTools: ['render_widget', 'pure_other'] }], ['schema', { tools: [{ ...pure, parameters: { ...schema, required: [] } }] }]] as const) hooksTest(`blocks boot dispatch and new runs after a ${label} policy change`, async ({ hooks }) => {
    const name = await hooks.setup(); await hooks.json(name, 'seed', { seed: { phase: 'execute', ledger: true } });
    await hooks.restart(nextPolicy); await hooks.json(name, 'ready'); const rows = await hooks.dump(name);
    expect(rows.fixture_dispatches).toHaveLength(0); expect(rows.cloud_invocations[0]).toMatchObject({ state: 'failed', errorCode: 'CLOUD_EXECUTION_INTERRUPTED' });
    expect(await hooks.run(name)).toContain('CLOUD_SESSION_CONFLICT'); expect(hooks.provider.bodies).toHaveLength(0);
    const response = await hooks.rpc(name, 'setup', { config }); expect(response.status).toBe(409);
    await hooks.restart();
  });
  for (const state of ['failed', 'aborted', 'timed_out', 'interrupted'] as const) hooksTest(`projects ${state} from a null-result ledger row with a durable clock`, async ({ hooks }) => {
    const name = await hooks.setup(); await hooks.json(name, 'terminal', { input: { state, recovery: state === 'interrupted' } }); const rows = await hooks.dump(name);
    const row = rows.cloud_invocations[0]; expect(row).toMatchObject({ state, resultJson: null }); assertClock(rows, row);
    expect(JSON.parse(rows.cloud_projections[0].dataJson)).toMatchObject({ state, data: null, settledAt: row.settledAt, settledEventSeq: row.settledEventSeq });
  });
  hooksTest('rolls back the terminal row, event and projection when the clock write fails', async ({ hooks }) => {
    const name = await hooks.setup(); const response = await hooks.rpc(name, 'terminal', { input: { state: 'failed', rollback: true } }); expect(response.status).toBe(502);
    const rows = await hooks.dump(name); expect(rows.cloud_invocations[0]).toMatchObject({ state: 'running', settledAt: null, settledEventSeq: null });
    expect(rows.cloud_events.some((row: any) => row.type === 'tool.settled')).toBe(false); expect(rows.cloud_projections).toHaveLength(0);
  });
  for (const mode of ['age', 'count'] as const) hooksTest(`uses ledger identity and clock in lookup after ${mode} event retention`, async ({ hooks }) => {
    hooks.provider.reset([['get_financial_statements']]); const name = await hooks.setup(); await hooks.run(name); const before = await hooks.dump(name); const source = before.cloud_invocations[0];
    await hooks.json(name, 'trim', { input: mode === 'age' ? { now: Date.now() + 8 * 86_400_000 } : { count: true } });
    hooks.provider.reset([['render_widget']]); await hooks.run(name); const rows = await hooks.dump(name);
    // The second run resolves an earlier source through the session-local ledger.
    const render = rows.cloud_invocations.find((row: any) => row.toolName === 'render_widget'); const lookup = JSON.parse(render.resultJson).source;
    expect(lookup).toMatchObject({ conversationId: source.conversationId, toolCallId: source.toolCallId, toolName: source.toolName,
      settledAt: source.settledAt, settledEventSeq: source.settledEventSeq });
    expect(rows.cloud_events.some((row: any) => row.eventKey === `tool:${source.invocationId}:settled`)).toBe(false);
  });
  hooksTest('migrates old ledger rows without inventing a clock and rejects them as widget sources', async ({ hooks }) => {
    hooks.provider.reset([['get_financial_statements']]); const name = await hooks.setup(); await hooks.run(name);
    await hooks.json(name, 'trim', { input: { legacySchema: true } }); await hooks.restart(); await hooks.json(name, 'ready');
    const before = await hooks.dump(name); expect(before.cloud_invocations[0]).toMatchObject({ settledAt: null, settledEventSeq: null });
    hooks.provider.reset([['render_widget']]); expect(await hooks.run(name)).toContain('"type":"done"');
    expect(hooks.modelResults()).toEqual([{ ok: false, error: { code: 'WIDGET_SOURCE_NOT_BINDABLE' } }]);
    const rows = await hooks.dump(name); expect(rows.cloud_invocations[0]).toMatchObject({ settledAt: null, settledEventSeq: null });
  });

  hooksTest('rejects a legacy configured session without a policy digest before recovery dispatch', async ({ hooks }) => {
    const name = await hooks.setup(); await hooks.json(name, 'seed', { seed: { phase: 'execute', ledger: true } });
    await hooks.json(name, 'trim', { input: { legacySession: true } }); await hooks.restart(); await hooks.json(name, 'ready');
    const rows = await hooks.dump(name); expect(rows.cloud_session[0].dispatcherDigest).toBeNull();
    expect(rows.fixture_dispatches).toHaveLength(0); expect(rows.cloud_invocations[0]).toMatchObject({ state: 'failed', errorCode: 'CLOUD_EXECUTION_INTERRUPTED' });
    expect(await hooks.run(name)).toContain('CLOUD_SESSION_CONFLICT'); expect(hooks.provider.bodies).toHaveLength(0);
  });
  hooksTest('accepts reordered declarations at boot and retains safe skill recovery', async ({ hooks }) => {
    const name = await hooks.setup(); await hooks.json(name, 'seed', { seed: { phase: 'execute', ledger: true } });
    await hooks.restart({ domainErrors: ['WIDGET_SOURCE_NOT_BINDABLE', 'WIDGET_INVALID'] }); await hooks.json(name, 'ready');
    expect((await hooks.dump(name)).fixture_dispatches).toHaveLength(1); await hooks.restart();
  });

});

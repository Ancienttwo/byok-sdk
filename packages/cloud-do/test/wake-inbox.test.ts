import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

const KEY = 'Primary~0123456789ABCDEFGHIJKLMNOP';
const SECONDARY = 'Secondary~0123456789QRSTUVWXYZabcd';
const SKILL = 'load_financial_analysis_skill';
const DAY = 86_400_000;
// Real workerd alarms drive every wake. Under parallel CI load one wake can take more than one second, and each poll
// of the store can take hundreds of milliseconds, so waits must not use the hidden 1 s default of vi.waitFor.
// The bounds below only stop a genuine hang. Each assertion keeps its exact expected state and count.
vi.setConfig({ testTimeout: 30_000 });
const eventually = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 10_000 });
// Tool timeout for tests that hold one call past its deadline and then need a later free call to succeed. The held
// call is paused without a bound, so only the free call depends on this value. Under parallel load a free call took up
// to 450 ms from start to settlement, which is longer than a 150 ms deadline.
const HELD_CALL_TIMEOUT_MS = 2_000;
type Row = Record<string, unknown>;
type Rows = Record<string, Row[]>;
interface ProviderCall { url: string; body: { messages: { role: string; content: string }[]; tools?: unknown[] } }
interface Scenario { usageFrames?: Record<string, number>[][]; holdBody?: 'before-usage' | 'after-usage'; leakAfterUsage?: boolean; interruptAfterUsage?: boolean; invalidToolAfterUsage?: boolean; tools?: number[]; repeat?: boolean; final?: string; pause?: boolean; pauseBilling?: boolean; status?: number }
let mf: Miniflare;
let script: string;
let persist: string;
let serial = 0;
let scenario: Scenario = {};
const calls: ProviderCall[] = [];
const reservations = new Map<string, 'held' | 'released'>();
const reserveCalls: string[] = [];
const providerReleases: (() => void)[] = [];
const logs: string[] = [];
class AuditLog extends Log { constructor() { super(LogLevel.ERROR); } protected override log(value: string) { logs.push(value); } }
const sse = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
function runtime(nativeObserver = '') {
  return new Miniflare({ resourcePersistencePath: persist, log: new AuditLog(), workers: [{ config: {
    name: 'wake-runtime', type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
    exports: { WakeAuditDO: { type: 'durable-object', storage: 'sqlite' } },
    env: { AGENTS: { type: 'durable-object', workerName: 'wake-runtime', exportName: 'WakeAuditDO' },
      AIPHABEE_ZAI_API_KEY: { type: 'text', value: KEY }, AIPHABEE_DEEPSEEK_API_KEY: { type: 'text', value: SECONDARY },
      NATIVE_OBSERVER_PAUSE: { type: 'text', value: nativeObserver } },
  }, dev: { outboundService: { type: 'node-handler', handler: async (request: IncomingMessage, response: ServerResponse) => {
    let text = ''; for await (const chunk of request) text += chunk.toString();
    const url = String(request.headers['mf-original-url'] ?? new URL(request.url ?? '/', `https://${request.headers.host}`).href);
    if (url.startsWith('https://billing.fixture/')) {
      const { key, deny } = JSON.parse(text) as { key: string; deny?: boolean };
      if (url.endsWith('/cancel')) { reservations.set(key, 'released'); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ cancelled: true })); return; }
      reserveCalls.push(key);
      if (scenario.pauseBilling) await new Promise<void>(resolve => providerReleases.push(resolve));
      const allowed = !deny && reservations.get(key) !== 'released';
      if (allowed) reservations.set(key, 'held');
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ allowed })); return;
    }
    const body = JSON.parse(text) as ProviderCall['body'];
    const index = calls.length; calls.push({ url, body });
    const heldScenario = scenario.holdBody ? { ...scenario } : undefined;
    if ((heldScenario ?? scenario).pause) await new Promise<void>(resolve => providerReleases.push(resolve));
    const providerStatus = (heldScenario ?? scenario).status;
    if (providerStatus) { response.writeHead(providerStatus); response.end('fixture-provider-unavailable'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if ((heldScenario ?? scenario).holdBody === 'before-usage') await new Promise<void>(resolve => providerReleases.push(resolve));
    for (const usage of (heldScenario ?? scenario).usageFrames?.[index] ?? []) response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    if ((heldScenario ?? scenario).holdBody === 'after-usage') await new Promise<void>(resolve => providerReleases.push(resolve));
    if ((heldScenario ?? scenario).leakAfterUsage) { response.end(sse({ content: KEY }, 'stop') + 'data: [DONE]\n\n'); return; }
    if ((heldScenario ?? scenario).interruptAfterUsage) { response.end('data: {'); return; }
    if ((heldScenario ?? scenario).invalidToolAfterUsage) { response.end(sse({ tool_calls: [{ index: 0, id: 'source_0', type: 'function', function: { name: 'not_offered', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n'); return; }
    const count = (heldScenario ?? scenario).tools?.[index] ?? ((heldScenario ?? scenario).repeat ? 1 : 0);
    if (count) response.end(sse({ tool_calls: Array.from({ length: count }, (_, i) => ({ index: i, id: `source_${i}`, type: 'function', function: { name: SKILL, arguments: '{}' } })) }, 'tool_calls') + 'data: [DONE]\n\n');
    else {
      const answer = (heldScenario ?? scenario).final ?? `Reply ${index + 1}: ${body.messages.filter(message => message.role === 'tool').length} document results.`;
      for (let offset = 0; offset < answer.length; offset += 8_192) response.write(sse({ content: answer.slice(offset, offset + 8_192) }));
      response.end(sse({}, 'stop') + 'data: [DONE]\n\n');
    }
  } } } }] });
}
beforeAll(async () => {
  const instructions = await readFile(path.resolve(import.meta.dirname, 'fixtures/financial-analysis.md'), 'utf8');
  const bundled = await build({ entryPoints: [path.resolve(import.meta.dirname, 'wake-inbox-worker.ts')], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
    define: { __FINANCIAL_ANALYSIS_SKILL__: JSON.stringify(instructions) }, write: false });
  script = bundled.outputFiles![0]!.text;
  persist = await mkdtemp(path.join(os.tmpdir(), 'byok-wake-inbox-'));
  mf = runtime(); await mf.ready;
});
afterAll(async () => { providerReleases.splice(0).forEach(resolve => resolve()); await mf?.dispose(); if (persist) await rm(persist, { recursive: true, force: true }); });
beforeEach(() => { providerReleases.splice(0).forEach(resolve => resolve()); calls.length = 0; logs.length = 0; scenario = {}; reservations.clear(); reserveCalls.length = 0; });
// A failed test can leave its alarms and wakes running in the shared runtime, and they add calls to the next test.
// Replace the runtime and its store after a failure, so that one failure cannot cause failures in later tests.
afterEach(async ({ task }) => {
  if (task.result?.state !== 'fail') return;
  providerReleases.splice(0).forEach(resolve => resolve()); await mf.dispose(); await rm(persist, { recursive: true, force: true });
  persist = await mkdtemp(path.join(os.tmpdir(), 'byok-wake-inbox-')); mf = runtime(); await mf.ready;
});
async function rpc(name: string, operation: string, extra: Row = {}) {
  return (await mf.getWorker('wake-runtime')).fetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, ...extra }) });
}
async function json<T = Row>(name: string, operation: string, extra: Row = {}): Promise<T> {
  const response = await rpc(name, operation, extra); const text = await response.text(); expect(response.status, text).toBe(200); return JSON.parse(text) as T;
}
async function setup(controls: Row = {}, limits?: Row) {
  const name = `wake-${++serial}`;
  await json(name, 'setup', { controls, config: { identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: name },
    principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' }, scopes: ['read:fixture'], dispatcherId: 'wake-documents', ...(limits ? { limits } : {}) } });
  return name;
}
const dump = (name: string) => json<Rows>(name, 'dump');
const sql = (name: string, query: string, params: (string | number | null)[] = []) => json<Row[]>(name, 'sql', { query, params });
async function enqueue(name: string, item: Row) { return json<Row>(name, 'enqueue', { item: { source: 'message', ...item } }); }
async function waitState(name: string, count = 1, state = 'completed') { await eventually(async () => expect((await dump(name)).cloud_executions?.filter(row => row.state === state)).toHaveLength(count)); return dump(name); }
async function restart(nativeObserver = '') { await mf.dispose(); mf = runtime(nativeObserver); await mf.ready; }
function frameEvents(rows: Rows): (Row & { data: Row })[] { return (rows.cloud_events ?? []).map(row => ({ ...row, data: JSON.parse(String(row.dataJson)) as Row })); }
function entries(rows: Rows) { return (rows.pi_entries ?? []).map(row => JSON.parse(String(row.record)) as Row); }
function tasks(rows: Rows) { return (rows.pi_tasks ?? []).map(row => JSON.parse(String(row.record)) as Row); }
function noSecrets(...values: unknown[]) {
  const text = JSON.stringify(values);
  for (const key of [KEY, SECONDARY]) for (const secret of [key, ...Array.from({ length: key.length - 15 }, (_, i) => key.slice(i, i + 16))]) {
    for (const form of [secret, btoa(secret), encodeURIComponent(secret)]) expect(text).not.toContain(form);
  }
}
async function code(name: string, operation: string, extra: Row, expected: string) {
  const response = await rpc(name, operation, extra); expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await response.json()).toMatchObject({ error: { code: expected } });
}
function wakeInput(index: number) { return JSON.parse(calls[index]!.body.messages.find(message => message.role === 'user')!.content) as { history: { input: unknown; reply: string }[]; inbox: { seq: number; source: string; text: string }[] }; }
// Miniflare's getWorker() fetch wraps undici's Response in a new Response and drops the original. undici cancels the
// shared body when that original object is garbage collected while the body is unlocked, and the reader then sees an
// empty, finished stream. Lock the body as soon as the stream opens, before any other await, so that GC cannot cancel it.
async function events(name: string, cursor: Row) { return (await rpc(name, 'events', { cursor })).body!.getReader(); }
async function readFrames(reader: Awaited<ReturnType<typeof events>>, count: number) {
  const decoder = new TextDecoder(); let text = '';
  while ((text.match(/^id: /gm) ?? []).length < count) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value); }
  await reader.cancel();
  return text.split('\n\n').filter(frame => frame.startsWith('id:')).map(frame => ({ id: Number(frame.match(/^id: (\d+)/m)![1]), type: frame.match(/^event: (.*)/m)![1], data: JSON.parse(frame.match(/^data: (.*)/m)![1]!) as Row }));
}

describe('real workerd inbox admission and durable dedup', () => {
  it('stores omitted defaults once, conflicts on all payload fields, and keeps terminal keys', async () => {
    const name = await setup(); const availableAt = Date.now() + DAY;
    const first = await enqueue(name, { dedupKey: 'same', text: 'first', availableAt });
    expect(first.accepted).toBe(true);
    expect((await enqueue(name, { dedupKey: 'same', text: 'first', availableAt })).accepted).toBe(false);
    const row = (await dump(name)).cloud_inbox![0]!;
    expect(row.expiresAt).toBe(availableAt + DAY);
    for (const change of [{ text: 'second' }, { source: 'schedule' }, { profile: 'deepseek_direct' }, { availableAt: availableAt + 1 }, { expiresAt: availableAt + DAY + 1 }]) {
      await code(name, 'enqueue', { item: { dedupKey: 'same', source: 'message', text: 'first', availableAt, ...change } }, 'CLOUD_INBOX_CONFLICT');
      expect((await dump(name)).cloud_inbox).toHaveLength(1);
    }
    await json(name, 'cancel-item', { seq: row.seq });
    expect((await enqueue(name, { dedupKey: 'same', text: 'first', availableAt })).accepted).toBe(false);
    const before = Date.now(); await enqueue(name, { dedupKey: 'default-times', text: 'default' });
    await eventually(async () => expect((await dump(name)).cloud_inbox!.find(row => row.dedupKey === 'default-times')!.state).toBe('done'));
    expect((await enqueue(name, { dedupKey: 'default-times', text: 'default' })).accepted).toBe(false);
    const defaults = (await dump(name)).cloud_inbox!.find(row => row.dedupKey === 'default-times')!;
    expect(Number(defaults.availableAt)).toBeGreaterThanOrEqual(before); expect(defaults.expiresAt).toBe(Number(defaults.availableAt) + DAY);
  });

  for (const bad of [{ availableAt: 1.5 }, { availableAt: Number.MAX_SAFE_INTEGER }, { expiresAt: 0 }, { availableAt: 30, expiresAt: 30 },
    { text: 'x'.repeat(16_001) }, { dedupKey: 'x'.repeat(129) }, { dedupKey: 'bad\nkey' }, { credentials: { apiKey: KEY } }, { source: 'cron' },
    { text: KEY }, { text: btoa(SECONDARY) }, { dedupKey: encodeURIComponent(KEY) }, { apiKey: 'unknown' }]) {
    it(`rejects ${JSON.stringify(bad).slice(0, 90)} before any persistent item or event`, async () => {
      const name = await setup(); const before = await dump(name);
      const response = await rpc(name, 'enqueue', { item: { dedupKey: 'bad', source: 'message', text: 'valid', ...bad } });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const after = await dump(name); expect(after.cloud_inbox).toEqual(before.cloud_inbox); expect(after.cloud_events).toEqual(before.cloud_events);
      expect(calls).toHaveLength(0); noSecrets(after, logs);
    });
  }

  it('rejects a platform key and invalid default-time expiry before schema initialization', async () => {
    for (const change of [{ text: KEY }, { dedupKey: SECONDARY }, { expiresAt: 0 }]) {
      const name = 'fresh-admission-' + (++serial);
      const before = await dump(name);
      const response = await rpc(name, 'enqueue', { item: { dedupKey: 'bad', source: 'message', text: 'valid', ...change } });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await dump(name)).toEqual(before);
      expect(calls).toHaveLength(0);
    }
  });

  it('caps queued items at 100 and rolls back both acceptance and alarm on event failure', async () => {
    const name = await setup(); const availableAt = Date.now() + DAY;
    for (let i = 0; i < 100; i++) await enqueue(name, { dedupKey: `capacity:${i}`, text: 'queued', availableAt });
    await code(name, 'enqueue', { item: { dedupKey: 'overflow', source: 'message', text: 'queued', availableAt } }, 'CLOUD_INBOX_FULL');
    expect((await dump(name)).cloud_inbox).toHaveLength(100);
    const other = await setup(); const alarmBefore = (await json(other, 'status')).alarm;
    await sql(other, "CREATE TRIGGER fixture_accept_fail BEFORE INSERT ON cloud_events WHEN NEW.type='inbox.accepted' BEGIN SELECT RAISE(ABORT,'accept-storage-failure'); END");
    expect((await rpc(other, 'enqueue', { item: { dedupKey: 'atomic', source: 'message', text: 'atomic', availableAt } })).status).toBeGreaterThanOrEqual(400);
    const rows = await dump(other); expect(rows.cloud_inbox).toEqual([]); expect(rows.cloud_events).toEqual([]); expect((await json(other, 'status')).alarm).toBe(alarmBefore);
  });
});

describe('native wake runs, continuity, profile order and gate budgets', () => {
  it('uses real future alarms, preserves T2 and builds history from native final replies only', async () => {
    const name = await setup(); expect((await json(name, 'status')).alarm).toBeNull();
    scenario = { tools: [1] };
    // Each check below must run before the next real alarm. Under load one RPC poll can take over a second,
    // so the gaps are larger than the measured poll latency.
    const t1 = Date.now() + 1_000, t2 = t1 + 2_000;
    await enqueue(name, { dedupKey: 'T1', text: 'first input', availableAt: t1 });
    await enqueue(name, { dedupKey: 'T2', source: 'schedule', text: 'second input', availableAt: t2 });
    expect(Number((await json(name, 'status')).alarm)).toBeLessThanOrEqual(t1);
    const first = await waitState(name); expect(calls).toHaveLength(2);
    expect((first.fixture_alarms ?? []).every(row => Number(row.at) >= t1)).toBe(true);
    expect((await json(name, 'status')).alarm).toBe(t2);
    const rows = await waitState(name, 2); expect(calls).toHaveLength(3);
    expect(new Set(rows.cloud_executions!.map(row => row.conversationId)).size).toBe(2);
    const input = entries(rows).find(entry => entry.kind === 'byok.run-input')!;
    expect(input.model).toBeUndefined();
    const committed = await json<{ entries: Row[] }>(name, 'context', { id: first.cloud_executions![0]!.conversationId });
    expect(committed.entries.find(entry => entry.kind === 'byok.run-input')!.model).toBeUndefined();
    expect(wakeInput(2).history).toHaveLength(1); expect(wakeInput(2).history[0]!.reply).toBe('Reply 2: 1 document results.');
    expect(JSON.stringify(calls[2]!.body)).not.toContain('"instructions"');
    expect(rows.cloud_inbox!.every(row => row.payloadJson === null)).toBe(true);
    noSecrets(rows, calls, logs);
  });

  it('never skips a different profile when selecting a contiguous batch', async () => {
    const name = await setup(); const availableAt = Date.now() + 500;
    for (const [i, profile] of ['zai_openai', 'deepseek_direct', 'zai_openai'].entries()) await enqueue(name, { dedupKey: `profile:${i}`, text: `item ${i}`, profile, availableAt });
    const rows = await waitState(name, 3);
    expect(calls.map(call => call.url.includes('api.deepseek.com'))).toEqual([false, true, false]);
    expect(calls.map((_, i) => wakeInput(i).inbox.map(item => item.text))).toEqual([['item 0'], ['item 1'], ['item 2']]);
    expect(rows.cloud_inbox!.map(row => row.attempts)).toEqual([1, 1, 1]);
  });

  it('uses only the last 20 completed native runs in chronological history order', async () => {
    const name = await setup();
    for (let i = 0; i < 22; i++) { await enqueue(name, { dedupKey: `history:${i}`, text: `history ${i}` }); await waitState(name, i + 1); }
    expect(calls).toHaveLength(22);
    const history = wakeInput(21).history; expect(history).toHaveLength(20);
    expect(history[0]!.reply).toBe('Reply 2: 0 document results.'); expect(history.at(-1)!.reply).toBe('Reply 21: 0 document results.');
  });

  it('measures the complete canonical JSON budget including multibyte and escaped controls', async () => {
    const name = await setup({ largeSchema: true }); const availableAt = Date.now() + 500;
    for (let i = 0; i < 4; i++) await enqueue(name, { dedupKey: `bytes:${i}`, text: (i % 2 ? '会话' : '\u0001').repeat(2_000), availableAt });
    await eventually(async () => expect((await dump(name)).cloud_inbox!.every(row => row.state === 'done')).toBe(true));
    for (let i = 0; i < calls.length; i++) expect(Buffer.byteLength(JSON.stringify(wakeInput(i)))).toBeLessThanOrEqual(48_000);
    expect(Buffer.byteLength(JSON.stringify(calls[0]!.body.tools))).toBeGreaterThan(48_000);
  });

  it('rejects one unfit 16000-character control item with no paid call and keeps other work queued', async () => {
    const name = await setup(); const availableAt = Date.now() + 100;
    await enqueue(name, { dedupKey: 'unfit', text: '\u0001'.repeat(16_000), availableAt });
    await enqueue(name, { dedupKey: 'later', text: 'safe later', availableAt: availableAt + DAY });
    await eventually(async () => expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_INBOX_TOO_LARGE' }, { state: 'queued' }]));
    expect(calls).toHaveLength(0);
  });

  it('rejects an inbox array of exactly 48000 bytes because the complete wrapper exceeds the budget', async () => {
    const name = await setup(); let text = '会'.repeat(15_980);
    const size = () => Buffer.byteLength(JSON.stringify([{ seq: 1, source: 'message', text }]));
    text += 'x'.repeat(48_000 - size()); expect(size()).toBe(48_000); expect(text.length).toBeLessThanOrEqual(16_000);
    await enqueue(name, { dedupKey: 'exact-array-budget', text });
    await eventually(async () => expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_INBOX_TOO_LARGE' }]));
    expect(calls).toHaveLength(0);
  });

  it('stops the ninth native model step before a provider request', async () => {
    const name = await setup(); scenario = { repeat: true };
    await enqueue(name, { dedupKey: 'steps', text: 'read each step' });
    const rows = await waitState(name, 1, 'failed'); expect(calls).toHaveLength(8);
    expect(rows.cloud_executions).toMatchObject([{ steps: 8, fatalCode: 'CLOUD_STEP_LIMIT' }]);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_STEP_LIMIT' }]);
  });

  it('stops the thirteenth native tool call before consumer dispatch', async () => {
    const name = await setup(); scenario = { tools: [4, 4, 4, 1] };
    await enqueue(name, { dedupKey: 'tools', text: 'read tools' });
    const rows = await waitState(name, 1, 'failed'); expect(rows.fixture_dispatches).toHaveLength(12); expect(calls).toHaveLength(4);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_TOOL_LIMIT' }]);
  });
});

describe('single native slot, arrivals and cancellation', () => {
  it('holds one wake slot, coalesces mid-run arrivals, and caps the next batch at 16', async () => {
    const name = await setup({ pauseTool: true }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'active', text: 'first' });
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    await code(name, 'submit', { input: { instruction: 'must be busy' } }, 'CLOUD_TOOL_BUSY');
    for (let i = 0; i < 17; i++) await enqueue(name, { dedupKey: `arrival:${i}`, text: `later ${i}` });
    const active = await dump(name); expect(active.cloud_executions).toMatchObject([{ state: 'running' }]); expect(calls).toHaveLength(1);
    expect(reserveCalls).toHaveLength(1);
    await json(name, 'release'); await waitState(name, 3);
    expect(calls).toHaveLength(4);
    expect(wakeInput(2).inbox).toHaveLength(16); expect(wakeInput(3).inbox).toHaveLength(1);
  });

  it('keeps a live submit intact while alarms run bounded maintenance', async () => {
    const name = await setup({ pauseTool: true, deny: true }); scenario = { tools: [1] };
    const response = await rpc(name, 'submit', { input: { instruction: 'live submit' } }); const reading = response.text();
    void reading.catch(() => undefined);
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    await enqueue(name, { dedupKey: 'while-submit', text: 'later', availableAt: Date.now() + 100 });
    await json(name, 'controls', { controls: { pauseTool: true, deny: true, failCredentials: true } });
    await eventually(async () => expect((await dump(name)).fixture_alarms!.length).toBeGreaterThan(0));
    expect((await dump(name)).cloud_executions).toMatchObject([{ state: 'running' }]);
    expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'queued', attempts: 0 }]); expect(reserveCalls).toHaveLength(0); expect(calls).toHaveLength(1);
    await json(name, 'controls', { controls: { pauseTool: true, deny: true } });
    await json(name, 'release'); await reading;
  });

  it('cancels queued items without claiming and cancels active runs through the native signal', async () => {
    const name = await setup({ pauseTool: true }); scenario = { tools: [1] };
    const future = await enqueue(name, { dedupKey: 'cancel-queued', text: 'queued', availableAt: Date.now() + DAY });
    const futureSeq = Number(future.seq ?? (future.row as Row)?.seq); await json(name, 'cancel-item', { seq: futureSeq });
    await enqueue(name, { dedupKey: 'cancel-running', text: 'running' });
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    const running = (await dump(name)).cloud_inbox!.find(row => row.state === 'running')!;
    await json(name, 'cancel-item', { seq: running.seq });
    await eventually(async () => expect((await dump(name)).cloud_inbox!.find(row => row.seq === running.seq)!.state).toBe('failed'));
    await json(name, 'release');
    const rows = await dump(name); expect(rows.cloud_inbox).toMatchObject([{ state: 'cancelled', attempts: 0 }, { state: 'failed', errorCode: 'CLOUD_EXECUTION_ABORTED' }]);
    expect(calls).toHaveLength(1); noSecrets(rows, logs);
  });
});

describe('transactional invocation events, projections and native delivery', () => {
  it('keeps a throwing post-commit doorbell harmless and gives repeated call_1 ids separate native evidence', async () => {
    const name = await setup({ throwDoorbell: true, projection: 'valid' }); scenario = { tools: [1, 1] };
    await enqueue(name, { dedupKey: 'delivery', text: 'read two tool rounds' });
    const rows = await waitState(name);
    expect(rows.cloud_invocations).toHaveLength(2);
    expect(rows.cloud_invocations!.map(row => row.toolCallId)).toEqual(['call_1', 'call_1']);
    expect(new Set(rows.cloud_invocations!.map(row => row.assistantEntryId)).size).toBe(2);
    expect(rows.cloud_invocations!.every(row => row.state === 'succeeded' && row.deliveredState === 'delivered')).toBe(true);
    expect((await json<{ bells: unknown[] }>(name, 'status')).bells).toHaveLength(2);
    expect(rows.cloud_projections).toHaveLength(2);
    expect(frameEvents(rows).filter(event => event.type === 'tool.settled')).toHaveLength(2);
    expect(frameEvents(rows).filter(event => event.type === 'tool.delivered')).toHaveLength(2);
    for (const invocation of rows.cloud_invocations!) {
      const task = tasks(rows).find(task => task.id === invocation.taskId)!;
      expect(task).toMatchObject({ input: { assistant: invocation.assistantEntryId, callId: invocation.toolCallId }, state: { status: 'terminal', outcome: { status: 'completed' } } });
      const entry = entries(rows).find(entry => entry.id === invocation.resultEntryId)!;
      expect(entry).toMatchObject({ kind: 'pi.tool-result', byTaskId: invocation.taskId });
      const dispatch = rows.fixture_dispatches!.map(row => JSON.parse(String(row.contextJson)) as Row).find(row => (row.call as Row).invocationId === invocation.invocationId)!;
      expect(dispatch.frozen).toEqual([true, true, true, true, true]);
      expect(dispatch.call).toMatchObject({ conversationId: invocation.conversationId, toolCallId: invocation.toolCallId, attempt: invocation.attempt });
      expect(dispatch.lookup).toMatchObject({ toolName: SKILL, state: 'running', resultJson: null });
    }
  });

  for (const projection of ['throw', 'json', 'large', 'key', 'unicode'] as const) it(`contains ${projection} projection failure without changing terminal tool or native run outcome`, async () => {
    const name = await setup({ projection }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'projection', text: 'read document' });
    const rows = await waitState(name);
    expect(rows.cloud_invocations).toMatchObject([{ state: 'succeeded', deliveredState: 'delivered' }]);
    expect(rows.cloud_projections).toHaveLength(1);
    expect(JSON.stringify(rows.cloud_projections)).toContain('CLOUD_PROJECTION_FAILED');
    expect(frameEvents(rows).filter(event => event.type === 'projection.failed')).toHaveLength(1);
    expect(frameEvents(rows).filter(event => event.type === 'tool.settled')).toHaveLength(1);
    noSecrets(rows, calls, logs);
  });

  it('stores consumer marker-shaped keys under the projection namespace', async () => {
    const name = await setup({ projection: 'marker' }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'namespace', text: 'read document' });
    const rows = await waitState(name);
    expect(JSON.stringify(rows.cloud_projections)).toContain('projection:');
    expect(frameEvents(rows).filter(event => event.type === 'projection.failed')).toHaveLength(0);
  });
});

describe('persisted restarts and consumer reservation fencing', () => {
  it('rejects a failed actual credential read before enqueue writes or alarm changes', async () => {
    const name = await setup(); const before = await dump(name);
    await json(name, 'controls', { controls: { failCredentials: true } });
    await code(name, 'enqueue', { item: { dedupKey: 'failed-reader', source: 'message', text: 'never persist' } }, 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
    const rows = await dump(name); expect(rows.cloud_inbox).toEqual(before.cloud_inbox); expect(rows.cloud_events).toEqual(before.cloud_events);
    expect((await json(name, 'status')).alarm).toBeNull(); expect(calls).toHaveLength(0);
    await json(name, 'controls', { controls: {} }); noSecrets(rows, logs);
  });

  it('keeps cancellation terminal when real consumer admission denies the remaining selected item', async () => {
    const name = await setup({ pauseAdmission: true, deny: true }); const availableAt = Date.now() + 200;
    await enqueue(name, { dedupKey: 'denied', text: 'denied selection', availableAt });
    const cancelled = await enqueue(name, { dedupKey: 'cancel-before-denial', text: 'cancelled selection', availableAt });
    await eventually(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    await json(name, 'cancel-item', { seq: cancelled.seq }); await json(name, 'release');
    const rows = await waitState(name, 1, 'interrupted');
    expect(rows.cloud_inbox).toMatchObject([{ state: 'failed', attempts: 0, errorCode: 'CLOUD_TOOL_NOT_AVAILABLE' }, { state: 'cancelled', attempts: 0 }]);
    expect(calls).toHaveLength(0); expect(reserveCalls).toHaveLength(1); expect(reservations.size).toBe(0);
  });

  it('releases a real held reservation once when credential preflight fails and preserves cancelled rows', async () => {
    const name = await setup({ pauseAdmission: true }); const availableAt = Date.now() + 200;
    await enqueue(name, { dedupKey: 'credential-failure', text: 'selected', availableAt });
    const cancelled = await enqueue(name, { dedupKey: 'cancel-before-preflight', text: 'cancel selected', availableAt });
    await eventually(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    const key = reserveCalls[0]!; expect(reservations.get(key)).toBe('held');
    await json(name, 'cancel-item', { seq: cancelled.seq });
    await json(name, 'controls', { controls: { pauseAdmission: true, failCredentials: true } }); await json(name, 'release');
    const rows = await waitState(name, 1, 'interrupted');
    expect(rows.cloud_inbox).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE' }, { state: 'cancelled' }]);
    expect(frameEvents(rows).filter(event => event.type === 'run.reservation' && event.data.key === key && event.data.action === 'release')).toHaveLength(1);
    await json(name, 'billing-cancel', { key }); expect(reservations.get(key)).toBe('released');
    expect(reserveCalls).toHaveLength(1); expect(calls).toHaveLength(0); await json(name, 'controls', { controls: {} });
  });

  it('observes a genuine placed native submission with zero steps and requeues from the saved eligibility', async () => {
    const name = await setup({ nativePause: 'request' });
    await enqueue(name, { dedupKey: 'zero-step', text: 'pause native request' });
    await eventually(async () => {
      const rows = await dump(name); expect(rows.cloud_executions).toMatchObject([{ state: 'running', steps: 0, aborted: 0, fatalCode: null }]);
      expect(rows.pi_submissions!.map(row => JSON.parse(String(row.record)))).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'placed' })]));
      expect(tasks(rows).some(task => (task.state as Row).status === 'running' && ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true);
    });
    expect(calls).toHaveLength(0); await restart('alarm'); await json(name, 'ready');
    const recovered = await dump(name);
    expect(recovered.cloud_inbox).toMatchObject([{ state: 'queued', attempts: 1, runId: null }]);
    expect(recovered.cloud_executions).toMatchObject([{ state: 'interrupted' }]);
    expect(calls).toHaveLength(0);
    await json(name, 'release'); const rows = await waitState(name);
    expect(rows.cloud_executions![0]).toMatchObject({ state: 'interrupted' });
    expect(JSON.parse(String(rows.cloud_executions![0]!.eligibilityJson))).toEqual({ steps: 0, aborted: 0, fatalCode: null, wasStale: true });
    expect(rows.cloud_inbox).toMatchObject([{ state: 'done', attempts: 2 }]); expect(calls).toHaveLength(1);
  });

  it('keeps a failed recovery promise rejected instead of swallowing its storage failure', async () => {
    const name = await setup({ nativePause: 'request' });
    await enqueue(name, { dedupKey: 'recovery-rejection', text: 'fail actual recovery settlement' });
    await eventually(async () => expect(tasks(await dump(name)).some(task => ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true));
    await sql(name, "CREATE TRIGGER fixture_recovery_fail BEFORE INSERT ON cloud_events WHEN NEW.type='run.interrupted' BEGIN SELECT RAISE(ABORT,'recovery-write-failure'); END");
    await restart('alarm');
    await code(name, 'ready', {}, 'CLOUD_MODEL_REQUEST_FAILED');
    const first = await dump(name);
    expect(first.cloud_executions).toMatchObject([{ state: 'running', steps: 0 }]);
    expect(first.cloud_inbox).toMatchObject([{ state: 'running', attempts: 1 }]);
    await code(name, 'ready', {}, 'CLOUD_MODEL_REQUEST_FAILED');
    expect((await dump(name)).cloud_executions).toEqual(first.cloud_executions);
    expect(frameEvents(first).filter(event => event.type === 'run.interrupted')).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('preserves zero-step cancellation across restart instead of requeueing', async () => {
    const name = await setup({ nativePause: 'request' }); await enqueue(name, { dedupKey: 'aborted-zero', text: 'cancel before request' });
    await eventually(async () => expect(tasks(await dump(name)).some(task => ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true));
    await json(name, 'cancel-run');
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ steps: 0, aborted: 1, fatalCode: 'CLOUD_EXECUTION_ABORTED' }]);
    await restart(); await json(name, 'ready');
    expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'interrupted', attempts: 1, errorCode: 'CLOUD_EXECUTION_ABORTED' }]); expect(calls).toHaveLength(0);
  });

  it('preserves the original zero-step eligibility through a second restart after native abort before adjudication', async () => {
    const name = await setup({ nativePause: 'request' }); await enqueue(name, { dedupKey: 'double-restart', text: 'save eligibility once' });
    await eventually(async () => expect(tasks(await dump(name)).some(task => ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true));
    expect(calls).toHaveLength(0); await restart('recovery');
    await json(name, 'controls', { controls: { nativePause: 'recovery' } });
    expect((await json(name, 'open-recovery')).recovering).toBe(true);
    await eventually(async () => expect(tasks(await dump(name)).every(task => (task.state as Row).status === 'terminal')).toBe(true));
    const paused = await dump(name);
    expect(JSON.parse(String(paused.cloud_executions![0]!.eligibilityJson))).toEqual({ steps: 0, aborted: 0, fatalCode: null, wasStale: true });
    expect(paused.cloud_executions![0]!.fatalCode).toBe('CLOUD_EXECUTION_INTERRUPTED');
    expect(paused.cloud_inbox).toMatchObject([{ state: 'running', attempts: 1 }]);
    expect(paused.pi_submissions!.map(row => JSON.parse(String(row.record)))).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'unanswered' })]));
    await restart(); await json(name, 'ready'); const rows = await waitState(name);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'done', attempts: 2 }]); expect(calls).toHaveLength(1);
    expect(JSON.parse(String(rows.cloud_executions![0]!.eligibilityJson))).toEqual({ steps: 0, aborted: 0, fatalCode: null, wasStale: true });
  });

  it('exhausts the fourth actual native claim after three zero-step checkpoint restarts', async () => {
    const name = await setup({ nativePause: 'request' }); await enqueue(name, { dedupKey: 'four-native-claims', text: 'bound unpaid retries' });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await eventually(async () => {
        const rows = await dump(name); expect(rows.cloud_inbox).toMatchObject([{ state: 'running', attempts: attempt }]);
        const run = rows.cloud_executions!.find(row => row.state === 'running')!; expect(run.steps).toBe(0);
        expect(tasks(rows).some(task => task.conversationId === run.conversationId && ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true);
      });
      expect(calls).toHaveLength(0); await restart('request'); await json(name, 'ready');
    }
    await eventually(async () => expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'failed', attempts: 4, errorCode: 'CLOUD_WAKE_EXHAUSTED' }]));
    expect(calls).toHaveLength(0);
    const rows = await dump(name); expect(rows.cloud_executions).toHaveLength(4);
    expect(rows.cloud_executions!.every(row => row.state === 'interrupted' && row.steps === 0)).toBe(true);
  });

  for (const trigger of ['wake', 'submit'] as const) it(`looks up a real done ${trigger} admission before its host submissionId receipt after restart`, async () => {
    const name = await setup({ nativePause: 'receipt' }); let stream: Promise<string> | undefined;
    if (trigger === 'wake') await enqueue(name, { dedupKey: 'receipt-gap', text: 'complete native before host receipt' });
    else stream = (await rpc(name, 'submit', { input: { instruction: 'complete native before host receipt' } })).text().catch(() => 'restart disconnected');
    await eventually(async () => {
      const rows = await dump(name); expect(rows.cloud_executions).toMatchObject([{ state: 'running', submissionId: null, steps: 1 }]);
      expect(rows.pi_submissions!.map(row => JSON.parse(String(row.record)))).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'done' })]));
    });
    expect(calls).toHaveLength(1); await restart(); await stream; await json(name, 'ready');
    const rows = await waitState(name); expect(calls).toHaveLength(1); expect(rows.cloud_executions).toMatchObject([{ state: 'completed', trigger }]);
    if (trigger === 'wake') expect(rows.cloud_inbox).toMatchObject([{ state: 'done' }]);
  });

  it('maps a real unanswered native submit to its fixed provider failure on recovery', async () => {
    const name = await setup({ nativePause: 'receipt' }); scenario = { status: 503 };
    const reading = (await rpc(name, 'submit', { input: { instruction: 'provider failure before host receipt' } })).text().catch(() => 'restart disconnected');
    await eventually(async () => expect((await dump(name)).pi_submissions!.map(row => JSON.parse(String(row.record)))).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'unanswered', detail: 'CLOUD_MODEL_REQUEST_FAILED' })])));
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ state: 'running', submissionId: null }]);
    await restart(); await reading; await json(name, 'ready');
    expect((await dump(name)).cloud_executions).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_MODEL_REQUEST_FAILED' }]); expect(calls).toHaveLength(1);
  });

  for (const nativeStatus of ['done', 'unanswered'] as const) it('finalizes a committed ' + nativeStatus + ' submission with actual completing native work on boot', async () => {
    const name = await setup({ holdNativeOutcome: true });
    if (nativeStatus === 'unanswered') scenario = { status: 503 };
    await enqueue(name, { dedupKey: 'completing-' + nativeStatus, text: 'hold native cleanup after committed result' });
    await eventually(async () => {
      const rows = await dump(name);
      expect(rows.pi_submissions!.map(row => JSON.parse(String(row.record)))).toEqual(expect.arrayContaining([expect.objectContaining({ status: nativeStatus })]));
      expect(tasks(rows).some(task => task.kind === 'pi.generation' && (task.state as Row).status === 'completing')).toBe(true);
      expect(rows.cloud_executions).toMatchObject([{ state: 'running', steps: 1 }]);
    });
    expect(calls).toHaveLength(1); await restart('alarm'); await json(name, 'ready');
    const rows = await dump(name);
    expect(rows.cloud_executions).toMatchObject([{ state: nativeStatus === 'done' ? 'completed' : 'failed', errorCode: nativeStatus === 'done' ? null : 'CLOUD_MODEL_REQUEST_FAILED' }]);
    expect(rows.cloud_inbox).toMatchObject([{ state: nativeStatus === 'done' ? 'done' : 'failed', attempts: 1 }]);
    expect(tasks(rows).every(task => (task.state as Row).status === 'terminal')).toBe(true);
    expect(frameEvents(rows).filter(event => event.type === (nativeStatus === 'done' ? 'run.completed' : 'run.failed'))).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('reopens a persisted unclaimed schedule and runs it once at its real alarm time', async () => {
    const name = await setup(); const availableAt = Date.now() + 500;
    await enqueue(name, { dedupKey: 'persisted-schedule', source: 'schedule', text: 'restart before claim', availableAt });
    const before = await dump(name); expect(before.cloud_inbox).toMatchObject([{ state: 'queued', attempts: 0 }]); expect(before.cloud_executions).toHaveLength(0);
    await restart(); await json(name, 'ready'); const rows = await waitState(name);
    expect(calls).toHaveLength(1); expect(rows.cloud_inbox).toMatchObject([{ state: 'done', attempts: 1 }]);
    expect(rows.fixture_alarms!.every(row => Number(row.at) >= availableAt)).toBe(true);
  });

  it('replays only the ledger after an actual in-flight native tool restart and records late undelivered settlement', async () => {
    const name = await setup({ pauseTool: true, projection: 'valid' }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'tool-restart', text: 'native tool' });
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    const before = await dump(name); expect(before.cloud_invocations).toMatchObject([{ state: 'running', replayCount: 0 }]);
    expect(tasks(before).some(task => task.kind === 'pi.tool' && (task.state as Row).status === 'running')).toBe(true);
    await restart(); await json(name, 'ready'); const rows = await dump(name);
    expect(calls).toHaveLength(1); expect(rows.fixture_dispatches).toHaveLength(2);
    expect(rows.cloud_invocations).toMatchObject([{ state: 'succeeded', replayCount: 1, deliveredState: 'undelivered' }]);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'interrupted' }]);
    expect(frameEvents(rows).filter(event => event.type === 'tool.settled')).toHaveLength(1);
    expect(frameEvents(rows).find(event => event.type === 'tool.settled')!.data.late).toBe(true);
    await restart(); await json(name, 'ready'); expect((await dump(name)).fixture_dispatches).toHaveLength(2); expect(calls).toHaveLength(1);
  });

  it('observes starting plus committed pending reservation before restart and emits one release', async () => {
    const name = await setup({ pauseAdmission: true });
    await enqueue(name, { dedupKey: 'pending-reservation', text: 'read later' });
    await eventually(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ state: 'starting', reservation: 'pending', steps: 0 }]);
    expect(before.cloud_inbox).toMatchObject([{ state: 'queued', attempts: 0 }]); expect(before.pi_submissions).toHaveLength(0);
    const key = String(before.fixture_admissions![0]!.admissionKey); expect(reservations.get(key)).toBe('held'); expect(calls).toHaveLength(0);
    await restart(); await json(name, 'ready');
    await eventually(async () => expect(frameEvents(await dump(name)).filter(event => event.type === 'run.reservation' && event.data.action === 'release' && event.data.key === key)).toHaveLength(1));
    await json(name, 'billing-cancel', { key });
    await waitState(name); expect(reservations.get(key)).toBe('released'); expect(reserveCalls.filter(value => value === key)).toHaveLength(1);
  });

  it('pins a paid native task before restart and never sends the old request again', async () => {
    const name = await setup(); scenario = { pause: true };
    await enqueue(name, { dedupKey: 'paid', text: 'paid interrupted' });
    await eventually(() => expect(calls).toHaveLength(1));
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ state: 'running', steps: 1 }]);
    expect(before.cloud_inbox).toMatchObject([{ state: 'running', attempts: 1 }]);
    expect(tasks(before).some(task => (task.state as Row).status === 'running')).toBe(true);
    await restart(); scenario = {}; providerReleases.splice(0).forEach(resolve => resolve());
    await json(name, 'ready');
    const rows = await dump(name); expect(rows.cloud_executions).toMatchObject([{ state: 'interrupted' }]);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'interrupted', errorCode: 'CLOUD_EXECUTION_INTERRUPTED' }]); expect(calls).toHaveLength(1);
    expect(frameEvents(rows).filter(event => event.type === 'run.interrupted')).toHaveLength(1);
  });

  it('repairs a pi-done run after genuine atomic settlement failure without a second model request', async () => {
    const name = await setup();
    await sql(name, "CREATE TRIGGER fixture_settle_fail BEFORE INSERT ON cloud_events WHEN NEW.type='run.completed' BEGIN SELECT RAISE(ABORT,'settlement-storage-failure'); END");
    await enqueue(name, { dedupKey: 'done-before-settle', text: 'complete once' });
    await eventually(async () => {
      const rows = await dump(name); expect(rows.pi_submissions!.map(row => JSON.parse(String(row.record)))).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'done' })]));
      expect(rows.cloud_executions).toMatchObject([{ state: 'running', steps: 1 }]);
    });
    expect(calls).toHaveLength(1);
    await sql(name, 'DROP TRIGGER fixture_settle_fail');
    await restart(); await json(name, 'ready');
    const rows = await waitState(name); expect(rows.cloud_inbox).toMatchObject([{ state: 'done' }]); expect(calls).toHaveLength(1);
    expect(frameEvents(rows).filter(event => event.type === 'run.completed')).toHaveLength(1);
  });

  it('cancels selected rows during a real admission pause and revalidates the empty claim', async () => {
    const name = await setup({ pauseAdmission: true }); await enqueue(name, { dedupKey: 'cancel-setup', text: 'cancel during setup' });
    await eventually(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ state: 'starting', reservation: 'pending' }]);
    await json(name, 'cancel-item', { seq: before.cloud_inbox![0]!.seq }); await json(name, 'release');
    const rows = await waitState(name, 1, 'interrupted'); expect(rows.cloud_executions).toMatchObject([{ errorCode: 'CLOUD_WAKE_EMPTY' }]);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'cancelled', attempts: 0 }]); expect(calls).toHaveLength(0);
    expect(frameEvents(rows).filter(event => event.type === 'run.reservation' && event.data.action === 'release')).toHaveLength(1);
  });

  it('fences a consumer reserve that arrives after cancellation and ignores its late SDK receipt', async () => {
    const name = await setup(); scenario = { pauseBilling: true };
    await enqueue(name, { dedupKey: 'cancel-before-reserve', text: 'cancel reservation' });
    await eventually(() => expect(reserveCalls).toHaveLength(1));
    const key = reserveCalls[0]!; expect(reservations.has(key)).toBe(false);
    expect((await dump(name)).cloud_executions).toMatchObject([{ state: 'starting', reservation: 'pending' }]);
    await json(name, 'cancel-run');
    await eventually(async () => expect(frameEvents(await dump(name)).filter(event => event.type === 'run.reservation' && event.data.key === key && event.data.action === 'release')).toHaveLength(1));
    // The separate consumer applies the release event before its delayed reserve commits.
    await json(name, 'billing-cancel', { key }); scenario.pauseBilling = false; providerReleases.splice(0).forEach(resolve => resolve());
    await eventually(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    expect(reservations.get(key)).toBe('released');
    const rows = await dump(name); expect(rows.cloud_executions).toMatchObject([{ state: 'interrupted', reservation: 'released' }]);
    expect(frameEvents(rows).filter(event => event.type === 'run.reservation' && event.data.key === key && event.data.reservation === 'held')).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('abandons an uncooperative billing hook at the execution deadline and releases its pending key', async () => {
    const name = await setup({ pauseAdmission: true }, { turnTimeoutMs: 100 }); await enqueue(name, { dedupKey: 'deadline', text: 'do not wait forever' });
    const rows = await waitState(name, 1, 'interrupted'); expect(rows.cloud_executions).toMatchObject([{ reservation: 'released' }]);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'failed', attempts: 0, errorCode: 'CLOUD_EXECUTION_TIMEOUT' }]); expect(calls).toHaveLength(0);
    expect(frameEvents(rows).filter(event => event.type === 'run.reservation' && event.data.action === 'release')).toHaveLength(1);
    await json(name, 'release');
    expect(reserveCalls).toHaveLength(1);
  });
});

describe('durable events, SSE resume, snapshots and byte-offset final output', () => {
  it('pages actual terminal runs, inbox and invocation refs without a snapshot watermark', async () => {
    const name = await setup(); scenario = { tools: [1] }; await enqueue(name, { dedupKey: 'historical', text: 'real terminal history' });
    const rows = await waitState(name);
    const runs = await json<Row[]>(name, 'runs'); const inbox = await json<Row[]>(name, 'inbox'); const invocations = await json<Row[]>(name, 'invocations');
    expect(runs).toMatchObject([{ conversationId: rows.cloud_executions![0]!.conversationId, state: 'completed' }]);
    expect(inbox).toMatchObject([{ seq: rows.cloud_inbox![0]!.seq, state: 'done', payloadJson: null }]);
    expect(invocations).toEqual([{ seq: rows.cloud_invocations![0]!.seq, invocationId: rows.cloud_invocations![0]!.invocationId, toolName: SKILL, state: 'succeeded', errorCode: null }]);
    for (const page of [runs, inbox, invocations]) expect(Object.hasOwn(page, 'highWater')).toBe(false);
    expect(await json(name, 'runs', { page: { after: runs[0]!.conversationId } })).toEqual([]);
    expect(await json(name, 'inbox', { page: { after: inbox[0]!.seq } })).toEqual([]);
    expect(await json(name, 'invocations', { page: { after: invocations[0]!.seq } })).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('sends one reset and closes when actual native backpressure leaves an unread trimmed replay page', async () => {
    const name = await setup(); const availableAt = Date.now() + DAY;
    for (let i = 0; i < 60; i++) {
      const item = await enqueue(name, { dedupKey: `paused:${i}`, text: 'real retained event', availableAt });
      await json(name, 'cancel-item', { seq: item.seq });
    }
    const initial = await dump(name); expect(initial.cloud_events).toHaveLength(120);
    const paused = await json<{ first: string; done: boolean }>(name, 'pause-events', { after: 0 });
    expect(paused.first).toContain('id: 1\n'); expect(paused.done).toBe(false);
    await sql(name, 'UPDATE cloud_events SET createdAt=?', [Date.now() - 8 * DAY]);
    await enqueue(name, { dedupKey: 'trim-unread-trigger', text: 'retain new head', availableAt });
    await eventually(async () => expect((await dump(name)).cloud_event_meta).toMatchObject([{ trimmedThrough: 120, highWater: 121 }]));
    const drained = await json<{ text: string }>(name, 'drain-events');
    const full = paused.first + drained.text;
    expect((full.match(/^event: reset$/gm) ?? [])).toHaveLength(1);
    expect(full).toContain('"trimmedThrough":120'); expect(full).toContain('"highWater":121');
    expect((full.match(/^id: /gm) ?? []).length).toBeLessThanOrEqual(100);
    expect(calls).toHaveLength(0);
  });

  it('keeps a retention alarm for a completed submit with no inbox', async () => {
    const name = await setup(); const response = await rpc(name, 'submit', { input: { instruction: 'one direct submit' } });
    expect(await response.text()).toContain('"type":"done"');
    const rows = await dump(name); expect(rows.cloud_inbox).toHaveLength(0); expect(rows.cloud_executions).toMatchObject([{ state: 'completed', trigger: 'submit' }]);
    expect(Number((await json(name, 'status')).alarm)).toBeGreaterThan(Date.now());
  });

  it('replays retained SQL events from a cursor and rejects expired or future cursors', async () => {
    const name = await setup(); await enqueue(name, { dedupKey: 'events', text: 'complete' }); const rows = await waitState(name);
    const expected = frameEvents(rows); const first = await readFrames(await events(name, { after: 0 }), expected.length);
    expect(first.map(event => event.id)).toEqual(expected.map(event => event.seq));
    const after = first[1]!.id;
    const replay = await readFrames(await events(name, { after }), first.length - 2);
    expect(replay.map(event => event.id)).toEqual(first.slice(2).map(event => event.id));
    await code(name, 'events', { cursor: { after: first.at(-1)!.id + 1 } }, 'CLOUD_EVENT_CURSOR_EXPIRED');
    await code(name, 'events', { cursor: { after: -1 } }, 'CLOUD_EVENT_CURSOR_EXPIRED');
    await code(name, 'events', { cursor: { after: 1.5 } }, 'CLOUD_EVENT_CURSOR_EXPIRED');
  });

  it('keeps a snapshot and its SQL watermark consistent with concurrent enqueues', async () => {
    const name = await setup(); const availableAt = Date.now() + DAY;
    await enqueue(name, { dedupKey: 'snapshot-base', text: 'base', availableAt });
    const [snapshot] = await Promise.all([
      json<{ inbox: Row[]; highWater: number }>(name, 'snapshot'),
      enqueue(name, { dedupKey: 'snapshot-race', text: 'race', availableAt }),
    ]);
    const rows = await dump(name); const covered = rows.cloud_events!.filter(row => Number(row.seq) <= snapshot.highWater && row.type === 'inbox.accepted');
    expect(snapshot.inbox.map(row => row.seq).sort()).toEqual(covered.map(row => Number(row.ref)).sort());
    const next = rows.cloud_events!.filter(row => Number(row.seq) > snapshot.highWater);
    if (next.length) expect((await readFrames(await events(name, { after: snapshot.highWater }), next.length)).map(event => event.id)).toEqual(next.map(row => row.seq));
  });

  it('starts omitted cursors from the current SQL watermark and tails only new events', async () => {
    const name = await setup(); await enqueue(name, { dedupKey: 'old', text: 'old event', availableAt: Date.now() + DAY });
    const before = await json<{ highWater: number }>(name, 'snapshot');
    const stream = await events(name, {});
    await enqueue(name, { dedupKey: 'new', text: 'new event', availableAt: Date.now() + DAY });
    const replay = await readFrames(stream, 1); expect(replay).toHaveLength(1); expect(replay[0]!.id).toBeGreaterThan(before.highWater);
    expect(replay[0]!.type).toBe('inbox.accepted');
  });

  it('caps streams at eight and disconnecting readers never cancels a wake', async () => {
    const name = await setup({ pauseTool: true }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'readers', text: 'read' }); await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    const readers: Awaited<ReturnType<typeof events>>[] = [];
    for (let i = 0; i < 8; i++) readers.push(await events(name, { after: 0 }));
    await code(name, 'events', { cursor: { after: 0 } }, 'CLOUD_EVENTS_BUSY');
    await Promise.all(readers.map(reader => reader.cancel()));
    expect((await dump(name)).cloud_executions).toMatchObject([{ state: 'running', aborted: 0 }]);
    await json(name, 'release'); await waitState(name); expect(calls).toHaveLength(2);
  });

  it('reconstructs a genuine multibyte final assistant entry larger than 64 KiB across safe offsets', async () => {
    const name = await setup(); const text = '会话🙂'.repeat(20_000); scenario = { tools: [1], final: text };
    await enqueue(name, { dedupKey: 'large-output', text: 'large final output' }); const rows = await waitState(name);
    const completed = frameEvents(rows).find(event => event.type === 'run.completed')!;
    expect(completed.data.truncated).toBe(true); expect(Buffer.byteLength(String(completed.data.text))).toBeLessThanOrEqual(1_024);
    const id = rows.cloud_executions![0]!.conversationId; let offset = 0; let entryId: number | undefined; let actual = '';
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await json<{ entryId: number; text: string; nextOffset: number; done: boolean }>(name, 'output', { id, page: { offset, entryId } });
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(65_536); expect(page.text).not.toContain('\ufffd');
      actual += page.text; entryId ??= page.entryId; expect(page.entryId).toBe(entryId); offset = page.nextOffset; if (page.done) break;
    }
    expect(actual).toBe(text); expect(calls).toHaveLength(2);
    const finalEntry = entries(rows).find(entry => entry.id === entryId)!;
    expect((finalEntry.model as Row[])[0]).toMatchObject({ stopReason: 'stop' });
  });

  it('keeps all 116 outstanding inbox rows and native invocation refs in one snapshot', async () => {
    // The wake must claim all 16 rows. Hold its alarm until all 16 are admitted, because under load the 16 enqueues can
    // outlast any due-time offset, and a wake that starts early claims fewer rows and leaves the rest queued.
    const name = await setup({ pauseTool: true, pauseAlarm: true }); scenario = { tools: [1] }; const availableAt = Date.now() + 500;
    for (let i = 0; i < 16; i++) await enqueue(name, { dedupKey: `claimed:${i}`, text: `claim ${i}`, availableAt });
    await json(name, 'release-alarm');
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    expect((await dump(name)).cloud_inbox!.filter(row => row.state === 'queued')).toHaveLength(0);
    for (let i = 0; i < 100; i++) await enqueue(name, { dedupKey: `outstanding:${i}`, text: `queue ${i}`, availableAt: Date.now() + DAY });
    const snapshot = await json<{ inbox: Row[]; runs: Row[]; invocations: Row[]; highWater: number }>(name, 'snapshot');
    expect(snapshot.inbox).toHaveLength(116); expect(snapshot.inbox.every(row => row.payloadJson === null)).toBe(true);
    expect(snapshot.runs.some(row => row.state === 'running')).toBe(true); expect(snapshot.invocations.some(row => row.state === 'running')).toBe(true);
    const rows = await dump(name); expect(snapshot.highWater).toBe(rows.cloud_event_meta![0]!.highWater);
    await json(name, 'release'); await waitState(name);
  });

  // Budget the 540 sequential fixture RPCs separately from the unchanged alarm wait.
  it('retains a 30-day schedule while trimming over 500 expired events by real maintenance alarms', async () => {
    const name = await setup(); const availableAt = Date.now() + 30 * DAY - 1_000;
    await enqueue(name, { dedupKey: 'old-schedule', source: 'schedule', text: 'do not lose this', availableAt });
    for (let i = 0; i < 100; i++) { await enqueue(name, { dedupKey: `settled:${i}`, text: 'past', availableAt: Date.now() + DAY }); await json(name, 'cancel-item', { seq: i + 2 }); }
    await sql(name, 'UPDATE cloud_events SET createdAt=?', [Date.now() - 8 * DAY]);
    // These rows are real event writes. More are admitted and cancelled to cross the bounded trim size.
    for (let i = 0; i < 170; i++) { await enqueue(name, { dedupKey: `trim:${i}`, text: 'past', availableAt: Date.now() + DAY }); await json(name, 'cancel-item', { seq: i + 102 }); }
    await sql(name, 'UPDATE cloud_events SET createdAt=?', [Date.now() - 8 * DAY]);
    await enqueue(name, { dedupKey: 'maintenance-trigger', text: 'future', availableAt: Date.now() + DAY });
    await eventually(async () => expect((await dump(name)).cloud_events!.length).toBeLessThan(10));
    const snapshot = await json<{ inbox: Row[]; highWater: number }>(name, 'snapshot');
    expect(snapshot.inbox.some(row => row.dedupKey === 'old-schedule' && row.state === 'queued')).toBe(true);
    const rows = await dump(name); expect(Number(rows.cloud_event_meta![0]!.trimmedThrough)).toBeGreaterThan(500);
    expect(snapshot.highWater).toBe(rows.cloud_event_meta![0]!.highWater);
    expect(Number((await json(name, 'status')).alarm)).toBeLessThanOrEqual(Number(rows.cloud_events![0]!.createdAt) + 7 * DAY);
    const head = Number(rows.cloud_events![0]!.seq);
    const retained = await readFrames(await events(name, { after: head - 1 }), rows.cloud_events!.length);
    expect(retained.map(event => event.id)).toEqual(rows.cloud_events!.map(row => row.seq));
  }, 30_000);
});

interface TranscriptPage { runs: (Row & { nativeRunId: number; claimedSeqs: number[]; turns: Row[] })[]; items: Row[]; next: { horizon: number; run: number | null; item: number | null } }
const transcript = (name: string, page: Row = {}) => json<TranscriptPage>(name, 'transcript', { page });
const receipts = (rows: Rows): (Row & { run: Row & { usage: Row; admittedSeqs: number[]; claimedSeqs: number[] } })[] => (rows.fixture_receipts ?? []).map(row => ({ ...row, run: JSON.parse(String(row.runJson)) as Row & { usage: Row; admittedSeqs: number[]; claimedSeqs: number[] } }));
const renewals = (rows: Rows) => (rows.fixture_renewals ?? []).map(row => JSON.parse(String(row.requestJson)) as Row);
async function waitAck(name: string, count = 1) {
  await eventually(async () => expect((await dump(name)).cloud_executions!.filter(row => row.settlementAck === 1)).toHaveLength(count));
  return dump(name);
}
async function direct(name: string, instruction = 'fixture direct input') {
  const response = await rpc(name, 'submit', { input: { instruction } });
  expect(response.status).toBe(200);
  return response.text();
}
async function oldMembershipStore(name: string) {
  await sql(name, 'DROP TABLE cloud_run_turns');
  await sql(name, 'ALTER TABLE cloud_executions DROP COLUMN membershipPending');
  await sql(name, 'UPDATE cloud_executions SET settlementAck=NULL');
}
async function allTranscript(name: string, limit = 2) {
  const runs: TranscriptPage['runs'] = []; const items: Row[] = [];
  let page = await transcript(name, { limit }); const horizon = page.next.horizon;
  for (let i = 0; i < 100; i++) {
    expect(page.next.horizon).toBe(horizon); runs.push(...page.runs); items.push(...page.items);
    if (page.next.run === null && page.next.item === null) return { runs, items, next: page.next };
    page = await transcript(name, { limit, after: page.next });
  }
  throw new Error('Transcript pass did not end');
}

describe('4e-2 real native renewal, dispatch intent and billing facts', () => {
  it('puts consumer G1 instructions in the actual provider system message for wake and submit', async () => {
    const instructionsText = 'The consumer controls this financial analysis policy.';
    const name = await setup({ audit: true, instructionsText });
    await enqueue(name, { dedupKey: 'g1', text: 'wake policy' }); await waitAck(name);
    await direct(name, 'submit policy'); await waitAck(name, 2);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.body.messages.find(message => message.role === 'system')?.content).toContain(instructionsText);
    expect(calls[0]!.body.messages.filter(message => message.role === 'user').map(message => message.content).join('')).not.toContain(instructionsText);
  });

  it('compensates a first model renewal denial without a step, dispatch mark, usage or tool', async () => {
    const name = await setup({ audit: true, renewDeny: 'model' });
    await enqueue(name, { dedupKey: 'renew-first', text: 'deny before paid work' });
    const rows = await waitAck(name);
    expect(calls).toHaveLength(0); expect(rows.fixture_dispatches).toHaveLength(0);
    expect(rows.cloud_executions).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_TOOL_NOT_AVAILABLE', steps: 0, sentRequests: 0, inputTokens: 0, outputTokens: 0, credits: 0 }]);
    expect(receipts(rows)).toMatchObject([{ compensated: 1, run: { usage: { steps: 0, sentRequests: 0, inputTokens: 0, outputTokens: 0, credits: 0 } } }]);
    expect(renewals(rows)).toMatchObject([{ kind: 'model', recovery: false }]);
    expect((await json(name, 'status')).alarm).toBeGreaterThan(Date.now());
  });

  it('keeps paid first-request usage when the second model renewal is denied', async () => {
    const name = await setup({ audit: true, renewDeny: 'model', renewDenyAt: 2 });
    scenario = { tools: [1], usageFrames: [[{ prompt_tokens: 123, completion_tokens: 17 }]] };
    await enqueue(name, { dedupKey: 'renew-second', text: 'one paid round' });
    const rows = await waitAck(name);
    expect(calls).toHaveLength(1); expect(rows.fixture_dispatches).toHaveLength(1);
    expect(rows.cloud_executions).toMatchObject([{ state: 'failed', steps: 1, sentRequests: 1, inputTokens: 123, outputTokens: 17 }]);
    expect(receipts(rows)).toMatchObject([{ run: { usage: { steps: 1, sentRequests: 1, inputTokens: 123, outputTokens: 17 } } }]);
    expect(renewals(rows).map(row => row.kind)).toEqual(['model', 'tool', 'model']);
  });

  it('denies a tool renewal before the consumer dispatcher', async () => {
    const name = await setup({ audit: true, renewDeny: 'tool' }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'tool-renew-denial', text: 'request a denied tool' });
    const rows = await waitAck(name);
    expect(rows.fixture_dispatches).toHaveLength(0);
    expect(rows.cloud_invocations).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_TOOL_NOT_AVAILABLE' }]);
    expect(renewals(rows)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', toolName: SKILL, recovery: false })]));
  });

  for (const stop of ['deadline', 'cancel'] as const) it(`releases an uncooperative model renewal at ${stop} without provider work`, async () => {
    const name = await setup({ audit: true, pauseRenew: 'model' }, { turnTimeoutMs: stop === 'deadline' ? 150 : 2_000 });
    await enqueue(name, { dedupKey: `renew-${stop}`, text: 'renew never cooperates' });
    await eventually(async () => expect((await dump(name)).fixture_renewals).toHaveLength(1));
    if (stop === 'cancel') await json(name, 'cancel-run');
    const rows = await waitAck(name);
    expect(calls).toHaveLength(0);
    expect(rows.cloud_executions).toMatchObject([{ steps: 0, sentRequests: 0 }]);
    expect(receipts(rows)).toMatchObject([{ compensated: 1 }]);
    await json(name, 'release'); await json(name, 'controls', { controls: { audit: true } });
    await direct(name); await waitAck(name, 2); expect(calls).toHaveLength(1);
  });

  it('times out tool renewal before taking the sole inline slot, so the next run can dispatch', async () => {
    const name = await setup({ audit: true, pauseRenew: 'tool' }, { inlineFetches: 1, callTimeoutMs: HELD_CALL_TIMEOUT_MS }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'tool-renew-timeout', text: 'time out before dispatch' });
    const first = await waitAck(name);
    expect(first.fixture_dispatches).toHaveLength(0);
    expect(first.cloud_invocations).toMatchObject([{ state: 'timed_out', errorCode: 'CLOUD_TOOL_TIMEOUT' }]);
    await json(name, 'release'); await json(name, 'controls', { controls: { audit: true } });
    scenario = { tools: Array<number>(calls.length).fill(0).concat(1) };
    await direct(name); const rows = await waitAck(name, 2);
    expect(rows.fixture_dispatches).toHaveLength(1);
    expect(rows.cloud_invocations!.at(-1)).toMatchObject({ state: 'succeeded', errorCode: null });
  });

  for (const denial of [false, true]) it(`renews actual persisted tool replay with recovery=true${denial ? ' and denies consumer replay' : ''}`, async () => {
    const name = await setup({ audit: true, pauseTool: true }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'recovery-renew', text: 'persist a running native tool' });
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    await restart('alarm');
    await json(name, 'controls', { controls: { audit: true, ...(denial ? { renewDeny: 'recovery' } : {}) } });
    await json(name, 'ready'); await json(name, 'release');
    const rows = await waitAck(name);
    expect(calls).toHaveLength(1);
    expect(renewals(rows)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', recovery: true, toolName: SKILL, nativeRunId: rows.cloud_executions![0]!.conversationId })]));
    expect(rows.fixture_dispatches).toHaveLength(denial ? 1 : 2);
    expect(rows.cloud_invocations).toMatchObject([{ replayCount: 1, state: denial ? 'failed' : 'succeeded', ...(denial ? { errorCode: 'CLOUD_TOOL_NOT_AVAILABLE' } : {}) }]);
  });

  for (const [label, frames, expected, rejected] of [
    ['decreasing', [{ prompt_tokens: 100 }, { prompt_tokens: 90 }], { inputTokens: 100, outputTokens: 0 }, true],
    ['equal', [{ prompt_tokens: 100 }, { prompt_tokens: 100 }], { inputTokens: 100, outputTokens: 0 }, false],
    ['increasing', [{ prompt_tokens: 100 }, { prompt_tokens: 120 }], { inputTokens: 120, outputTokens: 0 }, false],
    ['independent fields', [{ prompt_tokens: 100, completion_tokens: 5 }, { prompt_tokens: 100, completion_tokens: 9 }], { inputTokens: 100, outputTokens: 9 }, false],
  ] as const) it(`stores ${label} checked usage frames through the native provider boundary`, async () => {
    const name = await setup({ audit: true }); scenario = { usageFrames: [frames.map(frame => ({ ...frame }))] };
    await enqueue(name, { dedupKey: 'usage-frames', text: 'report provider tokens' }); const rows = await waitAck(name);
    expect(calls).toHaveLength(1);
    expect(rows.cloud_executions).toMatchObject([{ steps: 1, sentRequests: 1, ...expected, state: rejected ? 'failed' : 'completed', ...(rejected ? { errorCode: 'CLOUD_MODEL_RESPONSE_REJECTED' } : {}) }]);
    expect(receipts(rows)).toMatchObject([{ run: { usage: { steps: 1, sentRequests: 1, ...expected } } }]);
  });

  it('adds cumulative usage once per request across native model and tool rounds', async () => {
    const name = await setup({ audit: true, toolCredits: 7 });
    scenario = { tools: [1], usageFrames: [[{ prompt_tokens: 100, completion_tokens: 10 }, { prompt_tokens: 120, completion_tokens: 11 }], [{ prompt_tokens: 40, completion_tokens: 8 }]] };
    await enqueue(name, { dedupKey: 'usage-sum', text: 'two requests' }); const rows = await waitAck(name);
    expect(calls).toHaveLength(2); expect(rows.cloud_executions).toMatchObject([{ steps: 2, sentRequests: 2, inputTokens: 160, outputTokens: 19, credits: 7 }]);
    expect(receipts(rows)).toMatchObject([{ run: { usage: { steps: 2, sentRequests: 2, inputTokens: 160, outputTokens: 19, credits: 7 } } }]);
  });

  for (const failure of ['leakAfterUsage', 'interruptAfterUsage', 'invalidToolAfterUsage'] as const) it(`keeps ingested usage before ${failure}`, async () => {
    const name = await setup({ audit: true }); scenario = { usageFrames: [[{ prompt_tokens: 31, completion_tokens: 4 }]], [failure]: true };
    await enqueue(name, { dedupKey: 'usage-before-rejection', text: 'usage survives rejection' }); const rows = await waitAck(name);
    expect(rows.cloud_executions).toMatchObject([{ state: 'failed', inputTokens: 31, outputTokens: 4, sentRequests: 1 }]);
    expect(receipts(rows)).toMatchObject([{ run: { usage: { inputTokens: 31, outputTokens: 4 } } }]);
    expect(rows.fixture_dispatches).toHaveLength(0);
  });

  for (const [column, usage] of [['inputTokens', { prompt_tokens: 128_000 }], ['outputTokens', { completion_tokens: 32_768 }]] as const) it(`stops the next paid request at the ${column} cap`, async () => {
    const name = await setup({ audit: true }); scenario = { tools: [1], usageFrames: [[usage]] };
    await enqueue(name, { dedupKey: `cap-${column}`, text: 'stop after reported cap' }); const rows = await waitAck(name);
    expect(calls).toHaveLength(1); expect(rows.cloud_executions).toMatchObject([{ state: 'failed', fatalCode: 'CLOUD_BUDGET_EXCEEDED', steps: 1, sentRequests: 1, [column]: Object.values(usage)[0] }]);
    expect(receipts(rows)).toMatchObject([{ run: { usage: { [column]: Object.values(usage)[0] } } }]);
  });

  it('keeps the credit-crossing tool result and stops the next model gate', async () => {
    const name = await setup({ audit: true, toolCredits: 101 }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'credit-cap', text: 'one tool over the soft cap' }); const rows = await waitAck(name);
    expect(calls).toHaveLength(1); expect(rows.cloud_invocations).toMatchObject([{ state: 'succeeded' }]);
    expect(JSON.parse(String(rows.cloud_invocations![0]!.resultJson))).toMatchObject({ usage: { credits: 101 } });
    expect(rows.cloud_executions).toMatchObject([{ state: 'failed', fatalCode: 'CLOUD_BUDGET_EXCEEDED', credits: 101 }]);
    expect(receipts(rows)).toMatchObject([{ run: { usage: { credits: 101 } } }]);
  });

  for (const field of ['sentRequests', 'inputTokens'] as const) it(`fails a real SQL ${field} accounting write before success can be observed`, async () => {
    const name = await setup({ audit: true });
    await sql(name, `CREATE TRIGGER fixture_accounting_fail BEFORE UPDATE ON cloud_executions WHEN NEW.${field}>OLD.${field} BEGIN SELECT RAISE(ABORT,'accounting-write-failure'); END`);
    scenario = { usageFrames: [[{ prompt_tokens: 33, completion_tokens: 2 }]] };
    await enqueue(name, { dedupKey: 'accounting-write', text: 'trigger actual accounting write' }); const rows = await waitAck(name);
    expect(rows.cloud_executions).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_MODEL_REQUEST_FAILED', steps: 1, sentRequests: field === 'sentRequests' ? 0 : 1, inputTokens: 0, outputTokens: 0 }]);
    expect(calls).toHaveLength(field === 'sentRequests' ? 0 : 1);
    expect(frameEvents(rows).filter(event => event.type === 'run.completed')).toHaveLength(0);
    expect(receipts(rows)).toMatchObject([{ compensated: field === 'sentRequests' ? 1 : 0 }]);
  });

  for (const holdBody of ['before-usage', 'after-usage'] as const) it(`binds ${holdBody} held-stream accounting to run A across cancel and run B`, async () => {
    const name = await setup({ audit: true }); scenario = { holdBody, usageFrames: [[{ prompt_tokens: 41, completion_tokens: 3 }]] };
    await enqueue(name, { dedupKey: 'held-A', text: 'hold this native response' });
    await eventually(() => expect(calls).toHaveLength(1));
    if (holdBody === 'after-usage') await eventually(async () => expect((await dump(name)).cloud_executions).toMatchObject([{ inputTokens: 41 }]));
    const runA = (await dump(name)).cloud_executions![0]!.conversationId;
    await json(name, 'cancel-run'); await waitAck(name);
    scenario = { usageFrames: [[], [{ prompt_tokens: 12, completion_tokens: 2 }]] };
    await direct(name, 'new run B'); const before = await waitAck(name, 2);
    providerReleases.splice(0).forEach(resolve => resolve());
    await eventually(async () => expect((await dump(name)).cloud_executions!.find(row => row.conversationId === runA)).toEqual(before.cloud_executions!.find(row => row.conversationId === runA)));
    const rows = await dump(name); const a = rows.cloud_executions!.find(row => row.conversationId === runA)!;
    expect(a).toMatchObject({ sentRequests: 1, inputTokens: holdBody === 'after-usage' ? 41 : 0, outputTokens: holdBody === 'after-usage' ? 3 : 0 });
    expect(rows.cloud_executions!.find(row => row.conversationId !== runA)).toMatchObject({ inputTokens: 12, outputTokens: 2 });
    expect(receipts(rows).find(row => row.runId === runA)).toMatchObject({ run: { usage: { inputTokens: a.inputTokens, outputTokens: a.outputTokens } } });
  });
});

describe('4e-2 terminal-first settlement and stable admission', () => {
  it('delivers a terminal row and terminal event before acknowledging submit success', async () => {
    const name = await setup({ audit: true });
    expect(await direct(name)).toContain('"type":"done"'); const rows = await waitAck(name);
    expect(rows.fixture_settlements).toMatchObject([{ state: 'completed', ack: 0 }]);
    expect(Number(rows.fixture_settlements![0]!.terminalEvent)).toBeGreaterThan(0);
    expect(receipts(rows)).toMatchObject([{ run: { trigger: 'submit', requestId: expect.any(String), claimedSeqs: [], admittedSeqs: [], admissionDigest: null, usage: { sentRequests: 1 } } }]);
    const terminal = frameEvents(rows).find(event => event.type === 'run.completed')!;
    const ack = frameEvents(rows).find(event => event.type === 'run.settlement')!;
    expect(Number(ack.seq)).toBeGreaterThan(Number(terminal.seq)); expect(ack.data).toMatchObject({ ack: true });
    expect(rows.cloud_executions).toMatchObject([{ revision: ack.seq, settlementAck: 1 }]);
  });

  it('keeps submit SSE closure on hook failure and retries settlement by alarm without a model rerun', async () => {
    const name = await setup({ audit: true, failSettlement: true, pauseAlarm: true });
    expect(await direct(name)).toContain('"type":"done"');
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ state: 'completed', settlementAck: 0 }]);
    expect(before.fixture_receipts).toHaveLength(0); expect(calls).toHaveLength(1);
    await json(name, 'controls', { controls: { audit: true } }); await json(name, 'release-alarm');
    const rows = await waitAck(name);
    expect(rows.fixture_settlements!.length).toBeGreaterThanOrEqual(2); expect(rows.fixture_receipts).toHaveLength(1);
    expect(frameEvents(rows).filter(event => event.type === 'run.settlement')).toHaveLength(1); expect(calls).toHaveLength(1);
  });

  it('replays an idempotent consumer receipt after restart when delivery lost its ack', async () => {
    const name = await setup({ audit: true, receiptThenFail: true, pauseAlarm: true });
    await direct(name); const before = await dump(name);
    expect(before.fixture_receipts).toHaveLength(1); expect(before.cloud_executions).toMatchObject([{ settlementAck: 0 }]);
    await restart('alarm'); await json(name, 'ready'); await json(name, 'release-alarm'); const rows = await waitAck(name);
    expect(rows.fixture_receipts).toHaveLength(1); expect(rows.fixture_receipts).toEqual(before.fixture_receipts);
    expect(rows.fixture_settlements).toHaveLength(2); expect(calls).toHaveLength(1);
    expect(frameEvents(rows).filter(event => event.type === 'run.settlement')).toHaveLength(1);
    await restart('alarm'); await json(name, 'ready'); await json(name, 'release-alarm');
    expect((await dump(name)).fixture_settlements).toHaveLength(2); expect(calls).toHaveLength(1);
  });

  it('rolls back ack and event together when the actual settlement event insert fails', async () => {
    const name = await setup({ audit: true, pauseAlarm: true });
    await sql(name, "CREATE TRIGGER fixture_ack_fail BEFORE INSERT ON cloud_events WHEN NEW.type='run.settlement' BEGIN SELECT RAISE(ABORT,'ack-write-failure'); END");
    await direct(name); const before = await dump(name);
    expect(before.cloud_executions).toMatchObject([{ state: 'completed', settlementAck: 0 }]);
    expect(before.fixture_receipts).toHaveLength(1); expect(frameEvents(before).filter(event => event.type === 'run.settlement')).toHaveLength(0);
    await sql(name, 'DROP TRIGGER fixture_ack_fail'); await json(name, 'release-alarm'); const rows = await waitAck(name);
    expect(rows.fixture_receipts).toHaveLength(1); expect(frameEvents(rows).filter(event => event.type === 'run.settlement')).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('admits and acknowledges a new submit while an older settlement delivery is paused', async () => {
    const name = await setup({ audit: true, failSettlement: true, pauseAlarm: true }); await direct(name);
    const before = await dump(name); const olderId = Number(before.cloud_executions![0]!.conversationId);
    expect(before.cloud_executions).toMatchObject([{ state: 'completed', settlementAck: 0 }]);
    await json(name, 'controls', { controls: { audit: true, pauseSettlementRunId: olderId } });
    await json(name, 'release-alarm');
    await eventually(async () => expect((await dump(name)).fixture_settlements).toHaveLength(2));
    expect(await json(name, 'runtime')).toMatchObject({ busy: false, hasLiveOwner: false });
    const response = await rpc(name, 'submit', { input: { instruction: 'new run while older settlement is paused' } });
    expect(response.status).toBe(200); const submitted = response.text();
    const parallel = await waitAck(name);
    expect(parallel.cloud_executions).toMatchObject([{ conversationId: olderId, state: 'completed', settlementAck: 0 }, { state: 'completed', settlementAck: 1 }]);
    expect(parallel.fixture_receipts).toHaveLength(1); expect(parallel.fixture_receipts![0]!.runId).not.toBe(olderId);
    expect(calls).toHaveLength(2);
    await json(name, 'release-settlement'); expect(await submitted).toContain('"type":"done"'); const rows = await waitAck(name, 2);
    expect(rows.cloud_executions).toHaveLength(2); expect(rows.cloud_executions!.every(row => row.state === 'completed')).toBe(true);
    expect(frameEvents(rows).filter(event => event.type === 'run.settlement')).toHaveLength(2); expect(calls).toHaveLength(2);
  });

  it('rings the live event doorbell as soon as consumer settlement succeeds', async () => {
    const name = await setup({ audit: true, pauseSettlement: true });
    const submitted = direct(name);
    await eventually(async () => expect((await dump(name)).fixture_settlements).toHaveLength(1));
    const snapshot = await json<{ highWater: number }>(name, 'snapshot');
    const frame = readFrames(await events(name, { after: snapshot.highWater }), 1);
    await json(name, 'release-settlement');
    const frames = await Promise.race([frame, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Settlement doorbell did not ring')), 2_000))]);
    expect(frames).toMatchObject([{ type: 'run.settlement', data: { ack: true } }]);
    expect(await submitted).toContain('"type":"done"'); await waitAck(name);
  });

  it('releases an uncooperative settlement hook at the real call timeout and retries its receipt', async () => {
    const name = await setup({ audit: true, pauseSettlement: true, pauseAlarm: true });
    const submitted = direct(name);
    await eventually(async () => expect((await dump(name)).fixture_settlements).toHaveLength(1));
    expect(await submitted).toContain('"type":"done"');
    const timedOut = await dump(name); expect(timedOut.cloud_executions).toMatchObject([{ state: 'completed', settlementAck: 0 }]);
    await json(name, 'controls', { controls: { audit: true } }); await json(name, 'release-alarm'); const rows = await waitAck(name);
    expect(rows.fixture_receipts).toHaveLength(1); expect(calls).toHaveLength(1);
    await json(name, 'release');
    expect((await dump(name)).cloud_executions).toEqual(rows.cloud_executions);
  }, 65_000);

  it('keeps the admission digest and original selection when cancel and expiry shrink a real claim', async () => {
    const name = await setup({ audit: true, pauseAdmission: true }); const at = Date.now() + 200;
    const selected: Row[] = [];
    for (let i = 0; i < 3; i++) selected.push(await enqueue(name, { dedupKey: `shrink:${i}`, text: `selected text ${i}`, availableAt: at }));
    await eventually(async () => expect((await dump(name)).fixture_admission_details).toHaveLength(1));
    const original = await dump(name); const admission = JSON.parse(String(original.fixture_admission_details![0]!.detailJson)) as { digest: string; seqs: number[] };
    expect(admission.seqs).toEqual(selected.map(row => row.seq)); expect(admission.digest).toMatch(/^[a-f0-9]{64}$/);
    await json(name, 'cancel-item', { seq: selected[1]!.seq });
    await sql(name, 'UPDATE cloud_inbox SET expiresAt=? WHERE seq=?', [Date.now() - 1, Number(selected[2]!.seq)]);
    await json(name, 'release'); const rows = await waitAck(name);
    expect(rows.cloud_executions).toMatchObject([{ admissionDigest: admission.digest, admittedSeqs: JSON.stringify(admission.seqs) }]);
    expect(receipts(rows)).toMatchObject([{ run: { admissionDigest: admission.digest, admittedSeqs: admission.seqs, claimedSeqs: [selected[0]!.seq] } }]);
    expect(wakeInput(0).inbox.map(row => row.seq)).toEqual([selected[0]!.seq]);
  });

  for (const denied of [false, true]) it(`compensates ${denied ? 'admission denial' : 'an all-cancelled empty claim'} with its original digest and empty claimed seqs`, async () => {
    const name = await setup({ audit: true, pauseAdmission: true, deny: denied });
    const item = await enqueue(name, { dedupKey: 'empty-selection', text: 'selected but never dispatched' });
    await eventually(async () => expect((await dump(name)).fixture_admission_details).toHaveLength(1));
    const original = JSON.parse(String((await dump(name)).fixture_admission_details![0]!.detailJson)) as Row;
    if (!denied) await json(name, 'cancel-item', { seq: item.seq });
    await json(name, 'release'); const rows = await waitAck(name);
    expect(calls).toHaveLength(0); expect(rows.cloud_run_turns).toHaveLength(0);
    expect(receipts(rows)).toMatchObject([{ compensated: 1, run: { admissionDigest: original.digest, admittedSeqs: [item.seq], claimedSeqs: [], usage: { steps: 0, sentRequests: 0, inputTokens: 0, outputTokens: 0, credits: 0 } } }]);
  });
});

describe('4e-2 native text handoff, transcript paging and legacy history', () => {
  it('keeps queued and never-claimed terminal input text through refresh and event trimming', async () => {
    const name = await setup({ audit: true });
    const a = await enqueue(name, { dedupKey: 'queued-text', text: 'queued original text', availableAt: Date.now() + DAY });
    const b = await enqueue(name, { dedupKey: 'cancelled-text', text: 'never committed text', availableAt: Date.now() + DAY });
    await json(name, 'cancel-item', { seq: b.seq });
    let page = await transcript(name);
    expect(page.items).toEqual(expect.arrayContaining([expect.objectContaining({ seq: a.seq, text: 'queued original text', state: 'queued' }), expect.objectContaining({ seq: b.seq, text: 'never committed text', state: 'cancelled' })]));
    expect((await dump(name)).cloud_inbox!.find(row => row.seq === b.seq)).toMatchObject({ inputDurable: 0, payloadJson: JSON.stringify({ text: 'never committed text' }) });
    await sql(name, 'UPDATE cloud_events SET createdAt=?', [Date.now() - 8 * DAY]);
    await enqueue(name, { dedupKey: 'trim-transcript', text: 'retained new item', availableAt: Date.now() + DAY });
    await eventually(async () => expect(Number((await dump(name)).cloud_event_meta![0]!.trimmedThrough)).toBeGreaterThan(0));
    page = await transcript(name); expect(page.items.find(row => row.seq === b.seq)?.text).toBe('never committed text');
    expect(calls).toHaveLength(0);
  });

  it('keeps text when cancel stops a claimed wake before its real input commit', async () => {
    const name = await setup({ audit: true, pauseInput: true });
    const item = await enqueue(name, { dedupKey: 'pre-input-cancel', text: 'claim text before durable commit' });
    await eventually(async () => expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'running', inputDurable: 0 }]));
    const before = await dump(name); expect(entries(before).filter(entry => entry.kind === 'byok.run-input')).toHaveLength(0);
    await json(name, 'cancel-run');
    await restart('alarm'); await json(name, 'ready');
    expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'interrupted', inputDurable: 0 }]);
    expect((await transcript(name)).runs[0]!.turns).toMatchObject([{ seq: item.seq, text: 'claim text before durable commit' }]);
    await json(name, 'release'); await waitAck(name);
    expect(calls).toHaveLength(0);
    expect((await dump(name)).cloud_inbox).toMatchObject([{ payloadJson: JSON.stringify({ text: 'claim text before durable commit' }) }]);
  });

  it('retains fallback text and recovers after an actual native input-commit failure', async () => {
    const name = await setup({ audit: true });
    await sql(name, "CREATE TRIGGER fixture_input_commit_fail BEFORE INSERT ON pi_entries WHEN json_extract(NEW.record,'$.kind')='byok.run-input' BEGIN SELECT RAISE(ABORT,'native-input-write-failure'); END");
    const item = await enqueue(name, { dedupKey: 'input-failure', text: 'native commit failed text' });
    await eventually(async () => {
      expect((await dump(name)).cloud_executions).toMatchObject([{ state: 'running', steps: 0 }]);
      expect(await json(name, 'runtime')).toMatchObject({ hasLiveOwner: false });
    });
    const rows = await dump(name); expect(calls).toHaveLength(0);
    expect(entries(rows).filter(entry => entry.kind === 'byok.run-input')).toHaveLength(0);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'running', inputDurable: 0, payloadJson: JSON.stringify({ text: 'native commit failed text' }) }]);
    await code(name, 'context', { id: rows.cloud_executions![0]!.conversationId }, 'CLOUD_MODEL_REQUEST_FAILED');
    const rejected = await rpc(name, 'transcript'); expect(rejected.status).toBe(502);
    expect(await rejected.json()).toEqual({ error: { code: 'CLOUD_MODEL_REQUEST_FAILED', retryable: false } });
    await sql(name, 'DROP TRIGGER fixture_input_commit_fail'); await restart('alarm'); await json(name, 'ready');
    const page = await transcript(name);
    expect(page.runs[0]!.turns).toHaveLength(0); expect(page.runs[0]!.claimedSeqs).toEqual([item.seq]);
    expect(page.items).toMatchObject([{ seq: item.seq, text: 'native commit failed text', state: 'queued', runId: null }]);
    expect(calls).toHaveLength(0);
  });

  it('keeps the real committed input when the subsequent input-durable marker write fails', async () => {
    const name = await setup({ audit: true });
    await sql(name, "CREATE TRIGGER fixture_input_marker_fail BEFORE UPDATE ON cloud_inbox WHEN NEW.inputDurable>OLD.inputDurable BEGIN SELECT RAISE(ABORT,'input-marker-write-failure'); END");
    const item = await enqueue(name, { dedupKey: 'marker-failure', text: 'native text precedes marker' });
    await eventually(async () => {
      expect((await dump(name)).cloud_executions).toMatchObject([{ state: 'running', steps: 0 }]);
      expect(await json(name, 'runtime')).toMatchObject({ hasLiveOwner: false });
    });
    const rows = await dump(name); expect(calls).toHaveLength(0);
    expect(entries(rows).find(entry => entry.kind === 'byok.run-input')).toMatchObject({ data: { items: [{ seq: item.seq, text: 'native text precedes marker' }] } });
    expect(rows.cloud_inbox).toMatchObject([{ state: 'running', inputDurable: 0, payloadJson: JSON.stringify({ text: 'native text precedes marker' }) }]);
    expect((await transcript(name)).runs[0]!.turns).toMatchObject([{ seq: item.seq, text: 'native text precedes marker' }]);
    await sql(name, 'DROP TRIGGER fixture_input_marker_fail'); await restart('alarm'); await json(name, 'ready');
    const page = await transcript(name);
    expect(page.runs[0]!.turns).toHaveLength(0); expect(page.runs[0]!.claimedSeqs).toEqual([item.seq]);
    expect(page.items).toMatchObject([{ seq: item.seq, text: 'native text precedes marker', state: 'queued', runId: null }]);
    expect(calls).toHaveLength(0);
  });

  it('reads all batched native turns, invocation revisions and full output beyond 64 KiB', async () => {
    const name = await setup({ audit: true }); const answer = '会话🙂'.repeat(8_000); scenario = { tools: [1], final: answer };
    const availableAt = Date.now() + 200; const selected: Row[] = [];
    for (let i = 0; i < 3; i++) selected.push(await enqueue(name, { dedupKey: `transcript-batch:${i}`, text: `input ${i}`, availableAt }));
    const rows = await waitAck(name); const page = await transcript(name);
    expect(page.items).toHaveLength(0); expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({ nativeRunId: rows.cloud_executions![0]!.conversationId, claimedSeqs: selected.map(row => row.seq), truncated: true, settlementAck: true,
      turns: selected.map((row, i) => ({ seq: row.seq, text: `input ${i}`, state: 'done', runId: rows.cloud_executions![0]!.conversationId })),
      invocations: [{ toolName: SKILL, state: 'succeeded', revision: rows.cloud_invocations![0]!.settledEventSeq }] });
    expect(Buffer.byteLength(String(page.runs[0]!.text))).toBeLessThanOrEqual(1_024);
    let actual = ''; let offset = 0; let entryId: number | undefined;
    for (;;) {
      const output = await json<{ entryId: number; text: string; nextOffset: number; done: boolean }>(name, 'output', { id: page.runs[0]!.nativeRunId, page: { offset, entryId } });
      actual += output.text; offset = output.nextOffset; entryId = output.entryId; if (output.done) break;
    }
    expect(actual).toBe(answer); expect(calls).toHaveLength(2);
  });

  it('keeps an unscanned item in its horizon pass when a later real wake settles and clears its payload', async () => {
    const name = await setup({ audit: true });
    for (let i = 0; i < 3; i++) { await enqueue(name, { dedupKey: `page-run:${i}`, text: `completed ${i}` }); await waitAck(name, i + 1); }
    const future = Date.now() + DAY; const selected: Row[] = [];
    for (let i = 0; i < 5; i++) selected.push(await enqueue(name, { dedupKey: `page-item:${i}`, text: `later ${i}`, availableAt: future }));
    const cursor = await json<{ highWater: number }>(name, 'snapshot');
    const first = await transcript(name, { limit: 2 }); expect(first.items.map(row => row.seq)).toEqual([selected[4]!.seq, selected[3]!.seq]);
    scenario = { pause: true };
    await sql(name, 'UPDATE cloud_inbox SET availableAt=? WHERE seq=?', [Date.now() - 1, Number(selected[0]!.seq)]);
    const waking = rpc(name, 'alarm'); await eventually(() => expect(calls).toHaveLength(4));
    const current = (await dump(name)).cloud_executions!.at(-1)!.conversationId;
    expect((await dump(name)).cloud_inbox!.find(row => row.seq === selected[0]!.seq)).toMatchObject({ inputDurable: 1 });
    const runningItems: Row[] = []; let runningNext = first.next;
    while (runningNext.run !== null || runningNext.item !== null) {
      const page = await transcript(name, { limit: 2, after: runningNext }); runningItems.push(...page.items); runningNext = page.next;
    }
    expect(runningItems.find(row => row.seq === selected[0]!.seq)).toMatchObject({ text: 'later 0', runId: current, state: 'running' });
    scenario.pause = false; providerReleases.splice(0).forEach(resolve => resolve()); expect((await waking).status).toBe(200); await waitAck(name, 4);
    expect((await dump(name)).cloud_inbox!.find(row => row.seq === selected[0]!.seq)?.payloadJson).toBeNull();
    const runs = [...first.runs]; const items = [...first.items]; let next = first.next;
    while (next.run !== null || next.item !== null) { const page = await transcript(name, { limit: 2, after: next }); runs.push(...page.runs); items.push(...page.items); expect(page.next.horizon).toBe(first.next.horizon); next = page.next; }
    expect(runs.map(run => run.nativeRunId)).not.toContain(current);
    expect(items.filter(row => row.seq === selected[0]!.seq)).toEqual([expect.objectContaining({ text: 'later 0', runId: current, state: 'done' })]);
    expect(new Set([...runs.flatMap(run => run.turns.map(turn => turn.seq)), ...items.map(item => item.seq)]).size).toBe(8);
    expect(items).toHaveLength(5);
    const replay = frameEvents(await dump(name)).filter(event => Number(event.seq) > cursor.highWater);
    expect(replay).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.started', data: expect.objectContaining({ seqs: [selected[0]!.seq] }) })]));
  });

  it('pages unequal real list lengths beyond 50 rows and does not restart exhausted lists', async () => {
    const name = await setup({ audit: true }); await enqueue(name, { dedupKey: 'only-run', text: 'one completed run' }); await waitAck(name);
    for (let i = 0; i < 53; i++) await enqueue(name, { dedupKey: `many-items:${i}`, text: `item ${i}`, availableAt: Date.now() + DAY });
    const page = await allTranscript(name, 3); expect(page.runs).toHaveLength(1); expect(page.items).toHaveLength(53);
    expect(new Set(page.items.map(row => row.seq)).size).toBe(53);
    const exhausted = await transcript(name, { limit: 3, after: page.next }); expect(exhausted.runs).toEqual([]); expect(exhausted.items).toEqual([]); expect(exhausted.next).toEqual(page.next);
  });

  it('restores a purged legacy turn from true committed native input and repeats no migration writes', async () => {
    const name = await setup({ audit: true }); const item = await enqueue(name, { dedupKey: 'legacy-purged', text: 'original legacy durable text' }); const before = await waitAck(name);
    const runId = before.cloud_executions![0]!.conversationId;
    expect(entries(before).find(entry => entry.kind === 'byok.run-input')).toMatchObject({ data: { items: [{ seq: item.seq, text: 'original legacy durable text' }] } });
    await sql(name, 'DELETE FROM cloud_inbox WHERE seq=?', [Number(item.seq)]); await oldMembershipStore(name);
    await restart('alarm'); await json(name, 'ready'); let page = await transcript(name); const migrated = await dump(name);
    expect(page.items).toEqual([]); expect(page.runs[0]!.turns).toMatchObject([{ seq: item.seq, text: 'original legacy durable text', state: null, revision: null }]);
    expect(migrated.cloud_run_turns).toEqual([{ runId, seq: item.seq, claimEvent: null, releaseEvent: null }]);
    expect(migrated.cloud_executions).toMatchObject([{ membershipPending: 0, settlementAck: null }]);
    expect(migrated.fixture_settlements).toEqual(before.fixture_settlements);
    await restart('alarm'); await json(name, 'ready'); page = await transcript(name); const second = await dump(name);
    expect(second.cloud_run_turns).toEqual(migrated.cloud_run_turns); expect(second.cloud_events).toEqual(migrated.cloud_events);
    expect(page.runs[0]!.turns).toHaveLength(1); expect(calls).toHaveLength(1); await json(name, 'release-alarm');
  });

  for (const outcome of ['reclaim', 'queued', 'expiry-purge'] as const) it(`preserves the historical native input and correct legacy ownership after requeue -> ${outcome}`, async () => {
    const name = await setup({ audit: true, nativePause: 'request' }); const item = await enqueue(name, { dedupKey: 'legacy-requeue', text: 'requeued historical input' });
    await eventually(async () => expect(tasks(await dump(name)).some(task => ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true));
    const originalId = (await dump(name)).cloud_executions![0]!.conversationId;
    await restart('alarm'); await json(name, 'ready');
    expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'queued', runId: null, attempts: 1 }]);
    if (outcome === 'reclaim') { await json(name, 'release-alarm'); await waitAck(name, 2); await sql(name, 'DELETE FROM cloud_inbox WHERE seq=?', [Number(item.seq)]); }
    if (outcome === 'expiry-purge') {
      await sql(name, 'UPDATE cloud_inbox SET expiresAt=? WHERE seq=?', [Date.now() - 1, Number(item.seq)]);
      await json(name, 'release-alarm'); await json(name, 'alarm');
      expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'expired', runId: null }]);
      await sql(name, 'UPDATE cloud_inbox SET settledAt=? WHERE seq=?', [Date.now() - 8 * DAY, Number(item.seq)]);
      await json(name, 'alarm'); expect((await dump(name)).cloud_inbox).toHaveLength(0);
    }
    await oldMembershipStore(name); await restart('alarm'); await json(name, 'ready'); const page = await transcript(name); const rows = await dump(name);
    const allTurns = page.runs.flatMap(run => run.turns.map(turn => ({ ...turn, sourceRun: run.nativeRunId })));
    if (outcome === 'queued') { expect(allTurns).toHaveLength(0); expect(page.items).toMatchObject([{ seq: item.seq, runId: null, text: 'requeued historical input' }]); }
    else {
      expect(page.items).toHaveLength(0); expect(allTurns).toHaveLength(1);
      expect(allTurns[0]).toMatchObject({ seq: item.seq, text: 'requeued historical input', state: null, revision: null });
      if (outcome === 'reclaim') { expect(allTurns[0]!.sourceRun).not.toBe(originalId); expect(page.runs.find(run => run.nativeRunId === originalId)!.turns).toHaveLength(0); }
      else expect(allTurns[0]).toMatchObject({ sourceRun: originalId, runId: null, state: null, revision: null });
    }
    expect(rows.cloud_executions!.every(row => row.membershipPending === 0)).toBe(true);
    expect(calls).toHaveLength(outcome === 'reclaim' ? 1 : 0);
    // Keep the queued case paused. Its next real alarm must not mutate this legacy projection assertion.
    if (outcome !== 'queued') await json(name, 'release-alarm');
  });

  it('resumes a failed middle-run backfill without duplicate rows or invented clocks', async () => {
    const name = await setup({ audit: true });
    for (let i = 0; i < 3; i++) { await enqueue(name, { dedupKey: `legacy-resume:${i}`, text: `legacy source ${i}` }); await waitAck(name, i + 1); }
    const before = await dump(name); const ids = before.cloud_executions!.map(row => Number(row.conversationId));
    await sql(name, 'DELETE FROM cloud_inbox'); await oldMembershipStore(name);
    await sql(name, `CREATE TRIGGER fixture_backfill_fail BEFORE UPDATE ON cloud_executions WHEN NEW.membershipPending=0 AND OLD.membershipPending=1 AND NEW.conversationId=${ids[1]} BEGIN SELECT RAISE(ABORT,'middle-backfill-failure'); END`);
    await restart('alarm'); await code(name, 'ready', {}, 'CLOUD_MODEL_REQUEST_FAILED'); const failed = await dump(name);
    expect(failed.cloud_executions!.map(row => row.membershipPending)).toEqual([1, 1, 0]);
    expect(failed.cloud_run_turns).toHaveLength(1); expect(failed.cloud_run_turns![0]!.runId).toBe(ids[2]);
    await sql(name, 'DROP TRIGGER fixture_backfill_fail'); await restart('alarm'); await json(name, 'ready'); const recovered = await dump(name);
    expect(recovered.cloud_executions!.map(row => row.membershipPending)).toEqual([0, 0, 0]);
    expect([...recovered.cloud_run_turns!].sort((a, b) => Number(a.runId) - Number(b.runId))).toEqual(ids.map((runId, i) => ({ runId, seq: before.cloud_inbox![i]!.seq, claimEvent: null, releaseEvent: null })));
    expect((await transcript(name)).runs.map(run => run.turns[0]!.text)).toEqual(['legacy source 2', 'legacy source 1', 'legacy source 0']);
    await restart('alarm'); await json(name, 'ready'); expect((await dump(name)).cloud_run_turns).toEqual(recovered.cloud_run_turns); expect(calls).toHaveLength(3); await json(name, 'release-alarm');
  });
});

describe('4e-2 remaining native budget and legacy controls', () => {
  it('uses the full serialized provider request, including instructions and schema, for the input cap', async () => {
    const name = await setup({ audit: true, largeSchema: true, instructionsText: 'policy '.repeat(6_800) });
    await direct(name, 'input '.repeat(2_600)); const rows = await waitAck(name);
    expect(calls).toHaveLength(0); expect(rows.cloud_executions).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_BUDGET_EXCEEDED', steps: 0, sentRequests: 0 }]);
    expect(receipts(rows)).toMatchObject([{ compensated: 1 }]);
  });

  for (const missing of [false, true]) it(`clears a legacy pending flag when ${missing ? 'the native conversation is missing' : 'an empty claim has no committed input'}`, async () => {
    const name = await setup({ audit: true, ...(!missing ? { pauseAdmission: true } : {}) });
    const item = await enqueue(name, { dedupKey: 'legacy-no-source', text: 'no legacy source after control' });
    if (!missing) {
      await eventually(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
      await json(name, 'cancel-item', { seq: item.seq }); await json(name, 'release');
    }
    const before = await waitAck(name); const id = Number(before.cloud_executions![0]!.conversationId);
    if (missing) { await sql(name, 'DELETE FROM cloud_inbox'); await sql(name, 'DELETE FROM pi_conversations WHERE id=?', [id]); }
    else expect(entries(before).filter(entry => entry.kind === 'byok.run-input')).toHaveLength(0);
    await oldMembershipStore(name); await restart('alarm'); await json(name, 'ready'); const rows = await dump(name);
    expect(rows.cloud_run_turns).toHaveLength(0); expect(rows.cloud_executions).toMatchObject([{ membershipPending: 0, settlementAck: null }]);
    const page = await transcript(name); expect(page.runs[0]!.turns).toHaveLength(0);
    expect(rows.fixture_settlements).toEqual(before.fixture_settlements); await json(name, 'release-alarm');
  });

  it('delivers a restored active legacy run once with a null admission digest', async () => {
    const name = await setup({ audit: true, pauseTool: true }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'legacy-active', text: 'active old run' });
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    await oldMembershipStore(name); await sql(name, 'UPDATE cloud_executions SET admissionDigest=NULL,admittedSeqs=NULL');
    await restart('alarm'); await json(name, 'ready'); const recovered = await dump(name);
    expect(recovered.cloud_executions).toMatchObject([{ state: 'interrupted', settlementAck: 0, membershipPending: 0 }]);
    expect(recovered.fixture_settlements).toHaveLength(0);
    await json(name, 'release-alarm'); const rows = await waitAck(name);
    expect(receipts(rows)).toMatchObject([{ run: { admissionDigest: null, admittedSeqs: [] } }]);
    expect(rows.fixture_settlements).toHaveLength(1); expect(calls).toHaveLength(1);
    await restart('alarm'); await json(name, 'ready'); await json(name, 'release-alarm');
    expect((await dump(name)).fixture_settlements).toHaveLength(1);
  });
});

describe('4e-2 zero-dispatch credential compensation', () => {
  it('compensates a held selection when real credential preflight fails before the native gate', async () => {
    const name = await setup({ audit: true, pauseAdmission: true });
    await enqueue(name, { dedupKey: 'credential-compensation', text: 'hold then lose credential' });
    await eventually(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    await json(name, 'controls', { controls: { audit: true, pauseAdmission: true, failCredentials: true } });
    await json(name, 'release'); const rows = await waitAck(name);
    expect(calls).toHaveLength(0); expect(rows.fixture_renewals).toHaveLength(0);
    expect(rows.cloud_executions).toMatchObject([{ state: 'interrupted', errorCode: 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE', steps: 0, sentRequests: 0 }]);
    expect(receipts(rows)).toMatchObject([{ compensated: 1, run: { usage: { steps: 0, sentRequests: 0, inputTokens: 0, outputTokens: 0, credits: 0 } } }]);
    await json(name, 'controls', { controls: { audit: true } });
  });
});

describe('4e-2 native uncooperative dispatch slot', () => {
  it('keeps the sole inline slot until the ignored-abort dispatch returns, then admits another native tool', async () => {
    const name = await setup({ audit: true, pauseTool: true }, { inlineFetches: 1, callTimeoutMs: HELD_CALL_TIMEOUT_MS });
    scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'uncooperative-slot', text: 'hold consumer dispatch past its deadline' });
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    const first = await waitAck(name);
    expect(first.cloud_invocations).toMatchObject([{ state: 'timed_out', errorCode: 'CLOUD_TOOL_TIMEOUT' }]);
    expect(first.fixture_dispatches).toMatchObject([{ completed: 0 }]);
    scenario = { tools: Array<number>(calls.length).fill(0).concat(1) };
    await direct(name, 'request tool while the slot is held'); const blocked = await waitAck(name, 2);
    expect(blocked.fixture_dispatches).toHaveLength(1);
    expect(blocked.cloud_invocations!.at(-1)).toMatchObject({ state: 'failed', errorCode: 'CLOUD_TOOL_BUSY' });
    await json(name, 'release');
    await eventually(async () => expect((await dump(name)).fixture_dispatches).toMatchObject([{ completed: 1, aborted: 1 }]));
    scenario = { tools: Array<number>(calls.length).fill(0).concat(1) };
    await direct(name, 'request tool after the held dispatch returns'); const rows = await waitAck(name, 3);
    expect(rows.fixture_dispatches).toHaveLength(2); expect(rows.cloud_invocations!.at(-1)).toMatchObject({ state: 'succeeded', errorCode: null });
    expect(rows.cloud_invocations![0]).toEqual(first.cloud_invocations![0]);
  });
});

describe('4e-2 cancel before native input commit without restart', () => {
  it('releases the real paused commit after cancellation without appending input or discarding fallback text', async () => {
    const name = await setup({ audit: true, pauseInput: true });
    const item = await enqueue(name, { dedupKey: 'cancel-input-no-restart', text: 'retain this cancelled pre-commit input' });
    await eventually(async () => expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'running', inputDurable: 0 }]));
    expect(entries(await dump(name)).filter(entry => entry.kind === 'byok.run-input')).toHaveLength(0);
    await json(name, 'cancel-run'); await json(name, 'release'); const rows = await waitAck(name);
    expect(calls).toHaveLength(0); expect(entries(rows).filter(entry => entry.kind === 'byok.run-input')).toHaveLength(0);
    expect(rows.cloud_inbox).toMatchObject([{ seq: item.seq, state: 'interrupted', inputDurable: 0, payloadJson: JSON.stringify({ text: 'retain this cancelled pre-commit input' }) }]);
    expect(receipts(rows)).toMatchObject([{ compensated: 1, run: { usage: { steps: 0, sentRequests: 0, inputTokens: 0, outputTokens: 0, credits: 0 } } }]);
    expect((await transcript(name)).runs[0]!.turns).toMatchObject([{ seq: item.seq, text: 'retain this cancelled pre-commit input' }]);
  });
});

describe('4e-2 instruction validation and mixed compensation controls', () => {
  for (const [label, instructionsText] of [
    ['blank', '   '],
    ['invalid type', 7],
    ['oversized UTF-8', '界'.repeat(16_001)],
    ['configured credential', KEY],
  ] as const) it(`rejects ${label} system instructions before creating a native run`, async () => {
    const name = await setup({ audit: true, instructionsText });
    await enqueue(name, { dedupKey: 'invalid-instructions', text: 'keep the submitted input' });
    await eventually(async () => expect((await dump(name)).cloud_inbox).toMatchObject([
      { state: 'failed', attempts: 0, errorCode: 'CLOUD_REQUEST_INVALID', payloadJson: JSON.stringify({ text: 'keep the submitted input' }) },
    ]));
    const rows = await dump(name);
    expect(rows.cloud_executions).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(receipts(rows)).toHaveLength(0);
    noSecrets(rows, logs);
  });

  it('preserves earlier paid usage when the next gate passes but its dispatch-intent write fails', async () => {
    const name = await setup({ audit: true, toolCredits: 7 });
    await sql(name, "CREATE TRIGGER fixture_unsent_tail BEFORE UPDATE ON cloud_executions WHEN NEW.sentRequests=2 AND OLD.sentRequests=1 BEGIN SELECT RAISE(ABORT,'unsent-tail'); END");
    scenario = { tools: [1], usageFrames: [[{ prompt_tokens: 31, completion_tokens: 4 }]] };
    await enqueue(name, { dedupKey: 'mixed-paid-unsent', text: 'keep actual first-call usage' });
    const rows = await waitAck(name);
    expect(calls).toHaveLength(1);
    expect(rows.cloud_executions).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_MODEL_REQUEST_FAILED',
      steps: 2, sentRequests: 1, inputTokens: 31, outputTokens: 4, credits: 7 }]);
    expect(receipts(rows)).toMatchObject([{ compensated: 1, run: { usage: {
      steps: 2, sentRequests: 1, inputTokens: 31, outputTokens: 4, credits: 7,
    } } }]);
    expect(rows.cloud_invocations).toMatchObject([{ state: 'succeeded', resultJson: expect.any(String) }]);
  });

  it('reports a new transcript as unacked before the consumer settlement commits', async () => {
    const name = await setup({ audit: true, pauseSettlement: true });
    await enqueue(name, { dedupKey: 'new-ack-gate', text: 'wait for actual settlement' });
    await eventually(async () => expect((await dump(name)).fixture_settlements).toHaveLength(1));
    const before = await transcript(name);
    expect(before.runs).toMatchObject([{ state: 'completed', settlementAck: false }]);
    await json(name, 'release-settlement'); await waitAck(name);
    expect((await transcript(name)).runs).toMatchObject([{ state: 'completed', settlementAck: true }]);
  });
});


describe('4e-2 review fixes: independent consumer closes and legacy reads', () => {
  it('acknowledges a later submit while one older consumer close keeps failing', async () => {
    const name = await setup({ audit: true, failSettlement: true, pauseAlarm: true });
    await direct(name, 'older unpaid consumer close');
    const first = await dump(name); const olderId = Number(first.cloud_executions![0]!.conversationId);
    expect(first.cloud_executions).toMatchObject([{ state: 'completed', settlementAck: 0 }]);
    await json(name, 'controls', { controls: { audit: true, failSettlementRunId: olderId, pauseAlarm: true } });
    expect(await direct(name, 'independent later submit')).toContain('"type":"done"');
    const isolated = await waitAck(name);
    expect(isolated.cloud_executions).toMatchObject([{ conversationId: olderId, state: 'completed', settlementAck: 0 }, { state: 'completed', settlementAck: 1 }]);
    expect(isolated.fixture_receipts).toHaveLength(1); expect(isolated.fixture_receipts![0]!.runId).not.toBe(olderId);
    expect(calls).toHaveLength(2); expect(await json(name, 'runtime')).toMatchObject({ busy: false, hasLiveOwner: false });
    await json(name, 'controls', { controls: { audit: true } }); await json(name, 'release-alarm');
    const recovered = await waitAck(name, 2);
    expect(recovered.fixture_receipts).toHaveLength(2);
    expect(frameEvents(recovered).filter(event => event.type === 'run.settlement')).toHaveLength(2); expect(calls).toHaveLength(2);
  });

  it('retries a failed wake close through the real platform alarm without repeating paid usage', async () => {
    const name = await setup({ audit: true, failSettlementOnce: true });
    scenario = { usageFrames: [[{ prompt_tokens: 29, completion_tokens: 7 }]] };
    await enqueue(name, { dedupKey: 'consumer-wake-retry', text: 'one paid wake and one failed consumer close' });
    await eventually(async () => expect((await dump(name)).fixture_settlements).toHaveLength(1));
    const before = await dump(name); const id = Number(before.cloud_executions![0]!.conversationId);
    expect(before.cloud_executions).toMatchObject([{ trigger: 'wake', state: 'completed', settlementAck: 0, steps: 1, sentRequests: 1, inputTokens: 29, outputTokens: 7 }]);
    expect(before.fixture_receipts).toHaveLength(0); expect(calls).toHaveLength(1);
    expect(await json(name, 'runtime')).toMatchObject({ busy: false, hasLiveOwner: false });
    await vi.waitFor(async () => expect((await dump(name)).cloud_executions).toMatchObject([{ settlementAck: 1 }]), { timeout: 5_000 });
    const retried = await dump(name);
    expect(retried.fixture_alarms!.map(row => row.retryCount)).toEqual([0, 1]);
    expect(retried.fixture_settlements).toHaveLength(2); expect(retried.fixture_receipts).toHaveLength(1);
    expect(retried.cloud_executions).toMatchObject([{ conversationId: id, state: 'completed', steps: 1, sentRequests: 1, inputTokens: 29, outputTokens: 7, credits: 0 }]);
    expect(frameEvents(retried).filter(event => event.type === 'run.settlement')).toHaveLength(1); expect(calls).toHaveLength(1);
    await json(name, 'controls', { controls: { audit: true } });
    expect(await direct(name, 'later submit after the wake close retry')).toContain('"type":"done"');
    await waitAck(name, 2); expect(calls).toHaveLength(2);
  }, 8_000);

  it('runs a queued future wake during an older failed close and later repairs that close by a real retry', async () => {
    const name = await setup({ audit: true, failSettlement: true, pauseAlarm: true });
    scenario = { usageFrames: [[{ prompt_tokens: 11, completion_tokens: 2 }], [{ prompt_tokens: 23, completion_tokens: 5 }]] };
    await direct(name, 'older failed consumer close'); const older = await dump(name);
    const olderId = Number(older.cloud_executions![0]!.conversationId);
    await json(name, 'controls', { controls: { audit: true, failSettlementRunId: olderId, pauseAlarm: true } });
    const availableAt = Date.now() + 200;
    const item = await enqueue(name, { dedupKey: 'wake-during-close-failure', text: 'future wake is independent', availableAt });
    await json(name, 'release-alarm');
    await vi.waitFor(async () => expect((await dump(name)).cloud_executions!.find(row => row.trigger === 'wake')).toMatchObject({ state: 'completed', settlementAck: 1 }), { timeout: 5_000 });
    const activeRetry = await dump(name);
    expect(activeRetry.cloud_executions!.find(row => row.conversationId === olderId)).toMatchObject({ state: 'completed', settlementAck: 0, steps: 1, sentRequests: 1, inputTokens: 11, outputTokens: 2 });
    expect(activeRetry.cloud_inbox).toMatchObject([{ seq: item.seq, state: 'done', attempts: 1 }]);
    expect(activeRetry.fixture_alarms).toEqual(expect.arrayContaining([expect.objectContaining({ retryCount: 1 })]));
    expect(activeRetry.fixture_alarms!.every(row => Number(row.retryCount) < 6)).toBe(true);
    expect(activeRetry.fixture_admissions).toHaveLength(1); expect(reserveCalls).toHaveLength(1);
    expect(wakeInput(1).inbox).toMatchObject([{ seq: item.seq, text: 'future wake is independent' }]); expect(calls).toHaveLength(2);
    await json(name, 'controls', { controls: { audit: true } });
    await vi.waitFor(async () => expect((await dump(name)).cloud_executions!.every(row => row.settlementAck === 1)).toBe(true), { timeout: 8_000 });
    const recovered = await dump(name);
    expect(recovered.fixture_receipts).toHaveLength(2); expect(calls).toHaveLength(2);
    expect(frameEvents(recovered).filter(event => event.type === 'run.settlement')).toHaveLength(2);
    expect(recovered.cloud_executions!.find(row => row.trigger === 'wake')).toMatchObject({ steps: 1, sentRequests: 1, inputTokens: 23, outputTokens: 5 });
  }, 15_000);

  it('skips one unreadable native legacy input, serves healthy work, then retries that input at the next boot', async () => {
    const name = await setup({ audit: true });
    for (let i = 0; i < 3; i++) { await enqueue(name, { dedupKey: `legacy-read-isolation:${i}`, text: `readable legacy text ${i}` }); await waitAck(name, i + 1); }
    const original = await dump(name); const ids = original.cloud_executions!.map(row => Number(row.conversationId));
    const input = (await sql(name, "SELECT id,record FROM pi_entries WHERE conversation_id=? AND json_extract(record,'$.kind')='byok.run-input'", [ids[1]!]))[0]!;
    await sql(name, 'DELETE FROM cloud_inbox'); await oldMembershipStore(name);
    // JSON remains valid for SQLite. The native model contribution must be an array; this real row is unreadable.
    await sql(name, "UPDATE pi_entries SET record=json_set(record,'$.model',json('{}')) WHERE id=?", [Number(input.id)]);
    await restart('alarm'); await json(name, 'ready');
    const skipped = await dump(name);
    expect(skipped.cloud_executions!.map(row => row.membershipPending)).toEqual([0, 1, 0]);
    expect(skipped.cloud_run_turns).toHaveLength(2);
    expect(skipped.cloud_run_turns!.map(row => row.runId).sort((a, b) => Number(a) - Number(b))).toEqual([ids[0], ids[2]]);
    await code(name, 'context', { id: ids[1] }, 'CLOUD_MODEL_REQUEST_FAILED');
    const page = await transcript(name);
    expect(page.runs.find(run => run.nativeRunId === ids[1])!.turns).toHaveLength(0);
    expect(page.runs.flatMap(run => run.turns.map(turn => turn.text)).sort()).toEqual(['readable legacy text 0', 'readable legacy text 2']);
    await enqueue(name, { dedupKey: 'healthy-after-bad-legacy', text: 'new work after unreadable legacy input' });
    await json(name, 'release-alarm'); await waitAck(name);
    expect(calls).toHaveLength(4); expect(wakeInput(3).history).toHaveLength(2);
    expect((await dump(name)).cloud_executions!.find(row => row.conversationId === ids[1])).toMatchObject({ membershipPending: 1 });
    await sql(name, 'UPDATE pi_entries SET record=? WHERE id=?', [String(input.record), Number(input.id)]);
    await restart('alarm'); await json(name, 'ready'); const recovered = await dump(name);
    expect(recovered.cloud_executions!.filter(row => ids.includes(Number(row.conversationId))).every(row => row.membershipPending === 0)).toBe(true);
    expect(recovered.cloud_run_turns!.filter(row => ids.includes(Number(row.runId)))).toHaveLength(3);
    expect(recovered.cloud_run_turns!.find(row => row.runId === ids[1])).toEqual({ runId: ids[1], seq: original.cloud_inbox![1]!.seq, claimEvent: null, releaseEvent: null });
    expect((await transcript(name)).runs.find(run => run.nativeRunId === ids[1])!.turns).toMatchObject([{ text: 'readable legacy text 1' }]);
    expect(calls).toHaveLength(4); await json(name, 'release-alarm');
  });
});

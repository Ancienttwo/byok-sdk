import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
type Row = Record<string, unknown>;
type Rows = Record<string, Row[]>;
interface ProviderCall { url: string; body: { messages: { role: string; content: string }[]; tools?: unknown[] } }
interface Scenario { tools?: number[]; repeat?: boolean; final?: string; pause?: boolean; pauseBilling?: boolean; status?: number }
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
    if (scenario.pause) await new Promise<void>(resolve => providerReleases.push(resolve));
    if (scenario.status) { response.writeHead(scenario.status); response.end('fixture-provider-unavailable'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const count = scenario.tools?.[index] ?? (scenario.repeat ? 1 : 0);
    if (count) response.end(sse({ tool_calls: Array.from({ length: count }, (_, i) => ({ index: i, id: `source_${i}`, type: 'function', function: { name: SKILL, arguments: '{}' } })) }, 'tool_calls') + 'data: [DONE]\n\n');
    else {
      const answer = scenario.final ?? `Reply ${index + 1}: ${body.messages.filter(message => message.role === 'tool').length} document results.`;
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
async function waitState(name: string, count = 1, state = 'completed') { await vi.waitFor(async () => expect((await dump(name)).cloud_executions?.filter(row => row.state === state)).toHaveLength(count)); return dump(name); }
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
async function readFrames(response: Awaited<ReturnType<typeof rpc>>, count: number) {
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '';
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
    await vi.waitFor(async () => expect((await dump(name)).cloud_inbox!.find(row => row.dedupKey === 'default-times')!.state).toBe('done'));
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
    const t1 = Date.now() + 300, t2 = t1 + 600;
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
    await vi.waitFor(async () => expect((await dump(name)).cloud_inbox!.every(row => row.state === 'done')).toBe(true));
    for (let i = 0; i < calls.length; i++) expect(Buffer.byteLength(JSON.stringify(wakeInput(i)))).toBeLessThanOrEqual(48_000);
    expect(Buffer.byteLength(JSON.stringify(calls[0]!.body.tools))).toBeGreaterThan(48_000);
  });

  it('rejects one unfit 16000-character control item with no paid call and keeps other work queued', async () => {
    const name = await setup(); const availableAt = Date.now() + 100;
    await enqueue(name, { dedupKey: 'unfit', text: '\u0001'.repeat(16_000), availableAt });
    await enqueue(name, { dedupKey: 'later', text: 'safe later', availableAt: availableAt + DAY });
    await vi.waitFor(async () => expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_INBOX_TOO_LARGE' }, { state: 'queued' }]));
    expect(calls).toHaveLength(0);
  });

  it('rejects an inbox array of exactly 48000 bytes because the complete wrapper exceeds the budget', async () => {
    const name = await setup(); let text = '会'.repeat(15_980);
    const size = () => Buffer.byteLength(JSON.stringify([{ seq: 1, source: 'message', text }]));
    text += 'x'.repeat(48_000 - size()); expect(size()).toBe(48_000); expect(text.length).toBeLessThanOrEqual(16_000);
    await enqueue(name, { dedupKey: 'exact-array-budget', text });
    await vi.waitFor(async () => expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_INBOX_TOO_LARGE' }]));
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
    await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
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
    await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    await enqueue(name, { dedupKey: 'while-submit', text: 'later', availableAt: Date.now() + 100 });
    await json(name, 'controls', { controls: { pauseTool: true, deny: true, failCredentials: true } });
    await vi.waitFor(async () => expect((await dump(name)).fixture_alarms!.length).toBeGreaterThan(0));
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
    await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    const running = (await dump(name)).cloud_inbox!.find(row => row.state === 'running')!;
    await json(name, 'cancel-item', { seq: running.seq });
    await vi.waitFor(async () => expect((await dump(name)).cloud_inbox!.find(row => row.seq === running.seq)!.state).toBe('failed'));
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
    await vi.waitFor(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    await json(name, 'cancel-item', { seq: cancelled.seq }); await json(name, 'release');
    const rows = await waitState(name, 1, 'interrupted');
    expect(rows.cloud_inbox).toMatchObject([{ state: 'failed', attempts: 0, errorCode: 'CLOUD_TOOL_NOT_AVAILABLE' }, { state: 'cancelled', attempts: 0 }]);
    expect(calls).toHaveLength(0); expect(reserveCalls).toHaveLength(1); expect(reservations.size).toBe(0);
  });

  it('releases a real held reservation once when credential preflight fails and preserves cancelled rows', async () => {
    const name = await setup({ pauseAdmission: true }); const availableAt = Date.now() + 200;
    await enqueue(name, { dedupKey: 'credential-failure', text: 'selected', availableAt });
    const cancelled = await enqueue(name, { dedupKey: 'cancel-before-preflight', text: 'cancel selected', availableAt });
    await vi.waitFor(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
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
    await vi.waitFor(async () => {
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
    await vi.waitFor(async () => expect(tasks(await dump(name)).some(task => ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true));
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
    await vi.waitFor(async () => expect(tasks(await dump(name)).some(task => ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true));
    await json(name, 'cancel-run');
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ steps: 0, aborted: 1, fatalCode: 'CLOUD_EXECUTION_ABORTED' }]);
    await restart(); await json(name, 'ready');
    expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'interrupted', attempts: 1, errorCode: 'CLOUD_EXECUTION_ABORTED' }]); expect(calls).toHaveLength(0);
  });

  it('preserves the original zero-step eligibility through a second restart after native abort before adjudication', async () => {
    const name = await setup({ nativePause: 'request' }); await enqueue(name, { dedupKey: 'double-restart', text: 'save eligibility once' });
    await vi.waitFor(async () => expect(tasks(await dump(name)).some(task => ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true));
    expect(calls).toHaveLength(0); await restart('recovery');
    await json(name, 'controls', { controls: { nativePause: 'recovery' } });
    expect((await json(name, 'open-recovery')).recovering).toBe(true);
    await vi.waitFor(async () => expect(tasks(await dump(name)).every(task => (task.state as Row).status === 'terminal')).toBe(true));
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
      await vi.waitFor(async () => {
        const rows = await dump(name); expect(rows.cloud_inbox).toMatchObject([{ state: 'running', attempts: attempt }]);
        const run = rows.cloud_executions!.find(row => row.state === 'running')!; expect(run.steps).toBe(0);
        expect(tasks(rows).some(task => task.conversationId === run.conversationId && ((task.state as Row).checkpoint as Row)?.phase === 'request')).toBe(true);
      });
      expect(calls).toHaveLength(0); await restart('request'); await json(name, 'ready');
    }
    await vi.waitFor(async () => expect((await dump(name)).cloud_inbox).toMatchObject([{ state: 'failed', attempts: 4, errorCode: 'CLOUD_WAKE_EXHAUSTED' }]));
    expect(calls).toHaveLength(0);
    const rows = await dump(name); expect(rows.cloud_executions).toHaveLength(4);
    expect(rows.cloud_executions!.every(row => row.state === 'interrupted' && row.steps === 0)).toBe(true);
  });

  for (const trigger of ['wake', 'submit'] as const) it(`looks up a real done ${trigger} admission before its host submissionId receipt after restart`, async () => {
    const name = await setup({ nativePause: 'receipt' }); let stream: Promise<string> | undefined;
    if (trigger === 'wake') await enqueue(name, { dedupKey: 'receipt-gap', text: 'complete native before host receipt' });
    else stream = (await rpc(name, 'submit', { input: { instruction: 'complete native before host receipt' } })).text().catch(() => 'restart disconnected');
    await vi.waitFor(async () => {
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
    await vi.waitFor(async () => expect((await dump(name)).pi_submissions!.map(row => JSON.parse(String(row.record)))).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'unanswered', detail: 'CLOUD_MODEL_REQUEST_FAILED' })])));
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ state: 'running', submissionId: null }]);
    await restart(); await reading; await json(name, 'ready');
    expect((await dump(name)).cloud_executions).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_MODEL_REQUEST_FAILED' }]); expect(calls).toHaveLength(1);
  });

  for (const nativeStatus of ['done', 'unanswered'] as const) it('finalizes a committed ' + nativeStatus + ' submission with actual completing native work on boot', async () => {
    const name = await setup({ holdNativeOutcome: true });
    if (nativeStatus === 'unanswered') scenario = { status: 503 };
    await enqueue(name, { dedupKey: 'completing-' + nativeStatus, text: 'hold native cleanup after committed result' });
    await vi.waitFor(async () => {
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
    await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
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
    await vi.waitFor(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ state: 'starting', reservation: 'pending', steps: 0 }]);
    expect(before.cloud_inbox).toMatchObject([{ state: 'queued', attempts: 0 }]); expect(before.pi_submissions).toHaveLength(0);
    const key = String(before.fixture_admissions![0]!.admissionKey); expect(reservations.get(key)).toBe('held'); expect(calls).toHaveLength(0);
    await restart(); await json(name, 'ready');
    await vi.waitFor(async () => expect(frameEvents(await dump(name)).filter(event => event.type === 'run.reservation' && event.data.action === 'release' && event.data.key === key)).toHaveLength(1));
    await json(name, 'billing-cancel', { key });
    await waitState(name); expect(reservations.get(key)).toBe('released'); expect(reserveCalls.filter(value => value === key)).toHaveLength(1);
  });

  it('pins a paid native task before restart and never sends the old request again', async () => {
    const name = await setup(); scenario = { pause: true };
    await enqueue(name, { dedupKey: 'paid', text: 'paid interrupted' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(async () => {
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
    await vi.waitFor(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
    const before = await dump(name); expect(before.cloud_executions).toMatchObject([{ state: 'starting', reservation: 'pending' }]);
    await json(name, 'cancel-item', { seq: before.cloud_inbox![0]!.seq }); await json(name, 'release');
    const rows = await waitState(name, 1, 'interrupted'); expect(rows.cloud_executions).toMatchObject([{ errorCode: 'CLOUD_WAKE_EMPTY' }]);
    expect(rows.cloud_inbox).toMatchObject([{ state: 'cancelled', attempts: 0 }]); expect(calls).toHaveLength(0);
    expect(frameEvents(rows).filter(event => event.type === 'run.reservation' && event.data.action === 'release')).toHaveLength(1);
  });

  it('fences a consumer reserve that arrives after cancellation and ignores its late SDK receipt', async () => {
    const name = await setup(); scenario = { pauseBilling: true };
    await enqueue(name, { dedupKey: 'cancel-before-reserve', text: 'cancel reservation' });
    await vi.waitFor(() => expect(reserveCalls).toHaveLength(1));
    const key = reserveCalls[0]!; expect(reservations.has(key)).toBe(false);
    expect((await dump(name)).cloud_executions).toMatchObject([{ state: 'starting', reservation: 'pending' }]);
    await json(name, 'cancel-run');
    await vi.waitFor(async () => expect(frameEvents(await dump(name)).filter(event => event.type === 'run.reservation' && event.data.key === key && event.data.action === 'release')).toHaveLength(1));
    // The separate consumer applies the release event before its delayed reserve commits.
    await json(name, 'billing-cancel', { key }); scenario.pauseBilling = false; providerReleases.splice(0).forEach(resolve => resolve());
    await vi.waitFor(async () => expect((await dump(name)).fixture_admissions).toHaveLength(1));
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
    await vi.waitFor(async () => expect((await dump(name)).cloud_event_meta).toMatchObject([{ trimmedThrough: 120, highWater: 121 }]));
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
    const expected = frameEvents(rows); const first = await readFrames(await rpc(name, 'events', { cursor: { after: 0 } }), expected.length);
    expect(first.map(event => event.id)).toEqual(expected.map(event => event.seq));
    const after = first[1]!.id;
    const replay = await readFrames(await rpc(name, 'events', { cursor: { after } }), first.length - 2);
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
    if (next.length) expect((await readFrames(await rpc(name, 'events', { cursor: { after: snapshot.highWater } }), next.length)).map(event => event.id)).toEqual(next.map(row => row.seq));
  });

  it('starts omitted cursors from the current SQL watermark and tails only new events', async () => {
    const name = await setup(); await enqueue(name, { dedupKey: 'old', text: 'old event', availableAt: Date.now() + DAY });
    const before = await json<{ highWater: number }>(name, 'snapshot');
    const stream = await rpc(name, 'events', { cursor: {} });
    await enqueue(name, { dedupKey: 'new', text: 'new event', availableAt: Date.now() + DAY });
    const replay = await readFrames(stream, 1); expect(replay).toHaveLength(1); expect(replay[0]!.id).toBeGreaterThan(before.highWater);
    expect(replay[0]!.type).toBe('inbox.accepted');
  });

  it('caps streams at eight and disconnecting readers never cancels a wake', async () => {
    const name = await setup({ pauseTool: true }); scenario = { tools: [1] };
    await enqueue(name, { dedupKey: 'readers', text: 'read' }); await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    const responses: Awaited<ReturnType<typeof rpc>>[] = [];
    for (let i = 0; i < 8; i++) responses.push(await rpc(name, 'events', { cursor: { after: 0 } }));
    await code(name, 'events', { cursor: { after: 0 } }, 'CLOUD_EVENTS_BUSY');
    await Promise.all(responses.map(response => response.body!.cancel()));
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
    const name = await setup({ pauseTool: true }); scenario = { tools: [1] }; const availableAt = Date.now() + 500;
    for (let i = 0; i < 16; i++) await enqueue(name, { dedupKey: `claimed:${i}`, text: `claim ${i}`, availableAt });
    await vi.waitFor(async () => expect((await dump(name)).fixture_dispatches).toHaveLength(1));
    for (let i = 0; i < 100; i++) await enqueue(name, { dedupKey: `outstanding:${i}`, text: `queue ${i}`, availableAt: Date.now() + DAY });
    const snapshot = await json<{ inbox: Row[]; runs: Row[]; invocations: Row[]; highWater: number }>(name, 'snapshot');
    expect(snapshot.inbox).toHaveLength(116); expect(snapshot.inbox.every(row => row.payloadJson === null)).toBe(true);
    expect(snapshot.runs.some(row => row.state === 'running')).toBe(true); expect(snapshot.invocations.some(row => row.state === 'running')).toBe(true);
    const rows = await dump(name); expect(snapshot.highWater).toBe(rows.cloud_event_meta![0]!.highWater);
    await json(name, 'release'); await waitState(name);
  });

  it('retains a 30-day schedule while trimming over 500 expired events by real maintenance alarms', async () => {
    const name = await setup(); const availableAt = Date.now() + 30 * DAY - 1_000;
    await enqueue(name, { dedupKey: 'old-schedule', source: 'schedule', text: 'do not lose this', availableAt });
    for (let i = 0; i < 100; i++) { await enqueue(name, { dedupKey: `settled:${i}`, text: 'past', availableAt: Date.now() + DAY }); await json(name, 'cancel-item', { seq: i + 2 }); }
    await sql(name, 'UPDATE cloud_events SET createdAt=?', [Date.now() - 8 * DAY]);
    // These rows are real event writes. More are admitted and cancelled to cross the bounded trim size.
    for (let i = 0; i < 170; i++) { await enqueue(name, { dedupKey: `trim:${i}`, text: 'past', availableAt: Date.now() + DAY }); await json(name, 'cancel-item', { seq: i + 102 }); }
    await sql(name, 'UPDATE cloud_events SET createdAt=?', [Date.now() - 8 * DAY]);
    await enqueue(name, { dedupKey: 'maintenance-trigger', text: 'future', availableAt: Date.now() + DAY });
    await vi.waitFor(async () => expect((await dump(name)).cloud_events!.length).toBeLessThan(10));
    const snapshot = await json<{ inbox: Row[]; highWater: number }>(name, 'snapshot');
    expect(snapshot.inbox.some(row => row.dedupKey === 'old-schedule' && row.state === 'queued')).toBe(true);
    const rows = await dump(name); expect(Number(rows.cloud_event_meta![0]!.trimmedThrough)).toBeGreaterThan(500);
    expect(snapshot.highWater).toBe(rows.cloud_event_meta![0]!.highWater);
    expect(Number((await json(name, 'status')).alarm)).toBeLessThanOrEqual(Number(rows.cloud_events![0]!.createdAt) + 7 * DAY);
    const head = Number(rows.cloud_events![0]!.seq);
    const retained = await readFrames(await rpc(name, 'events', { cursor: { after: head - 1 } }), rows.cloud_events!.length);
    expect(retained.map(event => event.id)).toEqual(rows.cloud_events!.map(row => row.seq));
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

// Node's unchanged default policy permits the real platform exponential retry delay.
// No manual alarm calls, test clock, scheduler patch, or host retry substitute exists here.
test('a real workerd alarm exhausts six retries without enqueue/cancel replacing the generation', async () => {
  const instructions = await readFile(new URL('./fixtures/financial-analysis.md', import.meta.url), 'utf8');
  const built = await build({ entryPoints: [path.join(import.meta.dirname, 'wake-inbox-worker.ts')], bundle: true,
    format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false,
    define: { __FINANCIAL_ANALYSIS_SKILL__: JSON.stringify(instructions) } });
  const persist = await mkdtemp(path.join(os.tmpdir(), 'byok-alarm-retry-'));
  let providerCalls = 0;
  const mf = new Miniflare({ resourcePersistencePath: persist, log: new Log(LogLevel.NONE), workers: [{ config: {
    name: 'alarm-proof', type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: built.outputFiles[0].text } } },
    exports: { WakeAuditDO: { type: 'durable-object', storage: 'sqlite' } },
    env: { AGENTS: { type: 'durable-object', workerName: 'alarm-proof', exportName: 'WakeAuditDO' },
      AIPHABEE_ZAI_API_KEY: { type: 'text', value: 'Primary~0123456789ABCDEFGHIJKLMNOP' },
      AIPHABEE_DEEPSEEK_API_KEY: { type: 'text', value: 'Secondary~0123456789QRSTUVWXYZabcd' } },
  }, dev: { outboundService: { type: 'node-handler', handler: async (request, response) => {
    for await (const _chunk of request) { /* Drain the external request body. */ }
    const url = String(request.headers['mf-original-url'] ?? new URL(request.url ?? '/', `https://${request.headers.host}`).href);
    if (url.startsWith('https://billing.fixture/')) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"allowed":true}'); return;
    }
    providerCalls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"one paid reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } } } }] });
  const name = 'real-alarm-retry';
  const rpc = async (operation, extra = {}) => {
    const response = await mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, ...extra }) });
    const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
  };
  const until = async (predicate, maxMs) => {
    const started = Date.now(); let lastCount = -1;
    while (Date.now() - started < maxMs) {
      const rows = await rpc('dump');
      if (rows.fixture_alarms.length !== lastCount) {
        lastCount = rows.fixture_alarms.length;
        console.log(`real alarm callback count=${lastCount} retryCounts=${JSON.stringify(rows.fixture_alarms.map(row => row.retryCount))} providerCalls=${providerCalls}`);
      }
      if (predicate(rows)) return rows;
      await delay(250);
    }
    assert.fail(`Real alarm condition did not occur in ${maxMs}ms: ${JSON.stringify(await rpc('dump'))}`);
  };
  try {
    await mf.ready;
    await rpc('setup', { config: {
      identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: name },
      principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' }, scopes: ['read:fixture'], dispatcherId: 'wake-documents',
    } });
    await rpc('sql', { query: "CREATE TRIGGER fixture_retry_failure BEFORE INSERT ON cloud_events WHEN NEW.type IN ('run.completed','run.interrupted') BEGIN SELECT RAISE(ABORT,'real-alarm-storage-failure'); END" });
    await rpc('enqueue', { item: { dedupKey: 'paid-once', source: 'message', text: 'one paid run' } });
    const first = await until(rows => rows.fixture_alarms.length === 1 && rows.pi_submissions.some(row => JSON.parse(row.record).status === 'done'), 5_000);
    assert.equal(providerCalls, 1);
    assert.equal(first.cloud_executions[0].state, 'running');
    assert.equal(first.cloud_inbox[0].state, 'running');
    const held = await rpc('enqueue', { item: { dedupKey: 'during-retries', source: 'message', text: 'wait for repair' } });
    await rpc('cancel-item', { seq: held.seq ?? held.row.seq });
    const exhausted = await until(rows => rows.fixture_alarms.some(row => row.retryCount === 6), 180_000);
    assert.deepEqual(exhausted.fixture_alarms.map(row => row.retryCount), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(providerCalls, 1);
    assert.equal(exhausted.cloud_executions[0].state, 'running');
    await delay(2_100);
    assert.equal((await rpc('dump')).fixture_alarms.length, 7);
    await rpc('sql', { query: 'DROP TRIGGER fixture_retry_failure' });
    // A later authorized enqueue is the real trigger after platform retry exhaustion.
    await rpc('enqueue', { item: { dedupKey: 'after-exhaustion', source: 'message', text: 'future maintenance trigger', availableAt: Date.now() + 86_400_000 } });
    const repaired = await until(rows => rows.cloud_executions[0].state === 'completed', 5_000);
    assert.equal(repaired.cloud_inbox[0].state, 'done');
    assert.equal(providerCalls, 1);
    assert.equal(repaired.cloud_events.filter(row => row.type === 'run.completed').length, 1);
    assert.equal(repaired.cloud_inbox.find(row => row.dedupKey === 'during-retries').state, 'cancelled');
    assert.ok((await rpc('status')).alarm > Date.now());
  } finally { await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
});

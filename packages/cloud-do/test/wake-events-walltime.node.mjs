import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

// Use Node's unchanged default policy. The production timer and native stream run for 110 real seconds.
test('a real workerd durable event stream closes at its 110 second connection cap', async () => {
  const instructions = await readFile(new URL('./fixtures/financial-analysis.md', import.meta.url), 'utf8');
  const built = await build({ entryPoints: [path.join(import.meta.dirname, 'wake-inbox-worker.ts')], bundle: true,
    format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false,
    define: { __FINANCIAL_ANALYSIS_SKILL__: JSON.stringify(instructions) } });
  const persist = await mkdtemp(path.join(os.tmpdir(), 'byok-events-walltime-'));
  let externalCalls = 0;
  const mf = new Miniflare({ resourcePersistencePath: persist, log: new Log(LogLevel.NONE), workers: [{ config: {
    name: 'events-walltime', type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: built.outputFiles[0].text } } },
    exports: { WakeAuditDO: { type: 'durable-object', storage: 'sqlite' } },
    env: { AGENTS: { type: 'durable-object', workerName: 'events-walltime', exportName: 'WakeAuditDO' },
      AIPHABEE_ZAI_API_KEY: { type: 'text', value: 'Primary~0123456789ABCDEFGHIJKLMNOP' },
      AIPHABEE_DEEPSEEK_API_KEY: { type: 'text', value: 'Secondary~0123456789QRSTUVWXYZabcd' } },
  }, dev: { outboundService: { type: 'node-handler', handler: (_request, response) => {
    externalCalls++; response.writeHead(503); response.end('No external call is expected for an empty event stream.');
  } } } }] });
  const name = 'native-110-second-stream';
  const rpc = async (operation, extra = {}, signal) => mf.dispatchFetch('http://test/', {
    method: 'POST', body: JSON.stringify({ name, operation, ...extra }), signal,
  });
  let deadline;
  const controller = new AbortController();
  try {
    await mf.ready;
    const setup = await rpc('setup', { config: {
      identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: name },
      principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' },
      scopes: ['read:fixture'], dispatcherId: 'wake-documents',
    } });
    assert.equal(setup.status, 200, await setup.text());
    const started = Date.now();
    // This client failure deadline bounds a broken stream. It does not change the production or test timers.
    deadline = setTimeout(() => controller.abort(), 120_000);
    const response = await rpc('events', { cursor: {} }, controller.signal);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    let bytes = 0; let closure = 'eof'; let lastProgress = started;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (Date.now() - lastProgress >= 15_000) {
          lastProgress = Date.now(); console.log(`real event stream elapsedMs=${lastProgress - started} nativeKeepaliveBytes=${bytes}`);
        }
      }
    } catch (error) {
      // writer.abort at the connection cap can terminate the transferred native byte stream.
      assert.ok(error instanceof TypeError && error.message === 'terminated', String(error));
      closure = 'native transport terminated';
    }
    const elapsed = Date.now() - started;
    clearTimeout(deadline);
    console.log(`real event stream closure=${closure} elapsedMs=${elapsed} externalCalls=${externalCalls}`);
    assert.equal(controller.signal.aborted, false, 'The client deadline must not close the stream.');
    assert.ok(elapsed >= 110_000, `The native stream closed early: ${elapsed}ms.`);
    assert.ok(elapsed < 115_000, `The production 110-second cap did not close promptly: ${elapsed}ms.`);
    assert.ok(bytes > 0, 'The real native stream must send keepalives.');
    assert.equal(externalCalls, 0);
    const status = await rpc('status'); assert.equal(status.status, 200);
    assert.equal((await status.json()).alarm, null, 'An idle event stream must not create a DO alarm.');
  } finally { clearTimeout(deadline); await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
});

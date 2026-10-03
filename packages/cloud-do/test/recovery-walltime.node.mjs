import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// This real wall-time proof uses Node's default test policy. Existing Vitest timeouts stay unchanged.
test('a real workerd replay exceeds 30 seconds outside the initialization gate', async () => {
  const instructions = await readFile(new URL('./fixtures/financial-analysis.md', import.meta.url), 'utf8');
  const built = await build({ entryPoints: [path.join(import.meta.dirname, 'session-runtime-worker.ts')], bundle: true,
    format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false,
    define: { __FINANCIAL_ANALYSIS_SKILL__: JSON.stringify(instructions) } });
  const persist = await mkdtemp(path.join(os.tmpdir(), 'byok-recovery-walltime-'));
  let providerCalls = 0;
  const makeRuntime = () => new Miniflare({ resourcePersistencePath: persist, workers: [{ config: {
    name: 'walltime-proof', type: 'worker', compatibilityDate: '2026-08-18',
    compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: built.outputFiles[0].text } } },
    exports: { SessionAuditDO: { type: 'durable-object', storage: 'sqlite' } },
    env: { AGENTS: { type: 'durable-object', workerName: 'walltime-proof', exportName: 'SessionAuditDO' },
      AIPHABEE_ZAI_API_KEY: { type: 'text', value: 'Primary~0123456789ABCDEFGHIJKLMNOP' },
      AIPHABEE_DEEPSEEK_API_KEY: { type: 'text', value: 'Secondary~0123456789QRSTUVWXYZabcd' } },
  }, dev: { outboundService: { type: 'node-handler', handler: (_request, response) => {
    providerCalls++;
    response.writeHead(503); response.end();
  } } } }] });
  let mf = makeRuntime();
  const name = 'real-walltime-replay';
  const rpc = async (operation, extra = {}) => {
    const response = await mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, ...extra }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  };
  try {
    await mf.ready;
    await rpc('setup', { config: {
      identity: { tenantId: 'fixture-tenant', workspaceId: 'fixture-workspace', agentId: 'fixture-agent', sessionId: 'fixture-session' },
      principal: { accountId: 'fixture-account', workspaceId: 'fixture-workspace', channel: 'api' },
      scopes: ['read:fixture'], dispatcherId: 'fixture-documents',
    } });
    await rpc('seed', { seed: { phase: 'execute', ledger: true } });
    await mf.dispose(); mf = makeRuntime(); await mf.ready;
    await rpc('controls', { controls: { pause: true } });
    const opened = await rpc('open-recovery');
    assert.ok(opened.elapsed < 30_000, JSON.stringify(opened));
    assert.equal(opened.recovering, true);
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await rpc('dump');
      if (rows.fixture_dispatches.length === 1) break;
      await delay(10);
    }
    assert.equal((await rpc('dump')).fixture_dispatches.length, 1);
    const started = Date.now();
    let readySettled = false;
    const ready = rpc('ready').then(value => { readySettled = true; return value; });
    await delay(31_100);
    assert.ok(Date.now() - started >= 31_000);
    assert.equal(readySettled, false);
    const held = await rpc('dump');
    assert.equal(held.fixture_dispatches.length, 1);
    assert.equal(held.cloud_invocations[0].state, 'running');
    assert.equal(held.cloud_invocations[0].replayCount, 1);
    assert.equal(providerCalls, 0);
    await rpc('release');
    assert.equal((await ready).recovering, false);
    const completed = await rpc('dump');
    assert.equal(completed.cloud_invocations[0].state, 'succeeded');
    assert.equal(completed.cloud_invocations[0].replayCount, 1);
    assert.equal(completed.fixture_dispatches.length, 1);
    assert.equal(JSON.parse(completed.cloud_invocations[0].resultJson).data.instructions, instructions);
    assert.equal(providerCalls, 0);
  } finally {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});

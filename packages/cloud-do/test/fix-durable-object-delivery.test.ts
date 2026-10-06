import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

let mf: Miniflare;
let persist: string;
let serial = 0;
const sse = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
interface Status { liveOwner: boolean; busy: boolean; closedResponses: number; settled?: boolean; aborted?: boolean;
  runs: { state: string; errorCode: string | null }[]; invocations: { state: string }[] }

beforeAll(async () => {
  const bundled = await build({ entryPoints: [path.resolve(import.meta.dirname, 'fix-durable-object-delivery-worker.ts')],
    bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  persist = await mkdtemp(path.join(os.tmpdir(), 'byok-submit-delivery-'));
  mf = new Miniflare({ resourcePersistencePath: persist, log: new Log(LogLevel.ERROR), workers: [{ config: {
    name: 'submit-delivery', type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundled.outputFiles[0]!.text } } },
    exports: { DeliveryAuditDO: { type: 'durable-object', storage: 'sqlite' } },
    env: { AGENTS: { type: 'durable-object', workerName: 'submit-delivery', exportName: 'DeliveryAuditDO' },
      AIPHABEE_ZAI_API_KEY: { type: 'text', value: 'Fixture~0123456789ABCDEFGHIJKLMNOP' } },
  }, dev: { outboundService: { type: 'node-handler', handler: async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    const input = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
    const pause = input.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('pause'));
    const text = input.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('complete text'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(pause
      ? sse({ content: 'Safe fixture output. '.repeat(512) }) + sse({ tool_calls: [{ index: 0, id: 'fixture-pause', type: 'function', function: { name: 'load_financial_analysis_skill', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n'
      : sse({ content: text ? 'Safe completed output. '.repeat(512) : '' }, 'stop') + 'data: [DONE]\n\n');
  } } } }] });
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); if (persist) await rm(persist, { recursive: true, force: true }); });
async function rpc(name: string, operation: string, extra: Record<string, unknown> = {}) {
  return mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, ...extra }) });
}
async function json<T = unknown>(name: string, operation: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response = await rpc(name, operation, extra); const text = await response.text();
  expect(response.status, text).toBe(200); return JSON.parse(text) as T;
}
async function setup(timeout: number) {
  const name = `delivery-${++serial}`; await json(name, 'setup', { timeout }); return name;
}
async function status(name: string) { return json<Status>(name, 'status'); }
async function nextSubmit(name: string) {
  const response = await rpc(name, 'submit', { instruction: 'finish with an empty response' });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(text).toContain('"type":"done"');
}

describe('F06-1 submit delivery ownership in real workerd', () => {
  it('releases an unread text response on the execution deadline without resuming the reader', async () => {
    const name = await setup(300);
    try {
      expect(await json(name, 'hold', { instruction: 'pause after safe text' })).toEqual({ status: 200 });
      await vi.waitFor(async () => {
        const current = await status(name);
        expect(current.liveOwner).toBe(false);
        expect(current.runs).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_EXECUTION_TIMEOUT' }]);
      }, { timeout: 2500 });
      await nextSubmit(name);
      await vi.waitFor(async () => expect((await status(name)).closedResponses).toBe(1), { timeout: 1000 });
    } finally { await json(name, 'discard'); }
  });

  it('releases an unread text response on explicit cancellation without resuming the reader', async () => {
    const name = await setup(5000);
    try {
      await json(name, 'hold', { instruction: 'pause after safe text' });
      await vi.waitFor(async () => expect((await status(name)).invocations).toHaveLength(1));
      expect(await status(name)).toMatchObject({ liveOwner: true, runs: [{ state: 'running' }] });
      await json(name, 'cancel');
      await vi.waitFor(async () => {
        const current = await status(name);
        expect(current.liveOwner).toBe(false);
        expect(current.runs).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_EXECUTION_ABORTED' }]);
      }, { timeout: 1500 });
      await nextSubmit(name);
      await vi.waitFor(async () => expect((await status(name)).closedResponses).toBe(1), { timeout: 1000 });
    } finally { await json(name, 'discard'); }
  });

  it('releases a successfully settled run while its terminal response remains unread', async () => {
    const name = await setup(500);
    try {
      await json(name, 'hold', { instruction: 'finish with an empty response' });
      await vi.waitFor(async () => {
        const current = await status(name);
        expect(current.runs).toMatchObject([{ state: 'completed' }]);
        expect(current.liveOwner).toBe(false);
      }, { timeout: 1500 });
      // Reuse the same session before the stalled reader has consumed a byte.
      await nextSubmit(name);
      await vi.waitFor(async () => expect((await status(name)).closedResponses).toBe(1), { timeout: 1500 });
      expect((await status(name)).runs.map(run => run.state)).toEqual(['completed', 'completed']);
    } finally { await json(name, 'discard'); }
  });

  it('settles and releases a catch-path failure before its unread error response', async () => {
    const name = await setup(5000);
    try {
      await json(name, 'hold', { instruction: 'fail submission' });
      await vi.waitFor(async () => {
        const current = await status(name);
        expect(current.liveOwner).toBe(false);
        expect(current.runs).toMatchObject([{ state: 'failed', errorCode: 'CLOUD_MODEL_REQUEST_FAILED' }]);
      });
      await nextSubmit(name);
      await vi.waitFor(async () => expect((await status(name)).closedResponses).toBe(1), { timeout: 1000 });
    } finally { await json(name, 'discard'); }
  });

  it('preserves successful settlement when the final text response is backpressured', async () => {
    const name = await setup(500);
    try {
      await json(name, 'hold', { instruction: 'complete text' });
      await vi.waitFor(async () => {
        const current = await status(name);
        expect(current.runs).toMatchObject([{ state: 'completed' }]);
        expect(current.liveOwner).toBe(false);
      });
      await nextSubmit(name);
      await vi.waitFor(async () => expect((await status(name)).closedResponses).toBe(1), { timeout: 1500 });
      expect((await status(name)).runs.map(run => run.state)).toEqual(['completed', 'completed']);
    } finally { await json(name, 'discard'); }
  });

  it('hands a failed durable settlement to repair without letting response expiry change its native outcome', async () => {
    const name = await setup(500);
    try {
      await json(name, 'hold', { instruction: 'fail settlement' });
      await vi.waitFor(async () => expect(await status(name)).toMatchObject({
        liveOwner: false, busy: true, runs: [{ state: 'running' }],
      }));
      const blocked = await rpc(name, 'submit', { instruction: 'must wait for repair' });
      expect(await blocked.json()).toMatchObject({ error: { code: 'CLOUD_TOOL_BUSY' } });
      await vi.waitFor(async () => expect((await status(name)).closedResponses).toBe(1), { timeout: 1500 });
      await json(name, 'repair');
      expect(await status(name)).toMatchObject({ liveOwner: false, busy: false, runs: [{ state: 'completed' }] });
      await nextSubmit(name);
    } finally { await json(name, 'discard'); }
  });

});

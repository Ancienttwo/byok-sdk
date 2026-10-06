import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

let mf: Miniflare;
let persist: string;
let answer = '';
let serial = 0;
interface Page { entryId: number; offset: number; nextOffset: number; done: boolean; text: string }

beforeAll(async () => {
  const bundled = await build({ entryPoints: [path.resolve(import.meta.dirname, 'fix-durable-object-delivery-output-worker.ts')],
    bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  persist = await mkdtemp(path.join(os.tmpdir(), 'byok-output-paging-'));
  mf = new Miniflare({ resourcePersistencePath: persist, log: new Log(LogLevel.ERROR), workers: [{ config: {
    name: 'output-paging', type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundled.outputFiles[0]!.text } } },
    exports: { OutputAuditDO: { type: 'durable-object', storage: 'sqlite' } },
    env: { AGENTS: { type: 'durable-object', workerName: 'output-paging', exportName: 'OutputAuditDO' },
      AIPHABEE_ZAI_API_KEY: { type: 'text', value: 'Fixture~0123456789ABCDEFGHIJKLMNOP' } },
  }, dev: { outboundService: { type: 'node-handler', handler: async (request, response) => {
    for await (const _chunk of request) { /* Drain only this local fixture request. */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let offset = 0; offset < answer.length; offset += 8192) {
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer.slice(offset, offset + 8192) }, finish_reason: null }] })}\n\n`);
    }
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } } } }] });
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); if (persist) await rm(persist, { recursive: true, force: true }); });
async function rpc(name: string, operation: string, extra: Record<string, unknown> = {}) {
  return mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, ...extra }) });
}
async function json<T>(name: string, operation: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response = await rpc(name, operation, extra); const text = await response.text();
  expect(response.status, text).toBe(200); return JSON.parse(text) as T;
}
async function submit(text: string) {
  answer = text;
  const name = `output-${++serial}`;
  await json(name, 'setup');
  const response = await rpc(name, 'submit');
  const body = await response.text(); expect(response.status, body).toBe(200);
  const events = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: 'done' });
  return { name, id: events.at(-1).conversationId as number };
}
async function output(name: string, id: number, page: { offset?: number; entryId?: number } = {}) {
  return json<Page>(name, 'output', { id, page });
}

describe('F06-2 exact UTF-8 output paging in real workerd', () => {
  it('preserves a leading U+FEFF in a persisted assistant entry', async () => {
    const text = '\uFEFFtext'; const { name, id } = await submit(text);
    const page = await output(name, id);
    expect(page).toMatchObject({ offset: 0, nextOffset: Buffer.byteLength(text), done: true, text });
  });

  it('preserves U+FEFF at the automatic 65,536-byte page boundary', async () => {
    const prefix = 'Safe fixture output. '.repeat(4000).slice(0, 65_536);
    const text = prefix + '\uFEFFtext'; const { name, id } = await submit(text);
    const first = await output(name, id);
    expect(first).toMatchObject({ offset: 0, nextOffset: 65_536, done: false, text: prefix });
    const second = await output(name, id, { entryId: first.entryId, offset: first.nextOffset });
    expect(second).toMatchObject({ entryId: first.entryId, offset: 65_536, nextOffset: Buffer.byteLength(text), done: true, text: '\uFEFFtext' });
    expect(first.text + second.text).toBe(text);
  });

  it('preserves U+FEFF at an explicitly requested nonzero byte offset', async () => {
    const prefix = '会话🙂'; const suffix = '\uFEFFtail'; const { name, id } = await submit(prefix + suffix);
    const page = await output(name, id, { offset: Buffer.byteLength(prefix) });
    expect(page).toMatchObject({ offset: 10, nextOffset: 17, done: true, text: suffix });
  });

  it('still reconstructs CJK and emoji without splitting UTF-8 code points', async () => {
    const text = '会话🙂'.repeat(14_000); const { name, id } = await submit(text);
    let offset = 0; let actual = ''; let entryId: number | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await output(name, id, { offset, entryId });
      entryId ??= page.entryId;
      expect(page.entryId).toBe(entryId);
      expect(Buffer.byteLength(page.text)).toBe(page.nextOffset - page.offset);
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(65_536);
      expect(page.text).not.toContain('\ufffd');
      actual += page.text; offset = page.nextOffset;
      if (page.done) break;
    }
    expect(actual).toBe(text); expect(offset).toBe(Buffer.byteLength(text));
  });

  it('still rejects continuation-byte, invalid range and stale-entry offsets', async () => {
    const text = '🙂\uFEFFtail'; const { name, id } = await submit(text);
    const page = await output(name, id);
    for (const invalid of [{ offset: 1 }, { offset: 5 }, { offset: -1 }, { offset: 0.5 },
      { offset: Buffer.byteLength(text) + 1 }, { entryId: page.entryId + 1 }]) {
      const response = await rpc(name, 'output', { id, page: invalid });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'CLOUD_REQUEST_INVALID' } });
    }
    expect(await output(name, id, { offset: Buffer.byteLength(text) })).toMatchObject({ done: true, text: '', nextOffset: Buffer.byteLength(text) });
  });
});

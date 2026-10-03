import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { build } from 'esbuild';
import { Log, LogLevel, Miniflare, type MiniflareOptions } from 'miniflare';

const KEY = 'sk-proj-~~~Platform~0123456789+Tail/Z9';
const SECONDARY = 'sk-proj-~~~Secondary~0123456789+Tail/Z8';
const OPAQUE_PRIMARY = 'Primary~A1234567890BCdefghijklM';
const OPAQUE_SECONDARY = 'Secondary~Z9876543210YXwvutsrqP';
const USER_KEY = 'sk-proj-UserSecret0123456789abcdef';
const SAFE = 'The completed paragraph has no credentials. ';
const LONG_SAFE = SAFE.repeat(20);
const logs: string[] = [];
class AuditLog extends Log {
  constructor() { super(LogLevel.VERBOSE); }
  protected override log(message: string) { logs.push(message); }
}
interface ProviderCall { url: string; headers: Record<string, string>; body: string }
const calls: ProviderCall[] = [];
let mf: Miniflare;
let serial = 0;
let scenario: { chunks?: string[]; ending?: string; status?: number; responseBody?: string; location?: string; hold?: boolean; trailingHold?: boolean } = {};
let finishProvider: (() => void) | undefined;
let cancelled = false;
let providerClosed = false;

function sse(text: string, unicode = false): string {
  const data = JSON.stringify({ id: 'fixture-4b', object: 'chat.completion.chunk', model: 'glm-5.3-flash', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  const escaped = '"' + Array.from(text, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') + '"';
  return `data: ${unicode ? data.replace(JSON.stringify(text), escaped) : data}\n\n`;
}
const ending = 'data: {"id":"fixture-4b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\ndata: [DONE]\n\n';

beforeAll(async () => {
  const result = await build({ entryPoints: [path.resolve(import.meta.dirname, 'credentials-worker.ts')], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  const script = result.outputFiles![0]!.text;
  const workers: MiniflareOptions['workers'] = ['normal', 'missing', 'empty', 'malformed', 'opaque'].map(kind => {
    const name = `credentials-${kind}`;
    const value = kind === 'normal' ? KEY : kind === 'opaque' ? OPAQUE_PRIMARY : kind === 'empty' ? '' : 'invalid\r\nheader';
    return { config: {
      name, type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
      exports: { AuditAgentDO: { type: 'durable-object', storage: 'sqlite' } },
      env: {
        AGENTS: { type: 'durable-object', workerName: name, exportName: 'AuditAgentDO' },
        ...(kind === 'missing' ? {} : { AIPHABEE_ZAI_API_KEY: { type: 'text' as const, value } }),
        AIPHABEE_DEEPSEEK_API_KEY: { type: 'text', value: kind === 'opaque' ? OPAQUE_SECONDARY : SECONDARY },
      },
    },
      dev: { outboundService: { type: 'node-handler', handler: async (request: IncomingMessage, response: ServerResponse) => {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value ?? '']));
        calls.push({ url: headers['mf-original-url'] ?? new URL(request.url!, `https://${headers.host}`).href, headers, body });
        if (scenario.status) {
          response.writeHead(scenario.status, { location: scenario.location ?? 'https://evil.invalid/next' });
          response.end(scenario.responseBody); return;
        }
        const chunks = scenario.chunks ?? [sse(LONG_SAFE)];
        response.on('close', () => { if (!response.writableEnded) cancelled = true; });
        response.writeHead(200, { 'content-type': 'text/event-stream', 'x-provider-credential': KEY });
        response.flushHeaders();
        for (const chunk of chunks) response.write(chunk);
        const terminal = scenario.ending ?? ending;
        finishProvider = () => { response.end(terminal); providerClosed = true; };
        if (!scenario.hold && !scenario.trailingHold) finishProvider();
      } } },
    };
  });
  mf = new Miniflare({ workers, log: new AuditLog() });
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(() => { calls.length = 0; logs.length = 0; scenario = {}; finishProvider = undefined; cancelled = false; providerClosed = false; });

async function rpc(name: string, operation: 'dump' | 'submit' | 'append', input?: unknown, kind = 'normal') {
  const fetcher = await mf.getWorker(`credentials-${kind}`);
  return fetcher.fetch('http://test/', { method: 'POST', body: JSON.stringify({ name, operation, input }) });
}
async function dump(name: string, kind = 'normal') {
  const response = await rpc(name, 'dump', undefined, kind);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown[]>;
}
function events(text: string): Record<string, unknown>[] {
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
function safeArtifacts(...artifacts: unknown[]) {
  const text = JSON.stringify(artifacts);
  for (const key of [KEY, SECONDARY, OPAQUE_PRIMARY, OPAQUE_SECONDARY]) {
    const secrets = [key];
    const sensitive = key.replace(/^sk-proj-/, '');
    for (let index = 0; index <= sensitive.length - 16; index++) secrets.push(sensitive.slice(index, index + 16));
    for (const secret of secrets) {
      for (const form of [secret, btoa(secret), btoa(secret).replace(/\+/g, '-').replace(/\//g, '_'), encodeURIComponent(secret)]) expect(text).not.toContain(form);
    }
  }
}

describe('platform credentials through real native Harness in workerd', () => {
  for (const profile of ['zai_openai', 'deepseek_direct']) it(`uses frozen ${profile} mapping, header-only key and native persisted output`, async () => {
    const name = `good-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.', ...(profile === 'zai_openai' ? {} : { profile }) });
    expect(response.status).toBe(200);
    const text = await response.text();
    const parsed = events(text);
    expect(parsed.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), text).toBe(LONG_SAFE);
    expect(parsed.at(-1)).toMatchObject({ type: 'done' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(profile === 'zai_openai' ? 'https://api.z.ai/api/coding/paas/v4/chat/completions' : 'https://api.deepseek.com/chat/completions');
    expect(call.headers.authorization).toBe(`Bearer ${profile === 'zai_openai' ? KEY : SECONDARY}`);
    expect(JSON.parse(call.body).model).toBe(profile === 'zai_openai' ? 'glm-5.3-flash' : 'deepseek-v4-flash');
    safeArtifacts(call.url, call.body, text, logs);
    const persisted = await dump(name);
    safeArtifacts(persisted);
    expect(JSON.stringify(persisted)).toContain(LONG_SAFE);
    expect(Object.keys(persisted)).toContain('pi_entries');
    expect(JSON.stringify(persisted)).toContain('11');
    expect(JSON.stringify(persisted)).toContain('7');
  });

  it('releases safe text before provider EOF and finishes the tail in order', async () => {
    scenario = { hold: true, chunks: [sse(LONG_SAFE)] };
    const response = await rpc(`incremental-${++serial}`, 'submit', { instruction: 'Write a paragraph.' });
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain('text_delta');
      expect(providerClosed).toBe(false);
      finishProvider!();
      let text = new TextDecoder().decode(first.value);
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
      expect(events(text).filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe(LONG_SAFE);
      safeArtifacts(text, logs);
    } finally { if (!providerClosed && !cancelled) finishProvider?.(); await reader.cancel(); }
  });

  it('drops credential-bearing vendor metadata, headers and nonnumeric usage before pi intake', async () => {
    scenario = { chunks: [`data: ${JSON.stringify({ id: KEY, model: KEY, telemetry: { secret: KEY }, choices: [{ index: 0, delta: { content: LONG_SAFE, vendor_data: KEY }, finish_reason: null }], usage: { prompt_tokens: KEY, completion_tokens: 7, arbitrary: KEY } })}\n\n`] };
    const name = `metadata-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' });
    expect(response.headers.get('x-provider-credential')).toBeNull();
    const text = await response.text();
    expect(events(text).filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe(LONG_SAFE);
    expect(events(text).at(-1)).toMatchObject({ type: 'done' });
    safeArtifacts(text, logs, await dump(name));
    expect(calls).toHaveLength(1);
  });

  for (const transport of [false, true]) it(`drops key from ${transport ? 'HTTP error body' : 'provider SSE error message/stack/cause'} without retry or persistence`, async () => {
    const error = { message: KEY, stack: KEY, cause: { message: KEY } };
    scenario = transport ? { status: 500, responseBody: JSON.stringify(error) } : { chunks: [`data: ${JSON.stringify({ error })}\n\n`] };
    const name = `error-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' });
    const text = await response.text();
    expect(events(text).at(-1)).toEqual({ type: 'error', code: transport ? 'CLOUD_MODEL_REQUEST_FAILED' : 'CLOUD_MODEL_RESPONSE_REJECTED', retryable: false });
    expect(calls).toHaveLength(1);
    safeArtifacts(text, logs, await dump(name));
  });

  const leaks = [
    { name: 'raw final tail', chunks: [sse(KEY)] },
    { name: 'base64', chunks: [sse(btoa(KEY))] },
    { name: 'URL-safe base64', chunks: [sse(btoa(KEY).replace(/\+/g, '-').replace(/\//g, '_'))] },
    { name: 'percent encoded', chunks: [sse(Array.from(KEY, char => '%' + char.charCodeAt(0).toString(16)).join(''))] },
    { name: 'JSON unicode escapes', chunks: [sse(KEY, true)] },
    { name: 'split across decoded SSE deltas', chunks: Array.from(KEY, char => sse(char)) },
    { name: 'split across one-byte SSE transport chunks', chunks: Array.from(sse(KEY, true)) },
    { name: '16-character partial', chunks: [sse(KEY.slice(12, 28))] },
    { name: 'key split between content and reasoning lanes', chunks: [sse(KEY.slice(0, 13)), `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: KEY.slice(13) }, finish_reason: null }] })}\n\n`] },
  ];
  for (const leak of leaks) it(`drops ${leak.name} before client and all SQLite persistence`, async () => {
    scenario = { chunks: leak.chunks };
    const name = `leak-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' });
    const text = await response.text();
    expect(events(text).at(-1)).toEqual({ type: 'error', code: 'CLOUD_MODEL_RESPONSE_REJECTED', retryable: false });
    expect(events(text).some(event => event.type === 'text_delta')).toBe(false);
    expect(calls).toHaveLength(1);
    const persisted = await dump(name);
    safeArtifacts(text, logs, persisted);
    const assistants = (persisted.pi_entries as { record: string }[]).map(row => JSON.parse(row.record) as { kind: string; model: { content: unknown[] }[] }).filter(row => row.kind === 'pi.assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.model[0]!.content).toEqual([]);
  });

  it('rejects content-lane key assembly despite benign interleaved reasoning text', async () => {
    scenario = { chunks: Array.from(KEY).flatMap(character => [
      sse(character),
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'x' }, finish_reason: null }] })}\n\n`,
    ]) };
    const name = `interleaved-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' });
    const text = await response.text();
    const parsed = events(text);
    const persisted = await dump(name);
    const content = parsed.filter(event => event.type === 'text_delta').map(event => event.delta).join('');
    expect({ clientHasKey: content.includes(KEY), sqliteHasKey: JSON.stringify(persisted).includes(KEY), terminal: parsed.at(-1)?.type, code: parsed.at(-1)?.code }).toEqual({ clientHasKey: false, sqliteHasKey: false, terminal: 'error', code: 'CLOUD_MODEL_RESPONSE_REJECTED' });
    expect(calls).toHaveLength(1);
    safeArtifacts(text, logs, persisted);
  });

  for (const keyLane of ['content', 'reasoning_content'] as const) it(`holds incomplete ${keyLane} key while the other lane advances past the rolling window`, async () => {
    const fillerLane = keyLane === 'content' ? 'reasoning_content' : 'content';
    const frame = (lane: string, content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { [lane]: content }, finish_reason: null }] })}\n\n`;
    const prefix = KEY.slice(0, 15);
    scenario = { chunks: [frame(keyLane, prefix), frame(fillerLane, LONG_SAFE), frame(keyLane, KEY.slice(15))] };
    const name = `lane-tail-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' });
    const text = await response.text();
    const parsed = events(text);
    const persisted = await dump(name);
    const content = parsed.filter(event => event.type === 'text_delta').map(event => event.delta).join('');
    expect({ clientHasKey: content.includes(KEY), sqliteHasKey: JSON.stringify(persisted).includes(KEY), terminal: parsed.at(-1)?.type, code: parsed.at(-1)?.code }).toEqual({ clientHasKey: false, sqliteHasKey: false, terminal: 'error', code: 'CLOUD_MODEL_RESPONSE_REJECTED' });
    expect(content.includes(prefix)).toBe(false);
    expect(JSON.stringify(persisted).includes(prefix)).toBe(false);
    expect(calls).toHaveLength(1);
    safeArtifacts(text, logs, persisted);
  });

  for (const corrupt of [
    { name: 'missing terminal frame', chunks: [sse(SAFE)], ending: '', code: 'CLOUD_MODEL_RESPONSE_REJECTED' },
    { name: 'oversized SSE frame', chunks: ['data: ' + 'x'.repeat(65_537) + '\n\n'], ending: '', code: 'CLOUD_MODEL_RESPONSE_REJECTED' },
    { name: 'invalid JSON frame', chunks: ['data: {unclosed\n\n'], ending: '', code: 'CLOUD_MODEL_REQUEST_FAILED' },
  ]) it(`fails ${corrupt.name} safely without releasing a held tail`, async () => {
    scenario = corrupt;
    const name = `corrupt-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' });
    const text = await response.text();
    expect(events(text)).toEqual([{ type: 'error', code: corrupt.code, retryable: false }]);
    expect(calls).toHaveLength(1);
    safeArtifacts(text, logs, await dump(name));
  });

  it('retains only an already-released safe prefix and cancels the leaking upstream', async () => {
    scenario = { chunks: [sse(LONG_SAFE), sse(KEY)], trailingHold: true };
    const name = `abort-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' });
    const text = await response.text();
    expect(events(text).at(-1)).toMatchObject({ type: 'error', code: 'CLOUD_MODEL_RESPONSE_REJECTED', retryable: false });
    const released = events(text).filter(event => event.type === 'text_delta').map(event => event.delta).join('');
    expect(released.length).toBeGreaterThan(0);
    expect(LONG_SAFE.startsWith(released)).toBe(true);
    expect(released.length).toBeLessThan(LONG_SAFE.length);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(providerClosed).toBe(false);
    safeArtifacts(text, logs, await dump(name));
    expect(calls).toHaveLength(1);
  });

  for (const input of [
    { instruction: 'ok', apiKey: USER_KEY }, { instruction: 'ok', metadata: { credential: USER_KEY } },
    { instruction: 'ok', renamedKey: USER_KEY }, { instruction: 'ok', metadata: { arbitrary: USER_KEY } },
    { instruction: `Use ${USER_KEY}` }, { instruction: 'ok', headers: { authorization: USER_KEY } },
    { instruction: 'ok', profile: null },
  ]) it(`rejects user credential shape before writes and outbound fetch ${JSON.stringify(input)}`, async () => {
    const name = `reject-${++serial}`;
    const before = await dump(name);
    const response = await rpc(name, 'submit', input);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { retryable: false } });
    expect(text).not.toContain(USER_KEY);
    expect(calls).toHaveLength(0);
    expect(await dump(name)).toEqual(before);
    safeArtifacts(text, logs, before);
    expect(JSON.stringify(logs)).not.toContain(USER_KEY);
  });

  for (const { label, key, kind } of [
    { label: 'recognized user key', key: USER_KEY, kind: 'normal' },
    { label: 'primary platform key', key: KEY, kind: 'normal' },
    { label: 'secondary platform key', key: SECONDARY, kind: 'normal' },
    { label: 'opaque primary platform key', key: OPAQUE_PRIMARY, kind: 'opaque' },
    { label: 'opaque secondary platform key', key: OPAQUE_SECONDARY, kind: 'opaque' },
  ]) it(`rejects ${label} through legacy append before schema writes and fetch`, async () => {
    const name = `append-reject-${++serial}`;
    const before = await dump(name, kind);
    expect(before).toEqual({});
    const response = await rpc(name, 'append', `Store ${key}`, kind);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'CLOUD_USER_CREDENTIAL_REJECTED', retryable: false } });
    expect(text.includes(key)).toBe(false);
    expect(JSON.stringify(logs).includes(key)).toBe(false);
    expect(await dump(name, kind)).toEqual(before);
    expect(calls).toHaveLength(0);
    safeArtifacts(text, logs, before);
  });

  for (const { label, key, profile, kind } of [
    { label: 'primary platform key in secondary profile', key: KEY, profile: 'deepseek_direct', kind: 'normal' },
    { label: 'secondary platform key in primary profile', key: SECONDARY, profile: 'zai_openai', kind: 'normal' },
    { label: 'opaque primary platform key in secondary profile', key: OPAQUE_PRIMARY, profile: 'deepseek_direct', kind: 'opaque' },
    { label: 'opaque secondary platform key in primary profile', key: OPAQUE_SECONDARY, profile: 'zai_openai', kind: 'opaque' },
  ]) it(`rejects ${label} before schema writes and fetch`, async () => {
    const name = `profile-reject-${++serial}`;
    const before = await dump(name, kind);
    expect(before).toEqual({});
    const response = await rpc(name, 'submit', { instruction: `Use ${key}`, profile }, kind);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'CLOUD_USER_CREDENTIAL_REJECTED', retryable: false } });
    expect(text.includes(key)).toBe(false);
    expect(JSON.stringify(logs).includes(key)).toBe(false);
    expect(await dump(name, kind)).toEqual(before);
    expect(calls).toHaveLength(0);
    safeArtifacts(text, logs, before);
  });

  for (const kind of ['missing', 'empty', 'malformed']) it(`fails ${kind} binding with fixed nonretryable 503 and no writes/calls`, async () => {
    const name = `unavailable-${++serial}`;
    const before = await dump(name, kind);
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' }, kind);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE', retryable: false } });
    expect(calls).toHaveLength(0);
    expect(await dump(name, kind)).toEqual(before);
    safeArtifacts(before, logs);
  });

  for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) it(`rejects HTTP ${status} without following even a same-origin redirect`, async () => {
    scenario = { status, location: 'https://api.z.ai/api/coding/paas/v4/redirected' };
    const name = `redirect-${++serial}`;
    const response = await rpc(name, 'submit', { instruction: 'Write a paragraph.' });
    const text = await response.text();
    expect(events(text).at(-1)).toMatchObject({ type: 'error', code: 'CLOUD_MODEL_REQUEST_FAILED', retryable: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).not.toContain('redirected');
    safeArtifacts(text, logs, await dump(name));
  });
});

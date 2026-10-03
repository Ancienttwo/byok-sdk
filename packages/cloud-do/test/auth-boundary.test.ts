import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { build } from 'esbuild';
import { Log, LogLevel, Miniflare, type MiniflareOptions } from 'miniflare';
import type { Fault } from './auth-boundary-worker';

const KEY = 'sk-proj-~~~Platform~0123456789+Tail/Z9';
const RAW_CAUSE = 'raw-credential-reader-cause';
const THINKING = 'private-compaction-thinking-marker';
const SAFE = 'This is a safe platform response. '.repeat(20);
const CODE = 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE';
const faults: Fault[] = ['missing', 'empty', 'malformed', 'object', 'number', 'binding-throw'];
const authFaults: Fault[] = [...faults, 'get-undefined', 'get-throw'];
const calls: { url: string; body: string }[] = [];
const logs: string[] = [];
class AuditLog extends Log {
  constructor() { super(LogLevel.VERBOSE); }
  protected override log(message: string) { logs.push(message); }
}
let mf: Miniflare;
let serial = 0;
let providerStatus = 200;
type Tables = Record<string, Record<string, unknown>[]>;
interface RunResult {
  settled: { status: string; detail?: string }[];
  events: { type: string; message?: string; entry?: { model?: { errorMessage?: string; stopReason?: string }[] } }[];
  estimatedTokens: number;
  coercions: number;
  tables: Tables;
  resolverFailures: unknown[];
  settings: { compaction: { enabled: boolean } };
}

function assertSafe(...values: unknown[]) {
  const artifact = JSON.stringify(values);
  for (const secret of [KEY, ...Array.from({ length: KEY.length - 15 }, (_, index) => KEY.slice(index, index + 16))]) {
    const base64 = btoa(secret);
    const percent = Array.from(secret, char => '%' + char.charCodeAt(0).toString(16)).join('');
    for (const form of [secret, base64, base64.replace(/=+$/, ''), base64.replace(/\+/g, '-').replace(/\//g, '_'),
      base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      encodeURIComponent(secret), percent,
      percent.toUpperCase(), Array.from(secret, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]) {
      expect(artifact).not.toContain(form);
      expect(artifact).not.toContain(JSON.stringify(form).slice(1, -1));
    }
  }
  expect(artifact).not.toContain(RAW_CAUSE);
}

beforeAll(async () => {
  const result = await build({ entryPoints: [path.resolve(import.meta.dirname, 'auth-boundary-worker.ts')], bundle: true,
    format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  const workers: MiniflareOptions['workers'] = [...faults, 'normal'].map(fault => {
    const name = `auth-boundary-${fault}`;
    return { config: {
      name, type: 'worker', compatibilityDate: '2026-08-18', compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: result.outputFiles![0]!.text } } },
      exports: { PreflightAgentDO: { type: 'durable-object', storage: 'sqlite' }, AuthHarnessDO: { type: 'durable-object', storage: 'sqlite' } },
      env: {
        PREFLIGHT: { type: 'durable-object', workerName: name, exportName: 'PreflightAgentDO' },
        HARNESSES: { type: 'durable-object', workerName: name, exportName: 'AuthHarnessDO' },
        AIPHABEE_ZAI_API_KEY: { type: 'text', value: KEY }, FAULT: { type: 'text', value: fault },
      },
    }, dev: { outboundService: { type: 'node-handler', handler: async (request: IncomingMessage, response: ServerResponse) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      calls.push({ url: request.headers['mf-original-url'] as string ?? new URL(request.url!, `https://${request.headers.host}`).href, body });
      if (providerStatus !== 200) {
        response.writeHead(providerStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'The request exceeds the context window.' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = { choices: [{ index: 0, delta: { content: SAFE, reasoning_content: THINKING }, finish_reason: null }] };
      response.end(`data: ${JSON.stringify(frame)}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
    } } } };
  });
  mf = new Miniflare({ workers, log: new AuditLog(), handleStructuredLogs: message => { logs.push(JSON.stringify(message)); },
    handleUncaughtError: error => { logs.push(JSON.stringify(error, (_name, value: unknown) => value instanceof Error
      ? { message: value.message, stack: value.stack, cause: value.cause } : value)); } });
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); assertSafe(logs); });
beforeEach(() => { calls.length = 0; providerStatus = 200; });

async function rpc(operation: string, name: string, fault: Fault, flow = 'auth') {
  const worker = await mf.getWorker(`auth-boundary-${faults.includes(fault) ? fault : 'normal'}`);
  return worker.fetch('http://test/', { method: 'POST', body: JSON.stringify({ operation, name, fault, flow }) });
}

describe('credential failure before and inside real native Harness in workerd', () => {
  for (const fault of authFaults) {
    if (faults.includes(fault)) it(`rejects ${fault} binding in real AgentDO preflight with no provider call or persisted cause`, async () => {
      const name = `preflight-${++serial}`;
      const response = await rpc('preflight', name, fault);
      expect(response.status).toBe(503);
      const error = await response.json();
      expect(error).toEqual({ error: { code: CODE, retryable: false } });
      const audit = await (await rpc('dump-preflight', name, fault)).json() as { tables: Tables; coercions: number };
      expect(audit.coercions).toBe(0);
      expect(Object.keys(audit.tables).some(name => name.startsWith('pi_'))).toBe(false);
      expect(calls).toHaveLength(0);
      assertSafe(error, audit, logs);
    });

    it(`returns fixed resolver HTTP error for ${fault} binding`, async () => {
      const response = await rpc('resolve', `resolver-${++serial}`, fault);
      expect(response.status).toBe(503);
      const error = await response.json();
      expect(error).toEqual({ error: { code: CODE, retryable: false } });
      expect(calls).toHaveLength(0);
      assertSafe(error, logs);
    });

    it(`persists only fixed code for native ${fault} auth failure in every SQLite table`, async () => {
      const response = await rpc('run', `native-${++serial}`, fault);
      expect(response.status).toBe(200);
      const result = await response.json() as RunResult;
      expect(result.settled).toMatchObject([{ status: 'unanswered' }]);
      expect(result.resolverFailures).toEqual(Array.from({ length: 2 }, () => ({ cloudError: true,
        message: CODE, code: CODE, status: 503, retryable: false, causeAbsent: true, fresh: true })));
      expect(result.coercions).toBe(0);
      expect(calls).toHaveLength(0);
      const tables = Object.keys(result.tables);
      expect(tables).toContain('pi_tasks');
      expect(tables).toContain('pi_submissions');
      const persisted = JSON.stringify(result.tables);
      expect(persisted).toContain(CODE);
      expect(persisted).not.toContain('API key auth failed');
      expect(result.tables.pi_tasks).toHaveLength(1);
      const task = JSON.parse(result.tables.pi_tasks![0]!.record as string);
      expect(task.state.outcome).toMatchObject({ status: 'failed', error: { message: CODE } });
      expect(result.settled[0]!.detail).toBe(CODE);
      // Native pi emits message_end for outcome.failed. task_failed is for faults and orphans.
      const errors = result.events.filter(event => event.type === 'message_end')
        .flatMap(event => event.entry?.model ?? []).filter(message => message.stopReason === 'error');
      expect(errors).toMatchObject([{ stopReason: 'error', errorMessage: CODE }]);
      assertSafe(result, logs);
    });
  }
});

describe('disabled compaction through real native Harness in workerd', () => {
  it('builds no compaction request above the real threshold and never sends historical thinking', async () => {
    const response = await rpc('run', `threshold-${++serial}`, 'normal', 'threshold');
    expect(response.status).toBe(200);
    const result = await response.json() as RunResult;
    expect(result.settings.compaction.enabled).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(65_536 - 16_384);
    expect(result.settled).toMatchObject([{ status: 'done' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
    expect(calls[0]!.body).toContain('early-context ');
    expect(calls[0]!.body).toContain('recent-context ');
    expect(calls[0]!.body).not.toContain(THINKING);
    expect(calls[0]!.body).not.toContain('[Assistant thinking]');
    expect(JSON.stringify(result.tables.pi_tasks)).not.toContain('pi.compaction');
    expect(result.events.some(event => event.type.startsWith('compaction_'))).toBe(false);
    expect(JSON.stringify(result.tables)).toContain(THINKING);
    assertSafe(result, logs, calls);
  });

  it('fails a real HTTP 413 overflow response above the threshold with no compaction request or retry', async () => {
    providerStatus = 413;
    const response = await rpc('run', `overflow-${++serial}`, 'normal', 'overflow');
    expect(response.status).toBe(200);
    const result = await response.json() as RunResult;
    expect(result.settings.compaction.enabled).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(65_536 - 16_384);
    expect(result.settled).toMatchObject([{ status: 'unanswered', detail: 'CLOUD_MODEL_REQUEST_FAILED' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
    expect(calls[0]!.body).toContain('early-context ');
    expect(calls[0]!.body).toContain('recent-context ');
    expect(calls[0]!.body).not.toContain(THINKING);
    expect(calls[0]!.body).not.toContain('[Assistant thinking]');
    expect(JSON.stringify(result.tables.pi_tasks)).not.toContain('pi.compaction');
    expect(result.events.some(event => event.type.startsWith('compaction_'))).toBe(false);
    expect(JSON.stringify(result.tables)).not.toContain('context_length_exceeded');
    expect(JSON.stringify(result.tables)).toContain(THINKING);
    assertSafe(result, logs, calls);
  });

  it('keeps normal two-turn requests and omits prior thinking from the second request', async () => {
    const response = await rpc('run', `multi-turn-${++serial}`, 'normal', 'multi-turn');
    expect(response.status).toBe(200);
    const result = await response.json() as RunResult;
    expect(result.settled).toMatchObject([{ status: 'done' }, { status: 'done' }]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
      expect(call.body).not.toContain(THINKING);
      expect(call.body).not.toContain('[Assistant thinking]');
    }
    expect(calls[1]!.body).toContain(SAFE);
    expect(JSON.stringify(result.tables.pi_tasks)).not.toContain('pi.compaction');
    expect(result.events.some(event => event.type.startsWith('compaction_'))).toBe(false);
    expect(JSON.stringify(result.tables)).toContain(THINKING);
    assertSafe(result, logs, calls);
  });
});

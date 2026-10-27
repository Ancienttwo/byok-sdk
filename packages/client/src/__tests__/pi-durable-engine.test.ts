import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { DURABLE_HARNESS_IDENTITY, DURABLE_HARNESS_SETTINGS, openDurableEngine } from '../adapters/pi-durable/engine';
import { admitReplica } from '../adapters/pi-durable/replica';
import { projectDurableEvent } from '../adapters/pi-durable/events';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-durable-engine-')); roots.push(root);
  const home = path.join(root, 'home'); await mkdir(home);
  const binding = { agentRef: { tenantId: 't', agentId: 'a', profileRevision: 'r' }, taskId: 'task', leaseId: 'lease', canonicalHome: home };
  const replicaRoot = path.join(root, 'store'); const file = await admitReplica(replicaRoot, binding);
  const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'probe', baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 };
  let calls = 0;
  const stream = () => {
    calls++;
    const out = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'finished' }], api: model.api, provider: 'probe', model: 'test', usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    queueMicrotask(() => { out.push({ type: 'done', reason: 'stop', message }); out.end(message); }); return out;
  };
  const models = createModels(); models.setProvider(createProvider({ id: 'probe', auth: { apiKey: { name: 'synthetic', resolve: async () => ({ auth: { apiKey: 'synthetic' } }) } }, models: [model], api: { stream, streamSimple: stream } }));
  return { file, replicaRoot, binding, models, model: { provider: 'probe', modelId: 'test' }, instruction: 'Reply', ambient: process.env, calls: () => calls };
}
describe('real Pi 1.0 durable engine', () => {
  it('reports completion once and projects final ordinary usage exactly once', async () => {
    const input = await fixture(); const events: unknown[] = []; let completed = 0;
    const engine = await openDurableEngine({ ...input, resume: false, beforeTool: async () => {}, events: async batch => { events.push(...batch.flatMap(projectDurableEvent)); }, completed: async () => { completed += 1; } });
    try { await engine.run(); } finally { await engine.close(); }
    expect(input.calls()).toBe(1); expect(completed).toBe(1);
    expect(events.filter((event: any) => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 3, cachedInputTokens: 2, outputTokens: 1, totalTokens: 4 }]);
  });
  it('projects the model pi-ai recorded as served, not the requested id (#1014)', async () => {
    const input = await fixture();
    const model: Model<'openai-completions'> = { id: 'probe/alias', name: 'probe', api: 'openai-completions', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 };
    const chunk = (body: object) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'probe/served-2026-10-01', ...body })}\n\n`;
    const sse = chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'finished' }, finish_reason: null }] })
      + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + 'data: [DONE]\n\n';
    const respond: typeof fetch = async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    const stream: typeof streamSimple = (m, context, options) => streamSimple(m, context, { ...options, fetch: respond });
    const models = createModels(); models.setProvider(createProvider({ id: 'openrouter', auth: { apiKey: { name: 'synthetic', resolve: async () => ({ auth: { apiKey: 'synthetic' } }) } }, models: [model], api: { stream, streamSimple: stream } }));
    const events: unknown[] = [];
    const engine = await openDurableEngine({ ...input, models, model: { provider: 'openrouter', modelId: model.id }, resume: false, beforeTool: async () => {}, events: async batch => { events.push(...batch.flatMap(projectDurableEvent)); }, completed: async () => {} });
    try { await engine.run(); } finally { await engine.close(); }
    expect(events.filter((event: any) => event.type === 'usage')).toMatchObject([{ type: 'usage', model: 'probe/served-2026-10-01' }]);
  });
  it('fresh execution discards a real stale pending tool checkpoint BEFORE any old model request can resume', async () => {
    const input = await fixture(); const receipt = path.join(path.dirname(input.file), 'old-calls');
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, 'fixtures/pi-durable-pending.mjs'), input.file, receipt], { stdio: ['ignore','pipe','pipe'] });
    try {
      await new Promise<void>((resolve,reject) => { child.stdout.once('data', () => resolve()); child.once('error',reject); child.once('exit', () => reject(new Error('pending fixture exited'))); });
      child.kill('SIGKILL'); await once(child, 'close');
      const engine = await openDurableEngine({ ...input, resume: false, beforeTool: async () => {}, events: async () => {}, completed: async () => {} });
      try { await engine.run(); } finally { await engine.close(); }
      expect(input.calls()).toBe(1); expect(await readFile(receipt, 'utf8')).toBe('old-model-call\n');
      await expect(readFile(path.join(path.dirname(input.file), 'old-effect'))).rejects.toThrow();
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child,'close'); } }
  });
  it('sends no provider attribution headers, as with Pi 1.3', async () => {
    const input = await fixture();
    const model: Model<'openai-completions'> = { id: 'probe/model', name: 'probe', api: 'openai-completions', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 };
    const sent: Headers[] = [];
    const chunk = (body: object) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: model.id, ...body })}\n\n`;
    const sse = chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'finished' }, finish_reason: null }] })
      + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + 'data: [DONE]\n\n';
    const capture: typeof fetch = async (resource, init) => {
      sent.push(new Headers(resource instanceof Request ? resource.headers : init?.headers));
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    };
    const stream: typeof streamSimple = (m, context, options) => streamSimple(m, context, { ...options, fetch: capture });
    const models = createModels(); models.setProvider(createProvider({ id: 'openrouter', auth: { apiKey: { name: 'synthetic', resolve: async () => ({ auth: { apiKey: 'synthetic' } }) } }, models: [model], api: { stream, streamSimple: stream } }));
    const engine = await openDurableEngine({ ...input, models, model: { provider: 'openrouter', modelId: model.id }, resume: false, beforeTool: async () => {}, events: async () => {}, completed: async () => {} });
    try { await engine.run(); } finally { await engine.close(); }
    expect(sent).toHaveLength(1);
    for (const name of ['http-referer', 'x-openrouter-title', 'x-openrouter-categories']) expect(sent[0]!.has(name), name).toBe(false);
  });
  it('never parks a task that restarts cut off, as with Pi 1.3', () => {
    expect(DURABLE_HARNESS_SETTINGS.restartLimit).toBe(Infinity);
    expect(DURABLE_HARNESS_IDENTITY).toEqual({ attribution: null });
  });
  it('reacquires a settled execution after reopen without adding Host input or calling the model', async () => {
    const input = await fixture(); let completed = 0;
    const callbacks = { beforeTool: async () => {}, events: async () => {}, completed: async () => { completed += 1; } };
    const first = await openDurableEngine({ ...input, ...callbacks, resume: false }); await first.run(); await first.close();
    const second = await openDurableEngine({ ...input, ...callbacks, resume: true });
    try { await second.run(); } finally { await second.close(); }
    // Each run reports its settled completion; no Host input is added and no model call repeats.
    expect(input.calls()).toBe(1); expect(completed).toBe(2);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { openDurableEngine } from '../adapters/pi-durable/engine';
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
  it('persists current result and projects final ordinary usage exactly once', async () => {
    const input = await fixture(); const events: unknown[] = []; let result: unknown;
    const engine = await openDurableEngine({ ...input, resume: false, beforeTool: async () => {}, events: async batch => { events.push(...batch.flatMap(projectDurableEvent)); }, result: async value => { result = value; } });
    try { await engine.run(); } finally { await engine.close(); }
    expect(input.calls()).toBe(1); expect(result).toEqual({ text: 'finished' });
    expect(events.filter((event: any) => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 3, cachedInputTokens: 2, outputTokens: 1, totalTokens: 4 }]);
  });
  it('fresh execution discards a real stale pending tool checkpoint BEFORE any old model request can resume', async () => {
    const input = await fixture(); const receipt = path.join(path.dirname(input.file), 'old-calls');
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, 'fixtures/pi-durable-pending.mjs'), input.file, receipt], { stdio: ['ignore','pipe','pipe'] });
    try {
      await new Promise<void>((resolve,reject) => { child.stdout.once('data', () => resolve()); child.once('error',reject); child.once('exit', () => reject(new Error('pending fixture exited'))); });
      child.kill('SIGKILL'); await once(child, 'close');
      const engine = await openDurableEngine({ ...input, resume: false, beforeTool: async () => {}, events: async () => {}, result: async () => {} });
      try { await engine.run(); } finally { await engine.close(); }
      expect(input.calls()).toBe(1); expect(await readFile(receipt, 'utf8')).toBe('old-model-call\n');
      await expect(readFile(path.join(path.dirname(input.file), 'old-effect'))).rejects.toThrow();
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child,'close'); } }
  });
  it('reacquires a settled execution after reopen without adding Host input or calling the model', async () => {
    const input = await fixture(); let result: unknown;
    const callbacks = { beforeTool: async () => {}, events: async () => {}, result: async (value: unknown) => { result = value; } };
    const first = await openDurableEngine({ ...input, ...callbacks, resume: false }); await first.run(); await first.close();
    const second = await openDurableEngine({ ...input, ...callbacks, resume: true });
    try { await second.run(); } finally { await second.close(); }
    expect(input.calls()).toBe(1); expect(result).toEqual({ text: 'finished' });
  });
});

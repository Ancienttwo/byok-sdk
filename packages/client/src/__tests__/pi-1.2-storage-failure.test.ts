import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionFailed, type Storage } from '@earendil-works/pi-durable';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { openDurableEngine } from '../adapters/pi-durable/engine';
import { admitReplica } from '../adapters/pi-durable/replica';
import { openLocalDurableStorage } from '../adapters/pi-durable/storage';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** Real node SQLite storage; the first commit after the model is called throws once. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-durable-storage-failure-')); roots.push(root);
  const home = path.join(root, 'home'); await mkdir(home);
  const binding = { agentRef: { tenantId: 't', agentId: 'a', profileRevision: 'r' }, taskId: 'task', leaseId: 'lease', canonicalHome: home };
  const replicaRoot = path.join(root, 'store'); const file = await admitReplica(replicaRoot, binding);
  const storageError = new Error('fixture storage unavailable');
  let armed = false; let thrown = 0;
  const storageFactory = async (location: string): Promise<Storage> => {
    const storage = await openLocalDurableStorage(location);
    return new Proxy(storage, { get(target, key) {
      if (key === 'commit') return async (...args: Parameters<Storage['commit']>) => {
        if (armed) { armed = false; thrown++; throw storageError; }
        return target.commit(...args);
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'probe', baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 };
  const stream = () => {
    armed = true; // mid-run: the commit persisting this response fails
    const out = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'finished' }], api: model.api, provider: 'probe', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    queueMicrotask(() => { out.push({ type: 'done', reason: 'stop', message }); out.end(message); }); return out;
  };
  const models = createModels(); models.setProvider(createProvider({ id: 'probe', auth: { apiKey: { name: 'synthetic', resolve: async () => ({ auth: { apiKey: 'synthetic' } }) } }, models: [model], api: { stream, streamSimple: stream } }));
  return { file, replicaRoot, binding, models, model: { provider: 'probe', modelId: 'test' }, instruction: 'Reply', ambient: process.env, storageFactory, storageError, thrown: () => thrown };
}

const settleWithin = <T>(promise: Promise<T>, ms: number) => Promise.race([
  promise.then(value => ({ outcome: 'resolved' as const, value }), (error: unknown) => ({ outcome: 'rejected' as const, error })),
  new Promise<{ outcome: 'hung' }>(resolve => setTimeout(() => resolve({ outcome: 'hung' }), ms)),
]);

describe('Pi 1.2 storage failure fails the durable engine closed', () => {
  it('rejects run() with SessionFailed carrying the storage error and never reports completion', async () => {
    const { storageError, thrown, ...input } = await fixture();
    let completed = 0;
    const engine = await openDurableEngine({ ...input, resume: false, beforeTool: async () => {}, events: async () => {}, completed: async () => { completed += 1; } });
    const ran = await settleWithin(engine.run(), 5000);
    const closed = await settleWithin(engine.close(), 5000);
    expect(thrown()).toBe(1);
    expect(ran.outcome).toBe('rejected');
    const error = (ran as { error: unknown }).error;
    expect(error).toBeInstanceOf(SessionFailed);
    expect((error as Error).cause).toBe(storageError);
    expect(completed).toBe(0);
    // Pre-fix observation (pi-durable 1.2.0): run() rejects with SessionFailed(cause = storage error)
    // before stop() is reached, and close() resolves on the failed Session, releasing the replica lock.
    expect(closed.outcome).toBe('resolved');
  });
});

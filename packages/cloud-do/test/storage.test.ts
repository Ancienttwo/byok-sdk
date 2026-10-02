import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExpectAssertions } from '@earendil-works/pi-durable/testing';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { openLocalDurableStorage } from '../../client/src/adapters/pi-durable/storage';
import { createByokStorageContract } from './storage-contract';

const assertions = createExpectAssertions(expect);
const cases = createByokStorageContract(async use => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-local-contract-'));
  const file = path.join(root, 'durable-contract.sqlite');
  let storage = await openLocalDurableStorage(file);
  try {
    await use(storage, async () => { await storage.close(ctx); storage = await openLocalDurableStorage(file); return storage; });
  } finally { await storage.close(ctx); await rm(root, { recursive: true, force: true }); }
}, assertions);

describe('local SQLite shared native storage contract', () => {
  for (const test of cases) it(test.name, test.run);
});

let mf: Miniflare;
let script: string;
let persist: string;
function runtime() {
  return new Miniflare({
    resourcePersistencePath: persist,
    workers: [{ config: {
      name: 'byok-cloud-4a-test', type: 'worker', compatibilityDate: '2026-08-18',
      compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
      exports: { AgentDO: { type: 'durable-object', storage: 'sqlite' }, ContractDO: { type: 'durable-object', storage: 'sqlite' } },
      env: {
        AGENTS: { type: 'durable-object', workerName: 'byok-cloud-4a-test', exportName: 'AgentDO' },
        CONTRACTS: { type: 'durable-object', workerName: 'byok-cloud-4a-test', exportName: 'ContractDO' },
      },
    } }],
  });
}
async function rpc(body: Record<string, unknown>) {
  const response = await mf.dispatchFetch('http://test/', { method: 'POST', body: JSON.stringify(body) });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text);
}

beforeAll(async () => {
  const result = await build({ entryPoints: [path.resolve(import.meta.dirname, 'worker.ts')], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  script = result.outputFiles![0]!.text;
  persist = await mkdtemp(path.join(os.tmpdir(), 'byok-do-contract-'));
  mf = runtime();
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); if (persist) await rm(persist, { recursive: true, force: true }); });

describe('DO SQLite shared native storage contract in workerd', () => {
  cases.forEach((test, index) => it(test.name, async () => {
    await rpc({ operation: 'contract:case', name: `contract:${index}`, index });
  }));
});

describe('DO host and adapter in workerd', () => {
  it('uses a stable unambiguous SHA-256 identity and both namespace lookup forms agree', async () => {
    const identity = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent' };
    const name = await rpc({ operation: 'name', identity });
    expect(name).toMatch(/^agent:[a-f0-9]{64}$/);
    expect(await rpc({ operation: 'name', identity })).toBe(name);
    for (const key of Object.keys(identity)) expect(await rpc({ operation: 'name', identity: { ...identity, [key]: 'different' } })).not.toBe(name);
    expect(await rpc({ operation: 'name', identity: { tenantId: 'a:b', workspaceId: 'c', agentId: 'd' } })).not.toBe(await rpc({ operation: 'name', identity: { tenantId: 'a', workspaceId: 'b:c', agentId: 'd' } }));
    const lookup = await rpc({ operation: 'lookup', identity });
    expect(lookup.name).toBe(name); expect(lookup.byName).toBe(lookup.byId);
  });
  it('allocates a fresh conversation per execution and preserves isolation across a full runtime restart', async () => {
    const identity = { tenantId: 't', workspaceId: 'w', agentId: 'restart' };
    expect(await rpc({ operation: 'open', identity })).toEqual({ scheduling: 'paused' });
    const first = await rpc({ operation: 'execution', identity });
    const second = await rpc({ operation: 'execution', identity });
    expect(first.conversationId).not.toBe(second.conversationId);
    await rpc({ operation: 'append', identity, conversationId: first.conversationId, text: 'first only' });
    await rpc({ operation: 'append', identity, conversationId: second.conversationId, text: 'second only' });
    expect(await rpc({ operation: 'read', identity, conversationId: first.conversationId })).toEqual(['first only']);
    expect(await rpc({ operation: 'read', identity, conversationId: second.conversationId })).toEqual(['second only']);
    await mf.dispose(); mf = runtime(); await mf.ready;
    expect(await rpc({ operation: 'read', identity, conversationId: first.conversationId })).toEqual(['first only']);
    expect(await rpc({ operation: 'read', identity, conversationId: second.conversationId })).toEqual(['second only']);
    const third = await rpc({ operation: 'execution', identity });
    expect(third.conversationId).toBeGreaterThan(second.conversationId);
    expect(await rpc({ operation: 'read', identity, conversationId: third.conversationId })).toEqual([]);
    const other = await rpc({ operation: 'execution', identity: { ...identity, tenantId: 'other' } });
    expect(await rpc({ operation: 'read', identity: { ...identity, tenantId: 'other' }, conversationId: other.conversationId })).toEqual([]);
  });
  it('queues outside operations, rolls back, invalidates handles, survives failure and orders close', async () => {
    await rpc({ operation: 'contract:transactions', name: 'transactions' });
  });
  it('prefixes every pi table and index while preserving host tables, literals and binding values', async () => {
    await rpc({ operation: 'contract:schema', name: 'schema' });
  });
  it('accepts 100 bindings and rejects 101 bindings', async () => {
    await rpc({ operation: 'contract:limits', name: 'limits' });
  });
});

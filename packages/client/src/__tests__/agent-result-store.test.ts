import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_RESULT_DIRECTORY, AgentResultStore, AgentResultStoreError, agentResultDigest } from '../daemon/agent-result-store';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function home(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-result-store-')));
  roots.push(root);
  return root;
}

const SCHEMA = { type: 'object', additionalProperties: false, properties: { a: { type: 'integer' }, b: { type: 'string' } } };
const BASE = { taskId: 'task-1', tenantId: 'tenant', agentRef: { agentId: 'agent', profileRevision: 'r1' }, contract: 'c.v1', schema: SCHEMA };

describe('AgentResultStore', () => {
  it('writes one immutable record per task under .byok/results and reads it back from a fresh store', async () => {
    const dir = await home();
    const store = await AgentResultStore.open(dir);
    const record = await store.stage({ ...BASE, outcome: { a: 1, b: 'x' }, byteCount: 13 });
    expect(record).toMatchObject({ schema: 1, taskId: 'task-1', outcome: { a: 1, b: 'x' }, byteCount: 13,
      schemaDigest: agentResultDigest(SCHEMA), contentHash: agentResultDigest({ b: 'x', a: 1 }) });
    const files = await fs.readdir(path.join(dir, AGENT_RESULT_DIRECTORY));
    expect(files).toHaveLength(1);
    expect((await fs.stat(path.join(dir, AGENT_RESULT_DIRECTORY, files[0]!))).mode & 0o777).toBe(0o600);
    expect(await (await AgentResultStore.open(dir)).get('task-1')).toEqual(record);
    expect(await store.get('task-2')).toBeUndefined();
  });

  it('returns the same record for the same content in any key order and refuses anything different', async () => {
    const store = await AgentResultStore.open(await home());
    const first = await store.stage({ ...BASE, outcome: { a: 1, b: 'x' }, byteCount: 13 });
    expect(await store.stage({ ...BASE, outcome: { b: 'x', a: 1 }, byteCount: 13 })).toEqual(first);
    for (const different of [
      { ...BASE, outcome: { a: 2, b: 'x' } },
      { ...BASE, contract: 'c.v2', outcome: { a: 1, b: 'x' } },
      { ...BASE, schema: { ...SCHEMA, required: ['a'] }, outcome: { a: 1, b: 'x' } },
      { ...BASE, agentRef: { agentId: 'agent', profileRevision: 'r2' }, outcome: { a: 1, b: 'x' } },
    ]) {
      await expect(store.stage({ ...different, byteCount: 13 })).rejects.toMatchObject({ code: 'result_already_staged' });
    }
    expect(await store.get('task-1')).toEqual(first);
  });

  it('serializes concurrent stages of one task to a single winner', async () => {
    const store = await AgentResultStore.open(await home());
    const settled = await Promise.allSettled([
      store.stage({ ...BASE, outcome: { a: 1 }, byteCount: 7 }),
      store.stage({ ...BASE, outcome: { a: 2 }, byteCount: 7 }),
      store.stage({ ...BASE, outcome: { a: 1 }, byteCount: 7 }),
    ]);
    expect(settled.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    const [first, , third] = settled as [PromiseFulfilledResult<unknown>, PromiseRejectedResult, PromiseFulfilledResult<unknown>];
    expect(third.value).toEqual(first.value);
  });

  it('fails closed on a tampered record instead of delivering it', async () => {
    const dir = await home();
    const store = await AgentResultStore.open(dir);
    await store.stage({ ...BASE, outcome: { a: 1 }, byteCount: 7 });
    const [file] = await fs.readdir(path.join(dir, AGENT_RESULT_DIRECTORY));
    const full = path.join(dir, AGENT_RESULT_DIRECTORY, file!);
    const record = JSON.parse(await fs.readFile(full, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(full, JSON.stringify({ ...record, outcome: { a: 99 } }));
    await expect(store.get('task-1')).rejects.toBeInstanceOf(AgentResultStoreError);
    await expect(store.get('task-1')).rejects.toMatchObject({ code: 'result_record_invalid' });
  });
});

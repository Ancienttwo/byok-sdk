import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_RESULT_DIRECTORY, AgentResultStore, AgentResultStoreError, agentResultDigest, pruneAgentResults } from '../daemon/agent-result-store';

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

describe('pruneAgentResults', () => {
  const NOW = Date.parse('2026-10-14T00:00:00.000Z');
  const DAY = 86_400_000;
  const name = (n: number): string => `result-${n.toString(16).padStart(64, '0')}.json`;
  async function file(dir: string, entry: string, ageMs: number, content = '{}'): Promise<string> {
    const target = path.join(dir, entry);
    await fs.writeFile(target, content);
    const when = new Date(NOW - ageMs);
    await fs.utimes(target, when, when);
    return target;
  }
  async function prune(dir: string, input: { readonly maxAgeMs?: number; readonly maxRetained?: number; readonly allow?: number } = {}): Promise<string[]> {
    const removed: string[] = [];
    await pruneAgentResults({
      resultsRoot: dir, entries: await fs.opendir(dir), nowMs: NOW, maxAgeMs: input.maxAgeMs ?? 7 * DAY,
      ...(input.maxRetained === undefined ? {} : { maxRetained: input.maxRetained }),
      remove: async (target) => {
        if (removed.length >= (input.allow ?? Number.MAX_SAFE_INTEGER)) return false;
        await fs.rm(target);
        removed.push(path.basename(target));
        return true;
      },
    });
    return removed.sort();
  }

  it('removes records and crashed-stage temps at the TTL without parsing them, and keeps younger ones', async () => {
    const dir = await home();
    await file(dir, name(1), 7 * DAY + 1000, '{malformed');
    await file(dir, `${name(2)}.123-4.tmp`, 8 * DAY);
    await file(dir, name(3), 7 * DAY - 1000);
    await file(dir, `${name(4)}.123-5.tmp`, DAY);
    expect(await prune(dir)).toEqual([name(1), `${name(2)}.123-4.tmp`].sort());
    expect((await fs.readdir(dir)).sort()).toEqual([name(3), `${name(4)}.123-5.tmp`].sort());
  });

  it('removes the oldest records beyond the retained count; temps do not count', async () => {
    const dir = await home();
    for (let index = 0; index < 5; index++) await file(dir, name(index), (5 - index) * 1000);
    await file(dir, `${name(9)}.123-4.tmp`, 10_000);
    expect(await prune(dir, { maxRetained: 3 })).toEqual([name(0), name(1)]);
    expect(await fs.readdir(dir)).toHaveLength(4);
  });

  it('a zero TTL removes every record', async () => {
    const dir = await home();
    await file(dir, name(1), 1000);
    await file(dir, name(2), 2000);
    expect(await prune(dir, { maxAgeMs: 0 })).toEqual([name(1), name(2)]);
  });

  it('leaves other names, directories and symbolic links alone', async () => {
    const dir = await home();
    await file(dir, 'notes.json', 30 * DAY);
    await file(dir, `result-${'a'.repeat(63)}.json`, 30 * DAY);
    await fs.mkdir(path.join(dir, name(1)));
    const outside = await file(await home(), 'outside.json', 30 * DAY);
    await fs.symlink(outside, path.join(dir, name(2)));
    expect(await prune(dir, { maxAgeMs: 0, maxRetained: 0 })).toEqual([]);
    expect(await fs.readdir(dir)).toHaveLength(4);
  });

  it('removes expired files while listing, so a budget shared with the listing still drains a backlog', async () => {
    const dir = await home();
    for (let index = 0; index < 20; index++) await file(dir, name(index), 30 * DAY);
    // One budget for listing steps and removals, as the per-home retention budget is.
    let units = 10;
    const spend = (): boolean => units-- > 0;
    const listed: string[] = [], removed: string[] = [];
    async function* limited(): AsyncGenerator<import('node:fs').Dirent> {
      for await (const entry of await fs.opendir(dir)) {
        if (!spend()) return;
        listed.push(entry.name);
        yield entry;
      }
    }
    await pruneAgentResults({
      resultsRoot: dir, entries: limited(), nowMs: NOW, maxAgeMs: 7 * DAY,
      remove: async (target) => {
        if (!spend()) return false;
        await fs.rm(target);
        removed.push(path.basename(target));
        return true;
      },
    });
    expect(listed).toHaveLength(5);
    expect(removed).toEqual(listed);
    expect(await fs.readdir(dir)).toHaveLength(15);
  });

  it('stops at the first removal its caller refuses', async () => {
    const dir = await home();
    for (let index = 0; index < 4; index++) await file(dir, name(index), 30 * DAY);
    expect(await prune(dir, { allow: 1 })).toHaveLength(1);
    expect(await fs.readdir(dir)).toHaveLength(3);
  });
});

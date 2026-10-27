import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { createRetentionRegistry } from '../daemon/retention/producers';
import { resolveStorageConfig } from '../daemon/retention/config';
import { ScratchRoot } from '../daemon/retention/scratch';
import { runtimeReclaimedBytes } from '../daemon/retention/runtime-accounting';
import type { ExpiringClassId, SweepBudget } from '../daemon/retention/registry';
import { testScratchRoot } from './fixtures/execution-scratch';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of close.splice(0)) await dispose(); });
const now = new Date('2026-10-28T00:00:00Z');
const old = new Date('2026-09-01T00:00:00Z');
async function fixture() {
  const store = testScratchRoot();
  const config = resolveStorageConfig(store, { scratchRoot: testScratchRoot() });
  const scratch = new ScratchRoot(config.scratchRoot, () => now); await scratch.open(store);
  const home = new AgentHomeManager({ hostStorageRoot: testScratchRoot() });
  const binding = await home.prepare({ agentId: 'agent', profileRevision: '1' });
  await binding.lease.release();
  const createRegistry = () => {
  const registry = createRetentionRegistry({ storeDir: store, config, scratch, clock: () => now,
    journal: () => undefined, identity: () => undefined, preparation: () => undefined,
    home, handoffs: new AgentSessionHandoffStore() });
  close.push(() => registry.close());
  return registry;
  };
  return { store, scratch, registry: createRegistry(), createRegistry, home: binding.resolution.canonicalHome };
}
async function populate(directory: string, count: number) {
  await fs.mkdir(directory, { recursive: true });
  for (let start = 0; start < count; start += 128) {
    await Promise.all(Array.from({ length: Math.min(128, count - start) }, (_, n) => fs.writeFile(path.join(directory, `f${start + n}`), 'x')));
  }
  await fs.utimes(directory, old, old);
}
function budget(trigger: SweepBudget['trigger'] = 'periodic') {
  const tally = { inspections: 0, deleted: 0, bytes: 0, truncated: false };
  const value: SweepBudget = { trigger, now, available: () => ++tally.inspections <= 8192,
    remaining: () => 256 - tally.deleted, removed: bytes => { tally.deleted++; tally.bytes += bytes; },
    truncate: () => { tally.truncated = true; } };
  return { value, tally };
}
async function count(directory: string) {
  try { return (await fs.readdir(directory)).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}
it.each(['exec-sdk', 'daemon-temp', 'reader-run'] as const)('%s drains a real oversized tree across bounded passes with exact byte accounting', async id => {
  const f = await fixture();
  const execution = await f.scratch.create(); f.scratch.abandon(execution.token);
  const target = id === 'exec-sdk' ? execution.sdkDir : id === 'daemon-temp'
    ? path.join(f.store, 'tmp/daemon/diag-abc123') : path.join(f.home, '.byok/runs/run-large');
  await populate(target, 16_384);
  let bytes = 0, deleted = 0, registry = f.registry;
  for (let pass = 0; pass < 40 && await fs.lstat(target).then(() => true, () => false); pass++) {
    const before = await count(target), b = budget();
    await registry.sweep(id, b.value);
    bytes += b.tally.bytes + (runtimeReclaimedBytes.get(b.value) ?? 0); deleted += b.tally.deleted;
    expect(b.tally.inspections).toBeLessThanOrEqual(1024);
    expect(before - await count(target)).toBeLessThanOrEqual(1024);
    if (pass === 0) {
      expect(await count(target)).toBeLessThan(16_384); expect(b.tally.truncated).toBe(true);
      expect((await fs.stat(target)).mtimeMs).toBe(old.getTime());
      await registry.close(); registry = f.createRegistry();
    }
  }
  expect(await fs.lstat(target).then(() => true, () => false)).toBe(false);
  expect(bytes).toBe(16_384); expect(deleted).toBe(1);
}, 60_000);
it('startup makes bounded SDK progress without publishing a released marker until secrets are gone', async () => {
  const f = await fixture(), execution = await f.scratch.create(); f.scratch.abandon(execution.token);
  await populate(execution.sdkDir, 2048);
  const first = budget('startup');
  await expect(f.registry.sweep('exec-sdk', first.value)).rejects.toThrow('retention_startup_incomplete');
  expect(await count(execution.sdkDir)).toBeLessThan(2048);
  expect(await count(execution.sdkDir)).toBeGreaterThan(0);
  const marker = path.join(path.dirname(execution.sdkDir), 'released');
  expect(await fs.lstat(marker).then(() => true, () => false)).toBe(false);
  for (let pass = 0; pass < 4; pass++) {
    try { await f.registry.sweep('exec-sdk', budget('startup').value); }
    catch (error) { expect((error as Error).message).toBe('retention_startup_incomplete'); }
  }
  expect(await fs.readFile(marker, 'utf8')).toBe(now.toISOString());
});
it('directory classes leave the remainder of one shared pass for single-file retention', async () => {
  const f = await fixture(), execution = await f.scratch.create(); f.scratch.abandon(execution.token);
  await populate(execution.sdkDir, 2048);
  await populate(path.join(f.store, 'tmp/daemon/diag-abc123'), 2048);
  await populate(path.join(f.home, '.byok/runs/run-large'), 2048);
  const results = path.join(f.home, '.byok/results'); await fs.mkdir(results, { recursive: true });
  const result = path.join(results, `result-${'a'.repeat(64)}.json`); await fs.writeFile(result, 'x'); await fs.utimes(result, old, old);
  const b = budget();
  for (const id of ['exec-sdk', 'daemon-temp', 'reader-run', 'agent-result'] satisfies ExpiringClassId[]) await f.registry.sweep(id, b.value);
  expect(b.tally.inspections).toBeLessThan(8192);
  expect(await fs.lstat(result).then(() => true, () => false)).toBe(false);
  expect(runtimeReclaimedBytes.get(b.value)).toBeGreaterThan(0);
});
it('reads complete reference authority beyond the deletion share before collecting an unreferenced run', async () => {
  const f = await fixture();
  const unreferenced = path.join(f.home, '.byok/runs/unreferenced');
  const referenced = path.join(f.home, '.byok/runs/referenced');
  await populate(unreferenced, 2048); await populate(referenced, 1);
  const handoffs = new AgentSessionHandoffStore();
  // Real ledgers through the production writer, including a recent reader reference.
  for (let index = 0; index < 1025; index++) {
    await handoffs.record({ agentRef: { agentId: 'agent', profileRevision: '1' },
      taskId: `writer-${index}`, sessionRef: `session-${index}`, runtimeId: 'test',
      cwd: f.home, leaseId: `lease-${index}` });
  }
  await handoffs.record({ agentRef: { agentId: 'agent', profileRevision: '1' },
    taskId: 'referenced', sessionRef: 'reader-session', runtimeId: 'test', home: f.home,
    cwd: referenced, homeAccess: 'memory-reader', leaseId: 'reader-lease' });
  expect((await fs.readdir(path.join(f.home, '.byok/runtime-sessions'))).length).toBe(1026);
  let progressed = false;
  for (let pass = 0; pass < 6 && !progressed; pass++) {
    const b = budget(); await f.registry.sweep('reader-run', b.value);
    progressed = await count(unreferenced) < 2048;
    expect(await count(referenced)).toBe(1);
    expect(b.tally.inspections).toBeLessThanOrEqual(8192);
  }
  expect(progressed).toBe(true);
}, 60_000);

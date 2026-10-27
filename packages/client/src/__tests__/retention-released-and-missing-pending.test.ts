import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveStorageConfig } from '../daemon/retention/config';
import { createRetentionRegistry } from '../daemon/retention/producers';
import type { SweepBudget } from '../daemon/retention/registry';
import { ScratchRoot } from '../daemon/retention/scratch';
import { testScratchRoot } from './fixtures/execution-scratch';

const now = new Date('2026-10-28T00:00:00Z');
const old = new Date('2026-09-01T00:00:00Z');
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function fixture() {
  const store = testScratchRoot();
  const config = resolveStorageConfig(store, { scratchRoot: testScratchRoot() });
  async function open() {
    const scratch = new ScratchRoot(config.scratchRoot, () => now);
    await scratch.open(store);
    const registry = createRetentionRegistry({
      storeDir: store, config, scratch, clock: () => now,
      journal: () => undefined, identity: () => undefined, preparation: () => undefined,
    });
    disposers.push(() => registry.close());
    return { scratch, registry };
  }
  return { store, config, open };
}

// Same pass budget as retention-oversized-classes; production applies class shares.
function budget(trigger: SweepBudget['trigger'] = 'periodic') {
  const tally = { inspections: 0, deleted: 0, truncated: false };
  const value: SweepBudget = {
    trigger, now, available: () => ++tally.inspections <= 8192,
    remaining: () => 256 - tally.deleted,
    removed: () => { tally.deleted++; },
    truncate: () => { tally.truncated = true; },
  };
  return { value, tally };
}

async function populate(directory: string, count: number) {
  await fs.mkdir(directory, { recursive: true });
  for (let start = 0; start < count; start += 128) {
    await Promise.all(Array.from({ length: Math.min(128, count - start) }, (_, offset) =>
      fs.writeFile(path.join(directory, `f${start + offset}`), 'x')));
  }
  await fs.utimes(directory, old, old);
}

it('P1: startup succeeds across restarts with 1024 normally released executions and no SDK secrets', async () => {
  const f = await fixture();
  const initial = await f.open();
  for (let index = 0; index < 1024; index++) {
    const execution = await initial.scratch.create();
    await execution.release();
    expect(initial.scratch.isLive(execution.token)).toBe(false);
    await expect(fs.lstat(execution.sdkDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(path.dirname(execution.sdkDir), 'released'), 'utf8')).toBe(now.toISOString());
  }
  await initial.registry.close();
  const execRoot = path.join(f.config.scratchRoot, 'exec');
  expect(await fs.readdir(execRoot)).toHaveLength(1024);

  const outcomes: unknown[] = [];
  for (let restart = 0; restart < 3; restart++) {
    // Reopen both owners: no in-memory cursor from a previous startup can help.
    const { registry } = await f.open();
    outcomes.push(await registry.sweep('exec-sdk', budget('startup').value).catch(error => error));
    await registry.close();
  }
  expect(outcomes).toEqual([undefined, undefined, undefined]);
  // Startup must not erase fresh runtime history merely to finish its SDK scan.
  expect(await fs.readdir(execRoot)).toHaveLength(1024);
}, 60_000);

it('P2: a missing pending daemon directory does not block reclaiming the next expired directory', async () => {
  const f = await fixture();
  const { registry } = await f.open();
  const pending = path.join(f.store, 'tmp/daemon/diag-abc123');
  await populate(pending, 2048);
  const first = budget();
  await registry.sweep('daemon-temp', first.value);
  const remaining = await fs.readdir(pending);
  expect(remaining.length).toBeGreaterThan(0);
  expect(remaining.length).toBeLessThan(2048);
  expect(first.tally.truncated).toBe(true);
  expect(first.tally.inspections).toBeLessThanOrEqual(1024);

  // A real removal between passes, while this registry retains its pending cursor.
  await fs.rm(pending, { recursive: true });
  await expect(fs.lstat(pending)).rejects.toMatchObject({ code: 'ENOENT' });
  const next = path.join(f.store, 'tmp/daemon/diag-def456');
  await populate(next, 1);
  const outcomes: unknown[] = [];
  let deleted = 0;
  // Allow the existing root cursor to reach EOF and reopen for the new directory.
  for (let pass = 0; pass < 3; pass++) {
    const b = budget();
    outcomes.push(await registry.sweep('daemon-temp', b.value).catch(error => error));
    deleted += b.tally.deleted;
    expect(b.tally.inspections).toBeLessThanOrEqual(1024);
  }
  expect(outcomes).toEqual([undefined, undefined, undefined]);
  await expect(fs.lstat(next)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(deleted).toBe(1);
}, 60_000);

it('startup still fails closed when a released marker coexists with unfinished SDK cleanup', async () => {
  const f = await fixture();
  const { scratch, registry } = await f.open();
  const execution = await scratch.create();
  await execution.release();
  // A marker alone must not authorize skipping inspection of the SDK subtree.
  await populate(execution.sdkDir, 2048);
  const b = budget('startup');
  await expect(registry.sweep('exec-sdk', b.value)).rejects.toThrow('retention_startup_incomplete');
  const remaining = await fs.readdir(execution.sdkDir);
  expect(remaining.length).toBeGreaterThan(0);
  expect(remaining.length).toBeLessThan(2048);
  expect(b.tally.inspections).toBeLessThanOrEqual(1024);
  expect(b.tally.truncated).toBe(true);
});

it('a replaced pending daemon directory still fails identity validation and is not reclaimed', async () => {
  const f = await fixture();
  const { registry } = await f.open();
  const target = path.join(f.store, 'tmp/daemon/diag-abc123');
  await populate(target, 2048);
  await registry.sweep('daemon-temp', budget().value);
  expect((await fs.readdir(target)).length).toBeGreaterThan(0);
  expect((await fs.readdir(target)).length).toBeLessThan(2048);
  // Keep the original inode alive so this is a deterministic identity replacement.
  await fs.rename(target, path.join(f.store, 'displaced-pending'));
  await populate(target, 1);
  for (let pass = 0; pass < 2; pass++) {
    await expect(registry.sweep('daemon-temp', budget().value)).rejects.toThrow('retention_runtime_identity_changed');
    expect(await fs.readFile(path.join(target, 'f0'), 'utf8')).toBe('x');
  }
});

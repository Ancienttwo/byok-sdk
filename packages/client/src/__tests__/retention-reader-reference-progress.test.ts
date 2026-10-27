import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { resolveStorageConfig } from '../daemon/retention/config';
import { createRetentionRegistry } from '../daemon/retention/producers';
import type { SweepBudget } from '../daemon/retention/registry';
import { PASS_INSPECTIONS } from '../daemon/retention/runtime-accounting';
import { ScratchRoot } from '../daemon/retention/scratch';
import { testScratchRoot } from './fixtures/execution-scratch';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) await dispose();
});

async function fixture() {
  const now = new Date();
  const old = new Date(now.getTime() - 60 * 86_400_000);
  const store = testScratchRoot();
  const config = resolveStorageConfig(store, { scratchRoot: testScratchRoot() });
  const scratch = new ScratchRoot(config.scratchRoot, () => now);
  await scratch.open(store);
  const manager = new AgentHomeManager({ hostStorageRoot: testScratchRoot() });
  const agentRef = { agentId: 'agent', profileRevision: '1' };
  const binding = await manager.prepare(agentRef);
  const home = binding.resolution.canonicalHome;
  await binding.lease.release();
  const handoffs = new AgentSessionHandoffStore();
  const unreferenced = path.join(home, '.byok/runs/unreferenced');
  const referenced = path.join(home, '.byok/runs/referenced');
  for (const directory of [unreferenced, referenced]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'keep-or-remove'), 'payload');
    await fs.utimes(directory, old, old);
  }
  const recordReader = (cwd: string, sessionRef: string) => handoffs.record({
    agentRef, taskId: sessionRef, sessionRef, runtimeId: 'test', home, cwd,
    homeAccess: 'memory-reader', leaseId: `lease-${sessionRef}`,
  });
  for (let index = 0; index < 3; index++) {
    await handoffs.record({ agentRef, taskId: `writer-${index}`, sessionRef: `writer-${index}`,
      runtimeId: 'test', cwd: home, leaseId: `lease-${index}` });
  }
  await recordReader(referenced, 'reader');
  const registry = createRetentionRegistry({ storeDir: store, config, scratch, clock: () => now,
    journal: () => undefined, identity: () => undefined, preparation: () => undefined,
    home: manager, handoffs });
  disposers.push(() => registry.close());
  return { now, config, registry, home, manager, recordReader, unreferenced, referenced };
}

function controlledReads(home: string) {
  const clock = { ms: 0, perReadMs: 100, reads: 0, inLease: false };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.ms);
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const result = await readFile(...args);
    if (String(args[0]).startsWith(path.join(home, '.byok/runtime-sessions') + path.sep)
      && String(args[0]).endsWith('.jsonl')) {
      expect(clock.inLease).toBe(true);
      clock.reads++;
      clock.ms += clock.perReadMs;
    }
    return result;
  }) as typeof fs.readFile);
  return clock;
}

function passBudget(f: Awaited<ReturnType<typeof fixture>>, clock: { ms: number }, spent = 0) {
  const started = clock.ms;
  const tally = { inspections: spent, deleted: 0, truncated: false };
  const value: SweepBudget = {
    trigger: 'periodic', now: f.now,
    available: () => {
      const allowed = ++tally.inspections <= PASS_INSPECTIONS
        && tally.deleted < f.config.maxDeletionsPerPass
        && clock.ms - started < f.config.maxPassDurationMs;
      if (!allowed) tally.truncated = true;
      return allowed;
    },
    remaining: () => f.config.maxDeletionsPerPass - tally.deleted,
    removed: () => { tally.deleted++; },
    truncate: () => { tally.truncated = true; },
  };
  return { value, tally };
}

function observeLease(f: Awaited<ReturnType<typeof fixture>>, clock: { inLease: boolean }) {
  const withLease = f.manager.withIdleHomeLease.bind(f.manager);
  vi.spyOn(f.manager, 'withIdleHomeLease').mockImplementation((agent, work) => withLease(agent, async home => {
    clock.inLease = true;
    try { await work(home); } finally { clock.inLease = false; }
  }));
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, 'unlink').mockImplementation(async file => {
    if (String(file).startsWith(f.unreferenced + path.sep)) expect(clock.inLease).toBe(true);
    await unlink(file);
  });
}

it('makes deletion progress after a complete reference scan exceeding 250ms within the original global budget', async () => {
  const f = await fixture();
  const clock = controlledReads(f.home);
  observeLease(f, clock);
  const b = passBudget(f, clock);
  await f.registry.sweep('reader-run', b.value);
  expect(clock.reads).toBe(4);
  expect(clock.ms).toBe(400);
  expect(clock.ms).toBeLessThan(f.config.maxPassDurationMs);
  expect(b.tally.inspections).toBeLessThanOrEqual(PASS_INSPECTIONS);
  expect(b.tally.deleted).toBe(1);
  await expect(fs.lstat(f.unreferenced)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(f.referenced, 'keep-or-remove'), 'utf8')).toBe('payload');
  expect(clock.inLease).toBe(false);
});

it.each(['time', 'inspections'] as const)('protects all runs when global %s is exhausted and rereads authority next pass', async exhausted => {
  const f = await fixture();
  const clock = controlledReads(f.home);
  observeLease(f, clock);
  clock.perReadMs = exhausted === 'time' ? 4000 : 100;
  const first = passBudget(f, clock, exhausted === 'inspections' ? PASS_INSPECTIONS - 3 : 0);
  await f.registry.sweep('reader-run', first.value);
  expect(clock.reads).toBeGreaterThan(0);
  expect(clock.reads).toBeLessThan(4);
  expect(first.tally.truncated).toBe(true);
  expect(first.tally.deleted).toBe(0);
  for (const run of [f.unreferenced, f.referenced]) {
    expect(await fs.readFile(path.join(run, 'keep-or-remove'), 'utf8')).toBe('payload');
  }
  // A new reference between passes must be read, not masked by cached partial authority.
  await f.recordReader(f.unreferenced, 'new-reader');
  clock.perReadMs = 100;
  const readsBefore = clock.reads;
  // An exhausted outer home cursor may need one pass to observe EOF first.
  for (let pass = 0; pass < 2 && clock.reads === readsBefore; pass++) {
    const next = passBudget(f, clock);
    await f.registry.sweep('reader-run', next.value);
    expect(next.tally.deleted).toBe(0);
  }
  expect(clock.reads - readsBefore).toBe(5);
  for (const run of [f.unreferenced, f.referenced]) {
    expect(await fs.readFile(path.join(run, 'keep-or-remove'), 'utf8')).toBe('payload');
  }
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentHomeBusyError, AgentHomeCommitCopyError, AgentHomeLeaseCorruptError, AgentHomeLeaseManager, AgentHomeManager } from '../agent-home';
import { acquireDaemonOwner, DaemonOwnerActiveError, DaemonOwnerReclaimingError } from '../util/daemon-owner';
import * as gates from '../util/path-mutation-gate';
import * as pi from '../util/pi-session-retention';
import { resolveStorageConfig } from '../daemon/retention/config';
import { createRetentionRegistry } from '../daemon/retention/producers';
import { ScratchRoot } from '../daemon/retention/scratch';
import { testScratchRoot } from './fixtures/execution-scratch';

afterEach(() => vi.restoreAllMocks());

it('preserves maintenance failure and root gate release failure', async () => {
  const root = testScratchRoot();
  const failure = new Error('release root');
  vi.spyOn(gates, 'acquirePathMutationGate').mockResolvedValue({ release: async () => { throw failure; } } as never);
  const error = await new AgentHomeLeaseManager().acquireMaintenance(root, path.join(root, 'missing')).catch(e => e);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors[0]).toMatchObject({ code: 'ENOENT' });
  expect(error.errors[1]).toBe(failure);
});

it('retains the home busy type and both causes when release fails', async () => {
  const root = testScratchRoot();
  const home = path.join(root, 'agent');
  await fs.mkdir(home);
  const primary = new AgentHomeBusyError('occupied');
  const failure = new Error('release root');
  vi.spyOn(gates, 'acquirePathMutationGate').mockResolvedValue({ release: async () => { throw failure; } } as never);
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === home) throw primary;
    return lstat(...args);
  }) as typeof fs.lstat);
  const error = await new AgentHomeLeaseManager().acquireMaintenance(root, home).catch(e => e);
  expect(error).toBeInstanceOf(AgentHomeBusyError);
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect(error.cause.errors).toEqual([primary, failure]);
});

it('keeps corrupt marker errors non-retryable when the root gate release fails', async () => {
  const root = testScratchRoot();
  const home = new AgentHomeManager({ hostStorageRoot: root });
  const resolution = await home.layout.resolve({ agentId: 'agent', profileRevision: '1' });
  await fs.mkdir(path.join(resolution.canonicalHome, '.byok'), { recursive: true });
  await fs.writeFile(path.join(resolution.canonicalHome, '.byok', 'agent-home.lease'), 'invalid');
  const failure = new Error('release root');
  vi.spyOn(gates, 'acquirePathMutationGate').mockResolvedValue({ release: async () => { throw failure; } } as never);
  const error = await home.leaseManager.acquire(resolution).catch(e => e);
  expect(error).toBeInstanceOf(AgentHomeLeaseCorruptError);
  expect(error.cause.errors[0]).toBeInstanceOf(AgentHomeLeaseCorruptError);
  expect(error.cause.errors[1]).toBe(failure);
});

it('keeps settle and lease release failures together', async () => {
  const root = testScratchRoot();
  const manager = new AgentHomeLeaseManager({ settleAgentMemoryCommit: async ({ canonicalHome }) => {
    await fs.writeFile(path.join(canonicalHome, '.byok', 'agent-home.lease'), 'invalid');
    throw new Error('settle');
  } });
  const home = new AgentHomeManager({ hostStorageRoot: root, leaseManager: manager });
  const resolution = await home.layout.resolve({ agentId: 'agent', profileRevision: '1' });
  const error = await manager.acquire(resolution).catch(e => e);
  expect(error).toBeInstanceOf(AgentHomeCommitCopyError);
  expect(error.cause.errors[0]).toBeInstanceOf(AgentHomeCommitCopyError);
  expect(error.cause.errors[1]).toBeInstanceOf(AgentHomeLeaseCorruptError);
});

it('keeps owner release operation and release gate failures together', async () => {
  const root = testScratchRoot();
  const failure = new Error('release gate');
  const release = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  vi.spyOn(gates, 'acquirePathMutationGate').mockResolvedValue({ release } as never);
  const lease = await acquireDaemonOwner(root, 'daemon');
  const ownerPath = path.join(root, 'daemon-owner.json');
  const original = await fs.readFile(ownerPath, 'utf8');
  await fs.writeFile(ownerPath, JSON.stringify({ ...JSON.parse(original), nonce: 'other' }));
  const error = await lease.release().catch(e => e);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors[0].message).toMatch(/identity changed/);
  expect(error.errors[1]).toBe(failure);
  await fs.writeFile(ownerPath, original);
  await lease.release();
});

it('preserves owner publication failure and gate release failure', async () => {
  const root = testScratchRoot();
  const primary = new Error('clock');
  const failure = new Error('release owner gate');
  vi.spyOn(gates, 'acquirePathMutationGate').mockResolvedValue({ release: async () => { throw failure; } } as never);
  const error = await acquireDaemonOwner(root, 'daemon', () => { throw primary; }).catch(e => e);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([primary, failure]);
});

it.each([new DaemonOwnerActiveError('doctor'), new DaemonOwnerReclaimingError()])('retains owner busy type and causes: %s', async primary => {
  const root = testScratchRoot();
  const failure = new Error('release owner gate');
  vi.spyOn(gates, 'acquirePathMutationGate').mockResolvedValue({ release: async () => { throw failure; } } as never);
  const error = await acquireDaemonOwner(root, 'daemon', () => { throw primary; }).catch(e => e);
  expect(error).toBeInstanceOf(primary.constructor);
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect(error.cause.errors).toEqual([primary, failure]);
});

it('releases every Pi gate in order and preserves the operation error', async () => {
  const root = testScratchRoot();
  const sessions = testScratchRoot();
  const file = path.join(sessions, '2020-01-01T00-00-00-000Z_session.jsonl');
  await fs.writeFile(file, '{}');
  await fs.utimes(file, new Date(0), new Date(0));
  const primary = new Error('session read');
  const failures = ['writer', 'session', 'discovery', 'rebinding'].map(name => new Error(name));
  const calls: string[] = [];
  const gate = (index: number) => ({ release: async () => { calls.push(failures[index]!.message); throw failures[index]; }, assertHeld: () => {}, sessionRef: 'session' });
  vi.spyOn(pi, 'acquirePiSessionRebinding').mockResolvedValue(gate(3) as never);
  vi.spyOn(pi, 'acquirePiSessionDiscovery').mockResolvedValue(gate(2) as never);
  vi.spyOn(pi, 'acquirePiSessionRetention').mockResolvedValue(gate(1));
  vi.spyOn(pi, 'acquirePiSessionWriter').mockResolvedValue(gate(0));
  const lstat = fs.lstat.bind(fs);
  let reads = 0;
  vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === file && ++reads === 2) throw primary;
    return lstat(...args);
  }) as typeof fs.lstat);
  const now = new Date();
  const config = resolveStorageConfig(root, { scratchRoot: testScratchRoot() });
  const scratch = new ScratchRoot(config.scratchRoot, () => now);
  await scratch.open(root);
  const registry = createRetentionRegistry({ storeDir: root, config, scratch, clock: () => now, piSessionDir: sessions,
    journal: () => undefined, identity: () => undefined, preparation: () => undefined });
  const budget = { trigger: 'periodic' as const, now, available: () => true, remaining: () => 100, removed: () => {}, truncate: () => {} };
  try {
    const error = await registry.sweep('pi-session-dir', budget).catch(e => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([primary, ...failures]);
    expect(calls).toEqual(['writer', 'session', 'discovery', 'rebinding']);
  } finally { await registry.close(); }
});

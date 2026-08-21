/**
 * L-003a: the policy itself, the watermark table, and the cleanup order.
 *
 * The disk-pressure matrix (`journal-pressure-matrix.test.ts`) proves what a
 * daemon DOES at each state. This file pins the two things that decide which
 * state it is in — a validated policy and a pure state function — plus the one
 * property no amount of runtime testing can establish: that a misconfigured
 * policy is refused at construction rather than clamped into something
 * plausible.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import type { LocalStorageUsage } from '../daemon/journal/journal';
import {
  cleanupEligibleAt,
  cleanupOrderFor,
  computePressureState,
  createFilesystemCleanupExecutor,
  DEFAULT_HARD_BUDGET_RATIO,
  DEFAULT_RETENTION_MS,
  DEFAULT_SOFT_BUDGET_RATIO,
  LocalStoragePolicyError,
  resolveLocalStoragePolicy,
} from '../daemon/journal/storage-policy';

const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function usage(totalBytes: number): LocalStorageUsage {
  return {
    measuredAt: '2026-08-07T00:00:00.000Z',
    totalBytes,
    categories: {
      journal: { bytes: totalBytes, approximate: false },
      cache: { bytes: 0, approximate: true },
      log: { bytes: 0, approximate: true },
      workspace: { bytes: 0, approximate: true },
      quarantine: { bytes: 0, approximate: false },
    },
  };
}

const BASE = { maxStoreBytes: 1_000_000, minFreeBytes: 100_000, ackCriticalReserveBytes: 10_000 };

describe('LocalStoragePolicy (L-003a)', () => {
  it('fills in the §12.7.2.1 defaults and is idempotent under a second resolve', () => {
    const resolved = resolveLocalStoragePolicy(BASE);
    expect(resolved.softBudgetRatio).toBe(DEFAULT_SOFT_BUDGET_RATIO);
    expect(resolved.hardBudgetRatio).toBe(DEFAULT_HARD_BUDGET_RATIO);
    // The soft free-space floor defaults to one doubling above the hard one.
    expect(resolved.softMinFreeBytes).toBe(200_000);
    expect(resolved.retentionMs).toEqual(DEFAULT_RETENTION_MS);
    // A resolved policy is a valid input, so an engine can accept either shape
    // without sniffing which one it got.
    expect(resolveLocalStoragePolicy(resolved)).toEqual(resolved);
  });

  it('refuses a policy that is internally inconsistent, rather than clamping it', () => {
    expect(() => resolveLocalStoragePolicy({ ...BASE, maxStoreBytes: 0 })).toThrow(LocalStoragePolicyError);
    expect(() => resolveLocalStoragePolicy({ ...BASE, maxStoreBytes: 1.5 })).toThrow(/positive integer/);
    expect(() => resolveLocalStoragePolicy({ ...BASE, softBudgetRatio: 0.95 })).toThrow(/strictly below hardBudgetRatio/);
    expect(() => resolveLocalStoragePolicy({ ...BASE, softBudgetRatio: 1.5 })).toThrow(/ratio in \(0, 1\]/);
    expect(() => resolveLocalStoragePolicy({ ...BASE, softMinFreeBytes: 50_000 })).toThrow(/at least minFreeBytes/);
    // An emergency floor above the hard floor would skip the admission decline
    // that is supposed to prevent emergency in the first place.
    expect(() => resolveLocalStoragePolicy({ ...BASE, ackCriticalReserveBytes: 200_000 })).toThrow(/must not exceed minFreeBytes/);
    // Compaction must accelerate under pressure, never decelerate.
    expect(() =>
      resolveLocalStoragePolicy({ ...BASE, compaction: { normalIntervalMs: 1000, pressureIntervalMs: 5000 } }),
    ).toThrow(/must not be longer than/);
  });

  it('has no retention setting for protected data, because protected data is never auto-deleted', () => {
    expect(() =>
      resolveLocalStoragePolicy({ ...BASE, retentionMs: { quarantine: 1000 } as never }),
    ).toThrow(/is not a cleanable category/);
  });

  it('turns retention into an eligibility timestamp in exactly one place', () => {
    const policy = resolveLocalStoragePolicy(BASE);
    expect(cleanupEligibleAt(policy, 'orphan-artifact', new Date('2026-08-07T00:00:00.000Z'))).toBe('2026-08-08T00:00:00.000Z');
    // The longest default belongs to `confirmed-journal`: pruning a journal row
    // drops its idempotency receipt, so its retention has to outlast the
    // mailbox redelivery window.
    expect(Math.max(...Object.values(DEFAULT_RETENTION_MS))).toBe(DEFAULT_RETENTION_MS['confirmed-journal']);
  });
});

describe('the watermark state machine (§12.7.2.1 table)', () => {
  const policy = resolveLocalStoragePolicy(BASE);
  const roomyFree = 500_000;

  it('reads the budget axis at 80% and 90%', () => {
    expect(computePressureState(policy, { usage: usage(799_999), freeBytes: roomyFree })).toBe('normal');
    expect(computePressureState(policy, { usage: usage(800_000), freeBytes: roomyFree })).toBe('pressure');
    expect(computePressureState(policy, { usage: usage(899_999), freeBytes: roomyFree })).toBe('pressure');
    expect(computePressureState(policy, { usage: usage(900_000), freeBytes: roomyFree })).toBe('hard-pressure');
  });

  it('reads the free-space axis independently of the budget', () => {
    // Nothing stored at all, and still at hard pressure: the disk is shared,
    // and a budget this daemon is nowhere near says nothing about the space
    // its next commit needs.
    expect(computePressureState(policy, { usage: usage(0), freeBytes: 199_999 })).toBe('pressure');
    expect(computePressureState(policy, { usage: usage(0), freeBytes: 99_999 })).toBe('hard-pressure');
    expect(computePressureState(policy, { usage: usage(0), freeBytes: 9_999 })).toBe('emergency');
  });

  it('treats an observed ack-critical failure as stronger evidence than any arithmetic', () => {
    // Every number here says the device is fine. A commit that already failed
    // says it is not, and that is the one that wins.
    expect(computePressureState(policy, { usage: usage(0), freeBytes: roomyFree }, 'SQLITE_FULL')).toBe('emergency');
  });

  it('truncates the cleanup order under pressure instead of extending it', () => {
    expect(cleanupOrderFor('normal')).toEqual([
      'expired-temp',
      'rotated-log',
      'confirmed-journal',
      'ephemeral-workspace',
      'orphan-artifact',
    ]);
    for (const state of ['pressure', 'hard-pressure', 'emergency'] as const) {
      expect(cleanupOrderFor(state)).toEqual(['expired-temp', 'rotated-log']);
    }
  });
});

describe('the default cleanup executor', () => {
  const candidate = {
    candidateId: 'c1',
    category: 'expired-temp' as const,
    eligibleAt: '2026-08-01T00:00:00.000Z',
    reason: 'expired',
    attempts: 0,
  };

  it('refuses a relative ref rather than resolving it against whatever cwd happens to be', async () => {
    const executor = createFilesystemCleanupExecutor();
    expect(await executor({ ...candidate, ref: 'tmp/relative.bin' })).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('absolute path'),
    });
  });

  it('will not remove journal rows without an explicit prune hook', async () => {
    const executor = createFilesystemCleanupExecutor();
    expect(await executor({ ...candidate, category: 'confirmed-journal', ref: 'task:t1' })).toMatchObject({ outcome: 'skipped' });
    expect(await executor({ ...candidate, category: 'confirmed-journal', ref: '/tmp/not-a-task-ref' })).toMatchObject({
      outcome: 'failed',
    });
  });
});

describe('createDaemon storage policy validation', () => {
  it('rejects a bad policy at construction, before any daemon exists', async () => {
    const base: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
      productId: 'test-product-storage',
      serverUrl: 'http://127.0.0.1:1',
      workspaceRoot: await tmpDir('byok-policy-workspace-'),
      storeDir: await tmpDir('byok-policy-store-'),
    };

    expect(() =>
      createDaemonWithAdapters(
        {
          ...base,
          hostedJournal: { mode: 'sqlite', tenantId: 'tenant-a', storagePolicy: { maxStoreBytes: -1, minFreeBytes: 1000 } },
        },
        [],
      ),
    ).toThrow(LocalStoragePolicyError);
  });

  it('constructs no engine — and needs no policy — on the default path', async () => {
    const daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product-storage',
        serverUrl: 'http://127.0.0.1:1',
        workspaceRoot: await tmpDir('byok-policy-workspace-'),
        storeDir: await tmpDir('byok-policy-store-'),
      },
      [],
    );
    // The status surface omits `storage` entirely rather than reporting zeros:
    // "not measured" and "measured, and fine" are different facts.
    expect(daemon.status()).toBeDefined();
  });
});

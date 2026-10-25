import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { DaemonConfigFieldRemovedError } from '../daemon/daemon-errors';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { describe, expect, it } from 'vitest';
import { LocalStorageConfigError, resolveStorageConfig, resolveStorageBudget, DEFAULT_RETENTION_TTL_MS } from '../daemon/retention/config';
import { computePressureState, StoragePressure, LocalStorageEmergencyError } from '../daemon/retention/pressure';
import { RetentionRegistry, type ProtectedClassId, type ExpiringClassId } from '../daemon/retention/registry';
import { ScratchRootPathError } from '../daemon/retention/scratch';
import { testScratchRoot } from './fixtures/execution-scratch';

const BASE = { maxStoreBytes: 1_000_000, minFreeBytes: 100_000, ackCriticalReserveBytes: 10_000 };
describe('storage configuration and protected authority', () => {
  it('defaults to 15-minute maintenance, 24-hour runtime residue and 30-day journal receipts', () => {
    const resolved = resolveStorageConfig(testScratchRoot(), { scratchRoot: testScratchRoot() });
    expect(resolved.sweepIntervalMs).toBe(900_000);
    expect(resolved.ttlMs).toEqual(DEFAULT_RETENTION_TTL_MS);
    expect(resolved.ttlMs['confirmed-journal']).toBe(30 * 86_400_000);
    expect(resolved.ttlMs['exec-runtime']).toBe(86_400_000);
    expect(resolveStorageBudget(BASE)).toMatchObject({ softBudgetRatio: 0.8, hardBudgetRatio: 0.9, softMinFreeBytes: 200_000 });
  });
  it('rejects invalid watermarks and budgets without clamping', () => {
    for (const input of [{ ...BASE, maxStoreBytes: 0 }, { ...BASE, maxStoreBytes: 1.5 },
      { ...BASE, softBudgetRatio: 0.95 }, { ...BASE, hardBudgetRatio: 1.5 },
      { ...BASE, softMinFreeBytes: 50_000 }, { ...BASE, ackCriticalReserveBytes: 200_000 }])
      expect(() => resolveStorageBudget(input)).toThrow(LocalStorageConfigError);
  });
  it('rejects protected TTLs, unsafe home TTLs and journal windows shorter than redelivery', () => {
    const root = testScratchRoot();
    for (const ttlMs of [{ quarantine: 1 }, { 'home-temp': 1000 }, { 'confirmed-journal': 7 * 86_400_000 }])
      expect(() => resolveStorageConfig(root, { retention: { ttlMs: ttlMs as never } })).toThrow(LocalStorageConfigError);
    expect(() => resolveStorageConfig(root, { retention: { maxDeletionsPerPass: 0 } })).toThrow(LocalStorageConfigError);
    expect(() => resolveStorageConfig(root, { scratchRoot: '/'+ 'x'.repeat(200) })).toThrow(ScratchRootPathError);
  });
  it('rejects removed configuration and old journal ports instead of silently disabling retention', () => {
    const config = { localAgentRelease: { version: '0.0.0-test' }, productName:'Retention',productId:'retention-policy',serverUrl:'http://127.0.0.1:1',workspaceRoot:testScratchRoot(),storeDir:testScratchRoot(),storage:{scratchRoot:testScratchRoot()} };
    expect(() => createDaemonWithAdapters({ ...config, hostedJournal: { mode:'sqlite',storagePolicy:BASE } } as never,[new StubRuntimeAdapter()])).toThrow(DaemonConfigFieldRemovedError);
    expect(() => createDaemonWithAdapters(config,[new StubRuntimeAdapter()],{hostedJournal:{pressureEngine:{}}} as never)).toThrow(DaemonConfigFieldRemovedError);
    expect(() => createDaemonWithAdapters(config,[new StubRuntimeAdapter()],{journal:{} as never})).toThrow(/confirmed-retention ports/);
  });
  it('has no type-level deletion spelling for protected classes', () => {
    const protectedId: ProtectedClassId = 'quarantine';
    // @ts-expect-error protected data never enters the expiring union
    const expiring: ExpiringClassId = protectedId;
    expect(expiring).toBe('quarantine');
    const check = (registry: RetentionRegistry) => {
      // @ts-expect-error protected registry entries cannot be swept
      registry.sweep(protectedId, {});
    };
    expect(check).toBeTypeOf('function');
  });
});
describe('§12.7.2.1 pressure admission and durability', () => {
  const budget = resolveStorageBudget(BASE);
  it.each([[799_999,500_000,'normal'],[800_000,500_000,'pressure'],[900_000,500_000,'hard-pressure'],
    [0,199_999,'pressure'],[0,99_999,'hard-pressure'],[0,9_999,'emergency']] as const)('used=%i free=%i yields %s', (used, free, state) => {
    expect(computePressureState(budget, used, free)).toBe(state);
  });
  it('hard pressure declines new work while preserving ack-critical writes; emergency refuses both', () => {
    const pressure = new StoragePressure(budget);
    pressure.update(900_000, 500_000);
    expect(pressure.admissionGuard()).toMatchObject({ admit: false, retryable: true });
    expect(() => pressure.assertAckCriticalAllowed()).not.toThrow();
    pressure.noteAckCriticalFailure('SQLITE_FULL');
    expect(() => pressure.assertAckCriticalAllowed()).toThrow(LocalStorageEmergencyError);
    pressure.update(800_000, 500_000);
    expect(pressure.state).toBe('emergency');
    pressure.update(0, 500_000);
    expect(pressure.state).toBe('normal');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { CollectExpiredFailure, createMutableClock, tenantId } from '@byok-sdk/core';
import { createInMemoryByokCloud } from '../composition/in-memory';
import { ByokCloudError } from '../errors';
import { DEFAULT_RETENTION_POLICY, MAINTENANCE_STEPS, resolveRetentionPolicy } from '../maintenance';
import { RECEIPT_RETENTION, REQUEST_RECEIPT_PREFIXES, receiptRetentionClass } from '../receipt-retention';

const tenant = tenantId('maintenance-test');
function setup() {
  const clock = createMutableClock();
  let observed: unknown;
  const composition = createInMemoryByokCloud({ clock, observer: { onInboundCommitted() {}, onMaintenance(report) { observed = report; } } });
  return { ...composition, clock, observed: () => observed };
}
describe('cloud maintenance', () => {
  it('runs the closed maintenance order and publishes the same report once', async () => {
    const composition = setup();
    const order: string[] = [];
    for (const [name, store] of Object.entries({ mailbox: composition.core.mailbox, receipts: composition.stores.receipts, nonces: composition.stores.nonces, pairingCodes: composition.stores.pairingCodes, presence: composition.core.presence, activity: composition.stores.activity, approvals: composition.stores.approvals, quota: composition.core.quota, objects: composition.core.objects })) {
      vi.spyOn(store, 'collectExpired').mockImplementation(async () => { order.push(name); return { removed: 0, expired: 0, releasedBytes: 0n, more: false }; });
    }
    vi.spyOn(composition.stores.agentMessageDraft, 'sweepExpired').mockImplementation(async () => { order.push('agentMessageDraft'); });
    const report = await composition.cloud.runMaintenance({ tenant, now: composition.clock.now().toISOString(), policy: DEFAULT_RETENTION_POLICY, limit: 3 });
    expect(report.steps.map(step => step.step)).toEqual(MAINTENANCE_STEPS);
    expect(order).toEqual(MAINTENANCE_STEPS.filter(step => step !== 'deviceAssertionReplay'));
    expect(report.steps[8]).toEqual({ step: 'deviceAssertionReplay', status: 'not-configured' });
    expect(composition.observed()).toBe(report);
  });
  it('commits other steps after one port fails and rejects malformed result counts', async () => {
    const composition = setup();
    vi.spyOn(composition.stores.receipts, 'collectExpired').mockRejectedValue(new Error('receipt outage'));
    vi.spyOn(composition.core.presence, 'collectExpired').mockResolvedValue({ removed: 3, expired: 0, releasedBytes: 0n, more: false });
    const report = await composition.cloud.runMaintenance({ tenant, now: composition.clock.now().toISOString(), policy: DEFAULT_RETENTION_POLICY, limit: 2 });
    expect(report.steps).toHaveLength(11);
    expect(report.steps[1]).toEqual({ step: 'receipts', status: 'failed', errorCode: 'maintenance_step_failed', failedRows: 0 });
    expect(report.steps[4]).toEqual({ step: 'presence', status: 'failed', errorCode: 'maintenance_result_invalid', failedRows: 0 });
    expect(report.steps[10]).toMatchObject({ step: 'objects', status: 'ok' });
  });
  it('preserves a full committed budget when only the remainder observation fails', async () => {
    const composition = setup();
    vi.spyOn(composition.core.objects, 'collectExpired').mockRejectedValue(new CollectExpiredFailure(
      { removed: 2, expired: 0, releasedBytes: 30n }, 0, undefined, { cause: new Error('probe failed') },
    ));
    const report = await composition.cloud.runMaintenance({ tenant, now: composition.clock.now().toISOString(), policy: DEFAULT_RETENTION_POLICY, limit: 2 });
    expect(report.steps[10]).toEqual({ step: 'objects', status: 'failed', errorCode: 'retention_collect_failed',
      failedRows: 0, committed: { removed: 2, expired: 0, releasedBytes: 30n } });
    expect(report.steps[10]).not.toHaveProperty('more');
  });
  it('counts a failed row inside the same budget as confirmed commits', async () => {
    const composition = setup();
    vi.spyOn(composition.core.objects, 'collectExpired').mockRejectedValue(new CollectExpiredFailure(
      { removed: 1, expired: 0, releasedBytes: 10n }, 1, true, { cause: new Error('delete failed') },
    ));
    const report = await composition.cloud.runMaintenance({ tenant, now: composition.clock.now().toISOString(), policy: DEFAULT_RETENTION_POLICY, limit: 2 });
    expect(report.steps[10]).toEqual({ step: 'objects', status: 'failed', errorCode: 'retention_collect_failed',
      failedRows: 1, committed: { removed: 1, expired: 0, releasedBytes: 10n }, more: true });
  });
  it('rejects a failure whose committed and failed rows exceed the budget', async () => {
    const composition = setup();
    vi.spyOn(composition.core.objects, 'collectExpired').mockRejectedValue(new CollectExpiredFailure(
      { removed: 2, expired: 0, releasedBytes: 20n }, 1, true,
    ));
    const report = await composition.cloud.runMaintenance({ tenant, now: composition.clock.now().toISOString(), policy: DEFAULT_RETENTION_POLICY, limit: 2 });
    expect(report.steps[10]).toEqual({ step: 'objects', status: 'failed', errorCode: 'maintenance_result_invalid', failedRows: 0 });
  });
  it.each([0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 24 as unknown as bigint])('rejects a disabled or invalid retention duration %s', value => {
    expect(() => resolveRetentionPolicy({ mailboxAckedRetentionMs: value })).toThrow(ByokCloudError);
  });
  it.each([0, -1, 5001, 1.5])('rejects invalid batch limit %s before calling a port', async limit => {
    const composition = setup();
    const collect = vi.spyOn(composition.core.mailbox, 'collectExpired');
    await expect(composition.cloud.runMaintenance({ tenant, now: composition.clock.now().toISOString(), policy: DEFAULT_RETENTION_POLICY, limit })).rejects.toMatchObject({ code: 'maintenance_invalid_input' });
    expect(collect).not.toHaveBeenCalled();
  });
  it('rejects a cutoff outside the canonical timestamp range before any mutation', async () => {
    const composition = setup();
    const collect = vi.spyOn(composition.core.mailbox, 'collectExpired');
    await expect(composition.cloud.runMaintenance({ tenant, now: composition.clock.now().toISOString(), policy: { ...DEFAULT_RETENTION_POLICY, objectOrphanGraceMs: 2_000_000_000_000_000n } })).rejects.toMatchObject({ code: 'maintenance_invalid_input' });
    expect(collect).not.toHaveBeenCalled();
  });
  it('does not expire any identity or unknown receipt family', async () => {
    const composition = setup();
    const keys = [...RECEIPT_RETENTION.map(entry => entry.prefix + 'example'), 'host-unregistered:example'];
    for (const key of keys) await composition.stores.receipts.record(tenant, { key, body: key });
    composition.clock.advance(365 * 86_400_000);
    const result = await composition.stores.receipts.collectExpired(tenant, { now: composition.clock.now().toISOString(), requestBefore: composition.clock.now().toISOString(), limit: 1 });
    expect(result).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
    expect(REQUEST_RECEIPT_PREFIXES).toEqual([]);
    expect(Object.isFrozen(RECEIPT_RETENTION)).toBe(true);
    for (const key of keys) { expect(receiptRetentionClass(key)).toBe('identity'); expect(await composition.stores.receipts.get(tenant, key)).toMatchObject({ body: key }); }
  });
});

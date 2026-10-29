import { describe, expect, it, vi } from 'vitest';
import type { ByokPool } from '../pool';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { PostgresRetentionPolicyStore, type TenantRetentionPolicyInput } from '../runtime';

const tenant = tenantId('maintenance-policy');
const input: TenantRetentionPolicyInput = {
  policyId: 'tenant-policy', mailboxAckedRetentionMs: 1n, mailboxUnackedRetentionMs: 2n,
  mailboxDeadLetterRetentionMs: 5n, requestReceiptRetentionMs: 3n, objectOrphanGraceMs: 4n, terminalTaskArchiveMs: 7n,
};
const row = {
  tenant_id: tenant, policy_id: input.policyId, mailbox_acked_retention_ms: 1n,
  mailbox_unacked_retention_ms: 2n, mailbox_dead_letter_retention_ms: 5n, request_receipt_retention_ms: 3n,
  object_orphan_grace_ms: 4n, terminal_task_archive_ms: 7n, updated_at: '2026-10-14T00:00:00.000Z',
};

describe('Worker retention policy authority', () => {
  it('fails closed when the entitlement has no matching policy', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresRetentionPolicyStore({ query } as unknown as ByokPool, createMutableClock());
    await expect(store.readRetentionPolicy(tenant)).rejects.toMatchObject({ code: 'cleanup_policy_missing' });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('JOIN tenant_retention_policy'), [tenant]);
  });
  it('reads the six authoritative durations without defaults', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const store = new PostgresRetentionPolicyStore({ query } as unknown as ByokPool, createMutableClock());
    expect(await store.readRetentionPolicy(tenant)).toEqual({ ...input, tenantId: tenant, updatedAt: row.updated_at });
  });
  it.each([undefined, 0n, -1n, 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n])('rejects incomplete or invalid writes before SQL: %s', duration => {
    const query = vi.fn();
    const store = new PostgresRetentionPolicyStore({ query } as unknown as ByokPool, createMutableClock());
    return expect(store.writeRetentionPolicy(tenant, { ...input, objectOrphanGraceMs: duration } as TenantRetentionPolicyInput))
      .rejects.toMatchObject({ code: 'cleanup_invalid_input' }).then(() => { expect(query).not.toHaveBeenCalled(); });
  });
  it('rejects a terminal-task archive window shorter than the unacked plus dead-letter windows (#1120)', async () => {
    const query = vi.fn();
    const store = new PostgresRetentionPolicyStore({ query } as unknown as ByokPool, createMutableClock());
    await expect(store.writeRetentionPolicy(tenant, { ...input, terminalTaskArchiveMs: 6n })).rejects.toMatchObject({ code: 'cleanup_invalid_input' });
    expect(query).not.toHaveBeenCalled();
    const stored = new PostgresRetentionPolicyStore({ query: vi.fn().mockResolvedValue({ rows: [{ ...row, terminal_task_archive_ms: 6n }] }) } as unknown as ByokPool, createMutableClock());
    await expect(stored.readRetentionPolicy(tenant)).rejects.toMatchObject({ code: 'cleanup_invalid_input' });
  });
  it('rejects invalid stored policy rather than synthesizing a duration', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row, request_receipt_retention_ms: 0n }] });
    const store = new PostgresRetentionPolicyStore({ query } as unknown as ByokPool, createMutableClock());
    await expect(store.readRetentionPolicy(tenant)).rejects.toMatchObject({ code: 'cleanup_invalid_input' });
  });
});

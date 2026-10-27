import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeEnvelope } from '@byok-sdk/protocol';
import {
  ReceiptMigrationUnmappableError,
  WireV4LegacyTaskListMismatchError,
  assertWireV4MigrationConfirmed,
  hasUnnamedApproval,
  migrateWireV3Receipt,
  wireV3LegacyOfferType,
  wireV4ReceiptKind,
} from '../wire-v4-receipt-migration';

const v3Lines = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n');
const v3Terminal = v3Lines.find((line) => (JSON.parse(line) as { type: string }).type === 'task.complete')!;
const offerReceipt = (type: string, payload: unknown) => JSON.stringify({ deviceId: 'device-1', type, payload });
const AGENT = { agentId: 'agent-1', profileRevision: 'rev-1' };

describe('wire v3 -> v4 receipt migration (#925)', () => {
  it('classifies only offer and terminal receipt keys', () => {
    expect(wireV4ReceiptKind('task-offer:abc')).toBe('offer');
    expect(wireV4ReceiptKind('task:t1:terminal')).toBe('terminal');
    expect(wireV4ReceiptKind('task-offer-delivered:abc')).toBeUndefined();
    expect(wireV4ReceiptKind('task-redaction:t1')).toBeUndefined();
  });

  it('re-encodes a v3 terminal receipt under v4 and leaves a v4 one unchanged', () => {
    const migrated = migrateWireV3Receipt('terminal', v3Terminal);
    if (migrated.outcome !== 'migrated') throw new Error(`expected migrated, got ${migrated.outcome}`);
    expect(migrated.body).not.toBe(v3Terminal);
    expect(decodeEnvelope(migrated.body)).toMatchObject({ v: 4, type: 'task.complete' });
    expect(migrateWireV3Receipt('terminal', migrated.body)).toEqual({ outcome: 'unchanged' });
  });

  it('re-encodes every v3 terminal, with or without agentRef, and v4 reads its agentRef unchanged', () => {
    const terminals = v3Lines.filter((line) => ['task.complete', 'task.fail', 'task.cancelled'].includes((JSON.parse(line) as { type: string }).type));
    const withoutAgent = terminals.filter((line) => !('agentRef' in (JSON.parse(line) as { payload: object }).payload));
    expect(withoutAgent.length).toBeGreaterThan(0);
    expect(withoutAgent.length).toBeLessThan(terminals.length);
    for (const line of terminals) {
      const v3 = (JSON.parse(line) as { payload: { agentRef?: unknown } }).payload;
      const migrated = migrateWireV3Receipt('terminal', line);
      if (migrated.outcome !== 'migrated') throw new Error(`expected migrated, got ${JSON.stringify(migrated)}`);
      const decoded = decodeEnvelope(migrated.body);
      expect(decoded.v).toBe(4);
      expect((decoded.payload as { agentRef?: unknown }).agentRef).toEqual(v3.agentRef);
    }
  });

  const OFFER_VARIANTS = [
    ['resume', 'task.offer_for_agent', 'resume'],
    ['resume with egress', 'task.offer_for_agent_with_egress', 'resume'],
    ['fresh execution', 'task.offer_for_agent_with_egress_fresh', 'fresh'],
    ['prepared', 'task.offer_prepared', 'fresh'],
    ['sealed resume', 'task.offer_for_agent_sealed', 'resume'],
    ['sealed egress', 'task.offer_for_agent_with_egress_sealed', 'resume'],
    ['sealed execution', 'task.offer_for_agent_with_egress_fresh_sealed', 'fresh'],
  ] as const;
  const v3OfferPayload = (type: string) =>
    (JSON.parse(v3Lines.find((line) => (JSON.parse(line) as { type: string }).type === type)!) as { payload: Record<string, unknown> }).payload;

  it.each(OFFER_VARIANTS)('migrates a v3 %s offer receipt to task.offer with its session', (_variant, v3Type, mode) => {
    const payload = v3OfferPayload(v3Type);
    const migrated = migrateWireV3Receipt('offer', offerReceipt(v3Type, payload));
    if (migrated.outcome !== 'migrated') throw new Error(`expected migrated, got ${JSON.stringify(migrated)}`);
    const { sessionRef, ...rest } = payload;
    expect(JSON.parse(migrated.body)).toEqual({
      deviceId: 'device-1',
      type: 'task.offer',
      payload: { ...rest, session: mode === 'resume' ? { mode, sessionRef } : { mode } },
    });
  });

  it('refuses a legacy offer type', () => {
    for (const type of ['task.offer', 'task.offer_with_toolsets', 'task.offer_sealed', 'task.offer_with_toolsets_sealed']) {
      expect(migrateWireV3Receipt('offer', offerReceipt(type, { instruction: 'x' }))).toEqual({
        outcome: 'refused', refusal: 'type_without_v4_form', type,
      });
    }
  });

  it('refuses an offer receipt whose payload v4 does not read exactly', () => {
    expect(migrateWireV3Receipt('offer', offerReceipt('task.offer_for_agent', { instruction: 'x' }))).toEqual({
      outcome: 'refused', refusal: 'invalid_under_v4', type: 'task.offer_for_agent',
    });
    // A resume offer without its sessionRef is never read as fresh.
    expect(migrateWireV3Receipt('offer', offerReceipt('task.offer_for_agent', { instruction: 'x', agentRef: AGENT }))).toEqual({
      outcome: 'refused', refusal: 'invalid_under_v4', type: 'task.offer_for_agent',
    });
    expect(migrateWireV3Receipt('offer', 'not json')).toEqual({ outcome: 'refused', refusal: 'not_wire_v3' });
  });

  it('leaves a redaction tombstone unchanged', () => {
    expect(migrateWireV3Receipt('terminal', '{"byokRedacted":1,"type":"task.complete"}')).toEqual({ outcome: 'unchanged' });
  });

  it('names every unmappable row in its error', () => {
    const error = new ReceiptMigrationUnmappableError([
      { kind: 'receipt', tenantId: 'tenant-a', key: 'task-offer:m1', receiptKind: 'offer', refusal: 'invalid_under_v4', type: 'task.offer_for_agent' },
      { kind: 'approval', tenantId: 'tenant-a', taskId: 't1', refusal: 'approval_id_missing' },
    ]);
    expect(error.code).toBe('wire_v4_migration_unmappable');
    expect(error.message).toContain('tenant-a/task-offer:m1 (task.offer_for_agent: invalid_under_v4)');
    expect(error.message).toContain('tenant-a/approvals/t1 (approval_id_missing)');
  });

  it('finds the removed offer type of a legacy offer receipt, redacted or not', () => {
    for (const type of ['task.offer', 'task.offer_with_toolsets', 'task.offer_sealed', 'task.offer_with_toolsets_sealed']) {
      expect(wireV3LegacyOfferType(offerReceipt(type, { instruction: 'x' }))).toBe(type);
      expect(wireV3LegacyOfferType(JSON.stringify({ byokRedacted: 1, sha256: `sha256:${'a'.repeat(64)}`, bytes: 1, type }))).toBe(type);
    }
    expect(wireV3LegacyOfferType(offerReceipt('task.offer_for_agent', { instruction: 'x', agentRef: AGENT }))).toBeUndefined();
    expect(wireV3LegacyOfferType('not json')).toBeUndefined();
  });

  it('flags an approval timeline that holds an approval without an id', () => {
    const entry = (event: object, revision: number) => ({ taskId: 't1', sourceEnvelopeId: `e${revision}`, revision, receivedAt: '2026-10-01T00:00:00.000Z', event });
    expect(hasUnnamedApproval([entry({ type: 'approval_requested', summary: 's', approvalId: 'a1' }, 1)])).toBe(false);
    expect(hasUnnamedApproval([entry({ type: 'approval_requested', summary: 's' }, 1)])).toBe(true);
  });

  it('runs only when nothing is unmappable and the confirmed legacy list matches exactly', () => {
    const task = { tenantId: 'tenant-a', taskId: 't1', deviceId: 'd1', type: 'task.offer' };
    const clean = { legacyTasks: [task], unmappable: [] };
    expect(() => assertWireV4MigrationConfirmed(clean, [task])).not.toThrow();
    expect(() => assertWireV4MigrationConfirmed({ legacyTasks: [], unmappable: [] }, [])).not.toThrow();
    for (const confirmed of [[], [task, task], [{ ...task, deviceId: 'd2' }], [task, { ...task, taskId: 't2' }]]) {
      expect(() => assertWireV4MigrationConfirmed(clean, confirmed)).toThrow(WireV4LegacyTaskListMismatchError);
    }
    expect(() => assertWireV4MigrationConfirmed(
      { legacyTasks: [task], unmappable: [{ kind: 'approval', tenantId: 'tenant-a', taskId: 't9', refusal: 'approval_id_missing' }] },
      [task],
    )).toThrow(ReceiptMigrationUnmappableError);
  });
});

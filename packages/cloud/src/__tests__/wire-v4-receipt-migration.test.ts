import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeEnvelope } from '@byok-sdk/protocol';
import { migrateWireV3Receipt, wireV4ReceiptKind, WireV4ReceiptMigrationError } from '../wire-v4-receipt-migration';

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

  it('keeps an offer receipt whose type v4 keeps, and refuses a legacy offer type', () => {
    expect(migrateWireV3Receipt('offer', offerReceipt('task.offer_for_agent', { instruction: 'x', agentRef: AGENT })))
      .toEqual({ outcome: 'unchanged' });
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
    expect(migrateWireV3Receipt('offer', 'not json')).toEqual({ outcome: 'refused', refusal: 'not_wire_v3' });
  });

  it('leaves a redaction tombstone unchanged', () => {
    expect(migrateWireV3Receipt('terminal', '{"byokRedacted":1,"type":"task.complete"}')).toEqual({ outcome: 'unchanged' });
  });

  it('names every refused receipt in its error', () => {
    const error = new WireV4ReceiptMigrationError([
      { tenantId: 'tenant-a', key: 'task-offer:m1', kind: 'offer', refusal: 'type_without_v4_form', type: 'task.offer' },
    ]);
    expect(error.code).toBe('wire_v4_receipt_migration_refused');
    expect(error.message).toContain('tenant-a/task-offer:m1 (task.offer: type_without_v4_form)');
  });
});

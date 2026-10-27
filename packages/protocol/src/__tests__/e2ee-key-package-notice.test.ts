/** The E2EE key package notice (#654 E2c-3): its payload, its envelope fields and its gate. */
import { describe, expect, it } from 'vitest';
import {
  E2EE_SCOPE_ID_MAX_LENGTH,
  E2eeKeyPackageAvailablePayloadSchema,
  EnvelopeSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  SEALED_PAYLOAD_CAPABILITY,
  SERVER_TO_DAEMON_TYPES,
  WIRE_ADDITIONS,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  requiredReceiverCapabilities,
} from '../index';

const TYPE = 'e2ee.key_package.available';
const envelopeBase = {
  v: 4,
  id: '20000000-0000-4000-8000-0000000000e2',
  ts: '2026-10-24T00:00:00.000Z',
  type: TYPE,
  seq: 1,
  payload: { scopeId: 'scope-1', epoch: 1 },
};

describe('e2ee.key_package.available notice', () => {
  it('is a registered server-to-daemon type carrying exactly { scopeId, epoch }', () => {
    expect(SERVER_TO_DAEMON_TYPES).toContain(TYPE);
    expect(MESSAGE_PAYLOAD_SCHEMAS[TYPE]).toBe(E2eeKeyPackageAvailablePayloadSchema);
    const envelope = createEnvelope(TYPE, { scopeId: 'scope-1', epoch: 2 }, { seq: 4 });
    const decoded = decodeEnvelope(encodeEnvelope(envelope));
    expect(decoded).toEqual(envelope);
    if (decoded.type !== TYPE) throw new Error('unreachable');
    expect(Object.keys(decoded.payload).sort()).toEqual(['epoch', 'scopeId']);
  });

  it('requires seq and forbids task_id', () => {
    expect(EnvelopeSchema.safeParse(envelopeBase).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...envelopeBase, task_id: 'task-1' }).success).toBe(false);
    const { seq: _seq, ...withoutSeq } = envelopeBase;
    expect(EnvelopeSchema.safeParse(withoutSeq).success).toBe(false);
  });

  it('requires a nonempty scopeId and a positive safe integer epoch, and nothing else', () => {
    const parse = (payload: unknown) => E2eeKeyPackageAvailablePayloadSchema.safeParse(payload).success;
    expect(parse({ scopeId: 's', epoch: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(parse({ epoch: 1 })).toBe(false);
    expect(parse({ scopeId: 's' })).toBe(false);
    expect(parse({ scopeId: '', epoch: 1 })).toBe(false);
    for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) expect(parse({ scopeId: 's', epoch })).toBe(false);
  });

  it('bounds scopeId at 512 characters', () => {
    expect(E2EE_SCOPE_ID_MAX_LENGTH).toBe(512);
    const parse = (scopeId: string) => E2eeKeyPackageAvailablePayloadSchema.safeParse({ scopeId, epoch: 1 }).success;
    expect(parse('x'.repeat(512))).toBe(true);
    expect(parse('x'.repeat(513))).toBe(false);
  });

  it.each([
    ['keyId', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['recipient', 'member-1'],
    ['ciphertext', 'AAAA'],
    ['tenantId', 'tenant-1'],
  ])('rejects (never strips) an extra %s field', (field, value) => {
    const payload = { scopeId: 'scope-1', epoch: 1, [field]: value };
    expect(E2eeKeyPackageAvailablePayloadSchema.safeParse(payload).success).toBe(false);
    expect(() => decodeEnvelope(JSON.stringify({ ...envelopeBase, payload }))).toThrow();
  });

  it('is gated as a whole type by the device capability sealed-payload-v1', () => {
    expect(WIRE_ADDITIONS.filter(entry => entry.kind === 'envelope' && entry.surface === TYPE)).toEqual([
      { kind: 'envelope', rule: 'gated', surface: TYPE, capability: SEALED_PAYLOAD_CAPABILITY, advertisedBy: 'device' },
    ]);
    expect(requiredReceiverCapabilities(TYPE, { scopeId: 'scope-1', epoch: 1 })).toEqual([SEALED_PAYLOAD_CAPABILITY]);
  });
});

/**
 * Sealed payload v1 on the wire (#654 E3a): the padded length, the outer
 * shape of a sealed member, the sealed branch of each sealable message type
 * that the split table describes, their capability gates, and the digest rule
 * of D16.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
  createEnvelope,
  SEALED_DECLINE_CODES,
  SEALED_INLINE_MAX_PADDED_LENGTH,
  SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  SEALED_PAYLOAD_MAX_PADDED_LENGTH,
  SEALED_SPLIT_TABLE,
  SealedPayloadSchema,
  TaskOfferPlainPayloadSchema,
  WIRE_ADDITIONS,
  isSealedPayload,
  isServerToDaemonType,
  requiredReceiverCapabilities,
  sealedBase64UrlByteLength,
  sealedPayloadPaddedLength,
  type MessageType,
  type SealableMessageType,
  type SealedSplitEntry,
} from '../index';

type Json = { [key: string]: unknown };

const corpus = readFileSync(new URL('golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; ts: string; payload: Json });
const sealedLines = corpus.filter((line) => line.payload.sealed !== undefined);
const SEALABLE_TYPES = Object.keys(SEALED_SPLIT_TABLE) as SealableMessageType[];

/** The three sealed offer lanes: a resume offer, a resume offer with egress, and a fresh execution. */
const SEALED_OFFER_LANES = {
  resume: (payload: Json) => (payload.session as Json).mode === 'resume' && payload.egressPolicy === undefined,
  'resume with egress': (payload: Json) => (payload.session as Json).mode === 'resume' && payload.egressPolicy !== undefined,
  fresh: (payload: Json) => (payload.session as Json).mode === 'fresh',
} as const;
type SealedOfferLane = keyof typeof SEALED_OFFER_LANES;
const LANES = Object.keys(SEALED_OFFER_LANES) as SealedOfferLane[];

function sealedLine(type: SealableMessageType, inline = true, lane: SealedOfferLane = 'resume'): Json {
  const line = sealedLines.find((candidate) => candidate.type === type
    && ((candidate.payload.sealed as Json).ciphertext !== undefined) === inline
    && (type !== 'task.offer' || SEALED_OFFER_LANES[lane](candidate.payload)));
  if (line === undefined) throw new Error(`no sealed ${type} corpus line`);
  return structuredClone(line.payload);
}

function sealedMember(type: SealableMessageType = 'task.offer', inline = true): Json {
  return sealedLine(type, inline).sealed as Json;
}

/** The plaintext and the sealed branch of a sealable type, in that order. */
function branches(type: SealableMessageType): { readonly plain: z.ZodType; readonly sealed: z.ZodType } {
  const [plain, sealed] = (MESSAGE_PAYLOAD_SCHEMAS[type] as unknown as z.ZodUnion<[z.ZodType, z.ZodType]>).options;
  return { plain, sealed };
}

/** Canonical unpadded base64url of `length` zero bytes. */
function zeros(length: number): string {
  return Buffer.alloc(length).toString('base64url');
}

describe('sealed payload v1: padded length (§8.6)', () => {
  it('aligns to 256 bytes up to 16 KiB and uses Padmé above', () => {
    expect(sealedPayloadPaddedLength(4)).toBe(256);
    expect(sealedPayloadPaddedLength(256)).toBe(256);
    expect(sealedPayloadPaddedLength(257)).toBe(512);
    expect(sealedPayloadPaddedLength(16 * 1024)).toBe(16 * 1024);
    // 16385: E = 14, S = 4, step 2^10.
    expect(sealedPayloadPaddedLength(16 * 1024 + 1)).toBe(17 * 1024);
    // 262145: E = 18, S = 5, step 2^13.
    expect(sealedPayloadPaddedLength(256 * 1024 + 1)).toBe(256 * 1024 + 8192);
    expect(() => sealedPayloadPaddedLength(3)).toThrow(RangeError);
  });

  it('adds less than 6.25% above 16 KiB', () => {
    for (let frame = 16 * 1024 + 1; frame < 4 * 1024 * 1024; frame = Math.floor(frame * 1.37)) {
      const padded = sealedPayloadPaddedLength(frame);
      expect(padded).toBeGreaterThanOrEqual(frame);
      expect((padded - frame) / frame).toBeLessThan(0.0625);
      expect(sealedPayloadPaddedLength(padded), 'a padded length pads to itself').toBe(padded);
    }
  });

  it('bounds v1 content at 2 MiB, so the padded limit is the padded length of 4 + 2 MiB', () => {
    expect(SEALED_PAYLOAD_MAX_CONTENT_LENGTH).toBe(2 * 1024 * 1024);
    expect(SEALED_PAYLOAD_MAX_PADDED_LENGTH).toBe(sealedPayloadPaddedLength(4 + 2 * 1024 * 1024));
    expect(SEALED_PAYLOAD_MAX_PADDED_LENGTH).toBe(33 * 65536);
  });
});

describe('sealed payload v1: canonical base64url', () => {
  it('reads canonical unpadded base64url only', () => {
    expect(sealedBase64UrlByteLength('')).toBe(0);
    expect(sealedBase64UrlByteLength('AA')).toBe(1);
    expect(sealedBase64UrlByteLength('AAA')).toBe(2);
    expect(sealedBase64UrlByteLength('AAAA')).toBe(3);
    expect(sealedBase64UrlByteLength('A'), 'impossible length').toBeUndefined();
    expect(sealedBase64UrlByteLength('AB'), 'nonzero unused bits').toBeUndefined();
    expect(sealedBase64UrlByteLength('AAB'), 'nonzero unused bits').toBeUndefined();
    expect(sealedBase64UrlByteLength('AA=='), 'padding').toBeUndefined();
    expect(sealedBase64UrlByteLength('A+/A'), 'base64, not base64url').toBeUndefined();
  });
});

describe('sealed payload v1: the sealed member', () => {
  it('accepts the corpus members, inline and by reference', () => {
    expect(SealedPayloadSchema.safeParse(sealedMember('task.offer', true)).success).toBe(true);
    expect(SealedPayloadSchema.safeParse(sealedMember('task.complete', false)).success).toBe(true);
  });

  it('carries inline ciphertext exactly up to 256 KiB, and a ciphertext blob above', () => {
    const at = { ...sealedMember(), paddedLength: SEALED_INLINE_MAX_PADDED_LENGTH, ciphertext: zeros(SEALED_INLINE_MAX_PADDED_LENGTH + 16) };
    expect(SealedPayloadSchema.safeParse(at).success).toBe(true);
    const ref = { blobId: 'blob-1', contentHash: `sha256:${'0'.repeat(64)}`, size: SEALED_INLINE_MAX_PADDED_LENGTH + 16, contentType: 'application/octet-stream' };
    expect(SealedPayloadSchema.safeParse({ ...sealedMember(), paddedLength: SEALED_INLINE_MAX_PADDED_LENGTH, ciphertext: undefined, ciphertextRef: ref }).success).toBe(false);

    const above = sealedPayloadPaddedLength(SEALED_INLINE_MAX_PADDED_LENGTH + 1);
    const aboveRef = { ...ref, size: above + 16 };
    const base = { ...sealedMember(), paddedLength: above, ciphertext: undefined };
    expect(SealedPayloadSchema.safeParse({ ...base, ciphertextRef: aboveRef }).success).toBe(true);
    expect(SealedPayloadSchema.safeParse({ ...base, ciphertext: zeros(above + 16) }).success, 'inline above 256 KiB').toBe(false);
    expect(SealedPayloadSchema.safeParse({ ...base, ciphertextRef: { ...aboveRef, size: above } }).success, 'blob size').toBe(false);
    expect(SealedPayloadSchema.safeParse({ ...base, ciphertextRef: { ...aboveRef, url: 'https://example.test/x' } }).success, 'presigned url').toBe(false);
    expect(SealedPayloadSchema.safeParse({ ...base, ciphertextRef: aboveRef, ciphertext: zeros(above + 16) }).success, 'both forms').toBe(false);
  });

  it('rejects every malformed outer field, fail closed', () => {
    const good = sealedMember();
    const cases: [string, Json][] = [
      ['unknown version', { ...good, v: 2 }],
      ['unknown suite', { ...good, suite: 'byok-sealed-v2.hkdf-sha256.aes-256-gcm' }],
      ['C4 category', { ...good, category: 'memory-projection' }],
      ['C2 category', { ...good, category: 'agent-message' }],
      ['illegal padded length', { ...good, paddedLength: 300 }],
      ['padded length above the v1 limit', { ...good, paddedLength: sealedPayloadPaddedLength(SEALED_PAYLOAD_MAX_PADDED_LENGTH + 1) }],
      ['short ciphertext', { ...good, ciphertext: zeros((good.paddedLength as number) + 15) }],
      ['no ciphertext', { ...good, ciphertext: undefined }],
      ['short salt', { ...good, salt: zeros(16) }],
      ['long nonce', { ...good, nonce: zeros(16) }],
      ['bad key id', { ...good, scope: { ...(good.scope as Json), keyId: 'short' } }],
      ['bad sender', { ...good, sender: 'member' }],
      ['bad content MAC', { ...good, contentMac: 'sha256:00' }],
      ['bad chain head', { ...good, chainHead: { seq: 0, hash: (good.chainHead as Json).hash } }],
      ['unknown key', { ...good, byteCount: 4 }],
    ];
    for (const [label, member] of cases) expect(SealedPayloadSchema.safeParse(member).success, label).toBe(false);
  });
});

function parse(type: MessageType, payload: Json): boolean {
  return MESSAGE_PAYLOAD_SCHEMAS[type].safeParse(payload).success;
}

const blobRef = { blobId: 'blob-1', contentHash: `sha256:${'0'.repeat(64)}`, size: 1, contentType: 'text/plain' };

describe('sealed payload v1: the sealed offer', () => {
  it('carries sealed exactly when sealing includes task-input, under the task scope and epoch', () => {
    for (const lane of LANES) {
      const payload = sealedLine('task.offer', true, lane);
      expect(parse('task.offer', payload), lane).toBe(true);
      const sealing = payload.sealing as Json;
      expect(parse('task.offer', { ...payload, sealing: undefined }), `${lane} without sealing`).toBe(false);
      expect(parse('task.offer', { ...payload, sealing: { ...sealing, categories: ['task-output'] } }), `${lane} sealed without task-input`).toBe(false);
      expect(parse('task.offer', { ...payload, sealed: undefined }), `${lane} task-input sealing without sealed`).toBe(false);
      expect(parse('task.offer', { ...payload, sealing: { ...sealing, epoch: 3 } }), `${lane} epoch`).toBe(false);
      expect(parse('task.offer', { ...payload, sealing: { ...sealing, scopeId: 'scope-other' } }), `${lane} scope`).toBe(false);
      expect(parse('task.offer', { ...payload, instruction: 'plaintext next to the sealed copy' }), `${lane} plaintext copy`).toBe(false);
      expect(parse('task.offer', { ...payload, sealed: sealedMember('task.complete') }), `${lane} with a task-output member`).toBe(false);
      expect(parse('task.offer', { ...payload, surprise: true }), `${lane} unknown key`).toBe(false);
    }
  });

  it('keeps a plaintext instruction when the task seals only its output', () => {
    for (const lane of LANES) {
      const lines = corpus.filter((line) => line.type === 'task.offer' && line.payload.sealing !== undefined
        && line.payload.sealed === undefined && SEALED_OFFER_LANES[lane](line.payload));
      expect(lines.length, lane).toBeGreaterThan(0);
      for (const { payload } of lines) {
        expect(parse('task.offer', payload), lane).toBe(true);
        expect(parse('task.offer', { ...payload, instruction: undefined }), `${lane} without instruction`).toBe(false);
        const sealing = payload.sealing as Json;
        expect(parse('task.offer', { ...payload, sealing: { ...sealing, categories: ['task-output', 'task-input'] } }), 'canonical order').toBe(false);
        expect(parse('task.offer', { ...payload, sealing: { ...sealing, categories: ['agent-message'] } }), 'C2 is not in v1').toBe(false);
      }
    }
  });

  it('has no prepared form: a prepared offer takes no sealing (D17)', () => {
    const prepared = corpus.find((line) => line.type === 'task.offer' && line.payload.preparation !== undefined)!;
    expect(parse('task.offer', prepared.payload)).toBe(true);
    const outputOnly = corpus.find((line) => line.type === 'task.offer' && line.payload.sealing !== undefined && line.payload.sealed === undefined)!;
    expect(parse('task.offer', { ...prepared.payload, sealing: outputOnly.payload.sealing }), 'prepared offer with sealing').toBe(false);
    expect(parse('task.offer', { ...sealedLine('task.offer', true, 'fresh'), preparation: prepared.payload.preparation }), 'sealed offer with preparation').toBe(false);
    expect(SEALED_SPLIT_TABLE['task.offer'].forbidden).toContain('preparation');
  });

  it('is the type task.offer itself, marked by sealing even when only its output is sealed', () => {
    expect(SEALED_SPLIT_TABLE['task.offer'].marker).toBe('sealing');
    expect(MESSAGE_TYPES.filter((type) => type.endsWith('_sealed'))).toEqual([]);
    for (const line of corpus.filter((candidate) => candidate.type === 'task.offer')) {
      expect(isSealedPayload('task.offer', line.payload)).toBe(line.payload.sealing !== undefined);
    }
  });
});

describe('sealed payload v1: the routine template reference (#654 E3d)', () => {
  const routineLines = corpus.filter((line) => line.payload.routineRef !== undefined);
  const routinePayload = () => structuredClone(routineLines[0]!.payload);
  const routineRef = () => routinePayload().routineRef as Json;

  it('travels only on the fresh sealed execution offer, with a sealed task input', () => {
    expect(new Set(routineLines.map((line) => line.type))).toEqual(new Set(['task.offer']));
    for (const { payload } of routineLines) {
      expect(parse('task.offer', payload)).toBe(true);
      expect(SEALED_OFFER_LANES.fresh(payload)).toBe(true);
      expect((payload.sealing as Json).categories, 'the template seals task output too').toEqual(['task-input', 'task-output']);
    }
    for (const lane of LANES.filter((candidate) => candidate !== 'fresh')) {
      expect(parse('task.offer', { ...sealedLine('task.offer', true, lane), routineRef: routineRef() }), lane).toBe(false);
    }
    const plainFresh = corpus.find((line) => line.type === 'task.offer' && line.payload.sealing === undefined
      && line.payload.preparation === undefined && SEALED_OFFER_LANES.fresh(line.payload))!;
    expect(parse('task.offer', { ...plainFresh.payload, routineRef: routineRef() }), 'plaintext fresh offer').toBe(false);
  });

  it('needs a task that seals task-input', () => {
    const outputOnly = corpus.find((line) => line.type === 'task.offer' && line.payload.sealing !== undefined
      && line.payload.sealed === undefined && SEALED_OFFER_LANES.fresh(line.payload))!;
    expect(parse('task.offer', outputOnly.payload)).toBe(true);
    expect(parse('task.offer', { ...outputOnly.payload, routineRef: routineRef() })).toBe(false);
  });

  it('pins definitionVersion to an integer and notAfter to the canonical instant core binds', () => {
    const payload = routinePayload();
    const ref = routineRef();
    for (const [name, value] of [
      ['string version', { ...ref, definitionVersion: '4' }],
      ['negative version', { ...ref, definitionVersion: -1 }],
      ['fractional version', { ...ref, definitionVersion: 1.5 }],
      ['unsafe version', { ...ref, definitionVersion: Number.MAX_SAFE_INTEGER + 1 }],
      ['empty routine id', { ...ref, routineId: '' }],
      ['no milliseconds', { ...ref, notAfter: '2026-12-31T00:00:00Z' }],
      ['offset', { ...ref, notAfter: '2026-12-31T00:00:00.000+00:00' }],
      ['not a calendar day', { ...ref, notAfter: '2026-02-30T00:00:00.000Z' }],
      ['unknown key', { ...ref, categories: ['task-input'] }],
      ['missing notAfter', { routineId: ref.routineId, definitionVersion: ref.definitionVersion }],
    ] as const) {
      expect(parse('task.offer', { ...payload, routineRef: value }), name).toBe(false);
    }
    expect(parse('task.offer', { ...payload, routineRef: { ...ref, definitionVersion: 0 } })).toBe(true);
  });

  it('leaves the expiry to the device: an expired notAfter is still a valid offer', () => {
    const expired = routineLines.find((line) => Date.parse((line.payload.routineRef as Json).notAfter as string) < Date.parse(line.ts))!;
    expect(expired).toBeDefined();
    expect(parse('task.offer', expired.payload)).toBe(true);
  });
});

describe('sealed payload v1: the sealed steer and output branches', () => {
  it('leave each moved and forbidden field out, and require their identity', () => {
    const steer = sealedLine('task.steer');
    expect(parse('task.steer', steer)).toBe(true);
    expect(parse('task.steer', { ...steer, text: 'plaintext' })).toBe(false);
    expect(parse('task.steer', { ...steer, steerId: undefined }), 'identity').toBe(false);
    expect(parse('task.steer', { ...steer, sealed: sealedMember('task.complete') }), 'task-output member').toBe(false);

    const complete = sealedLine('task.complete', false);
    expect(parse('task.complete', complete)).toBe(true);
    expect(parse('task.complete', { ...complete, summary: 'x' })).toBe(false);
    expect(parse('task.complete', { ...complete, finalMessage: 'x' })).toBe(false);
    expect(parse('task.complete', { ...complete, document: { a: 1 } })).toBe(false);
    expect(parse('task.complete', { ...complete, sealed: sealedMember('task.offer') }), 'task-input member').toBe(false);
    const preparedObservation = corpus.find((line) => line.type === 'task.complete' && line.payload.preparedObservation !== undefined)?.payload.preparedObservation;
    expect(preparedObservation).toBeDefined();
    expect(parse('task.complete', { ...complete, preparedObservation }), 'prepared observation').toBe(false);
    expect(parse('task.complete', { ...complete, artifactRefs: [blobRef] }), 'blob bytes have no sealing rule yet').toBe(false);

    const fail = sealedLine('task.fail');
    expect(parse('task.fail', fail)).toBe(true);
    expect(parse('task.fail', { ...fail, reason: 'x' })).toBe(false);

    const progress = sealedLine('task.progress');
    expect(parse('task.progress', progress)).toBe(true);
    expect(parse('task.progress', { ...progress, events: [{ type: 'progress', text: 'x' }] })).toBe(false);
    expect(parse('task.progress', { ...progress, seq: undefined }), 'identity').toBe(false);

    const approval = sealedLine('task.await_approval');
    expect(parse('task.await_approval', approval)).toBe(true);
    expect(parse('task.await_approval', { ...approval, summary: 'x' })).toBe(false);
    expect(parse('task.await_approval', { ...approval, approvalId: undefined }), 'identity').toBe(false);

    const artifact = sealedLine('task.artifact');
    expect(parse('task.artifact', artifact)).toBe(true);
    expect(parse('task.artifact', { ...artifact, inline: 'x' })).toBe(false);
    expect(parse('task.artifact', { ...artifact, blobRef }), 'blob bytes have no sealing rule yet').toBe(false);
    expect(parse('task.artifact', { ...artifact, name: undefined }), 'name stays required').toBe(false);
    expect(parse('task.artifact', { ...artifact, artifactId: undefined }), 'identity').toBe(false);
    expect(parse('task.artifact', { ...artifact, artifactId: 'report.md' }), 'identity is a UUID').toBe(false);

    const cancelled = sealedLine('task.cancelled');
    expect(parse('task.cancelled', cancelled)).toBe(true);
    expect(parse('task.cancelled', { ...cancelled, reason: '' })).toBe(false);

    const decline = sealedLine('task.decline');
    expect(parse('task.decline', decline)).toBe(true);
    expect(parse('task.decline', { ...decline, reason: 'x' })).toBe(false);
  });

  it('require a sealed member of the right category', () => {
    for (const type of SEALABLE_TYPES) {
      const payload = sealedLine(type);
      // Without its marker a payload is plaintext, so the sealed branch itself must refuse it.
      expect(branches(type).sealed.safeParse({ ...payload, sealed: undefined }).success, `${type} without sealed`).toBe(false);
      const other = SEALED_SPLIT_TABLE[type].category === 'task-input' ? sealedMember('task.complete') : sealedMember('task.offer');
      expect(parse(type, { ...payload, sealed: other }), `${type} with the other category`).toBe(false);
    }
  });

  it('carry the sealed decline codes only on the plaintext task.decline, with reason === code (owner decision 12c)', () => {
    const sealedDecline = sealedLine('task.decline');
    for (const code of SEALED_DECLINE_CODES) {
      expect(corpus.some((line) => line.type === 'task.decline' && line.payload.sealed === undefined
        && line.payload.code === code && line.payload.reason === code), code).toBe(true);
      expect(sealedLines.some((line) => line.type === 'task.decline' && line.payload.code === code), code).toBe(false);
      expect(parse('task.decline', { reason: code, retryable: false, code }), code).toBe(true);
      expect(parse('task.decline', { reason: `${code}: free text`, retryable: false, code }), code).toBe(false);
      expect(parse('task.decline', { reason: code, retryable: true, code }), `${code} is not retryable`).toBe(false);
      expect(parse('task.decline', { ...sealedDecline, code }), code).toBe(false);
    }
    expect(parse('task.decline', { reason: 'free text', code: 'agent_home_writer_busy' })).toBe(true);
    expect(parse('task.decline', { ...sealedDecline, code: 'agent_home_writer_busy' })).toBe(true);
  });
});

describe('sealed payload v1: a plaintext branch never carries sealed content', () => {
  it('no plaintext branch accepts a sealed or sealing field', () => {
    for (const type of SEALABLE_TYPES) {
      const schema = z.toJSONSchema(branches(type).plain, { io: 'input', unrepresentable: 'any' }) as Json;
      const properties = schema.properties as Json;
      for (const field of ['sealed', 'sealing']) {
        // A loose branch names the field as one that holds no value. A strict branch refuses every unknown key.
        if (field in properties) expect(properties[field], `${type}.${field}`).toEqual({ not: {} });
        else expect(schema.additionalProperties, `${type}.${field}`).toBe(false);
      }
    }
  });

  it('refuses a plaintext payload with a sealed member or a sealing policy, and never strips it (#654)', () => {
    const sealedOffer = sealedLine('task.offer');
    for (const type of SEALABLE_TYPES) {
      const plain = corpus.find((line) => line.type === type && !isSealedPayload(type, line.payload))!;
      for (const field of ['sealed', 'sealing'] as const) {
        const parsed = MESSAGE_PAYLOAD_SCHEMAS[type].safeParse({ ...plain.payload, [field]: sealedOffer[field] });
        expect(parsed.success, `${type}.${field}`).toBe(false);
      }
    }
  });

  it('refuses a non-enumerable sealed member or sealing policy on a plaintext payload (#654)', () => {
    // A strict schema checks unknown keys by enumeration, so only a declared
    // field catches a non-enumerable own property.
    const sealedOffer = sealedLine('task.offer');
    for (const type of SEALABLE_TYPES) {
      const plain = corpus.find((line) => line.type === type && !isSealedPayload(type, line.payload))!;
      for (const field of ['sealed', 'sealing'] as const) {
        const payload = structuredClone(plain.payload);
        Object.defineProperty(payload, field, { value: sealedOffer[field], enumerable: false });
        expect(MESSAGE_PAYLOAD_SCHEMAS[type].safeParse(payload).success, `${type}.${field}`).toBe(false);
        expect(() => createEnvelope(type, payload as never, { taskId: 'task-hidden', seq: 1 }), `${type}.${field}`).toThrow();
      }
    }
  });

  it('refuses an output-only sealed offer as a plaintext offer, so it cannot run as plaintext', () => {
    const outputOnly = corpus.find((line) => line.type === 'task.offer' && line.payload.sealing !== undefined && line.payload.sealed === undefined)!;
    expect(TaskOfferPlainPayloadSchema.safeParse(outputOnly.payload).success).toBe(false);
    expect(isSealedPayload('task.offer', outputOnly.payload)).toBe(true);
  });
});

describe('sealed payload v1: capability gates (§8.4)', () => {
  it('gates the marker of each sealed branch on sealed-payload-v1, advertised by its receiver', () => {
    for (const type of SEALABLE_TYPES) {
      const { marker } = SEALED_SPLIT_TABLE[type];
      const advertisedBy = isServerToDaemonType(type) ? 'device' : 'server';
      expect(WIRE_ADDITIONS.filter((entry) => entry.surface === type && entry.rule === 'gated' && entry.capability === 'sealed-payload-v1' && entry.field !== 'code'), type)
        .toEqual([{ kind: 'envelope', rule: 'gated', surface: type, field: marker, capability: 'sealed-payload-v1', advertisedBy }]);
      // Every row of the type names its receiver.
      for (const entry of WIRE_ADDITIONS.filter((candidate) => candidate.surface === type && candidate.rule === 'gated')) {
        expect(entry.rule === 'gated' && entry.advertisedBy, `${type} ${JSON.stringify(entry)}`).toBe(advertisedBy);
      }
      for (const line of corpus.filter((candidate) => candidate.type === type && isSealedPayload(type, candidate.payload))) {
        expect(requiredReceiverCapabilities(type, line.payload), type).toContain('sealed-payload-v1');
      }
    }
  });

  it('gates a sealed task output that names its ciphertext blob on the server flag, except the inline-only types (§58a)', () => {
    const outputs = SEALABLE_TYPES.filter((type) => SEALED_SPLIT_TABLE[type].category === 'task-output');
    const inlineOnly = outputs.filter((type) => (SEALED_SPLIT_TABLE[type] as SealedSplitEntry).inlineOnly === true);
    expect(inlineOnly).toEqual(['task.progress', 'task.await_approval']);
    for (const type of outputs) {
      const byReference = sealedLines.find((line) => line.type === type && 'ciphertextRef' in (line.payload.sealed as object))!;
      const inline = sealedLines.find((line) => line.type === type && 'ciphertext' in (line.payload.sealed as object))!;
      const gated = !inlineOnly.includes(type);
      expect(requiredReceiverCapabilities(type, byReference.payload).includes('sealed-output-ciphertext-ref'), type).toBe(gated);
      expect(requiredReceiverCapabilities(type, inline.payload), type).not.toContain('sealed-output-ciphertext-ref');
    }
    for (const type of SEALABLE_TYPES.filter((candidate) => SEALED_SPLIT_TABLE[candidate].category === 'task-input')) {
      expect(WIRE_ADDITIONS.filter((entry) => entry.surface === type && entry.rule === 'gated' && entry.capability === 'sealed-output-ciphertext-ref'), type).toEqual([]);
    }
  });

  it('never needs fewer flags than its plaintext branch needs for the same plaintext fields', () => {
    for (const line of corpus.filter((candidate) => isSealedPayload(candidate.type, candidate.payload))) {
      const { sealed: _sealed, sealing: _sealing, steerId: _steerId, ...plaintext } = line.payload;
      const sealedFlags = requiredReceiverCapabilities(line.type, line.payload);
      const plainFlags = requiredReceiverCapabilities(line.type, plaintext);
      expect(plainFlags.filter((flag) => !sealedFlags.includes(flag)), line.type).toEqual([]);
      expect(sealedFlags, line.type).toContain('sealed-payload-v1');
    }
    // The corpus has sealed offers whose plaintext fields carry other gates.
    expect(sealedLines.some((line) => requiredReceiverCapabilities(line.type, line.payload).includes('agent-home-contract'))).toBe(true);
    expect(sealedLines.some((line) => requiredReceiverCapabilities(line.type, line.payload).includes('agent-egress-policy'))).toBe(true);
  });

  it('applies no row of a moved or dropped field to a sealed payload, because the sealed branch refuses that field', () => {
    for (const type of SEALABLE_TYPES) {
      const { moved, forbidden } = SEALED_SPLIT_TABLE[type];
      for (const entry of WIRE_ADDITIONS) {
        if (entry.kind !== 'envelope' || entry.surface !== type || entry.field === undefined) continue;
        const field = topField(entry.field);
        if (!([...moved, ...forbidden] as readonly string[]).includes(field)) continue;
        const value = corpus.find((line) => line.type === type && line.payload[field] !== undefined)?.payload[field];
        expect(value, `${type}.${field}`).toBeDefined();
        const lane = type === 'task.offer' ? 'fresh' : 'resume';
        expect(parse(type, { ...sealedLine(type, true, lane), [field]: value }), `${type}.${field}`).toBe(false);
      }
    }
  });

  it('gates the sealed decline codes on plain task.decline on the server flag, and not the earlier codes', () => {
    for (const code of SEALED_DECLINE_CODES) {
      expect(requiredReceiverCapabilities('task.decline', { reason: code, code })).toEqual(['sealed-payload-v1']);
      expect(parse('task.decline', { reason: code, code })).toBe(true);
    }
    expect(requiredReceiverCapabilities('task.decline', { reason: 'busy', code: 'agent_home_writer_busy' })).toEqual([]);
  });

  it('leaves every plaintext corpus line of a sealable type without the sealed gate', () => {
    for (const line of corpus.filter((candidate) => (SEALABLE_TYPES as readonly MessageType[]).includes(candidate.type))) {
      if (isSealedPayload(line.type, line.payload)) continue;
      if (line.type === 'task.decline' && SEALED_DECLINE_CODES.includes(line.payload.code as never)) continue;
      expect(requiredReceiverCapabilities(line.type, line.payload), line.type).not.toContain('sealed-payload-v1');
    }
  });
});

/** Every property path of a JSON Schema whose name matches `pattern`, `[]` for array items. */
function namedPaths(schema: unknown, pattern: RegExp): string[] {
  const root = schema as Json;
  const defs = (root.$defs ?? {}) as Json;
  const out = new Set<string>();
  const walk = (node: unknown, path: string, refs: readonly string[]): void => {
    if (node === null || typeof node !== 'object') return;
    const value = node as Json;
    if (typeof value.$ref === 'string') {
      const name = value.$ref.split('/').pop()!;
      if (!refs.includes(name)) walk(defs[name], path, [...refs, name]);
      return;
    }
    for (const [name, property] of Object.entries((value.properties ?? {}) as Json)) {
      const next = path === '' ? name : `${path}.${name}`;
      if (pattern.test(name)) out.add(next);
      walk(property, next, refs);
    }
    if (value.items !== undefined) walk(value.items, `${path}[]`, refs);
    for (const key of ['anyOf', 'oneOf', 'allOf']) for (const branch of (value[key] ?? []) as unknown[]) walk(branch, path, refs);
    if (value.additionalProperties !== null && typeof value.additionalProperties === 'object') walk(value.additionalProperties, `${path}{}`, refs);
  };
  walk(root, '', []);
  return [...out].sort();
}


const DIGEST_NAME = /digest|hash|revision/i;
const topField = (path: string): string => path.split(/[.[]/u)[0]!;

describe('sealed payload v1: the split table', () => {
  const entries = Object.entries(SEALED_SPLIT_TABLE) as [SealableMessageType, SealedSplitEntry][];
  const jsonSchema = (schema: z.ZodType): Json => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;

  it('names only current message types, and leaves out what v1 defers (D17)', () => {
    for (const [type, entry] of entries) {
      expect(MESSAGE_TYPES).toContain(type);
      expect(isServerToDaemonType(type), type).toBe(entry.category === 'task-input');
    }
    for (const deferred of ['agent.input.preparation', 'agent.message.draft', 'agent.message.publish', 'agent.egress.reliable'] as const) {
      expect(entries.some(([type]) => (type as string) === deferred), deferred).toBe(false);
    }
    // A prepared Execution is deferred too: the sealed offer drops `preparation`.
    expect(SEALED_SPLIT_TABLE['task.offer'].forbidden).toContain('preparation');
  });

  it('classifies every digest, hash and revision field of the plaintext branch (D16)', () => {
    for (const [type, entry] of entries) {
      const found = namedPaths(jsonSchema(branches(type).plain), DIGEST_NAME);
      expect(Object.keys(entry.digests).sort(), `${type}: classify each plaintext path in SEALED_SPLIT_TABLE`).toEqual(found);
    }
  });

  it('keeps each digest rule consistent with the sealed branch schema', () => {
    for (const [type, entry] of entries) {
      const sealedPaths = namedPaths(jsonSchema(branches(type).sealed), DIGEST_NAME).filter((path) => topField(path) !== 'sealed');
      for (const [path, rule] of Object.entries(entry.digests)) {
        if (rule === 'sealed') expect(entry.moved, `${type} ${path}`).toContain(topField(path));
        if (rule === 'forbidden') {
          expect(entry.forbidden, `${type} ${path}`).toContain(topField(path));
          expect(sealedPaths, `${type} ${path}`).not.toContain(path);
        }
        if (rule === 'plain') expect(sealedPaths, `${type} ${path}`).toContain(path);
      }
      const plainRules = Object.entries(entry.digests).filter(([, rule]) => rule === 'plain').map(([path]) => path);
      const offerInstruction = (path: string) => entry.category === 'task-input' && topField(path) === 'instruction';
      expect(sealedPaths.filter((path) => !offerInstruction(path)), `${type}: a digest the sealed branch carries in plaintext`).toEqual(plainRules.sort());
    }
  });

  it('drops each moved and forbidden field from the sealed branch, and requires its marker and identity fields', () => {
    for (const [type, entry] of entries) {
      const schema = jsonSchema(branches(type).sealed);
      const plainProperties = Object.keys(jsonSchema(branches(type).plain).properties as Json);
      const properties = schema.properties as Json;
      const required = (schema.required ?? []) as string[];
      // An offer may seal only its output; its sealing member is then the only sealed field.
      expect(required, type).toContain(entry.marker);
      expect(Object.keys(properties), type).toContain('sealed');
      for (const field of [...entry.moved, ...entry.forbidden]) {
        expect(plainProperties, `${type}.${field}`).toContain(field);
        // A task that seals only its output keeps a plaintext instruction.
        if (field === 'instruction') expect(required, `${type}.${field}`).not.toContain(field);
        else if (field in properties) expect(properties[field], `${type}.${field} holds no value`).toEqual({ not: {} });
      }
      for (const field of entry.identity) expect(required, `${type}.${field}`).toContain(field);
    }
  });
});

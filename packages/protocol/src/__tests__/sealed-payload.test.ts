/**
 * Sealed payload v1 on the wire (#654 E3a): the padded length, the outer
 * shape of a sealed member, the payload rule that the split table drives,
 * the two capability gates, and the digest rule of D16.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  MESSAGE_PAYLOAD_SCHEMAS,
  MESSAGE_TYPES,
  SEALED_DECLINE_CODES,
  SEALED_INLINE_MAX_PADDED_LENGTH,
  SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  SEALED_PAYLOAD_MAX_PADDED_LENGTH,
  SEALED_SPLIT_TABLE,
  SealedPayloadSchema,
  WIRE_ADDITIONS,
  isSealedMessageType,
  isServerToDaemonType,
  requiredReceiverCapabilities,
  sealedBase64UrlByteLength,
  sealedPayloadPaddedLength,
  type MessageType,
  type SealedMessageType,
  type SealedSplitEntry,
} from '../index';

type Json = { [key: string]: unknown };

const corpus = readFileSync(new URL('golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; payload: Json });
const sealedLines = corpus.filter((line) => line.payload.sealed !== undefined);

function sealedLine(type: MessageType, inline = true): Json {
  const line = sealedLines.find((candidate) => candidate.type === type
    && ((candidate.payload.sealed as Json).ciphertext !== undefined) === inline);
  if (line === undefined) throw new Error(`no sealed ${type} corpus line`);
  return structuredClone(line.payload);
}

function sealedMember(type: MessageType = 'task.offer', inline = true): Json {
  return sealedLine(type, inline).sealed as Json;
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

describe('sealed payload v1: the payload rule', () => {
  const offers = ['task.offer', 'task.offer_with_toolsets', 'task.offer_for_agent', 'task.offer_for_agent_with_egress', 'task.offer_for_agent_with_egress_fresh'] as const;

  it('an offer carries sealed exactly when its sealing includes task-input, under the task scope and epoch', () => {
    for (const type of offers) {
      const payload = sealedLine(type);
      expect(parse(type, payload), type).toBe(true);
      const sealing = payload.sealing as Json;
      expect(parse(type, { ...payload, sealing: undefined }), `${type} sealed without sealing`).toBe(false);
      expect(parse(type, { ...payload, sealing: { ...sealing, categories: ['task-output'] } }), `${type} sealed without task-input`).toBe(false);
      expect(parse(type, { ...payload, sealed: undefined }), `${type} task-input sealing without sealed`).toBe(false);
      expect(parse(type, { ...payload, sealing: { ...sealing, epoch: 3 } }), `${type} epoch`).toBe(false);
      expect(parse(type, { ...payload, sealing: { ...sealing, scopeId: 'scope-other' } }), `${type} scope`).toBe(false);
      expect(parse(type, { ...payload, instruction: 'plaintext next to the sealed copy' }), `${type} placeholder`).toBe(false);
      expect(parse(type, { ...payload, sealed: sealedMember('task.complete') }), `${type} with a task-output member`).toBe(false);
    }
  });

  it('a task-output-only offer keeps its instruction in plaintext', () => {
    const line = corpus.find((candidate) => (candidate.payload.sealing as Json | undefined)?.categories !== undefined
      && candidate.payload.sealed === undefined);
    expect(line).toBeDefined();
    expect(parse(line!.type, line!.payload)).toBe(true);
    expect(parse(line!.type, { ...line!.payload, sealing: { ...(line!.payload.sealing as Json), categories: ['task-output', 'task-input'] } }), 'canonical order').toBe(false);
    expect(parse(line!.type, { ...line!.payload, sealing: { ...(line!.payload.sealing as Json), categories: ['agent-message'] } }), 'C2 is not in v1').toBe(false);
  });

  it('the prepared offer never carries sealing', () => {
    const prepared = corpus.find((line) => line.type === 'task.offer_prepared')!;
    const offer = sealedLine('task.offer_for_agent');
    expect(parse('task.offer_prepared', prepared.payload)).toBe(true);
    expect(parse('task.offer_prepared', { ...prepared.payload, sealing: offer.sealing })).toBe(false);
    expect(isSealedMessageType('task.offer_prepared')).toBe(false);
  });

  it('a sealed message keeps each placeholder, carries its identity, and leaves forbidden fields out', () => {
    const steer = sealedLine('task.steer');
    expect(parse('task.steer', steer)).toBe(true);
    expect(parse('task.steer', { ...steer, text: 'plaintext' })).toBe(false);
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
    const blobRef = { blobId: 'blob-1', contentHash: `sha256:${'0'.repeat(64)}`, size: 1, contentType: 'text/plain' };
    expect(parse('task.complete', { ...complete, artifactRefs: [blobRef] }), 'blob bytes have no sealing rule yet').toBe(false);

    const progress = sealedLine('task.progress');
    expect(parse('task.progress', progress)).toBe(true);
    expect(parse('task.progress', { ...progress, events: [{ type: 'progress', text: 'x' }] })).toBe(false);

    const approval = sealedLine('task.await_approval');
    expect(parse('task.await_approval', approval)).toBe(true);
    expect(parse('task.await_approval', { ...approval, approvalId: undefined }), 'identity').toBe(false);

    const artifact = sealedLine('task.artifact');
    expect(parse('task.artifact', artifact)).toBe(true);
    expect(parse('task.artifact', { ...artifact, inline: 'x' })).toBe(false);
    expect(parse('task.artifact', { ...artifact, blobRef }), 'blob bytes have no sealing rule yet').toBe(false);

    const cancelled = sealedLine('task.cancelled');
    expect(parse('task.cancelled', cancelled)).toBe(true);
    expect(parse('task.cancelled', { ...cancelled, reason: '' }), 'an optional moved field is absent, not empty').toBe(false);
  });

  it('a message without sealed is unchanged', () => {
    for (const line of corpus.filter((candidate) => isSealedMessageType(candidate.type) && candidate.payload.sealing === undefined && candidate.payload.sealed === undefined)) {
      expect(parse(line.type, line.payload), line.type).toBe(true);
    }
  });
});

describe('sealed payload v1: capability gates (§8.4)', () => {
  it('gates every sealed field on sealed-payload-v1, in the direction of the receiver', () => {
    const entries = WIRE_ADDITIONS.filter((entry) => entry.kind === 'envelope' && entry.rule === 'gated' && entry.capability === 'sealed-payload-v1');
    for (const type of Object.keys(SEALED_SPLIT_TABLE) as SealedMessageType[]) {
      const advertisedBy = isServerToDaemonType(type) ? 'device' : 'server';
      expect(entries.filter((entry) => entry.surface === type && entry.field === 'sealed'), type)
        .toEqual([{ kind: 'envelope', rule: 'gated', surface: type, field: 'sealed', capability: 'sealed-payload-v1', advertisedBy }]);
      expect(requiredReceiverCapabilities(type, sealedLine(type))).toContain('sealed-payload-v1');
    }
    for (const type of ['task.offer', 'task.offer_with_toolsets', 'task.offer_for_agent', 'task.offer_for_agent_with_egress', 'task.offer_for_agent_with_egress_fresh'] as const) {
      expect(requiredReceiverCapabilities(type, { sealing: {} })).toContain('sealed-payload-v1');
    }
  });

  it('gates the sealed decline codes on the server flag, and not the earlier codes', () => {
    for (const code of SEALED_DECLINE_CODES) {
      expect(requiredReceiverCapabilities('task.decline', { reason: code, code })).toEqual(['sealed-payload-v1']);
      expect(parse('task.decline', { reason: code, code })).toBe(true);
    }
    expect(requiredReceiverCapabilities('task.decline', { reason: 'busy', code: 'agent_home_writer_busy' })).toEqual([]);
  });

  it('leaves a plaintext message ungated', () => {
    for (const type of Object.keys(SEALED_SPLIT_TABLE) as SealedMessageType[]) {
      const plain = corpus.find((line) => line.type === type && line.payload.sealed === undefined && line.payload.sealing === undefined);
      expect(plain, type).toBeDefined();
      expect(requiredReceiverCapabilities(type, plain!.payload)).not.toContain('sealed-payload-v1');
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

function payloadJsonSchema(type: MessageType): Json {
  return z.toJSONSchema(MESSAGE_PAYLOAD_SCHEMAS[type], { io: 'input', unrepresentable: 'any' }) as Json;
}

describe('sealed payload v1: the split table', () => {
  const entries = Object.entries(SEALED_SPLIT_TABLE) as [SealedMessageType, SealedSplitEntry][];

  it('names only current message types, and leaves out what v1 defers (D17)', () => {
    for (const [type] of entries) expect(MESSAGE_TYPES).toContain(type);
    for (const deferred of ['task.offer_prepared', 'agent.input.preparation', 'agent.message.draft', 'agent.message.publish', 'agent.egress.reliable'] as const) {
      expect(isSealedMessageType(deferred), deferred).toBe(false);
    }
  });

  it('classifies every digest, hash and revision field of a sealed message type (D16)', () => {
    for (const [type, entry] of entries) {
      const sealedPaths = (path: string) => path === 'sealed' || path.startsWith('sealed.');
      const found = namedPaths(payloadJsonSchema(type), /digest|hash|revision/i).filter((path) => !sealedPaths(path));
      expect(Object.keys(entry.digests).sort(), `${type}: classify each of these in SEALED_SPLIT_TABLE`).toEqual(found);
    }
  });

  it('keeps each digest rule consistent with the moved and forbidden fields', () => {
    for (const [type, entry] of entries) {
      for (const [path, rule] of Object.entries(entry.digests)) {
        const top = path.split(/[.[]/u)[0]!;
        if (rule === 'sealed') expect(Object.keys(entry.moved), `${type} ${path}`).toContain(top);
        else expect(Object.keys(entry.moved), `${type} ${path}: a plaintext digest must not sit under a moved field`).not.toContain(top);
        if (rule === 'forbidden') expect(entry.forbidden, `${type} ${path}`).toContain(top);
      }
    }
  });

  it('matches each placeholder to the released schema: required fields keep a value, optional ones are absent', () => {
    for (const [type, entry] of entries) {
      const schema = payloadJsonSchema(type);
      const required = (schema.required ?? []) as string[];
      const properties = schema.properties as Json;
      expect(Object.keys(properties), type).toContain('sealed');
      for (const [field, placeholder] of Object.entries(entry.moved)) {
        expect(Object.keys(properties), `${type}.${field}`).toContain(field);
        expect(required.includes(field), `${type}.${field} placeholder ${placeholder}`).toBe(placeholder !== 'absent');
      }
      for (const field of [...entry.identity, ...entry.forbidden]) expect(Object.keys(properties), `${type}.${field}`).toContain(field);
    }
  });
});

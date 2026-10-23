/**
 * The wire's sealed member and core's sealed content agree (#654 E3a).
 *
 * `@byok-sdk/protocol` repeats the header rules because it does not depend on
 * core. This package depends on both, so it proves the two equal: what core
 * seals, the wire schema accepts; what the wire schema accepts, core reads as
 * a header; a field that one rejects, the other rejects too. It also opens
 * every inline sealed line of the v3 golden corpus with the corpus scope key,
 * so those lines are real ciphertext under the binding a receiver rebuilds
 * from the split table.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@byok-sdk/core';
import {
  SEALED_CATEGORIES,
  SEALED_CONTENT_SUITE,
  SEALED_CONTENT_VERSION,
  SealedContentHeaderV1Schema,
  openSealedContent,
  sealContent,
  type SealedBinding,
} from '@byok-sdk/core/sealed-payload';
import {
  SEALED_PAYLOAD_CATEGORIES,
  SEALED_PAYLOAD_SUITE,
  SEALED_PAYLOAD_VERSION,
  SEALED_SPLIT_TABLE,
  SealedPayloadSchema,
  isSealedMessageType,
  isServerToDaemonType,
  createEnvelope,
  isSealedMessageType as isSealedType,
  requiredReceiverCapabilities,
  sealedPayloadPaddedLength,
  type Envelope,
  type MessageType,
} from '@byok-sdk/protocol';

import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { PRODUCT_ID, TENANT_A, createHarness } from './support/harness';

type Json = { [key: string]: unknown };

/** The fixed inputs the golden sealed lines were sealed with. Test data only. */
const GOLDEN_SCOPE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const GOLDEN_TENANT = 'tenant-golden';
const GOLDEN_DEVICE = 'device-golden-1';
const GOLDEN_SCOPE = { scopeId: 'scope-golden-device-1', epoch: 2 };
const GOLDEN_CATEGORIES = ['task-input', 'task-output'] as const;

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; task_id: string; payload: Json });

function bindingOf(line: (typeof corpus)[number]): SealedBinding {
  if (!isSealedMessageType(line.type)) throw new Error(`${line.type} is not sealed`);
  const identity: Record<string, string | number> = { taskId: line.task_id };
  for (const field of SEALED_SPLIT_TABLE[line.type].identity) identity[field] = line.payload[field] as string | number;
  // The receiver binds the Agent from the task it knows, never from this payload.
  const offer = corpus.find((candidate) => candidate.task_id === line.task_id && candidate.payload.sealing !== undefined);
  if (offer === undefined) throw new Error(`no sealed offer for ${line.task_id}`);
  const agentRef = offer.payload.agentRef as SealedBinding['agentRef'] | undefined;
  return {
    tenantId: GOLDEN_TENANT,
    family: line.type,
    direction: isServerToDaemonType(line.type) ? 'server-to-daemon' : 'daemon-to-server',
    identity,
    deviceId: GOLDEN_DEVICE,
    agentRef: agentRef == null ? null : { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision },
    categories: [...GOLDEN_CATEGORIES],
    notAfter: null,
  };
}

function headerOf(member: Json): Json {
  const { ciphertext: _inline, ciphertextRef: _ref, ...header } = member;
  return header;
}

async function sealed(plaintext: JsonObject) {
  return sealContent({
    scopeKey: GOLDEN_SCOPE_KEY,
    scope: { id: GOLDEN_SCOPE.scopeId, epoch: GOLDEN_SCOPE.epoch },
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
    sender: 'A'.repeat(43),
    category: 'task-output',
    binding: { ...bindingOf(corpus.find((line) => line.type === 'task.complete' && line.payload.sealed !== undefined)!) },
    plaintext,
    maxContentLength: 2 * 1024 * 1024,
  });
}

describe('sealed payload v1: protocol and core agree', () => {
  it('share the version, suite, categories and padded length', () => {
    expect(SEALED_PAYLOAD_VERSION).toBe(SEALED_CONTENT_VERSION);
    expect(SEALED_PAYLOAD_SUITE).toBe(SEALED_CONTENT_SUITE);
    expect(SEALED_PAYLOAD_CATEGORIES).toEqual(SEALED_CATEGORIES);
  });

  it('accept what core seals, inline and by reference, at every padding step', async () => {
    for (const length of [0, 1, 200, 16 * 1024, 16 * 1024 + 1, 256 * 1024 - 64, 256 * 1024 + 1]) {
      const content = await sealed({ summary: 'x'.repeat(length) });
      expect(content.header.paddedLength).toBe(sealedPayloadPaddedLength(4 + `{"summary":"${'x'.repeat(length)}"}`.length));
      const inline = content.header.paddedLength <= 256 * 1024;
      const member = inline
        ? { ...content.header, ciphertext: Buffer.from(content.ciphertext).toString('base64url') }
        : {
            ...content.header,
            ciphertextRef: { blobId: 'blob-1', contentHash: `sha256:${'0'.repeat(64)}`, size: content.ciphertext.byteLength, contentType: 'application/octet-stream' },
          };
      expect(SealedPayloadSchema.safeParse(member).success, `content ${length}`).toBe(true);
    }
  });

  it('reject the same malformed header fields', async () => {
    const content = await sealed({ summary: 'short' });
    const member = { ...content.header, ciphertext: Buffer.from(content.ciphertext).toString('base64url') };
    expect(SealedContentHeaderV1Schema.safeParse(headerOf(member)).success).toBe(true);
    const mutations: [string, Json][] = [
      ['v', { v: 2 }],
      ['suite', { suite: 'x' }],
      ['category', { category: 'task' }],
      ['scope.epoch', { scope: { ...content.header.scope, epoch: 0 } }],
      ['scope.keyId', { scope: { ...content.header.scope, keyId: 'x' } }],
      ['chainHead.hash', { chainHead: { ...content.header.chainHead, hash: 'sha256:00' } }],
      ['sender', { sender: 'x' }],
      ['salt', { salt: 'AA' }],
      ['nonce', { nonce: `${content.header.nonce}AA` }],
      ['paddedLength', { paddedLength: 257 }],
      ['contentMac', { contentMac: 'hmac-sha256:00' }],
    ];
    for (const [field, change] of mutations) {
      expect(SealedPayloadSchema.safeParse({ ...member, ...change }).success, `protocol ${field}`).toBe(false);
      expect(SealedContentHeaderV1Schema.safeParse(headerOf({ ...member, ...change })).success, `core ${field}`).toBe(false);
    }
  });
});

describe('sealed payload v1: the golden corpus lines are real ciphertext', () => {
  const inline = corpus.filter((line) => (line.payload.sealed as Json | undefined)?.ciphertext !== undefined);

  it('covers every sealed message type', () => {
    expect(new Set(inline.map((line) => line.type))).toEqual(new Set(Object.keys(SEALED_SPLIT_TABLE)));
  });

  it.each(inline.map((line, index) => [index, line.type, line] as const))(
    'line %i (%s) opens under the binding the split table names',
    async (_index, _type, line) => {
      const member = line.payload.sealed as Json;
      const ciphertext = new Uint8Array(Buffer.from(member.ciphertext as string, 'base64url'));
      const opened = await openSealedContent({
        header: headerOf(member),
        ciphertext,
        scopeKey: GOLDEN_SCOPE_KEY,
        binding: bindingOf(line),
        sealing: GOLDEN_SCOPE,
        maxContentLength: 2 * 1024 * 1024,
      });
      expect(opened.ok).toBe(true);
      const type = line.type;
      if (!opened.ok || !isSealedMessageType(type)) return;
      expect(Object.keys(opened.plaintext).every((field) => field in SEALED_SPLIT_TABLE[type].moved), 'only moved fields are sealed').toBe(true);

      const moved = await openSealedContent({
        header: headerOf(member),
        ciphertext,
        scopeKey: GOLDEN_SCOPE_KEY,
        binding: { ...bindingOf(line), identity: { taskId: `${line.task_id}-other` } },
        sealing: GOLDEN_SCOPE,
        maxContentLength: 2 * 1024 * 1024,
      });
      expect(moved, 'the Host cannot move a sealed member to another task').toEqual({ ok: false, reason: 'sealed_open_failed' });
    },
  );
});

describe('sealed payload v1: a Host without sealed-payload-v1 refuses sealed input (#654)', () => {
  const sealedInbound = corpus.filter((line) => !isServerToDaemonType(line.type)
    && requiredReceiverCapabilities(line.type, line.payload).includes('sealed-payload-v1'));

  it('covers every daemon-to-server sealed type and every sealed decline code', () => {
    expect(new Set(sealedInbound.map((line) => line.type))).toEqual(
      new Set(Object.keys(SEALED_SPLIT_TABLE).filter((type) => isSealedType(type) && !isServerToDaemonType(type))),
    );
    expect(sealedInbound.filter((line) => line.payload.sealed === undefined).map((line) => line.payload.code).sort())
      .toEqual(['sealed_content_mac_mismatch', 'sealed_key_unavailable', 'sealed_open_failed', 'sealing_policy_mismatch']);
  });

  it.each(sealedInbound.map((line, index) => [index, line.type, line] as const))(
    'line %i (%s) is rejected before the envelope identity is reserved',
    async (_index, _type, line) => {
      const harness = createHarness();
      const device = await harness.pairDevice(TENANT_A);
      const stores = tenantStoresFor(
        { kind: 'device', tenantId: TENANT_A, productId: PRODUCT_ID, deviceId: device.deviceId },
        { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
      );
      const envelope = createEnvelope(line.type as Envelope['type'], line.payload as never, { taskId: line.task_id }) as Envelope;

      const refused = { outcome: 'rejected', reason: 'sealed_payload_unsupported' };
      expect(await handleInboundEnvelope(stores, device.deviceId, envelope)).toEqual(refused);
      // The refusal reserved no envelope identity: the same envelope is refused again, not deduplicated.
      expect(await handleInboundEnvelope(stores, device.deviceId, envelope)).toEqual(refused);
    },
  );
});

/**
 * The wire's sealed member and core's sealed content agree (#654 E3a).
 *
 * `@byok-sdk/protocol` repeats the header rules because it does not depend on
 * core. This package depends on both, so it proves the two equal: what core
 * seals, the wire schema accepts; what the wire schema accepts, core reads as
 * a header; a field that one rejects, the other rejects too. It also opens
 * every inline sealed line of the v4 golden corpus with the corpus scope key,
 * so those lines are real ciphertext under the binding a receiver rebuilds
 * from the split table.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

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
  TaskOfferSealedPayloadSchema,
  TaskSealingSchema,
  isSealableMessageType,
  isSealedPayload,
  isServerToDaemonType,
  createEnvelope,
  requiredReceiverCapabilities,
  sealedPayloadPaddedLength,
  type Envelope,
  type MessageType,
} from '@byok-sdk/protocol';

import { SealedAgentExecutionInputSchema } from '../index';
import type {
  SealedAgentDispatchInput,
  SealedAgentEgressDispatchInput,
  SealedAgentExecutionInput,
} from '../index';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { PRODUCT_ID, TENANT_A, TEST_AGENT_REF, createHarness, grantAgentHome, offerPayload } from './support/harness';

type Json = { [key: string]: unknown };

/** The fixed inputs the golden sealed lines were sealed with. Test data only. */
const GOLDEN_SCOPE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const GOLDEN_TENANT = 'tenant-golden';
const GOLDEN_DEVICE = 'device-golden-1';
const GOLDEN_SCOPE = { scopeId: 'scope-golden-device-1', epoch: 2 };

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; task_id: string; ts: string; payload: Json });

const isSealedLine = (line: (typeof corpus)[number]) => isSealedPayload(line.type, line.payload);

function bindingOf(line: (typeof corpus)[number]): SealedBinding {
  if (!isSealableMessageType(line.type) || !isSealedLine(line)) throw new Error(`${line.type} is not sealed`);
  const identity: Record<string, string | number> = { taskId: line.task_id };
  for (const field of SEALED_SPLIT_TABLE[line.type].identity) identity[field] = line.payload[field] as string | number;
  // The receiver binds the Agent from the task it knows: the offer itself, or
  // for a later message the task's offer, never that message's payload.
  const offer = line.payload.sealing !== undefined
    ? line
    : corpus.find((candidate) => candidate.task_id === line.task_id && candidate.payload.sealing !== undefined);
  if (offer === undefined) throw new Error(`no sealed offer for ${line.task_id}`);
  const agentRef = offer.payload.agentRef as SealedBinding['agentRef'] | undefined;
  const routineRef = line.payload.routineRef as RoutineRef | undefined;
  if (routineRef !== undefined) return templateBinding(line);
  return {
    tenantId: GOLDEN_TENANT,
    family: line.type,
    direction: isServerToDaemonType(line.type) ? 'server-to-daemon' : 'daemon-to-server',
    identity,
    deviceId: GOLDEN_DEVICE,
    agentRef: agentRef == null ? null : { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision },
    categories: [...(offer.payload.sealing as { categories: SealedBinding['categories'] }).categories],
    notAfter: null,
  };
}

type RoutineRef = { routineId: string; definitionVersion: number; notAfter: string };

/**
 * The binding of a routine template (#654 E3d), rebuilt from the offer line's
 * plaintext `routineRef`, `agentRef` and `sealing.categories`. It names no
 * task and no device, so one template opens for every occurrence.
 */
function templateBinding(line: (typeof corpus)[number]): SealedBinding {
  const routineRef = line.payload.routineRef as RoutineRef;
  const agentRef = line.payload.agentRef as NonNullable<SealedBinding['agentRef']>;
  const sealing = line.payload.sealing as { categories: SealedBinding['categories'] };
  return {
    tenantId: GOLDEN_TENANT,
    family: 'routine.template',
    direction: 'server-to-daemon',
    identity: { routineId: routineRef.routineId, definitionVersion: routineRef.definitionVersion },
    deviceId: null,
    agentRef: { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision },
    categories: [...sealing.categories],
    notAfter: routineRef.notAfter,
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
    binding: { ...bindingOf(corpus.find((line) => line.type === 'task.complete' && isSealedLine(line))!) },
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

  it('accept the long scope id that core seals', async () => {
    const id = 's'.repeat(1024);
    const content = await sealContent({
      scopeKey: GOLDEN_SCOPE_KEY,
      scope: { id, epoch: GOLDEN_SCOPE.epoch },
      chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
      sender: 'A'.repeat(43),
      category: 'task-output',
      binding: { ...bindingOf(corpus.find((line) => line.type === 'task.complete' && isSealedLine(line))!) },
      plaintext: { summary: 'short' },
      maxContentLength: 2 * 1024 * 1024,
    });
    const member = { ...content.header, ciphertext: Buffer.from(content.ciphertext).toString('base64url') };
    expect(SealedContentHeaderV1Schema.safeParse(headerOf(member)).success).toBe(true);
    expect(SealedPayloadSchema.safeParse(member).success).toBe(true);
    expect(TaskSealingSchema.safeParse({ scopeId: id, epoch: GOLDEN_SCOPE.epoch, categories: ['task-output'] }).success).toBe(true);
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

  // A routine template is bound by its routineRef, not by the split table.
  // The routine describe below opens those lines.
  const splitTableLines = inline.filter((line) => line.payload.routineRef === undefined);

  it.each(splitTableLines.map((line, index) => [index, line.type, line] as const))(
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
      if (!opened.ok || !isSealableMessageType(type)) return;
      const moved: readonly string[] = SEALED_SPLIT_TABLE[type].moved;
      expect(Object.keys(opened.plaintext).filter((field) => !moved.includes(field)), 'only moved fields are sealed').toEqual([]);

      const elsewhere = await openSealedContent({
        header: headerOf(member),
        ciphertext,
        scopeKey: GOLDEN_SCOPE_KEY,
        binding: { ...bindingOf(line), identity: { taskId: `${line.task_id}-other` } },
        sealing: GOLDEN_SCOPE,
        maxContentLength: 2 * 1024 * 1024,
      });
      expect(elsewhere, 'the Host cannot move a sealed member to another task').toEqual({ ok: false, reason: 'sealed_open_failed' });

      const underOtherFamily = await openSealedContent({
        header: headerOf(member),
        ciphertext,
        scopeKey: GOLDEN_SCOPE_KEY,
        binding: { ...bindingOf(line), family: line.type === 'task.steer' ? 'task.offer' : 'task.steer' },
        sealing: GOLDEN_SCOPE,
        maxContentLength: 2 * 1024 * 1024,
      });
      expect(underOtherFamily, 'the family is the wire type of the sealed message').toEqual({ ok: false, reason: 'sealed_open_failed' });
    },
  );

  // Each identity field after the task id binds the write on its own: a Host
  // that changes only that field, in the same task, cannot open the member.
  const identityCases = inline.flatMap((line) => (isSealableMessageType(line.type) ? SEALED_SPLIT_TABLE[line.type].identity : [])
    .map((field) => [line.type, field, line] as const));

  it('covers every identity field of the split table', () => {
    expect([...new Set(identityCases.map(([, field]) => field))].sort()).toEqual(['approvalId', 'artifactId', 'cursor', 'messageId', 'seq', 'steerId']);
  });

  it.each(identityCases.map(([type, field, line], index) => [index, type, field, line] as const))(
    'case %i (%s) does not open when only %s changes',
    async (_index, _type, field, line) => {
      const member = line.payload.sealed as Json;
      const binding = bindingOf(line);
      const value = binding.identity[field];
      expect(value, `the binding names ${field}`).toBeDefined();
      const changed = typeof value === 'number' ? value + 1 : `${String(value).slice(0, -1)}${String(value).endsWith('9') ? '8' : '9'}`;
      const opened = await openSealedContent({
        header: headerOf(member),
        ciphertext: new Uint8Array(Buffer.from(member.ciphertext as string, 'base64url')),
        scopeKey: GOLDEN_SCOPE_KEY,
        binding: { ...binding, identity: { ...binding.identity, [field]: changed } },
        sealing: GOLDEN_SCOPE,
        maxContentLength: 2 * 1024 * 1024,
      });
      expect(opened).toEqual({ ok: false, reason: 'sealed_open_failed' });
    },
  );
});

describe('sealed payload v1: a routine template opens under the binding its routineRef names (#654 E3d)', () => {
  const routineLines = corpus.filter((line) => line.payload.routineRef !== undefined);
  const open = (line: (typeof corpus)[number], binding: SealedBinding) => {
    const member = line.payload.sealed as Json;
    return openSealedContent({
      header: headerOf(member),
      ciphertext: new Uint8Array(Buffer.from(member.ciphertext as string, 'base64url')),
      scopeKey: GOLDEN_SCOPE_KEY,
      binding,
      sealing: GOLDEN_SCOPE,
      maxContentLength: 2 * 1024 * 1024,
    });
  };

  // Protocol restates core's canonical instant for `notAfter`. The two rules
  // must accept the same values, or a member and a device disagree on the AAD.
  it.each([
    ['2026-12-31T00:00:00.000Z', true],
    ['2028-02-29T23:59:59.999Z', true],
    ['0000-01-01T00:00:00.000Z', true],
    ['2026-12-31T00:00:00Z', false],
    ['2026-12-31T00:00:00.0000Z', false],
    ['2026-12-31T00:00:00.000+00:00', false],
    ['2026-12-31t00:00:00.000z', false],
    ['2026-12-31 00:00:00.000Z', false],
    ['2027-02-29T00:00:00.000Z', false],
    ['2026-02-30T00:00:00.000Z', false],
    ['2026-12-31T24:00:00.000Z', false],
    ['2026-12-31T00:60:00.000Z', false],
    ['+012026-12-31T00:00:00.000Z', false],
    ['', false],
  ] as const)('notAfter %j: protocol accepts it exactly when core seals with it (%s)', async (notAfter, accepted) => {
    const line = routineLines[0]!;
    const wire = TaskOfferSealedPayloadSchema
      .safeParse({ ...line.payload, routineRef: { ...(line.payload.routineRef as RoutineRef), notAfter } }).success;
    const core = await sealContent({
      scopeKey: GOLDEN_SCOPE_KEY,
      scope: { id: GOLDEN_SCOPE.scopeId, epoch: GOLDEN_SCOPE.epoch },
      chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
      sender: 'A'.repeat(43),
      category: 'task-input',
      binding: { ...bindingOf(line), notAfter },
      plaintext: { instruction: 'Write the daily digest.' },
      maxContentLength: 2 * 1024 * 1024,
    }).then(() => true, () => false);
    expect({ wire, core }).toEqual({ wire: accepted, core: accepted });
  });

  it('has two occurrences of one template, and an expired template', () => {
    const [first, second, expired] = routineLines;
    expect(routineLines).toHaveLength(3);
    expect(second!.task_id).not.toBe(first!.task_id);
    expect(second!.payload.sealed, 'the next occurrence carries the same template bytes').toEqual(first!.payload.sealed);
    expect(second!.payload.routineRef).toEqual(first!.payload.routineRef);
    const { notAfter } = expired!.payload.routineRef as RoutineRef;
    expect(Date.parse(notAfter)).toBeLessThan(Date.parse(expired!.ts));
  });

  it.each(routineLines.map((line) => [line.task_id, line] as const))('%s opens with its instruction only', async (_taskId, line) => {
    const opened = await open(line, bindingOf(line));
    expect(opened).toMatchObject({ ok: true, plaintext: { instruction: 'Write the daily digest.' } });
    if (opened.ok) expect(Object.keys(opened.plaintext)).toEqual(['instruction']);
  });

  it.each(routineLines.map((line) => [line.task_id, line] as const))('%s does not open when one bound field changes', async (_taskId, line) => {
    const binding = bindingOf(line);
    const routineRef = line.payload.routineRef as RoutineRef;
    const changed: Record<string, SealedBinding> = {
      'the task binding of the offer': {
        ...binding, family: 'task.offer',
        identity: { taskId: line.task_id }, deviceId: GOLDEN_DEVICE, notAfter: null,
      },
      'a string definitionVersion': { ...binding, identity: { ...binding.identity, definitionVersion: String(routineRef.definitionVersion) } },
      'another definitionVersion': { ...binding, identity: { ...binding.identity, definitionVersion: routineRef.definitionVersion + 1 } },
      'another routine': { ...binding, identity: { ...binding.identity, routineId: `${routineRef.routineId}-other` } },
      'another notAfter': { ...binding, notAfter: new Date(Date.parse(routineRef.notAfter) + 1).toISOString() },
      'another Agent': { ...binding, agentRef: { ...binding.agentRef!, profileRevision: 'profile-other' } },
      'fewer categories': { ...binding, categories: ['task-input'] },
    };
    for (const [name, other] of Object.entries(changed)) {
      expect(await open(line, other), name).toEqual({ ok: false, reason: 'sealed_open_failed' });
    }
  });
});

describe('sealed payload v1: a task without output sealing refuses sealed output (#654)', () => {
  const sealedInbound = corpus.filter((line) => !isServerToDaemonType(line.type)
    && requiredReceiverCapabilities(line.type, line.payload).some((flag) => flag.startsWith('sealed-payload-')));

  it('covers every daemon-to-server sealed type and every sealed decline code', () => {
    expect(new Set(sealedInbound.filter(isSealedLine).map((line) => line.type))).toEqual(
      new Set(Object.keys(SEALED_SPLIT_TABLE).filter((type) => !isServerToDaemonType(type as MessageType))),
    );
    // The plaintext branch of task.decline carries the sealed failure codes.
    expect(sealedInbound.filter((line) => line.type === 'task.decline' && !isSealedLine(line)).map((line) => line.payload.code).sort())
      .toEqual(['sealed_content_mac_mismatch', 'sealed_key_unavailable', 'sealed_open_failed', 'sealing_policy_mismatch']);
  });

  /** A plaintext task offered to this device, claimed unless the line is a decline. */
  async function plainTask(type: string) {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = tenantStoresFor(
      { kind: 'device', tenantId: TENANT_A, productId: PRODUCT_ID, deviceId: device.deviceId },
      { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
    );
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const { taskId } = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload('plain') });
    const send = (envelopeType: string, payload: unknown) =>
      handleInboundEnvelope(stores, device.deviceId, createEnvelope(envelopeType as Envelope['type'], payload as never, { taskId }) as Envelope);
    if (type !== 'task.decline') {
      expect(await send('task.claim', { deviceId: device.deviceId, runtime: 'pi', agentRef: TEST_AGENT_REF })).toEqual({ outcome: 'accepted' });
    }
    return { harness, taskId, send };
  }

  /**
   * The line without the harness and recovery bindings that this plain task
   * does not have, and with this task's Agent where the type echoes one: a
   * claim, terminal or message must echo the attempt's Agent exactly.
   */
  function unbound(type: MessageType, payload: Json): Json {
    const { agentRef: _agentRef, harnessId: _harnessId, recovery: _recovery, ...rest } = payload;
    return ECHOES_AGENT.includes(type) ? { ...rest, agentRef: TEST_AGENT_REF } : rest;
  }
  const ECHOES_AGENT: readonly MessageType[] = ['task.decline', 'task.complete', 'task.fail', 'task.cancelled', 'agent.message.publish'];

  it.each(sealedInbound.filter(isSealedLine).map((line, index) => [index, line.type, line] as const))(
    'line %i (%s) is rejected before the envelope identity is reserved',
    async (_index, type, line) => {
      const { send } = await plainTask(type);
      const refused = { outcome: 'rejected', reason: 'sealed_payload_unsupported' };
      expect(await send(type, unbound(type, line.payload))).toEqual(refused);
      // The refusal reserved no envelope identity: the same envelope is refused again, not deduplicated.
      expect(await send(type, unbound(type, line.payload))).toEqual(refused);
    },
  );

  it.each(sealedInbound.filter((line) => line.type === 'task.decline' && !isSealedLine(line)).map((line) => [line.payload.code, line] as const))(
    'a plaintext decline with the sealed code %s is accepted, and keeps the code as the terminal cause',
    async (code, line) => {
      const { harness, taskId, send } = await plainTask('task.decline');
      expect(await send('task.decline', { ...line.payload, agentRef: TEST_AGENT_REF })).toEqual({ outcome: 'accepted' });
      expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toMatchObject({ status: 'failed', terminalCause: code });
    },
  );
});

describe('sealed payload v1: each sealed offer variant has its own hosted entry (#654)', () => {
  type Lane = (harness: ReturnType<typeof createHarness>, deviceId: string, payload: never) => Promise<{ envelope: Envelope }>;
  const CONTEXT = { destinationBinding: 'conversation/654/turn/1' };
  const withContext = (payload: { messageEgress?: unknown }) => (payload.messageEgress === undefined ? {} : { agentMessageContext: CONTEXT });
  type Variant = 'sealed resume' | 'sealed egress' | 'sealed execution';
  const variantOf = (payload: Json): Variant => (
    (payload.session as { mode?: unknown } | undefined)?.mode === 'fresh' ? 'sealed execution'
      : payload.egressPolicy === undefined ? 'sealed resume' : 'sealed egress');
  /** Each sealed offer variant: its sealed entry and its plaintext sibling. */
  const lanes: Record<Variant, { sealed: Lane; plain: Lane }> = {
    'sealed resume': {
      sealed: (h, d, payload) => h.cloud.enqueueSealedAgentOffer(TENANT_A, d, { taskId: 'sealed-lane', payload }),
      plain: (h, d, payload) => h.cloud.enqueueAgentOffer(TENANT_A, d, { taskId: 'sealed-lane', payload }),
    },
    'sealed egress': {
      sealed: (h, d, payload) => h.cloud.enqueueSealedAgentEgressOffer(TENANT_A, d, { taskId: 'sealed-lane', payload, ...withContext(payload) }),
      plain: (h, d, payload) => h.cloud.enqueueAgentEgressOffer(TENANT_A, d, { taskId: 'sealed-lane', payload, ...withContext(payload) }),
    },
    'sealed execution': {
      sealed: (h, d, payload) => h.cloud.submitSealedAgentExecution(TENANT_A, { taskId: 'sealed-lane', deviceId: d, payload, ...withContext(payload) }),
      plain: (h, d, payload) => h.cloud.submitAgentExecution(TENANT_A, { taskId: 'sealed-lane', deviceId: d, payload, ...withContext(payload) }),
    },
  };
  const laneLines = corpus.flatMap((line) => (line.type === 'task.offer' && line.payload.sealing !== undefined
    && (variantOf(line.payload) !== 'sealed execution' || line.payload.terminalProjection !== undefined)
    ? [{ ...line, variant: variantOf(line.payload) }] : []));
  // A task that seals only its output keeps a plaintext instruction.
  const outputOnly = laneLines.filter((line) => line.payload.sealed === undefined);

  it('has an output-only line and a sealed-input line for every lane', () => {
    expect(new Set(outputOnly.map((line) => line.variant))).toEqual(new Set(Object.keys(lanes)));
    expect(new Set(laneLines.filter((line) => line.payload.sealed !== undefined).map((line) => line.variant))).toEqual(new Set(Object.keys(lanes)));
  });

  it('exports the sealed lane inputs and the sealed execution schema from the package root', () => {
    const fresh = laneLines.find((line) => line.variant === 'sealed execution')!;
    const input: SealedAgentExecutionInput = SealedAgentExecutionInputSchema.parse({
      taskId: 'sealed-root', deviceId: 'device-root', payload: fresh.payload, ...withContext(fresh.payload as never),
    });
    expect(input.payload.sealing).toEqual(fresh.payload.sealing);
    expectTypeOf<SealedAgentDispatchInput>().toHaveProperty('payload');
    expectTypeOf<SealedAgentEgressDispatchInput>().toHaveProperty('payload');
  });

  it.each(outputOnly.map((line, index) => [index, line.variant, line] as const))(
    'line %i (%s) is enqueued as a task.offer with its sealing, and only to a device with every flag',
    async (_index, variant, line) => {
      const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }), consumeSealed: async () => ({ outcome: 'accepted' }) } });
      const device = await harness.pairDevice(TENANT_A);
      const flags = requiredReceiverCapabilities('task.offer', line.payload);
      await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: flags.filter((flag) => flag !== 'sealed-payload-v1') });
      await expect(lanes[variant].sealed(harness, device.deviceId, line.payload as never)).rejects.toMatchObject({ code: 'agent_capability_missing' });

      await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: flags });
      const enqueued = await lanes[variant].sealed(harness, device.deviceId, line.payload as never);
      expect(enqueued.envelope).toMatchObject({ type: 'task.offer', payload: { sealing: line.payload.sealing, instruction: line.payload.instruction } });
    },
  );

  it.each(laneLines.map((line, index) => [index, line.variant, line] as const))(
    'the plaintext sibling of line %i (%s) refuses its sealed fields before any device read or state',
    async (_index, variant, line) => {
      const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }), consumeSealed: async () => ({ outcome: 'accepted' }) } });
      const device = await harness.pairDevice(TENANT_A);
      await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer', line.payload) });
      const reads = vi.spyOn(harness.stores.devices, 'get');

      await expect(lanes[variant].plain(harness, device.deviceId, line.payload as never)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect(reads).toHaveBeenCalledTimes(0);
      expect(await harness.cloud.readTaskAttempt(TENANT_A, 'sealed-lane')).toBeUndefined();
      const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 });
      expect(page.messages).toEqual([]);
    },
  );

  // The two enqueue lanes take an optional task id. The fresh lane always requires one.
  const enqueueLanes: Partial<Record<Variant, (harness: ReturnType<typeof createHarness>, deviceId: string, payload: never, taskId?: string) => Promise<{ taskId: string }>>> = {
    'sealed resume': (h, d, payload, taskId) => h.cloud.enqueueSealedAgentOffer(TENANT_A, d, { taskId, payload }),
    'sealed egress': (h, d, payload, taskId) =>
      h.cloud.enqueueSealedAgentEgressOffer(TENANT_A, d, { taskId, payload, ...withContext(payload as { messageEgress?: unknown }) }),
  };

  it.each(laneLines.filter((line) => line.variant in enqueueLanes).map((line) => [line.variant, line.payload.sealed === undefined ? 'output only' : 'sealed input', line] as const))(
    '%s (%s) without a taskId: a sealed instruction is refused, because it binds the task id; output-only sealing gets a minted id',
    async (variant, label, line) => {
      const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }), consumeSealed: async () => ({ outcome: 'accepted' }) } });
      const device = await harness.pairDevice(TENANT_A);
      await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer', line.payload) });
      const page = () => harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 });

      if (label === 'sealed input') {
        await expect(enqueueLanes[variant]!(harness, device.deviceId, line.payload as never)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        // A JavaScript caller may pass a value that is not a task id.
        for (const taskId of [null, '']) {
          await expect(enqueueLanes[variant]!(harness, device.deviceId, line.payload as never, taskId as never)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        }
        expect((await page()).messages).toEqual([]);
      } else {
        const enqueued = await enqueueLanes[variant]!(harness, device.deviceId, line.payload as never);
        expect(enqueued.taskId).toMatch(/^task_/u);
        expect((await page()).messages).toHaveLength(1);
      }
    },
  );

  it('checks and enqueues one parsed copy, so a payload that the caller changes during the device read has no effect', async () => {
    const line = laneLines.find((candidate) => candidate.variant === 'sealed resume' && candidate.payload.sealed !== undefined)!;
    const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }), consumeSealed: async () => ({ outcome: 'accepted' }) } });
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer', line.payload) });
    const payload: Json = structuredClone(line.payload);
    const read = harness.stores.devices.get.bind(harness.stores.devices);
    vi.spyOn(harness.stores.devices, 'get').mockImplementation(async (...args) => {
      // A non-resume offer with a selection would need dispatch-selection, which this device lacks.
      payload.session = { mode: 'fresh' };
      payload.dispatchSelection = { lane: 'subscription', runtimeId: 'codex' };
      return read(...args);
    });

    const enqueued = await lanes[line.variant].sealed(harness, device.deviceId, payload as never);

    expect(enqueued.envelope.payload).toEqual(line.payload);
  });

  // A ciphertextRef must name a committed blob of this tenant (E3b). The corpus blob ids name no
  // uploaded blob, so each lane refuses them. `sealed-offer-host.test.ts` covers the accepted path.
  // Each lane line with sealed input, with the ciphertextRef member of the large corpus line of its type.
  const byReference = (Object.keys(lanes) as Variant[]).map((variant) => {
    const line = laneLines.find((candidate) => candidate.variant === variant && candidate.payload.sealed !== undefined)!;
    const large = corpus.find((candidate) => candidate.type === 'task.offer' && candidate.payload.sealing !== undefined
      && variantOf(candidate.payload) === variant && (candidate.payload.sealed as Json | undefined)?.ciphertextRef !== undefined)!;
    return { ...line, payload: { ...line.payload, sealed: large.payload.sealed } };
  });

  it.each(byReference.map((line, index) => [index, line.variant, line] as const))(
    'line %i (%s) by ciphertextRef to a blob that is not uploaded is refused on a device with every flag, before any task or mailbox state',
    async (_index, variant, line) => {
      const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }), consumeSealed: async () => ({ outcome: 'accepted' }) } });
      const device = await harness.pairDevice(TENANT_A);
      await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer', line.payload) });

      await expect(lanes[variant].sealed(harness, device.deviceId, line.payload as never)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect(await harness.cloud.readTaskAttempt(TENANT_A, 'sealed-lane')).toBeUndefined();
      const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 });
      expect(page.messages).toEqual([]);
    },
  );
});

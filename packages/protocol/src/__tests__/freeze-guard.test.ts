import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  MESSAGE_PAYLOAD_SCHEMAS,
  EnvelopeSchema,
  AgentEventSchema,
  KNOWN_AGENT_EVENT_TYPES,
  createEnvelope,
  parseMessage,
  UnknownMessageTypeError,
  EnvelopeValidationError,
  type MessageType,
  type CreateEnvelopeOptions,
} from '../index';

/**
 * FREEZE GUARD — local invariants of the frozen wire, major 3 (docs/protocol.md
 * "Freeze rule"). Release evidence (the retired v2 corpus as a negative
 * oracle, the v3 corpus and registry, and the published-decoder rejection
 * oracle) lives in `compat.test.ts`. This file keeps the checks that need no
 * released decoder:
 *
 *   1. The per-type `task_id`/`seq` requiredness table, typed against
 *      codec.ts's `CreateEnvelopeOptions<T>`.
 *   2. Behavior assertions for the freeze rule's own asymmetry (and the
 *      v3 wire-major cut: v1/v2 envelopes and the schema-less v2
 *      result-document projection are rejected): unknown is
 *      TOLERATED for observability data, FAIL-CLOSED for control/security
 *      data — including that an unrecognized field on an otherwise
 *      well-formed `instruction` blob-ref is rejected outright (`.strict()`),
 *      not silently stripped the way every other payload's unknown field is.
 *   3. A dual-source cross-check between envelope.ts's `envelopeShape()`
 *      calls and codec.ts's `EnvelopeShapeOptions`/`CreateEnvelopeOptions<T>`
 *      — two independently hand-maintained descriptions of the exact same
 *      `task_id`/`seq` requiredness rule (see codec.ts's own doc comment).
 *   4. A dual-authority check between agent-event.ts's hand-maintained
 *      `KNOWN_AGENT_EVENT_TYPES` and `AgentEventSchema`'s own variant `type`
 *      literals.
 */


/** The `task.offer` payload variants probed below (see `offerProbePayload`). */
const OFFER_PROBE_VARIANTS = ['resume', 'fresh', 'prepared'] as const;

// ---------------------------------------------------------------------------
// Part 1 — the task_id/seq requiredness table (checked in Part 3)
// ---------------------------------------------------------------------------

/**
 * Per-type `task_id`/`seq` requiredness, restated by hand here as a single
 * readable table. This same table is used two ways below:
 *
 *   - Its VALUE is asserted (in the "dual-source cross-check" describe
 *     block) to equal what `envelope.ts`'s actual `EnvelopeSchema` requires
 *     per type, probed at runtime — catches drift in `envelope.ts`.
 *   - Its TYPE is constrained by `CodecRequirednessMatrix` below, computed
 *     purely from codec.ts's exported `CreateEnvelopeOptions<T>` — catches
 *     drift in codec.ts. A change to either source that isn't mirrored in
 *     the other breaks one of these checks with a pointed compile/runtime
 *     error, not a vague downstream symptom.
 */
function codecRequirednessMatrix(): CodecRequirednessMatrix {
  return {
    'conn.hello': { taskId: 'optional', seq: 'optional' },
    'task.offer': { taskId: 'required', seq: 'required' },
    'agent.egress.reliable': { taskId: 'optional', seq: 'optional' },
    'agent.egress.ack': { taskId: 'optional', seq: 'required' },
    'agent.message.draft': { taskId: 'required', seq: 'optional' },
    'agent.message.publish': { taskId: 'required', seq: 'optional' },
    'agent.message.disposition': { taskId: 'required', seq: 'required' },
    'agent.content.read': { taskId: 'optional', seq: 'required' },
    'agent.content.receipt': { taskId: 'optional', seq: 'optional' },
    'agent.home.projection': { taskId: 'optional', seq: 'required' },
    'agent.input.preparation': { taskId: 'optional', seq: 'required' },
    'provider.provisioning.available': { taskId: 'optional', seq: 'required' },
    'agent.memory.intent.available': { taskId: 'optional', seq: 'required' },
    'e2ee.key_package.available': { taskId: 'optional', seq: 'required' },
    'task.approve': { taskId: 'required', seq: 'required' },
    'task.reject': { taskId: 'required', seq: 'required' },
    'task.cancel': { taskId: 'required', seq: 'required' },
    'task.steer': { taskId: 'required', seq: 'required' },
    'task.claim': { taskId: 'required', seq: 'optional' },
    'task.started': { taskId: 'required', seq: 'optional' },
    'task.decline': { taskId: 'required', seq: 'optional' },
    'task.progress': { taskId: 'required', seq: 'optional' },
    'task.artifact': { taskId: 'required', seq: 'optional' },
    'task.await_approval': { taskId: 'required', seq: 'optional' },
    'task.complete': { taskId: 'required', seq: 'optional' },
    'task.fail': { taskId: 'required', seq: 'optional' },
    'task.cancelled': { taskId: 'required', seq: 'optional' },
    'task.approval_resolved': { taskId: 'required', seq: 'optional' },
  };
}

/** `object extends Pick<T, K>` is true iff `K` is optional on `T` — the exact idiom codec.ts's own (unexported) `RequiredKeys<T>` uses internally. Re-declared locally so this file can apply it to codec.ts's *exported* `CreateEnvelopeOptions<T>` without needing codec.ts to export anything new. */
type IsRequiredKey<T, K extends keyof T> = object extends Pick<T, K> ? false : true;

/** `'required'` when `K` is a required key of `CreateEnvelopeOptions<T>`, `'optional'` otherwise. */
type FieldRequiredness<T extends MessageType, K extends 'taskId' | 'seq'> =
  IsRequiredKey<CreateEnvelopeOptions<T>, K> extends true ? 'required' : 'optional';

/**
 * Computed purely from codec.ts's exported `CreateEnvelopeOptions<T>` — the
 * compile-time half of the dual-source cross-check. Deliberately written as
 * an explicit 16-key literal type with `T` substituted directly at each
 * usage, NOT as a mapped type over `MessageType` (`{[T in MessageType]:
 * ...}`) and NOT through a second generic alias parameterized over `T`:
 * both of those were empirically confirmed (isolated repro, outside this
 * file) to under-resolve `FieldRequiredness`'s nested conditional for
 * roughly half of all keys — TypeScript doesn't always push a mapped
 * type's own per-member substitution deep enough through an indexed access
 * (`EnvelopeShapeOptions[T]`, inside codec.ts's `CreateEnvelopeOptions<T>`)
 * before evaluating an enclosing conditional type, silently defaulting the
 * ternary to its `true` branch instead of erroring — so it must be spelled
 * out per type here for the check to be trustworthy rather than silently
 * inert.
 */
type CodecRequirednessMatrix = {
  'conn.hello': { taskId: FieldRequiredness<'conn.hello', 'taskId'>; seq: FieldRequiredness<'conn.hello', 'seq'> };
  'task.offer': { taskId: FieldRequiredness<'task.offer', 'taskId'>; seq: FieldRequiredness<'task.offer', 'seq'> };
  'agent.egress.reliable': {
    taskId: FieldRequiredness<'agent.egress.reliable', 'taskId'>;
    seq: FieldRequiredness<'agent.egress.reliable', 'seq'>;
  };
  'agent.egress.ack': {
    taskId: FieldRequiredness<'agent.egress.ack', 'taskId'>;
    seq: FieldRequiredness<'agent.egress.ack', 'seq'>;
  };
  'agent.message.draft': {
    taskId: FieldRequiredness<'agent.message.draft', 'taskId'>;
    seq: FieldRequiredness<'agent.message.draft', 'seq'>;
  };
  'agent.message.publish': {
    taskId: FieldRequiredness<'agent.message.publish', 'taskId'>;
    seq: FieldRequiredness<'agent.message.publish', 'seq'>;
  };
  'agent.message.disposition': {
    taskId: FieldRequiredness<'agent.message.disposition', 'taskId'>;
    seq: FieldRequiredness<'agent.message.disposition', 'seq'>;
  };
  'agent.content.read': {
    taskId: FieldRequiredness<'agent.content.read', 'taskId'>;
    seq: FieldRequiredness<'agent.content.read', 'seq'>;
  };
  'agent.content.receipt': {
    taskId: FieldRequiredness<'agent.content.receipt', 'taskId'>;
    seq: FieldRequiredness<'agent.content.receipt', 'seq'>;
  };
  'agent.home.projection': {
    taskId: FieldRequiredness<'agent.home.projection', 'taskId'>;
    seq: FieldRequiredness<'agent.home.projection', 'seq'>;
  };
  'agent.input.preparation': {
    taskId: FieldRequiredness<'agent.input.preparation', 'taskId'>;
    seq: FieldRequiredness<'agent.input.preparation', 'seq'>;
  };
  'provider.provisioning.available': {
    taskId: FieldRequiredness<'provider.provisioning.available', 'taskId'>;
    seq: FieldRequiredness<'provider.provisioning.available', 'seq'>;
  };
  'agent.memory.intent.available': {
    taskId: FieldRequiredness<'agent.memory.intent.available', 'taskId'>;
    seq: FieldRequiredness<'agent.memory.intent.available', 'seq'>;
  };
  'e2ee.key_package.available': {
    taskId: FieldRequiredness<'e2ee.key_package.available', 'taskId'>;
    seq: FieldRequiredness<'e2ee.key_package.available', 'seq'>;
  };
  'task.approve': { taskId: FieldRequiredness<'task.approve', 'taskId'>; seq: FieldRequiredness<'task.approve', 'seq'> };
  'task.reject': { taskId: FieldRequiredness<'task.reject', 'taskId'>; seq: FieldRequiredness<'task.reject', 'seq'> };
  'task.cancel': { taskId: FieldRequiredness<'task.cancel', 'taskId'>; seq: FieldRequiredness<'task.cancel', 'seq'> };
  'task.steer': { taskId: FieldRequiredness<'task.steer', 'taskId'>; seq: FieldRequiredness<'task.steer', 'seq'> };
  'task.claim': { taskId: FieldRequiredness<'task.claim', 'taskId'>; seq: FieldRequiredness<'task.claim', 'seq'> };
  'task.started': { taskId: FieldRequiredness<'task.started', 'taskId'>; seq: FieldRequiredness<'task.started', 'seq'> };
  'task.decline': { taskId: FieldRequiredness<'task.decline', 'taskId'>; seq: FieldRequiredness<'task.decline', 'seq'> };
  'task.progress': { taskId: FieldRequiredness<'task.progress', 'taskId'>; seq: FieldRequiredness<'task.progress', 'seq'> };
  'task.artifact': { taskId: FieldRequiredness<'task.artifact', 'taskId'>; seq: FieldRequiredness<'task.artifact', 'seq'> };
  'task.await_approval': {
    taskId: FieldRequiredness<'task.await_approval', 'taskId'>;
    seq: FieldRequiredness<'task.await_approval', 'seq'>;
  };
  'task.complete': { taskId: FieldRequiredness<'task.complete', 'taskId'>; seq: FieldRequiredness<'task.complete', 'seq'> };
  'task.fail': { taskId: FieldRequiredness<'task.fail', 'taskId'>; seq: FieldRequiredness<'task.fail', 'seq'> };
  'task.cancelled': { taskId: FieldRequiredness<'task.cancelled', 'taskId'>; seq: FieldRequiredness<'task.cancelled', 'seq'> };
  'task.approval_resolved': {
    taskId: FieldRequiredness<'task.approval_resolved', 'taskId'>;
    seq: FieldRequiredness<'task.approval_resolved', 'seq'>;
  };
};

// ---------------------------------------------------------------------------
// Part 2 — behavior assertions: the freeze rule's tolerate/fail-closed split
// ---------------------------------------------------------------------------

describe('freeze guard: behavior assertions (unknown tolerance vs. fail-closed)', () => {
  it('an unrecognized message type throws UnknownMessageTypeError — distinctly skippable from a validation failure', () => {
    const raw = {
      v: PROTOCOL_VERSION,
      id: '00000000-0000-4000-8000-000000000101',
      ts: '2026-01-01T00:00:00.000Z',
      type: 'task.some_future_type',
      task_id: 'task-1',
      payload: {},
    };
    expect(() => parseMessage(raw)).toThrow(UnknownMessageTypeError);
  });

  it('an unknown top-level envelope field is silently stripped, not rejected (forward-compat, §1)', () => {
    const envelope = createEnvelope('task.started', {}, { taskId: 'task-1' });
    const withExtra = { ...envelope, futureTopLevelField: 'from a newer minor version' };
    const parsed = parseMessage(withExtra);
    expect('futureTopLevelField' in parsed).toBe(false);
    expect(parsed.type).toBe('task.started');
  });

  it('an unknown AgentEvent variant inside a task.progress batch is tolerated, not rejected (observability data)', () => {
    const envelope = createEnvelope(
      'task.progress',
      {
        seq: 1,
        events: [
          { type: 'progress', text: 'hi' },
          { type: 'plan_update', step: 1, of: 3 },
        ],
      },
      { taskId: 'task-1' },
    );
    const parsed = parseMessage(envelope);
    if (parsed.type !== 'task.progress') throw new Error('unreachable');
    if (parsed.payload.sealed !== undefined) throw new Error('unreachable');
    expect(parsed.payload.events).toHaveLength(2);
    expect(parsed.payload.events[1]).toEqual({ type: 'plan_update', step: 1, of: 3 });
  });

  it('an unknown capability flag is accepted, not a distinct type (conn.hello.capabilities is a bare string[])', () => {
    const hello = MESSAGE_PAYLOAD_SCHEMAS['conn.hello'].safeParse({
      protocolVersions: [1],
      capabilities: ['steer', 'some-future-capability-flag'],
      deviceId: 'device-1',
      productId: 'acme-agent',
    });
    expect(hello.success).toBe(true);
  });

  it('an unknown `instruction` shape is REJECTED, fail-closed (control/security data, not observability)', () => {
    const result = MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse({
      agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
      session: { mode: 'resume', sessionRef: 'session-1' },
      instruction: { someFutureShape: true }, // neither a plain string nor { blobRef }
    });
    expect(result.success).toBe(false);
  });

  it('an unknown field alongside an otherwise well-formed `instruction.blobRef` is REJECTED, fail-closed (same `.strict()` asymmetry applied to the blob-ref instruction variant)', () => {
    const result = MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse({
      agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
      session: { mode: 'resume', sessionRef: 'session-1' },
      instruction: {
        blobRef: {
          blobId: 'blob-1',
          contentHash: `sha256:${'a'.repeat(64)}`,
          size: 10,
          contentType: 'text/plain',
        },
        futureControlField: 'from a hypothetical future variant',
      },
    });
    expect(result.success).toBe(false);
  });

  it('the current wire major is 4', () => {
    expect(PROTOCOL_VERSION).toBe(4);
    expect(createEnvelope('task.started', {}, { taskId: 'task-1' }).v).toBe(4);
  });

  it.each([1, 2, 3])('a v%i envelope is REJECTED: there is no v1, v2 or v3 reader', (v) => {
    const envelope = createEnvelope('task.started', {}, { taskId: 'task-1' });
    expect(() => parseMessage({ ...envelope, v })).toThrow(EnvelopeValidationError);
  });

  it.each(OFFER_PROBE_VARIANTS)('a strict task.offer (%s variant) whose result-document projection lacks `schema` (the v2 shape) is REJECTED', (variant) => {
    const type = 'task.offer' as const;
    const payload = offerProbePayload(variant);
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    const v3 = { ...payload, terminalProjection: { mode: 'result-document', contract: 'example.answer.v1', schema } };
    expect(MESSAGE_PAYLOAD_SCHEMAS[type].safeParse(v3).success).toBe(true);
    const v2Shape = { ...payload, terminalProjection: { mode: 'result-document', contract: 'example.answer.v1' } };
    expect(MESSAGE_PAYLOAD_SCHEMAS[type].safeParse(v2Shape).success).toBe(false);
    const outsideSubset = { ...payload, terminalProjection: { mode: 'result-document', contract: 'example.answer.v1', schema: { ...schema, $defs: {} } } };
    expect(MESSAGE_PAYLOAD_SCHEMAS[type].safeParse(outsideSubset).success).toBe(false);
    const raw = { v: PROTOCOL_VERSION, id: '00000000-0000-4000-8000-000000000103', ts: '2026-01-01T00:00:00.000Z', type, task_id: 'task-1', seq: 1, payload: v2Shape };
    expect(() => parseMessage(raw)).toThrow(EnvelopeValidationError);
  });

  it.each(OFFER_PROBE_VARIANTS)('a strict task.offer (%s variant) that still carries the removed `policy` is REJECTED, not stripped', (variant) => {
    const type = 'task.offer' as const;
    const payload = offerProbePayload(variant);
    expect(MESSAGE_PAYLOAD_SCHEMAS[type].safeParse(payload).success).toBe(true);
    const removedPolicy = { mode: 'auto' };
    const withPolicy = { ...payload, policy: removedPolicy };
    expect(MESSAGE_PAYLOAD_SCHEMAS[type].safeParse(withPolicy).success).toBe(false);
    const raw = { v: PROTOCOL_VERSION, id: '00000000-0000-4000-8000-000000000102', ts: '2026-01-01T00:00:00.000Z', type, task_id: 'task-1', seq: 1, payload: withPolicy };
    expect(() => parseMessage(raw)).toThrow(EnvelopeValidationError);
  });

  it('an agent.input.preparation that still carries the removed `permissionMode` is REJECTED (strict)', () => {
    const payload = minimalPayloadForProbe('agent.input.preparation') as Record<string, unknown>;
    expect(MESSAGE_PAYLOAD_SCHEMAS['agent.input.preparation'].safeParse(payload).success).toBe(true);
    const removedMode = 'auto';
    expect(MESSAGE_PAYLOAD_SCHEMAS['agent.input.preparation'].safeParse({ ...payload, permissionMode: removedMode }).success).toBe(false);
  });

  it('a task.* envelope missing task_id is still rejected, even with every other field present', () => {
    const envelope = createEnvelope('task.started', {}, { taskId: 'task-1' });
    const { task_id: _taskId, ...withoutTaskId } = envelope;
    expect(EnvelopeSchema.safeParse(withoutTaskId).success).toBe(false);
    expect(() => parseMessage(withoutTaskId)).toThrow(EnvelopeValidationError);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — dual-source cross-check: envelope.ts vs. codec.ts requiredness
// ---------------------------------------------------------------------------

/** The `task.offer` payload variants the four Agent offer types became: resume, fresh with egress, prepared. */
function offerProbePayload(variant: (typeof OFFER_PROBE_VARIANTS)[number]): Record<string, unknown> {
  const agentRef = { agentId: 'agent-1', profileRevision: 'rev-1' };
  const egressPolicy = {
    policyRevision: 'policy-r1',
    activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
    reliable: { maxPendingEventsPerAgent: 1, maxPendingBytesPerAgent: 1, maxPendingBytesPerTenant: 1 },
    transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
  };
  switch (variant) {
    case 'resume':
      return { instruction: 'run for agent', agentRef, session: { mode: 'resume', sessionRef: 'session-1' } };
    case 'fresh':
      return { instruction: 'start with egress', agentRef, session: { mode: 'fresh' }, egressPolicy };
    case 'prepared':
      return {
        agentMemory: 'none',
        egressPolicy,
        agentRef,
        session: { mode: 'fresh' },
        preparation: { reference: 'prep-record-1', requestDigest: 'request-digest-1' },
      };
  }
}

/** Minimal-but-schema-valid payload per type, used only to probe `EnvelopeSchema`'s own requiredness at runtime — self-contained (not imported from another test file), matching this repo's existing test-file convention. */
function minimalPayloadForProbe(type: MessageType): unknown {
  switch (type) {
    case 'conn.hello':
      return { protocolVersions: [PROTOCOL_VERSION], capabilities: [], deviceId: 'device-1', productId: 'acme-agent' };
    case 'task.offer':
      return offerProbePayload('resume');
    case 'agent.egress.reliable':
      return {
        agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
        sessionRef: 'session-1',
        policyRevision: 'policy-r1',
        eventId: '00000000-0000-4000-8000-000000000021',
        cursor: 1,
        payload: { state: 'running' },
        contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        byteCount: 19,
      };
    case 'agent.egress.ack':
      return {
        agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
        sessionRef: 'session-1',
        policyRevision: 'policy-r1',
        eventId: '00000000-0000-4000-8000-000000000021',
        cursor: 1,
        receiptId: '00000000-0000-4000-8000-000000000022',
      };
    case 'agent.message.draft':
      return { agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' }, revision: 1, offset: 0, text: 'hello' };
    case 'agent.message.publish':
      return {
        agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
        sessionRef: 'session-1',
        contract: 'chat.v1',
        messageId: '00000000-0000-4000-8000-000000000025',
        cursor: 1,
        contentType: 'text/plain',
        body: 'hello',
        contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        byteCount: 5,
      };
    case 'agent.message.disposition':
      return {
        agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
        sessionRef: 'session-1',
        contract: 'chat.v1',
        messageId: '00000000-0000-4000-8000-000000000025',
        cursor: 1,
        contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        outcome: 'accepted',
        receiptId: '00000000-0000-4000-8000-000000000026',
      };
    case 'agent.content.read':
      return {
        requestId: '00000000-0000-4000-8000-000000000023',
        surface: 'workspace',
        actor: { kind: 'user', id: 'actor-1' },
        agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
        sessionRef: 'session-1',
        runtime: 'pi',
        cwd: '/agents/agent-1',
        policyRevision: 'policy-r1',
        target: 'notes/today.md',
        mimeType: 'text/plain',
        decodeAs: 'utf8',
        policy: { maxBytes: 64, allowedMimeTypes: ['text/plain'] },
      };
    case 'agent.content.receipt':
      return {
        requestId: '00000000-0000-4000-8000-000000000023',
        eventId: '00000000-0000-4000-8000-000000000023',
        cursor: 2,
        surface: 'workspace',
        actor: { kind: 'user', id: 'actor-1' },
        agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
        sessionRef: 'session-1',
        runtime: 'pi',
        cwd: '/agents/agent-1',
        policyRevision: 'policy-r1',
        target: 'notes/today.md',
        mimeType: 'text/plain',
        decodeAs: 'utf8',
        decision: 'denied',
        byteCount: 0,
        reason: 'policy-disabled',
      };
    case 'agent.home.projection':
      return {
        requestId: '00000000-0000-4000-8000-000000000024',
        agentRef: { agentId: 'agent-1', profileRevision: '1' },
        projectionHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        projection: { schemaVersion: 'opaque.v1', name: 'Agent' },
      };
    case 'agent.input.preparation':
      return {
        agentMemory: 'none',
        requestId: '00000000-0000-4000-8000-000000000025',
        agentRef: { agentId: 'agent-1', profileRevision: '1' },
        profileId: 'profile-1',
        policyRevision: 'limits-r1',
        source: { revision: 'src-r1', digest: 'sha256:src' },
        selection: {
          model: {
            id: 'model-1',
            name: 'Model One',
            api: 'openai-completions',
            provider: 'provider-1',
            baseUrl: 'https://provider.example/v1',
            reasoning: false,
            input: ['text'],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
          options: { cacheRetention: 'none', maxTokens: 1024 },
        },
        deadlineAt: '2026-01-01T00:00:30.000Z',
        context: { inline: '{"prompt":{},"messages":[]}' },
        requiredToolsets: ['team'],
      };
    case 'provider.provisioning.available':
      return { requestId: '00000000-0000-4000-8000-000000000026' };
    case 'agent.memory.intent.available':
      return { intentId: '00000000-0000-4000-8000-000000000027', agentRef: { agentId: 'agent-1', profileRevision: '7' } };
    case 'e2ee.key_package.available':
      return { scopeId: 'scope-1', epoch: 1 };
    case 'task.approve':
      return { approvalId: 'approval-1' };
    case 'task.reject':
      return { approvalId: 'approval-1' };
    case 'task.cancel':
      return {};
    case 'task.steer':
      return { text: 'hi' };
    case 'task.claim':
      return { deviceId: 'device-1' };
    case 'task.started':
      return {};
    case 'task.decline':
      return { reason: 'no compatible runtime' };
    case 'task.progress':
      return { seq: 1, events: [] };
    case 'task.artifact':
      return { name: 'a.txt', contentType: 'text/plain' };
    case 'task.await_approval':
      return { summary: 'about to do a thing', approvalId: 'approval-1' };
    case 'task.complete':
      return { summary: 'done', sessionRef: 'sess-1' };
    case 'task.fail':
      return { reason: 'boom' };
    case 'task.cancelled':
      return {};
    case 'task.approval_resolved':
      return { approvalId: 'appr-1', decision: 'approve', resolvedBy: 'local', at: '2026-01-01T00:00:00.000Z' };
    default: {
      const exhaustive: never = type;
      throw new Error(`no minimal payload fixture for message type: ${String(exhaustive)}`);
    }
  }
}

/** A fully-populated (task_id + seq both present) envelope for `type` — used to isolate one field's requiredness at a time by stripping just that field and re-checking `EnvelopeSchema.safeParse`. */
function fullEnvelopeFor(type: MessageType): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    id: '00000000-0000-4000-8000-000000000099',
    ts: '2026-01-01T00:00:00.000Z',
    type,
    seq: 1,
    payload: minimalPayloadForProbe(type),
  };
  if (
    type !== 'agent.home.projection' &&
    type !== 'agent.input.preparation' &&
    type !== 'provider.provisioning.available' &&
    type !== 'agent.memory.intent.available' &&
    type !== 'e2ee.key_package.available'
  ) {
    envelope.task_id = 'task-1';
  }
  return envelope;
}

/** The runtime half of the dual-source cross-check: what `envelope.ts`'s actual `EnvelopeSchema` requires per type, probed directly (not read from any hand-maintained table). */
function runtimeRequirednessMatrix(): Record<MessageType, { taskId: 'required' | 'optional'; seq: 'required' | 'optional' }> {
  const result = {} as Record<MessageType, { taskId: 'required' | 'optional'; seq: 'required' | 'optional' }>;
  for (const type of MESSAGE_TYPES) {
    const full = fullEnvelopeFor(type);

    const { task_id: _taskId, ...withoutTaskId } = full;
    const taskIdRequired = !EnvelopeSchema.safeParse(withoutTaskId).success;

    const { seq: _seq, ...withoutSeq } = full;
    const seqRequired = !EnvelopeSchema.safeParse(withoutSeq).success;

    result[type] = { taskId: taskIdRequired ? 'required' : 'optional', seq: seqRequired ? 'required' : 'optional' };
  }
  return result;
}

describe('freeze guard: dual-source cross-check (envelope.ts vs. codec.ts)', () => {
  it('every fully-populated envelope validates in the first place (sanity check for the probe below)', () => {
    for (const type of MESSAGE_TYPES) {
      expect(EnvelopeSchema.safeParse(fullEnvelopeFor(type)).success, `full envelope for ${type} must itself validate`).toBe(true);
    }
  });

  it("envelope.ts's actual per-type task_id/seq requiredness matches codec.ts's hand-maintained table exactly", () => {
    // `codecRequirednessMatrix()`'s return TYPE is constrained by
    // `CodecRequirednessMatrix` (computed from codec.ts's exported
    // `CreateEnvelopeOptions<T>`) — this equality check is therefore the
    // RUNTIME half of the cross-check (against envelope.ts); the COMPILE-TIME
    // half (against codec.ts) already ran when this file typechecked, because
    // `codecRequirednessMatrix()`'s body wouldn't compile if its literal
    // values didn't match what `CreateEnvelopeOptions<T>` requires for every
    // T. Together: a drift in EITHER envelope.ts or codec.ts breaks one of
    // these two checks, at the specific type+field that drifted.
    expect(runtimeRequirednessMatrix()).toEqual(codecRequirednessMatrix());
  });
});

// ---------------------------------------------------------------------------
// Part 4 — dual-authority guard: KNOWN_AGENT_EVENT_TYPES vs. AgentEventSchema
// ---------------------------------------------------------------------------

describe('freeze guard: dual-authority cross-check (agent-event.ts)', () => {
  it("KNOWN_AGENT_EVENT_TYPES exactly matches AgentEventSchema's own variant `type` literals", () => {
    // `agent-event.ts` maintains TWO independent descriptions of "what counts
    // as a known AgentEvent": the hand-written `KNOWN_AGENT_EVENT_TYPES` list
    // (consulted by `isKnownAgentEvent`/`partitionAgentEvents`) and
    // `AgentEventSchema`'s own discriminated-union variants (consulted by
    // everything that actually parses an event). The compat suite only proves
    // the schema side against released decoders — it says nothing about
    // whether the hand-written list still agrees with it. Adding a new variant to the schema without also
    // adding its `type` literal to `KNOWN_AGENT_EVENT_TYPES` would NOT be
    // caught there: the new variant would just fall through
    // `isKnownAgentEvent` as "unknown" — a well-formed known event silently
    // misclassified and routed to `partitionAgentEvents`'s `unknown` bucket
    // instead of `known`. This test is the guard for exactly that drift.
    const agentEventJsonSchema = z.toJSONSchema(AgentEventSchema) as unknown as {
      oneOf: Array<{ properties: { type: { const: string } } }>;
    };
    const schemaVariantTypes = agentEventJsonSchema.oneOf.map((branch) => branch.properties.type.const);

    expect(new Set(KNOWN_AGENT_EVENT_TYPES)).toEqual(new Set(schemaVariantTypes));
    // Belt-and-suspenders: also pin the exact count, so a duplicate entry in
    // `KNOWN_AGENT_EVENT_TYPES` masking a missing real one can't hide behind
    // a `Set`-based equality check above (two different-length arrays can
    // still produce equal Sets if one has a duplicate).
    expect(KNOWN_AGENT_EVENT_TYPES.length).toBe(schemaVariantTypes.length);
  });
});

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  CAPABILITY_FLAGS,
  PERMISSION_MODES,
  PermissionPolicySchema,
  TASK_STATES,
  TASK_TRANSITIONS,
  MESSAGE_TYPES,
  MESSAGE_PAYLOAD_SCHEMAS,
  SERVER_TO_DAEMON_TYPES,
  DAEMON_TO_SERVER_TYPES,
  EnvelopeSchema,
  AgentEventSchema,
  AgentEventOrUnknownSchema,
  BlobRefSchema,
  CONTENT_HASH_RE,
  PairRequestSchema,
  PairResponseSchema,
  ChallengeRequestSchema,
  ChallengeResponseSchema,
  TokenRequestSchema,
  TokenResponseSchema,
  CreateBlobRequestSchema,
  CreateBlobResponseSchema,
  BlobDownloadUrlResponseSchema,
  EventsPollQuerySchema,
  EventsPollResponseSchema,
  MessagesSendRequestSchema,
  MessagesSendResponseSchema,
  MAX_MESSAGES_PER_BATCH,
  createEnvelope,
  encodeEnvelope,
  decodeEnvelope,
  parseMessage,
  UnknownMessageTypeError,
  EnvelopeValidationError,
  type MessageType,
  type CreateEnvelopeOptions,
} from '../index';

/**
 * FREEZE GUARD — the regression net for the frozen v1 wire (docs/protocol.md
 * "Freeze rule"). This file is the one committed place that pins down
 * "everything that must never silently change" and gives every diff a
 * concrete, actionable verdict: an additive/optional change regenerates the
 * golden with a justification in the commit message; anything that changes,
 * removes, or retypes an existing frozen shape needs a `PROTOCOL_VERSION`
 * bump instead, per docs/protocol.md's freeze rule — this test's job is only
 * to make that distinction impossible to miss, not to make either call for
 * you.
 *
 * Three independent nets live in this one file:
 *
 *   1. A schema fingerprint snapshot (`buildFrozenSnapshot`) compared against
 *      the committed `golden/v1.frozen.json` — catches ANY structural change
 *      to a frozen schema, however small.
 *   2. A golden NDJSON envelope corpus (`golden/v1.envelopes.ndjson`, one
 *      canonical line per message type) that must keep `decodeEnvelope`-
 *      parsing forever — the actual regression net: real historical wire
 *      bytes a v1 peer already sent, re-played against today's code.
 *   3. Explicit behavior assertions for the freeze rule's own asymmetry:
 *      unknown is TOLERATED for observability data, FAIL-CLOSED for
 *      control/security data (see docs/protocol.md).
 *
 * Plus a dual-source cross-check between envelope.ts's `envelopeShape()`
 * calls and codec.ts's `EnvelopeShapeOptions`/`CreateEnvelopeOptions<T>` —
 * two independently hand-maintained descriptions of the exact same
 * `task_id`/`seq` requiredness rule (see codec.ts's own doc comment) — and a
 * standalone `PROTOCOL_VERSION === 1` pin.
 */

const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));

// ---------------------------------------------------------------------------
// Part 1 — schema fingerprint snapshot
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
 *
 * It's also folded into the golden fingerprint snapshot (Part 1) so a
 * diff against `golden/v1.frozen.json` surfaces a requiredness change too.
 */
function codecRequirednessMatrix(): CodecRequirednessMatrix {
  return {
    'conn.hello': { taskId: 'optional', seq: 'optional' },
    'conn.ack': { taskId: 'optional', seq: 'required' },
    'task.offer': { taskId: 'required', seq: 'required' },
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
  'conn.ack': { taskId: FieldRequiredness<'conn.ack', 'taskId'>; seq: FieldRequiredness<'conn.ack', 'seq'> };
  'task.offer': { taskId: FieldRequiredness<'task.offer', 'taskId'>; seq: FieldRequiredness<'task.offer', 'seq'> };
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
};

/** Builds the current schema fingerprint fresh from the live schemas — compared against the committed `golden/v1.frozen.json`. */
function buildFrozenSnapshot() {
  const payloadSchemas: Record<string, unknown> = {};
  for (const type of MESSAGE_TYPES) {
    payloadSchemas[type] = z.toJSONSchema(MESSAGE_PAYLOAD_SCHEMAS[type]);
  }

  // The AgentEvent variant list, derived from AgentEventSchema's own JSON
  // Schema output (`oneOf[].properties.type.const`) rather than needing
  // agent-event.ts to export its internal KNOWN_AGENT_EVENT_TYPES constant —
  // keeps this file from requiring any change to a frozen source module.
  const agentEventJsonSchema = z.toJSONSchema(AgentEventSchema) as unknown as {
    oneOf: Array<{ properties: { type: { const: string } } }>;
  };
  const agentEventVariants = agentEventJsonSchema.oneOf.map((branch) => branch.properties.type.const);

  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilityFlags: [...CAPABILITY_FLAGS],
    permissionModes: [...PERMISSION_MODES],
    taskStates: [...TASK_STATES],
    taskTransitions: TASK_TRANSITIONS,
    messageTypes: [...MESSAGE_TYPES],
    serverToDaemonTypes: [...SERVER_TO_DAEMON_TYPES],
    daemonToServerTypes: [...DAEMON_TO_SERVER_TYPES],
    agentEventVariants,
    envelopeRequiredness: codecRequirednessMatrix(),
    maxMessagesPerBatch: MAX_MESSAGES_PER_BATCH,
    contentHashPattern: CONTENT_HASH_RE.source,
    payloadSchemas,
    envelopeSchema: z.toJSONSchema(EnvelopeSchema),
    agentEventSchema: z.toJSONSchema(AgentEventSchema),
    agentEventOrUnknownSchema: z.toJSONSchema(AgentEventOrUnknownSchema),
    permissionPolicySchema: z.toJSONSchema(PermissionPolicySchema),
    blobRefSchema: z.toJSONSchema(BlobRefSchema),
    httpApiSchemas: {
      pairRequest: z.toJSONSchema(PairRequestSchema),
      pairResponse: z.toJSONSchema(PairResponseSchema),
      challengeRequest: z.toJSONSchema(ChallengeRequestSchema),
      challengeResponse: z.toJSONSchema(ChallengeResponseSchema),
      tokenRequest: z.toJSONSchema(TokenRequestSchema),
      tokenResponse: z.toJSONSchema(TokenResponseSchema),
      createBlobRequest: z.toJSONSchema(CreateBlobRequestSchema),
      createBlobResponse: z.toJSONSchema(CreateBlobResponseSchema),
      blobDownloadUrlResponse: z.toJSONSchema(BlobDownloadUrlResponseSchema),
      eventsPollQuery: z.toJSONSchema(EventsPollQuerySchema),
      eventsPollResponse: z.toJSONSchema(EventsPollResponseSchema),
      messagesSendRequest: z.toJSONSchema(MessagesSendRequestSchema),
      messagesSendResponse: z.toJSONSchema(MessagesSendResponseSchema),
    },
  };
}

const FREEZE_DIFF_MESSAGE =
  'v1 frozen schema fingerprint drifted from golden/v1.frozen.json. If this diff is purely additive (a new optional field, a new message type, a new AgentEvent variant, a new capability flag), regenerate the golden and say so — with justification — in the commit message. If it changes, removes, or retypes anything that already existed, that is a breaking change and needs a PROTOCOL_VERSION bump instead, per docs/protocol.md "Freeze rule" — do not just regenerate the golden to make this pass.';

describe('freeze guard: v1 schema fingerprint snapshot', () => {
  it('matches the committed golden/v1.frozen.json exactly', () => {
    const fresh = buildFrozenSnapshot();
    const golden = JSON.parse(readFileSync(`${goldenDir}v1.frozen.json`, 'utf8'));
    expect(fresh, FREEZE_DIFF_MESSAGE).toEqual(golden);
  });

  it('PROTOCOL_VERSION is embedded in the fingerprint (a version bump changes this file, forcing a conscious golden bump alongside it)', () => {
    expect(buildFrozenSnapshot().protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — v1 golden envelope corpus: real wire bytes that must keep parsing
// ---------------------------------------------------------------------------

describe('freeze guard: v1 golden envelope corpus (golden/v1.envelopes.ndjson)', () => {
  const raw = readFileSync(`${goldenDir}v1.envelopes.ndjson`, 'utf8');
  const lines = raw.split('\n').filter((line) => line.length > 0);

  it('has exactly one committed line per message type', () => {
    expect(lines.length).toBe(MESSAGE_TYPES.length);
  });

  it.each(lines.map((line, index) => [index, line] as const))(
    'golden line %i decodeEnvelope-parses without throwing',
    (_index, line) => {
      expect(() => decodeEnvelope(line)).not.toThrow();
    },
  );

  it('covers every message type exactly once, and each line round-trips through encode/decode unchanged', () => {
    const seenTypes = new Set<string>();
    for (const line of lines) {
      const envelope = decodeEnvelope(line);
      seenTypes.add(envelope.type);
      const reencoded = encodeEnvelope(envelope);
      expect(decodeEnvelope(reencoded)).toEqual(envelope);
    }
    expect(seenTypes).toEqual(new Set(MESSAGE_TYPES));
  });
});

// ---------------------------------------------------------------------------
// Part 3 — behavior assertions: the freeze rule's tolerate/fail-closed split
// ---------------------------------------------------------------------------

describe('freeze guard: behavior assertions (unknown tolerance vs. fail-closed)', () => {
  it('an unrecognized message type throws UnknownMessageTypeError — distinctly skippable from a validation failure', () => {
    const raw = {
      v: 1,
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
    expect(parsed.payload.events).toHaveLength(2);
    expect(parsed.payload.events[1]).toEqual({ type: 'plan_update', step: 1, of: 3 });
  });

  it('an unknown capability flag is accepted, not a distinct type (both conn.hello.capabilities and conn.ack.capabilities are bare string[])', () => {
    const hello = MESSAGE_PAYLOAD_SCHEMAS['conn.hello'].safeParse({
      protocolVersions: [1],
      capabilities: ['steer', 'some-future-capability-flag'],
      deviceId: 'device-1',
      productId: 'acme-agent',
    });
    expect(hello.success).toBe(true);

    const ack = MESSAGE_PAYLOAD_SCHEMAS['conn.ack'].safeParse({
      protocolVersion: 1,
      capabilities: ['steer', 'some-future-capability-flag'],
      serverTime: '2026-01-01T00:00:00.000Z',
    });
    expect(ack.success).toBe(true);
  });

  it('an unknown `instruction` shape is REJECTED, fail-closed (control/security data, not observability)', () => {
    const result = MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse({
      instruction: { someFutureShape: true }, // neither a plain string nor { blobRef }
      policy: { mode: 'auto' },
    });
    expect(result.success).toBe(false);
  });

  it('an unknown `policy.mode` is REJECTED, fail-closed (control/security data, not observability)', () => {
    const result = PermissionPolicySchema.safeParse({ mode: 'some-future-mode' });
    expect(result.success).toBe(false);
  });

  it('a task.* envelope missing task_id is still rejected, even with every other field present', () => {
    const envelope = createEnvelope('task.started', {}, { taskId: 'task-1' });
    const { task_id: _taskId, ...withoutTaskId } = envelope;
    expect(EnvelopeSchema.safeParse(withoutTaskId).success).toBe(false);
    expect(() => parseMessage(withoutTaskId)).toThrow(EnvelopeValidationError);
  });
});

// ---------------------------------------------------------------------------
// Part 4 — dual-source cross-check: envelope.ts vs. codec.ts requiredness
// ---------------------------------------------------------------------------

/** Minimal-but-schema-valid payload per type, used only to probe `EnvelopeSchema`'s own requiredness at runtime — self-contained (not imported from another test file), matching this repo's existing test-file convention. */
function minimalPayloadForProbe(type: MessageType): unknown {
  switch (type) {
    case 'conn.hello':
      return { protocolVersions: [1], capabilities: [], deviceId: 'device-1', productId: 'acme-agent' };
    case 'conn.ack':
      return { protocolVersion: 1, capabilities: [], serverTime: '2026-01-01T00:00:00.000Z' };
    case 'task.offer':
      return { instruction: 'do it', policy: { mode: 'auto' } };
    case 'task.approve':
      return {};
    case 'task.reject':
      return {};
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
      return { summary: 'about to do a thing' };
    case 'task.complete':
      return { summary: 'done', sessionRef: 'sess-1' };
    case 'task.fail':
      return { reason: 'boom' };
    case 'task.cancelled':
      return {};
    default: {
      const exhaustive: never = type;
      throw new Error(`no minimal payload fixture for message type: ${String(exhaustive)}`);
    }
  }
}

/** A fully-populated (task_id + seq both present) envelope for `type` — used to isolate one field's requiredness at a time by stripping just that field and re-checking `EnvelopeSchema.safeParse`. */
function fullEnvelopeFor(type: MessageType): Record<string, unknown> {
  return {
    v: 1,
    id: '00000000-0000-4000-8000-000000000099',
    ts: '2026-01-01T00:00:00.000Z',
    type,
    task_id: 'task-1',
    seq: 1,
    payload: minimalPayloadForProbe(type),
  };
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
// Part 5 — PROTOCOL_VERSION pin
// ---------------------------------------------------------------------------

describe('freeze guard: PROTOCOL_VERSION is pinned', () => {
  it('PROTOCOL_VERSION === 1 — a version bump must be a deliberate, visible edit, made alongside a golden update (see version.ts)', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

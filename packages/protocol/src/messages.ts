import { PreparedAgentMemoryModeSchema } from './input-preparation';
import { z } from 'zod';
import { RUNTIME_FAILURE_CLASSES, RUNTIME_IDS } from './constants';
import { BlobRefSchema } from './blob';
import {
  SEALED_DECLINE_CODES,
  SealedTaskInputSchema,
  SealedTaskOutputSchema,
  RoutineRefSchema,
  TaskSealingSchema,
  sealedOfferRule,
} from './sealed-payload';
import { AgentEventOrUnknownSchema } from './agent-event';
import {
  AgentContentActorSchema,
  AgentContentDecodeAsSchema,
  AgentContentMimeTypeSchema,
  AgentContentReadDenialReasonSchema,
  AgentContentReadSurfaceSchema,
  AgentEgressContentHashSchema,
  AgentEgressPolicyRevisionSchema,
  AgentEgressPolicySchema,
  AgentMessageContractSchema,
  AgentMessageContentTypeSchema,
  AgentMessageEgressRequirementSchema,
  AGENT_MESSAGE_MAX_BYTES,
  AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES,
  ContentReadPolicySchema,
} from './agent-egress';
import {
  AgentHomeProjectionHashSchema,
  AgentHomeProjectionProfileRevisionSchema,
  AgentHomeProjectionValueSchema,
} from './agent-home-projection';
import { ProviderProvisioningAvailablePayloadSchema } from './provider-provisioning';
import { E2eeKeyPackageAvailablePayloadSchema } from './e2ee-member';
import {
  InputPreparationAccountingPolicyRefSchema,
  InputPreparationArtifactSummarySchema,
  InputPreparationContentHashSchema,
  InputPreparationOfferBindingSchema,
  InputPreparationPolicyRevisionSchema,
  InputPreparationProfileIdSchema,
  InputPreparationSelectionSchema,
  InputPreparationSourceSchema,
} from './input-preparation';
import { ProviderProfileBindingSchema } from './provider-profile-binding';
import { TerminalProjectionSelectionSchema } from './terminal-projection';
import { canonicalizePlainJson, type PlainJsonCheck } from './plain-json';

/** Max size of an inlined artifact payload, per the delivery-model spec (<=64KB). */
const MAX_INLINE_BYTES = 64 * 1024;

function isWithinInlineByteLimit(value: string): boolean {
  return new TextEncoder().encode(value).length <= MAX_INLINE_BYTES;
}

// ---------------------------------------------------------------------------
// conn.* — connection handshake
// ---------------------------------------------------------------------------

export const RuntimeIdSchema = z.enum(RUNTIME_IDS);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

/** Wire-safe protocol version number: bounded before JSON reaches a store or comparison. */
export const ProtocolVersionNumberSchema = z
  .number()
  .int()
  .nonnegative()
  .max(2_147_483_647);

/**
 * Per-runtime feature flags reported in `conn.hello.runtimes[].capabilities`
 * (pre-freeze addition). Distinct from the connection-level `CAPABILITY_FLAGS`
 * (`version.ts`) / `conn.hello.capabilities` array: those are protocol-level
 * flags negotiated for the whole connection, while this is what one specific
 * detected runtime (pi/claude/codex) supports. The whole field is optional
 * end-to-end — older daemons omit `capabilities` entirely — and every field
 * inside it is itself optional, since detection can be partial.
 *
 * Unrecognized keys inside `capabilities` itself, by contrast, are silently
 * stripped (zod's default object behavior — same as every other payload
 * schema in this file) rather than passed through: this is a closed, typed
 * shape consumers can rely on, and a genuinely new capability flag gets added
 * here explicitly rather than round-tripped opaquely.
 */
export const RuntimeCapabilitiesSchema = z.object({
  steer: z.boolean().optional(),
  resume: z.boolean().optional(),
  approvalInteractive: z.boolean().optional(),
  /** Whether this runtime can project a locally configured MCP toolset into one task. */
  mcpToolsets: z.boolean().optional(),
  messageDraft: z.boolean().optional(),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

/**
 * Runtime detection info reported in `conn.hello`. Supersedes the M0
 * `agents: unknown` field (M1 gap #4): typed, so the server no longer has to
 * best-effort-normalize an untyped blob.
 */
export const RuntimeInfoSchema = z.object({
  id: RuntimeIdSchema,
  version: z.string().optional(),
  authPresent: z.boolean().optional(),
  /** Optional: older daemons omit this entirely (pre-freeze addition). */
  capabilities: RuntimeCapabilitiesSchema.optional(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

/** Custom identities are disjoint from the frozen built-in runtime enum. */
export const HarnessIdSchema = z.string().min(1).max(128).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .refine(value => !(RUNTIME_IDS as readonly string[]).includes(value), 'built-in runtime must use runtime');
export type HarnessId = z.infer<typeof HarnessIdSchema>;
export const HarnessInfoSchema = z.object({
  id: HarnessIdSchema,
  version: z.string().min(1).max(128).optional(),
  capabilities: RuntimeCapabilitiesSchema,
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;
export const HarnessInventorySchema = z.array(HarnessInfoSchema).max(64)
  .refine(values => new Set(values.map(value => value.id)).size === values.length, 'duplicate harness identity');

/** Maximum logical toolsets one daemon may advertise as locally configured. */
export const CONFIGURED_TOOLSETS_MAX_ITEMS = 64;

/**
 * Logical, host-owned MCP toolset identifier. A task may request this name,
 * but the executable/server definition behind it exists only in the daemon's
 * local configuration and never crosses the SaaS wire.
 */
export const ToolsetIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u, 'toolset ids must be lowercase logical identifiers');
export type ToolsetId = z.infer<typeof ToolsetIdSchema>;

/** Stable Agent identity carried across transport and storage. */
export const AGENT_REF_MAX_BYTES = 160;
const AGENT_REF_VALUE = z
  .string()
  .min(1)
  .max(AGENT_REF_MAX_BYTES)
  .refine((value) => new TextEncoder().encode(value).byteLength <= AGENT_REF_MAX_BYTES, {
    message: `AgentRef values must not exceed ${AGENT_REF_MAX_BYTES} UTF-8 bytes`,
  })
  .regex(/^[^\u0000-\u001f\u007f\r\n]+$/u, 'AgentRef values must not contain control characters');

const WINDOWS_RESERVED_AGENT_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/**
 * Agent ids are opaque to the SDK but must remain one safe pathname segment;
 * the SDK owns the deterministic `<hostStorageRoot>/agents/<agentId>` mapping.
 */
export const AgentRefSchema = z
  .object({
    agentId: AGENT_REF_VALUE.regex(/^[^\\/:<>"|?*]+$/u, 'agentId must be one portable pathname segment').refine(
      (value) => value !== '.' && value !== '..',
      'agentId must not be a dot segment',
    ).refine(
      (value) => !/[. ]$/u.test(value) && !WINDOWS_RESERVED_AGENT_SEGMENT.test(value),
      'agentId must be a portable Windows-safe pathname segment',
    ),
    profileRevision: AGENT_REF_VALUE,
  })
  .strict();
export type AgentRef = z.infer<typeof AgentRefSchema>;

/** AgentRef constrained to the canonical Profile revision required by projection control. */
export const AgentHomeProjectionAgentRefSchema = AgentRefSchema.extend({
  profileRevision: AgentHomeProjectionProfileRevisionSchema,
}).strict();
export type AgentHomeProjectionAgentRef = z.infer<typeof AgentHomeProjectionAgentRefSchema>;

function rejectDuplicateToolsets(
  ids: readonly string[],
  ctx: z.RefinementCtx,
  label: 'configured' | 'required',
): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      ctx.addIssue({ code: 'custom', path: [index], message: `duplicate ${label} toolset: ${id}` });
    }
    seen.add(id);
  }
}

/**
 * Device-local inventory projected for discovery. IDs only: executable MCP
 * definitions, arguments, environment and credentials never enter this shape.
 * Empty means known-none; omission on the containing message means unknown.
 */
export const ConfiguredToolsetsSchema = z
  .array(ToolsetIdSchema)
  .max(CONFIGURED_TOOLSETS_MAX_ITEMS)
  .superRefine((ids, ctx) => rejectDuplicateToolsets(ids, ctx, 'configured'));

/** daemon -> server: opening handshake. */
export const ConnHelloPayloadSchema = z.object({
  protocolVersions: z.array(ProtocolVersionNumberSchema).max(16),
  capabilities: z.array(z.string()),
  deviceId: z.string(),
  productId: z.string(),
  /** U4a Local Agent release identity; this is the sole client-version authority. */
  clientVersion: z.string().min(1).max(128).optional(),
  /** Runtimes detected on this device (M1 gap #4; replaces `agents`). */
  runtimes: z.array(RuntimeInfoSchema).optional(),
  harnesses: HarnessInventorySchema.optional(),
  /** Validated logical IDs configured on this device; definitions and secrets stay local. */
  configuredToolsets: ConfiguredToolsetsSchema.optional(),
  /**
   * Last `seq` this device has seen from the server (M1 redelivery cursor).
   * Omitted on a device's first-ever connection. The server replays any
   * server->daemon envelopes with `seq > cursor` it still holds — see
   * docs/protocol.md "At-least-once delivery".
   */
  cursor: z.number().int().optional(),
});
export type ConnHelloPayload = z.infer<typeof ConnHelloPayloadSchema>;

// ---------------------------------------------------------------------------
// server -> daemon: task.*
//
// Every type in this section carries a *required* envelope `task_id` (M1 gap
// #1) and a *required* envelope `seq` — a per-device monotonic counter the
// daemon uses as a redelivery cursor (M1 gap; see `conn.hello.cursor` above
// and docs/protocol.md "At-least-once delivery"). None of these payloads
// duplicate `taskId` at the payload level (M1 gap #7): the envelope's
// `task_id` is the single routing key.
// ---------------------------------------------------------------------------

/**
 * The out-of-band-reference form of `TaskOfferPayload.instruction` (the
 * alternative to an inlined string). `.strict()`: this is control data — it's
 * the task instruction itself,
 * the thing that authorizes what work gets done — so per the freeze rule's
 * observability-vs-control asymmetry (docs/protocol.md "Freeze rule") an
 * unrecognized field here must be REJECTED, not silently stripped the way an
 * ordinary payload's unknown field is. Without `.strict()`, a hypothetical
 * future field riding along next to `blobRef` (e.g. a routing/priority
 * override) would be silently discarded instead of failing the parse —
 * exactly the kind of silent reinterpretation the freeze rule forbids for
 * control/security payloads. Consequence: adding a field to this shape
 * post-freeze is a BREAKING change (version bump required), not the usual
 * non-breaking additive-optional-field case.
 */
const InstructionBlobRefSchema = z.object({ blobRef: BlobRefSchema }).strict();

const DispatchTargetIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\u0000\r\n]+$/u, 'dispatch target ids must not contain control line breaks');

/**
 * The web-selected runtime/model target carried end to end with a task.
 *
 * This is an additive v1 field. The discriminated union makes lane ownership
 * fail closed at decode time: subscription credentials can only belong to the
 * vendor CLIs, while a BYOK provider can only be executed through Pi.
 */
export const DispatchSelectionSchema = z.discriminatedUnion('lane', [
  z
    .object({
      lane: z.literal('subscription'),
      runtimeId: z.enum(['claude', 'codex']),
      providerId: z.null(),
      modelId: DispatchTargetIdSchema,
    })
    .strict(),
  z
    .object({
      lane: z.literal('byok'),
      runtimeId: z.literal('pi'),
      providerId: DispatchTargetIdSchema,
      modelId: DispatchTargetIdSchema,
    })
    .strict(),
  z
    .object({
      lane: z.literal('byok-profile'),
      runtimeId: z.literal('pi'),
      providerProfile: ProviderProfileBindingSchema,
    })
    .strict(),
]);
export type DispatchSelection = z.infer<typeof DispatchSelectionSchema>;

/**
 * #654: a plaintext type that has a sealed sibling refuses the sealed
 * members. Without this, a loose schema would strip them, and sealed content
 * or a sealing policy would pass as plaintext. A strict schema needs it too:
 * its unknown-key check sees only enumerable keys, so a non-enumerable
 * `sealed` or `sealing` would be dropped. A sealed message uses its own
 * `*_sealed` type.
 */
const NO_SEALED_MEMBER = { sealed: z.never().optional(), sealing: z.never().optional() };

/**
 * The offer fields a runtime adapter receives when a session starts. Every
 * offer message type carries them; this shape is not itself a message type.
 *
 * `taskId` is carried only by the envelope's `task_id` (M1 gap #7 — single
 * source of truth for routing).
 */
export const TaskOfferPayloadSchema = z.object({
  ...NO_SEALED_MEMBER,
  instruction: z.union([z.string(), InstructionBlobRefSchema]),
  runtime: RuntimeIdSchema.optional(),
  harnessId: HarnessIdSchema.optional(),
  dispatchSelection: DispatchSelectionSchema.optional(),
  sessionRef: z.string().optional(),
  workspaceHint: z.string().optional(),
  limits: z
    .object({
      maxDurationMs: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
});
export type TaskOfferPayload = z.infer<typeof TaskOfferPayloadSchema>;

/** Every named toolset is required; duplicates are rejected instead of silently de-duplicated. */
export const RequiredToolsetsSchema = z
  .array(ToolsetIdSchema)
  .min(1)
  .max(16)
  .superRefine((ids, ctx) => rejectDuplicateToolsets(ids, ctx, 'required'));

/**
 * How an Agent Attempt uses its Agent home. `memory-reader` runs the Attempt
 * in its own run directory, `<home>/.byok/runs/<taskId>/`, beside other
 * reader Attempts and at most one writer Attempt. The home stays an ancestor
 * of that cwd, so the runtime still finds the persona and memory. Absent means
 * a writer: the Attempt runs in the canonical home, and one home has at most
 * one writer at a time. The SDK does not make memory read-only; a reader
 * terminal reports memory changes in `agentHomeMemoryChange`. A host sends this
 * field only to a device that advertises `agent-home-readers`: the Agent
 * offers are strict, so an older daemon cannot accept it.
 */
export const AgentHomeAccessSchema = z.literal('memory-reader');
export type AgentHomeAccess = z.infer<typeof AgentHomeAccessSchema>;

/**
 * The `agentMemory` of an ordinary Agent offer: the prepared modes plus
 * `read-if-admitted` and `read-write-if-admitted`. When the daemon admits the
 * memory MCP they run as `read` and `read-write`; when it does not, both run as
 * `none`. A host sends each only to a device that advertises
 * `agent-memory-read-if-admitted` or `agent-memory-read-write-if-admitted`. A
 * `memory-reader` Attempt cannot select `read-write-if-admitted`. Prepared
 * offers refuse both.
 */
export const AgentMemorySelectionSchema = z.enum([
  ...PreparedAgentMemoryModeSchema.options, 'read-if-admitted', 'read-write-if-admitted',
]);
export type AgentMemorySelection = z.infer<typeof AgentMemorySelectionSchema>;

/**
 * Strict additive offer for a durable host-owned Agent. An older daemon that
 * does not advertise `agent-home-contract` skips this distinct message type
 * instead of stripping identity and applying legacy workspace semantics.
 *
 * `agentMemory` selects the Agent memory of this one task (see
 * {@link AgentMemorySelectionSchema}). Absent keeps the daemon admission. A
 * host sends it only to a device that advertises `agent-memory-selection`. The
 * prepared offer replaces it with its own required selection.
 */
export const TaskOfferForAgentPayloadSchema = z
  .object({
    ...NO_SEALED_MEMBER,
    instruction: z.union([z.string(), InstructionBlobRefSchema]),
    agentRef: AgentRefSchema,
    homeAccess: AgentHomeAccessSchema.optional(),
    agentMemory: AgentMemorySelectionSchema.optional(),
    requiredToolsets: RequiredToolsetsSchema.optional(),
    runtime: RuntimeIdSchema.optional(),
    harnessId: HarnessIdSchema.optional(),
    dispatchSelection: DispatchSelectionSchema.optional(),
    terminalProjection: TerminalProjectionSelectionSchema.optional(),
    sessionRef: z.string().optional(),
    limits: z
      .object({
        maxDurationMs: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();
export type TaskOfferForAgentPayload = z.infer<typeof TaskOfferForAgentPayloadSchema>;

/**
 * Strict Agent offer which consumes the typed egress policy. It is a distinct
 * message so an older Agent-home daemon cannot strip control data and proceed
 * with an unconsumed egress declaration.
 */
export const TaskOfferForAgentWithEgressPayloadSchema = TaskOfferForAgentPayloadSchema.extend({
  sessionRef: z.string().min(1).max(512),
  egressPolicy: AgentEgressPolicySchema,
  messageEgress: AgentMessageEgressRequirementSchema.optional(),
}).strict();
export type TaskOfferForAgentWithEgressPayload = z.infer<typeof TaskOfferForAgentWithEgressPayloadSchema>;

/**
 * Strict fresh-session Agent egress offer. It deliberately omits `sessionRef`:
 * the selected runtime is the sole authority that can mint that identity after
 * start. This distinct message prevents a missing resume reference from being
 * interpreted as a fresh execution by an older daemon.
 */
export const TaskOfferForAgentWithEgressFreshPayloadSchema = TaskOfferForAgentPayloadSchema.omit({
  sessionRef: true,
})
  .extend({
    egressPolicy: AgentEgressPolicySchema,
    messageEgress: AgentMessageEgressRequirementSchema.optional(),
  })
  .strict();
export type TaskOfferForAgentWithEgressFreshPayload = z.infer<typeof TaskOfferForAgentWithEgressFreshPayloadSchema>;

/**
 * Strict offer for an already-counted prepared Execution.
 *
 * A DISTINCT message type, not a `preparation` field added to
 * `task.offer_for_agent`, for the same N/N-1 reason the toolset and egress
 * variants are distinct. On long-poll, both an unknown message type and an
 * unknown key on a strict payload freeze the cursor. The enqueue capability
 * gate is the compatibility boundary: v6 requires a drain and paired upgrade,
 * with no dual token or dual read.
 *
 * It carries no `instruction`: the user request is already inside the frozen
 * envelope the referenced record retained, and an offer that carried both would
 * have two answers to what the runtime is about to send. `sessionRef` is absent
 * for the same structural reason the adapter refuses the pair — a prepared
 * Execution never resumes.
 *
 * Every value under `preparation` is the Host RE-PRESENTING what the device
 * already told it. The device compares each one against its own durable record
 * and declines non-retryably on any difference; nothing here is authority.
 */
export const TaskOfferPreparedPayloadSchema = TaskOfferForAgentPayloadSchema.omit({
  instruction: true,
  sessionRef: true,
  agentMemory: true,
})
  .extend({
    preparation: InputPreparationOfferBindingSchema,
    agentMemory: PreparedAgentMemoryModeSchema,
    egressPolicy: AgentEgressPolicySchema,
    messageEgress: AgentMessageEgressRequirementSchema.optional(),
  })
  .strict();
export type TaskOfferPreparedPayload = z.infer<typeof TaskOfferPreparedPayloadSchema>;

const EGRESS_SAFE_VALUE = z
  .json()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024,
    'egress payload exceeds 256KiB',
  );
const EGRESS_SESSION_REF = z.string().min(1).max(512);

/** Daemon -> cloud: one durable reliable-lane item, forwarded as the Agent produced it. */
export const AgentEgressReliablePayloadSchema = z
  .object({
    agentRef: AgentRefSchema,
    sessionRef: EGRESS_SESSION_REF,
    policyRevision: AgentEgressPolicyRevisionSchema,
    eventId: z.uuid(),
    cursor: z.number().int().positive(),
    payload: EGRESS_SAFE_VALUE,
    contentHash: AgentEgressContentHashSchema,
    byteCount: z.number().int().nonnegative().max(256 * 1024),
  })
  .strict();
export type AgentEgressReliablePayload = z.infer<typeof AgentEgressReliablePayloadSchema>;

/** Cloud -> daemon: exact acknowledgement for one reliable egress record. */
export const AgentEgressAckPayloadSchema = z
  .object({
    agentRef: AgentRefSchema,
    sessionRef: EGRESS_SESSION_REF,
    policyRevision: AgentEgressPolicyRevisionSchema,
    eventId: z.uuid(),
    cursor: z.number().int().positive(),
    receiptId: z.uuid(),
  })
  .strict();
export type AgentEgressAckPayload = z.infer<typeof AgentEgressAckPayloadSchema>;

const AGENT_MESSAGE_BODY = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= AGENT_MESSAGE_MAX_BYTES,
  `Agent message body exceeds ${AGENT_MESSAGE_MAX_BYTES} bytes`,
);

/** Daemon -> server: one Agent-authored message, independent from task activity. */
/** Display-only text. Offsets count UTF-8 bytes within one revision. */
export const AgentMessageDraftPayloadSchema = z.object({
  agentRef: AgentRefSchema,
  revision: z.number().int().min(1),
  offset: z.number().int().nonnegative(),
  text: z.string().refine(
    value => new TextEncoder().encode(value).byteLength <= AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES,
    `Agent message draft frame exceeds ${AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES} bytes`,
  ),
  overflow: z.literal(true).optional(),
}).strict();
export type AgentMessageDraftPayload = z.infer<typeof AgentMessageDraftPayloadSchema>;

export const AgentMessagePublishPayloadSchema = z
  .object({
    agentRef: AgentRefSchema,
    sessionRef: EGRESS_SESSION_REF,
    contract: AgentMessageContractSchema,
    messageId: z.uuid(),
    cursor: z.number().int().positive(),
    contentType: AgentMessageContentTypeSchema,
    body: AGENT_MESSAGE_BODY,
    contentHash: AgentEgressContentHashSchema,
    byteCount: z.number().int().positive().max(AGENT_MESSAGE_MAX_BYTES),
  })
  .strict()
  .superRefine((value, context) => {
    const actual = new TextEncoder().encode(value.body).byteLength;
    if (actual !== value.byteCount) {
      context.addIssue({ code: 'custom', path: ['byteCount'], message: 'byteCount must equal UTF-8 body bytes' });
    }
  });
export type AgentMessagePublishPayload = z.infer<typeof AgentMessagePublishPayloadSchema>;

export const AgentMessageDispositionPayloadSchema = z
  .object({
    agentRef: AgentRefSchema,
    sessionRef: EGRESS_SESSION_REF,
    contract: AgentMessageContractSchema,
    messageId: z.uuid(),
    cursor: z.number().int().positive(),
    contentHash: AgentEgressContentHashSchema,
    outcome: z.enum(['accepted', 'held', 'refused']),
    receiptId: z.uuid(),
    reasonCode: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u).optional(),
  })
  .strict();
export type AgentMessageDispositionPayload = z.infer<typeof AgentMessageDispositionPayloadSchema>;

const AGENT_CONTENT_TARGET = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, 'content target must not contain control characters')
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'content target must be a portable relative path without dot segments',
  );
const AGENT_CONTENT_CWD = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, 'cwd must not contain control characters')
  .regex(/^(?:\/|[A-Za-z]:[\\/])/u, 'cwd must be absolute');

/** Server -> daemon: one exact, independently-capability-gated content read. */
export const AgentContentReadPayloadSchema = z
  .object({
    requestId: z.uuid(),
    surface: AgentContentReadSurfaceSchema,
    actor: AgentContentActorSchema,
    agentRef: AgentRefSchema,
    sessionRef: EGRESS_SESSION_REF,
    runtime: RuntimeIdSchema,
    cwd: AGENT_CONTENT_CWD,
    policyRevision: AgentEgressPolicyRevisionSchema,
    target: AGENT_CONTENT_TARGET,
    mimeType: AgentContentMimeTypeSchema,
    decodeAs: AgentContentDecodeAsSchema,
    policy: ContentReadPolicySchema,
  })
  .strict();
export type AgentContentReadPayload = z.infer<typeof AgentContentReadPayloadSchema>;

/** Daemon -> cloud: durable, content-free content-read audit fact. */
export const AgentContentReceiptPayloadSchema = z.discriminatedUnion('decision', [
  z
    .object({
      requestId: z.uuid(),
      /** Stable reliable-delivery identity. Content receipts use their requestId. */
      eventId: z.uuid(),
      /** Stable positive cursor allocated by the durable Agent spool. */
      cursor: z.number().int().positive(),
      surface: AgentContentReadSurfaceSchema,
      actor: AgentContentActorSchema,
      agentRef: AgentRefSchema,
      sessionRef: EGRESS_SESSION_REF,
      runtime: RuntimeIdSchema,
      cwd: AGENT_CONTENT_CWD,
      policyRevision: AgentEgressPolicyRevisionSchema,
      target: AGENT_CONTENT_TARGET,
      mimeType: AgentContentMimeTypeSchema,
      decodeAs: AgentContentDecodeAsSchema,
      decision: z.literal('allowed'),
      byteCount: z.number().int().nonnegative(),
      contentHash: AgentEgressContentHashSchema,
      blobRef: BlobRefSchema,
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      eventId: z.uuid(),
      cursor: z.number().int().positive(),
      surface: AgentContentReadSurfaceSchema,
      actor: AgentContentActorSchema,
      agentRef: AgentRefSchema,
      sessionRef: EGRESS_SESSION_REF,
      runtime: RuntimeIdSchema,
      cwd: AGENT_CONTENT_CWD,
      policyRevision: AgentEgressPolicyRevisionSchema,
      target: AGENT_CONTENT_TARGET,
      mimeType: AgentContentMimeTypeSchema,
      decodeAs: AgentContentDecodeAsSchema,
      decision: z.literal('denied'),
      byteCount: z.literal(0),
      reason: AgentContentReadDenialReasonSchema,
    })
    .strict(),
]).superRefine((value, ctx) => {
  if (value.decision !== 'allowed') return;
  if (value.blobRef.size !== value.byteCount) {
    ctx.addIssue({ code: 'custom', path: ['blobRef', 'size'], message: 'blobRef size must equal byteCount' });
  }
  if (value.blobRef.contentHash !== value.contentHash) {
    ctx.addIssue({ code: 'custom', path: ['blobRef', 'contentHash'], message: 'blobRef contentHash must equal contentHash' });
  }
  if (value.blobRef.contentType !== value.mimeType) {
    ctx.addIssue({ code: 'custom', path: ['blobRef', 'contentType'], message: 'blobRef contentType must equal mimeType' });
  }
});
export type AgentContentReceiptPayload = z.infer<typeof AgentContentReceiptPayloadSchema>;

/**
 * Server -> daemon: one task-free exact-device Agent-home projection.
 *
 * `agentRef.profileRevision` is the projection contract's canonical comparable
 * revision. It is validated without interpreting the opaque product
 * projection, whose fields are never inspected for product semantics.
 */
export const AgentHomeProjectionPayloadSchema = z
  .object({
    requestId: z.uuid(),
    agentRef: AgentHomeProjectionAgentRefSchema,
    projectionHash: AgentHomeProjectionHashSchema,
    projection: AgentHomeProjectionValueSchema,
  })
  .strict();
export type AgentHomeProjectionPayload = z.infer<typeof AgentHomeProjectionPayloadSchema>;

/**
 * Server -> daemon: a Host-approved Agent memory intent is waiting for this
 * device (capability `agent-memory-intent.v1`, see `agent-memory-intent.ts`).
 *
 * `.strict()` and exactly two fields. There is deliberately no path, operation,
 * revision or content: the device fetches the immutable intent from the Host
 * under its own device authentication, so a mailbox row or journal line never
 * holds memory content. `agentRef` routes the home lease and the local ledger
 * and must equal the fetched intent's `agentRef`.
 */
export const AgentMemoryIntentAvailablePayloadSchema = z
  .object({
    intentId: z.uuid(),
    agentRef: AgentHomeProjectionAgentRefSchema,
  })
  .strict();
export type AgentMemoryIntentAvailablePayload = z.infer<typeof AgentMemoryIntentAvailablePayloadSchema>;

/**
 * The inlined form of `agent.input.preparation`'s authorized context document.
 *
 * Bounded by the SAME `MAX_INLINE_BYTES` (64 KiB) every other inlined artifact
 * on this wire is bounded by — there is no preparation-specific enlargement.
 * Anything larger uses the blob-ref form below, exactly the way a large task
 * instruction does; it is never implicitly chunked.
 */
const InputPreparationInlineContextSchema = z
  .object({
    inline: z
      .string()
      .refine(isWithinInlineByteLimit, `inline context must not exceed ${MAX_INLINE_BYTES} UTF-8 bytes`),
  })
  .strict();

/**
 * The out-of-band form. `contentHash` is stated a second time next to the
 * `BlobRef` on purpose and must equal it: the device verifies the DECODED
 * bytes against this field, so a blob store that serves different bytes under
 * the same id is caught locally rather than compiled.
 */
const InputPreparationBlobContextSchema = z
  .object({ blobRef: BlobRefSchema, contentHash: InputPreparationContentHashSchema })
  .strict()
  .superRefine((value, ctx) => {
    if (value.blobRef.contentHash !== value.contentHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['blobRef', 'contentHash'],
        message: 'blobRef contentHash must equal contentHash',
      });
    }
  });

/**
 * Server -> daemon: one task-free, exact-device remote input preparation.
 *
 * Distinct message type rather than an optional field on an existing one, for
 * the same N/N-1 reason the Agent offers are: an optional field could be
 * legally STRIPPED by a daemon that predates this contract, which would then
 * answer as though a preparation it never performed had somehow been handled.
 * An unknown type (`parseMessage` -> `UnknownMessageTypeError`) is not skipped
 * cleanly either: on long-poll it freezes the cursor, so the enqueue capability
 * gate is the compatibility boundary.
 *
 * What is deliberately NOT here (§17 B): `tools`, `toolExecutors`, runtime or
 * compiler identity, `tenantId` and `deviceId`. The first three are local
 * observations; the last two come from the device's own authenticated record,
 * never from the payload — a sender that could name them could redirect a
 * preparation's binding to a device it does not own.
 *
 * `deadlineAt` may only ever be TIGHTENED locally: the device clamps to
 * `min(deadlineAt - now, limits.preparationDeadlineMs)`, so a generous Host
 * deadline cannot enlarge a configured local bound.
 */
export const AgentInputPreparationPayloadSchema = z
  .object({
    agentMemory: PreparedAgentMemoryModeSchema,
    requestId: z.uuid(),
    agentRef: AgentRefSchema,
    profileId: InputPreparationProfileIdSchema,
    policyRevision: InputPreparationPolicyRevisionSchema,
    source: InputPreparationSourceSchema,
    selection: InputPreparationSelectionSchema,
    deadlineAt: z.iso.datetime({ offset: true }),
    context: z.union([InputPreparationInlineContextSchema, InputPreparationBlobContextSchema]),
    requiredToolsets: z.array(ToolsetIdSchema).max(16).superRefine((ids, ctx) => rejectDuplicateToolsets(ids, ctx, 'required')),
    /**
     * The Host's accounting ruling for this preparation, carried verbatim onto
     * the receipt's binding. Optional and defaulted NOWHERE: a payload that
     * omits it produces a receipt that says `accounting_policy_missing`, which
     * is the honest answer — the device rules on no residual key by itself.
     */
    accountingPolicyRef: InputPreparationAccountingPolicyRefSchema.optional(),
  })
  .strict();
export type AgentInputPreparationPayload = z.infer<typeof AgentInputPreparationPayloadSchema>;

/**
 * server -> daemon: approve a pending `task.await_approval` request.
 *
 * Semantics (M1 gap #3): the server's own state is authoritative on its own
 * action — calling the server-side `approve()` API moves the task record
 * `AwaitApproval -> Running` immediately. This wire message is a best-effort
 * *notification* telling the daemon to resume the paused runtime session; the
 * daemon does not send a dedicated ack. Its outcome is observable through the
 * task's existing message stream (e.g. `task.progress` resuming, or
 * `task.fail`/`task.cancelled` if resuming turns out to be impossible) — no
 * new ack message type is introduced. See docs/protocol.md "Approval flow".
 *
 * `approvalId` (required since v4): the SPECIFIC pending approval this
 * decision resolves. The daemon compares it against its own
 * currently-dispatched approval id (`ActiveTask.pendingApprovalId`,
 * `packages/client`'s `task-runner.ts`) and treats a mismatch as a stale,
 * audit-only no-op, so a late decision never lands on the task's next
 * approval — see `TaskRunner.handleApprove`.
 */
export const TaskApprovePayloadSchema = z.object({
  approvalId: z.string().min(1),
});
export type TaskApprovePayload = z.infer<typeof TaskApprovePayloadSchema>;

/**
 * server -> daemon: reject a pending `task.await_approval` request.
 *
 * Same best-effort-notification semantics as `task.approve` (M1 gap #3): the
 * server moves its own record `AwaitApproval -> Failed` immediately; this
 * message just tells the daemon to stop, and the daemon reports the outcome
 * via its existing `task.fail` terminal message.
 *
 * `approvalId` (required since v4): same targeting as
 * `TaskApprovePayloadSchema.approvalId` above, applied to the reject path
 * (`TaskRunner.handleReject`).
 */
export const TaskRejectPayloadSchema = z.object({
  reason: z.string().optional(),
  approvalId: z.string().min(1),
});
export type TaskRejectPayload = z.infer<typeof TaskRejectPayloadSchema>;

/**
 * server -> daemon: cancel a task in any non-terminal state.
 *
 * Same best-effort-notification semantics (M1 gap #3): the server moves its
 * own record to `Cancelled` immediately on its own action and does not wait
 * for a daemon ack; this message just tells the daemon to stop local work.
 * The daemon reports the outcome via the explicit `task.cancelled` terminal
 * message (M1 gap #6) — not `task.fail`.
 */
export const TaskCancelPayloadSchema = z.object({
  reason: z.string().optional(),
});
export type TaskCancelPayload = z.infer<typeof TaskCancelPayloadSchema>;

/** server -> daemon: inject steering text into a running task. */
export const TaskSteerPayloadSchema = z.object({
  ...NO_SEALED_MEMBER,
  text: z.string(),
});
export type TaskSteerPayload = z.infer<typeof TaskSteerPayloadSchema>;

// ---------------------------------------------------------------------------
// daemon -> server: task.*
//
// Every type in this section carries a *required* envelope `task_id` (M1 gap
// #1 — these all route by task id). Envelope `seq` (the redelivery cursor)
// stays optional in this direction: M1 only specifies at-least-once
// server->daemon redelivery, not a daemon->server one (see
// docs/protocol.md).
// ---------------------------------------------------------------------------

/**
 * daemon -> server: claim an offered task (idempotent CAS on the server
 * side). `taskId` used to be duplicated here; it is now carried only by the
 * envelope's `task_id` (M1 gap #7).
 *
 * Claiming no longer implies the task is `Running` (M1 gap #2) — see
 * `task.started`.
 *
 * `runtime` (M5, additive-minor — docs/protocol.md §3.1): the ACTUAL
 * adapter this device selected for the task, distinct from `task.offer`'s
 * own `runtime` (the merely REQUESTED one, `TaskOfferPayloadSchema.runtime`
 * above). When an offer names no runtime the daemon auto-selects (pi-first —
 * `TaskRunner.pickAdapter`, `packages/client`'s `task-runner.ts`), and before
 * this field existed the server had no way to learn which adapter actually
 * ran — `TaskSnapshot.runtime` (`packages/server`'s `types.ts`) only ever
 * recorded what was requested. Plain optional property on this already-
 * tolerant `z.object()`: an old server simply never reads it, so this needed
 * no version bump and no emission gating (same shape as `approvalId` on
 * `task.await_approval`/`task.approve`/`task.reject`, §5.3) — a new daemon
 * sends it unconditionally, regardless of whether the connected server is
 * new enough to store it.
 *
 * `capabilities` (S0/D-4, additive-minor — docs/protocol.md §2.4): the
 * TASK-level capability authority — what the claiming adapter reported about
 * itself at the moment it took this task, reusing `RuntimeCapabilitiesSchema`
 * (above) rather than introducing a second capability shape. Same source of
 * truth as `conn.hello.runtimes[].capabilities`, different scope: `conn.hello`
 * is CONNECTION-level discovery ("what could this device run"), which no
 * server-side task control decision may read, because it describes a device,
 * not the adapter that claimed this task. This field is task-shaped: it shares a lifecycle with
 * the task↔runtime binding the claim itself establishes, so a control gate
 * (`steerTask()`, `packages/server`'s `hub.ts`) can key off it and stay
 * correct across reconnects, adapter-set changes, and transports. Plain
 * optional property on this already-tolerant `z.object()`, exactly like
 * `runtime` above: an old daemon simply omits it, and a consumer that gates on
 * it must fail closed on absence rather than assume a default.
 */
export const TaskClaimPayloadSchema = z.object({
  deviceId: z.string(),
  agentId: z.string().optional(),
  agentRef: AgentRefSchema.optional(),
  runtime: RuntimeIdSchema.optional(),
  harnessId: HarnessIdSchema.optional(),
  capabilities: RuntimeCapabilitiesSchema.optional(),
});
export type TaskClaimPayload = z.infer<typeof TaskClaimPayloadSchema>;

/**
 * daemon -> server: explicit `Claimed -> Running` transition (M1 gap #2).
 * A `task.claim` no longer implies the task started running; the daemon
 * sends this once it has actually started the runtime session for the task.
 */
export const TaskStartedPayloadSchema = z.object({});
export type TaskStartedPayload = z.infer<typeof TaskStartedPayloadSchema>;

/**
 * daemon -> server: decline an offer *before* claiming it (M1 gap #5) — e.g.
 * no compatible/available runtime. Fail-closed rejections must use this instead of silently
 * dropping the offer.
 *
 * Decision (see docs/protocol.md "Declined vs. Failed" for the full
 * writeup): declining does *not* introduce a new `Declined` terminal state.
 * It maps onto the existing `Failed` state via a new `Offered -> Failed`
 * transition. `reason`/`retryable` intentionally mirror `TaskFailPayload`
 * semantics, because a pre-claim decline and a post-claim failure are the same
 * outcome from the dispatcher's point of view (this attempt produced no
 * result; here's whether retrying — e.g. offering to a different device —
 * makes sense), and keeping the state machine minimal avoids forking every
 * terminal-state consumer into "Failed or Declined, handle both".
 */
const HOME_DECLINE_CODES = ['agent_home_writer_busy', 'agent_home_reader_busy'] as const;
const DeclineFields = z.object({
  ...NO_SEALED_MEMBER,
  reason: z.string(),
  retryable: z.boolean().optional(),
  agentRef: AgentRefSchema.optional(),
  code: z.enum([...HOME_DECLINE_CODES, ...SEALED_DECLINE_CODES]).optional(),
});
/**
 * #654: a sealed decline code names a fixed, non-retryable outcome and
 * carries no content, so its `reason` is the code itself. A free-text reason
 * or `retryable: true` never goes with it.
 */
export const TaskDeclinePayloadSchema = DeclineFields.refine(
  (p) => !(SEALED_DECLINE_CODES as readonly unknown[]).includes(p.code) || (p.reason === p.code && p.retryable !== true),
  { message: 'a sealed code needs reason === code, not retryable' },
);
export type TaskDeclinePayload = z.infer<typeof TaskDeclinePayloadSchema>;

/**
 * daemon -> server: batch of normalized agent events.
 *
 * `events` elements are known-or-unknown (`AgentEventOrUnknownSchema` —
 * `agent-event.ts`), not bare `AgentEventSchema`: pre-freeze, an unrecognized
 * event `type` must not fail the whole batch, since a peer running a newer
 * minor version may have emitted an additive event variant this schema
 * doesn't know about yet. See `agent-event.ts` for the full rationale and
 * `partitionAgentEvents`/`isKnownAgentEvent` for how consumers should skip
 * unknowns instead of choking on them.
 */
export const TaskProgressPayloadSchema = z.object({
  ...NO_SEALED_MEMBER,
  seq: z.number().int(),
  events: z.array(AgentEventOrUnknownSchema),
});
export type TaskProgressPayload = z.infer<typeof TaskProgressPayloadSchema>;

/** daemon -> server: an artifact produced by the task, inline or by blob ref. */
export const TaskArtifactPayloadSchema = z.object({
  ...NO_SEALED_MEMBER,
  name: z.string(),
  contentType: z.string(),
  inline: z
    .string()
    .refine(isWithinInlineByteLimit, {
      message: 'inline artifact payload exceeds 64KB limit',
    })
    .optional(),
  blobRef: BlobRefSchema.optional(),
});
export type TaskArtifactPayload = z.infer<typeof TaskArtifactPayloadSchema>;

/**
 * daemon -> server: task is blocked on an out-of-band approval.
 *
 * `approvalId` (required since v4): the daemon's own locally-generated
 * identity for THIS SPECIFIC pending approval (`ApprovalRegistry`,
 * `packages/client`'s `approvals.ts`). The server echoes it on the
 * `task.approve`/`task.reject` that decides this approval.
 */
export const TaskAwaitApprovalPayloadSchema = z.object({
  ...NO_SEALED_MEMBER,
  summary: z.string(),
  approvalId: z.string().min(1),
});
export type TaskAwaitApprovalPayload = z.infer<typeof TaskAwaitApprovalPayloadSchema>;

/**
 * Hard cap (1 MiB) on a single `task.complete.document` (see
 * {@link TaskCompletePayloadSchema}), measured as the UTF-8 byte length of
 * its canonical JSON encoding — NOT as a node/key count, since a document is
 * schema-neutral and its object shape is unbounded by design.
 *
 * The cap is a REJECT-AT-BOUNDARY limit on both sides: a daemon that
 * produces an over-cap document reports `task.fail` instead of sending it,
 * and a server rejects an over-cap document at schema validation. It is
 * never truncated — a truncated JSON document is not valid JSON, so
 * "shrinking to fit" can only hand the consumer garbage.
 *
 * 1 MiB is the conservative ceiling declared by the first real consumer
 * (`docs/researches/2026-08-12-salesko-consumption-evidence.md` §1/§2:
 * smallest real frame 8.4 KiB, typical 48-96 KiB, 512 KiB comfortable).
 * Producers should stay at or under ~512 KiB (docs/protocol.md); the extra
 * headroom exists because raising a protocol cap later is additive while
 * lowering one is breaking. A result too big for this channel belongs in
 * `artifactRefs` (the multi-file/binary/oversized channel), not here.
 */
export const RESULT_DOCUMENT_MAX_BYTES = 1_048_576;

/**
 * Outcome of {@link checkResultDocument}.
 *
 * `bytes` is the measured canonical JSON UTF-8 byte length, present on both
 * the accept and the over-cap rejection so a caller can name the actual size
 * in a failure reason. `canonical` is the CANONICAL SNAPSHOT — the value a
 * sender must actually put on the wire; see {@link checkResultDocument}.
 */
export type ResultDocumentCheck = PlainJsonCheck;

/**
 * THE single authority for "is this a legal `task.complete.document`", and
 * the one place its canonical form is produced. `TaskCompletePayloadSchema`'s
 * own refinement calls it, and the daemon-side pre-send gate
 * (`packages/client`'s `task-runner.ts`) imports and calls the exact same
 * function rather than re-deriving any part of it: a daemon that measured or
 * judged a document even slightly differently from the server that validates
 * it would either reject documents the wire would have accepted, or hand the
 * server a payload it is about to reject after the runtime session already
 * ended.
 *
 * **The contract is: a document must be PLAIN JSON DATA.** Not "an object
 * that happens to survive `JSON.stringify`" — that bar is far too low, and
 * two concrete attacks/mistakes live under it:
 *
 *   1. `JSON.stringify` succeeding does not mean the value was preserved. An
 *      `undefined`-valued key, a `NaN`, a function-valued property, or a
 *      `Date` all serialize "successfully" while silently becoming something
 *      else (dropped, `null`, or a string). The result is a well-formed,
 *      under-cap document that is not what the producer had — a confidently
 *      wrong terminal result, the worst outcome this channel has.
 *   2. `toJSON(key)` receives the property key it is being serialized under,
 *      so an object can legally answer one way at the root (`key === ''`,
 *      where this function measures it) and a completely different way when
 *      nested inside the envelope payload (`key === 'document'`, where the
 *      codec actually serializes it). A root-only measurement is therefore
 *      not a bound on what goes on the wire at all. The same hole exists for
 *      any getter that answers differently on a second read.
 *
 * Both die together via the same mechanism. The steps:
 *
 *   1. `JSON.stringify` must succeed and not return `undefined`.
 *   2. Its UTF-8 byte length must be within {@link RESULT_DOCUMENT_MAX_BYTES}.
 *   3. `JSON.parse` that string — the CANONICAL SNAPSHOT. It is pure data:
 *      no `toJSON`, no getters, no prototype, nothing left that can answer
 *      differently a second time.
 *   4. The original must be structurally equal to the snapshot
 *      (`isSameJsonData`, `plain-json.ts`). Any mismatch means the value was not plain
 *      JSON data, and it is rejected rather than silently transformed.
 *
 * On success the snapshot is returned as `canonical`, and **every sender
 * must put THAT on the wire, never the original reference** — which is what
 * closes the contextual-`toJSON`/unstable-getter hole for good: pure data
 * serializes identically at the root and nested, so what was measured is
 * necessarily what is sent. The check is idempotent on pure data, so the
 * server re-running it on an already-parsed payload is a no-op that always
 * agrees.
 */
export function checkResultDocument(document: unknown): ResultDocumentCheck {
  return canonicalizePlainJson(document, RESULT_DOCUMENT_MAX_BYTES);
}

/** Maximum provider-reported prompt or completion token count retained in one terminal observation. */
export const TERMINAL_INFERENCE_USAGE_MAX_TOKENS = 1_000_000_000;
/** Maximum device-observed elapsed duration retained in one terminal observation (seven days). */
export const TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS = 604_800_000;
export const TERMINAL_INFERENCE_USAGE_PROVIDER_MAX_LENGTH = 160;
export const TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH = 160;
export const TERMINAL_INFERENCE_USAGE_CLIENT_VERSION_MAX_LENGTH = 128;

const TerminalInferenceUsageNumberSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(TERMINAL_INFERENCE_USAGE_MAX_TOKENS);

const TerminalInferenceUsageDurationSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(TERMINAL_INFERENCE_USAGE_MAX_DURATION_MS);

/** Canonical device observation time: an ISO-8601 UTC instant with milliseconds. */
const TerminalInferenceReportedAtSchema = z
  .iso
  .datetime({ offset: true, precision: 3 })
  .refine((value) => value.endsWith('Z'), 'reportedAt must be canonical UTC (Z)');

/**
 * A bounded, non-billing observation associated with one terminal runtime
 * outcome. It is optional on every terminal payload so a pre-U2 daemon remains
 * a legal v1 peer. `promptTokens` and `completionTokens` are values a runtime
 * reported for its final observed turn; they are not a storage-accounting or
 * invoice authority.
 */
export const TerminalInferenceUsageSchema = z.object({
  /** The adapter that actually started this task, never a requested fallback. */
  runtime: RuntimeIdSchema,
  /** Omitted unless the adapter itself exposed this provider observation. */
  provider: z.string().min(1).max(TERMINAL_INFERENCE_USAGE_PROVIDER_MAX_LENGTH).optional(),
  /** Omitted unless the adapter itself exposed this model observation. */
  model: z.string().min(1).max(TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH).optional(),
  /** Direct projection of the runtime's final observed input token count. */
  promptTokens: TerminalInferenceUsageNumberSchema.optional(),
  /** Direct projection of the runtime's final observed output token count. */
  completionTokens: TerminalInferenceUsageNumberSchema.optional(),
  /** Device-observed elapsed duration for the started task. */
  durationMs: TerminalInferenceUsageDurationSchema.optional(),
  /** Process-immutable Local Agent release version, owned outside the protocol. */
  clientVersion: z.string().min(1).max(TERMINAL_INFERENCE_USAGE_CLIENT_VERSION_MAX_LENGTH),
  /** Device observation time, never server receipt time. */
  reportedAt: TerminalInferenceReportedAtSchema,
});
export type TerminalInferenceUsage = z.infer<typeof TerminalInferenceUsageSchema>;

/**
 * The prepared-only terminal observation: what the runtime reported about the
 * provider calls of ONE prepared Execution, bound to the frozen request it
 * launched.
 *
 * - `requestDigest` — the frozen artifact's own request digest
 *   (`InputPreparationArtifactSummarySchema.requestDigest`), so the Host
 *   compares these numbers against exactly the D whose `requestBytes` it
 *   ruled on.
 * - `initialPromptTokens` — the prompt tokens of the FIRST provider call. It
 *   is the only call whose request is D; every later call is an ordinary tool
 *   continuation. Prompt tokens are the provider's whole prompt, cache reads
 *   and writes included.
 * - `maxPromptTokens` — the largest prompt of any provider call of the
 *   Execution, so `maxPromptTokens >= initialPromptTokens`.
 *
 * A separate field, deliberately NOT {@link TerminalInferenceUsageSchema}:
 * that one is telemetry and never task-state authority, while this one is the
 * evidence a Host checks its own budget ruling against. The device performs no
 * budget arithmetic over it. Strict, like every other control shape: an
 * unrecognized field is rejected, not stripped.
 */
export const TerminalPreparedObservationSchema = z
  .object({
    requestDigest: InputPreparationArtifactSummarySchema.shape.requestDigest,
    initialPromptTokens: TerminalInferenceUsageNumberSchema,
    maxPromptTokens: TerminalInferenceUsageNumberSchema,
  })
  .strict()
  .refine((value) => value.maxPromptTokens >= value.initialPromptTokens, {
    message: 'maxPromptTokens must not be below initialPromptTokens',
    path: ['maxPromptTokens'],
  });
export type TerminalPreparedObservation = z.infer<typeof TerminalPreparedObservationSchema>;

/**
 * The task-free Agent-home projection (`agent.home_projection`) that the
 * device had already applied when an Agent Attempt started. The writer lease
 * keeps a new projection out of the home until the Attempt ends, so this is
 * the persona the Attempt ran with. The SDK does not compare it with the
 * offer's `agentRef.profileRevision`: the host decides whether a mismatch
 * matters. Absent when the task was not Agent-bound, or when the home had no
 * applied projection record.
 */
export const TerminalAgentHomeProjectionSchema = z
  .object({
    profileRevision: AgentHomeProjectionProfileRevisionSchema,
    projectionHash: AgentHomeProjectionHashSchema,
  })
  .strict();
export type TerminalAgentHomeProjection = z.infer<typeof TerminalAgentHomeProjectionSchema>;

/** Maximum memory files one reader digest covers: `MEMORY.md` plus every entry under `notes/`. */
export const AGENT_HOME_MEMORY_DIGEST_MAX_FILES = 256;
/** Maximum bytes of memory files one reader digest reads. */
export const AGENT_HOME_MEMORY_DIGEST_MAX_BYTES = 16 * 1024 * 1024;
/** Maximum length of one changed memory path, relative to the Agent home. */
export const AGENT_HOME_MEMORY_PATH_MAX_LENGTH = 1024;

const AgentHomeMemoryChangedPathsSchema = z
  .array(z.string().min(1).max(AGENT_HOME_MEMORY_PATH_MAX_LENGTH).regex(/^[^\u0000]+$/u))
  .min(1)
  // A path can leave one digest and another can enter the other one.
  .max(AGENT_HOME_MEMORY_DIGEST_MAX_FILES * 2);

/**
 * Memory-change evidence of one `memory-reader` Attempt. The device hashes
 * `MEMORY.md` and every file under `notes/` when the reader starts and again
 * at its terminal, and compares the two digests.
 *
 * - `unchanged`: the digests are equal.
 * - `reader-attributed`: the digests differ and no writer Attempt of the home
 *   overlapped this reader. A reader Attempt changed memory: this one, or
 *   another reader that overlapped it.
 * - `unattributed`: the digests differ and a writer Attempt overlapped this
 *   reader, so the change has no single source.
 * - `unmeasured`: the digest bound was exceeded, or a read failed.
 *
 * `paths` lists the changed files relative to the home, with `/` separators.
 * The device sees only Attempts it runs; a host that writes memory files
 * itself while readers run makes the attribution ambiguous. Absent on writer
 * terminals and on a claimed failure before the Attempt became active.
 */
export const TerminalAgentHomeMemoryChangeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('unchanged') }).strict(),
  z.object({ outcome: z.literal('reader-attributed'), paths: AgentHomeMemoryChangedPathsSchema }).strict(),
  z.object({ outcome: z.literal('unattributed'), paths: AgentHomeMemoryChangedPathsSchema }).strict(),
  z.object({ outcome: z.literal('unmeasured') }).strict(),
]);
export type TerminalAgentHomeMemoryChange = z.infer<typeof TerminalAgentHomeMemoryChangeSchema>;

/**
 * daemon -> server: task finished successfully.
 *
 * `document` (docs/protocol.md §7.2): the OPTIONAL
 * structured terminal result of the task — one JSON value the product on the
 * other side consumes as the task's actual output, as opposed to `summary`
 * (human-readable prose) or `artifactRefs` (files). Deliberately
 * `z.unknown()`: this SDK never understands, validates, or transforms the
 * product's own document schema — that validation belongs to the consumer.
 * The only constraints the wire imposes are the ones
 * {@link checkResultDocument} enforces: it must be PLAIN JSON DATA (equal to
 * its own JSON round trip — see that function for why "stringify succeeded"
 * is not enough), and its canonical JSON UTF-8 encoding must be at most
 * {@link RESULT_DOCUMENT_MAX_BYTES}. An over-cap document is REJECTED here,
 * never truncated (see that constant's own doc comment). A sender puts the
 * check's `canonical` snapshot on the wire, never the original object.
 *
 * Wire v3: every v3 server keeps this field, so no capability flag gates it
 * (the v2 `result-document` flag is gone). For a
 * `terminalProjection.mode: 'result-document'` offer it carries the outcome
 * the daemon validated against the offer's frozen schema
 * (`validateResultOutcome`, `result-schema.ts`, at most
 * `RESULT_OUTCOME_MAX_BYTES`).
 */
export const TaskCompletePayloadSchema = z.object({
  ...NO_SEALED_MEMBER,
  harnessId: HarnessIdSchema.optional(),
  summary: z.string(),
  /**
   * The runtime's closing reply: the assistant text after the last tool
   * interaction, or the last whole message for a runtime whose `progress`
   * events are whole messages (Codex). `summary` keeps the whole run's text,
   * so a host reads the final answer here without parsing commentary out of
   * it. Absent when the run ended with no closing text. An older server strips
   * this optional field; the host then sees it absent and keeps `summary`.
   */
  finalMessage: z.string().optional(),
  sessionRef: z.string(),
  artifactRefs: z.array(BlobRefSchema).optional(),
  document: z
    .unknown()
    .optional()
    .refine((value) => value === undefined || checkResultDocument(value).ok, {
      message: `task.complete.document must be plain JSON data (equal to its own JSON round trip) and at most ${RESULT_DOCUMENT_MAX_BYTES} bytes as canonical JSON (UTF-8)`,
    }),
  usage: TerminalInferenceUsageSchema.optional(),
  /** Present on a prepared Execution only — see {@link TerminalPreparedObservationSchema}. */
  preparedObservation: TerminalPreparedObservationSchema.optional(),
  agentRef: AgentRefSchema.optional(),
  agentHomeProjection: TerminalAgentHomeProjectionSchema.optional(),
  agentHomeMemoryChange: TerminalAgentHomeMemoryChangeSchema.optional(),
});
export type TaskCompletePayload = z.infer<typeof TaskCompletePayloadSchema>;

/** A closed runtime failure class (#869). `unknown` means the runtime gave no structured evidence. */
export const RuntimeFailureClassSchema = z.enum(RUNTIME_FAILURE_CLASSES);
export type RuntimeFailureClass = z.infer<typeof RuntimeFailureClassSchema>;

/**
 * The machine-readable failure of a `task.fail` (#869); `reason` stays display
 * text. `resetsAt` (ISO 8601 UTC) exists only on `quota`, and only when the
 * runtime reported when the limit resets.
 */
export const TaskFailureSchema = z.union([
  z.object({ class: z.literal('quota'), resetsAt: z.iso.datetime().optional() }).strict(),
  z.object({ class: RuntimeFailureClassSchema.exclude(['quota']) }).strict(),
]);
export type TaskFailure = z.infer<typeof TaskFailureSchema>;

/** daemon -> server: task failed. */
export const TaskFailPayloadSchema = z.object({
  ...NO_SEALED_MEMBER,
  /** Local interruption observation bound to the immutable offer; does not assert a cloud claim. */
  recovery: z.object({ kind: z.literal('daemon_interrupted'), offerId: z.uuid() }).strict().optional(),
  harnessId: HarnessIdSchema.optional(),
  reason: z.string(),
  retryable: z.boolean().optional(),
  /** Gated on the server's `runtime-failure-class` flag. Plaintext on `task.fail_sealed`. */
  failure: TaskFailureSchema.optional(),
  usage: TerminalInferenceUsageSchema.optional(),
  /** Present on a prepared Execution that observed provider usage before failing. */
  preparedObservation: TerminalPreparedObservationSchema.optional(),
  agentRef: AgentRefSchema.optional(),
  agentHomeProjection: TerminalAgentHomeProjectionSchema.optional(),
  agentHomeMemoryChange: TerminalAgentHomeMemoryChangeSchema.optional(),
});
export type TaskFailPayload = z.infer<typeof TaskFailPayloadSchema>;

/**
 * daemon -> server: task ended in the `Cancelled` state (M1 gap #6) — either
 * in response to a server-sent `task.cancel`, or a cancellation the daemon
 * observed/decided locally (e.g. a local stop action) that the server didn't
 * initiate. This is the canonical way to report a `Cancelled` outcome; it
 * supersedes the M0 convention of `task.fail({ reason: 'cancelled' })`.
 *
 * This is deliberately its own message rather than folded into `task.fail`
 * (decision: prefer the explicit message — see docs/protocol.md) because
 * `Cancelled` is semantically distinct from `Failed`: one is an intentional
 * stop, the other an error. Overloading `task.fail` with a magic
 * `reason: 'cancelled'` string convention hid that distinction on the wire.
 *
 * Dual-purpose on receipt: if the server already moved its own record to
 * `Cancelled` (it initiated the cancel — M1 gap #3's "server state is
 * authoritative" rule), this is an idempotent no-op ack. If the server
 * hasn't yet (a locally-observed cancellation), this is the authoritative
 * trigger that moves `Claimed`/`Running`/`AwaitApproval -> Cancelled`.
 */
export const TaskCancelledPayloadSchema = z.object({
  ...NO_SEALED_MEMBER,
  harnessId: HarnessIdSchema.optional(),
  reason: z.string().optional(),
  usage: TerminalInferenceUsageSchema.optional(),
  agentRef: AgentRefSchema.optional(),
  agentHomeProjection: TerminalAgentHomeProjectionSchema.optional(),
  agentHomeMemoryChange: TerminalAgentHomeMemoryChangeSchema.optional(),
});
export type TaskCancelledPayload = z.infer<typeof TaskCancelledPayloadSchema>;

/**
 * daemon -> server: a pending `task.await_approval` was resolved entirely
 * LOCALLY on the device — the local control-socket `approvals.resolve` RPC,
 * a fail-closed `requestApproval` timeout, or a fail-closed eviction/finish
 * rejection (see `packages/client`'s `task-runner.ts`/`approvals.ts`) —
 * *without* a wire `task.approve`/`task.reject` ever having been exchanged
 * for it. Baseline since v4: the daemon reports every local resolution, and
 * this report is the server's only source for one; the server does not infer
 * a resolution from later task activity.
 *
 * Observability-class tolerance applies (not control/security — see the
 * freeze rule's asymmetry, `docs/protocol.md`): this is a daemon reporting
 * what it already did locally, not a payload that grants/denies anything on
 * its own — the receiving server's own state machine (`TASK_TRANSITIONS`,
 * `task-state.ts`) is still what decides whether the reported resolution is
 * legal to apply. Plain `z.object()` (not `.strict()`), same as every other
 * non-control payload in this file.
 *
 * `resolvedBy` is a single-value enum (`'local'`) rather than a bare string:
 * a later wave could add a DISTINCT value as a gated addition, while the
 * shape stays closed and typed today.
 */
export const TaskApprovalResolvedPayloadSchema = z.object({
  approvalId: z.string(),
  decision: z.enum(['approve', 'reject']),
  resolvedBy: z.enum(['local']),
  at: z.iso.datetime({ offset: true }),
});
export type TaskApprovalResolvedPayload = z.infer<typeof TaskApprovalResolvedPayloadSchema>;

// ---------------------------------------------------------------------------
// Sealed payload v1 (#654): sealed message types
//
// Each sealed type is its plaintext type without the fields one category
// moves into the ciphertext, plus `sealed`. The type is gated on
// `sealed-payload-v1` (`wire-additions.ts`), so a decoder without the flag
// refuses the whole message. `SEALED_SPLIT_TABLE` (`sealed-payload.ts`) names
// the moved fields. Every sealed type is strict: it carries content, so an
// unknown field must fail the parse.
// ---------------------------------------------------------------------------

/**
 * The fields every sealed offer adds: the task's frozen `sealing`, and the
 * sealed instruction when the task seals task input. A task that seals only
 * its output keeps `instruction` in plaintext.
 */
const SEALED_OFFER_FIELDS = {
  instruction: z.union([z.string(), InstructionBlobRefSchema]).optional(),
  sealing: TaskSealingSchema,
  sealed: SealedTaskInputSchema.optional(),
};

/** server -> daemon: `task.offer_for_agent` of a sealed task. */
export const TaskOfferForAgentSealedPayloadSchema = TaskOfferForAgentPayloadSchema.extend(SEALED_OFFER_FIELDS)
  .strict()
  .superRefine(sealedOfferRule);
export type TaskOfferForAgentSealedPayload = z.infer<typeof TaskOfferForAgentSealedPayloadSchema>;

/** server -> daemon: `task.offer_for_agent_with_egress` of a sealed task. */
export const TaskOfferForAgentWithEgressSealedPayloadSchema = TaskOfferForAgentWithEgressPayloadSchema.extend(SEALED_OFFER_FIELDS)
  .strict()
  .superRefine(sealedOfferRule);
export type TaskOfferForAgentWithEgressSealedPayload = z.infer<typeof TaskOfferForAgentWithEgressSealedPayloadSchema>;

/**
 * server -> daemon: `task.offer_for_agent_with_egress_fresh` of a sealed task.
 * Only this type takes `routineRef`: a routine occurrence is an execution.
 */
export const TaskOfferForAgentWithEgressFreshSealedPayloadSchema = TaskOfferForAgentWithEgressFreshPayloadSchema
  .extend({ ...SEALED_OFFER_FIELDS, routineRef: RoutineRefSchema.optional() })
  .strict()
  .superRefine(sealedOfferRule);
export type TaskOfferForAgentWithEgressFreshSealedPayload = z.infer<typeof TaskOfferForAgentWithEgressFreshSealedPayloadSchema>;

/**
 * server -> daemon: sealed steering text. `steerId` names this steer in the
 * AAD and the content MAC, so the Host cannot replay an earlier steer of the
 * same task as a new one.
 */
export const TaskSteerSealedPayloadSchema = z.object({ steerId: z.uuid(), sealed: SealedTaskInputSchema }).strict();
export type TaskSteerSealedPayload = z.infer<typeof TaskSteerSealedPayloadSchema>;

/**
 * daemon -> server: `task.complete` of a sealed task. `summary`,
 * `finalMessage` and `document` are sealed. `artifactRefs` and
 * `preparedObservation` are not carried in v1.
 */
export const TaskCompleteSealedPayloadSchema = TaskCompletePayloadSchema.omit({
  summary: true,
  finalMessage: true,
  document: true,
  artifactRefs: true,
  preparedObservation: true,
})
  .extend({ sealed: SealedTaskOutputSchema })
  .strict();
export type TaskCompleteSealedPayload = z.infer<typeof TaskCompleteSealedPayloadSchema>;

/** daemon -> server: `task.fail` of a sealed task. `reason` is sealed; `preparedObservation` is not carried in v1. */
export const TaskFailSealedPayloadSchema = TaskFailPayloadSchema.omit({ reason: true, preparedObservation: true })
  .extend({ sealed: SealedTaskOutputSchema })
  .strict();
export type TaskFailSealedPayload = z.infer<typeof TaskFailSealedPayloadSchema>;

/**
 * daemon -> server: `task.decline` of a sealed task with a sealed `reason`.
 * The sealed decline codes go only on the plaintext `task.decline`: a device
 * that cannot open or use the scope key often cannot seal a reply either.
 */
export const TaskDeclineSealedPayloadSchema = DeclineFields.omit({ reason: true })
  .extend({ code: z.enum(HOME_DECLINE_CODES).optional(), sealed: SealedTaskOutputSchema })
  .strict();
export type TaskDeclineSealedPayload = z.infer<typeof TaskDeclineSealedPayloadSchema>;

/** daemon -> server: `task.cancelled` of a sealed task. `reason` is sealed. */
export const TaskCancelledSealedPayloadSchema = TaskCancelledPayloadSchema.omit({ reason: true })
  .extend({ sealed: SealedTaskOutputSchema })
  .strict();
export type TaskCancelledSealedPayload = z.infer<typeof TaskCancelledSealedPayloadSchema>;

/** daemon -> server: `task.progress` of a sealed task. `events` is sealed; `seq` names the batch. */
export const TaskProgressSealedPayloadSchema = TaskProgressPayloadSchema.omit({ events: true })
  .extend({ sealed: SealedTaskOutputSchema })
  .strict();
export type TaskProgressSealedPayload = z.infer<typeof TaskProgressSealedPayloadSchema>;

/**
 * daemon -> server: an inline artifact of a sealed task. `inline` is sealed; a
 * blob artifact is not carried in v1. `artifactId` names the write in the AAD
 * and the content MAC, because two artifacts of one task may share a `name`.
 */
export const TaskArtifactSealedPayloadSchema = TaskArtifactPayloadSchema.omit({ inline: true, blobRef: true })
  .extend({ artifactId: z.uuid(), sealed: SealedTaskOutputSchema })
  .strict();
export type TaskArtifactSealedPayload = z.infer<typeof TaskArtifactSealedPayloadSchema>;

/** daemon -> server: `task.await_approval` of a sealed task. `summary` is sealed; `approvalId` is required. */
export const TaskAwaitApprovalSealedPayloadSchema = TaskAwaitApprovalPayloadSchema.omit({ summary: true })
  .extend({ approvalId: z.string().min(1), sealed: SealedTaskOutputSchema })
  .strict();
export type TaskAwaitApprovalSealedPayload = z.infer<typeof TaskAwaitApprovalSealedPayloadSchema>;

// ---------------------------------------------------------------------------
// registry — single source of truth mapping message type -> payload schema
// ---------------------------------------------------------------------------

/**
 * Protocol-owned task-opening family; the wire registry consumes these same entries.
 *
 * Each value is written `X as typeof X`, here and in `MESSAGE_PAYLOAD_SCHEMAS`.
 * The assertion is type-only (no runtime code). It makes declaration emit
 * name each schema (`typeof X`) instead of copying its full type, which keeps
 * the published `.d.ts` small. Every new entry follows this rule.
 */
const TASK_OFFER_PAYLOAD_SCHEMAS = {
  'task.offer_for_agent': TaskOfferForAgentPayloadSchema as typeof TaskOfferForAgentPayloadSchema,
  'task.offer_for_agent_with_egress': TaskOfferForAgentWithEgressPayloadSchema as typeof TaskOfferForAgentWithEgressPayloadSchema,
  'task.offer_for_agent_with_egress_fresh': TaskOfferForAgentWithEgressFreshPayloadSchema as typeof TaskOfferForAgentWithEgressFreshPayloadSchema,
  'task.offer_prepared': TaskOfferPreparedPayloadSchema as typeof TaskOfferPreparedPayloadSchema,
  'task.offer_for_agent_sealed': TaskOfferForAgentSealedPayloadSchema as typeof TaskOfferForAgentSealedPayloadSchema,
  'task.offer_for_agent_with_egress_sealed': TaskOfferForAgentWithEgressSealedPayloadSchema as typeof TaskOfferForAgentWithEgressSealedPayloadSchema,
  'task.offer_for_agent_with_egress_fresh_sealed': TaskOfferForAgentWithEgressFreshSealedPayloadSchema as typeof TaskOfferForAgentWithEgressFreshSealedPayloadSchema,
} as const;

export type TaskOfferType = keyof typeof TASK_OFFER_PAYLOAD_SCHEMAS;
export const TASK_OFFER_TYPES: readonly TaskOfferType[] = Object.freeze(
  Object.keys(TASK_OFFER_PAYLOAD_SCHEMAS) as TaskOfferType[],
);

/** Classify task-opening offers without duplicating the protocol registry in consumers. */
export function isTaskOfferType(type: string): type is TaskOfferType {
  return Object.hasOwn(TASK_OFFER_PAYLOAD_SCHEMAS, type);
}

export const MESSAGE_PAYLOAD_SCHEMAS = {
  'conn.hello': ConnHelloPayloadSchema as typeof ConnHelloPayloadSchema,
  ...TASK_OFFER_PAYLOAD_SCHEMAS,
  'agent.egress.reliable': AgentEgressReliablePayloadSchema as typeof AgentEgressReliablePayloadSchema,
  'agent.egress.ack': AgentEgressAckPayloadSchema as typeof AgentEgressAckPayloadSchema,
  'agent.message.draft': AgentMessageDraftPayloadSchema as typeof AgentMessageDraftPayloadSchema,
  'agent.message.publish': AgentMessagePublishPayloadSchema as typeof AgentMessagePublishPayloadSchema,
  'agent.message.disposition': AgentMessageDispositionPayloadSchema as typeof AgentMessageDispositionPayloadSchema,
  'agent.content.read': AgentContentReadPayloadSchema as typeof AgentContentReadPayloadSchema,
  'agent.content.receipt': AgentContentReceiptPayloadSchema as typeof AgentContentReceiptPayloadSchema,
  'agent.home.projection': AgentHomeProjectionPayloadSchema as typeof AgentHomeProjectionPayloadSchema,
  'agent.input.preparation': AgentInputPreparationPayloadSchema as typeof AgentInputPreparationPayloadSchema,
  'provider.provisioning.available': ProviderProvisioningAvailablePayloadSchema as typeof ProviderProvisioningAvailablePayloadSchema,
  'agent.memory.intent.available': AgentMemoryIntentAvailablePayloadSchema as typeof AgentMemoryIntentAvailablePayloadSchema,
  'task.approve': TaskApprovePayloadSchema as typeof TaskApprovePayloadSchema,
  'task.reject': TaskRejectPayloadSchema as typeof TaskRejectPayloadSchema,
  'task.cancel': TaskCancelPayloadSchema as typeof TaskCancelPayloadSchema,
  'task.steer': TaskSteerPayloadSchema as typeof TaskSteerPayloadSchema,
  'task.claim': TaskClaimPayloadSchema as typeof TaskClaimPayloadSchema,
  'task.started': TaskStartedPayloadSchema as typeof TaskStartedPayloadSchema,
  'task.decline': TaskDeclinePayloadSchema as typeof TaskDeclinePayloadSchema,
  'task.progress': TaskProgressPayloadSchema as typeof TaskProgressPayloadSchema,
  'task.artifact': TaskArtifactPayloadSchema as typeof TaskArtifactPayloadSchema,
  'task.await_approval': TaskAwaitApprovalPayloadSchema as typeof TaskAwaitApprovalPayloadSchema,
  'task.complete': TaskCompletePayloadSchema as typeof TaskCompletePayloadSchema,
  'task.fail': TaskFailPayloadSchema as typeof TaskFailPayloadSchema,
  'task.cancelled': TaskCancelledPayloadSchema as typeof TaskCancelledPayloadSchema,
  'task.approval_resolved': TaskApprovalResolvedPayloadSchema as typeof TaskApprovalResolvedPayloadSchema,
  'task.steer_sealed': TaskSteerSealedPayloadSchema as typeof TaskSteerSealedPayloadSchema,
  'task.complete_sealed': TaskCompleteSealedPayloadSchema as typeof TaskCompleteSealedPayloadSchema,
  'task.fail_sealed': TaskFailSealedPayloadSchema as typeof TaskFailSealedPayloadSchema,
  'task.decline_sealed': TaskDeclineSealedPayloadSchema as typeof TaskDeclineSealedPayloadSchema,
  'task.cancelled_sealed': TaskCancelledSealedPayloadSchema as typeof TaskCancelledSealedPayloadSchema,
  'task.progress_sealed': TaskProgressSealedPayloadSchema as typeof TaskProgressSealedPayloadSchema,
  'task.artifact_sealed': TaskArtifactSealedPayloadSchema as typeof TaskArtifactSealedPayloadSchema,
  'task.await_approval_sealed': TaskAwaitApprovalSealedPayloadSchema as typeof TaskAwaitApprovalSealedPayloadSchema,
  'e2ee.key_package.available': E2eeKeyPackageAvailablePayloadSchema as typeof E2eeKeyPackageAvailablePayloadSchema,
} as const;

export type MessageType = keyof typeof MESSAGE_PAYLOAD_SCHEMAS;

export const MESSAGE_TYPES = Object.keys(MESSAGE_PAYLOAD_SCHEMAS) as MessageType[];

/**
 * Message types the server sends to the daemon. Used by {@link EnvelopeSchema}
 * (`envelope.ts`) to decide which branches require envelope `seq` (M1
 * redelivery cursor).
 */
export const SERVER_TO_DAEMON_TYPES = [
  'task.offer_for_agent',
  'task.offer_for_agent_with_egress',
  'task.offer_for_agent_with_egress_fresh',
  'task.offer_prepared',
  'agent.egress.ack',
  'agent.message.disposition',
  'agent.content.read',
  'agent.home.projection',
  'agent.input.preparation',
  'provider.provisioning.available',
  'agent.memory.intent.available',
  'task.approve',
  'task.reject',
  'task.cancel',
  'task.steer',
  'task.offer_for_agent_sealed',
  'task.offer_for_agent_with_egress_sealed',
  'task.offer_for_agent_with_egress_fresh_sealed',
  'task.steer_sealed',
  'e2ee.key_package.available',
] as const satisfies readonly MessageType[];

/**
 * Message types the daemon sends to the server — the flip side of
 * {@link SERVER_TO_DAEMON_TYPES}. `conn.hello` is deliberately excluded: the
 * inbound gate handles a bearer-authenticated `conn.hello` as a capability
 * snapshot on its own, before the type-allow check.
 *
 * Used by `handleInboundEnvelope` (`@byok-sdk/cloud`'s `inbound.ts`) as the
 * type-allow gate for every inbound `POST /byok/messages` envelope (finding
 * P2): a `type` outside this set — a server -> daemon type arriving inbound,
 * or anything unrecognized — is rejected before it's dispatched to any
 * handler or counted `accepted` on the `/byok/messages` wire.
 */
export const DAEMON_TO_SERVER_TYPES = [
  'task.claim',
  'task.started',
  'task.decline',
  'task.progress',
  'task.artifact',
  'task.await_approval',
  'task.complete',
  'task.fail',
  'task.cancelled',
  'task.approval_resolved',
  'agent.egress.reliable',
  'agent.message.draft',
  'agent.message.publish',
  'agent.content.receipt',
  'task.complete_sealed',
  'task.fail_sealed',
  'task.decline_sealed',
  'task.cancelled_sealed',
  'task.progress_sealed',
  'task.artifact_sealed',
  'task.await_approval_sealed',
] as const satisfies readonly MessageType[];

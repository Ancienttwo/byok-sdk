import { z } from 'zod';
import { AgentHomeProjectionAgentRefSchema } from './messages';

/**
 * Host-approved Agent memory intents — the wire half.
 *
 * A Host (the only approval authority) approves one exact memory operation on
 * one device-local Agent home. The device (the only memory content authority)
 * applies it with its existing sha256 CAS at most once and reports a terminal,
 * content-free completion. This package defines only:
 *
 * - the device capability that gates the task-free server -> daemon notice
 *   `agent.memory.intent.available`, whose strict payload is exactly
 *   `{ intentId, agentRef }` (see `messages.ts`);
 * - the immutable intent a Host releases over its own device routes;
 * - the fetch request/response a device exchanges with those routes;
 * - the terminal completion a device reports and the durable readback a Host
 *   returns for it.
 *
 * Notice-and-fetch is the point: memory content never rides the mailbox or the
 * device journal. The only field that carries content is `content` on a
 * `release` of a `replace` intent.
 *
 * Path authority stays with the device. This schema applies only the syntactic
 * bounds the device ledger relies on (at most 1024 ASCII bytes that need no
 * JSON escaping); the exact memory path rule (`MEMORY.md` or
 * `notes/<safe>/…md`) and the `MEMORY.md` delete ban are evaluated by the
 * device and reported as `path_invalid` / `memory_md_not_deletable`. Host-only
 * path policy is Host vocabulary and stays out of this package, as do
 * audiences, route paths and product names.
 *
 * `operationDigest` is pinned to `@byok-sdk/core`
 * `agentMemoryIntentOperationDigest(...)`, which a device recomputes with its
 * own enrolled tenant and device ids.
 */

/** Device capability required before a Host may enqueue `agent.memory.intent.available`. */
export const AGENT_MEMORY_INTENT_CAPABILITY = 'agent-memory-intent.v1' as const;

/** Maximum UTF-8 byte length of a released `replace` body (one memory file): 256 KiB. */
export const AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES = 262_144;
/** Maximum byte length of an intent `path` (ASCII, so bytes = characters). */
export const AGENT_MEMORY_INTENT_PATH_MAX_BYTES = 1024;
/** Maximum byte length of an opaque `approvalRef` (ASCII, so bytes = characters). */
export const AGENT_MEMORY_INTENT_APPROVAL_REF_MAX_BYTES = 128;

const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u;

/** A memory file revision: `sha256:` over the file bytes (a missing file is the empty-bytes digest). */
export const AgentMemoryIntentRevisionSchema = z
  .string()
  .regex(SHA256_REVISION, 'revision must be lowercase sha256:<64 hex>');
export type AgentMemoryIntentRevision = z.infer<typeof AgentMemoryIntentRevisionSchema>;

/** The identity-and-operation binding; see `@byok-sdk/core` `agentMemoryIntentOperationDigest`. */
export const AgentMemoryIntentOperationDigestSchema = z
  .string()
  .regex(SHA256_REVISION, 'operationDigest must be lowercase sha256:<64 hex>');
export type AgentMemoryIntentOperationDigest = z.infer<typeof AgentMemoryIntentOperationDigestSchema>;

/**
 * Syntactic bound only: 1..1024 printable ASCII characters that need no JSON
 * escaping (no `"`, no `\`, no control characters). The device applies the
 * exact memory path rule.
 */
export const AgentMemoryIntentPathSchema = z
  .string()
  .min(1)
  .max(AGENT_MEMORY_INTENT_PATH_MAX_BYTES)
  .regex(/^[\x20\x21\x23-\x5b\x5d-\x7e]+$/u, 'path must be printable ASCII without quote or backslash');
export type AgentMemoryIntentPath = z.infer<typeof AgentMemoryIntentPathSchema>;

/** Opaque audit correlation. The device records it and never evaluates it. */
export const AgentMemoryIntentApprovalRefSchema = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9._:-]{1,${AGENT_MEMORY_INTENT_APPROVAL_REF_MAX_BYTES}}$`, 'u'),
    `approvalRef must be 1..${AGENT_MEMORY_INTENT_APPROVAL_REF_MAX_BYTES} characters of [A-Za-z0-9._:-]`,
  );
export type AgentMemoryIntentApprovalRef = z.infer<typeof AgentMemoryIntentApprovalRefSchema>;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const utf8 = new TextEncoder();

/** A `replace` body: well-formed Unicode whose UTF-8 encoding is at most 256 KiB. */
export const AgentMemoryIntentContentSchema = z
  .string()
  .refine((value) => !LONE_SURROGATE.test(value), 'content must be well-formed Unicode (encodable as UTF-8)')
  .refine(
    (value) => utf8.encode(value).byteLength <= AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES,
    `content must not exceed ${AGENT_MEMORY_INTENT_CONTENT_MAX_BYTES} UTF-8 bytes`,
  );
export type AgentMemoryIntentContent = z.infer<typeof AgentMemoryIntentContentSchema>;

export const AGENT_MEMORY_INTENT_OPERATIONS = ['replace', 'delete'] as const;
export const AgentMemoryIntentOperationSchema = z.enum(AGENT_MEMORY_INTENT_OPERATIONS);
export type AgentMemoryIntentOperation = z.infer<typeof AgentMemoryIntentOperationSchema>;

/**
 * The immutable Host-approved intent.
 *
 * - `replace`: `targetRevision` is the digest of the approved body and must
 *   differ from `baseRevision`; `content` appears only inside a `release`.
 * - `delete`: `targetRevision` is `null` and there is never `content`.
 */
export const AgentMemoryIntentV1Schema = z
  .object({
    intentId: z.uuid(),
    agentRef: AgentHomeProjectionAgentRefSchema,
    path: AgentMemoryIntentPathSchema,
    operation: AgentMemoryIntentOperationSchema,
    baseRevision: AgentMemoryIntentRevisionSchema,
    targetRevision: AgentMemoryIntentRevisionSchema.nullable(),
    content: AgentMemoryIntentContentSchema.optional(),
    approvalRef: AgentMemoryIntentApprovalRefSchema,
    operationDigest: AgentMemoryIntentOperationDigestSchema,
  })
  .strict()
  .superRefine((intent, ctx) => {
    if (intent.operation === 'delete') {
      if (intent.targetRevision !== null) {
        ctx.addIssue({ code: 'custom', path: ['targetRevision'], message: 'a delete intent has a null targetRevision' });
      }
      if (intent.content !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['content'], message: 'a delete intent never carries content' });
      }
      return;
    }
    if (intent.targetRevision === null) {
      ctx.addIssue({ code: 'custom', path: ['targetRevision'], message: 'a replace intent requires a targetRevision' });
    } else if (intent.targetRevision === intent.baseRevision) {
      ctx.addIssue({ code: 'custom', path: ['targetRevision'], message: 'targetRevision must differ from baseRevision' });
    }
  });
export type AgentMemoryIntentV1 = z.infer<typeof AgentMemoryIntentV1Schema>;

// ---------------------------------------------------------------------------
// Completion and readback
// ---------------------------------------------------------------------------

/**
 * Codes a Host decides on its own authority. They are the only `withheld`
 * codes and the only codes a `host_terminal` readback may carry.
 */
export const AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES = [
  'intent_revoked',
  'intent_expired',
  'placement_changed',
  'profile_revision_changed',
] as const;
export const AgentMemoryIntentHostTerminalCodeSchema = z.enum(AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES);
export type AgentMemoryIntentHostTerminalCode = z.infer<typeof AgentMemoryIntentHostTerminalCodeSchema>;

/**
 * Closed rejection set. A code names the failed check, never a value. Every
 * `rejected` completion means the device wrote no `applying` record and made
 * zero memory writes.
 */
export const AGENT_MEMORY_INTENT_REJECTION_CODES = [
  'intent_invalid',
  'path_invalid',
  'memory_md_not_deletable',
  'content_invalid',
  'intent_digest_mismatch',
  'agent_ref_mismatch',
  'agent_home_unavailable',
  ...AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES,
] as const;
export const AgentMemoryIntentRejectionCodeSchema = z.enum(AGENT_MEMORY_INTENT_REJECTION_CODES);
export type AgentMemoryIntentRejectionCode = z.infer<typeof AgentMemoryIntentRejectionCodeSchema>;

/** One device observation of the target file. The observation instant is not on the wire. */
export const AgentMemoryIntentFileObservationSchema = z
  .object({
    exists: z.boolean(),
    revision: AgentMemoryIntentRevisionSchema,
  })
  .strict();
export type AgentMemoryIntentFileObservation = z.infer<typeof AgentMemoryIntentFileObservationSchema>;

const completionIdentity = {
  intentId: z.uuid(),
  agentRef: AgentHomeProjectionAgentRefSchema,
  path: AgentMemoryIntentPathSchema,
  operation: AgentMemoryIntentOperationSchema,
  operationDigest: AgentMemoryIntentOperationDigestSchema,
} as const;

const AppliedCompletionSchema = z
  .object({ ...completionIdentity, outcome: z.literal('applied'), result: AgentMemoryIntentFileObservationSchema })
  .strict();
const ConflictCompletionSchema = z
  .object({ ...completionIdentity, outcome: z.literal('conflict'), observed: AgentMemoryIntentFileObservationSchema })
  .strict();
const RejectedCompletionSchema = z
  .object({ ...completionIdentity, outcome: z.literal('rejected'), code: AgentMemoryIntentRejectionCodeSchema })
  .strict();
const UncertainCompletionSchema = z
  .object({ ...completionIdentity, outcome: z.literal('uncertain'), observed: AgentMemoryIntentFileObservationSchema })
  .strict();

/**
 * The terminal, content-free result of one intent, reported by the device.
 *
 * - `applied`: the live-path CAS returned success; `result` is the file after it.
 * - `conflict`: the live-path CAS refused on revision; this attempt wrote nothing.
 * - `rejected`: no `applying` record was written; zero writes.
 * - `uncertain`: whether this intent wrote is unknown; `observed` is only the
 *   current file, never provenance.
 *
 * There is no non-terminal outcome.
 */
export const AgentMemoryIntentCompletionSchema = z.discriminatedUnion('outcome', [
  AppliedCompletionSchema,
  ConflictCompletionSchema,
  RejectedCompletionSchema,
  UncertainCompletionSchema,
]);
export type AgentMemoryIntentCompletion = z.infer<typeof AgentMemoryIntentCompletionSchema>;

/**
 * How the Host's durable record relates to the completion it was handed:
 *
 * - `recorded`: this completion became the intent's first terminal fact.
 * - `idempotent`: an identical completion was already recorded.
 * - `conflict`: a different completion is already recorded; it is returned.
 * - `host_terminal`: the Host had already terminated the intent on its own
 *   authority ({@link AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES}).
 */
export const AGENT_MEMORY_INTENT_READBACK_DISPOSITIONS = ['recorded', 'idempotent', 'conflict', 'host_terminal'] as const;
export const AgentMemoryIntentReadbackDispositionSchema = z.enum(AGENT_MEMORY_INTENT_READBACK_DISPOSITIONS);
export type AgentMemoryIntentReadbackDisposition = z.infer<typeof AgentMemoryIntentReadbackDispositionSchema>;

/**
 * The Host's durable terminal readback for one intent. `completion` is the
 * terminal fact the Host has STORED; on `host_terminal` it is always a
 * `rejected` completion carrying a Host code. `recordedAt` is the Host record
 * time, never a device observation time.
 */
export const AgentMemoryIntentReadbackSchema = z
  .object({
    tenantId: z.string().min(1),
    deviceId: z.string().min(1),
    intentId: z.uuid(),
    disposition: AgentMemoryIntentReadbackDispositionSchema,
    completion: AgentMemoryIntentCompletionSchema,
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((readback, ctx) => {
    if (readback.completion.intentId !== readback.intentId) {
      ctx.addIssue({ code: 'custom', path: ['completion', 'intentId'], message: 'completion intentId must equal readback intentId' });
    }
    if (
      readback.disposition === 'host_terminal' &&
      (readback.completion.outcome !== 'rejected' ||
        !(AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES as readonly string[]).includes(readback.completion.code))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['completion'],
        message: `a host_terminal readback must carry a rejected completion with one of: ${AGENT_MEMORY_INTENT_HOST_TERMINAL_CODES.join(', ')}`,
      });
    }
  });
export type AgentMemoryIntentReadback = z.infer<typeof AgentMemoryIntentReadbackSchema>;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * `held`: the device reserved a ledger slot and may receive a release.
 * `none`: the device could not reserve; the Host must not change intent state
 * or release content.
 */
export const AGENT_MEMORY_INTENT_RESERVATIONS = ['held', 'none'] as const;
export const AgentMemoryIntentReservationSchema = z.enum(AGENT_MEMORY_INTENT_RESERVATIONS);
export type AgentMemoryIntentReservation = z.infer<typeof AgentMemoryIntentReservationSchema>;

/**
 * The SDK half of a fetch. Device authentication (the tenant and device a Host
 * trusts) is Host transport vocabulary and is not part of this schema.
 */
export const AgentMemoryIntentFetchRequestSchema = z
  .object({
    intentId: z.uuid(),
    reservation: AgentMemoryIntentReservationSchema,
  })
  .strict();
export type AgentMemoryIntentFetchRequest = z.infer<typeof AgentMemoryIntentFetchRequestSchema>;

export const AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS = ['release', 'withheld', 'terminal', 'deferred'] as const;
export type AgentMemoryIntentFetchDisposition = (typeof AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS)[number];

/** Which fetch dispositions a Host may answer for each request reservation. */
export const AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS_BY_RESERVATION = {
  held: ['release', 'withheld', 'terminal'],
  none: ['terminal', 'deferred'],
} as const satisfies Record<AgentMemoryIntentReservation, readonly AgentMemoryIntentFetchDisposition[]>;

function requireNoContent(intent: AgentMemoryIntentV1, ctx: z.RefinementCtx, disposition: string): void {
  if (intent.content !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['intent', 'content'], message: `a ${disposition} fetch response never carries content` });
  }
}

const ReleaseFetchResponseSchema = z
  .object({ disposition: z.literal('release'), intent: AgentMemoryIntentV1Schema })
  .strict()
  .superRefine((response, ctx) => {
    if (response.intent.operation === 'replace' && response.intent.content === undefined) {
      ctx.addIssue({ code: 'custom', path: ['intent', 'content'], message: 'a replace release must carry content' });
    }
  });

const WithheldFetchResponseSchema = z
  .object({ disposition: z.literal('withheld'), intent: AgentMemoryIntentV1Schema, code: AgentMemoryIntentHostTerminalCodeSchema })
  .strict()
  .superRefine((response, ctx) => requireNoContent(response.intent, ctx, 'withheld'));

const TerminalFetchResponseSchema = z
  .object({ disposition: z.literal('terminal'), intent: AgentMemoryIntentV1Schema, readback: AgentMemoryIntentReadbackSchema })
  .strict()
  .superRefine((response, ctx) => {
    requireNoContent(response.intent, ctx, 'terminal');
    const { intent, readback } = response;
    if (readback.intentId !== intent.intentId) {
      ctx.addIssue({ code: 'custom', path: ['readback', 'intentId'], message: 'readback intentId must equal intent intentId' });
    }
    const completion = readback.completion;
    if (
      completion.agentRef.agentId !== intent.agentRef.agentId ||
      completion.agentRef.profileRevision !== intent.agentRef.profileRevision ||
      completion.path !== intent.path ||
      completion.operation !== intent.operation ||
      completion.operationDigest !== intent.operationDigest
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['readback', 'completion'],
        message: 'readback completion identity must equal the intent identity and operationDigest',
      });
    }
  });

const DeferredFetchResponseSchema = z
  .object({ disposition: z.literal('deferred'), intent: AgentMemoryIntentV1Schema })
  .strict()
  .superRefine((response, ctx) => requireNoContent(response.intent, ctx, 'deferred'));

/**
 * A Host fetch answer, independent of the request reservation. A device must
 * parse with {@link agentMemoryIntentFetchResponseSchemaFor} so a `release` or
 * `withheld` answer to a `none` request (or a `deferred` answer to a `held`
 * request) is refused.
 */
export const AgentMemoryIntentFetchResponseSchema = z.discriminatedUnion('disposition', [
  ReleaseFetchResponseSchema,
  WithheldFetchResponseSchema,
  TerminalFetchResponseSchema,
  DeferredFetchResponseSchema,
]);
export type AgentMemoryIntentFetchResponse = z.infer<typeof AgentMemoryIntentFetchResponseSchema>;

/** The fetch answer schema bound to the reservation the device sent. */
export function agentMemoryIntentFetchResponseSchemaFor(reservation: AgentMemoryIntentReservation) {
  const allowed: readonly AgentMemoryIntentFetchDisposition[] =
    AGENT_MEMORY_INTENT_FETCH_DISPOSITIONS_BY_RESERVATION[AgentMemoryIntentReservationSchema.parse(reservation)];
  return AgentMemoryIntentFetchResponseSchema.superRefine((response, ctx) => {
    if (!allowed.includes(response.disposition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: `a ${reservation} reservation allows only: ${allowed.join(', ')}`,
      });
    }
  });
}

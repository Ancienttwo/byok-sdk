import { z } from 'zod';
import { BlobRefSchema } from './blob';
import { PermissionPolicySchema } from './permission';
import { AgentEventOrUnknownSchema } from './agent-event';

/** Max size of an inlined artifact payload, per the delivery-model spec (<=64KB). */
const MAX_INLINE_BYTES = 64 * 1024;

function isWithinInlineByteLimit(value: string): boolean {
  return new TextEncoder().encode(value).length <= MAX_INLINE_BYTES;
}

// ---------------------------------------------------------------------------
// conn.* — connection handshake
// ---------------------------------------------------------------------------

export const RuntimeIdSchema = z.enum(['pi', 'claude', 'codex']);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

/**
 * Per-runtime feature flags reported in `conn.hello.runtimes[].capabilities`
 * (pre-freeze addition). Distinct from the connection-level `CAPABILITY_FLAGS`
 * (`version.ts`) / `conn.hello.capabilities` array: those are protocol-level
 * flags negotiated for the whole connection, while this is what one specific
 * detected runtime (pi/claude/codex) supports. The whole field is optional
 * end-to-end — older daemons omit `capabilities` entirely — and every field
 * inside it is itself optional, since detection can be partial.
 *
 * Per-tool allow/deny lists are deliberately NOT included here (noise).
 * `permissionModes` mirrors `PERMISSION_MODES` (`permission.ts`) but is kept
 * as a bare `string[]` rather than `z.enum(PERMISSION_MODES)`: this is a
 * runtime's self-reported observability data, not a control/security field,
 * so — per the freeze rule (tolerate unknown for observability, fail closed
 * for control/security; see `agent-event.ts`'s unknown-variant tolerance for
 * the same asymmetry applied to `task.progress` events) — it stays tolerant
 * of a mode string a newer runtime might report that this schema doesn't
 * enumerate yet, rather than rejecting the whole `conn.hello`.
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
  permissionModes: z.array(z.string()).optional(),
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

/** daemon -> server: opening handshake. */
export const ConnHelloPayloadSchema = z.object({
  protocolVersions: z.array(z.number().int()),
  capabilities: z.array(z.string()),
  deviceId: z.string(),
  productId: z.string(),
  /** Runtimes detected on this device (M1 gap #4; replaces `agents`). */
  runtimes: z.array(RuntimeInfoSchema).optional(),
  /**
   * Last `seq` this device has seen from the server (M1 redelivery cursor).
   * Omitted on a device's first-ever connection. The server replays any
   * server->daemon envelopes with `seq > cursor` it still holds — see
   * docs/protocol.md "At-least-once delivery".
   */
  cursor: z.number().int().optional(),
});
export type ConnHelloPayload = z.infer<typeof ConnHelloPayloadSchema>;

/** server -> daemon: handshake acknowledgement. */
export const ConnAckPayloadSchema = z.object({
  protocolVersion: z.number().int(),
  capabilities: z.array(z.string()),
  serverTime: z.iso.datetime({ offset: true }),
});
export type ConnAckPayload = z.infer<typeof ConnAckPayloadSchema>;

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
 * alternative to an inlined string). `.strict()`: like `PermissionPolicySchema`
 * (`permission.ts`), this is control data — it's the task instruction itself,
 * the thing that authorizes what work gets done — so per the freeze rule's
 * observability-vs-control asymmetry (docs/protocol.md "Freeze rule") an
 * unrecognized field here must be REJECTED, not silently stripped the way an
 * ordinary payload's unknown field is. Without `.strict()`, a hypothetical
 * future field riding along next to `blobRef` (e.g. a routing/priority
 * override) would be silently discarded instead of failing the parse —
 * exactly the kind of silent reinterpretation the freeze rule forbids for
 * control/security payloads. Consequence: adding a field to this shape
 * post-freeze is a BREAKING change (version bump required), not the usual
 * non-breaking additive-optional-field case — same as `PermissionPolicySchema`.
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
]);
export type DispatchSelection = z.infer<typeof DispatchSelectionSchema>;

/**
 * server -> daemon: offer a task for a device to claim.
 *
 * `taskId` used to be duplicated here; it is now carried only by the
 * envelope's `task_id` (M1 gap #7 — single source of truth for routing).
 */
export const TaskOfferPayloadSchema = z.object({
  instruction: z.union([z.string(), InstructionBlobRefSchema]),
  policy: PermissionPolicySchema,
  runtime: RuntimeIdSchema.optional(),
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

/** Every named toolset is required; duplicates are rejected instead of silently de-duplicated. */
export const RequiredToolsetsSchema = z
  .array(ToolsetIdSchema)
  .min(1)
  .max(16)
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `duplicate required toolset: ${id}`,
        });
      }
      seen.add(id);
    }
  });

/**
 * Additive v1 offer variant for tasks whose semantics require local MCP
 * tools. This is a distinct message type rather than an optional field on
 * `task.offer`: an older v1 daemon skips an unknown message type, whereas it
 * would legally strip an unknown optional control field and run the task
 * without its required tools. The whole payload is strict because every
 * field here affects execution authority.
 */
export const TaskOfferWithToolsetsPayloadSchema = TaskOfferPayloadSchema.extend({
  requiredToolsets: RequiredToolsetsSchema,
}).strict();
export type TaskOfferWithToolsetsPayload = z.infer<typeof TaskOfferWithToolsetsPayloadSchema>;

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
 * `approvalId` (M5, additive-minor — docs/protocol.md §5.3): OPTIONAL target
 * identity for the SPECIFIC pending approval this decision resolves, rather
 * than "whichever one is currently pending" (the pre-M5 behavior, and still
 * what happens when this field is absent — a legacy server that never
 * learned an id, or one talking to a legacy daemon). When present, the
 * daemon compares it against its own currently-dispatched approval id
 * (`ActiveTask.pendingApprovalId`, `packages/client`'s `task-runner.ts`) and
 * treats a mismatch as a stale, audit-only no-op instead of resolving
 * whatever happens to be pending right now — see `TaskRunner.handleApprove`.
 */
export const TaskApprovePayloadSchema = z.object({
  approvalId: z.string().optional(),
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
 * `approvalId` (M5, additive-minor — docs/protocol.md §5.3): same optional
 * targeting semantics as `TaskApprovePayloadSchema.approvalId` above, applied
 * to the reject path (`TaskRunner.handleReject`).
 */
export const TaskRejectPayloadSchema = z.object({
  reason: z.string().optional(),
  approvalId: z.string().optional(),
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
 * server-side control decision may read, because it is transport-shaped — a
 * long-poll-only daemon never sends `conn.hello` at all — and it describes a
 * device, not a task. This field is task-shaped: it shares a lifecycle with
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
  runtime: RuntimeIdSchema.optional(),
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
 * no compatible/available runtime, or the offered policy exceeds this
 * device's ceiling. Fail-closed rejections must use this instead of silently
 * dropping the offer.
 *
 * Decision (see docs/protocol.md "Declined vs. Failed" for the full
 * writeup): declining does *not* introduce a new `Declined` terminal state.
 * It maps onto the existing `Failed` state via a new `Offered -> Failed`
 * transition. `reason`/`retryable` intentionally mirror `TaskFailPayload`
 * exactly, because a pre-claim decline and a post-claim failure are the same
 * outcome from the dispatcher's point of view (this attempt produced no
 * result; here's whether retrying — e.g. offering to a different device —
 * makes sense), and keeping the state machine minimal avoids forking every
 * terminal-state consumer into "Failed or Declined, handle both".
 */
export const TaskDeclinePayloadSchema = z.object({
  reason: z.string(),
  retryable: z.boolean().optional(),
});
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
  seq: z.number().int(),
  events: z.array(AgentEventOrUnknownSchema),
});
export type TaskProgressPayload = z.infer<typeof TaskProgressPayloadSchema>;

/** daemon -> server: an artifact produced by the task, inline or by blob ref. */
export const TaskArtifactPayloadSchema = z.object({
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
 * `approvalId` (M5, additive-minor — docs/protocol.md §5.3): the daemon's own
 * locally-generated identity for THIS SPECIFIC pending approval
 * (`ApprovalRegistry`, `packages/client`'s `approvals.ts`) — included
 * unconditionally by an M5+ daemon, regardless of whether the connected
 * server has advertised the `approval-targeting` capability flag
 * (`version.ts`; see that flag's own doc comment for why no emission gating
 * is needed here — it's a tolerant `z.object()` field, so an older server
 * simply ignores it). Optional purely for wire tolerance with a pre-M5
 * daemon build that never set it at all: a server that never learns an id
 * for a task's current approval can't target a later `approve`/`reject`
 * decision and falls back to resolving "whichever approval is currently
 * pending" — the same behavior every server had before this field existed.
 */
export const TaskAwaitApprovalPayloadSchema = z.object({
  summary: z.string(),
  approvalId: z.string().optional(),
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
export type ResultDocumentCheck =
  | { readonly ok: true; readonly bytes: number; readonly canonical: unknown }
  | { readonly ok: false; readonly reason: 'not-serializable' }
  | { readonly ok: false; readonly reason: 'over-cap'; readonly bytes: number }
  | { readonly ok: false; readonly reason: 'not-plain-json' };

/**
 * Structural equality between a value and its own JSON round trip, written
 * out by hand (no node builtins — this package deliberately has none) over
 * exactly the three shapes pure JSON data can take.
 *
 * The asymmetry is the point: `a` is the CALLER's object, which may contain
 * anything JavaScript allows, while `b` is always the output of
 * `JSON.parse` — pure data. So every case where `a` is something JSON cannot
 * represent (a `Date`, a function, `undefined`, `NaN`, a symbol, a getter
 * that answers differently the second time, an object whose `toJSON` rewrote
 * it) shows up here as a shape or value mismatch against `b`, and is
 * rejected. `NaN !== NaN` falls out of strict equality for free, which is
 * exactly what we want: `NaN` serializes to `null`, so it is not
 * representable and must not pass.
 *
 * The one case structural comparison alone cannot see — an object whose data
 * lives somewhere other than its own enumerable string keys, e.g. a
 * populated `Map` — gets its own explicit rejection in the object branch
 * below.
 */
function isSameJsonData(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;

  const typeOfA = typeof a;
  if (typeOfA !== typeof b) return false;

  if (typeOfA !== 'object') {
    // string | number | boolean. Anything else (function, symbol, bigint,
    // undefined) can never equal a JSON.parse output, and `NaN === NaN` is
    // false, so this single comparison covers every primitive case.
    return a === b;
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const arrayA = a as unknown[];
    const arrayB = b as unknown[];
    if (arrayA.length !== arrayB.length) return false;
    for (let index = 0; index < arrayA.length; index += 1) {
      if (!isSameJsonData(arrayA[index], arrayB[index])) return false;
    }
    return true;
  }

  const objectA = a as Record<string, unknown>;
  const objectB = b as Record<string, unknown>;
  const keysA = Object.keys(objectA); // own enumerable string keys
  const keysB = Object.keys(objectB);

  // An object whose data does NOT live in its own enumerable string keys is
  // invisible to both `JSON.stringify` and the key comparison below — a
  // populated `Map`/`Set` serializes to `{}` and would otherwise compare
  // EQUAL to that `{}`, delivering an empty document as the task's truthful
  // structured result. That is the same silent-wrong-output class the whole
  // plain-data contract exists to stop, so a container-shaped value with no
  // own enumerable string keys and a non-plain prototype is rejected here.
  // Applied at every object node (this function recurses), so a nested
  // `Map`/`Set`/exotic instance dies exactly like a top-level one.
  //
  // The boundary this deliberately draws: a class instance WITH own
  // enumerable fields still passes, because its data really is in those
  // fields and survives the round trip intact. A class whose values come
  // from PROTOTYPE-level getters does not — those are invisible to JSON, so
  // such an instance is not plain JSON data and is outside this contract by
  // definition (docs/protocol.md §7.2). `Object.create(null)` is explicitly
  // fine: a null prototype is plain data, just without `Object.prototype`.
  if (keysA.length === 0) {
    const prototypeA: unknown = Object.getPrototypeOf(objectA);
    if (prototypeA !== Object.prototype && prototypeA !== null) return false;
  }

  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objectB, key)) return false;
    if (!isSameJsonData(objectA[key], objectB[key])) return false;
  }
  return true;
}

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
 *      ({@link isSameJsonData}). Any mismatch means the value was not plain
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
  let json: string | undefined;
  try {
    json = JSON.stringify(document);
  } catch {
    return { ok: false, reason: 'not-serializable' };
  }
  if (json === undefined) return { ok: false, reason: 'not-serializable' };

  const bytes = new TextEncoder().encode(json).length;
  if (bytes > RESULT_DOCUMENT_MAX_BYTES) return { ok: false, reason: 'over-cap', bytes };

  const canonical: unknown = JSON.parse(json);
  if (!isSameJsonData(document, canonical)) return { ok: false, reason: 'not-plain-json' };

  return { ok: true, bytes, canonical };
}

/**
 * daemon -> server: task finished successfully.
 *
 * `document` (additive-minor, docs/protocol.md "Freeze rule"): the OPTIONAL
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
 * Unlike `approvalId` on `task.await_approval` above, emitting this field IS
 * gated on a capability flag (`result-document`, `version.ts`): a pre-
 * `result-document` server strips it silently as an unknown key (the
 * tolerant `z.object()` behavior §1 mandates), and silently losing the
 * task's primary structured result is not a tolerable degradation the way
 * losing an observability hint is. So a daemon sends `document` only to a
 * server that advertised the flag, and fails the task loudly otherwise —
 * see `packages/client`'s `task-runner.ts`.
 */
export const TaskCompletePayloadSchema = z.object({
  summary: z.string(),
  sessionRef: z.string(),
  artifactRefs: z.array(BlobRefSchema).optional(),
  document: z
    .unknown()
    .optional()
    .refine((value) => value === undefined || checkResultDocument(value).ok, {
      message: `task.complete.document must be plain JSON data (equal to its own JSON round trip) and at most ${RESULT_DOCUMENT_MAX_BYTES} bytes as canonical JSON (UTF-8)`,
    }),
});
export type TaskCompletePayload = z.infer<typeof TaskCompletePayloadSchema>;

/** daemon -> server: task failed. */
export const TaskFailPayloadSchema = z.object({
  reason: z.string(),
  retryable: z.boolean().optional(),
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
  reason: z.string().optional(),
});
export type TaskCancelledPayload = z.infer<typeof TaskCancelledPayloadSchema>;

/**
 * daemon -> server: a pending `task.await_approval` was resolved entirely
 * LOCALLY on the device — the local control-socket `approvals.resolve` RPC,
 * a fail-closed `requestApproval` timeout, or a fail-closed eviction/finish
 * rejection (see `packages/client`'s `task-runner.ts`/`approvals.ts`) —
 * *without* a wire `task.approve`/`task.reject` ever having been exchanged
 * for it. This is the additive-minor answer to a gap the M4 Phase 3 approval
 * work left open (see the "Deferred additive candidate" note this schema
 * resolves, `docs/protocol.md`): today the server only learns of a local
 * resolution IMPLICITLY, after the fact, once the daemon's next
 * `task.progress`/`task.artifact`/`task.complete` proves the task already
 * moved on (`ConnectionHub.resumeIfImplicitlyApproved`,
 * `packages/server/src/hub.ts`) — a window in which a SaaS-side
 * `TaskHandle.approve()`/`.reject()` can independently decide (and win) the
 * server's own authoritative record before that evidence ever arrives. This
 * message lets the daemon report the local resolution explicitly and
 * immediately, narrowing that window from "until the next progress message"
 * down to ordinary network latency; the implicit-inference path stays as-is,
 * unconditionally, as the compatibility fallback for an old server that
 * never advertises the `approval_resolved` capability flag (`version.ts`) or
 * an old daemon that predates this message entirely.
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
 * deliberately future-proof (a later wave could add e.g. `'operator-cli'` as
 * a DISTINCT value without a version bump — a new enum member is additive,
 * same as a new message type or capability flag), while still being a closed,
 * typed shape today rather than an open string a typo could silently widen.
 */
export const TaskApprovalResolvedPayloadSchema = z.object({
  approvalId: z.string(),
  decision: z.enum(['approve', 'reject']),
  resolvedBy: z.enum(['local']),
  at: z.iso.datetime({ offset: true }),
});
export type TaskApprovalResolvedPayload = z.infer<typeof TaskApprovalResolvedPayloadSchema>;

// ---------------------------------------------------------------------------
// registry — single source of truth mapping message type -> payload schema
// ---------------------------------------------------------------------------

export const MESSAGE_PAYLOAD_SCHEMAS = {
  'conn.hello': ConnHelloPayloadSchema,
  'conn.ack': ConnAckPayloadSchema,
  'task.offer': TaskOfferPayloadSchema,
  'task.offer_with_toolsets': TaskOfferWithToolsetsPayloadSchema,
  'task.approve': TaskApprovePayloadSchema,
  'task.reject': TaskRejectPayloadSchema,
  'task.cancel': TaskCancelPayloadSchema,
  'task.steer': TaskSteerPayloadSchema,
  'task.claim': TaskClaimPayloadSchema,
  'task.started': TaskStartedPayloadSchema,
  'task.decline': TaskDeclinePayloadSchema,
  'task.progress': TaskProgressPayloadSchema,
  'task.artifact': TaskArtifactPayloadSchema,
  'task.await_approval': TaskAwaitApprovalPayloadSchema,
  'task.complete': TaskCompletePayloadSchema,
  'task.fail': TaskFailPayloadSchema,
  'task.cancelled': TaskCancelledPayloadSchema,
  'task.approval_resolved': TaskApprovalResolvedPayloadSchema,
} as const;

export type MessageType = keyof typeof MESSAGE_PAYLOAD_SCHEMAS;

export const MESSAGE_TYPES = Object.keys(MESSAGE_PAYLOAD_SCHEMAS) as MessageType[];

/**
 * Message types the server sends to the daemon. Used by {@link EnvelopeSchema}
 * (`envelope.ts`) to decide which branches require envelope `seq` (M1
 * redelivery cursor).
 */
export const SERVER_TO_DAEMON_TYPES = [
  'conn.ack',
  'task.offer',
  'task.offer_with_toolsets',
  'task.approve',
  'task.reject',
  'task.cancel',
  'task.steer',
] as const satisfies readonly MessageType[];

/**
 * Message types the daemon sends to the server — the flip side of
 * {@link SERVER_TO_DAEMON_TYPES}. `conn.hello` is deliberately excluded: it's
 * only ever valid as the first frame of a WS handshake (`ws-server.ts`), not
 * as ongoing inbound traffic through `ConnectionHub.handleInbound`.
 *
 * Used by `handleInbound` (`@byok-sdk/server`'s `hub.ts`) as the type-allow gate
 * for every inbound envelope, WS and `POST /byok/messages` alike (finding
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
] as const satisfies readonly MessageType[];

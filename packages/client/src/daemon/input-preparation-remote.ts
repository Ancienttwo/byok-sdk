import { awaitAdmission } from './admission-wait';
import { createHash } from 'node:crypto';
import {
  InputPreparationContextDocumentSchema,
  type AgentInputPreparationPayload,
  type InputPreparationCompletionRequest,
  type InputPreparationContextDocument,
  type InputPreparationMessage,
  type InputPreparationReadinessReason,
  type InputPreparationReceiptSummary,
  type InputPreparationRejectionReason,
} from '@byok-sdk/protocol';
import {
  INPUT_PREPARATION_REQUEST_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationErrorCodeV1,
  type InputPreparationLimitsPolicyV1,
  type InputPreparationMessageV1,
  type InputPreparationReadinessReasonV1,
  type InputPreparationReceiptV1,
  type InputPreparationRequestV1,
} from '../input-preparation';
import {
  InputPreparationRequestError,
  type InputPreparationService,
} from './input-preparation-service';
import type { InputPreparationCompletionClient } from './input-preparation-completion-client';

/**
 * C07 G4-remote, device half: turn one `agent.input.preparation` envelope into
 * an IN-PROCESS call on the B-P2 local primitive, then report a receipt
 * summary back over the authenticated completion route.
 *
 * Why in-process and not over the control socket (§17 B, and the condition
 * Owner ruling 3 attached to retiring plan A): the control socket is a local
 * operator seam with its own 64 KiB frame policy. Routing a Host-authorized
 * preparation through it would put a second framing bound in the path of a
 * request whose size is already governed by the wire's own inline/blob split,
 * and would make the daemon a client of itself. The remote path therefore
 * BYPASSES the local control channel entirely — this module imports nothing
 * from `control-protocol.ts`, `control-client.ts` or `node:net`, which is what
 * makes "zero bytes on the control socket" a structural fact rather than a
 * behaviour a test has to chase.
 *
 * Three authority rules this module holds:
 *
 * 1. `tenantId`/`deviceId` come from the LOCAL authenticated device record,
 *    never from the payload. A sender that could name them could bind a
 *    preparation to a device it does not own.
 * 2. Tools and tool-executor identities are LOCAL observations. The payload
 *    names required toolsets; the daemon's ONE prepared
 *    tool-surface entry (`./prepared-tool-surface.ts`, reached through
 *    `InputPreparationService.prepare`) resolves the launch boundary, resolves
 *    an implementation identity per server, probes them itself and
 *    fingerprints what they actually report. This module states no tool and no
 *    executor, which is why it no longer has an observation seam of its own.
 * 3. The Host's `deadlineAt` may only TIGHTEN the configured local deadline.
 *
 * Failure posture: a business refusal is REPORTED as a terminal completion so
 * the mailbox row is discharged and the cursor advances. Only a failure to
 * record or read back that outcome throws, which leaves the row
 * undelivered for redelivery — the cursor must never move past an envelope
 * whose outcome the cloud never learned.
 */

/**
 * Every local refusal code is a legal wire rejection reason. Stated as a type
 * constraint so adding a local code without adding it to the protocol enum is
 * a compile error rather than an `unknown_reason` at runtime.
 *
 * ONE-DIRECTIONAL on purpose, and the mirror is NOT asserted: the wire
 * rejection enum is deliberately a strict SUPERSET of the local codes. It also
 * carries the reasons this remote lane itself owns and the service never
 * answers with — `context_unresolvable`, `context_hash_mismatch` and
 * `deadline_elapsed` — so a `Wire extends Local` assertion would fail on
 * reasons that are correct by design.
 */
type _LocalCodesAreWireReasons = InputPreparationErrorCodeV1 extends InputPreparationRejectionReason
  ? true
  : never;
const _localCodesAreWireReasons: _LocalCodesAreWireReasons = true;
void _localCodesAreWireReasons;

/**
 * Same constraint, one surface over: every local readiness reason is a legal
 * wire readiness reason. There is no single schema authority for this pair —
 * the local set is a hand-written union in `../input-preparation` and the wire
 * set is a zod enum in `@byok-sdk/protocol` — so this assertion is what makes
 * adding a reason to one and forgetting the other a COMPILE error rather than
 * a receipt the cloud rejects at parse time.
 */
type _LocalReadinessReasonsAreWireReasons =
  InputPreparationReadinessReasonV1 extends InputPreparationReadinessReason ? true : never;
const _localReadinessReasonsAreWireReasons: _LocalReadinessReasonsAreWireReasons = true;
void _localReadinessReasonsAreWireReasons;

/**
 * And the mirror, because unlike the refusal codes above the two readiness sets
 * are meant to be EQUAL, not nested: every readiness reason the cloud can parse
 * must be one this device can actually produce. Without this direction, a
 * reason added to the zod enum alone would compile forever as a value the wire
 * admits and no device ever emits.
 */
type _WireReadinessReasonsAreLocalReasons =
  InputPreparationReadinessReason extends InputPreparationReadinessReasonV1 ? true : never;
const _wireReadinessReasonsAreLocalReasons: _WireReadinessReasonsAreLocalReasons = true;
void _wireReadinessReasonsAreLocalReasons;

/**
 * And the message support set, both directions.
 *
 * Same absence of a single schema authority, one surface worse: the local set
 * is a hand-written union in `../input-preparation`, the wire set is a zod
 * discriminated union in `@byok-sdk/protocol`, and `./control-protocol.ts`
 * carries a THIRD hand-written parse of the same shapes. These assertions are
 * what make registering a message kind in one place and forgetting another a
 * COMPILE error, instead of a context document the Host is allowed to send and
 * the device answers with `unsupported_input`. Equality, not nesting: a kind
 * the wire admits that no device can state is as broken as the reverse.
 */
type _LocalMessagesAreWireMessages = InputPreparationMessageV1 extends InputPreparationMessage ? true : never;
const _localMessagesAreWireMessages: _LocalMessagesAreWireMessages = true;
void _localMessagesAreWireMessages;

type _WireMessagesAreLocalMessages = InputPreparationMessage extends InputPreparationMessageV1 ? true : never;
const _wireMessagesAreLocalMessages: _WireMessagesAreLocalMessages = true;
void _wireMessagesAreLocalMessages;

export interface RemoteInputPreparationDeps {
  /** The authenticated local device record. Never the payload's word for it. */
  readonly deviceId: string;
  /**
   * Absent when this daemon has no `inputPreparation` section at all, or when
   * the installed native closure could not be verified. Both answer a typed
   * completion rather than throwing.
   */
  readonly service: InputPreparationService | undefined;
  readonly limits: InputPreparationLimitsPolicyV1 | undefined;
  /** Why the service is absent, when it is absent for a reason other than "unconfigured". */
  readonly unavailableReason?: InputPreparationRejectionReason;
  readonly completion: InputPreparationCompletionClient;
  /** Resolves a `BlobRef` context to text; must propagate the signal to owned I/O. */
  readonly resolveBlobText: (
    blobRef: Extract<AgentInputPreparationPayload['context'], { blobRef: unknown }>['blobRef'],
    signal: AbortSignal,
  ) => Promise<string>;
  readonly now?: () => number;
  /** Daemon lifetime cancellation for new context/admission work. */
  readonly signal?: AbortSignal;
}

/** A refusal that is reported, not thrown. */
class RemoteRejection extends Error {
  constructor(readonly reason: InputPreparationRejectionReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteInputPreparationRejection';
  }
}

function sha256Hash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * The receipt projection that leaves this device.
 *
 * Written as an explicit field list rather than a spread: D, P(D) and the
 * snapshot are never in this shape, and a spread would silently start carrying
 * whatever the local receipt gains next. The assignment to the PROTOCOL type is
 * also the drift check between the local receipt and the wire summary.
 */
/**
 * The binding, with the Host's accounting ruling copied into a mutable shape.
 *
 * Written out rather than spread so the ruling that leaves this device is
 * provably the one the record holds, field by field — a spread would carry
 * whatever the local binding gains next straight onto the wire.
 */
function toWireBinding(
  binding: InputPreparationReceiptV1['binding'],
): InputPreparationReceiptSummary['binding'] {
  const { accountingPolicyRef, ...rest } = binding;
  return {
    ...rest,
    ...(accountingPolicyRef === undefined
      ? {}
      : {
        accountingPolicyRef: {
          revision: accountingPolicyRef.revision,
          ruledRuntime: accountingPolicyRef.ruledRuntime,
          ruledTarget: { ...accountingPolicyRef.ruledTarget },
          ruledResidualKeys: [...accountingPolicyRef.ruledResidualKeys],
        },
      }),
  };
}

export function toInputPreparationReceiptSummary(
  receipt: InputPreparationReceiptV1,
): InputPreparationReceiptSummary {
  return {
    reference: receipt.reference,
    state: receipt.state,
    binding: toWireBinding(receipt.binding),
    ...(receipt.artifact === undefined
      ? {}
      : { artifact: { ...receipt.artifact, residual: receipt.artifact.residual.map((entry) => ({ ...entry })) } }),
    ...(receipt.counter === undefined ? {} : { counter: receipt.counter }),
    ready: receipt.ready,
    readinessReasons: [...receipt.readinessReasons],
    ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
    artifactExpiresAt: receipt.artifactExpiresAt,
  };
}

async function resolveContextDocument(
  payload: AgentInputPreparationPayload,
  deps: RemoteInputPreparationDeps,
  signal: AbortSignal,
): Promise<InputPreparationContextDocument> {
  let text: string;
  if ('inline' in payload.context) {
    text = payload.context.inline;
  } else {
    try {
      text = await deps.resolveBlobText(payload.context.blobRef, signal);
    } catch (cause) {
      throw new RemoteRejection('context_unresolvable', 'the referenced context blob could not be resolved', { cause });
    }
    // Verified against the payload's own `contentHash`, not only against the
    // BlobRef the resolver was handed. The two are required to agree by the
    // wire schema, so re-hashing the DECODED bytes here is what catches a store
    // that serves different bytes under the same id — before anything compiles.
    if (sha256Hash(text) !== payload.context.contentHash) {
      throw new RemoteRejection(
        'context_hash_mismatch',
        'the resolved context bytes do not match the authorized content hash',
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new RemoteRejection('bad_request', 'the authorized context is not valid JSON', { cause });
  }
  const result = InputPreparationContextDocumentSchema.safeParse(parsed);
  if (!result.success) {
    throw new RemoteRejection('bad_request', 'the authorized context is not the one strict context document shape', {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Turn one authorized envelope into the LOCAL request shape.
 *
 * It is a projection, not an assembly: every field is either copied from the
 * payload or read off this device's authenticated record. Nothing about tools
 * is decided here — `requiredToolsets` travels through to
 * the service, which reaches the one assembly entry. That is what makes "the
 * remote lane cannot state a tool schema or an executor" a structural fact
 * about this file rather than a rule it has to remember.
 */
async function buildRequest(
  payload: AgentInputPreparationPayload,
  deps: RemoteInputPreparationDeps,
  signal: AbortSignal,
): Promise<InputPreparationRequestV1> {
  const context = await resolveContextDocument(payload, deps, signal);
  return {
    format: INPUT_PREPARATION_REQUEST_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    requestId: payload.requestId,
    policyRevision: payload.policyRevision,
    scope: {
      // Local record, not payload. This is the whole point of rule 1.
      deviceId: deps.deviceId,
      agentRef: payload.agentRef.agentId,
      profileId: payload.profileId,
      profileRevision: payload.agentRef.profileRevision,
    },
    source: payload.source,
    selection: payload.selection,
    agentMemory: payload.agentMemory,
    requiredToolsets: Object.freeze([...payload.requiredToolsets]),
    snapshot: { prompt: context.prompt, messages: context.messages },
    // Host authority, carried verbatim. Absent stays absent: this lane never
    // supplies an accounting ruling the Host did not state.
    ...(payload.accountingPolicyRef === undefined
      ? {}
      : { accountingPolicyRef: payload.accountingPolicyRef }),
  };
}

/**
 * Handle one envelope payload end to end and return the completion that was
 * durably recorded by the cloud.
 *
 * Throws when the completion cannot be recorded or authoritatively read back.
 * Every other outcome, including every refusal, resolves: the row is discharged by
 * a terminal fact, not by the absence of an error.
 */
export function createRemoteInputPreparationHandler(deps: RemoteInputPreparationDeps) {
  const now = deps.now ?? Date.now;

  return async function handleRemoteInputPreparation(
    payload: AgentInputPreparationPayload,
  ): Promise<InputPreparationCompletionRequest> {
    const startedAt = now();
    const identity = {
      requestId: payload.requestId,
      agentRef: payload.agentRef,
      profileId: payload.profileId,
      policyRevision: payload.policyRevision,
    } as const;

    // Completion replay is cloud history, not a fresh readiness decision. A
    // lost PUT response (or crash before the cursor save) must recover the
    // exact first-write-wins fact even after local expiry/GC, binding drift,
    // a changed service configuration, or the Host deadline. Read failures are
    // deliberately outside the business-refusal catch: none authorizes an ack.
    const recorded = await deps.completion.readCompleted(identity);
    if (recorded !== undefined) return recorded;

    let completion: InputPreparationCompletionRequest;
    try {
      const service = deps.service;
      if (service === undefined || deps.limits === undefined) {
        throw new RemoteRejection(
          deps.unavailableReason ?? 'input_preparation_unconfigured',
          'this daemon is not configured for input preparation',
        );
      }

      const deadlineAt = Math.min(Date.parse(payload.deadlineAt), startedAt + deps.limits.preparationDeadlineMs);
      const controller = new AbortController();
      const owner = deps.signal;
      const expire = (): void => controller.abort(new RemoteRejection('deadline_elapsed', 'the authorized preparation deadline has elapsed'));
      const cancel = (): void => controller.abort(new RemoteRejection('cancelled', 'remote input preparation was cancelled'));
      const checkActive = (): void => {
        if (!Number.isFinite(deadlineAt) || now() >= deadlineAt) expire();
        controller.signal.throwIfAborted();
      };
      owner?.addEventListener('abort', cancel, { once: true });
      if (owner?.aborted) cancel();
      const deadline = setTimeout(expire, Math.min(Math.max(0, deadlineAt - now()), 2_147_483_647));
      deadline.unref?.();
      try {
        checkActive();
        const request = await awaitAdmission(() => {
          checkActive();
          return buildRequest(payload, deps, controller.signal);
        }, controller.signal);
        checkActive();
        // Carry the original absolute ceiling into authority, lock and durable
        // reservation waits. Do not race owned writes against the outer timer.
        const receipt = await service.prepare(request, { deadlineAt, signal: owner });
        checkActive();
        completion = { ...identity, outcome: 'prepared', receipt: toInputPreparationReceiptSummary(receipt) };
      } finally {
        clearTimeout(deadline);
        owner?.removeEventListener('abort', cancel);
      }
    } catch (error) {
      if (error instanceof RemoteRejection) {
        completion = { ...identity, outcome: 'rejected', reason: error.reason };
      } else if (error instanceof InputPreparationRequestError) {
        completion = { ...identity, outcome: 'rejected', reason: error.code };
      } else {
        // An untyped fault is this daemon's own storage/runtime problem, not a
        // verdict about the request. Rethrowing keeps the mailbox row and its
        // cursor in place for operator repair instead of recording a terminal
        // outcome nobody computed.
        throw error;
      }
    }

    await deps.completion.complete(completion);
    return completion;
  };
}

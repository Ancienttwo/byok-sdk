import { createHash } from 'node:crypto';
import {
  InputPreparationContextDocumentSchema,
  type AgentInputPreparationPayload,
  type InputPreparationCompletionRequest,
  type InputPreparationContextDocument,
  type InputPreparationReceiptSummary,
  type InputPreparationRejectionReason,
} from '@byok-sdk/protocol';
import {
  INPUT_PREPARATION_REQUEST_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationErrorCodeV1,
  type InputPreparationLimitsPolicyV1,
  type InputPreparationReceiptV1,
  type InputPreparationRequestV1,
  type InputPreparationToolV1,
} from '../input-preparation';
import { McpAuthorityError } from '../mcp/client';
import type { McpToolsetServerObservation } from '../mcp/observation';
import { projectMcpTools, qualifiedMcpToolName } from '../mcp/projection';
import { buildToolExecutorsFromObservation } from '../adapters/pi/input-preparation';
import {
  InputPreparationRequestError,
  inputPreparationRuntimeIdentityString,
  type InputPreparationService,
} from './input-preparation-service';
import type { McpLaunchAttestation } from './trusted-launch-cwd';
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
 *    names required toolsets; this module probes those servers itself and
 *    fingerprints what they actually report.
 * 3. The Host's `deadlineAt` may only TIGHTEN the configured local deadline.
 *
 * Failure posture: a business refusal is REPORTED as a terminal completion so
 * the mailbox row is discharged and the cursor advances. Only a failure to
 * record that outcome (the completion PUT) throws, which leaves the row
 * undelivered for redelivery — the cursor must never move past an envelope
 * whose outcome the cloud never learned.
 */

/**
 * Every local refusal code is a legal wire rejection reason. Stated as a type
 * constraint so adding a local code without adding it to the protocol enum is
 * a compile error rather than an `unknown_reason` at runtime.
 */
type _LocalCodesAreWireReasons = InputPreparationErrorCodeV1 extends InputPreparationRejectionReason
  ? true
  : never;
const _localCodesAreWireReasons: _LocalCodesAreWireReasons = true;
void _localCodesAreWireReasons;

/** What the daemon observed for the payload's `requiredToolsets`. */
export interface RemoteInputPreparationObservation {
  /** Actual verified direct-spawn boundary used by the observation probe. */
  readonly launch: McpLaunchAttestation;
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  /** `toolsetId` -> the registry's definition revision. Every observed toolset must appear. */
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
}

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
  /** Resolves a `BlobRef` context to text. The inline form never reaches it. */
  readonly resolveBlobText: (
    blobRef: Extract<AgentInputPreparationPayload['context'], { blobRef: unknown }>['blobRef'],
  ) => Promise<string>;
  readonly observeToolsets: (requiredToolsets: readonly string[]) => Promise<RemoteInputPreparationObservation>;
  readonly now?: () => number;
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
export function toInputPreparationReceiptSummary(
  receipt: InputPreparationReceiptV1,
): InputPreparationReceiptSummary {
  return {
    reference: receipt.reference,
    state: receipt.state,
    binding: receipt.binding,
    ...(receipt.artifact === undefined ? {} : { artifact: receipt.artifact }),
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
): Promise<InputPreparationContextDocument> {
  let text: string;
  if ('inline' in payload.context) {
    text = payload.context.inline;
  } else {
    try {
      text = await deps.resolveBlobText(payload.context.blobRef);
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

async function buildRequest(
  payload: AgentInputPreparationPayload,
  deps: RemoteInputPreparationDeps,
  service: InputPreparationService,
): Promise<InputPreparationRequestV1> {
  const context = await resolveContextDocument(payload, deps);

  let observed: RemoteInputPreparationObservation;
  try {
    observed = await deps.observeToolsets(payload.requiredToolsets);
  } catch (cause) {
    throw new RemoteRejection(
      'toolsets_unobservable',
      'a required MCP toolset server could not be observed on this device',
      { cause },
    );
  }

  // The model-visible tool set is what the servers THEMSELVES reported, in the
  // core's one canonical order — the same order the ordinary extension
  // registers and the model is shown, so a prepared digest cannot depend on
  // which consumer built it.
  let tools: InputPreparationToolV1[];
  try {
    tools = projectMcpTools(observed.observation).map((tool) => ({
      name: qualifiedMcpToolName(tool.serverName, tool.toolName),
      description: tool.description,
      // No `?? {}` fallback: `observation.ts`'s `validateTool` already refuses a
      // tool whose `inputSchema` is absent or is not a JSON object, so an
      // empty-schema default here would be dead code posing as a safety net —
      // and, if it ever were reachable, it would count a schema no model was shown.
      parameters: tool.inputSchema as Readonly<Record<string, unknown>>,
    }));
  } catch (cause) {
    if (!(cause instanceof McpAuthorityError)) throw cause;
    throw new RemoteRejection('unsupported_input', 'the observed MCP tool identities are ambiguous', { cause });
  }

  let toolExecutors: Readonly<Record<string, string>>;
  try {
    ({ toolExecutors } = await buildToolExecutorsFromObservation({
      observation: observed.observation,
      launch: observed.launch,
      // This task-free lane fingerprints the complete observed snapshot it
      // compiled above. Non-narrowing projection is explicit; it grants no
      // execution permission and the unattested receipt remains not-ready.
      permissionMode: 'auto',
      toolsetDefinitionRevisions: observed.toolsetDefinitionRevisions,
      // Declared limit for this slice: the remote lane compiles the observed
      // MCP toolset tools only. Pi's own native tools are selected by a runtime
      // policy this task-free path never resolves, and inventing one here would
      // put a tool in the manifest that no authority admitted.
      nativeTools: [],
      runtimeIdentity: inputPreparationRuntimeIdentityString(service.runtime),
    }));
  } catch (cause) {
    throw new RemoteRejection('unsupported_input', 'the observed toolsets could not be fingerprinted', { cause });
  }

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
    snapshot: { prompt: context.prompt, messages: context.messages, tools },
    toolExecutors,
  };
}

/**
 * Handle one envelope payload end to end and return the completion that was
 * durably recorded by the cloud.
 *
 * Throws only when the completion could not be recorded. Every other outcome —
 * including every refusal — resolves, because the mailbox row is discharged by
 * a terminal fact, not by the absence of an error.
 */
export function createRemoteInputPreparationHandler(deps: RemoteInputPreparationDeps) {
  const now = deps.now ?? Date.now;

  return async function handleRemoteInputPreparation(
    payload: AgentInputPreparationPayload,
  ): Promise<InputPreparationCompletionRequest> {
    const identity = {
      requestId: payload.requestId,
      agentRef: payload.agentRef,
      profileId: payload.profileId,
      policyRevision: payload.policyRevision,
    } as const;

    let completion: InputPreparationCompletionRequest;
    try {
      const service = deps.service;
      if (service === undefined || deps.limits === undefined) {
        throw new RemoteRejection(
          deps.unavailableReason ?? 'input_preparation_unconfigured',
          'this daemon is not configured for input preparation',
        );
      }

      // The Host deadline can only ever TIGHTEN the configured bound. An
      // already-elapsed one refuses before a single byte is compiled rather
      // than after, because a preparation that cannot be consumed is work this
      // device should never have started.
      const remainingMs = Date.parse(payload.deadlineAt) - now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        throw new RemoteRejection('deadline_elapsed', 'the authorized preparation deadline has already elapsed');
      }

      const request = await buildRequest(payload, deps, service);
      // Re-delivery is absorbed by the store's own reserve -> `existing` path:
      // the same `(scope, Agent, requestId)` under the same normalized digest
      // returns the durable receipt without a second compile or a second
      // counter call, so two deliveries produce two EQUAL completions.
      const receipt = await service.prepare(request, {
        deadlineMs: Math.min(remainingMs, deps.limits.preparationDeadlineMs),
      });
      completion = { ...identity, outcome: 'prepared', receipt: toInputPreparationReceiptSummary(receipt) };
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

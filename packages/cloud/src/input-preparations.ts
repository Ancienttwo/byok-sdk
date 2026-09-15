/**
 * Durable remote input-preparation facts.
 *
 * Exactly the composition `agent-home-projections.ts` uses, for exactly the
 * same reason: the desired request and the terminal completion are two
 * IMMUTABLE first-write-wins receipts in the tenant-scoped receipt store, so
 * this module needs no second mutable authority merely to survive a restart,
 * and a replayed write is decided by comparing bodies rather than by trusting
 * whichever writer arrived last.
 *
 * The one idempotency key is `(deviceId, agentRef, requestId)`, minted by the
 * Host and carried unchanged through the cloud receipt, the device's durable
 * namespace and the completion. A Host that times out therefore RE-READS
 * status; it never mints a second requestId for the same turn, which is what
 * keeps a duplicate from becoming a second counter call downstream.
 */
import {
  AgentInputPreparationPayloadSchema,
  InputPreparationCompletionRequestSchema,
  type AgentInputPreparationPayload,
  type InputPreparationCompletionRequest,
  type InputPreparationReadback,
} from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
import { agentReliabilityKey } from './agent-reliability';
import { ByokCloudError } from './errors';
import type { TenantBoundReceipts } from './tenant-stores';

/** Exact request identity a host must echo to read back durable preparation status. */
export interface InputPreparationReceiptInput {
  readonly requestId: string;
  readonly agentRef: AgentInputPreparationPayload['agentRef'];
}

export function inputPreparationRequestKey(
  deviceId: string,
  agentRef: AgentInputPreparationPayload['agentRef'],
  requestId: string,
): string {
  return agentReliabilityKey('agent-input-preparation-request', deviceId, agentRef, requestId);
}

export function inputPreparationCompletionKey(
  deviceId: string,
  agentRef: AgentInputPreparationPayload['agentRef'],
  requestId: string,
): string {
  return agentReliabilityKey('agent-input-preparation-completion', deviceId, agentRef, requestId);
}

/**
 * Whole-body equality, not a field subset.
 *
 * The desired fact is the ENTIRE authorized request — source digest, model
 * selection, deadline, context and required toolsets alike. Comparing only the
 * identity fields would let the same requestId silently re-bind to a different
 * model, a different context or a looser deadline, which is precisely the
 * substitution the immutable receipt exists to prevent. Both sides are already
 * schema-parsed, so key order is the only degree of freedom left, and the
 * stored body is re-serialized from a parse for that reason.
 */
export function sameInputPreparationRequest(
  expected: AgentInputPreparationPayload,
  actual: AgentInputPreparationPayload,
): boolean {
  return canonicalRequestBody(expected) === canonicalRequestBody(actual);
}

function canonicalRequestBody(payload: AgentInputPreparationPayload): string {
  return JSON.stringify(AgentInputPreparationPayloadSchema.parse(payload));
}

export function receiptMatchesInputPreparation(
  request: AgentInputPreparationPayload,
  receipt: InputPreparationCompletionRequest,
): boolean {
  return (
    receipt.requestId === request.requestId &&
    receipt.agentRef.agentId === request.agentRef.agentId &&
    receipt.agentRef.profileRevision === request.agentRef.profileRevision &&
    receipt.profileId === request.profileId &&
    receipt.policyRevision === request.policyRevision
  );
}

export function statusInputMatchesInputPreparation(
  request: AgentInputPreparationPayload,
  input: InputPreparationReceiptInput,
): boolean {
  return (
    input.requestId === request.requestId &&
    input.agentRef.agentId === request.agentRef.agentId &&
    input.agentRef.profileRevision === request.agentRef.profileRevision
  );
}

function parseRequestBody(body: string): AgentInputPreparationPayload {
  try {
    return AgentInputPreparationPayloadSchema.parse(JSON.parse(body));
  } catch (error) {
    throw new ByokCloudError(
      'input_preparation_receipt_invalid',
      'Stored input-preparation request is not a valid immutable desired fact.',
      { cause: error },
    );
  }
}

function parseCompletionBody(body: string): InputPreparationCompletionRequest {
  try {
    return InputPreparationCompletionRequestSchema.parse(JSON.parse(body));
  } catch (error) {
    throw new ByokCloudError(
      'input_preparation_receipt_invalid',
      'Stored input-preparation completion is not a valid immutable receipt fact.',
      { cause: error },
    );
  }
}

function terminalReadback(
  tenant: TenantId,
  deviceId: string,
  request: AgentInputPreparationPayload,
  completion: InputPreparationCompletionRequest,
  completedAt: string,
): InputPreparationReadback {
  const common = {
    tenantId: tenant,
    deviceId,
    requestId: request.requestId,
    agentRef: request.agentRef,
    profileId: request.profileId,
    policyRevision: request.policyRevision,
    completedAt,
  } as const;
  return completion.outcome === 'prepared'
    ? { ...common, status: 'prepared', receipt: completion.receipt }
    : { ...common, status: 'rejected', reason: completion.reason };
}

export async function readInputPreparationStatus(
  receipts: TenantBoundReceipts,
  tenant: TenantId,
  deviceId: string,
  input: InputPreparationReceiptInput,
): Promise<InputPreparationReadback | undefined> {
  const storedRequest = await receipts.get(inputPreparationRequestKey(deviceId, input.agentRef, input.requestId));
  if (storedRequest === undefined) return undefined;

  const request = parseRequestBody(storedRequest.body);
  if (!statusInputMatchesInputPreparation(request, input)) {
    throw new ByokCloudError(
      'input_preparation_request_conflict',
      `Input-preparation request ${input.requestId} does not match its immutable desired fact.`,
    );
  }

  const storedCompletion = await receipts.get(
    inputPreparationCompletionKey(deviceId, request.agentRef, input.requestId),
  );
  if (storedCompletion === undefined) {
    return {
      tenantId: tenant,
      deviceId,
      requestId: request.requestId,
      agentRef: request.agentRef,
      profileId: request.profileId,
      policyRevision: request.policyRevision,
      status: 'pending',
    };
  }

  const completion = parseCompletionBody(storedCompletion.body);
  if (!receiptMatchesInputPreparation(request, completion)) {
    throw new ByokCloudError(
      'input_preparation_receipt_mismatch',
      `Input-preparation completion ${input.requestId} does not match its immutable desired fact.`,
    );
  }
  return terminalReadback(tenant, deviceId, request, completion, storedCompletion.recordedAt);
}

export async function recordInputPreparationCompletion(
  receipts: TenantBoundReceipts,
  tenant: TenantId,
  deviceId: string,
  receiptInput: InputPreparationCompletionRequest,
): Promise<InputPreparationReadback> {
  const receipt = InputPreparationCompletionRequestSchema.parse(receiptInput);
  const storedRequest = await receipts.get(
    inputPreparationRequestKey(deviceId, receipt.agentRef, receipt.requestId),
  );
  if (storedRequest === undefined) {
    throw new ByokCloudError(
      'input_preparation_request_not_found',
      `Input-preparation request ${receipt.requestId} was not found for this device.`,
    );
  }
  const request = parseRequestBody(storedRequest.body);
  if (!receiptMatchesInputPreparation(request, receipt)) {
    throw new ByokCloudError(
      'input_preparation_receipt_mismatch',
      `Input-preparation completion ${receipt.requestId} does not exactly match its desired fact.`,
    );
  }

  // First write wins. An identical replay (the device retried its completion
  // after a lost response) reads back the SAME terminal fact; a different body
  // under the same key is a conflict, never an overwrite — a second, different
  // terminal outcome for one preparation is not a thing that can be true.
  const body = JSON.stringify(receipt);
  const storedCompletion = await receipts.record({
    key: inputPreparationCompletionKey(deviceId, request.agentRef, receipt.requestId),
    body,
  });
  if (!storedCompletion.created && storedCompletion.receipt.body !== body) {
    throw new ByokCloudError(
      'input_preparation_completion_conflict',
      `Input-preparation request ${receipt.requestId} already has a different terminal completion.`,
    );
  }

  return terminalReadback(
    tenant,
    deviceId,
    request,
    parseCompletionBody(storedCompletion.receipt.body),
    storedCompletion.receipt.recordedAt,
  );
}

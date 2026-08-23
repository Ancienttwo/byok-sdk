/**
 * Durable task-free Agent-home projection facts.
 *
 * Desired projection and completion are deliberately two immutable request
 * receipts.  The receipt store is tenant-scoped and first-write-wins, so the
 * composition does not need a second mutable projection authority merely to
 * survive a process restart.
 */
import {
  AgentHomeProjectionCompletionRequestSchema,
  AgentHomeProjectionPayloadSchema,
  type AgentHomeProjectionPayload,
  type AgentHomeProjectionCompletionRequest,
  type AgentHomeProjectionReadback,
} from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
import { ByokCloudError } from './errors';
import type { TenantBoundReceipts } from './tenant-stores';

export interface AgentHomeProjectionReceiptInput {
  readonly requestId: string;
  readonly agentRef: AgentHomeProjectionPayload['agentRef'];
  readonly projectionHash: AgentHomeProjectionPayload['projectionHash'];
}

export function agentHomeProjectionRequestKey(deviceId: string, requestId: string): string {
  return `agent-home-projection:v1:${deviceId}:${requestId}:request`;
}

export function agentHomeProjectionCompletionKey(deviceId: string, requestId: string): string {
  return `agent-home-projection:v1:${deviceId}:${requestId}:completion`;
}

export function sameAgentHomeProjectionRequest(
  expected: AgentHomeProjectionPayload,
  actual: AgentHomeProjectionPayload,
): boolean {
  return (
    expected.requestId === actual.requestId &&
    expected.agentRef.agentId === actual.agentRef.agentId &&
    expected.agentRef.profileRevision === actual.agentRef.profileRevision &&
    expected.projectionHash === actual.projectionHash &&
    JSON.stringify(expected.projection) === JSON.stringify(actual.projection)
  );
}

export function receiptMatchesAgentHomeProjection(
  request: AgentHomeProjectionPayload,
  receipt: AgentHomeProjectionCompletionRequest,
): boolean {
  return (
    receipt.requestId === request.requestId &&
    receipt.agentRef.agentId === request.agentRef.agentId &&
    receipt.agentRef.profileRevision === request.agentRef.profileRevision &&
    receipt.projectionHash === request.projectionHash
  );
}

export function statusInputMatchesAgentHomeProjection(
  request: AgentHomeProjectionPayload,
  input: AgentHomeProjectionReceiptInput,
): boolean {
  return (
    input.requestId === request.requestId &&
    input.agentRef.agentId === request.agentRef.agentId &&
    input.agentRef.profileRevision === request.agentRef.profileRevision &&
    input.projectionHash === request.projectionHash
  );
}

function parseRequestBody(body: string): AgentHomeProjectionPayload {
  try {
    return AgentHomeProjectionPayloadSchema.parse(JSON.parse(body));
  } catch (error) {
    throw new ByokCloudError(
      'agent_home_projection_receipt_invalid',
      'Stored Agent-home projection request is not a valid immutable projection fact.',
      { cause: error },
    );
  }
}

function parseCompletionBody(body: string): AgentHomeProjectionCompletionRequest {
  try {
    return AgentHomeProjectionCompletionRequestSchema.parse(JSON.parse(body));
  } catch (error) {
    throw new ByokCloudError(
      'agent_home_projection_receipt_invalid',
      'Stored Agent-home projection completion is not a valid immutable receipt fact.',
      { cause: error },
    );
  }
}

export async function readAgentHomeProjectionStatus(
  receipts: TenantBoundReceipts,
  tenant: TenantId,
  deviceId: string,
  input: AgentHomeProjectionReceiptInput,
): Promise<AgentHomeProjectionReadback | undefined> {
  const storedRequest = await receipts.get(agentHomeProjectionRequestKey(deviceId, input.requestId));
  if (storedRequest === undefined) return undefined;

  const request = parseRequestBody(storedRequest.body);
  if (!statusInputMatchesAgentHomeProjection(request, input)) {
    throw new ByokCloudError(
      'agent_home_projection_request_conflict',
      `Agent-home projection request ${input.requestId} does not match its immutable desired fact.`,
    );
  }

  const storedCompletion = await receipts.get(agentHomeProjectionCompletionKey(deviceId, input.requestId));
  if (storedCompletion === undefined) {
    return {
      tenantId: tenant,
      deviceId,
      requestId: request.requestId,
      agentRef: request.agentRef,
      projectionHash: request.projectionHash,
      status: 'pending',
    };
  }

  const completion = parseCompletionBody(storedCompletion.body);
  if (!receiptMatchesAgentHomeProjection(request, completion)) {
    throw new ByokCloudError(
      'agent_home_projection_receipt_mismatch',
      `Agent-home projection completion ${input.requestId} does not match its immutable desired fact.`,
    );
  }
  return {
    tenantId: tenant,
    deviceId,
    requestId: request.requestId,
    agentRef: request.agentRef,
    projectionHash: request.projectionHash,
    status: completion.outcome,
    completedAt: storedCompletion.recordedAt,
  };
}

export async function recordAgentHomeProjectionCompletion(
  receipts: TenantBoundReceipts,
  tenant: TenantId,
  deviceId: string,
  receiptInput: AgentHomeProjectionCompletionRequest,
): Promise<AgentHomeProjectionReadback> {
  const receipt = AgentHomeProjectionCompletionRequestSchema.parse(receiptInput);
  const storedRequest = await receipts.get(agentHomeProjectionRequestKey(deviceId, receipt.requestId));
  if (storedRequest === undefined) {
    throw new ByokCloudError(
      'agent_home_projection_request_not_found',
      `Agent-home projection request ${receipt.requestId} was not found for this device.`,
    );
  }
  const request = parseRequestBody(storedRequest.body);
  if (!receiptMatchesAgentHomeProjection(request, receipt)) {
    throw new ByokCloudError(
      'agent_home_projection_receipt_mismatch',
      `Agent-home projection completion ${receipt.requestId} does not exactly match its desired fact.`,
    );
  }

  const body = JSON.stringify(receipt);
  const storedCompletion = await receipts.record({
    key: agentHomeProjectionCompletionKey(deviceId, receipt.requestId),
    body,
  });
  if (!storedCompletion.created && storedCompletion.receipt.body !== body) {
    throw new ByokCloudError(
      'agent_home_projection_completion_conflict',
      `Agent-home projection request ${receipt.requestId} already has a different terminal completion.`,
    );
  }

  return {
    tenantId: tenant,
    deviceId,
    requestId: request.requestId,
    agentRef: request.agentRef,
    projectionHash: request.projectionHash,
    status: receipt.outcome,
    completedAt: storedCompletion.receipt.recordedAt,
  };
}

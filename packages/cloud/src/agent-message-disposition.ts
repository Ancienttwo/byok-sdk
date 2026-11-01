import {
  AgentMessageDispositionPayloadSchema,
  AgentMessagePublishPayloadSchema,
  sealedAgentMessageMaxContentLength,
  sealedPayloadPaddedLength,
  type AgentMessageDispositionPayload,
  type AgentMessagePublishPayload,
  type AgentMessagePublishPlainPayload,
  type AgentMessagePublishSealedPayload,
  type AgentMessageServerContext,
  type AgentRef,
} from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';

/** A product consumer's terminal decision on one Agent message. */
export interface AgentMessageDecision {
  readonly outcome: 'accepted' | 'held' | 'refused';
  readonly reasonCode?: string;
}

/** What a product consumer reads about one Agent message; the payload is the received one. */
export interface AgentMessageConsumeInput<Payload> {
  readonly tenant: TenantId;
  readonly deviceId: string;
  readonly taskId: string;
  readonly context: AgentMessageServerContext;
  readonly payload: Payload;
}

/**
 * The product consumers of Agent messages. `consume` takes a plaintext message;
 * `consumeSealed` takes the sealed message of a task whose `sealing` names
 * `agent-message` (#1045), which only a member can open.
 */
export interface AgentMessageConsumers {
  consume?(input: AgentMessageConsumeInput<AgentMessagePublishPlainPayload>): Promise<AgentMessageDecision>;
  consumeSealed?(input: AgentMessageConsumeInput<AgentMessagePublishSealedPayload>): Promise<AgentMessageDecision>;
}

/**
 * Whether the message fits the frozen byte limit: the exact `byteCount` of a
 * plaintext message, or the one padded length a body of that limit can seal to.
 */
export function agentMessageWithinLimit(payload: AgentMessagePublishPayload, maxBytes: number): boolean {
  return payload.sealed === undefined
    ? payload.byteCount <= maxBytes
    : payload.sealed.paddedLength <= sealedPayloadPaddedLength(4 + sealedAgentMessageMaxContentLength(maxBytes));
}

/** The disposition names a sealed message by its `contentMac` and a plaintext one by its `contentHash`. */
export function sameAgentMessageContent(payload: AgentMessagePublishPayload, disposition: AgentMessageDispositionPayload): boolean {
  return payload.sealed === undefined
    ? disposition.contentMac === undefined && disposition.contentHash === payload.contentHash
    : disposition.contentHash === undefined && disposition.contentMac === payload.sealed.contentMac;
}

export function parseAgentMessageDisposition(
  payload: AgentMessagePublishPayload,
  terminalBody: string,
): AgentMessageDispositionPayload {
  // This is persisted SDK authority. Corruption cannot mean "not yet accepted".
  const invalid = () => new Error('Invalid persisted Agent message disposition.');
  let decoded: unknown;
  try { decoded = JSON.parse(terminalBody); } catch { throw invalid(); }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw invalid();
  const record = decoded as Record<string, unknown>;
  const storedPayload = AgentMessagePublishPayloadSchema.safeParse(record.payload);
  const storedDisposition = AgentMessageDispositionPayloadSchema.safeParse(record.disposition);
  if (!storedPayload.success || !storedDisposition.success ||
      JSON.stringify(record.payload) !== JSON.stringify(payload)) throw invalid();
  const disposition = storedDisposition.data;
  if (!sameAgentRef(payload.agentRef, disposition.agentRef) ||
      disposition.sessionRef !== payload.sessionRef || disposition.contract !== payload.contract ||
      disposition.messageId !== payload.messageId || disposition.cursor !== payload.cursor ||
      !sameAgentMessageContent(payload, disposition)) throw invalid();
  return disposition;
}

export function sameAgentRef(expected: AgentRef, actual: AgentRef | undefined): boolean {
  return actual?.agentId === expected.agentId && actual.profileRevision === expected.profileRevision;
}

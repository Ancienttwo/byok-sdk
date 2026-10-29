import {
  AgentMessageDispositionPayloadSchema,
  AgentMessagePublishPayloadSchema,
  type AgentMessageDispositionPayload,
  type AgentMessagePublishPayload,
  type AgentRef,
} from '@byok-sdk/protocol';

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
      disposition.contentHash !== payload.contentHash) throw invalid();
  return disposition;
}

export function sameAgentRef(expected: AgentRef, actual: AgentRef | undefined): boolean {
  return actual?.agentId === expected.agentId && actual.profileRevision === expected.profileRevision;
}

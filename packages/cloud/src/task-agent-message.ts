import { z } from 'zod';
import {
  AgentRefSchema, AgentMessageEgressRequirementSchema, AgentMessageServerContextSchema, AgentMessagePublishPayloadSchema,
  type AgentRef, type AgentMessagePublishPayload, type AgentMessageServerContext, type AgentMessageDispositionPayload,
} from '@byok-sdk/protocol';
import type { TenantStores } from './tenant-stores';
import { agentMessageWithinLimit, parseAgentMessageDisposition } from './agent-message-disposition';
import { assertTaskContentPresent } from './task-redaction';

/**
 * SDK transmission evidence; payload remains untrusted and never authors a Host
 * product message. A task whose `sealing` names `agent-message` (#1045) holds
 * the sealed message, which only a member can open.
 */
export interface TaskAgentMessage {
  readonly payload: AgentMessagePublishPayload;
  readonly context: AgentMessageServerContext;
  /** Absent while the exact first-message reservation remains pending. */
  readonly disposition?: AgentMessageDispositionPayload;
}

const FrozenMessageBinding = z.object({
  agentRef: AgentRefSchema, sessionRef: z.string().min(1).optional(),
  requirement: AgentMessageEgressRequirementSchema, context: AgentMessageServerContextSchema,
}).strict();

function sameRef(a: AgentRef, b: AgentRef): boolean {
  return a.agentId === b.agentId && a.profileRevision === b.profileRevision;
}

/** Discover the one durable message without requiring the Host to have received its body. */
export async function readTaskAgentMessage(
  stores: TenantStores, deviceId: string, taskId: string, expectedRef: AgentRef,
): Promise<TaskAgentMessage | undefined> {
  const agentRef = AgentRefSchema.parse(expectedRef);
  const attempt = await readMessageAttempt(stores, deviceId, taskId, agentRef);
  if (attempt === undefined) return undefined;
  const admission = await stores.tasks.readTaskAgentMessage({ taskId, deviceId });
  if (!admission) return undefined;
  const invalid = () => new Error('Invalid persisted task Agent message.');
  const binding = await stores.receipts.get(`agent-message-offer:${deviceId}:${taskId}`);
  if (!binding) throw invalid();
  assertTaskContentPresent(taskId, admission.payloadBody);
  assertTaskContentPresent(taskId, binding.body);
  let body: unknown, frozenBody: unknown;
  try { body = JSON.parse(admission.payloadBody); frozenBody = JSON.parse(binding.body); } catch { throw invalid(); }
  const parsed = AgentMessagePublishPayloadSchema.safeParse(body);
  const frozen = FrozenMessageBinding.safeParse(frozenBody);
  if (!parsed.success || !frozen.success) throw invalid();
  const payload = parsed.data;
  if (admission.messageId !== payload.messageId || JSON.stringify(payload) !== admission.payloadBody
    || !sameRef(payload.agentRef, agentRef) || !sameRef(frozen.data.agentRef, agentRef)
    || payload.contract !== frozen.data.requirement.contract || payload.contentType !== frozen.data.requirement.contentType
    || (frozen.data.sessionRef !== undefined && payload.sessionRef !== frozen.data.sessionRef)
    || !agentMessageWithinLimit(payload, frozen.data.requirement.maxBytes)) throw invalid();
  // A consumer may have refused precisely because the sender's body/hash/byte
  // claims were invalid. Readback preserves that received payload and decision;
  // it must not reinterpret a refusal as storage corruption or product acceptance.
  const disposition = admission.terminalBody === undefined ? undefined : parseAgentMessageDisposition(payload, admission.terminalBody);
  return { payload, context: frozen.data.context, ...(disposition === undefined ? {} : { disposition }) };
}


/** One frozen identity check shared by message and draft readers. */
export async function readTaskAgentMessageBinding(
  stores: TenantStores, deviceId: string, taskId: string, agentRef: AgentRef,
) {
  const attempt = await readMessageAttempt(stores, deviceId, taskId, agentRef);
  if (attempt === undefined) return undefined;
  const binding = await stores.receipts.get(`agent-message-offer:${deviceId}:${taskId}`);
  if (!binding) return undefined;
  assertTaskContentPresent(taskId, binding.body);
  let value: unknown;
  try { value = JSON.parse(binding.body); } catch { throw new Error('Invalid persisted task Agent message.'); }
  const frozen = FrozenMessageBinding.safeParse(value);
  if (!frozen.success) throw new Error('Invalid persisted task Agent message.');
  if (!sameRef(frozen.data.agentRef, agentRef)) return undefined;
  return { attempt, frozen: frozen.data };
}

async function readMessageAttempt(stores: TenantStores, deviceId: string, taskId: string, agentRef: AgentRef) {
  const attempt = await stores.tasks.get(taskId);
  if (!attempt || attempt.tenantId !== stores.tenant || attempt.taskId !== taskId || attempt.deviceId !== deviceId
    || !attempt.agentRef || !sameRef(attempt.agentRef, agentRef)) return undefined;
  return attempt;
}

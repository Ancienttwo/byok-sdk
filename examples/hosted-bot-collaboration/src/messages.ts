import type { PoolClient } from 'pg';
import type { ByokCloudOptions, TenantId } from '@byok-sdk/cloud';
import { canonical } from '@byok-sdk/server/execution-core';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { CommitConflict, revisionOf, type CommitResult } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { earlierIntent, frozenIntent } from './intents';
import { storedKey } from './layout';
import { acceptedReply, commitStored } from './retention';
import type { Decision, HostedCollaborationStore, StorePorts } from './store';

/** The SDK admission hook that H installs (#793 D2c). */
export type AgentMessageConsumer = NonNullable<ByokCloudOptions['agentMessage']>;
export type AgentMessageInput = Parameters<AgentMessageConsumer['consume']>[0];
/** H never holds a message: each decision is final. */
export type MessageDecision = { outcome: 'accepted' } | { outcome: 'refused'; reasonCode: string };

/** The command id of an Agent message, as L keys it. */
export const messageCommandId = (input: AgentMessageInput): string => `${input.taskId}:${input.payload.messageId}`;

/**
 * Decides one Agent message in the consume transaction, in the order of K4 `consumeMessage`. The checks before the commit
 * write nothing. They stay stable for a replay, because the frozen input never changes and an accepted reply stays.
 */
export async function decideMessage(client: PoolClient, scope: string, state: CollaborationState,
  input: AgentMessageInput, ports: StorePorts, channel: boolean): Promise<Decision<MessageDecision>> {
  const refuse = (reasonCode: string): Decision<MessageDecision> => ({ value: { outcome: 'refused', reasonCode }, outbox: [] });
  const frozen = await frozenIntent(client, scope, input.taskId);
  if (!frozen) return decideEarlier(client, scope, state, input);
  if (input.deviceId !== frozen.input.deviceId || canonical(input.payload.agentRef) !== canonical(frozen.input.payload.agentRef)
    || canonical(input.context) !== canonical(frozen.input.agentMessageContext)) return refuse('binding_mismatch');
  // One accepted message per task, as the K4 receipt. The command record keys one message, so it cannot see another one.
  // Retention moves the reply with its Turn and keeps it, so an exact replay is accepted after its record expires (#651).
  const reply = await acceptedReply(client, storedKey(scope), state, input.taskId);
  if (reply && (reply.messageId !== input.payload.messageId || reply.contentHash !== input.payload.contentHash)) return refuse('message_conflict');
  if (reply) return { value: { outcome: 'accepted' }, outbox: [] };
  const head = revisionOf(state), { manage: _manage, ...base } = ports;
  let result: CommitResult;
  try {
    result = await commitStored(client, scope, state, { scope, commandId: messageCommandId(input),
      command: { kind: 'message', turnId: frozen.turnId, message: { taskId: input.taskId, payload: input.payload } } },
    base, channel);
  } catch (cause) {
    // Other content for the id of a refused message: the refusal that K4 gives for an accepted one.
    if (cause instanceof CommitConflict && cause.code === 'identity_conflict') return refuse('message_conflict');
    throw cause;
  }
  const value: MessageDecision = result.disposition.outcome === 'accepted' ? { outcome: 'accepted' }
    : { outcome: 'refused', reasonCode: result.disposition.reasonCode };
  return { value, outbox: result.revision === head + 1 ? result.outbox : [], now: base.now() };
}

/**
 * A message for the task of an earlier generation of an imported intent (#975 D1), as K4 `consumeMessage` answers it from
 * that generation's execution: the binding check, then its receipt (the K8 accepted reply of the task), else
 * `stale_generation`. A task that no generation has is `unknown_task`. It writes nothing.
 */
async function decideEarlier(client: PoolClient, scope: string, state: CollaborationState, input: AgentMessageInput): Promise<Decision<MessageDecision>> {
  const refuse = (reasonCode: string): Decision<MessageDecision> => ({ value: { outcome: 'refused', reasonCode }, outbox: [] });
  const earlier = await earlierIntent(client, scope, input.taskId);
  if (!earlier) return refuse('unknown_task');
  if (input.deviceId !== earlier.input.deviceId || canonical(input.payload.agentRef) !== canonical(earlier.input.payload.agentRef)
    || canonical(input.context) !== canonical(earlier.input.agentMessageContext)) return refuse('binding_mismatch');
  const reply = await acceptedReply(client, storedKey(scope), state, input.taskId);
  if (!reply) return refuse('stale_generation');
  return reply.messageId === input.payload.messageId && reply.contentHash === input.payload.contentHash
    ? { value: { outcome: 'accepted' }, outbox: [] } : refuse('message_conflict');
}

export interface MessageConsumerOptions {
  /**
   * The H scope of an SDK tenant. It must map each tenant to its own scope, and it must be the inverse of the submitter's
   * `port(scope)`, which submits the tasks of a scope as one tenant. The frozen input has no tenant field, so H cannot
   * repeat K4's tenant check: this mapping is the tenant check.
   */
  scopeOf(tenant: TenantId): string;
  /** The Host clock of the consume transaction. Default `Date.now`. The store builds the command ports. */
  now?: () => number;
}
/** The `agentMessage` option of `createByokCloud` for an H store. */
export function hostedMessageConsumer(store: HostedCollaborationStore, options: MessageConsumerOptions): AgentMessageConsumer {
  const now = options.now ?? Date.now;
  return { consume: input => store.consume(options.scopeOf(input.tenant), input, now) };
}

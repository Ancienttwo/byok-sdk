import { z } from 'zod';
import { AgentMessageServerContextSchema, TaskOfferForAgentWithEgressFreshPayloadSchema } from '@byok-sdk/protocol';

/** Persist this validated input before dispatch; the Host owns Turn/generation and outbox. */
export const RecurringExecutionInputSchema = z.object({
  taskId: z.string().min(1),
  deviceId: z.string().min(1),
  payload: TaskOfferForAgentWithEgressFreshPayloadSchema.required({ runtime: true, messageEgress: true, terminalProjection: true }),
  agentMessageContext: AgentMessageServerContextSchema,
}).strict();
export type RecurringExecutionInput = z.infer<typeof RecurringExecutionInputSchema>;

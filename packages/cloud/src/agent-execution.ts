import { z } from 'zod';
import { AgentMessageServerContextSchema, TaskOfferForAgentWithEgressFreshPayloadSchema } from '@byok-sdk/protocol';

/** Persist this validated input before dispatch; the Host owns Turn/generation and outbox. */
export const AgentExecutionInputSchema = z.object({
  taskId: z.string().min(1),
  deviceId: z.string().min(1),
  payload: TaskOfferForAgentWithEgressFreshPayloadSchema.required({ runtime: true, terminalProjection: true }),
  agentMessageContext: AgentMessageServerContextSchema.optional(),
}).strict();
export type AgentExecutionInput = z.infer<typeof AgentExecutionInputSchema>;

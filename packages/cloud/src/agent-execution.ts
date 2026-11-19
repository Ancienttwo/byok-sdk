import { z } from 'zod';
import {
  AgentMessageServerContextSchema,
  SessionSelectionSchema,
} from '@byok-sdk/protocol';
import { HostOfferPlainPayloadSchema, HostOfferSealedPayloadSchema } from '@byok-sdk/protocol';

/** An execution is a fresh `task.offer`, never a prepared one. */
const FRESH_EXECUTION = { session: SessionSelectionSchema.options[1], preparation: z.never().optional() };

/**
 * Persist this validated input before dispatch; the Host owns Turn/generation and outbox.
 *
 * `terminalProjection` is always required (#470). The execution target is the
 * offer's required `target`, validated by the protocol schema.
 */
export const AgentExecutionInputSchema = z.object({
  taskId: z.string().min(1),
  deviceId: z.string().min(1),
  payload: HostOfferPlainPayloadSchema.required({ terminalProjection: true }).safeExtend(FRESH_EXECUTION),
  agentMessageContext: AgentMessageServerContextSchema.optional(),
}).strict();
export type AgentExecutionInput = z.infer<typeof AgentExecutionInputSchema>;

/**
 * The sealed counterpart (#654): the payload is the sealed branch of a fresh
 * `task.offer` with the same rules. Submit it through `submitSealedAgentExecution`.
 */
export const SealedAgentExecutionInputSchema = z.object({
  taskId: z.string().min(1),
  deviceId: z.string().min(1),
  payload: HostOfferSealedPayloadSchema
    .required({ terminalProjection: true })
    .safeExtend(FRESH_EXECUTION),
  agentMessageContext: AgentMessageServerContextSchema.optional(),
}).strict();
export type SealedAgentExecutionInput = z.infer<typeof SealedAgentExecutionInputSchema>;

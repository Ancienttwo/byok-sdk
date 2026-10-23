import { z } from 'zod';
import {
  AgentMessageServerContextSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  TaskOfferForAgentWithEgressFreshPayloadSchema,
} from '@byok-sdk/protocol';

/** One execution target: a built-in `runtime` or a device-advertised `harnessId`, never both. */
function executionTargetRule(
  payload: { readonly runtime?: unknown; readonly harnessId?: unknown; readonly dispatchSelection?: unknown },
  ctx: z.RefinementCtx,
): void {
  const hasRuntime = payload.runtime !== undefined;
  const hasHarness = payload.harnessId !== undefined;
  if (!hasRuntime && !hasHarness) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'runtime or harnessId is required', path: ['runtime'] });
  }
  if (hasHarness && (hasRuntime || payload.dispatchSelection !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'harnessId conflicts with built-in runtime selection',
      path: ['harnessId'],
    });
  }
}

/**
 * Persist this validated input before dispatch; the Host owns Turn/generation and outbox.
 *
 * `terminalProjection` is always required (#470). Execution targets either a built-in
 * `runtime` or a device-advertised `harnessId` (not both; harnessId also excludes
 * `dispatchSelection`), so corpus hosted entries that carry only `harnessId` stay
 * expressible through `submitAgentExecution`.
 */
export const AgentExecutionInputSchema = z.object({
  taskId: z.string().min(1),
  deviceId: z.string().min(1),
  payload: TaskOfferForAgentWithEgressFreshPayloadSchema.required({ terminalProjection: true }).superRefine(executionTargetRule),
  agentMessageContext: AgentMessageServerContextSchema.optional(),
}).strict();
export type AgentExecutionInput = z.infer<typeof AgentExecutionInputSchema>;

/**
 * The sealed counterpart (#654): the payload is a
 * `task.offer_for_agent_with_egress_fresh_sealed` payload with the same
 * rules. Submit it through `submitSealedAgentExecution`.
 */
export const SealedAgentExecutionInputSchema = z.object({
  taskId: z.string().min(1),
  deviceId: z.string().min(1),
  payload: MESSAGE_PAYLOAD_SCHEMAS['task.offer_for_agent_with_egress_fresh_sealed']
    .required({ terminalProjection: true })
    .superRefine(executionTargetRule),
  agentMessageContext: AgentMessageServerContextSchema.optional(),
}).strict();
export type SealedAgentExecutionInput = z.infer<typeof SealedAgentExecutionInputSchema>;

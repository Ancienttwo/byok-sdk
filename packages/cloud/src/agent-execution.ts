import { z } from 'zod';
import {
  AgentMessageServerContextSchema,
  SessionSelectionSchema,
  TaskOfferPlainPayloadSchema,
  TaskOfferSealedPayloadSchema,
} from '@byok-sdk/protocol';

/** An execution is a fresh `task.offer`, never a prepared one. */
const FRESH_EXECUTION = { session: SessionSelectionSchema.options[1], preparation: z.never().optional() };

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
  payload: TaskOfferPlainPayloadSchema.required({ terminalProjection: true }).safeExtend(FRESH_EXECUTION).superRefine(executionTargetRule),
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
  payload: TaskOfferSealedPayloadSchema
    .required({ terminalProjection: true })
    .safeExtend(FRESH_EXECUTION)
    .superRefine(executionTargetRule),
  agentMessageContext: AgentMessageServerContextSchema.optional(),
}).strict();
export type SealedAgentExecutionInput = z.infer<typeof SealedAgentExecutionInputSchema>;

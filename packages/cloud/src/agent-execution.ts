import { z } from 'zod';
import { AgentMessageServerContextSchema, TaskOfferForAgentWithEgressFreshPayloadSchema } from '@byok-sdk/protocol';

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
  payload: TaskOfferForAgentWithEgressFreshPayloadSchema.required({ terminalProjection: true }).superRefine(
    (payload, ctx) => {
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
    },
  ),
  agentMessageContext: AgentMessageServerContextSchema.optional(),
}).strict();
export type AgentExecutionInput = z.infer<typeof AgentExecutionInputSchema>;

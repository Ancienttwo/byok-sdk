import { z } from 'zod';
import { AgentMemoryCommitSchema, TaskOfferPlainPayloadSchema, TaskOfferSealedPayloadSchema, type AgentMemoryCommit, type TaskOfferPlainPayload, type TaskOfferSealedPayload } from './messages';

/** Host policy; only the resolved wire value is persisted with a task offer. */
const commit = z.union([AgentMemoryCommitSchema, z.literal('on-success-if-advertised')]).optional();
const nativeSessions = TaskOfferPlainPayloadSchema.shape.nativeSessions.unwrap()
  .safeExtend({ ifAdvertised: z.literal(true).optional() }).optional();
const fields = { agentMemoryCommit: commit, nativeSessions };

function hostOfferSelectionRule(
  payload: Pick<TaskOfferPlainPayload, 'homeAccess' | 'agentMemory' | 'runtime' | 'dispatchSelection' | 'harnessId'>,
  ctx: z.RefinementCtx,
): void {
  if (payload.homeAccess === 'memory-reader'
    && (payload.agentMemory === 'read-write' || payload.agentMemory === 'read-write-if-admitted')) {
    ctx.addIssue({
      code: 'custom', path: ['agentMemory'],
      message: `agentMemory ${payload.agentMemory} requires a writer; a memory-reader Attempt reads memory only`,
    });
  }
  if (payload.runtime !== undefined && payload.dispatchSelection !== undefined
    && payload.runtime !== payload.dispatchSelection.runtimeId) {
    ctx.addIssue({
      code: 'custom', path: ['runtime'],
      message: `runtime ${payload.runtime} does not match dispatchSelection.runtimeId ${payload.dispatchSelection.runtimeId}`,
    });
  }
  if (payload.harnessId !== undefined && (payload.runtime !== undefined || payload.dispatchSelection !== undefined)) {
    ctx.addIssue({
      code: 'custom', path: ['harnessId'], message: 'harnessId conflicts with built-in runtime selection',
    });
  }
}

// safeExtend retains the wire's cross-field rules. Its static subtype check
// needs an explicit widening here: those rules inspect commit and nativeSessions presence only.
export const HostOfferPlainPayloadSchema = TaskOfferPlainPayloadSchema.safeExtend<typeof fields>(fields as never).superRefine(hostOfferSelectionRule);
export const HostOfferSealedPayloadSchema = TaskOfferSealedPayloadSchema.safeExtend<typeof fields>(fields as never).superRefine(hostOfferSelectionRule);
type HostOfferPayload<T> = Omit<T, 'agentMemoryCommit' | 'nativeSessions'> & {
  agentMemoryCommit?: AgentMemoryCommit | 'on-success-if-advertised';
  nativeSessions?: z.infer<typeof nativeSessions>;
};
export type HostOfferPlainPayload = HostOfferPayload<TaskOfferPlainPayload>;
export type HostOfferSealedPayload = HostOfferPayload<TaskOfferSealedPayload>;

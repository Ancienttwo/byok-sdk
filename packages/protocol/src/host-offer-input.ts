import { z } from 'zod';
import { AgentMemoryCommitSchema, TaskOfferPlainPayloadSchema, TaskOfferSealedPayloadSchema, type AgentMemoryCommit, type TaskOfferPlainPayload, type TaskOfferSealedPayload } from './messages';

/** Host policy; only the resolved wire value is persisted with a task offer. */
const commit = z.union([AgentMemoryCommitSchema, z.literal('on-success-if-advertised')]).optional();
const nativeSessions = TaskOfferPlainPayloadSchema.shape.nativeSessions.unwrap()
  .safeExtend({ ifAdvertised: z.literal(true).optional() }).optional();
const fields = { agentMemoryCommit: commit, nativeSessions };

// safeExtend retains the wire's cross-field rules. Its static subtype check
// needs an explicit widening here: those rules inspect commit and nativeSessions presence only.
export const HostOfferPlainPayloadSchema = TaskOfferPlainPayloadSchema.safeExtend<typeof fields>(fields as never);
export const HostOfferSealedPayloadSchema = TaskOfferSealedPayloadSchema.safeExtend<typeof fields>(fields as never);
type HostOfferPayload<T> = Omit<T, 'agentMemoryCommit' | 'nativeSessions'> & {
  agentMemoryCommit?: AgentMemoryCommit | 'on-success-if-advertised';
  nativeSessions?: z.infer<typeof nativeSessions>;
};
export type HostOfferPlainPayload = HostOfferPayload<TaskOfferPlainPayload>;
export type HostOfferSealedPayload = HostOfferPayload<TaskOfferSealedPayload>;

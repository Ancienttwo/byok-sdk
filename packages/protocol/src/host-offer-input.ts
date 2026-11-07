import { z } from 'zod';
import { AgentMemoryCommitSchema, TaskOfferPlainPayloadSchema, TaskOfferSealedPayloadSchema, type AgentMemoryCommit, type TaskOfferPlainPayload, type TaskOfferSealedPayload } from './messages';

/** Host policy; only the resolved wire value is persisted with a task offer. */
const commit = z.union([AgentMemoryCommitSchema, z.literal('on-success-if-advertised')]).optional();
const fields = { agentMemoryCommit: commit };

// safeExtend retains the wire's cross-field rules. Its static subtype check
// needs an explicit widening here: those rules inspect commit presence only.
export const HostOfferPlainPayloadSchema = TaskOfferPlainPayloadSchema.safeExtend<typeof fields>(fields as never);
export const HostOfferSealedPayloadSchema = TaskOfferSealedPayloadSchema.safeExtend<typeof fields>(fields as never);
type HostOfferPayload<T> = Omit<T, 'agentMemoryCommit'> & { agentMemoryCommit?: AgentMemoryCommit | 'on-success-if-advertised' };
export type HostOfferPlainPayload = HostOfferPayload<TaskOfferPlainPayload>;
export type HostOfferSealedPayload = HostOfferPayload<TaskOfferSealedPayload>;

import { z } from 'zod';
import { AgentEgressContentHashSchema } from './agent-egress';

/** Capability required before a task-free Agent-home projection is admitted. */
export const AGENT_HOME_PROJECTION_CAPABILITY = 'agent-home-projection' as const;

/** Maximum UTF-8 encoded JSON bytes carried by one projection payload. */
export const AGENT_HOME_PROJECTION_MAX_BYTES = 64 * 1024;

/** PostgreSQL BIGINT maximum, kept as decimal text to avoid JavaScript precision loss. */
export const AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM = '9223372036854775807' as const;

/**
 * Canonical positive decimal Profile revision for this projection contract.
 *
 * This deliberately stays local to the projection contract: the generic
 * AgentRef used by existing task and egress messages remains opaque. Values
 * cross the JavaScript/PostgreSQL boundary as text and are compared
 * lexically after canonical syntax validation.
 */
export const AgentHomeProjectionProfileRevisionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u, 'profileRevision must be a canonical positive decimal string')
  .refine(
    (value) =>
      value.length < AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM.length ||
      value <= AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM,
    `profileRevision must not exceed PostgreSQL BIGINT maximum ${AGENT_HOME_PROJECTION_PROFILE_REVISION_MAXIMUM}`,
  );
export type AgentHomeProjectionProfileRevision = z.infer<typeof AgentHomeProjectionProfileRevisionSchema>;

/** The projection hash uses the package-wide lowercase SHA-256 transport form. */
export const AgentHomeProjectionHashSchema = AgentEgressContentHashSchema;
export type AgentHomeProjectionHash = z.infer<typeof AgentHomeProjectionHashSchema>;

/** Terminal local-apply outcome carried by the exact completion request. */
export const AgentHomeProjectionOutcomeSchema = z.enum(['applied', 'idempotent', 'stale', 'conflict']);
export type AgentHomeProjectionOutcome = z.infer<typeof AgentHomeProjectionOutcomeSchema>;

/**
 * Bounded opaque JSON. The SDK enforces only byte size and does not interpret
 * Salesko or any other product's fields. Credential custody remains outside
 * this protocol surface; this schema intentionally defines no credential
 * fields and is not a DLP scanner.
 */
export type AgentHomeProjectionValue =
  | string
  | number
  | boolean
  | null
  | AgentHomeProjectionValue[]
  | { [key: string]: AgentHomeProjectionValue };

export const AgentHomeProjectionValueSchema: z.ZodType<AgentHomeProjectionValue> = z
  .json()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= AGENT_HOME_PROJECTION_MAX_BYTES,
    `projection must not exceed ${AGENT_HOME_PROJECTION_MAX_BYTES} UTF-8 JSON bytes`,
  );

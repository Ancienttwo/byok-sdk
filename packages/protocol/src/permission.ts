import { z } from 'zod';

export const PERMISSION_MODES = ['auto', 'confirm', 'readonly', 'plan'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Policy the server proposes for a task. The daemon/runtime adapter maps this
 * onto the concrete runtime's flags; anything that can't be expressed exactly
 * must fail closed (deny) rather than silently widen the grant.
 *
 * `.strict()`: this is control/security data, so per the freeze rule's
 * observability-vs-control asymmetry (docs/protocol.md "Freeze rule") an
 * unrecognized field must be REJECTED, not silently stripped-and-ignored the
 * way an ordinary payload's unknown field is (plain `z.object()`'s default
 * behavior). Without `.strict()`, a policy carrying a future constraint this
 * schema doesn't know about yet would parse successfully with that
 * constraint silently discarded — exactly the silent-widening failure mode
 * this type's own doc comment above warns against, since a stripped
 * constraint is indistinguishable from a constraint that was never sent.
 *
 * Consequence: adding a new field to this schema post-freeze is therefore a
 * BREAKING change requiring a `PROTOCOL_VERSION` bump — unlike the general
 * "a new optional field on an existing payload is non-breaking" rule the
 * freeze rule grants every other schema. That's intentional: a new
 * security/control constraint must force a conscious version bump so an
 * unupgraded peer can never silently ignore it, rather than being added the
 * same low-friction way a harmless observability field would be.
 */
export const PermissionPolicySchema = z
  .object({
    mode: z.enum(PERMISSION_MODES),
    allowTools: z.array(z.string()).optional(),
    denyTools: z.array(z.string()).optional(),
    workspaceRoot: z.string().optional(),
    network: z.boolean().optional(),
  })
  .strict();

export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

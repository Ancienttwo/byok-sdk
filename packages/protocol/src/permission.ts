import { z } from 'zod';

export const PERMISSION_MODES = ['auto', 'confirm', 'readonly', 'plan'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Policy the server proposes for a task. The daemon/runtime adapter maps this
 * onto the concrete runtime's flags; anything that can't be expressed exactly
 * must fail closed (deny) rather than silently widen the grant.
 */
export const PermissionPolicySchema = z.object({
  mode: z.enum(PERMISSION_MODES),
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
  workspaceRoot: z.string().optional(),
  network: z.boolean().optional(),
});

export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

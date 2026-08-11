/**
 * Capability declaration (ADR-010).
 *
 * A client learns what a deployment supports by reading a declaration, never by
 * probing endpoints and interpreting 404/405/501. Status-code sniffing conflates
 * "this build does not have that feature" with "that request was wrong" and
 * with "a proxy ate it", and every consumer ends up with its own guess.
 *
 * The schema is intentionally the minimum that supports that rule: an opaque
 * string set plus a monotonic declaration version. Capability names are host and
 * deployment vocabulary — core validates their shape, never their meaning, so a
 * new capability never requires a core release.
 */
import { z } from 'zod';
import { ByokCoreError } from './errors';

export const CAPABILITY_DECLARATION_SCHEMA_ID = 'byok-capabilities-v1';

/** Capability names: lowercase dotted segments, e.g. `board.sse`, `storage.reservations`. */
export const CAPABILITY_NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export const CapabilityDeclarationSchema = z
  .object({
    schema: z.literal(CAPABILITY_DECLARATION_SCHEMA_ID),
    /** Monotonic per deployment. Lets a client cache and detect a rollout. */
    version: z.number().int().nonnegative(),
    capabilities: z.array(z.string().regex(CAPABILITY_NAME_PATTERN)),
  })
  .superRefine((declaration, ctx) => {
    const seen = new Set<string>();
    for (const [index, name] of declaration.capabilities.entries()) {
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['capabilities', index],
          message: `Duplicate capability ${JSON.stringify(name)}.`,
        });
      }
      seen.add(name);
    }
  });

export type CapabilityDeclaration = z.infer<typeof CapabilityDeclarationSchema>;

/**
 * Parses a declaration fail-closed.
 *
 * @throws {ByokCoreError} code `capability_declaration_invalid`.
 */
export function parseCapabilityDeclaration(input: unknown): CapabilityDeclaration {
  const result = CapabilityDeclarationSchema.safeParse(input);
  if (!result.success) {
    throw new ByokCoreError(
      'capability_declaration_invalid',
      `Invalid capability declaration: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export function hasCapability(
  declaration: CapabilityDeclaration,
  capability: string,
): boolean {
  return declaration.capabilities.includes(capability);
}

/**
 * The enforcement point ADR-010 exists for: a caller asserts the capability up
 * front and gets a named failure, instead of issuing the request and guessing
 * what the status code meant.
 *
 * @throws {ByokCoreError} code `capability_unavailable`.
 */
export function assertCapability(
  declaration: CapabilityDeclaration,
  capability: string,
): void {
  if (!hasCapability(declaration, capability)) {
    throw new ByokCoreError(
      'capability_unavailable',
      `Capability ${JSON.stringify(capability)} is not declared by this deployment.`,
    );
  }
}

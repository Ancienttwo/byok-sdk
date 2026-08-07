/**
 * Tenant identity — layer 1 of the six-layer isolation model
 * (`docs/architecture/sdk-architecture.md` §12.6.2).
 *
 * `TenantId` is a branded string and this module is the **only** place that may
 * produce one: every other module receives a `TenantId` it cannot forge without
 * calling {@link tenantId}. The brand carries no runtime value — it exists so a
 * bare `string` (a path segment, a claim from an unverified proof, a
 * device-supplied query parameter) can never silently slide into a store port's
 * first parameter.
 *
 * `src/__tests__/constraints.test.ts` greps the package for `as TenantId`: this
 * file and test fixtures are the only allowed sites. A module that needs a
 * `TenantId` takes one as a parameter or mints it here.
 */
import { ByokCoreError } from './errors';

/**
 * A validated tenant identifier.
 *
 * Nominal by construction: structurally a `string`, but the phantom brand makes
 * it unassignable from an arbitrary string. Assignment the other way
 * (`TenantId` → `string`) stays legal on purpose, so composition code can pass
 * it as a SQL parameter or key prefix without a cast.
 */
export type TenantId = string & { readonly __byokTenantId: unique symbol };

/**
 * Upper bound on tenant id length. Not a security boundary — a bound so a
 * pathological id cannot become an unbounded key prefix inside a store.
 */
export const TENANT_ID_MAX_LENGTH = 200;

/**
 * Separator for flat composite keys. `NUL` cannot appear in a tenant id that a
 * control plane can express in a URL, a header, or a SQL identifier, and
 * {@link tenantId} rejects it outright — so a composite key is never ambiguous
 * between `(a, bc)` and `(ab, c)`.
 */
export const TENANT_KEY_SEPARATOR = '\u0000';

/**
 * The single mint point for {@link TenantId}.
 *
 * Fail-closed: empty, whitespace-padded, over-long, non-string, or
 * `NUL`-bearing values are rejected rather than normalized. Normalizing here
 * would create a second source of truth for "which tenant is this", because the
 * control plane that issued the id would then disagree with the SDK about its
 * canonical form.
 *
 * @throws {ByokCoreError} code `tenant_id_invalid`.
 */
export function tenantId(value: string): TenantId {
  const candidate: unknown = value;
  if (typeof candidate !== 'string') {
    throw new ByokCoreError(
      'tenant_id_invalid',
      `Tenant id must be a string, received ${typeof candidate}.`,
    );
  }
  if (candidate.length === 0) {
    throw new ByokCoreError('tenant_id_invalid', 'Tenant id must not be empty.');
  }
  if (candidate.trim() !== candidate) {
    throw new ByokCoreError(
      'tenant_id_invalid',
      'Tenant id must not have leading or trailing whitespace.',
    );
  }
  if (candidate.length > TENANT_ID_MAX_LENGTH) {
    throw new ByokCoreError(
      'tenant_id_invalid',
      `Tenant id must be at most ${TENANT_ID_MAX_LENGTH} characters.`,
    );
  }
  if (candidate.includes(TENANT_KEY_SEPARATOR)) {
    throw new ByokCoreError('tenant_id_invalid', 'Tenant id must not contain a NUL character.');
  }
  return candidate as TenantId;
}

/**
 * Non-throwing form of {@link tenantId}, for surfaces that must answer "is this
 * a tenant id?" without building an error (route matching, log redaction).
 * Accepts exactly what {@link tenantId} accepts, never more.
 */
export function isTenantId(value: unknown): value is TenantId {
  if (typeof value !== 'string') return false;
  return (
    value.length > 0 &&
    value.trim() === value &&
    value.length <= TENANT_ID_MAX_LENGTH &&
    !value.includes(TENANT_KEY_SEPARATOR)
  );
}

/**
 * Composite key helper for compositions that need a flat key space (in-memory
 * maps, KV namespaces). SQL compositions use a tenant-prefixed composite
 * primary key instead — §12.6.2 layer 3 forbids a bare device/task index
 * regardless of which representation a composition picks.
 */
export function tenantKey(tenant: TenantId, ...parts: readonly string[]): string {
  return [tenant as string, ...parts].join(TENANT_KEY_SEPARATOR);
}

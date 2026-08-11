/**
 * Authenticated principals — layer 2 of the isolation model (§12.6.2).
 *
 * A handler never receives a raw tenant string; it receives a principal that
 * already carries a minted {@link TenantId}. The two principal shapes are
 * deliberately not one type with an optional `deviceId`: a control-plane caller
 * that can write entitlements and a device that can write truth records have
 * different authority, and a discriminated union makes a handler state which
 * one it accepts.
 *
 * `keyId`/`keyEpoch` are **not** here. They are device-proof semantics
 * (`plans/sprints/…sprint.md` §S6.2): the signing key's identity and rotation
 * generation, resolved by looking up the device row during proof verification.
 * Putting them on the principal would create permanently-empty fields on every
 * principal minted by a non-proof path.
 */
import type { TenantId } from './tenant';

/** Principal kinds. A composition may not invent a third without a contract change. */
export const PRINCIPAL_KINDS = ['device', 'control-plane'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/**
 * A paired device acting inside one tenant/product.
 *
 * Built only from a device row loaded with the tenant as part of the lookup key
 * (§12.6.2 layer 5) — never from claims a device asserted about itself.
 */
export interface DevicePrincipal {
  readonly kind: 'device';
  readonly tenantId: TenantId;
  readonly productId: string;
  readonly deviceId: string;
}

/**
 * The host's control plane acting on a tenant: entitlement writes, retention
 * policy, administrative reads. Carries the operator identity for audit, which
 * is opaque to the SDK.
 */
export interface ControlPlanePrincipal {
  readonly kind: 'control-plane';
  readonly tenantId: TenantId;
  readonly operatorId: string;
}

/** Anything that can address a tenant-scoped store. */
export type Principal = DevicePrincipal | ControlPlanePrincipal;

export function isDevicePrincipal(principal: Principal): principal is DevicePrincipal {
  return principal.kind === 'device';
}

export function isControlPlanePrincipal(
  principal: Principal,
): principal is ControlPlanePrincipal {
  return principal.kind === 'control-plane';
}

/**
 * The tenant every store call must be scoped to.
 *
 * Exists so a handler cannot accidentally read `principal.tenantId` off one
 * principal and pass a different tenant to a store: the facade that binds
 * stores to a tenant takes this, not a loose string.
 */
export function principalTenant(principal: Principal): TenantId {
  return principal.tenantId;
}

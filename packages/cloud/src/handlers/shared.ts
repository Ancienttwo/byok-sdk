/**
 * The two things every device-facing handler starts from: a tolerant JSON body
 * read, and the bearer -> principal -> tenant-closed-facade step.
 *
 * Once {@link authenticateDevice} has answered, a handler holds a
 * `TenantStores` and a `DevicePrincipal` and never sees a `TenantId` again.
 */
import type { Context } from 'hono';
import type { DevicePrincipal } from '@byok-sdk/core';
import { authenticateBearer, type BearerAuthDeps } from '../auth/bearer';
import { tenantStoresFor, type CloudRootStores, type TenantStores } from '../tenant-stores';

/** Every error response on this surface is `{ error }` — the same shape the reference server uses. */
export interface ErrorBody {
  readonly error: string;
}

export async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export interface DeviceRouteDeps {
  readonly bearer: BearerAuthDeps;
  readonly root: CloudRootStores;
}

export interface AuthenticatedDeviceContext {
  readonly device: DevicePrincipal;
  readonly stores: TenantStores;
}

/**
 * `undefined` means "answer 401" — and it means that for a missing header, a
 * forged token, an expired token, a revoked device, a product mismatch, and a
 * token whose tenant does not own the device, indistinguishably.
 */
export async function authenticateDevice(
  c: Context,
  deps: DeviceRouteDeps,
): Promise<AuthenticatedDeviceContext | undefined> {
  const device = await authenticateBearer(c.req.header('authorization'), deps.bearer);
  if (device === undefined) return undefined;
  return { device, stores: tenantStoresFor(device, deps.root) };
}

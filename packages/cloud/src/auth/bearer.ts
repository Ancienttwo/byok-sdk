/**
 * The single bearer check every device-facing route shares.
 *
 * S1 shape, reproduced exactly: the token's `(tenantId, deviceId, productId)`
 * are LOOKUP KEYS, and the ROW that comes back is the authority. A token for a
 * device that no longer exists, one whose tenant does not own that device, one
 * whose product disagrees with the row, one for a revoked device, an expired
 * token, and a malformed tenant id in the claims all fail identically here and
 * are indistinguishable to the caller. There is deliberately no "which of
 * those was it" signal to hand back, so no route can turn a 401 into a
 * cross-tenant existence oracle.
 *
 * The returned {@link DevicePrincipal} is core's, carrying a minted
 * `TenantId` — which is what makes it the only legal input to
 * `tenantStoresFor` (`../tenant-stores.ts`).
 */
import { isTenantId, tenantId, type DevicePrincipal } from '@byok-sdk/core';
import type { DeviceDirectory } from '../stores/ports';
import type { TokenSigner } from './tokens';

export interface BearerAuthDeps {
  readonly tokenSigner: TokenSigner;
  readonly devices: DeviceDirectory;
  /**
   * The ONE product this deployment serves, when it serves exactly one.
   *
   * Two deployment shapes, two explicit authorities — not a default and a
   * fallback. A multi-product hosted control plane leaves this absent, and the
   * row is the whole product authority (`device.productId === claims.productId`
   * below). A single-product instance supplies it — that is the embedded shape,
   * where `createByokServer({ productId })` always has one — and the token must
   * then name THAT product as well, so a device paired through a code minted
   * for another product cannot reach this instance's bearer-authed routes at
   * all.
   *
   * Absent it, a cross-product device whose token and row agree with each other
   * authenticates on every `device` route the deployment mounts, which is
   * precisely the drift this closes for the embedded shape.
   */
  readonly instanceProductId?: string;
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export async function authenticateBearer(
  header: string | undefined,
  deps: BearerAuthDeps,
): Promise<DevicePrincipal | undefined> {
  const token = extractBearerToken(header);
  if (token === undefined) return undefined;

  const claims = await deps.tokenSigner.verify(token);
  if (claims === undefined) return undefined;
  // The claim is a bare string until it is minted; a tenant id that core would
  // refuse is simply not a tenant this deployment ever issued a token for.
  if (!isTenantId(claims.tenantId)) return undefined;

  const device = await deps.devices.get(tenantId(claims.tenantId), claims.deviceId);
  if (device === undefined || device.revoked) return undefined;
  if (device.productId !== claims.productId) return undefined;
  // Instance equality, when the deployment declares one product. Checked after
  // row==claims, so by here the two agree and comparing either is the same
  // comparison; it is written against the claims to read as what it is — this
  // token was minted for another product. Same `undefined` as every other
  // failure above: an instance mismatch must not be distinguishable from an
  // unknown, wrong-tenant, or revoked device, or the 401 becomes an oracle for
  // what this instance serves.
  if (deps.instanceProductId !== undefined && claims.productId !== deps.instanceProductId) {
    return undefined;
  }

  return {
    kind: 'device',
    tenantId: device.tenantId,
    productId: device.productId,
    deviceId: device.deviceId,
  };
}

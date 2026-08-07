/**
 * `GET /byok/capabilities` — the declaration route (ADR-010).
 *
 * Public by design: a client has to be able to read what a deployment supports
 * before it holds a credential, and the declaration is a deployment-level
 * fact, not a tenant-level one. Nothing tenant-scoped may ever be added to
 * this response for exactly that reason.
 */
import type { Context } from 'hono';
import type { CapabilityDeclaration } from '@byok/core';

export interface CapabilitiesRouteDeps {
  readonly declaration: CapabilityDeclaration;
}

export function capabilitiesHandler(deps: CapabilitiesRouteDeps) {
  return async (c: Context): Promise<Response> => c.json(deps.declaration, 200);
}

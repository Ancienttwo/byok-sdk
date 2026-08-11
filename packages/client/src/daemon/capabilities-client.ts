/**
 * Hosted capability discovery (ADR-010), client side.
 *
 * The daemon learns what a deployment supports by READING the declaration
 * `GET /byok/capabilities` serves, never by issuing a request and interpreting
 * 404/405/501 — status-code sniffing conflates "this deployment does not have
 * that feature" with "that request was wrong" and with "a proxy ate it". Core
 * owns the declaration shape (`CapabilityDeclarationSchema`) and the
 * `hasCapability` enforcement point; this module owns only the fetch and the
 * fail-closed parse.
 *
 * Fail-closed means exactly that: an unreachable route, a non-200, a body that
 * is not JSON, or a body core's schema rejects all produce
 * {@link CapabilityDiscoveryError} and NOTHING else. There is deliberately no
 * "assume the usual capabilities" fallback and no 404-means-unsupported branch
 * — a caller that cannot read a declaration must behave as though it read
 * nothing, which for every capability-gated feature means not starting it.
 *
 * The route is public by design (a client has to be able to read it before it
 * holds a credential), so no bearer token is attached here.
 */
import { CapabilityDeclarationSchema, hasCapability, type CapabilityDeclaration } from '@byok-sdk/core';
import { toHttpBase } from './url';

/**
 * The hosted capability the presence producer gates on. A plain string, not an
 * import from `@byok-sdk/cloud`: the daemon must not gain a dependency on the
 * hosted implementation, and ADR-010 names capabilities as deployment
 * vocabulary that core validates the shape of but never the meaning of.
 */
export const PRESENCE_HINTS_CAPABILITY = 'presence.hints';

/** Thrown for every way discovery can fail. One type: a caller only ever needs "no declaration was read". */
export class CapabilityDiscoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CapabilityDiscoveryError';
  }
}

export interface FetchCapabilityDeclarationOptions {
  /** Aborts the in-flight request — the daemon passes its shutdown signal so teardown never waits on a hung deployment. */
  signal?: AbortSignal;
}

/**
 * Reads and validates the deployment's declaration.
 *
 * @throws {CapabilityDiscoveryError} for a transport failure, a non-200, a
 * non-JSON body, or a body that is not a valid ADR-010 declaration.
 */
export async function fetchCapabilityDeclaration(
  serverUrl: string,
  options: FetchCapabilityDeclarationOptions = {},
): Promise<CapabilityDeclaration> {
  const url = new URL('/byok/capabilities', toHttpBase(serverUrl));

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (err) {
    throw new CapabilityDiscoveryError(
      `failed to read the capability declaration from ${url.toString()}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!response.ok) {
    throw new CapabilityDiscoveryError(
      `failed to read the capability declaration from ${url.toString()}: HTTP ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CapabilityDiscoveryError(
      `the capability declaration at ${url.toString()} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const parsed = CapabilityDeclarationSchema.safeParse(body);
  if (!parsed.success) {
    throw new CapabilityDiscoveryError(
      `the capability declaration at ${url.toString()} is not a valid ADR-010 declaration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** Declaration gate — core's `hasCapability`, re-exposed so callers read the intent at the call site. */
export function declares(declaration: CapabilityDeclaration, capability: string): boolean {
  return hasCapability(declaration, capability);
}

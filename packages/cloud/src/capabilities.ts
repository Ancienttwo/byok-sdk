/**
 * The hosted capability declaration (ADR-010).
 *
 * A client learns what a deployment supports by READING a declaration, never
 * by probing an endpoint and interpreting 404/405/501. `@byok/core` owns the
 * declaration shape and the `hasCapability`/`assertCapability` enforcement
 * point; what lives here is the hosted vocabulary and the mapping from a
 * capability name to the routes that provide it.
 *
 * `GET /byok/capabilities` is a hosted-only route: it is not part of the
 * frozen device wire contract, `@byok/protocol` is untouched by it, and the
 * daemon does not consume it yet (that lands in a later slice). What it
 * already does here is drive route selection — a deployment that does not
 * declare `blobs.presigned` does not mount the grant routes at all, and one
 * that does not declare `blobs.contentproxy` does not mount the two `/content`
 * routes, so the declaration and the surface cannot disagree.
 */
import { CapabilityDeclarationSchema, hasCapability, type CapabilityDeclaration } from '@byok/core';

/** The hosted capability vocabulary this package knows how to serve. */
export const CLOUD_CAPABILITIES = {
  /** `GET /byok/events` long-poll receive (§8). */
  eventsLongPoll: 'events.longpoll',
  /** `POST /byok/messages` batched send (§8.2). */
  messagesBatch: 'messages.batch',
  /** The three bearer-authed blob routes: reserve/grant, explicit finalize, committed-only download (§7). */
  blobsPresigned: 'blobs.presigned',
  /**
   * The two presigned `/byok/blobs/:id/content` routes — cloud carrying the
   * bytes itself.
   *
   * Split out of `blobs.presigned` because it was one capability describing two
   * separable facts. A composition whose bytes live in object storage mints
   * grants (`blobs.presigned`) but has no byte-proxy path at all, and saying so
   * by declaration is ADR-010's whole posture: a client reads what a deployment
   * serves, it never probes a `/content` route and interprets the status code.
   *
   * Spelled all-lowercase because core's declaration schema pins capability
   * names to `/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/` — the same reason the sibling
   * above reads `events.longpoll` and not `events.longPoll`.
   */
  blobsContentProxy: 'blobs.contentproxy',
} as const;

export type CloudCapability = (typeof CLOUD_CAPABILITIES)[keyof typeof CLOUD_CAPABILITIES];

/** The wire DTO for `GET /byok/capabilities` — core's shape, bound to a cloud-owned route. */
export const CapabilitiesResponseSchema = CapabilityDeclarationSchema;
export type CapabilitiesResponse = CapabilityDeclaration;

/** Everything this package can serve. A deployment narrows it; it never widens past what the routes implement. */
export function fullCapabilityDeclaration(version = 1): CapabilityDeclaration {
  return {
    schema: 'byok-capabilities-v1',
    version,
    capabilities: Object.values(CLOUD_CAPABILITIES),
  };
}

export function declares(declaration: CapabilityDeclaration, capability: CloudCapability): boolean {
  return hasCapability(declaration, capability);
}

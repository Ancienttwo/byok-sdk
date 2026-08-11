/**
 * The hosted capability declaration (ADR-010).
 *
 * A client learns what a deployment supports by READING a declaration, never
 * by probing an endpoint and interpreting 404/405/501. `@byok-sdk/core` owns the
 * declaration shape and the `hasCapability`/`assertCapability` enforcement
 * point; what lives here is the hosted vocabulary and the mapping from a
 * capability name to the routes that provide it.
 *
 * `GET /byok/capabilities` is a hosted-only route: it is not part of the
 * frozen device wire contract, `@byok-sdk/protocol` is untouched by it, and the
 * daemon does not consume it yet (that lands in a later slice). What it
 * already does here is drive route selection — a deployment that does not
 * declare `blobs.presigned` does not mount the grant routes at all, and one
 * that does not declare `blobs.contentproxy` does not mount the two `/content`
 * routes, so the declaration and the surface cannot disagree.
 */
import { CapabilityDeclarationSchema, hasCapability, type CapabilityDeclaration } from '@byok-sdk/core';

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
  /** Board list/claim/unclaim/status routes. Polling is first-class under this declaration. */
  boardCoordination: 'board.coordination',
  /** Additional SSE transport for the same board read model. */
  boardSse: 'board.sse',
  /** Device-scoped five-level presence publication. */
  presenceHints: 'presence.hints',
  /** Bounded task activity batch publication. */
  activityTail: 'activity.tail',
  /** Request-bound device proof record manifest/read/write surface (S6). */
  truthRecords: 'truth.records',
} as const;

export type CloudCapability = (typeof CLOUD_CAPABILITIES)[keyof typeof CLOUD_CAPABILITIES];

/** The wire DTO for `GET /byok/capabilities` — core's shape, bound to a cloud-owned route. */
export const CapabilitiesResponseSchema = CapabilityDeclarationSchema;
export type CapabilitiesResponse = CapabilityDeclaration;

export interface FullCapabilityDeclarationOptions {
  /**
   * Composition-bound capabilities require an explicit application authority.
   * `truth.records` is omitted by default because the standard in-memory
   * composition cannot truthfully promise a cross-store atomic commit.
   */
  readonly includeTruthRecords?: boolean;
}

/** Every capability the standard composition can serve, plus explicitly wired composition-bound ones. */
export function fullCapabilityDeclaration(
  version = 1,
  options: FullCapabilityDeclarationOptions = {},
): CapabilityDeclaration {
  return {
    schema: 'byok-capabilities-v1',
    version,
    capabilities: Object.values(CLOUD_CAPABILITIES).filter(
      (capability) =>
        capability !== CLOUD_CAPABILITIES.truthRecords || options.includeTruthRecords === true,
    ),
  };
}

export function declares(declaration: CapabilityDeclaration, capability: CloudCapability): boolean {
  return hasCapability(declaration, capability);
}

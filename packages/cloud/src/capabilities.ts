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
 * declare `blobs.presigned` does not mount the blob routes at all, so the
 * declaration and the surface cannot disagree.
 */
import { CapabilityDeclarationSchema, hasCapability, type CapabilityDeclaration } from '@byok/core';

/** The hosted capability vocabulary this package knows how to serve. */
export const CLOUD_CAPABILITIES = {
  /** `GET /byok/events` long-poll receive (§8). */
  eventsLongPoll: 'events.longpoll',
  /** `POST /byok/messages` batched send (§8.2). */
  messagesBatch: 'messages.batch',
  /** The four `/byok/blobs` routes (§7). */
  blobsPresigned: 'blobs.presigned',
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

/**
 * `@byok/cloud` — the hosted device surface.
 *
 * Cloud sits BESIDE `@byok/server`, not above it (§12.1): `cloud → core +
 * protocol`, and never `cloud → server`. The self-hosted embedded coordinator
 * stays the self-hosted option; this package serves the same frozen v1 device
 * wire contract statelessly, over `@byok/core` ports plus the cloud-local auth
 * and task ports in `stores/ports.ts`.
 *
 * `src/__tests__/constraints.test.ts` asserts the properties this export list
 * implies: no `@byok/server` import, no `node:` import, no module-level
 * mutable state, no session/Running map, and no route mounted outside the I1
 * registry.
 */

// Tenant identity. RE-exported from `@byok/core`, never redefined: core owns
// the single mint point, and every control-plane function on this package's
// own API takes a `TenantId` first, so a host composing cloud has to be able
// to mint one without reasoning about which package's brand it got.
export { isTenantId, tenantId } from '@byok/core';
export type { TenantId } from '@byok/core';

// The composition entry points
export { createByokCloud } from './cloud';
export type { ByokCloud, ByokCloudOptions, EnqueueOfferInput, EnqueuedOffer } from './cloud';
export {
  DEFAULT_EVENTS_PAGE_LIMIT,
  DEFAULT_LONG_POLL_HOLD_MS,
  DEFAULT_LONG_POLL_INTERVAL_MS,
  DEFAULT_MAX_BLOB_SIZE_BYTES,
} from './cloud';
export { createInMemoryByokCloud } from './composition/in-memory';
export type { InMemoryByokCloud, InMemoryByokCloudOptions } from './composition/in-memory';

// Errors
export { ByokCloudError, CLOUD_ERROR_CODES, isCloudError } from './errors';
export type { CloudErrorCode } from './errors';

// Capability declaration (ADR-010)
export {
  CLOUD_CAPABILITIES,
  CapabilitiesResponseSchema,
  declares,
  fullCapabilityDeclaration,
} from './capabilities';
export type { CapabilitiesResponse, CloudCapability } from './capabilities';

// Route inventory (I1)
export { CloudRouteRegistry, ROUTE_CLASSES, ROUTE_METHODS, routeKey } from './router/registry';
export type { CloudRouteHandler, RouteClass, RouteDescriptor, RouteMethod } from './router/registry';

// Auth plane
export { ACCESS_TOKEN_TTL_SECONDS, createHmacTokenSigner } from './auth/tokens';
export type { AccessTokenClaims, TokenSigner } from './auth/tokens';
export { NONCE_SIGNING_DOMAIN, verifyNonceSignature } from './auth/verify';
export { authenticateBearer, extractBearerToken } from './auth/bearer';
export type { BearerAuthDeps } from './auth/bearer';
export { PAIRING_CODE_TTL_MS, createAuthPlane } from './auth/plane';
export type { AuthPlane, AuthPlaneDeps, MintedAccessToken, PairInput } from './auth/plane';

// The crypto seam
export { createWebCrypto } from './crypto/web-crypto';
export type { CloudCrypto } from './crypto/port';

// Inbound gate
export { handleInboundEnvelope, terminalReceiptKey } from './inbound';
export type { InboundOutcome } from './inbound';

// Tenant facade (layer 2 of §12.6.2)
export { tenantStoresFor } from './tenant-stores';
export type {
  CloudRootStores,
  TenantBoundBlobs,
  TenantBoundDedup,
  TenantBoundDevices,
  TenantBoundMailbox,
  TenantBoundRateLimiter,
  TenantBoundReceipts,
  TenantBoundSequence,
  TenantBoundTaskAttempts,
  TenantStores,
} from './tenant-stores';

// Cloud-local ports
export { CLOUD_STORE_NAMES, TASK_ATTEMPT_STATUSES } from './stores/ports';
export type {
  BlobContent,
  BlobDeclaration,
  BlobWriteResult,
  CloudBlobStore,
  CloudStoreName,
  CloudStores,
  DeviceDirectory,
  DeviceRecord,
  DeviceRegistration,
  DeviceSequenceStore,
  InboundDedupStore,
  InboundRateLimiter,
  NonceStore,
  PairingCodeClaims,
  PairingCodeInfo,
  PairingCodeIssueInput,
  PairingCodeStore,
  RequestReceipt,
  RequestReceiptStore,
  TaskAttempt,
  TaskAttemptStatus,
  TaskAttemptStore,
} from './stores/ports';

// In-memory reference implementations
export {
  AllowAllRateLimiter,
  BLOB_URL_TTL_MS,
  DEDUP_RING_CAPACITY,
  InMemoryCloudBlobStore,
  InMemoryDeviceDirectory,
  InMemoryDeviceSequenceStore,
  InMemoryInboundDedupStore,
  InMemoryNonceStore,
  InMemoryPairingCodeStore,
  InMemoryRequestReceiptStore,
  InMemoryTaskAttemptStore,
  NONCE_TTL_MS,
  createInMemoryCloudStores,
} from './stores/in-memory/index';

/**
 * `@byok-sdk/core` — platform contracts.
 *
 * What this package exports is deliberately narrow: contracts, schemas, errors,
 * one in-memory reference implementation, and the sealed provider-secret byte
 * authority (one-shot HPKE over WebCrypto only — the browser and the device
 * must run the same code). No HTTP, no node crypto, no SQL, no
 * `@byok-sdk/protocol` (that edge would make a future `keys → core` dependency drag
 * the wire protocol along with it, §12.1), and no `node:` import (a Workers
 * composition has to be able to load this).
 *
 * `src/__tests__/constraints.test.ts` asserts every one of those properties
 * against the source, including this export list.
 */

// Identity (§12.6.2)
export {
  tenantId,
  isTenantId,
  tenantKey,
  TENANT_ID_MAX_LENGTH,
} from './tenant.js';
export type { TenantId } from './tenant.js';

export {
  principalTenant,
} from './principals.js';
export type {
  ControlPlanePrincipal,
  DevicePrincipal,
  Principal,
} from './principals.js';

// Errors (single taxonomy)
export {
  ByokCoreError,
  CoreConflictError,
  isCoreError,
  isCoreConflictError,
} from './errors.js';
export type { CoreErrorCode } from './errors.js';

// Canonical instants (the format every caller-supplied timestamp must be in)
export {
  assertCanonicalTimestamp,
  isCanonicalTimestamp,
} from './time.js';

// Mailbox (§12.7.3)
export {
  MAILBOX_STREAM_CLOSE_CAUSES,
  MailboxStreamClosedError,
} from './mailbox.js';
export type {
  MailboxAdmission,
  MailboxAdvanceCursorInput,
  MailboxAppendInput,
  MailboxBody,
  MailboxCursorState,
  MailboxMessage,
  MailboxMessageState,
  MailboxPage,
  MailboxReadQuery,
  MailboxRecordDeliveryInput,
  MailboxCloseStreamInput,
  MailboxCollectExpiredInput,
  MailboxExpirePendingInput,
  MailboxReopenStreamInput,
  MailboxStreamCloseCause,
  MailboxStore,
  MailboxUsage,
} from './mailbox.js';

// Board coordination (§12.3)
export {
  BOARD_STATUSES,
  isLegalBoardTransition,
} from './board.js';
export type {
  BoardClaimInput,
  BoardItem,
  BoardItemInput,
  BoardListQuery,
  BoardPage,
  BoardStatus,
  BoardStatusUpdateInput,
  BoardStore,
  BoardUnclaimInput,
} from './board.js';

// Truth records (§12.3, §12.6.4)
export { TRUTH_RECORD_KINDS } from './truth.js';
export type {
  SnapshotWriteInput,
  TerminalWriteInput,
  TruthBodyRef,
  TruthManifestEntry,
  TruthManifestQuery,
  TruthRecord,
  TruthRecordKind,
  TruthRecordSelector,
  TruthStore,
} from './truth.js';

// Presence (§12.3)
export { freezePresenceRuntimeFact, PRESENCE_LEVELS } from './presence.js';
export type {
  PresenceHint,
  PresenceHintInput,
  PresenceLevel,
  PresenceRuntimeCapabilities,
  PresenceRuntimeFact,
  PresenceStore,
  TenantReadinessDevice,
  TenantReadinessPresence,
  TenantReadiness,
} from './presence.js';

// Content addressing + object manifest (§12.7.4, §12.7.8)
export {
  CONTENT_HASH_PATTERN,
  OBJECT_KEY_PREFIX_PATTERN,
  contentHash,
  isContentHash,
  isLegalObjectTransition,
  objectKeyPrefix,
  tenantObjectKey,
} from './blob.js';
export type {
  ContentHash,
  ObjectCommitInput,
  ObjectKeyPrefix,
  ObjectListQuery,
  ObjectManifestEntry,
  ObjectManifestInput,
  ObjectReference,
  ObjectReferenceInput,
  ObjectState,
  ObjectStore,
} from './blob.js';

// Storage entitlement / usage / reservation (§12.7.6-12.7.7)
export {
  STORAGE_ERROR_CODES,
  STORAGE_ERROR_HTTP_STATUS,
} from './quota.js';
export type {
  QuotaStore,
  StorageErrorCode,
  StorageFinalizeInput,
  StorageFinalizeResult,
  StorageReservation,
  StorageReservationInput,
  StorageReservationState,
  StorageStatus,
  StorageWriteKind,
  StorageWritePosture,
  TenantStorageEntitlement,
  TenantStorageEntitlementInput,
  TenantStorageUsage,
} from './quota.js';

// Capability declaration (ADR-010)
export {
  CAPABILITY_NAME_PATTERN,
  CapabilityDeclarationSchema,
  assertCapability,
  hasCapability,
  parseCapabilityDeclaration,
} from './capabilities.js';
export type { CapabilityDeclaration } from './capabilities.js';

// Skill packs (plan `skill-pack-delivery-channel`): the declarative content
// channel a deployment declares as `skills.pack` (ADR-010) and a paired device
// installs. Schema, limits, and the evaluation point for every one of them.
export {
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_FILE_MAX_BYTES,
  SKILL_PACK_FILE_PATH_PATTERN,
  SKILL_PACK_FORBIDDEN_FIELDS,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  SKILL_PACK_MAX_BYTES,
  checkSkillPackEntry,
  checkSkillPackFileContent,
  checkSkillPackManifest,
  isSkillPackPathSafe,
  parseSkillFrontmatter,
  parseSkillPackManifest,
  skillPackContentHashInput,
} from './skill-pack.js';
export type {
  SkillPackCheck,
  SkillPackFile,
  SkillPackFileContent,
  SkillPackListQuery,
  SkillPackManifest,
  SkillPackPublishInput,
  SkillPackStore,
} from './skill-pack.js';

// Composition contract
export { CORE_STORE_NAMES } from './stores.js';
export type { Clock, CoreStoreName, CoreStores, MutableClock } from './stores.js';

// The port method inventory is shared by source constraints and composition
// conformance. Source interface names belong to the constraints test.
export {
  CORE_PORT_METHODS,
} from './ports-contract.js';

// Device proof (§12.6.3, sprint §S6.2)
export {
  DEVICE_PROOF_DOMAIN_PREFIX,
  DEVICE_PROOF_HEADER,
  DEVICE_PROOF_SCHEMA_ID,
  DeviceProofProtectedClaimsSchema,
  canonicalizeJson,
  canonicalizeJsonBytes,
  deviceProofCanonicalClaims,
  deviceProofSigningInput,
  parseDeviceProofEnvelope,
} from './attestation.js';
export type {
  DeviceProofEnvelopeV1,
  DeviceProofProtectedClaims,
  DeviceProofVerifier,
  JsonObject,
  JsonValue,
} from './attestation.js';

// Device assertion (plan device-assertion-broker): the short-lived,
// audience-scoped envelope a paired device mints for a sibling local process,
// and the verifier a host runs at exchange time. Separate module, separate
// domain prefix, separate error code — see `device-assertion.ts`'s own doc
// comment for why none of it is folded into the device proof above.
export {
  authenticateDeviceAssertion,
  DEVICE_ASSERTION_AUDIENCE_MAX_BYTES,
  DEVICE_ASSERTION_DEFAULT_TTL_MS,
  DEVICE_ASSERTION_DOMAIN_PREFIX,
  DEVICE_ASSERTION_MAX_TTL_MS,
  DEVICE_ASSERTION_SCHEMA_ID,
  DEVICE_ASSERTION_VERSION,
  DeviceAssertionClaimsSchema,
  deviceAssertionSigningInput,
  parseDeviceAssertionEnvelope,
  verifyDeviceAssertion,
} from './device-assertion.js';
// Task-scoped assertion (`byok-task-assertion-v1`, contract §8.1): a SEPARATE
// envelope sharing the device lane's validators and replay authority, never a
// device assertion with extra claims. The two verifiers each accept only their
// own schema.
export {
  authenticateTaskAssertion,
  TASK_ASSERTION_DOMAIN_PREFIX,
  TASK_ASSERTION_SCHEMA_ID,
  TaskAssertionAgentRefSchema,
  TaskAssertionClaimsSchema,
  parseTaskAssertionEnvelope,
  taskAssertionSigningInput,
  verifyTaskAssertion,
} from './device-assertion.js';
export type {
  AuthenticatedDeviceAssertion,
  AuthenticatedTaskAssertion,
  DeviceAssertionClaims,
  DeviceAssertionDeviceRow,
  DeviceAssertionEnvelopeV1,
  DeviceAssertionExpectedBinding,
  DeviceAssertionReplayConsumeInput,
  DeviceAssertionReplayAuthority,
  DeviceAssertionVerifier,
  TaskAssertionAgentRef,
  TaskAssertionClaims,
  TaskAssertionEnvelopeV1,
} from './device-assertion.js';
// Sealed provider provisioning (plan web-sealed-provisioning): request
// schema, canonical AAD/claim bytes, padding, and one-shot HPKE seal/open.
// No reusable encryption context is exported.
export {
  PROVIDER_PROVISIONING_MAX_TTL_MS,
  PROVIDER_PROVISIONING_OPERATIONS,
  SealingPublicJwkSchema,
  assertProviderProvisioningConfigDigest,
  deriveSealingKeyId,
  openProviderProvisioningSecret,
  parseProviderProvisioningRequest,
  providerProvisioningRequestDigest,
  sealProviderProvisioningRequest,
  sealingKeyClaimCanonicalBytes,
} from './sealed-provider-secret.js';
export type {
  ProviderProvisioningExpectedProfile,
  ProviderProvisioningOperation,
  ProviderProvisioningRequestV1,
  SealingPublicJwk,
  WebCryptoKey,
} from './sealed-provider-secret.js';

// Host-approved Agent memory intent identity digest
export {
  agentMemoryIntentOperationDigest,
} from './agent-memory-intent.js';


// Nonce signing domain (§6.2) — the one authority the daemon, the hosted
// surface, and the reference server all sign/verify against.
export { NONCE_SIGNING_DOMAIN, nonceSigningBytes } from './pairing.js';

// In-memory reference implementation
export {
  IN_MEMORY_CLOCK_EPOCH,
  InMemoryBoardStore,
  InMemoryMailboxStore,
  InMemoryDeviceAssertionReplayAuthority,
  InMemoryObjectStore,
  InMemoryPresenceStore,
  InMemoryQuotaStore,
  InMemorySkillPackStore,
  InMemoryTruthStore,
  createInMemoryCoreStores,
  createInMemoryCoreCompositionWithClock,
  createMutableClock,
} from './in-memory/index.js';
export type { InMemoryCoreComposition, InMemoryCoreOptions } from './in-memory/index.js';

export { assertCollectExpiredInput, CollectExpiredFailure } from './retention.js';
export type { CollectExpiredInput, CollectExpiredCounts, CollectExpiredResult } from './retention.js';
export type { QuotaCollectExpiredInput } from './quota.js';
export type { ObjectCollectExpiredInput } from './blob.js';

// Store compatibility precheck result (#1102)
export type { LocalStoreId, StoreCompatibility, StoreCompatibilityVerdict } from './store-compatibility.js';

export { InMemoryStorageLedger } from './in-memory/storage-ledger.js';
export type { InMemoryObjectBytes } from './in-memory/blob.js';


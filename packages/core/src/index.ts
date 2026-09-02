/**
 * `@byok-sdk/core` — platform contracts.
 *
 * What this package exports is deliberately narrow: contracts, schemas, errors,
 * and one in-memory reference implementation. No HTTP, no crypto, no SQL, no
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
  TENANT_KEY_SEPARATOR,
} from './tenant';
export type { TenantId } from './tenant';

export {
  PRINCIPAL_KINDS,
  isDevicePrincipal,
  isControlPlanePrincipal,
  principalTenant,
} from './principals';
export type {
  ControlPlanePrincipal,
  DevicePrincipal,
  Principal,
  PrincipalKind,
} from './principals';

// Errors (single taxonomy)
export { ByokCoreError, CoreConflictError, CORE_ERROR_CODES, isCoreError, isCoreConflictError } from './errors';
export type { CoreErrorCode } from './errors';

// Canonical instants (the format every caller-supplied timestamp must be in)
export {
  CANONICAL_TIMESTAMP_PATTERN,
  assertCanonicalTimestamp,
  isCanonicalTimestamp,
} from './time';

// Mailbox (§12.7.3)
export { MAILBOX_MESSAGE_STATES } from './mailbox';
export type {
  MailboxAdvanceCursorInput,
  MailboxAppendInput,
  MailboxBody,
  MailboxCursorState,
  MailboxMessage,
  MailboxMessageState,
  MailboxPage,
  MailboxReadQuery,
  MailboxRecordDeliveryInput,
  MailboxRetentionInput,
  MailboxRetentionResult,
  MailboxStore,
} from './mailbox';

// Board coordination (§12.3)
export { BOARD_STATUSES, BOARD_TRANSITIONS, isLegalBoardTransition } from './board';
export type {
  BoardAssignee,
  BoardClaimInput,
  BoardItem,
  BoardItemInput,
  BoardListQuery,
  BoardPage,
  BoardStatus,
  BoardStatusUpdateInput,
  BoardStore,
  BoardUnclaimInput,
} from './board';

// Truth records (§12.3, §12.6.4)
export { TRUTH_RECORD_KINDS } from './truth';
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
} from './truth';

// Presence (§12.3)
export { PRESENCE_LEVELS } from './presence';
export type {
  PresenceHint,
  PresenceHintInput,
  PresenceLevel,
  PresenceRuntimeFact,
  PresenceStore,
  TenantReadinessDevice,
  TenantReadinessPresence,
  TenantReadiness,
} from './presence';

// Content addressing + object manifest (§12.7.4, §12.7.8)
export {
  CONTENT_HASH_PATTERN,
  OBJECT_KEY_PREFIX_PATTERN,
  OBJECT_STATES,
  OBJECT_STATE_TRANSITIONS,
  contentHash,
  isContentHash,
  isLegalObjectTransition,
  objectKeyPrefix,
  tenantObjectKey,
} from './blob';
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
} from './blob';

// Storage entitlement / usage / reservation (§12.7.6-12.7.7)
export {
  STORAGE_ERROR_CODES,
  STORAGE_ERROR_HTTP_STATUS,
  STORAGE_RESERVATION_STATES,
  STORAGE_WRITE_KINDS,
  STORAGE_WRITE_POSTURES,
} from './quota';
export type {
  MailboxUsageDeltaInput,
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
} from './quota';

// Capability declaration (ADR-010)
export {
  CAPABILITY_DECLARATION_SCHEMA_ID,
  CAPABILITY_NAME_PATTERN,
  CapabilityDeclarationSchema,
  assertCapability,
  hasCapability,
  parseCapabilityDeclaration,
} from './capabilities';
export type { CapabilityDeclaration } from './capabilities';

// Skill packs (plan `skill-pack-delivery-channel`): the declarative content
// channel a deployment declares as `skills.pack` (ADR-010) and a paired device
// installs. Schema, limits, and the evaluation point for every one of them.
export {
  SKILL_FRONTMATTER_FIELDS,
  SKILL_PACK_DESCRIPTION_MAX_LENGTH,
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_FILE_MAX_BYTES,
  SKILL_PACK_FILE_PATH_MAX_LENGTH,
  SKILL_PACK_FILE_PATH_PATTERN,
  SKILL_PACK_FORBIDDEN_FIELDS,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  SKILL_PACK_MAX_BYTES,
  SKILL_PACK_MAX_FILES,
  SKILL_PACK_NAME_MAX_LENGTH,
  SKILL_PACK_NAME_PATTERN,
  SKILL_PACK_REJECTIONS,
  SKILL_PACK_VERSION_PATTERN,
  SkillPackFileSchema,
  SkillPackManifestSchema,
  checkSkillPackEntry,
  checkSkillPackFileContent,
  checkSkillPackManifest,
  isSkillPackPathSafe,
  parseSkillFrontmatter,
  parseSkillPackManifest,
  skillPackContentHashInput,
} from './skill-pack';
export type {
  ObservedSkillPackFile,
  SkillFrontmatter,
  SkillPackCheck,
  SkillPackFile,
  SkillPackFileContent,
  SkillPackListQuery,
  SkillPackManifest,
  SkillPackPublishInput,
  SkillPackRejection,
  SkillPackStore,
} from './skill-pack';

// Composition contract
export { CORE_STORE_NAMES } from './stores';
export type { Clock, CoreStoreName, CoreStores, MutableClock } from './stores';

// The port method inventory (I7). Contract data, shipped rather than test-only,
// so `@byok-sdk/conformance` can assert compositions against the same table
// `__tests__/constraints.test.ts` asserts the source interfaces against —
// without a `core → conformance` cycle.
export {
  CORE_NON_COMPOSITION_PORT_NAMES,
  CORE_PORT_INTERFACES,
  CORE_PORT_METHODS,
} from './ports-contract';

// Device proof (§12.6.3, sprint §S6.2)
export {
  DEVICE_PROOF_ALGORITHMS,
  DEVICE_PROOF_DOMAIN_PREFIX,
  DEVICE_PROOF_HEADER,
  DEVICE_PROOF_SCHEMA_ID,
  DEVICE_PROOF_VERSION,
  DeviceProofEnvelopeV1Schema,
  DeviceProofProtectedClaimsSchema,
  canonicalizeJson,
  canonicalizeJsonBytes,
  deviceProofCanonicalClaims,
  deviceProofCanonicalJson,
  deviceProofSigningInput,
  parseDeviceProofEnvelope,
} from './attestation';
export type {
  DeviceProofAlgorithm,
  DeviceProofEnvelopeV1,
  DeviceProofProtectedClaims,
  DeviceProofVerifier,
  DeviceProofVerifyInput,
  JsonObject,
  JsonPrimitive,
  JsonValue,
} from './attestation';

// Device assertion (plan device-assertion-broker): the short-lived,
// audience-scoped envelope a paired device mints for a sibling local process,
// and the verifier a host runs at exchange time. Separate module, separate
// domain prefix, separate error code — see `device-assertion.ts`'s own doc
// comment for why none of it is folded into the device proof above.
export {
  authenticateDeviceAssertion,
  DEVICE_ASSERTION_ALGORITHMS,
  DEVICE_ASSERTION_AUDIENCE_MAX_BYTES,
  DEVICE_ASSERTION_DEFAULT_TTL_MS,
  DEVICE_ASSERTION_DOMAIN_PREFIX,
  DEVICE_ASSERTION_MAX_TTL_MS,
  DEVICE_ASSERTION_SCHEMA_ID,
  DEVICE_ASSERTION_VERSION,
  DeviceAssertionClaimsSchema,
  DeviceAssertionEnvelopeV1Schema,
  deviceAssertionCanonicalClaims,
  deviceAssertionCanonicalJson,
  deviceAssertionSigningInput,
  parseDeviceAssertionEnvelope,
  verifyDeviceAssertion,
} from './device-assertion';
export type {
  AuthenticateDeviceAssertionDeps,
  AuthenticatedDeviceAssertion,
  DeviceAssertionAlgorithm,
  DeviceAssertionAuthorityRow,
  DeviceAssertionClaims,
  DeviceAssertionDeviceRow,
  DeviceAssertionEnvelopeV1,
  DeviceAssertionExpectedBinding,
  DeviceAssertionReplayConsumeInput,
  DeviceAssertionReplayAuthority,
  DeviceAssertionVerifier,
  DeviceAssertionVerifyDeps,
  DeviceAssertionVerifyInput,
} from './device-assertion';
// Nonce signing domain (§6.2) — the one authority the daemon, the hosted
// surface, and the reference server all sign/verify against.
export { NONCE_SIGNING_DOMAIN, nonceSigningBytes } from './pairing';

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
} from './in-memory/index';
export type { InMemoryCoreComposition, InMemoryCoreOptions } from './in-memory/index';

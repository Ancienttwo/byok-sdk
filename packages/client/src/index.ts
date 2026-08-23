export type {
  RuntimeAdapter,
  RuntimeAdapterDescriptor,
  RuntimeAdapterPrepareInput,
  RuntimeAdapterPrepareResult,
  RuntimeAdapterRejectedOperation,
  RuntimeAdapterPreparedOperation,
  PreparedRuntimeOperation,
  RuntimeOperationManifest,
  RuntimeOperationStartInput,
  RuntimeCapabilities,
  RuntimeDetectResult,
  Session,
  GitWorkspaceConfig,
  McpStdioServerConfig,
  McpToolsetConfig,
  McpToolsetLifecycleState,
  McpToolsetObservation,
  McpToolsetStatus,
  McpToolsetRegistryStatus,
  McpToolsetReloadReceipt,
  AgentEgressPolicy,
} from './types';
export type { AgentRef } from './agent-home';
export {
  AgentHomeError,
  AgentRefValidationError,
  AgentHomeResolutionError,
  AgentHomeCollisionError,
  AgentHomeBusyError,
  AgentHomeLeaseCorruptError,
  AgentHomeLayout,
  AgentHomeLeaseManager,
  AgentHomeManager,
  createAgentHomeProjection,
  stableAgentHomeOwnerId,
  validateAgentRef,
} from './agent-home';
export {
  AgentSessionHandoffStore,
  AgentSessionHandoffStoreError,
  AgentSessionHandoffCorruptError,
  AgentSessionHandoffMismatchError,
} from './daemon/agent-session-handoff-store';
export type {
  AgentSessionHandoff,
  AgentSessionHandoffMatch,
  AgentTaskTerminalEvidence,
  AgentTaskTerminalMatch,
  AgentTerminalCause,
} from './daemon/agent-session-handoff-store';
export type {
  AgentHomeResolution,
  AgentHomeProjection,
  AgentHomeProjectionInput,
  AgentHomeProjectionFunction,
  AgentHomeLease,
  AgentHomeBinding,
} from './agent-home';
export { PolicyUnsupportedError, SteerUnsupportedError, freezeRuntimeAdapterDescriptor, sealRuntimeOperationManifest } from './types';
export type { RuntimeEnvironmentRequirements } from './daemon/environment';
export { resolveLocalAgentReleaseIdentity } from './release-identity';
export type { LocalAgentReleaseIdentity } from './release-identity';
export {
  RuntimeExecutionFailure,
  RuntimeDisposalFailure,
  RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON,
  isRuntimeDisposalFailure,
  isRuntimeExecutionFailure,
  projectRuntimeBoundaryFailure,
  projectRuntimeExecutionFailure,
} from './runtime-failure';
export type {
  RuntimeExecutionFailureInput,
  RuntimeDisposalFailureInput,
  RuntimeDisposalStage,
  RuntimeFailureCategory,
  RuntimeFailurePhase,
  RuntimeFailureProjection,
  RuntimeRetryDisposition,
} from './runtime-failure';

export { GitWorkspaceManager, GitWorkspaceError, isGitWorkspaceConfig, prependGitWorkspaceGuidance } from './daemon/git-workspace';
export type { GitWorkspaceObservation, GitWorkspaceLease, GitWorkspaceOptions, GitErrorCategory } from './daemon/git-workspace';
export { GitWorkspaceStore } from './daemon/git-workspace-store';
export type { GitWorkspaceLedger, GitWorkspaceLedgerRecord, GitWorkspacePhase } from './daemon/git-workspace-store';


export { createDaemon, createDaemonWithAdapters } from './daemon/create-daemon';
export type {
  Daemon,
  DaemonConfig,
  DaemonStatus,
  DaemonOverrides,
  DaemonBranding,
  HostedJournalConfig,
  DeviceAssertionConfig,
  AgentEgressConfig,
  AgentContentReadConfig,
  AgentContentReadSurfaceConfig,
  AgentReliableEgressInput,
} from './daemon/create-daemon';
export type {
  AgentEgressDropReceipt,
  AgentEgressLaneStatus,
  AgentEgressStatus,
} from './daemon/agent-egress-policy';
export type { AgentEgressSanitizer, AgentEgressSanitizerContext } from './daemon/agent-egress-sanitizer';
export {
  AGENT_CONTENT_READ_CAPABILITIES,
  AGENT_CONTENT_READ_CAPABILITY_WORKSPACE,
  AGENT_CONTENT_READ_CAPABILITY_TRANSCRIPT,
  AGENT_CONTENT_READ_CAPABILITY_ARTIFACT,
} from './daemon/agent-content-read';
export type {
  AgentContentReadSurface,
  AgentContentReadDecision,
  AgentContentReadReason,
  AgentContentReadRoot,
  AgentContentReadPolicy,
  AgentContentReadPolicySelection,
  AgentContentReadRequest,
  AgentContentReadResult,
  AgentContentReadAllowed,
  AgentContentReadDenied,
  AgentContentSessionIdentity,
  AgentContentAuditReceipt,
} from './daemon/agent-content-read';
export {
  McpToolsetRevisionConflictError,
  McpToolsetDefinitionRevisionConflictError,
} from './daemon/toolset-registry';
export type { ProgressBatcherOptions } from './daemon/progress-batcher';

/**
 * Plan `device-assertion-broker`: the ONLY control-socket capability this
 * package exposes publicly. `connectControlClient`/`ControlClient` are
 * deliberately NOT exported and must never be — they also carry `shutdown`,
 * approval resolution and the raw task-event stream, and exporting the client
 * would make all of it public API in one line. See `daemon/assertion-client.ts`
 * and the constraint test that pins this.
 */
export { requestDeviceAssertion } from './daemon/assertion-client';
export type {
  RequestDeviceAssertionOptions,
  RequestDeviceAssertionResult,
  RequestDeviceAssertionErrorCode,
} from './daemon/assertion-client';
export type { OperationalHealthSnapshot, OperationalHealthState } from './daemon/operational-health';

// S3b (L-001/L-002): the durable local journal (architecture §12.7.2). The
// PORT is exported, not just the SQLite implementation, because §12.7.2 lets a
// host inject its own backend — provided it meets the same durability contract
// (a resolved `appendEnvelope` means fsynced). The typed errors are exported
// for the same reason a host needs them: `JournalUnavailableError` is what a
// deployment on the wrong Node version actually sees, and it must be
// distinguishable from a generic startup failure.
export {
  journalHash,
  JournalUnavailableError,
  JournalCorruptError,
  JournalRecordTooLargeError,
  JournalUnknownTaskError,
  JournalClosedError,
} from './daemon/journal/journal';
export type {
  LocalTaskJournal,
  JournalIdentity,
  JournalReceipt,
  ReceivedEnvelopeRecord,
  AdmissionRecord,
  LocalTransitionRecord,
  LocalTerminalRecord,
  TerminalTruthState,
  RecoverableTask,
  RecoveryOutcome,
  RecoveryDisposition,
  LocalStorageUsage,
  StorageCategory,
  CategoryUsage,
  CleanableCategory,
  CleanupCandidate,
  CleanupResult,
  CompactOptions,
  CompactResult,
} from './daemon/journal/journal';
export { SqliteLocalTaskJournal, JOURNAL_DB_FILENAME, JOURNAL_QUARANTINE_DIRNAME } from './daemon/journal/sqlite-journal';
export type { SqliteLocalTaskJournalOptions } from './daemon/journal/sqlite-journal';

// S3b (L-003): local storage policy, watermarks and classified GC
// (architecture §12.7.2.1). Exported for the same reason the journal port is:
// the policy is host-injected, the free-space provider and the cleanup worker
// are both seams a host may need to supply (a host that owns its own log
// rotation or workspace lifecycle already knows things this SDK does not), and
// `LocalStorageEmergencyError` is what a fail-closed hosted daemon actually
// surfaces when it refuses to ack.
export {
  LocalStoragePressureEngine,
  LocalStoragePolicyError,
  LocalStorageEmergencyError,
  resolveLocalStoragePolicy,
  computePressureState,
  cleanupOrderFor,
  cleanupEligibleAt,
  createFilesystemCleanupExecutor,
  createStatfsFreeBytesProvider,
  JOURNAL_TASK_REF_PREFIX,
  DEFAULT_SOFT_BUDGET_RATIO,
  DEFAULT_HARD_BUDGET_RATIO,
  DEFAULT_ACK_CRITICAL_RESERVE_BYTES,
  DEFAULT_CLEANUP_BATCH_LIMIT,
  DEFAULT_INCREMENTAL_VACUUM_PAGES,
  DEFAULT_NORMAL_COMPACTION_INTERVAL_MS,
  DEFAULT_PRESSURE_COMPACTION_INTERVAL_MS,
  DEFAULT_RETENTION_MS,
  DEFAULT_LOG_ROTATION,
} from './daemon/journal/storage-policy';
export type {
  LocalStoragePolicy,
  LocalStoragePolicyInput,
  LocalStoragePressureEngineOptions,
  LogRotationPolicy,
  CompactionPolicy,
  StoragePressureState,
  StoragePressureEvent,
  StorageMeasurement,
  StorageStatusSnapshot,
  StorageTickResult,
  CleanupExecutor,
  CleanupExecution,
  TimerLike,
} from './daemon/journal/storage-policy';
export type { DeviceRecord } from './daemon/store';
export { AuthManager, DeviceRevokedError } from './daemon/auth-manager';
export { StoredDeviceProofSigner } from './daemon/device-proof-signer';
export type {
  DeviceProofRequest,
  DeviceProofSigner,
  StoredDeviceProofSignerOptions,
} from './daemon/device-proof-signer';
/**
 * Plan `skill-pack-delivery-channel`: the device half of the `skills.pack`
 * channel. The install pipeline and the two read APIs are public because the
 * HOST, not this SDK, decides where a vendor CLI keeps its skills (K4) — a host
 * lists what is installed and projects the pack it wants into the directory its
 * own runtime reads. Nothing here ever writes to a vendor CLI's skill directory.
 */
export {
  SKILL_PACKS_CAPABILITY,
  SKILL_PACKS_DIRNAME,
  SKILL_PACK_AUDIT_FILENAME,
  SKILL_PACK_INSTALL_ERROR_CODES,
  SKILL_PACK_LOCK_FILENAME,
  SKILL_PACK_LOCK_SCHEMA,
  SKILL_PACK_RESPONSE_MAX_BYTES,
  SkillPackInstallError,
  installSkillPacks,
  listInstalledSkillPacks,
  projectSkillPack,
  skillPacksRoot,
} from './daemon/skill-pack-installer';
export type {
  InstallSkillPacksOptions,
  InstalledSkillPack,
  ProjectedSkillPack,
  SkillPackInstallErrorCode,
  SkillPackInstallResult,
  SkillPackLock,
} from './daemon/skill-pack-installer';

export { TruthMemoryClient, TruthMemoryClientError } from './daemon/truth-memory-client';
export type {
  LocalMemoryFilter,
  MemorySelector,
  TruthManifestQueryInput,
  TruthManifestRecord,
  TruthMemoryClientErrorCode,
  TruthMemoryClientOptions,
  TruthMemoryMetric,
  TruthSnapshotCandidateInput,
  TruthSnapshotWriteInput,
  TruthTerminalWriteInput,
  TruthWriteBody,
  TruthWriteResult,
  VerifiedTruthRecord,
} from './daemon/truth-memory-client';
export type { ConnectionState } from './daemon/ws-transport';
export { BlobClient } from './daemon/blob-client';
export type { BlobResolver } from './daemon/blob-client';
// M3-2a: local observability — the seam the CLI (M3-2b) consumes for a live
// task feed, a task list, and approve/reject/unpair, all local to a running
// daemon. See `daemon/observer.ts`.
export { DaemonObserver } from './daemon/observer';
export type { DaemonEvent, DaemonEventKind, DaemonEventListener, DaemonTaskInfo, Unsubscribe } from './daemon/observer';

// M3-4: OS service lifecycle (launchd/systemd/WinSW) — see `lifecycle/create-service-lifecycle.ts`.
export { createServiceLifecycle, UnsupportedServicePlatformError } from './lifecycle/create-service-lifecycle';
export type { CreateServiceLifecycleOptions } from './lifecycle/create-service-lifecycle';
export { nodeAgentProgram, sanitizeServiceName } from './lifecycle/service-types';
export type {
  NodeAgentProgramOptions,
  ServiceDefinition,
  ServiceInstallOptions,
  ServiceLifecycle,
  ServiceProgram,
  ServiceStatusResult,
} from './lifecycle/service-types';
export { generateLaunchdPlist } from './lifecycle/launchd';
export { generateSystemdUnit } from './lifecycle/systemd';
export { generateWinswXml } from './lifecycle/winsw';

// Finding F7: the storeDir-hardening chokepoint (`DeviceStore.save()`/
// `control-server.ts`'s `startControlServer` both funnel through this) —
// exported as a building block for a product's own deployment smoke checks
// (see `templates/service/winsw/smoke-test.mjs`'s own win32-only use of it),
// mirroring `generateWinswXml`/`nodeAgentProgram` above. Finding R4:
// `SecureDirHardeningError` is also exported — win32 pairing (`daemon.pair()`)
// can now reject with this typed error if `icacls` fails, and a product
// wrapping this SDK may want to catch it specifically (e.g. to render a
// dedicated "couldn't secure the credential directory" message).
export { ensureSecureDir, buildIcaclsArgs, SecureDirHardeningError } from './util/secure-dir';
export type { EnsureSecureDirOptions } from './util/secure-dir';

export { PiAdapter } from './adapters/pi/pi-adapter';
export type { PiAdapterOptions, PiByokLauncherConfig } from './adapters/pi/pi-adapter';
export { PI_PACKAGE_NAME } from './adapters/pi/resolve-bin';

export { ClaudeAdapter } from './adapters/claude/claude-adapter';
export type { ClaudeAdapterOptions } from './adapters/claude/claude-adapter';

export { CodexAdapter, type CodexAdapterOptions } from './adapters/codex/codex-adapter';

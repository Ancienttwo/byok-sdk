export type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeDetectResult,
  Session,
  TaskContext,
  GitWorkspaceConfig,
} from './types';
export { PolicyUnsupportedError, SteerUnsupportedError } from './types';
// M5: per-runtime environment allowlist — part of the `RuntimeAdapter`
// contract's `environmentRequirements()` method (a custom adapter supplied
// to `createDaemonWithAdapters` implements this too). See `daemon/environment.ts`.
export type { RuntimeEnvironmentRequirements } from './daemon/environment';

export { GitWorkspaceManager, GitWorkspaceError, isGitWorkspaceConfig, prependGitWorkspaceGuidance } from './daemon/git-workspace';
export type { GitWorkspaceObservation, GitWorkspaceLease, GitWorkspaceOptions, GitErrorCategory } from './daemon/git-workspace';
export { GitWorkspaceStore } from './daemon/git-workspace-store';
export type { GitWorkspaceLedger, GitWorkspaceLedgerRecord, GitWorkspacePhase } from './daemon/git-workspace-store';


export { createDaemon, createDaemonWithAdapters } from './daemon/create-daemon';
export type { Daemon, DaemonConfig, DaemonStatus, DaemonOverrides, DaemonBranding, HostedJournalConfig, DeviceAssertionConfig } from './daemon/create-daemon';

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

import type { CapabilityDeclaration } from '@byok-sdk/core';
import type { CapabilityFlag, RuntimeInfo } from '@byok-sdk/protocol';
import type { ServiceEnvironmentStatus } from '../../lifecycle/service-environment';
import type { RuntimeObservation } from '../../runtime-detection';
import type { AgentEgressController } from '../agent-egress-controller';
import type { AuthManager } from '../auth-manager';
import type { BlobClient } from '../blob-client';
import type { ConnectionManager } from '../connection-manager';
import type { ControlServerHandle } from '../control-server';
import type { DaemonLifecycle } from '../daemon-lifecycle';
import type { DaemonOwnerLease } from '../daemon-owner';
import type { FleetJitter } from '../deterministic-jitter';
import type { DeviceMemberKeyring, MemberFreshness } from '../e2ee-keyring';
import type { InputPreparationService } from '../input-preparation-service';
import type { JournalIdentity, LocalTaskJournal } from '../journal/journal';
import type { SqliteLocalTaskJournal } from '../journal/sqlite-journal';
import type { PresencePublisher } from '../presence-publisher';
import type { SealedTasks } from '../sealed-task';
import type { TaskRunner } from '../task-runner';

  /**
 * The daemon's reassigned state, one field per value that used to be a
 * `let` in `buildDaemonWithAdapters` (#926). `buildDaemonWithAdapters` creates
 * the one `state` object; every reader and writer goes through it, so a value
 * written by one stage is the value every other stage reads.
 */
export interface DaemonState {
  /**
   * Set SYNCHRONOUSLY by `performControlShutdown`, before the shutdown RPC's
   * own response is even written — see that function and the `shutting_down`
   * gate for the ~10s minting window this closes.
   *
   * Latched: nothing ever sets it back to `false`, including a later
   * `start()` on this same instance. A daemon that has been told to shut down
   * does not get to mint credentials again in this process, and "fail closed
   * until restart" is the correct posture for the one flag whose entire job is
   * to stop issuance during teardown.
   */
  shuttingDown: boolean;
  retentionIdentity: JournalIdentity | undefined;
  inputPreparationService: InputPreparationService | undefined;
  inputPreparationInitialization: Promise<void> | undefined;
  /**
   * Set when the input-preparation lane is OFF for a reason the operator must
   * resolve, while the rest of the daemon runs: today only a durable record
   * log holding a record from an older record schema version. Fail closed and
   * scoped — the lane refuses typed (local control calls, remote completions,
   * no advertised capability, no prepared-offer lane) and nothing else is
   * affected. Nothing is migrated, read forward or deleted; the message names
   * the record log the operator archives.
   */
  inputPreparationLaneOff: | { readonly code: 'input_preparation_record_log_unsupported'; readonly message: string }
    | undefined;
  /** This run's verified member, once the background resume finds one. */
  deviceMember: DeviceMemberKeyring | undefined;
  memberResuming: boolean;
  /** Set by each start: binds that run's sealed tasks to a ready member. */
  activateSealedTasks: ((keyring: DeviceMemberKeyring) => void) | undefined;
  /** The freshness points a retired keyring left for the next run's member (§50d); a new enrollment voids them. */
  carriedFreshness: MemberFreshness | undefined;
  memberAbort: AbortController | undefined;
  memberResume: Promise<void> | undefined;
  detachOwnedProcessGroupLedger: (() => void) | undefined;
  fleetJitter: FleetJitter | undefined;
  // Before authenticated enrollment is loaded, egress is deliberately unable
  // to persist or acknowledge tenant-scoped records. startUnderLease replaces
  // this with the exact loaded DeviceRecord binding before it accepts work.
  agentEgress: AgentEgressController;
  // Every daemon journals (#924). Opening, schema-initializing and
  // quarantining the SQLite file waits until `startUnderLease` owns the
  // cross-process store lease; a rejected second daemon must not touch the
  // active daemon's DB/WAL/SHM before discovering that it is rejected. On a
  // runtime without `node:sqlite` the journal constructor refuses
  // (`JournalUnavailableError`) before any filesystem work.
  ownedJournal: SqliteLocalTaskJournal | undefined;
  journal: LocalTaskJournal | undefined;
  hostedStorageInitializationBarrierComplete: boolean;
  connection: ConnectionManager | undefined;
  blobLifecycleAbort: AbortController | undefined;
  // #654: sealed output uploads its ciphertext through its own blob client,
  // which shutdown aborts only after the terminal commit barrier. A queued
  // terminal can outlive its run, so its upload reads the current client.
  sealedUploadAbort: AbortController | undefined;
  sealedUploads: BlobClient | undefined;
  // A start under way opens a session, so a sealed output waits for its flags.
  startInProgress: boolean;
  // start()/pair() calls requested and not yet settled, including one queued behind another mutation.
  pendingAuthOperations: number;
  // Request-order evidence: a stop cancels auth operations requested before it.
  authCancellationEpoch: number;
  // The latest run's sealed tasks. A terminal the commit queue holds past a
  // failed stop seals through the run it runs in, never through the stopped
  // run's keyring, which its shutdown retires.
  latestSealedTasks: SealedTasks | undefined;
  /** The latest run's (tenant, device, member); `undefined` while it has no usable member. */
  latestSealIdentity: (() => string | undefined) | undefined;
  /** Set by each start: retires that run's member keyring at shutdown. */
  retireSealedMember: (() => void) | undefined;
  sealedOutputSettled: (() => Promise<void>) | undefined;
  inputPreparationStatusAbort: AbortController | undefined;
  lifecycle: DaemonLifecycle;
  // A successful start owns tenant-bound egress and journal composition. A
  // re-pair during that lifetime is refused rather than leaving any active
  // closure on the previous record; stop() must complete first.
  daemonStarted: boolean;
  // Once an active daemon begins an explicit re-pair, no inbound envelope or
  // host reliable append may observe the old binding after the new record is
  // committed. A failed replacement before commit clears this; a failed
  // shutdown after commit remains fail-closed.
  tenantRebinding: boolean;
  runner: TaskRunner | undefined;
  // M4 Phase 2: local control socket (see `control-server.ts`) — started in
  // `start()`, closed in `stop()`. `undefined` whenever the daemon isn't
  // running, or when binding it failed non-fatally (see `start()`'s own
  // try/catch below).
  controlServerHandle: ControlServerHandle | undefined;
  /**
   * The `authCancellationEpoch` at which this daemon began waiting for
   * service enrollment; `undefined` when it is not waiting. A stop after that
   * point changes the epoch, so a later `enrollment.pair` is refused.
   */
  serviceEnrollmentEpoch: number | undefined;
  serviceEnrollmentTransitioning: boolean;
  daemonOwnerLease: DaemonOwnerLease | undefined;
  // Presence and task context share one deployment declaration. Discovery is
  // asynchronous to start(); only Agent offers with host toolsets wait for it.
  presencePublisher: PresencePublisher | undefined;
  detectedRuntimeFacts: readonly RuntimeInfo[];
  runtimeObservations: RuntimeObservation[];
  resolvedEnvironment: ServiceEnvironmentStatus;
  environmentResolvedAt: string | undefined;
  presenceDiscovery: AbortController | undefined;
  // One active read per connection generation; stale completions cannot publish.
  presenceDiscoveryPass: {
    controller: AbortController;
    completion: Promise<void>;
    outcome: 'pending' | 'read' | 'failed' | 'timeout' | 'aborted';
  } | undefined;
  /**
   * The deployment declaration this daemon last READ (ADR-010), or `undefined`
   * when it has read none — which is what a failed read leaves behind too, on
   * purpose: a declaration that could not be read is exactly as informative as
   * one that declares nothing.
   *
   * Contract §8.1 is why this is now stored rather than consumed and dropped
   * inside the discovery pass. The task lane's capability gate has TWO channels
   * and both must hold, so the deployment-level answer has to outlive the read
   * that produced it — see {@link taskContextCapabilityAvailable}.
   */
  deploymentDeclaration: CapabilityDeclaration | undefined;
  /**
   * The exact `CapabilityFlag[]` instance handed to `ConnectionManager`, which
   * reads it afresh for every `conn.hello` it builds. Held here so the one
   * capability whose answer arrives asynchronously can be added to (or removed
   * from) the advertisement a running daemon publishes, via `refreshHello()` —
   * the same mechanism an `mcpToolsets` reload already uses.
   */
  helloCapabilities: CapabilityFlag[];
  shutdownPromise: Promise<void> | undefined;
  /** M4 Phase 2: when this `start()` began — backs the control socket's `status.uptimeMs`. */
  startedAt: number | undefined;
  auth: AuthManager;
  lifecycleMutationTail: Promise<void>;
}

/** One start's sealed-task lane, shared by the closures that start builds (#926). */
export interface SealedRunState {
  // Assigned once the blob client exists. Startup recovery before that
  // writes only `daemon_interrupted`, which stays plaintext (decision 12d).
  sealedTasks: SealedTasks | undefined;
  /** This run's verified member, bound when it is first ready; a loss leaves it bound and keyless. */
  sealedMember: DeviceMemberKeyring | undefined;
  /** The (tenant, device, member) of {@link sealedMember}, taken when it is bound, so retiring the member at shutdown keeps it. */
  ownSealIdentity: string | undefined;
}

import { DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME } from '../task-runner';
import { resolveAgentEgressPolicy } from '../agent-egress-policy';
import type { ProgressBatcherOptions } from '../progress-batcher';
import { DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS, DEFAULT_PRESENCE_TTL_MS, DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS, assertPresenceHeartbeatCadence } from '../presence-publisher';
import { resolveDeviceAssertionAudiences, resolveDeviceAssertionTtlMs } from './support';
import { DeviceStore, type DeviceRecord } from '../store';
import { foldNameAliases, resolveStorageConfig } from '../retention/config';
import { ScratchRoot } from '../retention/scratch';
import { StoragePressure } from '../retention/pressure';
import { validateInputPreparationLimits } from '../../input-preparation';
import { buildRuntimeEnv } from '../environment';
import { createPreparedToolSurfaceAssembler } from '../prepared-tool-surface';
import { isAgentMemorySecureFilesystemAvailable } from '../agent-memory';
import { LocalTeamWorkspace } from '../team-workspace';
import { createDeviceCredentialStore, createDeviceMemberCustody } from '../device-credential-provider';
import { DeviceMemberRecords } from '../device-member-custody';
import type { DeviceMemberKeyring } from '../e2ee-keyring';
import type { DaemonInputs } from './scope';
import type { DaemonConfigScope } from './config';

/**
 * The second stage of `buildDaemonWithAdapters` (#926): resolves the
 * operational bounds (Agent-home reader attempts, egress batching, presence
 * cadence, device-assertion audiences and TTL), then builds the store paths,
 * the storage budget and scratch root, the input-preparation limits and
 * prepared tool surface, the team workspace, the device store and the member
 * records.
 */
export function composeDaemonStores(input: Pick<DaemonInputs & DaemonConfigScope, 'config' | 'overrides' | 'agentMemoryMcpEnabled' | 'resolveAgentMemoryFilesystemHelperBin' | 'toolsetRegistry' | 'agentMemoryDescribeBin'>) {
  const { config, overrides, agentMemoryMcpEnabled, resolveAgentMemoryFilesystemHelperBin, toolsetRegistry, agentMemoryDescribeBin } = input;
  // Resolved exactly once so the admission gate and the status readback below
  // can never report different numbers.
  const agentHomeReaderLimit = config.maxConcurrentReaderAttemptsPerAgentHome
    ?? DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME;
  const egressPolicy = resolveAgentEgressPolicy(config.agentEgress?.policy);
  const egressBatcherOptions: ProgressBatcherOptions | undefined = config.agentEgress === undefined
    ? config.progressBatch
    : {
        ...config.progressBatch,
        flushIntervalMs: Math.min(config.progressBatch?.flushIntervalMs ?? 250, egressPolicy.activity.maxCoalesceMs),
      };

  // Same up-front discipline as `maxTaskOutputBytes` above: the presence
  // cadence is pure config, so a band violation is a construction error rather
  // than something the heartbeat loop discovers later — see
  // `DaemonConfig.presence`. Resolved once here so the assertion and the
  // publisher below can never read different numbers.
  const presenceCadence = {
    intervalMs: config.presence?.intervalMs ?? DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
    ttlMs: config.presence?.ttlMs ?? DEFAULT_PRESENCE_TTL_MS,
    minimumIntervalMs: config.presence?.minimumIntervalMs ?? DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  };
  assertPresenceHeartbeatCadence(presenceCadence);

  // Plan `device-assertion-broker`: same up-front discipline as the two blocks
  // above. This one guards a local AUTHENTICATION surface, so every rejection
  // below is a construction error rather than a runtime refusal — a daemon
  // that starts with a malformed allowlist is a daemon whose operator believes
  // an allowlist is in force.
  //
  // Resolved into a `Set` (exact membership, no ordering, no pattern) and a
  // number here, once, so the handler below cannot read a different allowlist
  // or a different TTL than the one that was validated.
  const deviceAssertionAudiences = resolveDeviceAssertionAudiences(config.deviceAssertion);
  const deviceAssertionTtlMs = resolveDeviceAssertionTtlMs(config.deviceAssertion);

  const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
  // Retention derives its roots from this spelling and checks their identity.
  const retentionStoreDir = foldNameAliases(storeDir);
  const storageConfig = resolveStorageConfig(retentionStoreDir, config.storage);
  const retentionClock = overrides.retention?.clock ?? (() => new Date());
  const scratchRoot = new ScratchRoot(storageConfig.scratchRoot, retentionClock);
  const storagePressure = new StoragePressure(storageConfig.budget);

  /**
   * B-P2 local primitive. Three facts are resolved here, once, at construction:
   *
   * 1. The limits policy is VALIDATED now, not on the first call. A present but
   *    malformed policy is a construction error (same rule as the presence
   *    cadence and the assertion allowlist); an ABSENT section leaves the whole
   *    surface off, and all three methods answer `input_preparation_unconfigured`.
   * 2. The native compiler binds to the identity of the pinned official Pi
   *    release. If the client pin does not name that release the feature does
   *    not silently degrade to a caller-supplied identity — it answers
   *    `runtime_identity_unavailable` and compiles nothing.
   * 3. The service itself, which owns the durable record log under `storeDir`.
   */
  const inputPreparationLimits =
    config.inputPreparation === undefined ? undefined : validateInputPreparationLimits(config.inputPreparation.limits);
  /**
   * The ONE prepared-tool-surface entry, bound to this daemon's registry
   * (`./prepared-tool-surface.ts`).
   *
   * There is deliberately no second path: both
   * the local `input_preparation.prepare` control call and the remote
   * `agent.input.preparation` envelope reach this assembler through
   * `InputPreparationService.prepare`, so a preparation's fingerprints and an
   * offer's admission bind the same facts.
   *
   * The runtime environment is resolved PER CALL, exactly as the offer path
   * builds it — a value captured at construction would miss a later change.
   */
  const preparationRuntimeEnv = () => buildRuntimeEnv({ ambient: process.env });
  const preparedToolSurface = createPreparedToolSurfaceAssembler({
    memoryAvailable: () => agentMemoryMcpEnabled && isAgentMemorySecureFilesystemAvailable(resolveAgentMemoryFilesystemHelperBin !== undefined),
    toolsetRegistry,
    runtimeEnv: preparationRuntimeEnv,
    ...(agentMemoryDescribeBin === undefined ? {} : { agentMemoryDescribe: agentMemoryDescribeBin }),
  });

  const teamWorkspaces = new LocalTeamWorkspace(storeDir);
  const store = new DeviceStore(storeDir, overrides.deviceCredentials === undefined ? createDeviceCredentialStore({
    productId: config.productId, storeDir, deviceCredentials: config.deviceCredentials,
  }) : overrides.deviceCredentials);
  // #654 E2d-1: the member entries live in the same OS custody as the
  // enrollment. An injected enrollment backend has no member custody, so such
  // a daemon refuses an E2EE pairing rather than split one device's secrets
  // across two custodians.
  const memberRecords = overrides.deviceCredentials === undefined
    ? new DeviceMemberRecords(createDeviceMemberCustody({ productId: config.productId, storeDir, deviceCredentials: config.deviceCredentials }))
    : undefined;
  const sealIdentityOf = (record: DeviceRecord, member: DeviceMemberKeyring | undefined): string | undefined => {
    const memberId = member?.session?.member.memberId;
    return memberId === undefined ? undefined : JSON.stringify([record.tenantId, record.deviceId, memberId]);
  };
  return {
    agentHomeReaderLimit, egressPolicy, egressBatcherOptions, presenceCadence, deviceAssertionAudiences,
    deviceAssertionTtlMs, storeDir, retentionStoreDir, storageConfig, retentionClock, scratchRoot, storagePressure,
    inputPreparationLimits, preparedToolSurface, teamWorkspaces, store, memberRecords, sealIdentityOf,
  };
}

export type DaemonStoreScope = ReturnType<typeof composeDaemonStores>;

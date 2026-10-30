import { DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME } from '../task-runner';
import { resolveAgentEgressPolicy } from '../agent-egress-policy';
import type { ProgressBatcherOptions } from '../progress-batcher';
import { resolveDaemonOperationalConfig } from './operational-config';
import { DeviceStore, type DeviceRecord } from '../store';
import { resolveStorageConfig } from '../retention/config';
import { ScratchRoot } from '../retention/scratch';
import { StoragePressure } from '../retention/pressure';
import type { RuntimeAdapter } from '../../types';
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
export function composeDaemonStores(input: Pick<DaemonInputs & DaemonConfigScope, 'config' | 'overrides' | 'agentMemoryMcpEnabled' | 'resolveAgentMemoryFilesystemHelperBin' | 'toolsetRegistry' | 'agentMemoryDescribeBin'> & { adapters: readonly RuntimeAdapter[] }) {
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

  const { presenceCadence, deviceAssertionAudiences, deviceAssertionTtlMs, inputPreparationLimits } =
    resolveDaemonOperationalConfig(config);

  const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
  const storageConfig = resolveStorageConfig(storeDir, config.storage);
  const retentionClock = overrides.retention?.clock ?? (() => new Date());
  const scratchRoot = new ScratchRoot(storageConfig.scratchRoot, retentionClock);
  const storagePressure = new StoragePressure(storageConfig.budget);

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
   * The runtime environment is the Pi adapter's, resolved PER CALL exactly
   * as the offer path builds it — a value captured at construction would
   * miss a later change.
   */
  const piAdapter = input.adapters.find((adapter) => adapter.descriptor.id === 'pi');
  const preparedToolSurface = createPreparedToolSurfaceAssembler({
    memoryAvailable: () => agentMemoryMcpEnabled && isAgentMemorySecureFilesystemAvailable(resolveAgentMemoryFilesystemHelperBin !== undefined),
    toolsetRegistry,
    ...(piAdapter === undefined ? {} : { runtimeEnv: async () => (await piAdapter.runtimeEnvironment()).env }),
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
    deviceAssertionTtlMs, storeDir, storageConfig, retentionClock, scratchRoot, storagePressure,
    inputPreparationLimits, preparedToolSurface, teamWorkspaces, store, memberRecords, sealIdentityOf,
  };
}

export type DaemonStoreScope = ReturnType<typeof composeDaemonStores>;

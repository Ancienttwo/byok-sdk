import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isTenantId } from '@byok-sdk/core';
import { AgentRefSchema, type AgentRef } from '@byok-sdk/protocol';
import {
  AGENT_HOME_INTERNAL_DIRECTORY, AgentHomeBusyError, AgentHomeLeaseHeldError, AgentHomeLeaseManager, AgentHomeLeaseMarkerMismatchError, AgentHomeManager,
  agentHomeLeaseGuidance, releaseAgentHomeLeaseMarkers, stableAgentHomeOwnerId, type AgentHomeLeaseBlock, type AgentHomeLeaseMarkerName,
} from '../agent-home.js';
import { connectControlClient } from '../daemon/control-client.js';
import { acquireDaemonOwner, DaemonOwnerActiveError } from '../util/daemon-owner.js';
import { OwnedProcessLedger, OwnedProcessResidueError } from '../daemon/owned-process-ledger.js';
import { AgentMessageOutbox, AGENT_MESSAGE_DIRECTORY, AGENT_MESSAGE_OUTBOX_FILENAME } from '../daemon/agent-message-outbox.js';
import { DeviceStore } from '../daemon/store.js';
import { createDeviceCredentialStore } from '../daemon/device-credential-provider.js';
import type { DaemonConfig } from '../daemon/create-daemon.js';
import { quarantineCorruptOperationalHealth } from './diagnostics.js';
import type { OperationalHealthFixResult } from './types.js';
import type { DiagnoseDeviceOptions } from './device-doctor.js';
import { createSupportBundle, isSupportBundleOutputInStore, writeSupportBundle } from './support-bundle.js';

const MESSAGES = {
  'confirmation-required': 'Explicit confirmation is required for this local maintenance action.',
  'invalid-input': 'The maintenance action requires valid explicit inputs.',
  'daemon-running': 'Stop the host daemon before local maintenance.',
  'store-busy': 'Another operation owns the device store.',
  'agent-busy': 'Another operation owns the Agent home.',
  'agent-lease-held': 'An Agent home lease marker blocks this action.',
  'owned-process-residue': 'Runtime processes a crashed daemon left could not be ended. Start the daemon to see the record path, verify the processes are gone, then delete that record from the owned-processes directory of the device store.',
  'target-mismatch': 'The stored device or Agent records do not match the authorized target.',
  'source-unavailable': 'The local source cannot be accessed safely; preserve it for inspection.',
  'output-exists': 'The selected output already exists; it will not be overwritten.',
  'operation-failed': 'The maintenance operation did not complete; preserve evidence before retrying.',
} as const;
export type DeviceOperatorErrorCode = keyof typeof MESSAGES;

/**
 * Closed codes only: never attach filesystem/OS error text, paths or nested
 * causes. `agent-lease-held` also carries why the marker blocks
 * (`blockedBy`) and what clears it, in the message.
 */
export class DeviceOperatorError extends Error {
  constructor(readonly code: DeviceOperatorErrorCode, readonly blockedBy?: AgentHomeLeaseBlock) {
    super(blockedBy === undefined ? MESSAGES[code] : `${MESSAGES[code]} ${agentHomeLeaseGuidance(blockedBy)}`);
    this.name = 'DeviceOperatorError';
  }
}

export interface ConfirmDeviceMaintenanceInput { confirmed: true }
export type DeviceHealthQuarantineResult = OperationalHealthFixResult & {
  action: 'quarantine-operational-health'; scope: 'device';
};
export interface ExportDeviceSupportBundleInput extends DiagnoseDeviceOptions {
  /** Absolute, previously unused file in an existing directory outside the device store. */
  outputPath: string;
}
export interface DeviceSupportBundleExportResult {
  action: 'export-support-bundle'; scope: 'device'; status: 'written'; bundleVersion: 1;
}
export interface ArchiveAgentTerminalMessagesInput extends ConfirmDeviceMaintenanceInput {
  expectedTenantId: string;
  expectedDeviceId: string;
  /** Selects one Agent home. Historical profile revisions are preserved verbatim. */
  agentRef: AgentRef;
  /** Absolute NEW directory in an existing parent; contains sensitive audit bodies. */
  archiveDirectory: string;
}
export interface ReleaseAgentHomeLeasesInput extends ConfirmDeviceMaintenanceInput {
  /**
   * A marker `byok-agent doctor` lists, removed whichever owner wrote it:
   * its `markerPath` and the `ownerId` it records (`null` for a corrupt
   * marker). Name one only once the machine, container or store that wrote
   * it no longer writes to this `agentHome.hostStorageRoot`. A marker whose
   * writer is proved running is never removed.
   */
  marker?: AgentHomeLeaseMarkerName;
}
export interface AgentHomeLeasesReleaseResult {
  action: 'release-agent-home-leases'; scope: 'device';
  /** This store's markers removed: their writer is proved gone, or they record none. */
  released: number;
  namedRemoved: boolean;
  removedTemps: number;
  /** Markers left in place because they cannot be proved free; `byok-agent doctor` lists them. */
  kept: { own: number; foreignOwner: number; corrupt: number };
}
export type AgentTerminalMessagesArchiveResult = {
  action: 'archive-terminal-messages'; scope: 'agent';
} & ({ status: 'not-needed' } | { status: 'archived'; archivedRecords: number; archiveFileName: string });

function requireConfirmation(input: ConfirmDeviceMaintenanceInput): void {
  if (input?.confirmed !== true) throw new DeviceOperatorError('confirmation-required');
}
function closedError(error: unknown): DeviceOperatorError {
  if (error instanceof DeviceOperatorError) return error;
  if (error instanceof DaemonOwnerActiveError) return new DeviceOperatorError('store-busy');
  if (error instanceof AgentHomeLeaseHeldError) return new DeviceOperatorError('agent-lease-held', error.blockedBy);
  if (error instanceof AgentHomeLeaseMarkerMismatchError) return new DeviceOperatorError('target-mismatch');
  if (error instanceof AgentHomeBusyError) return new DeviceOperatorError('agent-busy');
  if (error instanceof OwnedProcessResidueError) return new DeviceOperatorError('owned-process-residue');
  return new DeviceOperatorError('operation-failed');
}
async function requireOffline(config: Pick<DaemonConfig, 'productId'>, storeDir: string): Promise<void> {
  const control = await connectControlClient({ productId: config.productId, storeDir });
  if (control.ok) {
    control.client.close();
    throw new DeviceOperatorError('daemon-running');
  }
  // Offline is an observation only. The existing owner lease gates mutation.
}

/** Quarantines confirmed-corrupt health only; the host owns supervisor stop/restart. */
export async function quarantineDeviceOperationalHealth(
  config: DaemonConfig, input: ConfirmDeviceMaintenanceInput,
): Promise<DeviceHealthQuarantineResult> {
  requireConfirmation(input);
  try {
    const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
    await requireOffline(config, storeDir);
    const result = await quarantineCorruptOperationalHealth(storeDir);
    return { action: 'quarantine-operational-health', scope: 'device', ...result };
  } catch (error) { throw closedError(error); }
}

/** Read-only source observation; publishes only the SDK allowlisted bundle, never raw logs. */
export async function exportDeviceSupportBundle(
  config: DaemonConfig, input: ExportDeviceSupportBundleInput,
): Promise<DeviceSupportBundleExportResult> {
  if (typeof input?.outputPath !== 'string' || !path.isAbsolute(input.outputPath)) {
    throw new DeviceOperatorError('invalid-input');
  }
  try {
    const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
    if (await isSupportBundleOutputInStore(storeDir, input.outputPath)) throw new DeviceOperatorError('invalid-input');
    const bundle = await createSupportBundle(config, storeDir, {
      adapters: input.adapters, runtimeProbeTimeoutMs: input.runtimeProbeTimeoutMs,
    });
    await writeSupportBundle(input.outputPath, bundle);
    return { action: 'export-support-bundle', scope: 'device', status: 'written', bundleVersion: bundle.version };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new DeviceOperatorError('output-exists');
    throw closedError(error);
  }
}

/** Checks the existing source without following internal symlinks or opening special files. */
async function existingOutbox(home: string): Promise<boolean> {
  const components = [home, path.join(home, AGENT_HOME_INTERNAL_DIRECTORY), path.join(home, AGENT_MESSAGE_DIRECTORY),
    path.join(home, AGENT_MESSAGE_DIRECTORY, AGENT_MESSAGE_OUTBOX_FILENAME)];
  for (let index = 0; index < components.length; index += 1) {
    let stat;
    try { stat = await fs.lstat(components[index]!); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new DeviceOperatorError('source-unavailable');
    }
    if (stat.isSymbolicLink() || (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new DeviceOperatorError('source-unavailable');
    }
  }
  return true;
}

/** Archive refused/revoked evidence for one Agent under device and Agent single-writer leases. */
export async function archiveAgentTerminalMessages(
  config: DaemonConfig, input: ArchiveAgentTerminalMessagesInput,
): Promise<AgentTerminalMessagesArchiveResult> {
  requireConfirmation(input);
  const parsedRef = AgentRefSchema.safeParse(input.agentRef);
  if (!parsedRef.success || !isTenantId(input.expectedTenantId) ||
    typeof input.expectedDeviceId !== 'string' || !input.expectedDeviceId.trim() ||
    typeof input.archiveDirectory !== 'string' || !path.isAbsolute(input.archiveDirectory) || !config.agentHome) {
    throw new DeviceOperatorError('invalid-input');
  }
  const notNeeded = { action: 'archive-terminal-messages', scope: 'agent', status: 'not-needed' } as const;
  try {
    const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
    await requireOffline(config, storeDir);
    const owner = await acquireDaemonOwner(storeDir, 'doctor');
    try {
      // The same-owner Agent home lease below reclaims a crashed daemon's
      // marker; its runtime processes must be proved gone first, exactly as
      // daemon start does (#393).
      await new OwnedProcessLedger(storeDir).reconcile();
      // Credential-blind metadata; callers supply an authenticated target, never infer it here.
      const metadata = await new DeviceStore(config.productId, storeDir, createDeviceCredentialStore({ productId: config.productId, storeDir, deviceCredentials: config.deviceCredentials })).load();
      if (!metadata || metadata.deviceId !== input.expectedDeviceId || metadata.tenantId !== input.expectedTenantId) {
        throw new DeviceOperatorError('target-mismatch');
      }
      const manager = new AgentHomeManager({ hostStorageRoot: config.agentHome.hostStorageRoot,
        // It holds the owner lease and reconciled above, so it reclaims residue as a started daemon does.
        leaseManager: new AgentHomeLeaseManager({ ownerId: stableAgentHomeOwnerId(storeDir, config.productId), reclaimsResidue: () => true }) });
      const home = await manager.layout.canonicalHomePath(parsedRef.data);
      if (!await existingOutbox(home)) return notNeeded;
      const binding = await manager.acquire(parsedRef.data);
      try {
        if (!await existingOutbox(binding.lease.cwd)) throw new DeviceOperatorError('source-unavailable');
        const outbox = await AgentMessageOutbox.open(binding.lease.cwd);
        const records = outbox.records();
        if (records.some(record => record.tenantId !== input.expectedTenantId || record.agentRef.agentId !== parsedRef.data.agentId)) {
          throw new DeviceOperatorError('target-mismatch');
        }
        const archivedRecords = outbox.terminalRecords().length;
        if (archivedRecords === 0) return notNeeded;
        // Exclusive NEW output directory makes even the internal UUID file non-overwriting.
        try { await fs.mkdir(input.archiveDirectory, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DeviceOperatorError('output-exists');
          throw error;
        }
        const archivePath = await outbox.archiveTerminalRecords(input.archiveDirectory);
        if (!archivePath) throw new DeviceOperatorError('operation-failed');
        return { action: 'archive-terminal-messages', scope: 'agent', status: 'archived',
          archivedRecords, archiveFileName: path.basename(archivePath) };
      } finally { await binding.lease.release(); }
    } finally { await owner.release(); }
  } catch (error) { throw closedError(error); }
}

/**
 * {@link releaseAgentHomeLeases} without the closed error codes: a refusal is
 * thrown as is and may name a path, for a local caller such as uninstall.
 *
 * @internal
 */
export async function releaseStoreAgentHomeLeases(
  config: Pick<DaemonConfig, 'productId' | 'storeDir'>, hostStorageRoot: string, marker?: AgentHomeLeaseMarkerName,
): Promise<AgentHomeLeasesReleaseResult> {
  const storeDir = DeviceStore.resolveDir(config.productId, config.storeDir);
  await requireOffline(config, storeDir);
  const owner = await acquireDaemonOwner(storeDir, 'doctor');
  try {
    // Removing this owner's markers is the reclaim a started daemon does, so
    // its runtime processes must be proved gone first (#393).
    await new OwnedProcessLedger(storeDir).reconcile();
    const result = await releaseAgentHomeLeaseMarkers(hostStorageRoot, stableAgentHomeOwnerId(storeDir, config.productId), marker);
    const kept = (own: boolean, corrupt: boolean) => result.kept.filter((entry) => entry.own === own && (entry.state === 'corrupt') === corrupt).length;
    return { action: 'release-agent-home-leases', scope: 'device', released: result.released, namedRemoved: result.namedRemoved,
      removedTemps: result.removedTemps,
      kept: { own: kept(true, false), foreignOwner: kept(false, false), corrupt: kept(false, true) } };
  } finally { await owner.release(); }
}

/**
 * Release this store's Agent-home lease markers, and a `marker` the operator
 * names, so other stores sharing `agentHome.hostStorageRoot` can use those
 * homes (#2333). Run it after the daemon exits and before a store is deleted;
 * service uninstall runs it itself. It refuses, removing nothing, while a
 * writer of this store runs or while the named marker's writer is proved
 * running; a marker it cannot prove free is kept and counted.
 */
export async function releaseAgentHomeLeases(
  config: DaemonConfig, input: ReleaseAgentHomeLeasesInput,
): Promise<AgentHomeLeasesReleaseResult> {
  requireConfirmation(input);
  const marker = input.marker;
  if (!config.agentHome || (marker !== undefined && (typeof marker?.markerPath !== 'string' || !path.isAbsolute(marker.markerPath)
    || (marker.ownerId !== null && typeof marker.ownerId !== 'string')))) {
    throw new DeviceOperatorError('invalid-input');
  }
  try {
    return await releaseStoreAgentHomeLeases(config, config.agentHome.hostStorageRoot, marker);
  } catch (error) { throw closedError(error); }
}

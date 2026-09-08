import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isTenantId } from '@byok-sdk/core';
import { AgentRefSchema, type AgentRef } from '@byok-sdk/protocol';
import { AGENT_HOME_INTERNAL_DIRECTORY, AgentHomeBusyError, AgentHomeLeaseManager, AgentHomeManager, stableAgentHomeOwnerId } from '../agent-home';
import { connectControlClient } from '../bin/control-client';
import { acquireDaemonOwner, DaemonOwnerActiveError } from '../daemon/daemon-owner';
import { AgentMessageOutbox, AGENT_MESSAGE_DIRECTORY, AGENT_MESSAGE_OUTBOX_FILENAME } from '../daemon/agent-message-outbox';
import { DeviceStore } from '../daemon/store';
import type { DaemonConfig } from '../daemon/create-daemon';
import { quarantineCorruptOperationalHealth } from './diagnostics';
import type { OperationalHealthFixResult } from './types';
import type { DiagnoseDeviceOptions } from './device-doctor';
import { createSupportBundle, writeSupportBundle } from './support-bundle';

const MESSAGES = {
  'confirmation-required': 'Explicit confirmation is required for this local maintenance action.',
  'invalid-input': 'The maintenance action requires valid explicit inputs.',
  'daemon-running': 'Stop the host daemon before local maintenance.',
  'store-busy': 'Another operation owns the device store.',
  'agent-busy': 'Another operation owns the Agent home.',
  'target-mismatch': 'The stored device or Agent records do not match the authorized target.',
  'source-unavailable': 'The local source cannot be accessed safely; preserve it for inspection.',
  'output-exists': 'The selected output already exists; it will not be overwritten.',
  'operation-failed': 'The maintenance operation did not complete; preserve evidence before retrying.',
} as const;
export type DeviceOperatorErrorCode = keyof typeof MESSAGES;

/** Closed codes only: never attach filesystem/OS error text, paths or nested causes. */
export class DeviceOperatorError extends Error {
  constructor(readonly code: DeviceOperatorErrorCode) {
    super(MESSAGES[code]);
    this.name = 'DeviceOperatorError';
  }
}

export interface ConfirmDeviceMaintenanceInput { confirmed: true }
export type DeviceHealthQuarantineResult = OperationalHealthFixResult & {
  action: 'quarantine-operational-health'; scope: 'device';
};
export interface ExportDeviceSupportBundleInput extends DiagnoseDeviceOptions {
  /** Absolute, previously unused file in an existing directory. */
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
export type AgentTerminalMessagesArchiveResult = {
  action: 'archive-terminal-messages'; scope: 'agent';
} & ({ status: 'not-needed' } | { status: 'archived'; archivedRecords: number; archiveFileName: string });

function requireConfirmation(input: ConfirmDeviceMaintenanceInput): void {
  if (input?.confirmed !== true) throw new DeviceOperatorError('confirmation-required');
}
function closedError(error: unknown): DeviceOperatorError {
  if (error instanceof DeviceOperatorError) return error;
  if (error instanceof DaemonOwnerActiveError) return new DeviceOperatorError('store-busy');
  if (error instanceof AgentHomeBusyError) return new DeviceOperatorError('agent-busy');
  return new DeviceOperatorError('operation-failed');
}
async function requireOffline(config: DaemonConfig, storeDir: string): Promise<void> {
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
      // Credential-blind metadata; callers supply an authenticated target, never infer it here.
      const metadata = await new DeviceStore(storeDir, undefined, config.productId).load();
      if (!metadata || metadata.deviceId !== input.expectedDeviceId || metadata.tenantId !== input.expectedTenantId) {
        throw new DeviceOperatorError('target-mismatch');
      }
      const manager = new AgentHomeManager({ hostStorageRoot: config.agentHome.hostStorageRoot,
        leaseManager: new AgentHomeLeaseManager({ ownerId: stableAgentHomeOwnerId(storeDir, config.productId) }) });
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

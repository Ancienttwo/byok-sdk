import { EXPIRING_CLASS_IDS, type ExpiringClassId } from './registry';
import { defaultScratchRoot, validateScratchRoot } from './scratch';
import path from 'node:path';

export class LocalStorageConfigError extends Error {
  constructor(field: string, reason?: string) { super(`DaemonConfig.storage.${field} ${reason ?? 'is invalid'}`); this.name = 'LocalStorageConfigError'; }
}
export interface StorageBudgetInput {
  maxStoreBytes: number;
  minFreeBytes: number;
  softMinFreeBytes?: number;
  softBudgetRatio?: number;
  hardBudgetRatio?: number;
  ackCriticalReserveBytes?: number;
}
export interface StorageConfig {
  scratchRoot?: string;
  budget?: StorageBudgetInput;
  /** Exact SDK skill-pack dataDir roots used by installSkillPacks. */
  skillPackDataDirs?: readonly string[];
  retention?: {
    sweepIntervalMs?: number;
    pressureSweepIntervalMs?: number;
    maxDeletionsPerPass?: number;
    maxPassDurationMs?: number;
    ttlMs?: Partial<Record<ExpiringClassId, number>>;
  };
  /** Every daemon journals tasks durably in `<storeDir>/daemon.db` before it acks them. */
  journal?: {
    /** Bound on waiting for the journal's write lock, ms. Defaults to the journal's own bound. */
    busyTimeoutMs?: number;
    /**
     * Per-record byte bound. Defaults to the journal's own bound (256 KiB); oversized records are refused, never truncated.
     * An inbound envelope record may still reach a floor derived from the inline sealed maximum (415083 bytes),
     * so a sealed envelope is journaled and declined, not stalled (#654). An inbound envelope above the bound is
     * not stored and does not stall the cursor: an offer is declined (`inbound_envelope_too_large`), any other
     * envelope is dropped (#826).
     */
    maxRecordBytes?: number;
  };
}
export interface StorageBudget {
  readonly maxStoreBytes: number; readonly minFreeBytes: number; readonly softMinFreeBytes: number;
  readonly softBudgetRatio: number; readonly hardBudgetRatio: number; readonly ackCriticalReserveBytes: number;
}
export const DEFAULT_RETENTION_TTL_MS: Readonly<Record<ExpiringClassId, number>> = Object.freeze({
  'exec-sdk': 0, 'exec-runtime': 86_400_000, 'daemon-temp': 3_600_000, 'durable-replica': 0,
  'input-preparation': 0, 'confirmed-journal': 30 * 86_400_000, 'reader-run': 7 * 86_400_000,
  'agent-result': 7 * 86_400_000, 'home-temp': 3_600_000, 'skill-pack-old': 86_400_000,
});
function integer(value: number, field: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new LocalStorageConfigError(field);
  return value;
}
export function resolveStorageBudget(input: StorageBudgetInput): StorageBudget {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new LocalStorageConfigError('budget');
  const budget = {
    maxStoreBytes: integer(input.maxStoreBytes, 'budget.maxStoreBytes'),
    minFreeBytes: integer(input.minFreeBytes, 'budget.minFreeBytes'),
    softMinFreeBytes: integer(input.softMinFreeBytes ?? input.minFreeBytes * 2, 'budget.softMinFreeBytes'),
    softBudgetRatio: input.softBudgetRatio ?? 0.8, hardBudgetRatio: input.hardBudgetRatio ?? 0.9,
    ackCriticalReserveBytes: integer(input.ackCriticalReserveBytes ?? 8 * 1024 * 1024, 'budget.ackCriticalReserveBytes'),
  };
  if (!(budget.softBudgetRatio > 0 && budget.softBudgetRatio < budget.hardBudgetRatio && budget.hardBudgetRatio <= 1)
    || budget.softMinFreeBytes < budget.minFreeBytes || budget.ackCriticalReserveBytes > budget.minFreeBytes) throw new LocalStorageConfigError('budget.watermarks');
  return Object.freeze(budget);
}
export function resolveStorageConfig(storeDir: string, input: StorageConfig = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new LocalStorageConfigError('config');
  if (input.retention === null) throw new LocalStorageConfigError('retention');
  const retention = input.retention ?? {};
  if (typeof retention !== 'object' || Array.isArray(retention)) throw new LocalStorageConfigError('retention');
  if (retention.ttlMs !== undefined && (retention.ttlMs === null || typeof retention.ttlMs !== 'object' || Array.isArray(retention.ttlMs))) throw new LocalStorageConfigError('retention.ttlMs');
  const ttlMs = { ...DEFAULT_RETENTION_TTL_MS };
  for (const [key, value] of Object.entries(retention.ttlMs ?? {})) {
    if (!EXPIRING_CLASS_IDS.includes(key as ExpiringClassId)) throw new LocalStorageConfigError(`retention.ttlMs.${key}`);
    ttlMs[key as ExpiringClassId] = integer(value, `retention.ttlMs.${key}`, 0);
  }
  for (const id of ['exec-sdk', 'durable-replica', 'input-preparation'] as const) if (ttlMs[id] !== 0) throw new LocalStorageConfigError(`retention.ttlMs.${id}`);
  if (ttlMs['home-temp'] < 3_600_000) throw new LocalStorageConfigError('retention.ttlMs.home-temp');
  // Journal idempotency must outlive the cloud's maximum unacknowledged window.
  if (ttlMs['confirmed-journal'] <= 7 * 86_400_000) throw new LocalStorageConfigError('retention.ttlMs.confirmed-journal');
  const roots = input.skillPackDataDirs ?? [storeDir];
  if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new LocalStorageConfigError('skillPackDataDirs');
  const sweepIntervalMs = integer(retention.sweepIntervalMs ?? 900_000, 'retention.sweepIntervalMs');
  const pressureSweepIntervalMs = integer(retention.pressureSweepIntervalMs ?? 300_000, 'retention.pressureSweepIntervalMs');
  if (sweepIntervalMs > 2_147_483_647 || pressureSweepIntervalMs > sweepIntervalMs) throw new LocalStorageConfigError('retention.intervals');
  return Object.freeze({
    scratchRoot: validateScratchRoot(input.scratchRoot ?? defaultScratchRoot(storeDir)),
    budget: input.budget === undefined ? undefined : resolveStorageBudget(input.budget),
    skillPackDataDirs: Object.freeze([...roots]),
    sweepIntervalMs,
    pressureSweepIntervalMs,
    maxDeletionsPerPass: integer(retention.maxDeletionsPerPass ?? 256, 'retention.maxDeletionsPerPass'),
    maxPassDurationMs: integer(retention.maxPassDurationMs ?? 10_000, 'retention.maxPassDurationMs'),
    ttlMs: Object.freeze(ttlMs),
  });
}
export type ResolvedStorageConfig = ReturnType<typeof resolveStorageConfig>;

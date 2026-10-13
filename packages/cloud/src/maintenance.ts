import {
  assertCollectExpiredInput, assertCanonicalTimestamp, ByokCoreError, CollectExpiredFailure,
  type CollectExpiredResult, type CoreStores, type DeviceAssertionReplayAuthority,
  type Clock, type TenantId,
} from '@byok-sdk/core';
import { ByokCloudError } from './errors';
import type { CloudStores } from './stores/ports';

export interface RetentionPolicy {
  readonly mailboxAckedRetentionMs: bigint;
  readonly mailboxUnackedRetentionMs: bigint;
  readonly requestReceiptRetentionMs: bigint;
  readonly objectOrphanGraceMs: bigint;
}
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  mailboxAckedRetentionMs: 86_400_000n,
  mailboxUnackedRetentionMs: 7n * 86_400_000n,
  requestReceiptRetentionMs: 86_400_000n,
  objectOrphanGraceMs: 86_400_000n,
});
export const DEFAULT_MAINTENANCE_LIMIT = 500;
export const MAINTENANCE_STEPS = Object.freeze([
  'mailbox', 'receipts', 'nonces', 'pairingCodes', 'presence',
  'activity', 'approvals', 'deviceAssertionReplay', 'quota', 'objects',
] as const);
export type MaintenanceStep = typeof MAINTENANCE_STEPS[number];
export type MaintenanceStepReport =
  | ({ readonly step: MaintenanceStep; readonly status: 'ok' } & CollectExpiredResult)
  | { readonly step: MaintenanceStep; readonly status: 'failed'; readonly errorCode: string; readonly failures: number; readonly partial?: CollectExpiredResult }
  | { readonly step: 'deviceAssertionReplay'; readonly status: 'not-configured' };
export interface MaintenanceReport {
  readonly tenantId: TenantId;
  /** Caller-owned cutoff clock; never replaced by the report's execution clock. */
  readonly now: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: readonly MaintenanceStepReport[];
}
export interface MaintenanceInput {
  readonly tenant: TenantId;
  readonly now: string;
  readonly policy: RetentionPolicy;
  readonly limit?: number;
}
export function resolveRetentionPolicy(input: Partial<RetentionPolicy> = {}): RetentionPolicy {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ByokCloudError('maintenance_invalid_input', 'Retention policy must be an object.');
  }
  const policy = { ...DEFAULT_RETENTION_POLICY, ...input };
  for (const key of Object.keys(DEFAULT_RETENTION_POLICY) as (keyof RetentionPolicy)[]) {
    if (typeof policy[key] !== 'bigint' || policy[key] <= 0n || policy[key] > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ByokCloudError('maintenance_invalid_input', key + ' must be positive bigint milliseconds within the safe timestamp range.');
    }
  }
  return Object.freeze(policy);
}
function assertResult(result: CollectExpiredResult, limit: number): void {
  if (result === null || typeof result !== 'object' || !Number.isSafeInteger(result.removed) || result.removed < 0
    || !Number.isSafeInteger(result.expired) || result.expired < 0
    || result.removed + result.expired > limit
    || typeof result.releasedBytes !== 'bigint' || result.releasedBytes < 0n
    || typeof result.more !== 'boolean') {
    throw new ByokCloudError('maintenance_result_invalid', 'collectExpired returned invalid counts or exceeded its batch limit.');
  }
}
export async function runMaintenanceSteps(
  ports: { readonly core: CoreStores; readonly cloud: CloudStores; readonly clock: Clock; readonly deviceAssertionReplay?: DeviceAssertionReplayAuthority },
  input: MaintenanceInput,
): Promise<MaintenanceReport> {
  const limit = input.limit ?? DEFAULT_MAINTENANCE_LIMIT;
  const tenant = input.tenant;
  const now = input.now;
  const bounds = Object.freeze({ now, limit });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new ByokCloudError('maintenance_invalid_input', 'Maintenance limit must be from 1 to 5000.');
  try { assertCollectExpiredInput(bounds); } catch (cause) { throw new ByokCloudError('maintenance_invalid_input', 'Maintenance bounds are invalid.', { cause }); }
  // Kernel callers provide a complete policy. Only the server options permit
  // partial policy overrides at construction.
  if (input.policy === null || typeof input.policy !== 'object' || Array.isArray(input.policy) || Object.keys(DEFAULT_RETENTION_POLICY).some(key => !(key in input.policy))) {
    throw new ByokCloudError('maintenance_invalid_input', 'runMaintenance requires a complete retention policy.');
  }
  const policy = resolveRetentionPolicy(input.policy);
  const cutoff = (ms: bigint): string => {
    const value = new Date(Date.parse(now) - Number(ms));
    if (!Number.isFinite(value.getTime())) throw new ByokCloudError('maintenance_invalid_input', 'Retention cutoff is outside the timestamp range.');
    const timestamp = value.toISOString();
    try { assertCanonicalTimestamp(timestamp, 'retentionCutoff'); } catch (cause) { throw new ByokCloudError('maintenance_invalid_input', 'Retention cutoff must stay in the canonical timestamp range.', { cause }); }
    return timestamp;
  };
  const ackedBefore = cutoff(policy.mailboxAckedRetentionMs);
  const expireUnackedBefore = cutoff(policy.mailboxUnackedRetentionMs);
  const requestBefore = cutoff(policy.requestReceiptRetentionMs);
  const orphanBefore = cutoff(policy.objectOrphanGraceMs);
  const startedAt = ports.clock.now().toISOString();
  const operations: Record<Exclude<MaintenanceStep, 'deviceAssertionReplay'>, () => Promise<CollectExpiredResult>> = {
    mailbox: () => ports.core.mailbox.collectExpired(tenant, { ...bounds, ackedBefore, expireUnackedBefore }),
    receipts: () => ports.cloud.receipts.collectExpired(tenant, { ...bounds, requestBefore }),
    nonces: () => ports.cloud.nonces.collectExpired(tenant, bounds),
    pairingCodes: () => ports.cloud.pairingCodes.collectExpired(tenant, bounds),
    presence: () => ports.core.presence.collectExpired(tenant, bounds),
    activity: () => ports.cloud.activity.collectExpired(tenant, bounds),
    approvals: () => ports.cloud.approvals.collectExpired(tenant, bounds),
    quota: () => ports.core.quota.collectExpired(tenant, { ...bounds, settledBefore: orphanBefore }),
    objects: () => ports.core.objects.collectExpired(tenant, { ...bounds, orphanBefore }),
  };
  const steps: MaintenanceStepReport[] = [];
  for (const step of MAINTENANCE_STEPS) {
    if (step === 'deviceAssertionReplay' && ports.deviceAssertionReplay === undefined) {
      steps.push({ step, status: 'not-configured' });
      continue;
    }
    try {
      const result = step === 'deviceAssertionReplay'
        ? await ports.deviceAssertionReplay!.collectExpired(tenant, bounds)
        : await operations[step]();
      assertResult(result, limit);
      steps.push({ step, status: 'ok', ...result });
    } catch (error) {
      const errorCode = error instanceof ByokCoreError || error instanceof ByokCloudError
        ? error.code : 'maintenance_step_failed';
      if (error instanceof CollectExpiredFailure) {
        try {
          assertResult(error.partial, limit);
          if (!Number.isSafeInteger(error.failures) || error.failures < 1 || error.failures + error.partial.removed + error.partial.expired > limit) throw new ByokCloudError('maintenance_result_invalid', 'Partial failure exceeds its distinct-row budget.');
          steps.push({ step, status: 'failed', errorCode, failures: error.failures, partial: error.partial });
        } catch {
          steps.push({ step, status: 'failed', errorCode: 'maintenance_result_invalid', failures: 1 });
        }
      } else steps.push({ step, status: 'failed', errorCode, failures: 1 });
    }
  }
  return { tenantId: tenant, now, startedAt, finishedAt: ports.clock.now().toISOString(), steps };
}

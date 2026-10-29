import {
  assertCollectExpiredInput, assertCanonicalTimestamp, ByokCoreError, CollectExpiredFailure,
  type CollectExpiredCounts, type CollectExpiredInput, type CollectExpiredResult, type CoreStores, type DeviceAssertionReplayAuthority,
  type Clock, type TenantId,
} from '@byok-sdk/core';
import { MAX_DEVICE_PROOF_CLOCK_SKEW_MS } from './auth/device-proof';
import { ByokCloudError } from './errors';
import type { CloudStores } from './stores/ports';

export interface RetentionPolicy {
  readonly mailboxAckedRetentionMs: bigint;
  readonly mailboxUnackedRetentionMs: bigint;
  /**
   * How long a dead letter stays queryable after it expired. The reap cutoff is
   * `now - mailboxUnackedRetentionMs - mailboxDeadLetterRetentionMs` on
   * `appended_at`; each device's highest-seq dead letter is kept regardless,
   * as the `recoverableFrom` floor.
   */
  readonly mailboxDeadLetterRetentionMs: bigint;
  readonly requestReceiptRetentionMs: bigint;
  readonly objectOrphanGraceMs: bigint;
}
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  mailboxAckedRetentionMs: 86_400_000n,
  mailboxUnackedRetentionMs: 7n * 86_400_000n,
  mailboxDeadLetterRetentionMs: 30n * 86_400_000n,
  requestReceiptRetentionMs: 86_400_000n,
  objectOrphanGraceMs: 86_400_000n,
});
export const DEFAULT_MAINTENANCE_LIMIT = 500;
export const MAINTENANCE_STEPS = Object.freeze([
  'mailbox', 'receipts', 'nonces', 'pairingCodes', 'presence',
  'activity', 'approvals', 'agentMessageDraft', 'deviceAssertionReplay', 'quota', 'objects', 'proofReceipts',
] as const);
/** Receipts of used device-proof request ids recorded before `recordedBefore` are removed. */
export interface ProofReceiptCollectExpiredInput extends CollectExpiredInput {
  readonly recordedBefore: string;
}
/** The one owner of a deployment's used device-proof request ids (`proof_request_receipt`). */
export interface ProofReceiptRetentionAuthority {
  collectExpired(tenant: TenantId, input: ProofReceiptCollectExpiredInput): Promise<CollectExpiredResult>;
}
export interface ProofReceiptRetentionOptions {
  readonly authority: ProofReceiptRetentionAuthority;
  /** How long a used `requestId` stays single-use. Default 24 hours; at least {@link PROOF_RECEIPT_RETENTION_FLOOR_MS}. */
  readonly proofReceiptRetentionMs?: bigint;
}
/**
 * A receipt recorded at R binds a proof issued no later than R + skew, which
 * authenticates no later than R + 2 x skew at the largest allowed skew. Five
 * more minutes cover clock differences between Host nodes. After that, a
 * replay of the same proof gets 401 before any receipt is read.
 */
export const PROOF_RECEIPT_RETENTION_FLOOR_MS = BigInt(2 * MAX_DEVICE_PROOF_CLOCK_SKEW_MS + 5 * 60_000);
export const DEFAULT_PROOF_RECEIPT_RETENTION_MS = 86_400_000n;
export interface ResolvedProofReceiptRetention {
  readonly authority: ProofReceiptRetentionAuthority;
  readonly proofReceiptRetentionMs: bigint;
}
export function resolveProofReceiptRetention(input: ProofReceiptRetentionOptions): ResolvedProofReceiptRetention {
  if (input === null || typeof input !== 'object' || typeof input.authority?.collectExpired !== 'function') {
    throw new ByokCloudError('maintenance_invalid_input', 'proofReceiptRetention needs an authority with collectExpired.');
  }
  const proofReceiptRetentionMs = input.proofReceiptRetentionMs ?? DEFAULT_PROOF_RECEIPT_RETENTION_MS;
  if (typeof proofReceiptRetentionMs !== 'bigint' || proofReceiptRetentionMs < PROOF_RECEIPT_RETENTION_FLOOR_MS
    || proofReceiptRetentionMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ByokCloudError('maintenance_invalid_input', `proofReceiptRetentionMs must be bigint milliseconds of at least ${PROOF_RECEIPT_RETENTION_FLOOR_MS}.`);
  }
  return Object.freeze({ authority: input.authority, proofReceiptRetentionMs });
}
export type MaintenanceStep = typeof MAINTENANCE_STEPS[number];
export type MaintenanceStepReport =
  | ({ readonly step: MaintenanceStep; readonly status: 'ok' } & CollectExpiredResult)
  | {
      readonly step: MaintenanceStep;
      readonly status: 'failed';
      readonly errorCode: string;
      readonly failedRows: number;
      /** Confirmed commits only; absent when the port could not report them. */
      readonly committed?: CollectExpiredCounts;
      /** Absent when a failed remainder probe left this unknown. */
      readonly more?: boolean;
    }
  | { readonly step: 'deviceAssertionReplay' | 'proofReceipts'; readonly status: 'not-configured' }
  | { readonly step: 'agentMessageDraft'; readonly status: 'ok' };
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
function assertCounts(result: CollectExpiredCounts, limit: number): void {
  if (result === null || typeof result !== 'object' || !Number.isSafeInteger(result.removed) || result.removed < 0
    || !Number.isSafeInteger(result.expired) || result.expired < 0
    || result.removed + result.expired > limit
    || typeof result.releasedBytes !== 'bigint' || result.releasedBytes < 0n) {
    throw new ByokCloudError('maintenance_result_invalid', 'collectExpired returned invalid counts or exceeded its batch limit.');
  }
}
function assertResult(result: CollectExpiredResult, limit: number): void {
  assertCounts(result, limit);
  if (typeof result.more !== 'boolean') {
    throw new ByokCloudError('maintenance_result_invalid', 'collectExpired must report whether eligible rows remain.');
  }
}
export async function runMaintenanceSteps(
  ports: {
    readonly core: CoreStores; readonly cloud: CloudStores; readonly clock: Clock;
    readonly deviceAssertionReplay?: DeviceAssertionReplayAuthority;
    readonly proofReceiptRetention?: ResolvedProofReceiptRetention;
  },
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
  const reapDeadLettersBefore = cutoff(policy.mailboxUnackedRetentionMs + policy.mailboxDeadLetterRetentionMs);
  const requestBefore = cutoff(policy.requestReceiptRetentionMs);
  const orphanBefore = cutoff(policy.objectOrphanGraceMs);
  const proofReceipts = ports.proofReceiptRetention;
  const recordedBefore = proofReceipts === undefined ? undefined : cutoff(proofReceipts.proofReceiptRetentionMs);
  const startedAt = ports.clock.now().toISOString();
  const operations: Record<Exclude<MaintenanceStep, 'deviceAssertionReplay' | 'agentMessageDraft' | 'proofReceipts'>, () => Promise<CollectExpiredResult>> = {
    mailbox: () => ports.core.mailbox.collectExpired(tenant, { ...bounds, ackedBefore, expireUnackedBefore, reapDeadLettersBefore }),
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
    if ((step === 'deviceAssertionReplay' && ports.deviceAssertionReplay === undefined)
      || (step === 'proofReceipts' && proofReceipts === undefined)) {
      steps.push({ step, status: 'not-configured' });
      continue;
    }
    try {
      if (step === 'agentMessageDraft') {
        await ports.cloud.agentMessageDraft.sweepExpired(now);
        steps.push({ step, status: 'ok' });
        continue;
      }
      const result = step === 'deviceAssertionReplay'
        ? await ports.deviceAssertionReplay!.collectExpired(tenant, bounds)
        : step === 'proofReceipts'
          ? await proofReceipts!.authority.collectExpired(tenant, { ...bounds, recordedBefore: recordedBefore! })
          : await operations[step]();
      assertResult(result, limit);
      steps.push({ step, status: 'ok', ...result });
    } catch (error) {
      const errorCode = error instanceof ByokCoreError || error instanceof ByokCloudError
        ? error.code : 'maintenance_step_failed';
      if (error instanceof CollectExpiredFailure) {
        try {
          assertCounts(error.committed, limit);
          if (!Number.isSafeInteger(error.failedRows) || error.failedRows < 0
            || error.failedRows + error.committed.removed + error.committed.expired > limit
            || (error.more !== undefined && typeof error.more !== 'boolean')) {
            throw new ByokCloudError('maintenance_result_invalid', 'Partial failure exceeds its distinct-row budget.');
          }
          steps.push({ step, status: 'failed', errorCode, failedRows: error.failedRows,
            committed: { ...error.committed }, ...(error.more === undefined ? {} : { more: error.more }) });
        } catch {
          steps.push({ step, status: 'failed', errorCode: 'maintenance_result_invalid', failedRows: 0 });
        }
      } else steps.push({ step, status: 'failed', errorCode, failedRows: 0 });
    }
  }
  return { tenantId: tenant, now, startedAt, finishedAt: ports.clock.now().toISOString(), steps };
}

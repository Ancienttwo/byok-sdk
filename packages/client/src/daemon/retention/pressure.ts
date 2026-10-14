import type { StorageBudget } from './config';

export type StoragePressureState = 'normal' | 'pressure' | 'hard-pressure' | 'emergency';
export class LocalStorageEmergencyError extends Error {
  constructor(reason: string) { super(`local storage emergency: ${reason}`); this.name = 'LocalStorageEmergencyError'; }
}
export function computePressureState(budget: StorageBudget, usedBytes: number, freeBytes: number, latchedFailure?: string): StoragePressureState {
  if (latchedFailure !== undefined || freeBytes < budget.ackCriticalReserveBytes) return 'emergency';
  if (usedBytes >= budget.maxStoreBytes * budget.hardBudgetRatio || freeBytes < budget.minFreeBytes) return 'hard-pressure';
  if (usedBytes >= budget.maxStoreBytes * budget.softBudgetRatio || freeBytes < budget.softMinFreeBytes) return 'pressure';
  return 'normal';
}
export class StoragePressure {
  state: StoragePressureState = 'normal';
  private failure?: string;
  constructor(readonly budget?: StorageBudget) {}
  update(usedBytes: number, freeBytes: number): void {
    if (this.budget === undefined) return;
    if (computePressureState(this.budget, usedBytes, freeBytes) === 'normal') this.failure = undefined;
    this.state = computePressureState(this.budget, usedBytes, freeBytes, this.failure);
  }
  noteAckCriticalFailure(reason: string): void { this.failure = reason; this.state = 'emergency'; }
  admissionGuard() {
    return this.state === 'normal' || this.state === 'pressure'
      ? { admit: true as const }
      : { admit: false as const, reason: `local storage ${this.state}`, retryable: true };
  }
  assertAckCriticalAllowed(): void {
    if (this.state === 'emergency') throw new LocalStorageEmergencyError(this.failure ?? 'free space is below the ack-critical reserve');
  }
}

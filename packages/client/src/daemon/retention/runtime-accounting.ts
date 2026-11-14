import type { SweepBudget } from './registry.js';
/** Internal retention limits, like the accounting below; tests inject smaller ones to reach the same branches. */
export interface RetentionLimits {
  /** Entries one sweep pass may inspect across every class. */
  readonly passInspections: number;
  /** Entries a whole-tree measurement or removal visits before it refuses. */
  readonly treeScanEntries: number;
  /** Inspection share of one pass for each class with resumable directory cleanup. */
  readonly shares: Readonly<Record<'exec-runtime' | 'exec-sdk' | 'daemon-temp' | 'reader-run', number>>;
  /** Wall-clock window one idle Agent home gets for deletion in a pass. */
  readonly homeDeletionWindowMs: number;
}
export const RETENTION_LIMITS: RetentionLimits = Object.freeze({ passInspections: 8192, treeScanEntries: 16_384,
  shares: Object.freeze({ 'exec-runtime': 4096, 'exec-sdk': 1024, 'daemon-temp': 1024, 'reader-run': 1024 }), homeDeletionWindowMs: 250 });
/** The pass limit a registry was built with, kept off the public sweeper options; one injection sets both. */
export const registryPassInspections = new WeakMap<object, number>();
/** Partial leaf reclamation is private pass state, not a public SweepBudget capability. */
export const runtimeReclaimedBytes = new WeakMap<object, number>();

const parentBudgets = new WeakMap<SweepBudget, SweepBudget>();
export function classBudget(id: string, budget: SweepBudget, shares: RetentionLimits['shares']): SweepBudget {
  const limit = (shares as Readonly<Record<string, number>>)[id];
  if (limit === undefined) return budget;
  let used = 0;
  const bounded = { ...budget, available: () => {
    if (used >= limit) { budget.truncate(); return false; }
    used++; return budget.available();
  } };
  parentBudgets.set(bounded, budget);
  return bounded;
}
export function accountLeaves(budget: SweepBudget, bytes: number): void {
  const owner = parentBudgets.get(budget) ?? budget;
  runtimeReclaimedBytes.set(owner, (runtimeReclaimedBytes.get(owner) ?? 0) + bytes);
}

/** Complete authority reads use the pass limit, not a resumable deletion share. */
export function authorityBudget(budget: SweepBudget): SweepBudget {
  return parentBudgets.get(budget) ?? budget;
}

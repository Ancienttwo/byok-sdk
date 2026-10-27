/** Entries one sweep pass may inspect across every class; internal, like the accounting below. */
export const PASS_INSPECTIONS = 8192;
/** Partial leaf reclamation is private pass state, not a public SweepBudget capability. */
export const runtimeReclaimedBytes = new WeakMap<object, number>();

const parentBudgets = new WeakMap<object, object>();
const shares: Readonly<Record<string, number>> = { 'exec-runtime': 4096, 'exec-sdk': 1024, 'daemon-temp': 1024, 'reader-run': 1024 };
export function classBudget(id: string, budget: import('./registry').SweepBudget): import('./registry').SweepBudget {
  const limit = shares[id];
  if (limit === undefined) return budget;
  let used = 0;
  const bounded = { ...budget, available: () => {
    if (used >= limit) { budget.truncate(); return false; }
    used++; return budget.available();
  } };
  parentBudgets.set(bounded, budget);
  return bounded;
}
export function accountLeaves(budget: object, bytes: number): void {
  const owner = parentBudgets.get(budget) ?? budget;
  runtimeReclaimedBytes.set(owner, (runtimeReclaimedBytes.get(owner) ?? 0) + bytes);
}

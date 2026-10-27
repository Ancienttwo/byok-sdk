/** Entries one sweep pass may inspect across every class; internal, like the accounting below. */
export const PASS_INSPECTIONS = 8192;
/** Partial leaf reclamation is private pass state, not a public SweepBudget capability. */
export const runtimeReclaimedBytes = new WeakMap<object, number>();

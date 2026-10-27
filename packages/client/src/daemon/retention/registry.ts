export const EXPIRING_CLASS_IDS = [
  'exec-sdk', 'daemon-temp', 'exec-runtime', 'durable-replica', 'input-preparation',
  'confirmed-journal', 'reader-run', 'agent-result', 'home-temp', 'skill-pack-old',
] as const;
export const PROTECTED_CLASS_IDS = [
  'journal', 'quarantine', 'owned-processes', 'durable-replica-live', 'terminal-evidence',
  'agent-content', 'byok-authority', 'agent-home-lease', 'workspace', 'retired-namespace',
  'pi-session-dir', 'skill-pack-current', 'store-authority',
] as const;
export type ExpiringClassId = typeof EXPIRING_CLASS_IDS[number];
export type ProtectedClassId = typeof PROTECTED_CLASS_IDS[number];
export type RetentionClassId = ExpiringClassId | ProtectedClassId;
export type RetentionTrigger = 'startup' | 'periodic' | 'pressure' | 'home-lease';

export interface ClassUsage {
  readonly classId: RetentionClassId;
  readonly protected: boolean;
  readonly measured: boolean;
  /** The usage walk hit its entry limit before covering this class: `bytes` and `entries` are lower bounds. */
  readonly truncated: boolean;
  readonly bytes: number;
  readonly entries: number;
  readonly oldestAgeMs: number | null;
}
export interface SweepReport {
  readonly trigger: RetentionTrigger;
  readonly at: string;
  readonly deleted: number;
  readonly bytesReclaimed: number;
  readonly failures: number;
  readonly truncated: boolean;
  readonly durationMs: number;
}
export interface SweepBudget {
  readonly now: Date;
  readonly trigger: RetentionTrigger;
  available(): boolean;
  remaining(): number;
  removed(bytes: number): void;
  /** Account partial runtime reclamation without counting an incomplete token as deleted. */
  reclaimed(bytes: number): void;
  truncate(): void;
}
export interface ClassAuthority {
  readonly roots: readonly string[];
  readonly owner: 'sdk' | 'host';
  readonly scope: 'store' | 'agent-home' | 'replica' | 'host';
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}
export type RetentionClass = { readonly authority: ClassAuthority } & (
  | { readonly id: ExpiringClassId; measure(): Promise<ClassUsage>; sweep(budget: SweepBudget): Promise<void> }
  | { readonly id: ProtectedClassId; measure(): Promise<ClassUsage>; readonly sweep?: never });

/** One closed registry serves maintenance, pressure measurement and status. */
export class RetentionRegistry {
  readonly classes: readonly RetentionClass[];
  constructor(classes: readonly RetentionClass[], private readonly dispose: () => Promise<void> = async () => {}, private readonly beforeMeasure: () => void = () => {}, private readonly prepareMaintenance: (budget: SweepBudget, underPressure: boolean) => Promise<void> = async () => {}) {
    const ids = classes.map(entry => entry.id);
    const expected = [...EXPIRING_CLASS_IDS, ...PROTECTED_CLASS_IDS];
    if (new Set(ids).size !== ids.length || expected.some(id => !ids.includes(id)) || ids.length !== expected.length) {
      throw new Error('retention registry must contain every closed class exactly once');
    }
    if (classes.some(entry => PROTECTED_CLASS_IDS.includes(entry.id as ProtectedClassId) && entry.sweep !== undefined)) throw new Error('protected retention class has deletion authority');
    this.classes = Object.freeze([...classes]);
  }
  prepare(budget: SweepBudget, underPressure: boolean): Promise<void> { return this.prepareMaintenance(budget, underPressure); }
  close(): Promise<void> { return this.dispose(); }
  sweep(id: ExpiringClassId, budget: SweepBudget): Promise<void> {
    if (!EXPIRING_CLASS_IDS.includes(id)) throw new Error('protected retention class cannot be swept');
    const entry = this.classes.find(entry => entry.id === id);
    if (entry === undefined || entry.sweep === undefined) throw new Error('retention class has no deletion authority');
    return entry.sweep(budget);
  }
  measure(): Promise<ClassUsage[]> { this.beforeMeasure(); return Promise.all(this.classes.map(entry => entry.measure())); }
}

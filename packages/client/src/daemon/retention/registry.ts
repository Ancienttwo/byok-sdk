export const EXPIRING_CLASS_IDS = [
  'exec-sdk', 'daemon-temp', 'exec-runtime', 'durable-replica', 'input-preparation',
  'confirmed-journal', 'reader-run', 'agent-result', 'home-temp', 'skill-pack-old', 'session-ledger',
  'terminal-evidence', 'pi-session-dir',
] as const;
export const PROTECTED_CLASS_IDS = [
  'journal', 'quarantine', 'owned-processes', 'durable-replica-live',
  'agent-content', 'byok-authority', 'agent-home-lease',
  'skill-pack-current', 'store-authority', 'runtime-session-external',
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
  truncate(): void;
}
/**
 * How a class stays finite. An expiring class is deleted by TTL, optionally also by count. A protected
 * class either has a fixed count, or states why it cannot be bounded, who clears it and through which API.
 */
export type RetentionBound =
  | { readonly kind: 'ttl'; readonly ttlMs: number; readonly maxEntries?: number }
  | { readonly kind: 'count'; readonly maxEntries: number; readonly per: 'agent-home' | 'skill-pack' }
  | { readonly kind: 'exempt'; readonly reason: string; readonly cleanedBy: 'sdk' | 'host' | 'operator'; readonly api: string };
export type ProtectedRetentionBound = Exclude<RetentionBound, { readonly kind: 'ttl' }>;
/** The declared bound of every protected class; a new class does not compile without one. */
export const PROTECTED_CLASS_BOUNDS: Readonly<Record<ProtectedClassId, ProtectedRetentionBound>> = Object.freeze({
  'journal': { kind: 'exempt', cleanedBy: 'sdk', reason: 'Unconfirmed rows hold the ack and recovery state of live tasks; confirmed rows expire as confirmed-journal and maintenance compacts the file.', api: "storage.retention.ttlMs['confirmed-journal']" },
  'quarantine': { kind: 'exempt', cleanedBy: 'operator', reason: 'The only evidence of a corrupt journal or operational-health file; one entry per corruption event, not per task, and the daemon stops at each journal corruption.', api: 'byok-agent doctor reports each entry; the operator deletes <storeDir>/quarantine/<entry> after inspection' },
  'owned-processes': { kind: 'exempt', cleanedBy: 'operator', reason: 'One record per live runtime process, removed when it exits; only crash residue the SDK could not end remains.', api: "operator action 'owned-process-residue'" },
  'durable-replica-live': { kind: 'exempt', cleanedBy: 'sdk', reason: 'One replica per non-terminal durable Pi task; a terminal task\'s replica becomes durable-replica and expires.', api: "storage.retention.ttlMs['durable-replica']" },
  'agent-content': { kind: 'exempt', cleanedBy: 'host', reason: 'Host-owned Agent files and memory: their content and lifetime are product data.', api: 'the Host deletes Agent files or the whole Agent home' },
  'byok-authority': { kind: 'exempt', cleanedBy: 'host', reason: 'A fixed set of SDK records per Agent home whose logs keep bounded tails; it grows with Agent count, not task count.', api: 'removed with the Agent home' },
  'agent-home-lease': { kind: 'count', maxEntries: 1, per: 'agent-home' },
  'skill-pack-current': { kind: 'count', maxEntries: 1, per: 'skill-pack' },
  'store-authority': { kind: 'exempt', cleanedBy: 'sdk', reason: 'Fixed device records (identity, owner, locks, sockets) and self-bounded logs such as audit.jsonl, which rewrites itself past 10 MiB; none grows with task count.', api: 'removed with the store directory' },
  'runtime-session-external': { kind: 'exempt', cleanedBy: 'host', reason: 'Claude, Codex, Grok and Pi-login session records under the runtime\'s own config directory, mixed with the user\'s sessions; their paths follow each runtime and the SDK never deletes them.', api: "ClaudeAdapterOptions.agentSessionPersistence: 'disabled' for Claude; the runtime's own session management otherwise" },
});
export interface ClassAuthority {
  readonly roots: readonly string[];
  readonly owner: 'sdk' | 'host';
  readonly scope: 'store' | 'agent-home' | 'replica' | 'host';
  readonly bound: RetentionBound;
}
export type RetentionClass = { readonly authority: ClassAuthority } & (
  | { readonly id: ExpiringClassId; measure(): Promise<ClassUsage>; sweep(budget: SweepBudget): Promise<void> }
  | { readonly id: ProtectedClassId; measure(): Promise<ClassUsage>; readonly sweep?: never });

function declaresBound(entry: RetentionClass): boolean {
  const bound = entry.authority.bound as RetentionBound | undefined;
  if (bound === undefined) return false;
  if (EXPIRING_CLASS_IDS.includes(entry.id as ExpiringClassId)) {
    return bound.kind === 'ttl' && Number.isSafeInteger(bound.ttlMs) && bound.ttlMs >= 0
      && (bound.maxEntries === undefined || (Number.isSafeInteger(bound.maxEntries) && bound.maxEntries > 0));
  }
  if (bound.kind === 'count') return Number.isSafeInteger(bound.maxEntries) && bound.maxEntries > 0;
  return bound.kind === 'exempt' && bound.reason.trim() !== '' && bound.api.trim() !== '';
}

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
    for (const entry of classes) if (!declaresBound(entry)) throw new Error(`retention class ${entry.id} does not declare its bound`);
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

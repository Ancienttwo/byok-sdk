import type { TeamMemberLease } from '../daemon/team-workspace';
import type { TeamNotificationSnapshot } from './team-codex-relay';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const seq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export interface TeamRelayBinding { readonly context: string; readonly lease: TeamMemberLease; readonly afterSeq: number; }
export type TeamRelayState = 'running' | 'paused' | 'stopped' | 'budget_exhausted' | 'failed';
export class TeamNotificationRelay<T extends TeamRelayBinding> {
  private state: TeamRelayState = 'running';
  private attempts = 0;
  private error: 'snapshot_failed' | 'queue_delivery_unknown' | undefined;
  private readonly watermarks: number[];
  private pending: Promise<void> | undefined;
  private readonly abort = new AbortController();
  constructor(private readonly options: {
    bindings: readonly T[]; maxNotifications: number;
    snapshot: (binding: T, afterSeq: number) => Promise<unknown>;
    describe: (binding: T) => Record<string, string>;
    ready?: (binding: T) => Promise<boolean>;
    enqueue: (binding: T, throughSeq: number, signal: AbortSignal) => Promise<string>;
  }) {
    if (!Number.isInteger(options.maxNotifications) || options.maxNotifications < 1 || options.maxNotifications > 100) throw new Error('max-notifications must be an integer from 1 to 100');
    if (options.bindings.length !== 2) throw new Error('relay requires exactly two bindings');
    this.watermarks = options.bindings.map(binding => binding.afterSeq);
  }
  status() {
    return { state: this.state, attempts: this.attempts, maxNotifications: this.options.maxNotifications,
      ...(this.error ? { error: this.error } : {}), bindings: this.options.bindings.map((binding, i) => ({
        workspaceId: binding.lease.workspaceId, memberId: binding.lease.memberId,
        ...this.options.describe(binding), notifiedThroughSeq: this.watermarks[i],
      })) };
  }
  pause(): void { if (this.state === 'running') this.state = 'paused'; }
  resume(): void { if (this.state === 'paused') this.state = 'running'; }
  stop(): void { this.state = 'stopped'; this.abort.abort(); }
  tick(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.performTick().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async performTick(): Promise<void> {
    if (this.state !== 'running') return;
    let phase: 'snapshot_failed' | 'queue_delivery_unknown' = 'snapshot_failed';
    try {
      // Validate both grants before queuing anything, including at startup.
      const snapshots = await Promise.all(this.options.bindings.map(async (binding, i) => {
        const v = await this.options.snapshot(binding, this.watermarks[i]!);
        if (!record(v) || !exact(v, ['workspaceId', 'memberId', 'registryRevision', 'expiresAt', 'acknowledgedThroughSeq', 'latestPeerSeq']) ||
          v.workspaceId !== binding.lease.workspaceId || v.memberId !== binding.lease.memberId || v.registryRevision !== binding.lease.registryRevision ||
          v.expiresAt !== binding.lease.expiresAt || Date.parse(binding.lease.expiresAt) <= Date.now() ||
          !seq(v.acknowledgedThroughSeq) || (v.latestPeerSeq !== null && (!seq(v.latestPeerSeq) || v.latestPeerSeq <= Math.max(this.watermarks[i]!, v.acknowledgedThroughSeq)))) throw new Error('invalid or expired notification snapshot');
        return v as unknown as TeamNotificationSnapshot;
      }));
      for (const [i, snapshot] of snapshots.entries()) {
        if (this.state !== 'running') break;
        if (snapshot.latestPeerSeq === null) continue;
        if (this.attempts >= this.options.maxNotifications) { this.state = 'budget_exhausted'; break; }
        if (this.options.ready && !(await this.options.ready(this.options.bindings[i]!))) continue;
        if (this.state !== 'running') break;
        phase = 'queue_delivery_unknown';
        this.attempts += 1;
        const receipt = await this.options.enqueue(this.options.bindings[i]!, snapshot.latestPeerSeq, this.abort.signal);
        if (!UUID.test(receipt)) throw new Error('invalid queue receipt');
        this.watermarks[i] = snapshot.latestPeerSeq;
        if (this.attempts === this.options.maxNotifications && !this.abort.signal.aborted) this.state = 'budget_exhausted';
      }
    } catch {
      this.error = phase;
      if (!this.abort.signal.aborted) this.state = 'failed';
    }
  }
}

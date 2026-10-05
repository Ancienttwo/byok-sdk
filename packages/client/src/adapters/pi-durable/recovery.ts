export const DURABLE_MAX_RESPAWNS = 2;
import type { DurableLifecycle } from '../../types';
/** Parent authority: replica claims can never grant recovery or clear unsafe work. */
export class DurableRecovery {
  private readonly inflight = new Set<string>();
  private respawns = 0;
  private terminal = false;
  constructor(private readonly lifecycle: DurableLifecycle) {}
  async beforeTool(id: string): Promise<void> {
    if (this.terminal || !this.lifecycle.ownsLease() || !id || this.inflight.has(id)) throw new Error('durable tool intent refused');
    // Set first: a journal failure or child exit during this await remains unsafe.
    this.inflight.add(id);
    await this.lifecycle.record('tool-intent', this.respawns);
    if (this.terminal || !this.lifecycle.ownsLease()) throw new Error('durable lease ended before tool acknowledgement');
  }
  async committedTool(id: string): Promise<void> {
    if (!this.inflight.has(id)) throw new Error('durable result has no parent tool intent');
    await this.lifecycle.record('tool-committed', this.respawns);
    this.inflight.delete(id);
  }
  async crash(): Promise<number> {
    if (this.terminal || !this.lifecycle.ownsLease() || this.inflight.size || this.respawns >= DURABLE_MAX_RESPAWNS) {
      this.terminal = true;
      throw new Error('durable child recovery refused');
    }
    const next = this.respawns + 1;
    await this.lifecycle.record('respawn-intent', next);
    if (this.terminal || !this.lifecycle.ownsLease()) throw new Error('durable lease ended before respawn');
    this.respawns = next;
    return next;
  }
  stop(): void { this.terminal = true; }
}

import type { AbortedStart } from './runtime-start';
import { isRuntimeDisposalFailure, RuntimeDisposalFailure } from '../runtime-failure';

/** Resources owned by startup until synchronous transfer to an active task. */
export interface StartupOwner {
  runtimeId: string;
  dispose: () => Promise<void>;
  settle?: () => Promise<void>;
  release: () => Promise<void>;
  abortedStart?: AbortedStart;
}

interface StartupOwnershipDeps {
  isOfferInFlight(taskId: string): boolean;
  allowRetry(): boolean;
  awaitTerminalCommit(taskId: string): Promise<void> | undefined;
  onDisposed(taskId: string): void;
  onDisposalFailure(taskId: string, runtimeId: string, failure: RuntimeDisposalFailure): void;
}

/** One owner map, one disposal attempt per task, and one retry timer. */
export class StartupOwnership {
  private readonly owners = new Map<string, StartupOwner>();
  private readonly disposals = new Map<string, Promise<boolean>>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: StartupOwnershipDeps) {}

  get count(): number { return this.owners.size; }

  has(taskId: string): boolean { return this.owners.has(taskId); }

  register(taskId: string, owner: StartupOwner): void { this.owners.set(taskId, owner); }

  /** The caller registers the active task on the same synchronous path. */
  transferToActive(taskId: string): void { this.owners.delete(taskId); }

  stopRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  dispose(taskId: string): Promise<boolean> {
    const existing = this.disposals.get(taskId);
    if (existing) return existing;
    const attempt = this.disposeOnce(taskId).finally(() => this.disposals.delete(taskId));
    this.disposals.set(taskId, attempt);
    return attempt;
  }

  /** TaskRunner must first wait for offer settlements and active task cleanup. */
  async disposeAll(): Promise<void> {
    for (const [taskId, owner] of this.owners) {
      await owner.abortedStart?.settled;
      if (!await this.dispose(taskId)) throw new RuntimeDisposalFailure({
        stage: 'quiescence', reason: 'startup runtime ownership remains quarantined',
      });
    }
  }

  private async disposeOnce(taskId: string): Promise<boolean> {
    const owner = this.owners.get(taskId);
    if (!owner) return true;
    let disposed = false;
    try {
      await owner.settle?.();
      // A pending start has not returned its owner. A grace timeout alone
      // does not prove cleanup: dispose must still return its real receipt.
      if (!owner.abortedStart?.running()) {
        await owner.dispose();
        await this.deps.awaitTerminalCommit(taskId);
        await owner.release();
        disposed = true;
      }
    } catch (caught) {
      const failure = isRuntimeDisposalFailure(caught) ? caught : new RuntimeDisposalFailure({
        stage: 'quiescence', reason: 'startup runtime disposal has not been confirmed',
      }, { cause: caught });
      this.deps.onDisposalFailure(taskId, owner.runtimeId, failure);
      console.error(`[byok/client] startup ownership retained for ${taskId}: ${failure.message}`);
    }
    if (!disposed) {
      this.armRetry();
      return false;
    }
    if (this.owners.get(taskId) === owner) this.owners.delete(taskId);
    this.deps.onDisposed(taskId);
    return true;
  }

  private armRetry(): void {
    if (this.retryTimer || !this.deps.allowRetry()) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      for (const taskId of this.owners.keys()) {
        if (!this.deps.isOfferInFlight(taskId)) void this.dispose(taskId);
      }
    }, 1_000);
    this.retryTimer.unref?.();
  }
}

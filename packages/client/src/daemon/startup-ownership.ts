import type { AbortedStart } from './runtime-start';
import { isRuntimeDisposalFailure, RuntimeDisposalFailure } from '../runtime-failure';

const STARTUP_RETRY_DELAY_MS = 1_000;

/** The resources of one startup that has not become an active execution. */
export interface StartupOwner {
  runtimeId: string;
  dispose: () => Promise<void>;
  settle?: () => Promise<void>;
  release: () => Promise<void>;
  /** An aborted start that is still running: there is nothing to dispose yet. */
  abortedStart?: AbortedStart;
}

export interface StartupOwnershipHooks {
  /** The terminal commit barrier. The lease is released only after it. */
  awaitTerminalCommit: (taskId: string) => Promise<void> | undefined;
  onDisposalFailure: (taskId: string, runtimeId: string, failure: RuntimeDisposalFailure) => void;
  /** Runs once per confirmed disposal, after the owner is gone. */
  onDisposed: (taskId: string) => void;
  /** The retry timer disposes only owners whose offer has settled. */
  retryEligible: (taskId: string) => boolean;
}

/**
 * The one owner of startup resources between `startOwnedRuntime` and the
 * active-task handover. An unconfirmed disposal keeps the owner: a lease is
 * never released before the runtime stops and the terminal commit lands.
 */
export class StartupOwnership {
  private readonly owners = new Map<string, StartupOwner>();
  private readonly disposals = new Map<string, Promise<boolean>>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly hooks: StartupOwnershipHooks) {}

  get count(): number { return this.owners.size; }

  has(taskId: string): boolean { return this.owners.has(taskId); }

  adopt(taskId: string, owner: StartupOwner): void {
    if (this.owners.has(taskId)) throw new Error(`startup ownership invariant: ${taskId} already has an owner`);
    this.owners.set(taskId, owner);
  }

  /** Synchronous by contract: the caller registers the active task in the same block. */
  transferToActive(taskId: string): void {
    this.owners.delete(taskId);
  }

  dispose(taskId: string): Promise<boolean> {
    const existing = this.disposals.get(taskId);
    if (existing) return existing;
    const attempt = this.disposeOnce(taskId).finally(() => this.disposals.delete(taskId));
    this.disposals.set(taskId, attempt);
    return attempt;
  }

  /** Cancels the retry timer. No timer is armed after this. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** The startup part of shutdown. Throws while any owner stays unconfirmed. */
  async drain(): Promise<void> {
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
      // An aborted start that still runs has not returned its owner yet. That
      // is not a disposal failure: shutdown waits for it, and the retry below
      // finds it once it settles.
      if (!owner.abortedStart?.running()) {
        await owner.dispose();
        await this.hooks.awaitTerminalCommit(taskId);
        await owner.release();
        disposed = true;
      }
    } catch (caught) {
      const failure = isRuntimeDisposalFailure(caught) ? caught : new RuntimeDisposalFailure({
        stage: 'quiescence', reason: 'startup runtime disposal has not been confirmed',
      }, { cause: caught });
      this.hooks.onDisposalFailure(taskId, owner.runtimeId, failure);
    }
    if (!disposed) {
      this.armRetry();
      return false;
    }
    if (this.owners.get(taskId) === owner) this.owners.delete(taskId);
    this.hooks.onDisposed(taskId);
    return true;
  }

  private armRetry(): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      for (const id of this.owners.keys()) {
        if (this.hooks.retryEligible(id)) void this.dispose(id);
      }
    }, STARTUP_RETRY_DELAY_MS);
    this.retryTimer.unref?.();
  }
}

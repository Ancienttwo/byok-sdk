import type { ByokServer } from '@byok-sdk/server';
import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';
import type { Draft } from './view.ts';

export interface DraftTarget {
  readonly turnId: string;
  readonly taskId: string;
  readonly deviceId: string;
  readonly agentRef: ExecutionTemplate['payload']['agentRef'];
}

/**
 * Follows `tasks.messageDraft` for running Turns. A draft is display only: it lives in memory, a new revision replaces
 * it, and it disappears when the stream ends or the Turn is no longer followed. A stream that throws keeps its error as
 * the draft's state, so the renderer shows it instead of a silent stop.
 */
export class DraftFollowers {
  readonly #server: Pick<ByokServer, 'tasks'>;
  readonly #changed: () => void;
  readonly #drafts = new Map<string, Draft & { revision?: number }>();
  readonly #running = new Map<string, AbortController>();

  constructor(server: Pick<ByokServer, 'tasks'>, changed: () => void) {
    this.#server = server;
    this.#changed = changed;
  }

  /** Follows exactly `targets`: starts the new ones and stops every other. */
  follow(targets: readonly DraftTarget[]): void {
    const wanted = new Set(targets.map(target => target.turnId));
    for (const [turnId, abort] of this.#running) {
      if (wanted.has(turnId)) continue;
      abort.abort();
      this.#running.delete(turnId);
      this.#drafts.delete(turnId);
    }
    for (const target of targets) if (!this.#running.has(target.turnId)) this.#start(target);
  }

  drafts(): ReadonlyMap<string, Draft> {
    return new Map([...this.#drafts].map(([turnId, { text, state, error }]) => [turnId, { text, state, ...(error === undefined ? {} : { error }) }]));
  }

  close(): void {
    for (const abort of this.#running.values()) abort.abort();
    this.#running.clear();
    this.#drafts.clear();
  }

  #start(target: DraftTarget): void {
    const abort = new AbortController();
    this.#running.set(target.turnId, abort);
    const set = (draft: (Draft & { revision?: number }) | undefined) => {
      if (abort.signal.aborted) return;
      if (draft) this.#drafts.set(target.turnId, draft);
      else this.#drafts.delete(target.turnId);
      this.#changed();
    };
    void (async () => {
      try {
        for await (const event of this.#server.tasks.messageDraft(target.taskId, target.deviceId, target.agentRef, { signal: abort.signal })) {
          const prior = this.#drafts.get(target.turnId);
          if (event.kind === 'append') {
            set({ revision: event.revision, state: 'open', text: prior?.revision === event.revision ? prior.text + event.text : event.text });
          } else if (event.kind === 'overflow' || event.kind === 'gap') {
            set({ revision: event.revision, state: event.kind, text: prior?.revision === event.revision ? prior.text : '' });
          } else {
            set(undefined);
          }
        }
      } catch (error) {
        set({ state: 'failed', text: this.#drafts.get(target.turnId)?.text ?? '', error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }
}

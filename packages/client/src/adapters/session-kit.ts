import { RuntimeExecutionFailure } from '../runtime-failure';
import type { RawAcpSession } from '../runtime/acp-session-runtime';

function failure(reason: string): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure', retry: 'non-retryable', reason });
}

export class RetainedRecordBudget {
  private bytes = 0;
  constructor(private readonly maxBytes: number, private readonly runtime: string) {}
  add(record: unknown): void {
    this.bytes += Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (this.bytes > this.maxBytes) throw failure(`${this.runtime} retained record byte budget exceeded`);
  }
}

export function haltGate<T extends { onLine(handler: (line: string) => void): void }>(child: T, halted: () => boolean): T {
  return { ...child, onLine: (handler: (line: string) => void) => child.onLine((line) => {
    if (!halted()) handler(line);
  }) };
}

export class SettleWaiters {
  private readonly waiters = new Set<() => void>();
  wait(): { readonly settled: Promise<void>; release(): void } {
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    this.waiters.add(resolve);
    return { settled, release: () => { this.waiters.delete(resolve); } };
  }
  settleAll(): void { for (const resolve of this.waiters) resolve(); }
}

export async function raceDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => unknown): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function oarCancelSettled(abort: ReturnType<RawAcpSession['abort']>, settled: Promise<void>, runtime: string): Promise<void> {
  const { response: { body } } = await abort;
  // session/cancel is a notification; the cancelled prompt answer carries final usage and outcome.
  if (body.kind === 'accepted') await settled;
  // A turn that already ended is a normal race; any other refusal sent no cancel.
  else if (body.kind === 'rejected' && body.code !== 'no_active_turn') throw failure(`${runtime} interrupt refused: ${body.reason}`);
}

export class RetryableOnce {
  private attempt?: Promise<void>;
  run(work: () => Promise<void>): Promise<void> {
    if (!this.attempt) {
      this.attempt = Promise.resolve().then(work).catch((error: unknown) => {
        this.attempt = undefined;
        throw error;
      });
    }
    return this.attempt;
  }
}

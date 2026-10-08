import type { RuntimeOperationStartInput, Session } from '../types';
import { isRuntimeExecutionFailure, isRuntimeStartupDisposalFailure, RuntimeDisposalFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';

/**
 * After an abort, the adapter's start() still owns what it spawned. Codex and
 * Pi do not read the signal and settle only when their session opens. The
 * daemon waits this long after the abort for that settlement before it judges
 * the disposal.
 */
const ABORTED_START_SETTLE_GRACE_MS = 5_000;

/** An aborted start that may still be running. */
export interface AbortedStart {
  /** True until the start settles or the grace ends. */
  running(): boolean;
  /** Resolves when the start settles or the grace ends. */
  readonly settled: Promise<void>;
}

const abortedStarts = new WeakMap<object, AbortedStart>();

/** The aborted start behind an abort failure from {@link startOwnedRuntime}, if it was still running. */
export function abortedStartOf(failure: unknown): AbortedStart | undefined {
  return typeof failure === 'object' && failure !== null ? abortedStarts.get(failure) : undefined;
}

/** A deadline withdraws admission; it never invents a quiescence receipt. */
export async function startOwnedRuntime(
  start: (input: RuntimeOperationStartInput) => Promise<Session>,
  input: RuntimeOperationStartInput,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Session> {
  const controller = new AbortController();
  let session: Session | undefined;
  let failure: unknown;
  let settled = false;
  let startup: Promise<Session> | undefined;
  const retryDisposal = async (): Promise<void> => {
    if (session) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve().then(() => session!.interrupt()).catch(() => undefined),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); timer.unref?.(); })]);
      } finally { if (timer) clearTimeout(timer); }
      return session.close();
    }
    if (isRuntimeStartupDisposalFailure(failure)) return failure.retryDisposal();
    if (settled && isRuntimeExecutionFailure(failure)) return;
    throw new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'runtime startup has not returned a cleanup receipt' });
  };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (): void => {
    controller.abort();
    const failure = new RuntimeStartupDisposalFailure(retryDisposal);
    if (startup !== undefined && !settled) {
      let graceEnded = false;
      abortedStarts.set(failure, {
        running: () => !settled && !graceEnded,
        settled: settleWithin(startup, ABORTED_START_SETTLE_GRACE_MS).then(() => { graceEnded = true; }),
      });
    }
    rejectAbort(failure);
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  try {
    if (signal.aborted) {
      throw new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'runtime startup was cancelled before invocation' });
    }
    startup = Promise.resolve().then(() => start({ ...input, signal: controller.signal })).then(value => {
      session = value;
      settled = true;
      return value;
    }, error => {
      failure = error;
      settled = true;
      throw error;
    });
    return await Promise.race([startup, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** Resolves when `pending` settles or `ms` elapse, whichever is first. */
async function settleWithin(pending: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending.then(() => undefined, () => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); })]);
  } finally { if (timer) clearTimeout(timer); }
}

import type { RuntimeOperationStartInput, Session } from '../types';
import { isRuntimeExecutionFailure, isRuntimeStartupDisposalFailure, RuntimeDisposalFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';

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
    rejectAbort(new RuntimeStartupDisposalFailure(retryDisposal));
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  try {
    if (signal.aborted) {
      throw new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'runtime startup was cancelled before invocation' });
    }
    const startup = Promise.resolve().then(() => start({ ...input, signal: controller.signal })).then(value => {
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

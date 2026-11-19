import { validateHeaderValue } from 'node:http';
import { RuntimeExecutionFailure } from '../runtime-failure.js';

function resolutionFailed(runtime: 'dsh' | 'agy'): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure({
    phase: 'start', retry: 'non-retryable', failure: { class: 'auth' },
    reason: `${runtime} provider API key resolution failed`,
  });
}

/** Resolve one spawn's credential. Host exceptions and cancellation reasons can contain secrets. */
export async function resolveRuntimeApiKey(runtime: 'dsh' | 'agy', resolveKey: () => Promise<string>, signal?: AbortSignal): Promise<string> {
  const cancelled = () => new Error(`${runtime} start was cancelled`);
  if (signal?.aborted) throw cancelled();
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(cancelled());
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const key = await Promise.race([stopped.promise, Promise.resolve().then(() => {
      if (signal?.aborted) throw cancelled();
      return resolveKey();
    })]);
    if (signal?.aborted) throw cancelled();
    if (typeof key !== 'string' || key.trim() === '' || /[\0\r\n]/u.test(key)) throw new TypeError('invalid runtime credential');
    if (runtime === 'agy') validateHeaderValue('x-goog-api-key', key);
    return key;
  } catch {
    if (signal?.aborted) throw cancelled();
    throw resolutionFailed(runtime);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

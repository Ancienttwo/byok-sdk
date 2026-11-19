import { validateHeaderValue } from 'node:http';
import { RuntimeExecutionFailure } from '../runtime-failure.js';

type RuntimeWithHostCredential = 'claude' | 'dsh' | 'agy';
type RuntimeKeySource = RuntimeWithHostCredential | `Claude ${'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'}`;
const MIN_RUNTIME_KEY_LENGTH = 20;

export function requireRuntimeApiKey(key: unknown, source: RuntimeKeySource): string {
  if (typeof key !== 'string' || key.length < MIN_RUNTIME_KEY_LENGTH || key.trim() === '' || /[\0\r\n]/u.test(key)) {
    throw new RuntimeExecutionFailure({
      phase: 'start', retry: 'non-retryable', failure: { class: 'auth' },
      reason: `${source} provider API key must contain at least ${MIN_RUNTIME_KEY_LENGTH} characters and cannot be all whitespace or contain NUL or line breaks`,
    });
  }
  if (key.trim() !== key) {
    throw new RuntimeExecutionFailure({
      phase: 'start', retry: 'non-retryable', failure: { class: 'auth' },
      reason: `${source} provider API key cannot contain leading or trailing whitespace`,
    });
  }
  return key;
}

function resolutionFailed(runtime: RuntimeWithHostCredential): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure({
    phase: 'start', retry: 'non-retryable', failure: { class: 'auth' },
    reason: `${runtime} provider API key resolution failed`,
  });
}

/** Resolve one spawn's credential. Host exceptions and cancellation reasons can contain secrets. */
export async function resolveRuntimeApiKey(runtime: RuntimeWithHostCredential, resolveKey: () => Promise<string>, signal?: AbortSignal): Promise<string> {
  const cancelled = () => new Error(`${runtime} start was cancelled`);
  if (signal?.aborted) throw cancelled();
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(cancelled());
  signal?.addEventListener('abort', abort, { once: true });
  let resolved: unknown;
  try {
    resolved = await Promise.race([stopped.promise, Promise.resolve().then(() => {
      if (signal?.aborted) throw cancelled();
      return resolveKey();
    })]);
  } catch {
    if (signal?.aborted) throw cancelled();
    throw resolutionFailed(runtime);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (signal?.aborted) throw cancelled();
  const key = requireRuntimeApiKey(resolved, runtime);
  if (runtime === 'agy') {
    try { validateHeaderValue('x-goog-api-key', key); } catch { throw resolutionFailed(runtime); }
  }
  return key;
}

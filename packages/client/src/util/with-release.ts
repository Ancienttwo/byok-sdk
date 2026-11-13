import { withGateReleaseFailures } from './path-mutation-gate.js';

/** Release after failure without replacing the original error. */
export async function releaseAfterFailure(
  error: unknown,
  release: () => void | Promise<void>,
  combine: (error: unknown, failures: readonly unknown[]) => unknown = withGateReleaseFailures,
): Promise<never> {
  try { await release(); } catch (failure) { throw combine(error, [failure]); }
  throw error;
}

/** Run cleanup on either outcome without losing the operation error. */
export async function withRelease<T>(
  work: () => Promise<T>,
  release: () => void | Promise<void>,
  combine: (error: unknown, failures: readonly unknown[]) => unknown = withGateReleaseFailures,
): Promise<T> {
  let result: T;
  try { result = await work(); }
  catch (error) { return releaseAfterFailure(error, release, combine); }
  await release();
  return result;
}

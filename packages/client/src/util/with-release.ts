import { withGateReleaseFailures } from './path-mutation-gate.js';

/** Run cleanup on either outcome without losing the operation error. */
export async function withRelease<T>(
  work: () => Promise<T>,
  release: () => void | Promise<void>,
  combine: (error: unknown, failures: readonly unknown[]) => unknown = withGateReleaseFailures,
): Promise<T> {
  let result: T;
  try { result = await work(); }
  catch (error) {
    try { await release(); } catch (failure) { throw combine(error, [failure]); }
    throw error;
  }
  await release();
  return result;
}

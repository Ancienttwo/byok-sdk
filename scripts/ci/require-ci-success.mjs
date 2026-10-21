import { pathToFileURL } from 'node:url';

/** No skipped, missing, cancelled or unexpected family can satisfy the gate. */
export function requireCiSuccess(needs, expected) {
  if (!Array.isArray(expected) || expected.length === 0
    || expected.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(expected).size !== expected.length) {
    throw new Error('Invalid required CI job inventory');
  }
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    throw new Error('Invalid CI needs results');
  }
  const actual = Object.keys(needs).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`CI job inventory mismatch: expected ${expected.join(', ')}, received ${actual.join(', ')}`);
  }
  const failed = expected.filter(id => needs[id]?.result !== 'success');
  if (failed.length) {
    throw new Error(`Required CI jobs did not succeed: ${failed.map(id => `${id}=${needs[id]?.result ?? 'missing result'}`).join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireCiSuccess(JSON.parse(process.env.CI_NEEDS ?? ''), JSON.parse(process.env.CI_REQUIRED_JOBS ?? ''));
    console.log('All required CI job families succeeded');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

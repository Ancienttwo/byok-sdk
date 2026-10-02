import type { StorageConformanceAssertions } from '@earendil-works/pi-durable/testing';

// Runner-independent assertions keep the very same contract executable inside workerd.
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, i) => key === other[i] && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function partial(a: unknown, b: unknown): boolean {
  if (!b || typeof b !== 'object') return Object.is(a, b);
  if (!a || typeof a !== 'object') return false;
  return Object.keys(b).every(key => partial((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const assertions: StorageConformanceAssertions = {
  ok: (value, message) => check(value, message ?? 'Expected truthy value'),
  strictEqual: (a, b) => check(Object.is(a, b), `Expected ${String(a)} === ${String(b)}`),
  deepEqual: (a, b) => check(equal(a, b), 'Expected deeply equal values'),
  partialDeepEqual: (a, b) => check(partial(a, b), 'Expected matching fields'),
  greaterThan: (a, b) => check(a > b, `Expected ${a} > ${b}`),
  async rejects(operation, messageIncludes) {
    try { await operation; }
    catch (error) {
      check(error instanceof Error && error.message.includes(messageIncludes), `Expected rejection containing ${messageIncludes}, received ${String(error)}`);
      return;
    }
    throw new Error(`Expected rejection containing ${messageIncludes}`);
  },
};

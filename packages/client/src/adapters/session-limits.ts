export const DEFAULT_INTERRUPT_TIMEOUT_MS = 1_000;
export const DEFAULT_MAX_RETAINED_BYTES = 16 * 1024 * 1024;

export function resolveInterruptTimeoutMs(value: number | undefined, runtime: string): number {
  const ms = value ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
  // setTimeout fires immediately above 2147483647 ms.
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) throw new TypeError(`invalid ${runtime} interrupt timeout`);
  return ms;
}

export function resolveMaxRetainedBytes(value: number | undefined, runtime: string): number {
  const bytes = value ?? DEFAULT_MAX_RETAINED_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new TypeError(`invalid ${runtime} retention budget`);
  return bytes;
}

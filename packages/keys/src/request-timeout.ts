/** Validate the timer range without Node silently clamping an invalid delay. */
export function validateRequestTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError('requestTimeoutMs must be an integer between 1 and 2147483647');
  }
  return value;
}

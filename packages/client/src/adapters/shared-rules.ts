export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return record(value) ? value : undefined;
}

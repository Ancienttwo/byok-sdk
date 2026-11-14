export const HELPER_PROBE_TIMEOUT_MS = 60_000;
const timeouts = new WeakSet<Error>();
const cancellations = new WeakSet<Error>();
const exits = new WeakMap<Error, Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>();

/** Preserve the public I/O error type; classify deadlines and cancellation without parsing text. */
export function agentMemoryHelperTimeout(error: Error): Error {
  timeouts.add(error);
  return error;
}
export function isAgentMemoryHelperTimeout(error: unknown): boolean {
  return error instanceof Error && timeouts.has(error);
}
export function agentMemoryHelperCancellation(error: Error): Error {
  cancellations.add(error);
  return error;
}
export function isAgentMemoryHelperCancellation(error: unknown): boolean {
  return error instanceof Error && cancellations.has(error);
}

export function agentMemoryHelperExit(error: Error, code: number | null, signal: NodeJS.Signals | null): Error {
  exits.set(error, { code, signal });
  return error;
}
export function agentMemoryHelperExitOutcome(error: unknown): Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | undefined {
  return error instanceof Error ? exits.get(error) : undefined;
}

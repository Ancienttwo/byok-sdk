import { AsyncLocalStorage } from 'node:async_hooks';

const HELPER_PROBE_TIMEOUT_MS = 60_000;
/** Private invocation context: the public filesystem helper API stays unchanged. */
export const agentMemoryHelperProbe = new AsyncLocalStorage<{ deadline: number; signal?: AbortSignal }>();
const timeouts = new WeakSet<Error>();

/** Preserve the existing I/O error type while identifying missed deadlines without parsing text. */
export function agentMemoryHelperTimeout(error: Error): Error {
  timeouts.add(error);
  return error;
}
export function isAgentMemoryHelperTimeout(error: unknown): boolean {
  return error instanceof Error && timeouts.has(error);
}

export function withAgentMemoryHelperProbe<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return agentMemoryHelperProbe.run({ deadline: performance.now() + HELPER_PROBE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }, work);
}

/** The rejection a Pi start request gets when the start's signal aborts first. */
export const startAborted = (): Error => new Error('the start was aborted before pi answered');

/**
 * `pending`, or a rejection once the start's signal aborts. A Pi process can
 * leave a start request unanswered (#2300, #2308): an extension that compacts
 * from its `agent_settled` hook makes Pi defer the first prompt and then
 * refuse it with no response, and a durable host can stall before its start
 * receipt. The daemon aborts this signal at its startup deadline; each caller
 * then disposes the process through its lane's teardown and fails start with a
 * typed error.
 */
export async function untilStartAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await pending;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(startAborted()); });
  if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', onAbort); }
}

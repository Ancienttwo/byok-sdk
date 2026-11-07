/** V4 must suppress these envelopes and await abort acknowledgement or process exit before ending the task. */
export const PI_MEMORY_LANE = Object.freeze({
  egress: Object.freeze({ taskProgress: false, summary: '', finalMessage: false, resultDocument: false }),
  cancellation: 'await-rpc-abort-or-process-exit' as const,
});


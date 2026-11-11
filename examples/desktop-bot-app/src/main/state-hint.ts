/** How long main gathers state changes into one renderer hint. */
export const STATE_HINT_WINDOW_MS = 50;

/**
 * Coalesces state changes into hints: the first change of a burst schedules
 * one `send` after `windowMs`, and every change before it fires is covered by
 * it, because the renderer pulls the state when the hint arrives.
 */
export function coalesceStateHints(send: () => void, windowMs = STATE_HINT_WINDOW_MS): () => void {
  let pending: NodeJS.Timeout | undefined;
  return () => {
    pending ??= setTimeout(() => {
      pending = undefined;
      send();
    }, windowMs);
  };
}

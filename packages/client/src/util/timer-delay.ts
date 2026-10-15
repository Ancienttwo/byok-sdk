/**
 * Largest delay `setTimeout` honors (2^31 - 1 ms, ~24.8 days). Node and Bun
 * clamp anything longer to 1 ms, so a deadline that may be further away must
 * be armed in capped steps and re-armed until it is actually reached.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

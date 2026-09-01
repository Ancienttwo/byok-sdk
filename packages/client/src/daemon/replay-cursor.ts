/**
 * The server retained no contiguous replay history after the cursor the
 * daemon acknowledged. This is terminal for the current device enrollment:
 * retrying the same cursor can only repeat the loss condition.
 */
export class ReplayCursorTooOldError extends Error {
  constructor(readonly recoverableFrom?: number) {
    super(
      recoverableFrom === undefined
        ? 'server cannot replay the acknowledged cursor; re-pair or operator recovery is required'
        : `server cannot replay the acknowledged cursor; retained history starts at ${recoverableFrom}`,
    );
    this.name = 'ReplayCursorTooOldError';
  }
}

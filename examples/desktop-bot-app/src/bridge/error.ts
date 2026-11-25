/** A refused bridge call, carrying the structured error `code` from Main / `byok-shell`. */
export class BridgeCallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeCallError';
    this.code = code;
  }
}

// Both Server entrypoints recognize the same refusal across their separate bundles.
export const INPUT_IMAGE_REF_ERROR = Symbol.for('@byok-sdk/server/input-image-ref-error');

/** A definitive image metadata refusal before the server writes the offer. */
export function isInputImageRefError(error: unknown): error is Error & { code: 'coordination_input_invalid' } {
  return error instanceof Error && INPUT_IMAGE_REF_ERROR in error && error[INPUT_IMAGE_REF_ERROR] === true
    && 'code' in error && error.code === 'coordination_input_invalid';
}

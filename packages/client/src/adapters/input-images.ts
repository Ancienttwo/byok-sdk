import { RuntimeExecutionFailure } from '../runtime-failure.js';
import type { RuntimeInputImage } from '../types.js';

export function requireImageInput(images: readonly RuntimeInputImage[] | undefined, supported: boolean): void {
  if (images?.length && !supported) {
    throw new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable',
      reason: 'opened session does not support image input', failure: { class: 'invalid_request' } });
  }
}

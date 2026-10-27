import { TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH } from '@byok-sdk/protocol/constants';

/** A served model name as the runtime reported it; one the wire would refuse is dropped whole, never truncated. */
export function servedModelName(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH
    ? value
    : undefined;
}

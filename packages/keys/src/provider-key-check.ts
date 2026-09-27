import { AnthropicMessagesClient } from './anthropic-client';
import type { ProviderKeyCheckOutcome } from './custody';
import { ByokKeysError } from './errors';
import type { ProviderFetch } from './http';
import { OpenAiCompatibleChatClient } from './openai-client';
import type { ModelProviderProfile } from './provider-profile';

/** Default bound on one key check, below the transport's own 15 s ceiling. */
export const PROVIDER_KEY_CHECK_TIMEOUT_MS = 10_000;

export interface ProviderKeyCheckOptions {
  readonly fetchImpl?: ProviderFetch;
  readonly timeoutMs?: number;
}

/**
 * One live round trip with a just-provisioned key (plan D13, A10). The result
 * is a hint for the UI, never a readiness decision, and is a closed-set code:
 *
 * - `credential_rejected` only for an explicit credential rejection (HTTP 401);
 * - 403 and model-not-found → `model_not_permitted`;
 * - billing/quota → `quota_or_billing`, 429 → `rate_limited`;
 * - this check's own deadline or the transport timeout → `timeout`;
 * - abort or network failure → `unreachable`;
 * - anything else (5xx, malformed or oversize response) → `provider_error`.
 *
 * Bounded by `timeoutMs` and by the transport's response size ceiling; the
 * request refuses redirects so the key never follows one. No provider body,
 * header, or error text leaves this function.
 */
export async function checkProviderKey(
  profile: ModelProviderProfile,
  secret: string,
  options: ProviderKeyCheckOptions = {},
): Promise<Exclude<ProviderKeyCheckOutcome, 'not_run'>> {
  const client = profile.adapter === 'anthropic'
    ? new AnthropicMessagesClient({ fetchImpl: options.fetchImpl, profile, secret })
    : new OpenAiCompatibleChatClient({ fetchImpl: options.fetchImpl, profile, secret });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('provider_key_check_timeout'), options.timeoutMs ?? PROVIDER_KEY_CHECK_TIMEOUT_MS);
  try {
    await client.testConnection(controller.signal);
    return 'ok';
  } catch (error) {
    return classifyProviderKeyCheckFailure(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

export function classifyProviderKeyCheckFailure(
  error: unknown,
  timedOut: boolean,
): Exclude<ProviderKeyCheckOutcome, 'not_run' | 'ok'> {
  if (timedOut) return 'timeout';
  if (error instanceof ByokKeysError) {
    switch (error.code) {
      case 'MODEL_PROVIDER_AUTH_FAILED':
        return error.httpStatus === 401 ? 'credential_rejected' : 'model_not_permitted';
      case 'MODEL_PROVIDER_BALANCE_INSUFFICIENT':
        return 'quota_or_billing';
      case 'MODEL_PROVIDER_RATE_LIMITED':
        return 'rate_limited';
      case 'MODEL_PROVIDER_MODEL_NOT_FOUND':
        return 'model_not_permitted';
      case 'PROVIDER_REQUEST_TIMEOUT':
        return 'timeout';
      default:
        return 'provider_error';
    }
  }
  if (error instanceof TypeError) return 'unreachable';
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'unreachable';
  return 'provider_error';
}

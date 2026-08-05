import {
  assertLiveModelResponse,
  fetchWithProviderGuards,
  modelApiUrl,
  modelMessageText,
  objectValue,
  readModelProviderResponse,
  type ProviderFetch,
} from './http';
import { providerHeaders, requiredProviderSecret } from './headers';
import { ByokKeysError } from './errors';
import {
  parseModelProviderProfile,
  type ModelProviderProfile,
} from './provider-profile';
import type { ModelProviderClientOptions } from './openai-client';
import { isLoopbackProviderUrl } from './url';

/** One Anthropic message. `content` is `unknown` so block arrays pass through. */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

/**
 * A Messages API request minus `model`, which the client fills from the
 * profile. `max_tokens` is required because the API requires it.
 */
export interface AnthropicMessageRequest {
  messages: readonly AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
}

/**
 * Transport for the Anthropic Messages API, ported from
 * `aip-main-open@c6a5385` `providers.ts:831-1067`.
 *
 * As with the OpenAI-compatible client, only `#createMessage`'s generic
 * request/parse/error path travels; the narrative methods that wrapped it stay
 * in aip-main-open per `docs/researches/HANDOFF-byok-keys.md` §4.5.
 */
export class AnthropicMessagesClient {
  readonly model: string;
  /** False only when the provider is loopback, i.e. no data leaves the machine. */
  readonly remoteDataTransfer: boolean;
  readonly #fetch: ProviderFetch;
  readonly #profile: ModelProviderProfile;
  readonly #secret: string;

  constructor(options: ModelProviderClientOptions) {
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#profile = parseModelProviderProfile(options.profile);
    if (this.#profile.adapter !== 'anthropic') {
      throw new ByokKeysError(
        'PROVIDER_PROFILE_INVALID',
        'Anthropic provider requires the anthropic adapter',
      );
    }
    this.#secret = requiredProviderSecret(
      this.#profile,
      options.secret,
    ) as string;
    this.model = this.#profile.model;
    this.remoteDataTransfer = !isLoopbackProviderUrl(this.#profile.base_url);
  }

  /** POST `<base_url>/messages`; returns the parsed response object. */
  async createMessage(
    request: AnthropicMessageRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Record<string, unknown>> {
    const response = await fetchWithProviderGuards(
      this.#fetch,
      modelApiUrl(this.#profile.base_url, 'messages'),
      {
        body: JSON.stringify({ ...request, model: this.#profile.model }),
        headers: providerHeaders(this.#profile, this.#secret),
        method: 'POST',
        redirect: 'error',
      },
      signal,
    );
    const payload = objectValue(await readModelProviderResponse(response));
    if (payload === undefined) {
      throw new ByokKeysError(
        'MODEL_RESPONSE_INVALID',
        'Anthropic provider returned an invalid response',
      );
    }
    return payload;
  }

  /** Round-trip the configured key against the provider (`providers.ts:1037-1054`). */
  async testConnection(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const payload = await this.createMessage(
      {
        max_tokens: 32,
        messages: [
          {
            content:
              'Return one JSON object with exactly this shape: {"ok":true}.',
            role: 'user',
          },
        ],
        temperature: 0,
      },
      signal,
    );
    assertLiveModelResponse(anthropicMessageText(payload));
  }
}

/** Pull the assistant text out of a Messages API payload (`providers.ts:1084`). */
export function anthropicMessageText(payload: Record<string, unknown>): string {
  return modelMessageText(payload.content);
}

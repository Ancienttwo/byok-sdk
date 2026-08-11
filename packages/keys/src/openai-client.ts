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
import { isLoopbackProviderUrl } from './url';

/** One chat message. `content` is `unknown` so multimodal block arrays pass through. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

/**
 * A chat/completions request minus `model`, which the client fills from the
 * profile — the profile is the single source of truth for which model this
 * configured provider addresses.
 */
export interface ChatCompletionRequest {
  messages: readonly ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: string };
}

export interface ModelProviderClientOptions {
  fetchImpl?: ProviderFetch;
  profile: unknown;
  secret?: string;
}

/**
 * Transport for OpenAI-compatible chat/completions providers, ported from
 * `aip-main-open@c6a5385` `providers.ts:478-829`.
 *
 * Only the request construction, response parsing, and error mapping travel;
 * every narrative/finance method of the source class stays in aip-main-open
 * per `docs/researches/HANDOFF-byok-keys.md` §4.5. The domain-specific
 * prompts, temperatures, and token budgets that were baked into those methods
 * become caller-supplied request fields.
 */
export class OpenAiCompatibleChatClient {
  readonly model: string;
  /** False only when the provider is loopback, i.e. no data leaves the machine. */
  readonly remoteDataTransfer: boolean;
  readonly #fetch: ProviderFetch;
  readonly #profile: ModelProviderProfile;
  readonly #secret: string | undefined;

  constructor(options: ModelProviderClientOptions) {
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#profile = parseModelProviderProfile(options.profile);
    this.#secret = requiredProviderSecret(this.#profile, options.secret);
    this.model = this.#profile.model;
    this.remoteDataTransfer = !isLoopbackProviderUrl(this.#profile.base_url);
  }

  /** POST `<base_url>/chat/completions`; returns the parsed response object. */
  async createChatCompletion(
    request: ChatCompletionRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Record<string, unknown>> {
    const response = await fetchWithProviderGuards(
      this.#fetch,
      modelApiUrl(this.#profile.base_url, 'chat/completions'),
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
        'Model provider returned an invalid response',
      );
    }
    return payload;
  }

  /**
   * Round-trip the configured key against the provider
   * (`providers.ts:797-828`). An empty completion fails, so a provider that
   * accepts anything cannot be mistaken for a working configuration.
   */
  async testConnection(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const payload = await this.createChatCompletion(
      {
        max_tokens: 32,
        messages: [
          {
            content:
              'Return one JSON object with exactly this shape: {"ok":true}.',
            role: 'user',
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      },
      signal,
    );
    assertLiveModelResponse(chatCompletionText(payload));
  }
}

/**
 * Pull the assistant text out of a chat/completions payload
 * (`providers.ts:597-599` and siblings, which repeated this shape in every
 * narrative method).
 */
export function chatCompletionText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = objectValue(objectValue(choices[0])?.message);
  return modelMessageText(message?.content);
}

export { ByokKeysError, BYOK_KEYS_ERROR_CODES } from './errors';
export type { ByokKeysErrorCode } from './errors';

export {
  MODEL_PROVIDER_IDS,
  MODEL_PROVIDER_ADAPTERS,
  PROVIDER_AUTH_MODES,
  ModelProviderProfileSchema,
  parseModelProviderProfile,
} from './provider-profile';
export type {
  ModelProviderAdapter,
  ModelProviderId,
  ModelProviderProfile,
  ModelProviderProfileInput,
  ProviderAuthMode,
} from './provider-profile';

export { providerHeaders, requiredProviderSecret } from './headers';
export type { ProviderAuthProfile } from './headers';

export {
  normalizeProviderUrl,
  isLoopbackHost,
  isLoopbackProviderUrl,
  isPrivateNetworkLiteral,
} from './url';

export {
  classifyModelProviderHttpError,
  modelApiUrl,
  modelMessageText,
  PROVIDER_RESPONSE_MAX_BYTES,
  PROVIDER_TIMEOUT_MS,
} from './http';
export type { ProviderFetch } from './http';

export { OpenAiCompatibleChatClient, chatCompletionText } from './openai-client';
export type {
  ChatCompletionRequest,
  ChatMessage,
  ModelProviderClientOptions,
} from './openai-client';

export { AnthropicMessagesClient, anthropicMessageText } from './anthropic-client';
export type {
  AnthropicMessage,
  AnthropicMessageRequest,
} from './anthropic-client';

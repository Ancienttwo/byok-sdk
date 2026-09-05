export { ByokKeysError, BYOK_KEYS_ERROR_CODES } from './errors';
export type { ByokKeysErrorCode } from './errors';

export {
  MODEL_PROVIDER_ADAPTERS,
  MODEL_PROVIDER_KINDS,
  PROVIDER_AUTH_MODES,
  PROVIDER_MODEL_CAPABILITIES,
  ModelProviderProfileSchema,
  ProviderModelCapabilitySchema,
  ProviderProfileRefSchema,
  parseModelProviderProfile,
  exactProviderProfileBinding,
  assertExactProviderProfileBinding,
} from './provider-profile';
export type {
  ModelProviderAdapter,
  ModelProviderKind,
  ModelProviderProfile,
  ModelProviderProfileInput,
  ExactProviderProfileBinding,
  ProviderAuthMode,
  ProviderModelCapability,
  ProviderProfileRef,
} from './provider-profile';

export {
  MODEL_PROVIDER_VENDORS,
  MODEL_PROVIDER_VENDOR_IDS,
  modelProviderVendor,
} from './provider-catalog';
export type {
  ModelProviderVendor,
  ModelProviderVendorId,
} from './provider-catalog';

export { providerHeaders, requiredProviderSecret } from './headers';
export type { ProviderAuthProfile } from './headers';

export {
  normalizeProviderUrl,
  isLoopbackHost,
  isLoopbackProviderUrl,
  isPrivateNetworkLiteral,
} from './url';

export {
  assertLiveModelResponse,
  classifyModelProviderHttpError,
  fetchWithProviderGuards,
  modelApiUrl,
  modelMessageText,
  objectValue,
  parseBoundedJsonResponse,
  PROVIDER_RESPONSE_MAX_BYTES,
  PROVIDER_TIMEOUT_MS,
  readModelProviderResponse,
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

export { runCommand } from './command-runner';
export type { CommandResult, CommandRunner } from './command-runner';

export {
  SECRET_NAME_PATTERN,
  SECRET_NAMESPACE_PATTERN,
  assertSecretName,
  assertSecretNamespace,
} from './secret-name';

export {
  DEFAULT_SECRET_SERVICE_PREFIX,
  InMemorySecretStore,
  assertSharedSecretValue,
  decodeStrictBase64Utf8,
  modelProviderSecretName,
} from './secret-store';
export type { ModelProviderSecretName, SecretStore } from './secret-store';

export {
  DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX,
  MacOsKeychainSecretStore,
} from './macos-keychain';
export type { MacOsKeychainSecretStoreOptions } from './macos-keychain';

export { WindowsCredentialManagerSecretStore } from './windows-credential-manager';
export type { WindowsCredentialManagerSecretStoreOptions } from './windows-credential-manager';

export {
  DEFAULT_SECRET_ENVELOPE_PREFIX,
  EnvelopeScopedSecretStore,
  scopeSecretStore,
  secretScopeId,
} from './secret-scope';
export type { SecretScope } from './secret-scope';

export { InMemoryProviderProfileStore } from './profile-store';
export type { ProviderProfileStore } from './profile-store';

export {
  isSqliteAvailable,
  loadSqliteModule,
  openSqliteDatabase,
  secureSqliteFilePermissions,
} from './sqlite-support';

export { SqliteProviderProfileStore } from './sqlite-profile-store';
export type { SqliteProviderProfileStoreOptions } from './sqlite-profile-store';

export {
  PROVIDER_PROFILE_TRUTH_RECORD_KEY,
  TruthStoreProviderProfileStore,
} from './truth-profile-store';
export type { TruthStoreProviderProfileStoreOptions } from './truth-profile-store';

export { ProviderRegistry } from './registry';
export type {
  ModelProviderClient,
  ProviderConfiguration,
  ProviderRegistryOptions,
  ProviderStatus,
} from './registry';

export {
  PI_PROJECTED_KEY_ENV,
  buildPiProviderProjection,
} from './pi-provider-projection';

export { ByokKeysError, BYOK_KEYS_ERROR_CODES } from './errors.js';
export type { ByokKeysErrorCode } from './errors.js';
export {
  PiModelConfigSchema,
  PI_THINKING_LEVELS,
  PI_OPENAI_COMPATIBLE_APIS,
  PI_MODEL_APIS,
  PI_COMPAT_KEYS_BY_API,
} from './pi-model-config.js';
export type { PiCompatKey, PiModelApi, PiModelConfig, PiOpenAICompatibleApi, PiThinkingLevel } from './pi-model-config.js';


export {
  MODEL_PROVIDER_ADAPTERS,
  MODEL_PROVIDER_KINDS,
  PROVIDER_AUTH_MODES,
  PROVIDER_MODEL_CAPABILITIES,
  ModelProviderProfileSchema,
  ProviderModelCapabilitySchema,
  ProviderProfileRefSchema,
  parseModelProviderProfile,
} from './provider-profile.js';
export type {
  ModelProviderAdapter,
  ModelProviderKind,
  ModelProviderProfile,
  ModelProviderProfileInput,
  ProviderAuthMode,
  ProviderModelCapability,
  ProviderProfileRef,
} from './provider-profile.js';
export {
  exactProviderProfileBinding,
  assertExactProviderProfileBinding,
} from './provider-profile-binding.js';
export type { ExactProviderProfileBinding } from './provider-profile-binding.js';

export {
  MODEL_PROVIDER_VENDORS,
  MODEL_PROVIDER_VENDOR_IDS,
  modelProviderVendor,
} from './provider-catalog.js';
export type {
  ModelProviderVendor,
  ModelProviderVendorId,
} from './provider-catalog.js';

export { providerHeaders, requiredProviderSecret } from './headers.js';
export type { ProviderAuthProfile } from './headers.js';

export {
  normalizeProviderUrl,
  isLoopbackHost,
  isLoopbackProviderUrl,
  isPrivateNetworkLiteral,
} from './url.js';

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
} from './http.js';
export type { ProviderFetch } from './http.js';

export { OpenAiCompatibleChatClient, chatCompletionText } from './openai-client.js';
export type {
  ChatCompletionRequest,
  ChatMessage,
  ModelProviderClientOptions,
} from './openai-client.js';

export { AnthropicMessagesClient, anthropicMessageText } from './anthropic-client.js';
export type {
  AnthropicMessage,
  AnthropicMessageRequest,
} from './anthropic-client.js';

export { runCommand } from './command-runner.js';
export type { CommandResult, CommandRunner } from './command-runner.js';

export {
  SECRET_NAME_PATTERN,
  SECRET_NAMESPACE_PATTERN,
  assertSecretName,
  assertSecretNamespace,
} from './secret-name.js';

export {
  DEFAULT_SECRET_SERVICE_PREFIX,
  InMemorySecretStore,
  assertSharedSecretValue,
  decodeStrictBase64Utf8,
  modelProviderSecretName,
} from './secret-store.js';
export { PROVIDER_PROVISIONING_SECRET_MAX_BYTES } from './secret-value.js';
export type { ModelProviderSecretName, SecretStore } from './secret-store.js';

export {
  DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX,
  MacOsKeychainSecretStore,
} from './macos-keychain.js';
export type { MacOsKeychainSecretStoreOptions } from './macos-keychain.js';

export { LinuxSecretServiceSecretStore } from './linux-secret-service.js';
export type { LinuxSecretServiceSecretStoreOptions } from './linux-secret-service.js';

export { WindowsCredentialManagerSecretStore } from './windows-credential-manager.js';
export type { WindowsCredentialManagerSecretStoreOptions } from './windows-credential-manager.js';

export {
  DEFAULT_SECRET_ENVELOPE_PREFIX,
  EnvelopeScopedSecretStore,
  scopeSecretStore,
  secretScopeId,
} from './secret-scope.js';
export type { SecretScope } from './secret-scope.js';

export { InMemoryProviderProfileStore } from './profile-store.js';
export type { ProviderProfileStore } from './profile-store.js';

export {
  isSqliteAvailable,
  loadSqliteModule,
  openSqliteDatabase,
  secureSqliteFilePermissions,
} from './sqlite-support.js';

export { SqliteProviderProfileStore, migrateProviderProfileStore } from './sqlite-profile-store.js';
export type { ProviderProfileStoreMigration, SqliteProviderProfileStoreOptions } from './sqlite-profile-store.js';
export { inspectProviderProfileStore } from './store-compatibility.js';

export {
  PROVIDER_PROFILE_TRUTH_RECORD_KEY,
  TruthStoreProviderProfileStore,
} from './truth-profile-store.js';
export type { TruthStoreProviderProfileStoreOptions } from './truth-profile-store.js';

export {
  PROVIDER_CONFIGURATION_LOCK_WAIT_MS,
  PROVIDER_CUSTODY_RECEIPT_LIMIT,
  PROVIDER_KEY_CHECK_OUTCOMES,
  PROVIDER_PROVISIONING_REJECTIONS,
  withConfigurationLock,
} from './custody.js';
export type {
  ProviderConfigurationLock,
  ProviderCustodyCommit,
  ProviderCustodyOperation,
  ProviderCustodyPending,
  ProviderCustodyReceipt,
  ProviderKeyCheckOutcome,
  ProviderProvisioningBinding,
  ProviderProvisioningRejection,
  ProviderProvisioningResult,
} from './custody.js';

export { DEVICE_SEALING_SECRET_NAME, DeviceSealingKeyStore } from './device-sealing-key.js';
export type {
  DeviceSealingEnrollment,
  DeviceSealingKey,
  DeviceSealingSecretName,
} from './device-sealing-key.js';

export {
  PROVIDER_PROVISIONING_MAX_CLOCK_SKEW_MS,
  applySealedProviderProvisioning,
  readSealedProvisioningResult,
} from './sealed-provisioning.js';
export type {
  ApplySealedProviderProvisioningOptions,
  ProviderProvisioningIdentitySnapshot,
  SealedProvisioningReadback,
  ProviderProvisioningCutPoint,
  ProviderProvisioningFaultSeam,
} from './sealed-provisioning.js';

export { PROVIDER_KEY_CHECK_TIMEOUT_MS, checkProviderKey } from './provider-key-check.js';
export type { ProviderKeyCheckOptions } from './provider-key-check.js';

export { ProviderRegistry } from './registry.js';
export type {
  ModelProviderClient,
  ProviderConfiguration,
  ProviderRegistryOptions,
  ProviderStatus,
} from './registry.js';

export {
  PI_AUTH_NONE_API_KEY,
  PI_PROJECTED_KEY_ENV,
  assertPiLaunchArgs,
  buildPiProviderProjection,
} from './pi-provider-projection.js';

export {
  parsePiProviderLauncherOptions,
  runPiProviderLauncher,
} from './pi-provider-launcher-core.js';
export type {
  PiProviderLauncherHost,
  PiProviderLauncherOptions,
} from './pi-provider-launcher-core.js';

export { HERMES_PROVIDER_KEY_ENV, hermesProviderModel, parseHermesProviderLauncherRequest, runHermesProviderLauncher } from './hermes-provider-launcher.js';
export type { HermesProviderLauncherRequest } from './hermes-provider-launcher.js';

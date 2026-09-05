// ==== @byok-sdk/keys dist/anthropic-client.d.ts ====
import type { ModelProviderClientOptions } from './openai-client';
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
export declare class AnthropicMessagesClient {
    #private;
    readonly model: string;
    /** False only when the provider is loopback, i.e. no data leaves the machine. */
    readonly remoteDataTransfer: boolean;
    constructor(options: ModelProviderClientOptions);
    /** POST `<base_url>/messages`; returns the parsed response object. */
    createMessage(request: AnthropicMessageRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /** Round-trip the configured key against the provider (`providers.ts:1037-1054`). */
    testConnection(signal?: AbortSignal): Promise<void>;
}
/** Pull the assistant text out of a Messages API payload (`providers.ts:1084`). */
export declare function anthropicMessageText(payload: Record<string, unknown>): string;
// ==== @byok-sdk/keys dist/command-runner.d.ts ====
/** A finished child process, ported from `aip-main-open@c6a5385` `index.ts:284-288`. */
export interface CommandResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}
/**
 * The injection seam both OS backends are written against. Unit tests supply a
 * fake so no test ever reads or writes a real credential store; production code
 * gets {@link runCommand}.
 */
export type CommandRunner = (executable: string, args: string[], stdin?: string) => Promise<CommandResult>;
/**
 * Spawn `executable`, feed it `stdin`, and collect its output
 * (`index.ts:2498-2527`).
 *
 * It never rejects: a missing executable resolves as exit code 127 so the
 * backends' `available()` probes can treat "no such binary" the same way they
 * treat "binary said no". Stdin is always closed, otherwise a child that reads
 * to EOF would hang forever.
 */
export declare function runCommand(executable: string, args: string[], stdin?: string): Promise<CommandResult>;
// ==== @byok-sdk/keys dist/errors.d.ts ====
/**
 * Single error class for `@byok-sdk/keys`.
 *
 * The ported source (`aip-main-open@c6a5385`, `apps/local-agent/src/providers.ts`)
 * raised two different classes — `LocalExecutionError` and
 * `ResearchExecutionError` — that differed only in which subsystem owned the
 * throw site; both carried a `code` string and consumers branched on that code.
 * The narrative/research subsystem stays behind in aip-main-open, so this
 * package keeps one class and preserves the `code` strings verbatim. K4's swap
 * converts aip's two `instanceof` sites to structured code detection, so the
 * strings — not the class identity — are the compatibility surface.
 */
export declare class ByokKeysError extends Error {
    readonly code: string;
    readonly httpStatus?: number;
    constructor(code: string, message: string, options?: ErrorOptions & {
        httpStatus?: number;
    });
}
/**
 * Error codes this package can throw, ported verbatim from the source. Kept as
 * a named record so consumers (and K4's aip-main-open swap) can branch on
 * `error.code` without retyping string literals.
 *
 * Four codes have no source counterpart, and each guards a check the source did
 * not make: `KEYCHAIN_SECRET_DECODE_FAILED` (the source returned an undecodable
 * stored value as-is), `SECRET_ENVELOPE_INVALID` (it reported a malformed
 * envelope as an absent secret), and `SECRET_NAME_INVALID` /
 * `SECRET_VALUE_INVALID` (the runtime replacements for the closed
 * `KeychainSecretName` union). `PROVIDER_STORE_SCHEMA_STALE` joins them: it
 * guards a persisted `provider_profile` DDL that differs from the one this
 * package generates. Everything else matches the source string for string.
 *
 * `SECRET_NAMESPACE_INVALID` is a separate case. The source does record it:
 * `normalizeSecretNamespace` (`index.ts:748-757`) throws the verbatim string
 * `'SECRET_NAMESPACE_INVALID'` at `index.ts:752`, and this package ports both
 * that string and its pattern unchanged. It is still not a compatibility
 * surface K4 must match, but for a different reason than the string: neither
 * side has a branch consumer. In the source the only callers are the two OS
 * stores' `scope()` methods, which just compose a service prefix; here the code
 * is only ever asserted in tests. Matching it costs nothing and constrains
 * nothing.
 */
export declare const BYOK_KEYS_ERROR_CODES: {
    readonly CREDENTIAL_MANAGER_DELETE_FAILED: 'CREDENTIAL_MANAGER_DELETE_FAILED';
    readonly CREDENTIAL_MANAGER_READ_FAILED: 'CREDENTIAL_MANAGER_READ_FAILED';
    readonly CREDENTIAL_MANAGER_SECRET_INVALID: 'CREDENTIAL_MANAGER_SECRET_INVALID';
    readonly CREDENTIAL_MANAGER_UNAVAILABLE: 'CREDENTIAL_MANAGER_UNAVAILABLE';
    readonly CREDENTIAL_MANAGER_WRITE_FAILED: 'CREDENTIAL_MANAGER_WRITE_FAILED';
    readonly KEYCHAIN_ARGUMENT_INVALID: 'KEYCHAIN_ARGUMENT_INVALID';
    readonly KEYCHAIN_DELETE_FAILED: 'KEYCHAIN_DELETE_FAILED';
    readonly KEYCHAIN_READ_FAILED: 'KEYCHAIN_READ_FAILED';
    readonly KEYCHAIN_SECRET_DECODE_FAILED: 'KEYCHAIN_SECRET_DECODE_FAILED';
    readonly KEYCHAIN_SECRET_INVALID: 'KEYCHAIN_SECRET_INVALID';
    readonly KEYCHAIN_UNAVAILABLE: 'KEYCHAIN_UNAVAILABLE';
    readonly KEYCHAIN_WRITE_FAILED: 'KEYCHAIN_WRITE_FAILED';
    readonly LOCAL_ACCOUNT_SCOPE_INVALID: 'LOCAL_ACCOUNT_SCOPE_INVALID';
    readonly MODEL_PROVIDER_AUTH_FAILED: 'MODEL_PROVIDER_AUTH_FAILED';
    readonly MODEL_PROVIDER_BALANCE_INSUFFICIENT: 'MODEL_PROVIDER_BALANCE_INSUFFICIENT';
    readonly MODEL_PROVIDER_HTTP_ERROR: 'MODEL_PROVIDER_HTTP_ERROR';
    readonly MODEL_PROVIDER_MODEL_NOT_FOUND: 'MODEL_PROVIDER_MODEL_NOT_FOUND';
    readonly MODEL_PROVIDER_RATE_LIMITED: 'MODEL_PROVIDER_RATE_LIMITED';
    readonly MODEL_RESPONSE_INVALID: 'MODEL_RESPONSE_INVALID';
    readonly PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED';
    readonly PROVIDER_PROFILE_INVALID: 'PROVIDER_PROFILE_INVALID';
    readonly PROVIDER_PROFILE_CONFLICT: 'PROVIDER_PROFILE_CONFLICT';
    readonly PROVIDER_REQUEST_TIMEOUT: 'PROVIDER_REQUEST_TIMEOUT';
    readonly PROVIDER_RESPONSE_INVALID: 'PROVIDER_RESPONSE_INVALID';
    readonly PROVIDER_RESPONSE_TOO_LARGE: 'PROVIDER_RESPONSE_TOO_LARGE';
    readonly PROVIDER_SECRET_EMPTY: 'PROVIDER_SECRET_EMPTY';
    readonly PROVIDER_SECRET_MISSING: 'PROVIDER_SECRET_MISSING';
    readonly PROVIDER_SECRET_NOT_ALLOWED: 'PROVIDER_SECRET_NOT_ALLOWED';
    readonly PROVIDER_SECRET_ROLLBACK_FAILED: 'PROVIDER_SECRET_ROLLBACK_FAILED';
    readonly PROVIDER_STORE_SCHEMA_STALE: 'PROVIDER_STORE_SCHEMA_STALE';
    readonly PROVIDER_STORE_UNAVAILABLE: 'PROVIDER_STORE_UNAVAILABLE';
    readonly PROVIDER_TRUTH_INVALID: 'PROVIDER_TRUTH_INVALID';
    readonly PROVIDER_URL_INVALID: 'PROVIDER_URL_INVALID';
    readonly SECRET_ENVELOPE_INVALID: 'SECRET_ENVELOPE_INVALID';
    readonly SECRET_NAME_INVALID: 'SECRET_NAME_INVALID';
    readonly SECRET_NAMESPACE_INVALID: 'SECRET_NAMESPACE_INVALID';
    readonly SECRET_VALUE_INVALID: 'SECRET_VALUE_INVALID';
};
export type ByokKeysErrorCode = (typeof BYOK_KEYS_ERROR_CODES)[keyof typeof BYOK_KEYS_ERROR_CODES];
// ==== @byok-sdk/keys dist/headers.d.ts ====
import type { ProviderAuthMode } from './provider-profile';
/** The subset of a profile the header builder reads. */
export interface ProviderAuthProfile {
    auth_mode: ProviderAuthMode;
    kind: string;
}
/**
 * Fail-closed secret check. Ported from `aip-main-open@c6a5385`
 * `providers.ts:1657-1671`: a profile that declares `bearer` or `x_api_key`
 * must have a secret, or the request is refused rather than sent unauthenticated.
 */
export declare function requiredProviderSecret(profile: ProviderAuthProfile, secret: string | undefined): string | undefined;
/**
 * Build the outbound request headers for a provider call. Key-for-key
 * equivalent to `providers.ts:1680-1697`:
 * - always `accept` and `content-type`;
 * - `bearer` adds `authorization: Bearer <secret>`;
 * - `x_api_key` adds `x-api-key: <secret>` and `anthropic-version: 2023-06-01`;
 * - `none` adds nothing.
 */
export declare function providerHeaders(profile: ProviderAuthProfile, secret: string | undefined): Record<string, string>;
// ==== @byok-sdk/keys dist/http.d.ts ====
/** Injectable `fetch`. Defaults to `globalThis.fetch` at every call site. */
export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/** Response body ceiling, ported from `providers.ts:106`. */
export declare const PROVIDER_RESPONSE_MAX_BYTES: number;
/** Per-request timeout, ported from `providers.ts:107`. */
export declare const PROVIDER_TIMEOUT_MS = 15000;
/**
 * Issue a provider request under the source's guards
 * (`providers.ts:1711-1743`): the URL is re-validated immediately before the
 * call, the caller's abort signal is chained, and an internal timeout aborts
 * with a distinguishable reason so a timeout maps to
 * `PROVIDER_REQUEST_TIMEOUT` rather than a bare `AbortError`.
 */
export declare function fetchWithProviderGuards(fetchImpl: ProviderFetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response>;
/**
 * Read a JSON body with a size ceiling (`providers.ts:1825-1851`). The
 * `content-length` check is an early exit; the decoded-byte check is the one
 * that actually holds, since `content-length` is attacker-controlled.
 */
export declare function parseBoundedJsonResponse(response: Response): Promise<unknown>;
/**
 * Parse a model-provider response, mapping non-2xx to a classified error
 * (`providers.ts:1748-1769`). The source's `context` parameter only chose
 * between two error classes; this package has one, so the parameter is gone.
 */
export declare function readModelProviderResponse(response: Response): Promise<unknown>;
/**
 * Map an HTTP status plus error body onto a stable code
 * (`providers.ts:1783-1815`). Providers disagree on status codes for billing
 * and key problems, so the body text is inspected as well — the pattern lists
 * are verbatim from the source, including the Chinese-language variants the
 * source's providers actually return.
 */
export declare function classifyModelProviderHttpError(status: number, payload: unknown): string;
/** Join a normalized base URL with an API path, idempotently (`providers.ts:1949-1953`). */
export declare function modelApiUrl(baseUrl: string, suffix: string): string;
/**
 * Flatten a message content field to text (`providers.ts:1955-1971`). Both
 * dialects return either a string or an array of typed blocks.
 */
export declare function modelMessageText(value: unknown): string;
export declare function objectValue(value: unknown): Record<string, unknown> | undefined;
/** `providers.ts:2301-2308` — an empty completion does not prove a live key. */
export declare function assertLiveModelResponse(value: string): void;
// ==== @byok-sdk/keys dist/index.d.ts ====
export { ByokKeysError, BYOK_KEYS_ERROR_CODES } from './errors';
export type { ByokKeysErrorCode } from './errors';
export { MODEL_PROVIDER_ADAPTERS, MODEL_PROVIDER_KINDS, PROVIDER_AUTH_MODES, PROVIDER_MODEL_CAPABILITIES, ModelProviderProfileSchema, ProviderModelCapabilitySchema, ProviderProfileRefSchema, parseModelProviderProfile, exactProviderProfileBinding, assertExactProviderProfileBinding, } from './provider-profile';
export type { ModelProviderAdapter, ModelProviderKind, ModelProviderProfile, ModelProviderProfileInput, ExactProviderProfileBinding, ProviderAuthMode, ProviderModelCapability, ProviderProfileRef, } from './provider-profile';
export { MODEL_PROVIDER_VENDORS, MODEL_PROVIDER_VENDOR_IDS, modelProviderVendor, } from './provider-catalog';
export type { ModelProviderVendor, ModelProviderVendorId, } from './provider-catalog';
export { providerHeaders, requiredProviderSecret } from './headers';
export type { ProviderAuthProfile } from './headers';
export { normalizeProviderUrl, isLoopbackHost, isLoopbackProviderUrl, isPrivateNetworkLiteral, } from './url';
export { assertLiveModelResponse, classifyModelProviderHttpError, fetchWithProviderGuards, modelApiUrl, modelMessageText, objectValue, parseBoundedJsonResponse, PROVIDER_RESPONSE_MAX_BYTES, PROVIDER_TIMEOUT_MS, readModelProviderResponse, } from './http';
export type { ProviderFetch } from './http';
export { OpenAiCompatibleChatClient, chatCompletionText } from './openai-client';
export type { ChatCompletionRequest, ChatMessage, ModelProviderClientOptions, } from './openai-client';
export { AnthropicMessagesClient, anthropicMessageText } from './anthropic-client';
export type { AnthropicMessage, AnthropicMessageRequest, } from './anthropic-client';
export { runCommand } from './command-runner';
export type { CommandResult, CommandRunner } from './command-runner';
export { SECRET_NAME_PATTERN, SECRET_NAMESPACE_PATTERN, assertSecretName, assertSecretNamespace, } from './secret-name';
export { DEFAULT_SECRET_SERVICE_PREFIX, InMemorySecretStore, assertSharedSecretValue, decodeStrictBase64Utf8, modelProviderSecretName, } from './secret-store';
export type { ModelProviderSecretName, SecretStore } from './secret-store';
export { DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX, MacOsKeychainSecretStore, } from './macos-keychain';
export type { MacOsKeychainSecretStoreOptions } from './macos-keychain';
export { WindowsCredentialManagerSecretStore } from './windows-credential-manager';
export type { WindowsCredentialManagerSecretStoreOptions } from './windows-credential-manager';
export { DEFAULT_SECRET_ENVELOPE_PREFIX, EnvelopeScopedSecretStore, scopeSecretStore, secretScopeId, } from './secret-scope';
export type { SecretScope } from './secret-scope';
export { InMemoryProviderProfileStore } from './profile-store';
export type { ProviderProfileStore } from './profile-store';
export { isSqliteAvailable, loadSqliteModule, openSqliteDatabase, secureSqliteFilePermissions, } from './sqlite-support';
export { SqliteProviderProfileStore } from './sqlite-profile-store';
export type { SqliteProviderProfileStoreOptions } from './sqlite-profile-store';
export { PROVIDER_PROFILE_TRUTH_RECORD_KEY, TruthStoreProviderProfileStore, } from './truth-profile-store';
export type { TruthStoreProviderProfileStoreOptions } from './truth-profile-store';
export { ProviderRegistry } from './registry';
export type { ModelProviderClient, ProviderConfiguration, ProviderRegistryOptions, ProviderStatus, } from './registry';
export { PI_PROJECTED_KEY_ENV, buildPiProviderProjection, } from './pi-provider-projection';
// ==== @byok-sdk/keys dist/macos-keychain.d.ts ====
import { type CommandRunner } from './command-runner';
import { type SecretStore } from './secret-store';
/**
 * Marker written in front of every stored value so a read can tell a value this
 * package wrote from anything else already sitting at the same service name.
 * Injectable, so K4's aip-main-open swap passes `aiphabee-b64-v1:` and stays
 * byte-compatible with existing installs (source: `index.ts:246`).
 */
export declare const DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX = "byok-b64-v1:";
export interface MacOsKeychainSecretStoreOptions {
    /** Keychain account field; entries are addressed by (account, service). */
    account?: string;
    /**
     * Return a stored value that lacks {@link MacOsKeychainSecretStoreOptions.storagePrefix}
     * instead of throwing. Defaults to `false`.
     *
     * The source returned such values unconditionally
     * (`decodeMacOsKeychainSecret`, `index.ts:536-545`), which meant any
     * unrelated item at the same service name was handed back as if this package
     * had written it. Reading is fail-closed here, and the tolerant behavior is
     * demoted to something a caller must ask for by name — it exists only for a
     * migration that has read an unprefixed value it already knows it wrote.
     */
    allowUnprefixedRead?: boolean;
    commandRunner?: CommandRunner;
    /** Explicit macOS keychain file; omitted means the user default keychain. */
    keychainPath?: string;
    platform?: NodeJS.Platform;
    servicePrefix?: string;
    storagePrefix?: string;
}
/**
 * macOS Keychain backend, driving `/usr/bin/security`
 * (`aip-main-open@c6a5385` `apps/local-agent/src/index.ts:412-533`).
 *
 * There is deliberately no plaintext fallback: on a non-darwin platform every
 * operation throws `KEYCHAIN_UNAVAILABLE` rather than degrading to a file.
 */
export declare class MacOsKeychainSecretStore<TName extends string = string> implements SecretStore<TName> {
    #private;
    readonly providerLabel = "macOS Keychain";
    constructor(options?: MacOsKeychainSecretStoreOptions);
    available(): Promise<boolean>;
    delete(name: TName): Promise<boolean>;
    get(name: TName): Promise<string | undefined>;
    has(name: TName): Promise<boolean>;
    scope(namespace: string): SecretStore<TName>;
    set(name: TName, secret: string): Promise<void>;
}
// ==== @byok-sdk/keys dist/openai-client.d.ts ====
import { type ProviderFetch } from './http';
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
    response_format?: {
        type: string;
    };
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
export declare class OpenAiCompatibleChatClient {
    #private;
    readonly model: string;
    /** False only when the provider is loopback, i.e. no data leaves the machine. */
    readonly remoteDataTransfer: boolean;
    constructor(options: ModelProviderClientOptions);
    /** POST `<base_url>/chat/completions`; returns the parsed response object. */
    createChatCompletion(request: ChatCompletionRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
    /**
     * Round-trip the configured key against the provider
     * (`providers.ts:797-828`). An empty completion fails, so a provider that
     * accepts anything cannot be mistaken for a working configuration.
     */
    testConnection(signal?: AbortSignal): Promise<void>;
}
/**
 * Pull the assistant text out of a chat/completions payload
 * (`providers.ts:597-599` and siblings, which repeated this shape in every
 * narrative method).
 */
export declare function chatCompletionText(payload: Record<string, unknown>): string;
// ==== @byok-sdk/keys dist/pi-provider-projection.d.ts ====
import type { ModelProviderProfile } from './provider-profile';
export declare const PI_PROJECTED_KEY_ENV = "PI_PROVIDER_API_KEY";
/** Keep projected providers disjoint from Pi built-ins so composition can never fall back to one. */
export declare function piProjectionProviderId(profileRef: string): string;
/**
 * Credential-blind Pi configuration derived from one validated local profile.
 *
 * The projected provider is namespaced by the profile's own ref, not by its
 * provider kind, so two independently configured endpoints of the same kind
 * project to two distinct Pi providers instead of colliding on one. Model
 * `input` modalities are projected from the profile's declared capabilities —
 * declared local configuration is the only authority; nothing is inferred from
 * the model name or base URL.
 */
export declare function buildPiProviderProjection(profile: ModelProviderProfile): object;
/**
 * Validate the credential-blind RPC argv the client may delegate, then bind
 * the Pi child to the namespaced projection and exact configured model.
 */
export declare function buildPiProviderArgs(profile: ModelProviderProfile, delegatedArgs: readonly string[]): string[];
// ==== @byok-sdk/keys dist/profile-store.d.ts ====
import { ByokKeysError } from './errors';
import { type ModelProviderProfile, type ProviderProfileRef } from './provider-profile';
/**
 * Storage contract for provider profiles — everything needed to address a
 * provider except the API key, which lives in a {@link SecretStore}.
 *
 * Shaped after `@byok-sdk/server`'s `TaskStore` (`packages/server/src/task-store.ts`)
 * as a *pattern*, not a dependency: `keys` must not import `server`, and
 * `server` must not import `keys` (the plan's Security Boundary keeps the
 * agent-dispatch packages free of any credential-adjacent code).
 *
 * Two invariants every implementation MUST enforce, not just
 * {@link InMemoryProviderProfileStore}:
 *
 * 1. **At most one enabled profile.** The source expressed this as a partial
 *    unique index (`providers.ts:140-144`); saving an enabled profile disables
 *    every other one. {@link resolveDefaultModelProvider} relies on it to
 *    answer "which provider is the default" with a single row.
 * 2. **Validate on write.** `save` runs {@link parseModelProviderProfile}, so an
 *    invalid profile is refused at the boundary rather than discovered later by
 *    a reader.
 */
export interface ProviderProfileStore {
    /** Release the underlying resource. Safe to call more than once. */
    close(): Promise<void>;
    /** Remove `profileRef`; `false` when it was not configured. */
    delete(profileRef: ProviderProfileRef): Promise<boolean>;
    /** Read one profile, configured or not enabled alike. */
    get(profileRef: ProviderProfileRef): Promise<ModelProviderProfile | undefined>;
    /** The single enabled profile, or `undefined` when none is enabled. */
    getEnabled(): Promise<ModelProviderProfile | undefined>;
    /** Every configured profile, ordered by profile ref. */
    list(): Promise<ModelProviderProfile[]>;
    /** Insert or update `profile`, enforcing both invariants above. */
    save(profile: ModelProviderProfile): Promise<ModelProviderProfile>;
    /**
     * Make `profileRef` the enabled profile. Throws `PROVIDER_NOT_CONFIGURED`
     * when it has no profile — a fail-closed port of `providers.ts:1243-1250`.
     */
    setEnabled(profileRef: ProviderProfileRef): Promise<ModelProviderProfile>;
}
/** Shared by both implementations so their error text cannot drift apart. */
export declare function providerNotConfigured(profileRef: ProviderProfileRef): ByokKeysError;
/**
 * Profile store held in process memory: the default, and the one every test
 * that does not specifically exercise SQLite should use.
 *
 * Mirrors `InMemoryTaskStore`'s role in `@byok-sdk/server` — a real implementation
 * of the contract, not a stub, so behaviour proven here is the behaviour the
 * SQLite store must match (`profile-store.test.ts` runs one suite against both).
 */
export declare class InMemoryProviderProfileStore implements ProviderProfileStore {
    #private;
    close(): Promise<void>;
    delete(profileRef: ProviderProfileRef): Promise<boolean>;
    get(profileRef: ProviderProfileRef): Promise<ModelProviderProfile | undefined>;
    getEnabled(): Promise<ModelProviderProfile | undefined>;
    list(): Promise<ModelProviderProfile[]>;
    save(profile: ModelProviderProfile): Promise<ModelProviderProfile>;
    setEnabled(profileRef: ProviderProfileRef): Promise<ModelProviderProfile>;
}
// ==== @byok-sdk/keys dist/provider-catalog.d.ts ====
import type { ModelProviderAdapter, ProviderAuthMode } from './provider-profile';
/**
 * One vendor the SDK can address without the consumer typing its endpoint.
 *
 * Ported from the provider catalog deepseek-harness resolves its routes from:
 * pi-ai 0.84.2 `dist/providers/*.js` (the version the SDK's pinned
 * `@earendil-works/pi-coding-agent` 0.84.2 resolves) plus the harness's own
 * `packages/llm/llm-deepseek/src/index.ts` `PUBLIC_BASE_URL`, which agrees
 * with pi-ai's `deepseek` entry. Selection and the URL mapping rule are
 * recorded in `docs/researches/2026-09-06_deepseek-harness-provider-catalog-port.md`.
 *
 * Every field is declared configuration a consumer may copy into a
 * `ModelProviderProfile`; nothing here is read at request time, and a
 * profile still carries its own `base_url` so a self-hosted gateway for a
 * vendor stays expressible. `api_key_env` is the credential name the vendor's
 * own tooling reads; this package never reads it, and `@byok-sdk/client`'s
 * credential deny list must contain every value listed here.
 */
export interface ModelProviderVendor {
    readonly display_name: string;
    /**
     * Endpoint base in this package's suffix convention: an
     * `openai_compatible` client appends `chat/completions`, an `anthropic`
     * client appends `messages`. pi-ai's anthropic-dialect entries therefore
     * gain a `/v1` segment here; its OpenAI-dialect entries are verbatim.
     */
    readonly base_url: string;
    readonly adapter: ModelProviderAdapter;
    readonly auth_mode: Exclude<ProviderAuthMode, 'none'>;
    readonly api_key_env: string;
}
/**
 * Vendor id → declared endpoint facts. Ids are pi-ai's provider ids so a
 * profile's `provider_kind` names the same route deepseek-harness would.
 * Ordered by dialect, then alphabetically; order carries no meaning.
 */
export declare const MODEL_PROVIDER_VENDORS: {
    readonly 'ant-ling': ModelProviderVendor;
    readonly baseten: ModelProviderVendor;
    readonly cerebras: ModelProviderVendor;
    readonly deepseek: ModelProviderVendor;
    readonly groq: ModelProviderVendor;
    readonly huggingface: ModelProviderVendor;
    readonly moonshotai: ModelProviderVendor;
    readonly 'moonshotai-cn': ModelProviderVendor;
    readonly nvidia: ModelProviderVendor;
    readonly openai: ModelProviderVendor;
    readonly openrouter: ModelProviderVendor;
    readonly 'qwen-token-plan': ModelProviderVendor;
    readonly 'qwen-token-plan-cn': ModelProviderVendor;
    readonly together: ModelProviderVendor;
    readonly xai: ModelProviderVendor;
    readonly xiaomi: ModelProviderVendor;
    readonly 'xiaomi-token-plan-ams': ModelProviderVendor;
    readonly 'xiaomi-token-plan-cn': ModelProviderVendor;
    readonly 'xiaomi-token-plan-sgp': ModelProviderVendor;
    readonly zai: ModelProviderVendor;
    readonly 'zai-coding-cn': ModelProviderVendor;
    readonly anthropic: ModelProviderVendor;
    readonly fireworks: ModelProviderVendor;
    readonly 'kimi-coding': ModelProviderVendor;
    readonly minimax: ModelProviderVendor;
    readonly 'minimax-cn': ModelProviderVendor;
    readonly 'vercel-ai-gateway': ModelProviderVendor;
};
export type ModelProviderVendorId = keyof typeof MODEL_PROVIDER_VENDORS;
/** Catalog vendor ids; `MODEL_PROVIDER_KINDS` is this list plus `custom`. */
export declare const MODEL_PROVIDER_VENDOR_IDS: readonly ModelProviderVendorId[];
/**
 * The catalog entry for a provider kind, or `undefined` for `custom`, which
 * by definition declares everything itself.
 */
export declare function modelProviderVendor(kind: string): ModelProviderVendor | undefined;
// ==== @byok-sdk/keys dist/provider-profile.d.ts ====
import { z } from 'zod';
import { type ModelProviderVendorId } from './provider-catalog';
/**
 * Opaque, portable identity of one locally configured provider profile.
 *
 * This is the profile's primary key: it is a local logical id, never a path,
 * and several profiles may share one {@link MODEL_PROVIDER_KINDS} kind (two
 * independent `custom` endpoints, for example). It replaces the former
 * `MODEL_PROVIDER_IDS` primary key, which conflated instance identity with
 * provider kind and therefore allowed exactly one profile per kind.
 *
 * `@byok-sdk/protocol` declares the same lexical rule for the wire form in
 * `provider-profile-binding.ts`. The two definitions are deliberately parallel
 * rather than shared: the release graph (`scripts/release/check-package-graph.mjs`)
 * forbids `@byok-sdk/keys` from depending on any dispatch package, so the
 * device-local authority cannot import the wire authority. This mirrors how
 * `packages/protocol/src/blob.ts`'s `CONTENT_HASH_RE` restates
 * `packages/core/src/blob.ts`'s content-hash format across the same boundary.
 */
export declare const PROVIDER_PROFILE_REF_PATTERN: RegExp;
export declare const ProviderProfileRefSchema: z.ZodString;
export type ProviderProfileRef = z.infer<typeof ProviderProfileRefSchema>;
/**
 * Provider kinds this package knows how to address — the surviving half of the
 * former `MODEL_PROVIDER_IDS`. A kind says *what dialect family and vendor
 * shape* a profile is; {@link ProviderProfileRefSchema} says *which* profile.
 * Originally ported from `aip-main-open@c6a5385` `providers.ts:30-36`
 * (`LOCAL_MODEL_PROVIDER_IDS`); the list is now derived: every id in
 * {@link MODEL_PROVIDER_VENDORS}, plus `custom` for an endpoint the catalog
 * does not name. `provider-catalog.ts` is the single authority, and
 * `sqlite-profile-store.ts` generates its CHECK constraint from this list.
 */
export type ModelProviderKind = ModelProviderVendorId | 'custom';
export declare const MODEL_PROVIDER_KINDS: readonly [ModelProviderKind, ...ModelProviderKind[]];
/**
 * Bounded model capabilities a profile may declare. A capability is explicit
 * local configuration, never inferred from the model name or the base URL.
 */
export declare const PROVIDER_MODEL_CAPABILITIES: readonly ['image-input'];
export declare const ProviderModelCapabilitySchema: z.ZodEnum<{
    "image-input": "image-input";
}>;
export type ProviderModelCapability = z.infer<typeof ProviderModelCapabilitySchema>;
/** Auth modes a provider profile can request (`providers.ts:29`). */
export declare const PROVIDER_AUTH_MODES: readonly ['bearer', 'x_api_key', 'none'];
export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];
/**
 * Wire dialects. The source's `market_data` / `mcp_http` branch stays in
 * aip-main-open — this package ports the model branch only
 * (`providers.ts:38-61`, second union member).
 */
export declare const MODEL_PROVIDER_ADAPTERS: readonly ['openai_compatible', 'anthropic'];
export type ModelProviderAdapter = (typeof MODEL_PROVIDER_ADAPTERS)[number];
/**
 * A model provider profile: everything needed to address a provider except the
 * secret itself, which lives in the OS credential store.
 *
 * The adapter/auth-mode legality rules are the ones `normalizeProviderProfile`
 * enforced imperatively at `providers.ts:1522-1543`, moved into the schema so
 * there is one validation authority rather than a schema plus a normalizer.
 */
export declare const ModelProviderProfileSchema: z.ZodObject<{
    adapter: z.ZodEnum<{
        anthropic: "anthropic";
        openai_compatible: "openai_compatible";
    }>;
    auth_mode: z.ZodEnum<{
        bearer: "bearer";
        none: "none";
        x_api_key: "x_api_key";
    }>;
    base_url: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    capabilities: z.ZodArray<z.ZodEnum<{
        "image-input": "image-input";
    }>>;
    created_at: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    display_name: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    enabled: z.ZodBoolean;
    kind: z.ZodLiteral<"model">;
    model: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    profile_ref: z.ZodString;
    provider_kind: z.ZodEnum<{
        "ant-ling": "ant-ling";
        anthropic: "anthropic";
        baseten: "baseten";
        cerebras: "cerebras";
        custom: "custom";
        deepseek: "deepseek";
        fireworks: "fireworks";
        groq: "groq";
        huggingface: "huggingface";
        "kimi-coding": "kimi-coding";
        minimax: "minimax";
        "minimax-cn": "minimax-cn";
        moonshotai: "moonshotai";
        "moonshotai-cn": "moonshotai-cn";
        nvidia: "nvidia";
        openai: "openai";
        openrouter: "openrouter";
        "qwen-token-plan": "qwen-token-plan";
        "qwen-token-plan-cn": "qwen-token-plan-cn";
        together: "together";
        "vercel-ai-gateway": "vercel-ai-gateway";
        xai: "xai";
        xiaomi: "xiaomi";
        "xiaomi-token-plan-ams": "xiaomi-token-plan-ams";
        "xiaomi-token-plan-cn": "xiaomi-token-plan-cn";
        "xiaomi-token-plan-sgp": "xiaomi-token-plan-sgp";
        zai: "zai";
        "zai-coding-cn": "zai-coding-cn";
    }>;
    updated_at: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
}, z.core.$strip>;
/** Validated, normalized profile. */
export type ModelProviderProfile = z.infer<typeof ModelProviderProfileSchema>;
/** Pre-normalization shape callers may hand in. */
export type ModelProviderProfileInput = z.input<typeof ModelProviderProfileSchema>;
export interface ExactProviderProfileBinding {
    profileRef: ProviderProfileRef;
    profileRevision: string;
    profileHash: string;
    modelId: string;
    requiredCapabilities: readonly ProviderModelCapability[];
}
/**
 * Derive the credential-free wire identity from the normalized local record.
 * `updated_at` is the persisted monotonic revision authority; the hash covers
 * the complete normalized non-secret record with capability order
 * canonicalized. Secret values are not accepted by this type and therefore
 * cannot enter the digest or any mismatch message.
 */
export declare function exactProviderProfileBinding(profileInput: ModelProviderProfile, requiredCapabilities?: readonly ProviderModelCapability[]): ExactProviderProfileBinding;
/** Fail closed unless every offered binding field matches local authority. */
export declare function assertExactProviderProfileBinding(profile: ModelProviderProfile, expected: ExactProviderProfileBinding): void;
/**
 * Parse and normalize a profile, or throw {@link ByokKeysError}. Replaces the
 * source's `normalizeProviderProfile` (`providers.ts:1489-1556`) for the model
 * branch, preserving its error codes.
 */
export declare function parseModelProviderProfile(value: unknown): ModelProviderProfile;
// ==== @byok-sdk/keys dist/registry.d.ts ====
import { AnthropicMessagesClient } from './anthropic-client';
import type { ProviderFetch } from './http';
import { OpenAiCompatibleChatClient } from './openai-client';
import type { ProviderProfileStore } from './profile-store';
import { type ModelProviderAdapter, type ModelProviderKind, type ProviderAuthMode, type ProviderModelCapability, type ProviderProfileRef } from './provider-profile';
import { type ModelProviderSecretName, type SecretStore } from './secret-store';
/** A transport client for whichever dialect the resolved profile declares. */
export type ModelProviderClient = AnthropicMessagesClient | OpenAiCompatibleChatClient;
/**
 * What a caller supplies to {@link ProviderRegistry.configure}: the profile
 * minus the fields the registry owns (`kind`, both timestamps) and minus the
 * secret, which travels as a separate argument so it cannot be mistaken for
 * persisted data.
 */
export interface ProviderConfiguration {
    adapter: ModelProviderAdapter;
    auth_mode: ProviderAuthMode;
    base_url: string;
    /**
     * Bounded model capabilities this exact profile supports. Declared, never
     * inferred: an omitted capability means the endpoint does not offer it.
     */
    capabilities: readonly ProviderModelCapability[];
    display_name: string;
    /** Defaults to `true`: configuring a provider makes it the default. */
    enabled?: boolean;
    model: string;
    /** This profile's own local identity; several profiles may share one kind. */
    profile_ref: ProviderProfileRef;
    provider_kind: ModelProviderKind;
}
/**
 * The registry's outward projection of a profile.
 *
 * It reports **whether** a secret exists (`secret_configured`) and never the
 * secret itself — the property `registry.golden.test.ts` asserts, mirroring
 * `docs/researches/HANDOFF-byok-keys.md` §4.3's "status JSON contains no
 * plaintext key".
 */
export interface ProviderStatus {
    adapter: ModelProviderAdapter;
    auth_mode: ProviderAuthMode;
    base_url: string;
    capabilities: readonly ProviderModelCapability[];
    created_at: string;
    display_name: string;
    enabled: boolean;
    model: string;
    profile_ref: ProviderProfileRef;
    /** Canonical credential-free revision used by exact task admission. */
    profile_revision: string;
    /** SHA-256 of the normalized non-secret local record. */
    profile_hash: string;
    provider_kind: ModelProviderKind;
    /** Whether the credential store currently holds this profile's key. */
    secret_configured: boolean;
    updated_at: string;
}
export interface ProviderRegistryOptions {
    fetchImpl?: ProviderFetch;
    /** Injected clock, so tests get deterministic timestamps. */
    now?: () => Date;
    profileStore: ProviderProfileStore;
    secretStore: SecretStore<ModelProviderSecretName>;
}
/**
 * The configure/resolve boundary, ported from `providers.ts:1180-1229`
 * (`configure`) and `providers.ts:1331-1354` (`resolveDefaultModelProvider`).
 *
 * Both halves of a provider's configuration are written here and nowhere else:
 * the non-secret profile goes to the injected {@link ProviderProfileStore}, the
 * API key goes to the injected {@link SecretStore}. Splitting them is the whole
 * point of the package, so the registry is the only place that knows both.
 *
 * Two departures from the source, both required by
 * `docs/researches/HANDOFF-byok-keys.md` §4.5:
 *
 * - `resolveDefaultModelProvider` returns a transport client or `undefined`,
 *   and throws on a broken configuration. The source returned an
 *   `UnavailableNarrativeProvider` null-object carrying an error code, which is
 *   a narrative-domain symbol that stays in aip-main-open — and a degradation
 *   fallback this package's fail-closed rule does not permit. A caller that
 *   wants aip's behaviour catches `ByokKeysError` and reads `.code`, which is
 *   the same information the null-object carried.
 * - The source's `#migrateLegacyModelSecret` is not ported (legacy secret
 *   migration is out of scope per the plan).
 */
export declare class ProviderRegistry {
    #private;
    constructor(options: ProviderRegistryOptions);
    close(): Promise<void>;
    /**
     * Persist a provider's profile and, when supplied, its secret
     * (`providers.ts:1180-1229`).
     *
     * Order matters and is the source's: write the secret first, then require
     * that an authenticating profile actually has one, and only then save the
     * profile. A profile is therefore never persisted in a state that claims
     * authentication it cannot perform.
     */
    configure(configuration: ProviderConfiguration, secret?: string): Promise<ProviderStatus>;
    /** Remove a profile and its secret together. */
    delete(profileRef: ProviderProfileRef): Promise<boolean>;
    get(profileRef: ProviderProfileRef): Promise<ProviderStatus | undefined>;
    list(): Promise<ProviderStatus[]>;
    /**
     * Build a client for the one enabled provider (`providers.ts:1331-1354`).
     *
     * `undefined` means "nothing is configured", which is a legitimate state a
     * caller must handle. A configured-but-broken provider throws instead — a
     * missing secret or an unusable profile is a fault, not an absence.
     */
    resolveDefaultModelProvider(): Promise<ModelProviderClient | undefined>;
    /** Switch which configured profile is the default. */
    setDefaultModelProvider(profileRef: ProviderProfileRef): Promise<ProviderStatus>;
}
// ==== @byok-sdk/keys dist/secret-name.d.ts ====
/**
 * Legal secret-entry names, 3 to 96 characters.
 *
 * The source (`aip-main-open@c6a5385`, `apps/local-agent/src/index.ts:258-268`)
 * closed this set at compile time with the `KeychainSecretName` union, so it
 * needed no runtime check. `SecretStore<TName extends string>` is open by
 * design — aip's closed union stays in aip — so the closure moves to runtime.
 *
 * The exclusion that matters is `.`: every backend composes its storage key as
 * `` `${servicePrefix}.${name}` `` and a scoped store appends
 * `.scope.<namespace>` to that prefix. A name containing a dot could therefore
 * spell out another scope's service string and read that scope's secret. The
 * validator throws rather than sanitizing — a caller that mistyped a name must
 * see the error, not silently address a different entry.
 */
export declare const SECRET_NAME_PATTERN: RegExp;
/**
 * Legal scope namespaces, 8 to 96 characters. Ported verbatim from the source's
 * `normalizeSecretNamespace` (`index.ts:748-757`); the 8-character floor keeps
 * a namespace from colliding with a short accidental value.
 */
export declare const SECRET_NAMESPACE_PATTERN: RegExp;
/** Fail closed unless `name` matches {@link SECRET_NAME_PATTERN}. */
export declare function assertSecretName<TName extends string>(name: TName): TName;
/**
 * Trim and validate a scope namespace, or throw. Trimming is the source's
 * behavior and is safe because the pattern rejects every interior whitespace
 * character anyway.
 */
export declare function assertSecretNamespace(value: string): string;
// ==== @byok-sdk/keys dist/secret-scope.d.ts ====
import { type SecretStore } from './secret-store';
/**
 * Tenant identity a secret store is partitioned by. Ported from
 * `aip-main-open@c6a5385` `apps/local-agent/src/local-data-scope.ts:19-22`
 * (`LocalAccountDataScope`).
 */
export interface SecretScope {
    account_id: string;
    workspace_id: string;
}
/**
 * Envelope marker, injectable so K4 can pass the source's
 * `aiphabee-scoped-secrets-v1:` value (`local-data-scope.ts:30`).
 */
export declare const DEFAULT_SECRET_ENVELOPE_PREFIX = "byok-scoped-secrets-v1:";
/**
 * Derive the opaque namespace a scope's secrets live under
 * (`local-data-scope.ts:32-37`). Hashing means the namespace never leaks a
 * tenant identifier into a keychain service name a user can browse.
 */
export declare function secretScopeId(scope: SecretScope): string;
/**
 * Partition `store` by `scope` (`local-data-scope.ts:100-106`).
 *
 * The source read `store.scope?.(id) ?? new EnvelopeScopedSecretStore(...)`:
 * when a store happened not to implement `scope`, it silently switched to a
 * different storage layout. `SecretStore.scope` is required in this package, so
 * that implicit substitution is gone — a caller who wants envelope semantics
 * constructs {@link EnvelopeScopedSecretStore} on purpose.
 */
export declare function scopeSecretStore<TName extends string>(store: SecretStore<TName>, scope: SecretScope): SecretStore<TName>;
/**
 * Partition a store by keeping every scope's secret in one underlying entry,
 * as a JSON map of scope id to secret.
 *
 * This is the layout to reach for when the backend cannot cheaply namespace its
 * own key space. It costs a read-modify-write on every mutation and offers no
 * cross-process locking, so prefer a backend's native `scope()` when it has
 * one; this decorator exists for the backends that do not.
 *
 * Reads are fail-closed in a way the source's were not
 * (`local-data-scope.ts:163-194`): the source mapped any unparseable stored
 * value to `undefined`, which made a foreign value look like an absent secret
 * and let the next `set()` overwrite it. Here a stored value that is not a
 * well-formed envelope raises `SECRET_ENVELOPE_INVALID`.
 */
export declare class EnvelopeScopedSecretStore<TName extends string = string> implements SecretStore<TName> {
    #private;
    readonly providerLabel: string;
    constructor(store: SecretStore<TName>, scopeId: string, options?: {
        envelopePrefix?: string;
    });
    available(): Promise<boolean>;
    delete(name: TName): Promise<boolean>;
    get(name: TName): Promise<string | undefined>;
    has(name: TName): Promise<boolean>;
    scope(namespace: string): SecretStore<TName>;
    set(name: TName, secret: string): Promise<void>;
}
// ==== @byok-sdk/keys dist/secret-store.d.ts ====
import { type ProviderProfileRef } from './provider-profile';
/**
 * Storage contract for a single secret entry in an operating-system credential
 * store.
 *
 * Ported from `aip-main-open@c6a5385` `apps/local-agent/src/index.ts:261-269`
 * with two deliberate changes:
 *
 * 1. `TName` is a generic parameter rather than aip's closed
 *    `KeychainSecretName` union. aip's union names device keys, refresh tokens,
 *    and market-data entries that this package has no business knowing about,
 *    so it stays in aip and consumers pin their own union. The compile-time
 *    closure it provided is replaced at runtime by {@link assertSecretName},
 *    which every implementation must apply on every name it receives.
 * 2. `scope()` is required, not optional. The source made it optional and its
 *    `scopeLocalAgentSecretStore` silently substituted an envelope
 *    implementation when a store did not provide one. Scope-envelope prefixing
 *    has no installed base, so this package removes the implicit substitution:
 *    every store scopes itself, and {@link EnvelopeScopedSecretStore} is a
 *    decorator a caller applies on purpose.
 */
export interface SecretStore<TName extends string = string> {
    /** Human-readable backend name, safe to show a user. Never contains a secret. */
    readonly providerLabel: string;
    /** Whether this backend can be used on the current machine. Must not throw. */
    available(): Promise<boolean>;
    /** Remove `name`; `false` when it was already absent. */
    delete(name: TName): Promise<boolean>;
    /** Read `name`, or `undefined` when it is absent. */
    get(name: TName): Promise<string | undefined>;
    /** Whether `name` currently holds a secret. */
    has(name: TName): Promise<boolean>;
    /** A view of this store isolated under `namespace`. */
    scope(namespace: string): SecretStore<TName>;
    /** Write `secret` at `name`, replacing any existing value. */
    set(name: TName, secret: string): Promise<void>;
}
/**
 * Default service prefix for this package's own entries. `servicePrefix` is a
 * constructor option on both OS backends, so K4's aip-main-open swap passes its
 * `com.aiphabee.local-agent` value and keeps existing installs byte-compatible.
 */
export declare const DEFAULT_SECRET_SERVICE_PREFIX = "com.byok.keys";
/**
 * Credential-store entry name for one provider profile.
 *
 * The former fixed `MODEL_PROVIDER_SECRET_NAMES` table could name exactly one
 * entry per provider kind, so two independent `custom` endpoints would have
 * shared — and overwritten — a single credential. The name is now derived from
 * the profile's own {@link ProviderProfileRef}, keeping the shape
 * `providers.ts:1624-1632` established (`model-<id>-api-key`, no vendor
 * branding; the branding lives in the service prefix).
 */
export type ModelProviderSecretName = `model-${string}-api-key`;
/**
 * Resolve a provider profile ref to the credential-store entry holding its API
 * key. The ref is validated here as well as by the profile schema: this
 * function composes a storage address, so an unvalidated ref would be an
 * address-injection surface rather than merely an invalid record.
 */
export declare function modelProviderSecretName(profileRef: ProviderProfileRef): ModelProviderSecretName;
/**
 * The secret-shape invariant both OS backends share. Their size ceilings differ
 * in both magnitude and unit (macOS counts 16384 characters, Windows counts
 * 2560 UTF-8 bytes) and each reports its own error code, so those checks stay
 * in the backends; only the empty/control-character rule is common.
 */
export declare function assertSharedSecretValue(secret: string): void;
/**
 * Decode base64 to UTF-8 text, or return `undefined` — never a repaired
 * approximation.
 *
 * Both decode paths in Node are lenient in ways that matter here: `Buffer.from`
 * silently drops characters outside the base64 alphabet (so `"a!G@k="` would
 * decode to `"hi"`), and `Buffer#toString('utf8')` substitutes U+FFFD for
 * invalid byte sequences. A credential store that "successfully" returns a
 * silently-mangled secret is worse than one that fails, so the alphabet, the
 * canonical padding, and the UTF-8 round trip are all checked explicitly.
 */
export declare function decodeStrictBase64Utf8(encoded: string): string | undefined;
/**
 * A {@link SecretStore} held in process memory, for tests and for embedders
 * that supply their own persistence.
 *
 * It keys entries by the same `` `${servicePrefix}.${name}` `` string the OS
 * backends use, and `scope()` extends that prefix exactly as they do, so a test
 * written against this store exercises the same isolation arithmetic as
 * production. It applies the name validator and the shared secret-shape rule;
 * the platform size ceilings deliberately are not simulated, since they differ
 * per backend.
 */
export declare class InMemorySecretStore<TName extends string = string> implements SecretStore<TName> {
    #private;
    readonly providerLabel = "in-memory";
    constructor(options?: {
        /** Shared backing map; a scoped view keeps the parent's map. */
        entries?: Map<string, string>;
        servicePrefix?: string;
    });
    available(): Promise<boolean>;
    delete(name: TName): Promise<boolean>;
    get(name: TName): Promise<string | undefined>;
    has(name: TName): Promise<boolean>;
    scope(namespace: string): SecretStore<TName>;
    set(name: TName, secret: string): Promise<void>;
}
// ==== @byok-sdk/keys dist/sqlite-profile-store.d.ts ====
import { type ProviderProfileStore } from './profile-store';
import { type ModelProviderProfile, type ProviderProfileRef } from './provider-profile';
export interface SqliteProviderProfileStoreOptions {
    /**
     * Database file path. `:memory:` exercises the SQLite code path without a
     * temp file, but defeats the point of this store (restart-safety) exactly as
     * it does for `@byok-sdk/server`'s `SqliteTaskStore`.
     */
    path: string;
    /** Open an existing profile database without creating or mutating it. */
    readOnly?: boolean;
}
/**
 * SQLite-backed {@link ProviderProfileStore}, following `@byok-sdk/server`'s
 * `SqliteTaskStore` shape. Holds no secret: the API key lives in the injected
 * `SecretStore`, and `registry.golden.test.ts` asserts the plaintext key never
 * appears in this file's bytes.
 */
export declare class SqliteProviderProfileStore implements ProviderProfileStore {
    #private;
    constructor(options: SqliteProviderProfileStoreOptions);
    /**
     * Idempotent, as {@link ProviderProfileStore.close} requires: `node:sqlite`
     * throws "database is not open" on a second `close()`, and a store is
     * routinely closed both by the code that finished with it and by a test's
     * teardown.
     */
    close(): Promise<void>;
    delete(profileRef: ProviderProfileRef): Promise<boolean>;
    get(profileRef: ProviderProfileRef): Promise<ModelProviderProfile | undefined>;
    getEnabled(): Promise<ModelProviderProfile | undefined>;
    list(): Promise<ModelProviderProfile[]>;
    save(profile: ModelProviderProfile): Promise<ModelProviderProfile>;
    setEnabled(profileRef: ProviderProfileRef): Promise<ModelProviderProfile>;
}
/** Exported for the store's own tests to enumerate the CHECK-constrained kinds. */
export declare const SQLITE_PROFILE_PROVIDER_KINDS: readonly [import("./provider-profile").ModelProviderKind, ...import("./provider-profile").ModelProviderKind[]];
// ==== @byok-sdk/keys dist/sqlite-support.d.ts ====
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';
export type SqliteOpenStep = 'after-open' | 'after-wal' | 'after-synchronous';
/** Test-only seam for proving that post-open initialization failures release the native handle. */
export interface SqliteOpenFaultSeam {
    onStep?(step: SqliteOpenStep): void;
    close?(database: DatabaseSync): void;
}
/** Release an opened handle before propagating an initialization failure. */
export declare function closeSqliteDatabaseAfterInitializationFailure(database: DatabaseSync, initializationError: unknown, message: string, close?: (database: DatabaseSync) => void): never;
interface SqliteModule {
    DatabaseSync: new (path: string, options?: DatabaseSyncOptions) => DatabaseSync;
}
/**
 * Load `node:sqlite`, or fail with a `ByokKeysError` that says why.
 *
 * `node:sqlite` shipped in Node.js 22.5.0 and stays marked experimental (an
 * `ExperimentalWarning` on stderr is expected and harmless). Following
 * `@byok-sdk/server`'s `sqlite-support.ts`, the SQLite-backed store here depends on
 * nothing else — no `better-sqlite3`, no native module — because zero native
 * dependencies is what keeps this package trivially packageable. The tradeoff
 * is that {@link SqliteProviderProfileStore} does not work below Node 22.5, and
 * this error says so instead of letting a cryptic `Cannot find module` surface
 * from deep inside a query.
 */
export declare function loadSqliteModule(): SqliteModule;
/**
 * Whether `node:sqlite` can ACTUALLY be loaded right now.
 *
 * Same predicate as `@byok-sdk/server`'s `sqlite-support.ts`, and it exists for the
 * same reason: this package's `engines.node` is `>=20` and CI runs the matrix
 * on 20 and 22, but `node:sqlite` shipped in 22.5 and stayed behind
 * `--experimental-sqlite` for part of the 22.x line. A version-number
 * comparison would therefore be wrong in both directions, so this attempts the
 * real require via {@link loadSqliteModule} and reports whether it succeeded.
 *
 * Callers use it to skip a SQLite-backed path rather than fail it — the
 * package's own SQLite-backed suites gate on it — and anything else should call
 * it before assuming a {@link SqliteProviderProfileStore} can be constructed.
 */
export declare function isSqliteAvailable(): boolean;
/**
 * Open a database, creating its parent directory owner-only first. `:memory:`
 * skips every filesystem step, which is how the shared contract suite exercises
 * the SQLite code path without leaving anything on disk.
 */
export declare function openSqliteDatabase(path: string, options?: DatabaseSyncOptions, faults?: SqliteOpenFaultSeam): DatabaseSync;
/**
 * Restrict `databasePath` and its WAL/SHM siblings to owner-only read/write.
 *
 * The profile table holds no secret — that is the whole point of splitting the
 * key into the OS credential store — but it does hold every provider endpoint
 * this machine talks to, and the source locked the file down
 * (`providers.ts:158`), so the port keeps that. Call after the schema exists,
 * so the lazily-created WAL/SHM files are already there; a sibling that does
 * not exist is skipped rather than treated as an error. No-op for `:memory:`.
 */
export declare function secureSqliteFilePermissions(databasePath: string): void;
export {};
// ==== @byok-sdk/keys dist/truth-profile-store.d.ts ====
import { type TenantId, type TruthStore } from '@byok-sdk/core';
import { type ProviderProfileStore } from './profile-store';
import { type ModelProviderProfile, type ProviderProfileRef } from './provider-profile';
export declare const PROVIDER_PROFILE_TRUTH_RECORD_KEY = "byok-sdk.keys/model-provider-registry-v1";
/**
 * Upper bound on how many profiles one tenant's registry snapshot may carry.
 *
 * The former bound was `MODEL_PROVIDER_IDS.length`, which only held because the
 * primary key was a four-value enum. Profile refs are open, so the CAS body
 * needs an explicit ceiling of its own; a registry is device-local operator
 * configuration, and 32 endpoints is far past any real local setup while
 * keeping the single-record snapshot small.
 */
export declare const MAX_PROVIDER_PROFILES = 32;
export interface TruthStoreProviderProfileStoreOptions {
    tenant: TenantId;
    truthStore: TruthStore;
}
/**
 * Tenant-bound profile persistence over the core TruthStore snapshot contract.
 *
 * The complete, closed provider registry is one CAS unit. That is what makes a
 * delete and the "at most one enabled profile" transition atomic without
 * adding a second transaction authority. The body is metadata only; provider
 * credentials remain exclusively in the independently injected SecretStore.
 */
export declare class TruthStoreProviderProfileStore implements ProviderProfileStore {
    #private;
    constructor(options: TruthStoreProviderProfileStoreOptions);
    close(): Promise<void>;
    delete(profileRef: ProviderProfileRef): Promise<boolean>;
    get(profileRef: ProviderProfileRef): Promise<ModelProviderProfile | undefined>;
    getEnabled(): Promise<ModelProviderProfile | undefined>;
    list(): Promise<ModelProviderProfile[]>;
    save(profile: ModelProviderProfile): Promise<ModelProviderProfile>;
    setEnabled(profileRef: ProviderProfileRef): Promise<ModelProviderProfile>;
}
// ==== @byok-sdk/keys dist/url.d.ts ====
/**
 * Normalize a provider base URL, fail-closed.
 *
 * Ported from `aip-main-open@c6a5385` `providers.ts:1558-1588` plus the two
 * host predicates at `:2216-2242`. Rules, unchanged:
 * - must be an absolute URL;
 * - no embedded credentials, no fragment, no query string;
 * - HTTPS only, except that HTTP is allowed for loopback hosts;
 * - private-network literals are rejected unless they are loopback;
 * - one trailing slash is stripped.
 */
export declare function normalizeProviderUrl(value: string): string;
/** Whether an already-parseable provider URL points at a loopback host. */
export declare function isLoopbackProviderUrl(value: string): boolean;
export declare function isLoopbackHost(hostname: string): boolean;
/**
 * Conservative private-network literal check. Any IPv6 literal counts as
 * private (the `:` branch), matching the source: the guard cannot cheaply
 * classify IPv6 ranges, so it refuses all of them and lets hostnames through.
 */
export declare function isPrivateNetworkLiteral(hostname: string): boolean;
// ==== @byok-sdk/keys dist/windows-credential-manager.d.ts ====
import { type CommandRunner } from './command-runner';
import { type SecretStore } from './secret-store';
export interface WindowsCredentialManagerSecretStoreOptions {
    account?: string;
    commandRunner?: CommandRunner;
    platform?: NodeJS.Platform;
    servicePrefix?: string;
}
/**
 * Windows Credential Manager backend (`index.ts:568-712`).
 *
 * As on macOS there is no plaintext fallback — off win32 every operation throws
 * `CREDENTIAL_MANAGER_UNAVAILABLE`.
 */
export declare class WindowsCredentialManagerSecretStore<TName extends string = string> implements SecretStore<TName> {
    #private;
    readonly providerLabel = "Windows Credential Manager";
    constructor(options?: WindowsCredentialManagerSecretStoreOptions);
    available(): Promise<boolean>;
    /**
     * Delete, then read back. The source verifies rather than trusting the
     * delete's exit code (`index.ts:651-679`): a credential that survives a
     * "successful" delete is a security failure, so it is reported as one instead
     * of being returned as `true`.
     */
    delete(name: TName): Promise<boolean>;
    get(name: TName): Promise<string | undefined>;
    has(name: TName): Promise<boolean>;
    scope(namespace: string): SecretStore<TName>;
    set(name: TName, secret: string): Promise<void>;
}

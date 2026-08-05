import { ByokKeysError } from './errors';
import type { ModelProviderId } from './provider-profile';
import { assertSecretName, assertSecretNamespace } from './secret-name';

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
export const DEFAULT_SECRET_SERVICE_PREFIX = 'com.byok.keys';

/**
 * Credential-store entry name per model provider, ported verbatim from
 * `providers.ts:1624-1632`. The names carry no vendor branding — the branding
 * lives in the service prefix — so they travel unchanged and K4 needs no
 * migration.
 */
export const MODEL_PROVIDER_SECRET_NAMES = {
  anthropic: 'model-anthropic-api-key',
  custom: 'model-custom-api-key',
  deepseek: 'model-deepseek-api-key',
  openai: 'model-openai-api-key',
} as const satisfies Record<ModelProviderId, string>;

export type ModelProviderSecretName =
  (typeof MODEL_PROVIDER_SECRET_NAMES)[keyof typeof MODEL_PROVIDER_SECRET_NAMES];

/** Resolve a provider id to the credential-store entry holding its API key. */
export function modelProviderSecretName(
  providerId: ModelProviderId,
): ModelProviderSecretName {
  return MODEL_PROVIDER_SECRET_NAMES[providerId];
}

/**
 * The secret-shape invariant both OS backends share. Their size ceilings differ
 * in both magnitude and unit (macOS counts 16384 characters, Windows counts
 * 2560 UTF-8 bytes) and each reports its own error code, so those checks stay
 * in the backends; only the empty/control-character rule is common.
 */
export function assertSharedSecretValue(secret: string): void {
  if (secret.length === 0 || /[\u0000\r\n]/u.test(secret)) {
    throw new ByokKeysError(
      'SECRET_VALUE_INVALID',
      'Secret must be a non-empty string without null or newline characters',
    );
  }
}

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
export function decodeStrictBase64Utf8(encoded: string): string | undefined {
  if (encoded.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return undefined;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return undefined;
  return text;
}

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
export class InMemorySecretStore<TName extends string = string>
  implements SecretStore<TName>
{
  readonly providerLabel = 'in-memory';
  readonly #entries: Map<string, string>;
  readonly #servicePrefix: string;

  constructor(
    options: {
      /** Shared backing map; a scoped view keeps the parent's map. */
      entries?: Map<string, string>;
      servicePrefix?: string;
    } = {},
  ) {
    this.#entries = options.entries ?? new Map();
    this.#servicePrefix = options.servicePrefix ?? DEFAULT_SECRET_SERVICE_PREFIX;
  }

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async delete(name: TName): Promise<boolean> {
    return this.#entries.delete(this.#service(name));
  }

  async get(name: TName): Promise<string | undefined> {
    return this.#entries.get(this.#service(name));
  }

  async has(name: TName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  scope(namespace: string): SecretStore<TName> {
    return new InMemorySecretStore<TName>({
      entries: this.#entries,
      servicePrefix: `${this.#servicePrefix}.scope.${assertSecretNamespace(namespace)}`,
    });
  }

  async set(name: TName, secret: string): Promise<void> {
    const service = this.#service(name);
    assertSharedSecretValue(secret);
    this.#entries.set(service, secret);
  }

  #service(name: TName): string {
    return `${this.#servicePrefix}.${assertSecretName(name)}`;
  }
}

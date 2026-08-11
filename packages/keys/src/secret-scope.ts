import { createHash } from 'node:crypto';

import { ByokKeysError } from './errors';
import { assertSecretName, assertSecretNamespace } from './secret-name';
import { type SecretStore, assertSharedSecretValue } from './secret-store';

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
export const DEFAULT_SECRET_ENVELOPE_PREFIX = 'byok-scoped-secrets-v1:';

/**
 * Derive the opaque namespace a scope's secrets live under
 * (`local-data-scope.ts:32-37`). Hashing means the namespace never leaks a
 * tenant identifier into a keychain service name a user can browse.
 */
export function secretScopeId(scope: SecretScope): string {
  const normalized = normalizeSecretScope(scope);
  return `acct_${createHash('sha256')
    .update(`${normalized.account_id}\n${normalized.workspace_id}`, 'utf8')
    .digest('hex')}`;
}

/**
 * Partition `store` by `scope` (`local-data-scope.ts:100-106`).
 *
 * The source read `store.scope?.(id) ?? new EnvelopeScopedSecretStore(...)`:
 * when a store happened not to implement `scope`, it silently switched to a
 * different storage layout. `SecretStore.scope` is required in this package, so
 * that implicit substitution is gone — a caller who wants envelope semantics
 * constructs {@link EnvelopeScopedSecretStore} on purpose.
 */
export function scopeSecretStore<TName extends string>(
  store: SecretStore<TName>,
  scope: SecretScope,
): SecretStore<TName> {
  return store.scope(secretScopeId(scope));
}

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
export class EnvelopeScopedSecretStore<TName extends string = string>
  implements SecretStore<TName>
{
  readonly providerLabel: string;
  readonly #envelopePrefix: string;
  readonly #scopeId: string;
  readonly #store: SecretStore<TName>;

  constructor(
    store: SecretStore<TName>,
    scopeId: string,
    options: { envelopePrefix?: string } = {},
  ) {
    this.#store = store;
    this.#scopeId = assertScopeSlotKey(scopeId);
    this.#envelopePrefix =
      options.envelopePrefix ?? DEFAULT_SECRET_ENVELOPE_PREFIX;
    this.providerLabel = store.providerLabel;
  }

  available(): Promise<boolean> {
    return this.#store.available();
  }

  async delete(name: TName): Promise<boolean> {
    const envelope = await this.#readEnvelope(name);
    if (envelope === undefined || !Object.hasOwn(envelope, this.#scopeId)) {
      return false;
    }
    delete envelope[this.#scopeId];
    if (Object.keys(envelope).length === 0) return this.#store.delete(name);
    await this.#store.set(name, this.#serialize(envelope));
    return true;
  }

  async get(name: TName): Promise<string | undefined> {
    return (await this.#readEnvelope(name))?.[this.#scopeId];
  }

  async has(name: TName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  scope(namespace: string): SecretStore<TName> {
    return new EnvelopeScopedSecretStore<TName>(
      this.#store,
      `${this.#scopeId}.${assertSecretNamespace(namespace)}`,
      { envelopePrefix: this.#envelopePrefix },
    );
  }

  async set(name: TName, secret: string): Promise<void> {
    assertSharedSecretValue(secret);
    const envelope =
      (await this.#readEnvelope(name)) ??
      (Object.create(null) as Record<string, string>);
    envelope[this.#scopeId] = secret;
    await this.#store.set(name, this.#serialize(envelope));
  }

  /**
   * `undefined` means the entry is absent; a malformed entry throws.
   *
   * The returned map has a null prototype. A slot key is attacker-adjacent
   * data — `constructor` is a legal namespace (`toString` and `__proto__` are
   * rejected by the pattern, but this defense does not depend on the pattern's
   * shape) — so a plain object would answer `envelope[scopeId]` from
   * `Object.prototype` and hand a Function back as a scope's secret.
   */
  async #readEnvelope(
    name: TName,
  ): Promise<Record<string, string> | undefined> {
    const stored = await this.#store.get(assertSecretName(name));
    if (stored === undefined) return undefined;
    if (!stored.startsWith(this.#envelopePrefix)) throw envelopeInvalid();
    const decoded = decodeBase64Url(stored.slice(this.#envelopePrefix.length));
    if (decoded === undefined) throw envelopeInvalid();
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw envelopeInvalid();
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== 'string')
    ) {
      throw envelopeInvalid();
    }
    return Object.assign(
      Object.create(null) as Record<string, string>,
      parsed as Record<string, string>,
    );
  }

  #serialize(value: Record<string, string>): string {
    return `${this.#envelopePrefix}${Buffer.from(
      JSON.stringify(value),
      'utf8',
    ).toString('base64url')}`;
  }
}

/**
 * Validate an envelope slot key: one or more namespaces joined by `.`, as
 * {@link EnvelopeScopedSecretStore.scope} composes them. Each segment must pass
 * {@link assertSecretNamespace} on its own, so a nested key cannot smuggle in a
 * segment the validator would otherwise reject.
 *
 * Unlike a backend service string, a `.` is safe here: the key addresses a JSON
 * object property, not a `` `${servicePrefix}.${name}` `` lookup, so it cannot
 * be confused with a different entry.
 *
 * Addressing a JSON object property carries its own hazard, though: the
 * namespace pattern admits `constructor` (`toString` and `__proto__` it
 * rejects), so a slot lookup on a plain object would resolve through
 * `Object.prototype` and report a never-written scope as present.
 * {@link EnvelopeScopedSecretStore} closes that by keeping every envelope
 * null-prototyped and testing slot presence with `Object.hasOwn` — a defense
 * that does not depend on the pattern's shape, which is why `constructor`
 * stays a legal namespace rather than being banned.
 */
function assertScopeSlotKey(value: string): string {
  return value
    .trim()
    .split('.')
    .map((segment) => assertSecretNamespace(segment))
    .join('.');
}

function envelopeInvalid(): ByokKeysError {
  return new ByokKeysError(
    'SECRET_ENVELOPE_INVALID',
    'The stored value is not a well-formed scoped-secret envelope',
  );
}

/** Strict base64url decode; `undefined` rather than a repaired approximation. */
function decodeBase64Url(encoded: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) return undefined;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return undefined;
  return text;
}

/**
 * `local-data-scope.ts:108-121`, plus one tightening: control characters are
 * rejected. The scope id hashes `` `${account_id}\n${workspace_id}` ``, so an
 * account id containing a newline would collide with a different scope
 * (`"a\nb" + "c"` and `"a" + "b\nc"` both serialize to `"a\nb\nc"`). Rejecting
 * them closes the collision without changing the hash of any legal input.
 */
function normalizeSecretScope(scope: SecretScope): SecretScope {
  const accountId = scope.account_id.trim();
  const workspaceId = scope.workspace_id.trim();
  if (
    !accountId ||
    !workspaceId ||
    accountId.length > 160 ||
    workspaceId.length > 160 ||
    /[\u0000\r\n]/u.test(accountId) ||
    /[\u0000\r\n]/u.test(workspaceId)
  ) {
    throw new ByokKeysError(
      'LOCAL_ACCOUNT_SCOPE_INVALID',
      'The local account data scope is invalid',
    );
  }
  return { account_id: accountId, workspace_id: workspaceId };
}

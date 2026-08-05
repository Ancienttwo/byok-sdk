import { ByokKeysError } from './errors';

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
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,95}$/u;

/**
 * Legal scope namespaces, 8 to 96 characters. Ported verbatim from the source's
 * `normalizeSecretNamespace` (`index.ts:748-757`); the 8-character floor keeps
 * a namespace from colliding with a short accidental value.
 */
export const SECRET_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{7,95}$/u;

/** Fail closed unless `name` matches {@link SECRET_NAME_PATTERN}. */
export function assertSecretName<TName extends string>(name: TName): TName {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new ByokKeysError(
      'SECRET_NAME_INVALID',
      'Secret name must be 3 to 96 characters of [a-z0-9_-] starting with a letter or digit',
    );
  }
  return name;
}

/**
 * Trim and validate a scope namespace, or throw. Trimming is the source's
 * behavior and is safe because the pattern rejects every interior whitespace
 * character anyway.
 */
export function assertSecretNamespace(value: string): string {
  const normalized = value.trim();
  if (!SECRET_NAMESPACE_PATTERN.test(normalized)) {
    throw new ByokKeysError(
      'SECRET_NAMESPACE_INVALID',
      'Secret namespace must be 8 to 96 characters of [a-z0-9_-] starting with a letter or digit',
    );
  }
  return normalized;
}

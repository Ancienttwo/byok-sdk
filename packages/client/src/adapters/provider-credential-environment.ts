import { PI_PROVIDER_ENV_KEY_NAMES } from './pi/pi-provider-env.generated';

/**
 * The env name `@byok-sdk/keys` projects the resolved key under. Restated, not
 * imported: the client has no keys dependency (`check-package-graph.mjs`);
 * `prepared-provider-consent.test.ts` pins the restatement. The keys launcher
 * deletes any ambient copy and injects only the credential it just resolved
 * from OS custody, so it must never be inherited from the daemon.
 */
export const PI_PROJECTED_KEY_ENV = 'PI_PROVIDER_API_KEY';

/** Credentials pi reads from the ambient environment outside its provider key map. */
export const PI_AMBIENT_CREDENTIAL_ENV_NAMES = Object.freeze([
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const);

/**
 * Codex 0.159.2 auth inputs; CLI-owned login discovery (e.g. CODEX_HOME) is
 * configuration and deliberately not part of this bounded credential set.
 */
export const CODEX_AUTH_ENV_NAMES = Object.freeze(['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'] as const);

/**
 * Provider credential names. The Pi BYOK key lanes and the Pi MCP servers
 * must not inherit them (BYOK key custody): every name the pinned pi reads for
 * a provider (generated, so a pi upgrade cannot leave one out), plus the
 * explicitly justified extras above.
 */
export const PROVIDER_CREDENTIAL_ENV_DENY_NAMES: readonly string[] = Object.freeze([
  ...PI_PROVIDER_ENV_KEY_NAMES,
  ...PI_AMBIENT_CREDENTIAL_ENV_NAMES,
  ...CODEX_AUTH_ENV_NAMES,
  PI_PROJECTED_KEY_ENV,
]);

const credentialNames = new Set<string>(PROVIDER_CREDENTIAL_ENV_DENY_NAMES);

/** Return a copy that cannot pass ambient provider credentials to a child. */
export function withoutProviderCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  // Match Windows case aliases too.
  for (const name of Object.keys(sanitized)) {
    if (credentialNames.has(name.toUpperCase())) delete sanitized[name];
  }
  return sanitized;
}

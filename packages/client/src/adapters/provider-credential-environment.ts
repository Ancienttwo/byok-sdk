import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '@byok-sdk/implementation-identity';
export { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '@byok-sdk/implementation-identity';

/**
 * Provider credential names that the daemon may explicitly admit for the
 * legacy direct-Pi path. Subscription runtimes and the BYOK custody launcher
 * must not inherit them.
 *
 * This list contains names only. Credential values remain owned by the
 * caller's environment or by the separate keys launcher.
 */
export const PROVIDER_CREDENTIAL_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
] as const;

const credentialNames = new Set<string>(PROVIDER_CREDENTIAL_ENV_DENY_NAMES);

/** Return a copy that cannot pass ambient provider credentials to a child. */
export function withoutProviderCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  // Match the measurement projection, including Windows case aliases.
  for (const name of Object.keys(sanitized)) {
    if (credentialNames.has(name.toUpperCase())) delete sanitized[name];
  }
  return sanitized;
}

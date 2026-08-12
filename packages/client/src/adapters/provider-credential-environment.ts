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

/**
 * Credential-shaped names stripped at subscription/BYOK custody boundaries.
 * This is intentionally a superset of the small legacy-Pi allowlist above:
 * denying a credential is safe, while allowing every cloud credential Pi
 * could consume would regress the daemon's ambient-environment isolation.
 */
export const PROVIDER_CREDENTIAL_ENV_DENY_NAMES = [
  ...PROVIDER_CREDENTIAL_ENV_NAMES,
  'ANT_LING_API_KEY',
  'NVIDIA_API_KEY',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_CODING_CN_API_KEY',
  'OPENCODE_API_KEY',
  'RADIUS_API_KEY',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'BASETEN_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  // Reserved by the keys-owned Pi projection. It must never be inherited
  // from the daemon; the launcher deletes any ambient copy and injects only
  // the exact credential it just resolved from OS custody.
  'PI_PROVIDER_API_KEY',
] as const;

/** Return a copy that cannot pass ambient provider credentials to a child. */
export function withoutProviderCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const name of PROVIDER_CREDENTIAL_ENV_DENY_NAMES) {
    delete sanitized[name];
  }
  return sanitized;
}

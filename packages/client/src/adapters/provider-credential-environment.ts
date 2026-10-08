/**
 * Provider credential names. The Pi BYOK key lanes and the Pi MCP servers
 * must not inherit them (BYOK key custody).
 */
export const PROVIDER_CREDENTIAL_ENV_DENY_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  // Codex 0.159.2 auth inputs; CLI-owned login discovery (e.g. CODEX_HOME)
  // is configuration and deliberately not part of this bounded credential set.
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
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
  'HF_TOKEN',
  'MOONSHOT_API_KEY',
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
] as const);

/**
 * Provider credential names that the daemon may explicitly admit for the
 * legacy direct-Pi path. The Pi BYOK custody launcher must not inherit them.
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
  // Match Windows case aliases too.
  for (const name of Object.keys(sanitized)) {
    if (credentialNames.has(name.toUpperCase())) delete sanitized[name];
  }
  return sanitized;
}

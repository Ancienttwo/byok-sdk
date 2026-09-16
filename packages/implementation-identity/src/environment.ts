/** Fixed credential-name projection shared by measurement and client stripping. */
export const PROVIDER_CREDENTIAL_ENV_DENY_NAMES = Object.freeze([
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

export const LOADER_ENV_DENY_PATTERNS: readonly string[] = Object.freeze([
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_PATH',
  'BUN_*',
  'DYLD_*',
  'LD_*',
  // The shell half of the same problem. A variable that makes a shell run
  // code, trace itself, or resolve `cd` somewhere else is loader injection
  // against the POSIX bootstrap exactly as NODE_OPTIONS is against a Node one:
  //
  // - ENV / BASH_ENV: a file the shell sources before the `-c` program text.
  // - SHELLOPTS / BASHOPTS: bash invoked as `sh` imports these from the
  //   environment and applies them before the script — `SHELLOPTS=xtrace`
  //   alone writes `+ cd ...` trace lines onto the server's stderr, observed
  //   on bash 5.2.37.
  // - CDPATH: makes a RELATIVE `cd` argument land somewhere else entirely. The
  //   launcher passes an absolute realpath, so this is the second line of the
  //   same defence.
  // - PS4: the trace prefix, which is expanded — command substitution
  //   included — whenever tracing is on.
  'ENV',
  'BASH_ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'CDPATH',
  'PS4',
]);

function matchesPattern(name: string, pattern: string, caseInsensitive: boolean): boolean {
  const candidateName = caseInsensitive ? name.toUpperCase() : name;
  const candidatePattern = caseInsensitive ? pattern.toUpperCase() : pattern;
  return candidatePattern.endsWith('*')
    ? candidateName.startsWith(candidatePattern.slice(0, -1))
    : candidateName === candidatePattern;
}

function matchesAny(name: string, patterns: readonly string[], caseInsensitive: boolean): boolean {
  return patterns.some((pattern) => matchesPattern(name, pattern, caseInsensitive));
}

export function loaderEnvInjections(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const caseInsensitive = platform === 'win32';
  return Object.keys(env)
    .filter((name) => env[name] !== undefined
      && matchesAny(name, LOADER_ENV_DENY_PATTERNS, caseInsensitive))
    .sort();
}

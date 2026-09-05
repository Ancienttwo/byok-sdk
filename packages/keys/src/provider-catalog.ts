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

function openAiCompatible(
  display_name: string,
  base_url: string,
  api_key_env: string,
): ModelProviderVendor {
  return {
    display_name,
    base_url,
    adapter: 'openai_compatible',
    auth_mode: 'bearer',
    api_key_env,
  };
}

function anthropicMessages(
  display_name: string,
  base_url: string,
  api_key_env: string,
): ModelProviderVendor {
  return {
    display_name,
    base_url,
    adapter: 'anthropic',
    auth_mode: 'x_api_key',
    api_key_env,
  };
}

/**
 * Vendor id → declared endpoint facts. Ids are pi-ai's provider ids so a
 * profile's `provider_kind` names the same route deepseek-harness would.
 * Ordered by dialect, then alphabetically; order carries no meaning.
 */
export const MODEL_PROVIDER_VENDORS = {
  'ant-ling': openAiCompatible('Ant Ling', 'https://api.ant-ling.com/v1', 'ANT_LING_API_KEY'),
  baseten: openAiCompatible('Baseten', 'https://inference.baseten.co/v1', 'BASETEN_API_KEY'),
  cerebras: openAiCompatible('Cerebras', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY'),
  deepseek: openAiCompatible('DeepSeek', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY'),
  groq: openAiCompatible('Groq', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY'),
  huggingface: openAiCompatible('Hugging Face', 'https://router.huggingface.co/v1', 'HF_TOKEN'),
  moonshotai: openAiCompatible('Moonshot AI', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY'),
  'moonshotai-cn': openAiCompatible('Moonshot AI CN', 'https://api.moonshot.cn/v1', 'MOONSHOT_API_KEY'),
  nvidia: openAiCompatible('NVIDIA', 'https://integrate.api.nvidia.com/v1', 'NVIDIA_API_KEY'),
  openai: openAiCompatible('OpenAI', 'https://api.openai.com/v1', 'OPENAI_API_KEY'),
  openrouter: openAiCompatible('OpenRouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY'),
  'qwen-token-plan': openAiCompatible(
    'Qwen Token Plan',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    'QWEN_TOKEN_PLAN_API_KEY',
  ),
  'qwen-token-plan-cn': openAiCompatible(
    'Qwen Token Plan CN',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'QWEN_TOKEN_PLAN_CN_API_KEY',
  ),
  together: openAiCompatible('Together', 'https://api.together.ai/v1', 'TOGETHER_API_KEY'),
  xai: openAiCompatible('xAI', 'https://api.x.ai/v1', 'XAI_API_KEY'),
  xiaomi: openAiCompatible('Xiaomi', 'https://api.xiaomimimo.com/v1', 'XIAOMI_API_KEY'),
  'xiaomi-token-plan-ams': openAiCompatible(
    'Xiaomi Token Plan AMS',
    'https://token-plan-ams.xiaomimimo.com/v1',
    'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  ),
  'xiaomi-token-plan-cn': openAiCompatible(
    'Xiaomi Token Plan CN',
    'https://token-plan-cn.xiaomimimo.com/v1',
    'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  ),
  'xiaomi-token-plan-sgp': openAiCompatible(
    'Xiaomi Token Plan SGP',
    'https://token-plan-sgp.xiaomimimo.com/v1',
    'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  ),
  zai: openAiCompatible('Z.AI', 'https://api.z.ai/api/coding/paas/v4', 'ZAI_API_KEY'),
  'zai-coding-cn': openAiCompatible(
    'Z.AI Coding CN',
    'https://open.bigmodel.cn/api/coding/paas/v4',
    'ZAI_CODING_CN_API_KEY',
  ),
  anthropic: anthropicMessages('Anthropic', 'https://api.anthropic.com/v1', 'ANTHROPIC_API_KEY'),
  fireworks: anthropicMessages('Fireworks', 'https://api.fireworks.ai/inference/v1', 'FIREWORKS_API_KEY'),
  'kimi-coding': anthropicMessages('Kimi For Coding', 'https://api.kimi.com/coding/v1', 'KIMI_API_KEY'),
  minimax: anthropicMessages('MiniMax', 'https://api.minimax.io/anthropic/v1', 'MINIMAX_API_KEY'),
  'minimax-cn': anthropicMessages('MiniMax CN', 'https://api.minimaxi.com/anthropic/v1', 'MINIMAX_CN_API_KEY'),
  'vercel-ai-gateway': anthropicMessages(
    'Vercel AI Gateway',
    'https://ai-gateway.vercel.sh/v1',
    'AI_GATEWAY_API_KEY',
  ),
} as const satisfies Record<string, ModelProviderVendor>;

export type ModelProviderVendorId = keyof typeof MODEL_PROVIDER_VENDORS;

/** Catalog vendor ids; `MODEL_PROVIDER_KINDS` is this list plus `custom`. */
export const MODEL_PROVIDER_VENDOR_IDS = Object.keys(
  MODEL_PROVIDER_VENDORS,
) as readonly ModelProviderVendorId[];

/**
 * The catalog entry for a provider kind, or `undefined` for `custom`, which
 * by definition declares everything itself.
 */
export function modelProviderVendor(
  kind: string,
): ModelProviderVendor | undefined {
  return Object.hasOwn(MODEL_PROVIDER_VENDORS, kind)
    ? MODEL_PROVIDER_VENDORS[kind as ModelProviderVendorId]
    : undefined;
}

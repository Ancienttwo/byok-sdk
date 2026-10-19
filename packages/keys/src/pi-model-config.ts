import { z } from 'zod';

export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The Pi wire APIs an `openai_compatible` profile may declare. Absent means
 * `openai-completions`; an `anthropic` profile always projects
 * `anthropic-messages` and declares none.
 */
export const PI_OPENAI_COMPATIBLE_APIS = ['openai-completions', 'openai-responses'] as const;
export type PiOpenAICompatibleApi = (typeof PI_OPENAI_COMPATIBLE_APIS)[number];

const effort = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u).nullable();
const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Every `compat` member this schema admits, for any API. Each API admits only
 * its own subset of Pi's compat schema for that API (see
 * {@link PI_COMPAT_KEYS_BY_API}); a member outside the subset is refused,
 * never silently ignored.
 */
const compat = z.object({
  supportsStore: z.boolean().optional(),
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
  supportsUsageInStreaming: z.boolean().optional(),
  maxTokensField: z.enum(['max_completion_tokens', 'max_tokens']).optional(),
  thinkingFormat: z.enum(['openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen',
    'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']).optional(),
  zaiToolStream: z.boolean().optional(),
  supportsLongCacheRetention: z.boolean().optional(),
}).strict();

export const PI_COMPAT_KEYS_BY_API: Readonly<Record<PiOpenAICompatibleApi, readonly (keyof z.infer<typeof compat>)[]>> = {
  'openai-completions': ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
    'maxTokensField', 'thinkingFormat', 'zaiToolStream', 'supportsLongCacheRetention'],
  'openai-responses': ['supportsDeveloperRole', 'supportsLongCacheRetention'],
};

/**
 * The compat keys the frozen prepared model wire carries. The prepared runtime
 * entry refuses a profile that declares any other compat key.
 */
export const PI_PREPARED_COMPAT_KEYS: readonly string[] = ['supportsStore', 'supportsDeveloperRole',
  'supportsReasoningEffort', 'supportsUsageInStreaming', 'maxTokensField', 'thinkingFormat', 'zaiToolStream'];

/** Pi's `ModelInputLimitsSchema`, closed. */
const inputLimits = z.object({
  maxRequestBytes: limit.optional(),
  images: z.object({
    resize: z.object({
      maxWidth: limit.optional(),
      maxHeight: limit.optional(),
      maxBytes: limit.optional(),
      jpegQuality: z.number().int().min(1).max(100).optional(),
    }).strict().optional(),
    maxPerMessage: limit.optional(),
    maxPerRequest: limit.optional(),
  }).strict().optional(),
}).strict();

/** Local declared Pi configuration, without identity, endpoint, headers or secrets. */
export const PiModelConfigSchema = z.object({
  api: z.enum(PI_OPENAI_COMPATIBLE_APIS).optional(),
  contextWindow: limit,
  maxTokens: limit,
  reasoning: z.boolean(),
  thinkingLevel: z.enum(PI_THINKING_LEVELS),
  thinkingLevelMap: z.object({
    off: effort, minimal: effort, low: effort, medium: effort,
    high: effort, xhigh: effort, max: effort,
  }).strict(),
  compat,
  inputLimits: inputLimits.optional(),
}).strict().superRefine((config, ctx) => {
  if (config.maxTokens > config.contextWindow) {
    ctx.addIssue({ code: 'custom', path: ['maxTokens'], message: 'Pi maximum output cannot exceed its context window' });
  }
  if (config.reasoning && config.thinkingLevelMap[config.thinkingLevel] === null) {
    ctx.addIssue({ code: 'custom', path: ['thinkingLevel'], message: 'Pi thinking level is not supported by the declared model' });
  }
  if (!config.reasoning && config.thinkingLevel !== 'off') {
    ctx.addIssue({ code: 'custom', path: ['thinkingLevel'], message: 'Non-reasoning Pi models require thinking off' });
  }
  const api = config.api ?? 'openai-completions';
  const admitted: readonly string[] = PI_COMPAT_KEYS_BY_API[api];
  for (const key of Object.keys(config.compat)) {
    if (!admitted.includes(key)) {
      ctx.addIssue({ code: 'custom', path: ['compat', key], message: `Pi compat ${key} does not apply to ${api}` });
    }
  }
});

export type PiModelConfig = z.infer<typeof PiModelConfigSchema>;

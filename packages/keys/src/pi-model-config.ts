import { z } from 'zod';
import { PI_THINKING_LEVELS } from './pi-model-catalog.generated';

/**
 * Pi's own `MODEL_THINKING_LEVELS`, generated from the pinned
 * `@earendil-works/pi-ai` (see `pi-model-catalog.generated.ts`). The Pi host
 * entries in `@byok-sdk/client` import the same pinned list from pi-ai.
 */
export { PI_THINKING_LEVELS };
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/**
 * The Pi wire APIs an `openai_compatible` profile may declare. Absent means
 * `openai-completions`; an `anthropic` profile always projects
 * `anthropic-messages` and declares none.
 */
export const PI_OPENAI_COMPATIBLE_APIS = ['openai-completions', 'openai-responses'] as const;
export type PiOpenAICompatibleApi = (typeof PI_OPENAI_COMPATIBLE_APIS)[number];

/** Every Pi wire API a profile projects: the two `openai_compatible` APIs and `anthropic-messages`. */
export const PI_MODEL_APIS = [...PI_OPENAI_COMPATIBLE_APIS, 'anthropic-messages'] as const;
export type PiModelApi = (typeof PI_MODEL_APIS)[number];

const effort = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u).nullable();
const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Every `compat` member this schema admits, for any API. Each API admits only
 * its own subset of Pi's compat schema for that API (see
 * {@link PI_COMPAT_KEYS_BY_API}); a member outside the subset is refused,
 * never silently ignored. Each member is passed to Pi verbatim.
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
  supportsStrictMode: z.boolean().optional(),
  requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
  forceAdaptiveThinking: z.boolean().optional(),
  sendSessionAffinityHeaders: z.boolean().optional(),
  allowEmptySignature: z.boolean().optional(),
}).strict();

export type PiCompatKey = keyof z.infer<typeof compat>;

/** The subset of Pi's per-API compat schema this package carries, for each Pi wire API. */
export const PI_COMPAT_KEYS_BY_API: Readonly<Record<PiModelApi, readonly PiCompatKey[]>> = {
  'openai-completions': ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
    'maxTokensField', 'thinkingFormat', 'zaiToolStream', 'supportsLongCacheRetention', 'supportsStrictMode',
    'requiresReasoningContentOnAssistantMessages', 'sendSessionAffinityHeaders'],
  'openai-responses': ['supportsDeveloperRole', 'supportsLongCacheRetention', 'supportsStrictMode'],
  'anthropic-messages': ['supportsLongCacheRetention', 'forceAdaptiveThinking', 'sendSessionAffinityHeaders',
    'allowEmptySignature'],
};

/**
 * The compat keys an `anthropic` profile admits. It projects
 * `anthropic-messages`, but it has always admitted the `openai-completions`
 * set too, and a stored profile may declare one of those keys. Pi's
 * Anthropic compat schema does not read them. Tightening this set would
 * refuse such a stored profile, so it is a separate decision.
 */
export const PI_ANTHROPIC_PROFILE_COMPAT_KEYS: readonly PiCompatKey[] = [
  ...new Set([...PI_COMPAT_KEYS_BY_API['openai-completions'], ...PI_COMPAT_KEYS_BY_API['anthropic-messages']]),
];

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

/**
 * Local declared Pi configuration, without identity, endpoint, headers or secrets.
 *
 * `thinkingLevelMap` is absent or complete, as on the prepared model wire.
 * Without a map, Pi applies its own handling of each level. A partial map is
 * refused, because Pi reads an absent level differently from `null` and from
 * the level name.
 */
export const PiModelConfigSchema = z.object({
  api: z.enum(PI_OPENAI_COMPATIBLE_APIS).optional(),
  contextWindow: limit,
  maxTokens: limit,
  reasoning: z.boolean(),
  thinkingLevel: z.enum(PI_THINKING_LEVELS),
  thinkingLevelMap: z.object({
    off: effort, minimal: effort, low: effort, medium: effort,
    high: effort, xhigh: effort, max: effort,
  }).strict().optional(),
  compat,
  inputLimits: inputLimits.optional(),
}).strict().superRefine((config, ctx) => {
  if (config.maxTokens > config.contextWindow) {
    ctx.addIssue({ code: 'custom', path: ['maxTokens'], message: 'Pi maximum output cannot exceed its context window' });
  }
  if (config.reasoning && !piSupportedThinkingLevels(config).includes(config.thinkingLevel)) {
    ctx.addIssue({ code: 'custom', path: ['thinkingLevel'], message: 'Pi thinking level is not supported by the declared model' });
  }
  if (!config.reasoning && config.thinkingLevel !== 'off') {
    ctx.addIssue({ code: 'custom', path: ['thinkingLevel'], message: 'Non-reasoning Pi models require thinking off' });
  }
  // An absent api is decided by the profile adapter, which this schema cannot
  // see. It admits what either adapter admits (the anthropic set is that
  // union); `ModelProviderProfileSchema` checks the adapter's own set.
  if (config.api !== undefined) {
    for (const issue of piCompatIssues(config.compat, PI_COMPAT_KEYS_BY_API[config.api], config.api)) ctx.addIssue(issue);
  } else {
    for (const issue of piCompatIssues(config.compat, PI_ANTHROPIC_PROFILE_COMPAT_KEYS, 'openai-completions or anthropic-messages')) {
      ctx.addIssue(issue);
    }
  }
});

/**
 * The thinking levels Pi offers for these settings, in Pi's order. This
 * restates pi-ai `getSupportedThinkingLevels`; a client test compares the two.
 * A non-reasoning model has `off` only. A level mapped to `null` is not
 * offered, and Pi offers `xhigh` and `max` only when the map names them.
 */
export function piSupportedThinkingLevels(
  config: Pick<PiModelConfig, 'reasoning' | 'thinkingLevelMap'>,
): PiThinkingLevel[] {
  if (!config.reasoning) return ['off'];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = config.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return (level !== 'xhigh' && level !== 'max') || mapped !== undefined;
  });
}

/** One issue per declared compat key outside `admitted`, at `['compat', key]`. */
export function piCompatIssues(
  declared: object, admitted: readonly string[], api: string,
): { code: 'custom'; path: string[]; message: string }[] {
  return Object.keys(declared).filter((key) => !admitted.includes(key))
    .map((key) => ({ code: 'custom', path: ['compat', key], message: `Pi compat ${key} does not apply to ${api}` }));
}

export type PiModelConfig = z.infer<typeof PiModelConfigSchema>;

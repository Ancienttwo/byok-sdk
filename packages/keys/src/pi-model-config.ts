import { z } from 'zod';

export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const effort = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u).nullable();

/** Local declared Pi configuration, without identity, endpoint, headers or secrets. */
export const PiModelConfigSchema = z.object({
  contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reasoning: z.boolean(),
  thinkingLevel: z.enum(PI_THINKING_LEVELS),
  thinkingLevelMap: z.object({
    off: effort, minimal: effort, low: effort, medium: effort,
    high: effort, xhigh: effort, max: effort,
  }).strict(),
  compat: z.object({
    supportsStore: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsUsageInStreaming: z.boolean().optional(),
    maxTokensField: z.enum(['max_completion_tokens', 'max_tokens']).optional(),
    thinkingFormat: z.enum(['openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen',
      'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']).optional(),
    zaiToolStream: z.boolean().optional(),
  }).strict(),
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
});

export type PiModelConfig = z.infer<typeof PiModelConfigSchema>;

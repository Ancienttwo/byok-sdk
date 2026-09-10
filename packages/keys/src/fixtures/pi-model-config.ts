// Explicit test configuration, never a runtime default or model-name lookup.
export const PI_MODEL_FIXTURE = {
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  reasoning: true,
  thinkingLevel: 'low',
  thinkingLevelMap: {
    off: null, minimal: null, low: 'low', medium: null,
    high: 'high', xhigh: null, max: 'max',
  },
  compat: {
    supportsStore: false, supportsDeveloperRole: false,
    supportsReasoningEffort: true, supportsUsageInStreaming: true,
    maxTokensField: 'max_tokens', thinkingFormat: 'zai', zaiToolStream: true,
  },
} as const;

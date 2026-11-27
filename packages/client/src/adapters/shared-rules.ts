import type { AgentEvent } from '@byok-sdk/protocol';
import { HARNESS_SERVICE_TIER_MAX_LENGTH, HARNESS_SERVICE_TIER_TOKEN } from '@byok-sdk/protocol/constants';

type Usage = Extract<AgentEvent, { type: 'usage' }>;

export const BASE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.py': 'text/x-python',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.csv': 'text/csv',
};

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return record(value) ? value : undefined;
}

export function projectedServiceTier(events: unknown): Extract<AgentEvent, { type: 'service_tier' }> | undefined {
  if (!Array.isArray(events)) return undefined;
  for (const value of events) {
    const event = objectRecord(value);
    if (event?.kind !== 'service_tier') continue;
    const { serviceTier } = event;
    if (typeof serviceTier === 'string' && serviceTier.length <= HARNESS_SERVICE_TIER_MAX_LENGTH
      && HARNESS_SERVICE_TIER_TOKEN.test(serviceTier) && !serviceTier.includes('[redacted]')) {
      return { type: 'service_tier', serviceTier };
    }
  }
  return undefined;
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function projectProviderContext(next: Usage, context: Record<string, unknown> | undefined): void {
  const contextTokens = count(context?.tokens);
  const contextWindow = count(context?.contextWindow);
  if (contextTokens !== undefined) next.contextTokens = contextTokens;
  if (contextWindow !== undefined && contextWindow > 0) next.contextWindow = contextWindow;
  if (contextTokens !== undefined || next.contextWindow !== undefined) next.contextSource = 'provider';
}

/** Returns a new baseline only when both required cumulative counters are valid. */
export function accumulateUsage(next: Usage, tokens: Record<string, unknown> | undefined, billed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (tokens === undefined || count(tokens.input) === undefined || count(tokens.output) === undefined) return undefined;
  for (const [from, to] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cachedInputTokens'], ['reasoning', 'reasoningTokens']] as const) {
    const value = count(tokens[from]);
    const prior = count(billed?.[from]) ?? 0;
    if (value !== undefined && value >= prior) next[to] = (next[to] ?? 0) + value - prior;
  }
  return tokens;
}

/**
 * Convert OAR's normalized `ToolOutputPart[]` (`mediaType` on images, `other`
 * wrapper on non-text/image blocks) back to MCP `CallToolResult.content` items.
 */
export function normalizeOarToolContent(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.map((item) => {
    const part = objectRecord(item);
    if (part === undefined) return item;
    if (part.type === 'image' && typeof part.data === 'string' && typeof part.mediaType === 'string') {
      return { type: 'image', data: part.data, mimeType: part.mediaType };
    }
    if (part.type === 'other' && Object.hasOwn(part, 'value')) {
      return part.value;
    }
    return item;
  });
}

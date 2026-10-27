import type { AgentEvent } from '@byok-sdk/protocol';
import type { AgentEvent as DurableEvent } from '@earendil-works/pi-durable';
import type { McpEventIdentities } from '../../mcp/event-identity';
import { servedModelName } from '../served-model';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/**
 * `mcp` by the exact registered name (`mcp__<server>__<tool>`) of a tool in the
 * daemon's observed toolsets. A builtin, an SDK-reserved helper (registered
 * bare) or any other name gets none; the name is never split.
 */
export function withMcpIdentity(event: AgentEvent, identities: McpEventIdentities): AgentEvent {
  if (event.type !== 'tool_use' && event.type !== 'tool_result') return event;
  const mcp = identities.get(event.tool);
  return mcp === undefined ? event : { ...event, mcp };
}
/** Snapshot, partial usage, and model-turn boundaries never replay or complete a BYOK execution. */
export function projectDurableEvent(event: DurableEvent): AgentEvent[] {
  if (event.type === 'message_update') return event.changes.flatMap(change => change.type === 'text_delta' ? [{ type: 'progress' as const, text: change.delta }] : []);
  if (event.type === 'run_end') return [{ type: 'turn_end' }];
  if (event.type === 'tool_execution_start') {
    if (!event.toolCallId) throw new Error('durable tool call has no authoritative id');
    return [{ type: 'tool_use', tool: event.toolName, toolCallId: event.toolCallId, input: event.args }];
  }
  if (event.type === 'tool_execution_end') {
    if (!event.toolCallId) throw new Error('durable tool result has no authoritative id');
    const entry = object(event.entry);
    const message = object(Array.isArray(entry.model) ? entry.model[0] : undefined);
    return [{ type: 'tool_result', tool: event.toolName, toolCallId: event.toolCallId, output: message, isError: event.entry === undefined || message.isError === true }];
  }
  if (event.type === 'task_failed') return [{ type: 'error', message: 'durable runtime task failed' }];
  if (event.type === 'auto_retry_start' || event.type === 'compaction_start') return [{ type: 'error', message: 'durable slice 1 unexpectedly activated retry or compaction' }];
  if (event.type === 'message_end') {
    const entry = object(event.entry);
    if (entry.kind !== 'pi.assistant') return [];
    const message = object(Array.isArray(entry.model) ? entry.model[0] : undefined);
    const usage = object(message.usage);
    const input = usage.input, cacheRead = usage.cacheRead, cacheWrite = usage.cacheWrite;
    const sum = count(input) && count(cacheRead) && count(cacheWrite) ? input + cacheRead + cacheWrite : undefined;
    const model = servedModelName(message.responseModel);
    return [{ type: 'usage', ...(sum !== undefined && count(sum) ? { inputTokens: sum } : {}),
      ...(count(cacheRead) ? { cachedInputTokens: cacheRead } : {}), ...(count(usage.output) ? { outputTokens: usage.output } : {}), ...(count(usage.totalTokens) ? { totalTokens: usage.totalTokens } : {}),
      ...(model === undefined ? {} : { model }) }];
  }
  return [];
}

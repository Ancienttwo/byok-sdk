import type { AgentEvent } from '@byok-sdk/protocol';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Maps one ACP session's `session/update` notifications and the
 * `session/prompt` answer to SDK events. Each `agent_message_chunk` becomes
 * one `progress` event. Hermes sends text deltas, so its descriptor leaves
 * `progressEventsAreMessages` unset and the daemon joins consecutive chunks
 * into one reply; dsh sends each committed message whole and sets it.
 */
export class AcpProjection {
  private readonly tools = new Map<string, { tool: string; done: boolean }>();
  private context?: { contextTokens?: number; contextWindow?: number };

  update(update: Record<string, unknown>, emit: (event: AgentEvent) => void): void {
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const content = record(update.content);
      if (content?.type === 'text' && typeof content.text === 'string' && content.text.length > 0) emit({ type: 'progress', text: content.text });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.tool(kind, update, emit);
      return;
    }
    if (kind === 'usage_update') {
      const used = count(update.used);
      const size = count(update.size);
      this.context = {
        ...(used === undefined ? {} : { contextTokens: used }),
        ...(size === undefined || size === 0 ? {} : { contextWindow: size }),
      };
      return;
    }
    // Other kinds (thoughts, plan, commands, titles, modes) are display state, not reply text or tools.
  }

  /** The `session/prompt` answer ends the turn: usage first, then `turn_end`. */
  turnEnded(result: unknown, emit: (event: AgentEvent) => void): void {
    const usage = record(record(result)?.usage);
    const event: Extract<AgentEvent, { type: 'usage' }> = { type: 'usage' };
    const fields: Array<[keyof typeof event, unknown]> = [
      ['inputTokens', usage?.inputTokens],
      ['outputTokens', usage?.outputTokens],
      ['totalTokens', usage?.totalTokens],
      ['cachedInputTokens', usage?.cachedReadTokens],
      ['reasoningTokens', usage?.thoughtTokens],
    ];
    for (const [name, value] of fields) {
      const n = count(value);
      if (n !== undefined) (event as Record<string, unknown>)[name] = n;
    }
    if (this.context?.contextTokens !== undefined) {
      event.contextTokens = this.context.contextTokens;
      event.contextSource = 'provider';
      if (this.context.contextWindow !== undefined) event.contextWindow = this.context.contextWindow;
    }
    if (Object.keys(event).length > 1) emit(event);
    this.context = undefined;
    emit({ type: 'turn_end' });
  }

  private tool(kind: string, update: Record<string, unknown>, emit: (event: AgentEvent) => void): void {
    const toolCallId = typeof update.toolCallId === 'string' && /\S/.test(update.toolCallId) ? update.toolCallId : undefined;
    if (toolCallId === undefined) return;
    let known = this.tools.get(toolCallId);
    if (known === undefined) {
      if (kind !== 'tool_call') return;
      known = { tool: typeof update.title === 'string' && update.title.length > 0 ? update.title : 'tool', done: false };
      this.tools.set(toolCallId, known);
      const input = update.rawInput ?? update.content;
      emit({ type: 'tool_use', tool: known.tool, toolCallId, ...(input === undefined || input === null ? {} : { input }) });
    }
    const status = update.status;
    if (known.done || (status !== 'completed' && status !== 'failed')) return;
    known.done = true;
    const output = update.rawOutput ?? update.content;
    emit({
      type: 'tool_result', tool: known.tool, toolCallId,
      ...(output === undefined || output === null ? {} : { output }),
      ...(status === 'failed' ? { isError: true } : {}),
    });
  }
}

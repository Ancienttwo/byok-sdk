import { BufferedToolUse } from '../buffered-tool-use.js';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { AcpRecord } from '../../runtime/acp-session-runtime.js';
import { runtimeFailureClassOf } from '../../runtime-failure.js';

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export interface OpenCodeTurnOutcome { kind: 'completed' | 'aborted' | 'failed'; failure?: string; reason?: string; fromText?: boolean }

/** Per-native-session state keeps v2 child call ids distinct; SDK events have no child graph field. */
export class OpenCodeProjection {
  private readonly tools = new Map<string, string>();
  private readonly buffered = new BufferedToolUse();
  output = false;
  constructor(private readonly root: string) {}

  consume(record: AcpRecord, emit: (event: AgentEvent) => void, end: (outcome: OpenCodeTurnOutcome) => void): void {
    if (record.kind !== 'frame') return;
    const body = object(record.body);
    if (!Array.isArray(body?.events)) return;
    const events = body.events;
    const root = record.sessionId === this.root && record.agentPath.length === 0;
    const update = object(object(body.native)?.update);
    const nativeId = typeof update?.toolCallId === 'string' ? update.toolCallId : undefined;
    const updateId = nativeId === undefined ? undefined : root ? nativeId : `${record.sessionId}:${nativeId}`;
    const observe = () => {
      if (updateId === undefined) return;
      this.buffered.observe(updateId, update?.rawInput, update?.rawInput !== undefined,
        events.some(item => object(item)?.kind === 'tool_call_input') || ['in_progress', 'completed', 'failed', 'cancelled'].includes(String(update?.status)), emit);
    };
    observe();
    for (const item of events) {
      const event = object(item);
      if (!event) continue;
      const callId = typeof event.callId === 'string' ? (root ? event.callId : `${record.sessionId}:${event.callId}`) : undefined;
      switch (event.kind) {
        case 'text_delta':
          if (typeof event.text === 'string' && event.text.length > 0) {
            this.output = true;
            if (root) emit({ type: 'progress', text: event.text });
          }
          break;
        case 'reasoning':
          this.output = true;
          break;
        case 'tool_call_started': {
          this.output = true;
          if (callId === undefined || typeof event.tool !== 'string') break;
          this.tools.set(callId, event.tool);
          this.buffered.start({ type: 'tool_use', tool: event.tool, toolCallId: callId });
          observe();
          break;
        }
        case 'tool_call_ended': {
          this.output = true;
          if (callId === undefined) break;
          const tool = this.tools.get(callId);
          if (tool === undefined) break;
          this.buffered.finish(callId, emit);
          this.tools.delete(callId);
          emit({ type: 'tool_result', tool, toolCallId: callId, output: event.content,
            ...(event.result === 'failed' ? { isError: true } : {}) });
          break;
        }
        case 'usage': {
          const nativeUsage = object(event.usage);
          const tokens = object(nativeUsage?.tokens);
          const context = object(nativeUsage?.context);
          const usage: AgentEvent = { type: 'usage',
            ...(typeof tokens?.input === 'number' ? { inputTokens: tokens.input } : {}),
            ...(typeof tokens?.output === 'number' ? { outputTokens: tokens.output } : {}),
            ...(typeof context?.tokens === 'number' ? { contextTokens: context.tokens } : {}),
            ...(typeof context?.contextWindow === 'number' ? { contextWindow: context.contextWindow } : {}),
          };
          if (Object.keys(usage).length > 1) emit(usage);
          break;
        }
        case 'turn_ended': {
          if (!root) break;
          this.buffered.drain(emit);
          this.tools.clear();
          const outcome = object(event.outcome);
          end(outcome?.kind === 'failed'
            ? { kind: 'failed', failure: runtimeFailureClassOf(outcome.failure), reason: typeof outcome.reason === 'string' ? outcome.reason : 'opencode turn failed', fromText: outcome.fromText === true }
            : { kind: outcome?.kind === 'aborted' ? 'aborted' : 'completed' });
          break;
        }
      }
    }
  }
}

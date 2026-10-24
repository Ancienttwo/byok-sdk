import type { AgentEvent, RuntimeFailureClass } from '@byok-sdk/protocol';
import { runtimeFailureClassOf } from '../../runtime-failure';
import type { AcpRecord } from '../../runtime/acp-session-runtime';
import type { MessageDraftDelta } from '../../types';

type Usage = Extract<AgentEvent, { type: 'usage' }>;
type Tokens = { input?: unknown; output?: unknown; reasoning?: unknown; cacheRead?: unknown };
/** The turn end the vendored ACP turn machinery recorded, as `GrokSession` reads it. */
export type GrokTurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly failure: RuntimeFailureClass; readonly reason: string; readonly fromText?: true };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Root-session ACP records to `AgentEvent`s. It reads the runtime-neutral
 * events OAR derived beside each native frame, never the vendor wire. Child
 * sessions (Grok sub-agents) are recorded under their own id and produce
 * nothing here: their text is not the parent's reply and their tools are not
 * the parent's tools.
 *
 * Streamed text is buffered and emitted as one `progress` per text run: a
 * tool call or the turn end closes the run. The daemon keeps the last run
 * after the last tool interaction as the closing reply. Each delta also goes
 * to the display-only draft; the run's `progress` then reconciles it.
 */
export class GrokProjection {
  private text = '';
  private readonly tools = new Map<string, string>();
  /** OAR reports this session's tokens cumulatively from open; each turn's usage is the difference. */
  private billed: Required<Pick<Tokens, 'input' | 'output'>> & Tokens = { input: 0, output: 0 };
  private pending?: Usage;

  constructor(private readonly rootSessionId: string) {}

  /** Events for one record; `outcome` receives the root turn end, after its events. */
  consume(input: AcpRecord, emit: (event: AgentEvent | MessageDraftDelta) => void, outcome: (turn: GrokTurnOutcome) => void): void {
    if (input.kind !== 'frame' || input.sessionId !== this.rootSessionId || input.agentPath.length > 0) return;
    const events = record(input.body)?.events;
    if (!Array.isArray(events)) return;
    // The prompt answer's frame lists `turn_ended` before its `usage`: end the turn after every other event.
    let ended: Record<string, unknown> | undefined;
    for (const value of events) {
      const event = record(value);
      switch (event?.kind) {
        case 'text_delta':
          if (typeof event.text !== 'string') break;
          this.text += event.text;
          emit({ type: 'message_draft_delta', text: event.text, startsMessage: false });
          break;
        case 'tool_call_started': {
          if (typeof event.callId !== 'string' || typeof event.tool !== 'string') break;
          this.flush(emit);
          this.tools.set(event.callId, event.tool);
          emit({ type: 'tool_use', tool: event.tool, toolCallId: event.callId, ...(event.input === undefined ? {} : { input: event.input }) });
          break;
        }
        case 'tool_call_ended': {
          if (typeof event.callId !== 'string') break;
          this.flush(emit);
          const tool = this.tools.get(event.callId) ?? 'tool';
          this.tools.delete(event.callId);
          emit({
            type: 'tool_result', tool, toolCallId: event.callId,
            output: { ...(event.content === undefined ? {} : { content: event.content }), ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }) },
            ...(event.result === 'failed' ? { isError: true } : {}),
          });
          break;
        }
        case 'usage':
          this.usage(record(event.usage));
          break;
        case 'turn_ended':
          ended = record(event.outcome) ?? {};
          break;
        default:
          break;
      }
    }
    if (ended !== undefined) this.endTurn(ended, emit, outcome);
  }

  private endTurn(turn: Record<string, unknown>, emit: (event: AgentEvent) => void, outcome: (turn: GrokTurnOutcome) => void): void {
    this.flush(emit);
    this.endOpenTools(emit, turn.kind === 'aborted' ? 'interrupted' : 'ended');
    this.flushUsage(emit);
    if (turn.kind === 'failed') {
      // The vendored OAR outcome owns the class and marks one a text rule chose; the SDK adds no rule of its own.
      outcome({
        kind: 'failed', reason: typeof turn.reason === 'string' ? turn.reason : 'grok turn failed', failure: runtimeFailureClassOf(turn.failure),
        ...(turn.fromText === true ? { fromText: true as const } : {}),
      });
      return;
    }
    emit({ type: 'turn_end' });
    outcome({ kind: turn.kind === 'aborted' ? 'aborted' : 'completed' });
  }

  /** A transport close cannot invent a turn outcome, but must keep observed metering. */
  takePendingUsage(): Usage | undefined {
    const usage = this.pending;
    this.pending = undefined;
    return usage;
  }

  private flush(emit: (event: AgentEvent) => void): void {
    if (this.text.length === 0) return;
    const text = this.text;
    this.text = '';
    emit({ type: 'progress', text });
  }

  private endOpenTools(emit: (event: AgentEvent) => void, status: 'interrupted' | 'ended'): void {
    for (const [toolCallId, tool] of this.tools) {
      emit({ type: 'tool_result', tool, toolCallId, output: { status, reason: 'closed at turn end; runtime did not report the call ended' } });
    }
    this.tools.clear();
  }

  private flushUsage(emit: (event: AgentEvent) => void): void {
    const usage = this.takePendingUsage();
    if (usage !== undefined) emit(usage);
  }

  private usage(report: Record<string, unknown> | undefined): void {
    if (report === undefined) return;
    const next: Usage = { ...(this.pending ?? { type: 'usage' }) };
    const context = record(report.context);
    const contextTokens = count(context?.tokens);
    const contextWindow = count(context?.contextWindow);
    if (contextTokens !== undefined) next.contextTokens = contextTokens;
    if (contextWindow !== undefined && contextWindow > 0) next.contextWindow = contextWindow;
    if (contextTokens !== undefined || next.contextWindow !== undefined) next.contextSource = 'provider';
    const tokens = record(report.tokens) as Tokens | undefined;
    if (tokens !== undefined && count(tokens.input) !== undefined && count(tokens.output) !== undefined) {
      for (const [from, to] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cachedInputTokens'], ['reasoning', 'reasoningTokens']] as const) {
        const value = count(tokens[from]);
        const prior = count(this.billed[from]) ?? 0;
        if (value !== undefined && value >= prior) next[to] = (next[to] ?? 0) + value - prior;
      }
      this.billed = tokens as typeof this.billed;
    }
    if (Object.keys(next).length > 1) this.pending = next;
  }
}

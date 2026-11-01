import type { AgentEvent, RuntimeFailureClass } from '@byok-sdk/protocol';
import { runtimeFailureClassOf } from '../../runtime-failure';
import type { AcpRecord } from '../../runtime/acp-session-runtime';

type Usage = Extract<AgentEvent, { type: 'usage' }>;
/** The turn end the vendored ACP turn machinery recorded, as `DshSession` reads it. */
export type DshTurnOutcome =
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
 * Root-session ACP records to `AgentEvent`s, from the runtime-neutral events
 * OAR derived beside each native frame. dsh sends each committed assistant
 * message as one `agent_message_chunk`, so each `text_delta` is one whole
 * message and one `progress`. `usage_update` carries context occupancy only;
 * dsh reports no billed tokens.
 */
export class DshProjection {
  private readonly tools = new Map<string, string>();
  private pending?: Usage;
  /** The first model the session reported: the open answer's `configOptions`. */
  openedModel?: string;

  constructor(private readonly rootSessionId: string) {}

  /** Events for one record; `outcome` receives the root turn end, after its events. */
  consume(input: AcpRecord, emit: (event: AgentEvent) => void, outcome: (turn: DshTurnOutcome) => void): void {
    if (input.kind !== 'frame' || input.sessionId !== this.rootSessionId || input.agentPath.length > 0) return;
    const events = record(input.body)?.events;
    if (!Array.isArray(events)) return;
    // The prompt answer's frame lists `turn_ended` before its `usage`: end the turn after every other event.
    let ended: Record<string, unknown> | undefined;
    for (const value of events) {
      const event = record(value);
      switch (event?.kind) {
        case 'model':
          if (typeof event.model === 'string') this.openedModel ??= event.model;
          break;
        case 'text_delta':
          if (typeof event.text === 'string' && event.text.length > 0) emit({ type: 'progress', text: event.text });
          break;
        case 'tool_call_started':
          if (typeof event.callId !== 'string' || typeof event.tool !== 'string') break;
          this.tools.set(event.callId, event.tool);
          emit({ type: 'tool_use', tool: event.tool, toolCallId: event.callId, ...(event.input === undefined ? {} : { input: event.input }) });
          break;
        case 'tool_call_ended': {
          if (typeof event.callId !== 'string') break;
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
          this.usage(record(record(event.usage)?.context));
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

  /** A transport close cannot invent a turn outcome, but must keep the observed context usage. */
  takePendingUsage(): Usage | undefined {
    const usage = this.pending;
    this.pending = undefined;
    return usage;
  }

  private endTurn(turn: Record<string, unknown>, emit: (event: AgentEvent) => void, outcome: (turn: DshTurnOutcome) => void): void {
    for (const [toolCallId, tool] of this.tools) {
      emit({ type: 'tool_result', tool, toolCallId, output: { status: turn.kind === 'aborted' ? 'interrupted' : 'ended', reason: 'closed at turn end; runtime did not report the call ended' } });
    }
    this.tools.clear();
    const usage = this.takePendingUsage();
    if (usage !== undefined) emit(usage);
    if (turn.kind === 'failed') {
      // The vendored OAR outcome owns the class and marks one a text rule chose; the SDK adds no rule of its own.
      outcome({
        kind: 'failed', reason: typeof turn.reason === 'string' ? turn.reason : 'dsh turn failed', failure: runtimeFailureClassOf(turn.failure),
        ...(turn.fromText === true ? { fromText: true as const } : {}),
      });
      return;
    }
    emit({ type: 'turn_end' });
    outcome({ kind: turn.kind === 'aborted' ? 'aborted' : 'completed' });
  }

  private usage(context: Record<string, unknown> | undefined): void {
    const contextTokens = count(context?.tokens);
    const contextWindow = count(context?.contextWindow);
    if (contextTokens === undefined && (contextWindow === undefined || contextWindow === 0)) return;
    this.pending = {
      type: 'usage',
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(contextWindow === undefined || contextWindow === 0 ? {} : { contextWindow }),
      contextSource: 'provider',
    };
  }
}

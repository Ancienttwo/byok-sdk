import { BufferedToolUse } from '../buffered-tool-use.js';
import type { AgentEvent, RuntimeFailureClass } from '@byok-sdk/protocol';
import { runtimeFailureClassOf } from '../../runtime-failure.js';
import type { AcpRecord } from '../../runtime/acp-session-runtime.js';
import type { MessageDraftDelta } from '../../types.js';

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
 * events OAR derived beside each native frame; only a tool call's input comes
 * from the native frame itself. Child
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
  private readonly buffered = new BufferedToolUse();
  /** OAR reports this session's tokens cumulatively from open; each turn's usage is the difference. */
  private billed: Required<Pick<Tokens, 'input' | 'output'>> & Tokens = { input: 0, output: 0 };
  private pending?: Usage;
  /** The SDK prompt's input id, and whether the drained prompt request carrying it was recorded. */
  private sdkTurn?: { readonly inputId: string; drained: boolean };
  /** OAR adopted a turn Grok runs on its own (a background command or sub-agent wake) as the active turn. */
  private grokTurn = false;
  private closedGrokTurns = 0;

  constructor(private readonly rootSessionId: string) {}

  /** The SDK sends a prompt named `inputId`, directly or through OAR's held input. */
  beginSdkTurn(inputId: string): void {
    this.sdkTurn = { inputId, drained: false };
  }
  endSdkTurn(): void {
    this.sdkTurn = undefined;
  }
  /** OAR holds a prompt as busy while this is true. */
  get grokTurnOpen(): boolean {
    return this.grokTurn;
  }
  /** How many of Grok's own turns have closed. */
  get grokTurnsClosed(): number {
    return this.closedGrokTurns;
  }

  /** Events for one record; `outcome` receives the root turn end of an SDK turn, after its events. `GrokSession` decides whether the turn ends or fails. */
  consume(input: AcpRecord, emit: (event: AgentEvent | MessageDraftDelta) => void, outcome: (turn: GrokTurnOutcome) => void): void {
    const request = input.kind === 'request' ? record(input.body) : undefined;
    // The drained prompt request is recorded before any frame of its turn, so a later turn_active
    // without an input id belongs to this SDK turn (OAR names a drained prompt without its input id).
    if (request?.kind === 'prompt' && Array.isArray(request.carries) && this.sdkTurn !== undefined && request.carries.includes(this.sdkTurn.inputId)) this.sdkTurn.drained = true;
    if (input.kind !== 'frame' || input.sessionId !== this.rootSessionId || input.agentPath.length > 0) return;
    const body = record(input.body);
    const events = body?.events;
    if (!Array.isArray(events)) return;
    const update = record(record(body?.native)?.update);
    const updateId = typeof update?.toolCallId === 'string' ? update.toolCallId : undefined;
    const observe = () => {
      if (updateId === undefined) return;
      const raw = record(update?.rawInput);
      const tool = this.tools.get(updateId);
      const input = raw === undefined || tool === undefined ? raw : raw;
      this.buffered.observe(updateId, input, update?.rawInput !== undefined, events.some(value => record(value)?.kind === 'tool_call_input') || ['in_progress', 'completed', 'failed', 'cancelled'].includes(String(update?.status)), emit);
    };
    if (!events.some(value => record(value)?.kind === 'tool_call_ended')) observe();
    // The prompt answer's frame lists `turn_ended` before its `usage`: end the turn after every other event.
    let ended: Record<string, unknown> | undefined;
    // OAR reports a Grok turn deferred by an SDK turn on that turn's closing frame, after its turn_ended.
    let grokTurnAfterEnd = false;
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
          this.buffered.start({ type: 'tool_use', tool: event.tool, toolCallId: event.callId });
          observe();
          break;
        }
        case 'tool_call_ended': {
          if (typeof event.callId !== 'string') break;
          this.flush(emit);
          observe();
          const tool = this.tools.get(event.callId) ?? 'tool';
          this.buffered.finish(event.callId, emit);
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
        case 'turn_active':
          // While an SDK turn is open OAR defers a Grok turn and reports nothing; a turn_active without
          // an input id outside it is Grok's own (native-turns.ts), as is one after this frame's turn end.
          if (event.inputId !== undefined) break;
          if (ended !== undefined) grokTurnAfterEnd = true;
          else if (this.sdkTurn?.drained !== true) this.grokTurn = true;
          break;
        case 'turn_ended':
          ended = record(event.outcome) ?? {};
          break;
        default:
          break;
      }
    }
    if (ended !== undefined) this.endTurn(ended, emit, outcome);
    if (grokTurnAfterEnd) this.grokTurn = true;
  }

  private endTurn(turn: Record<string, unknown>, emit: (event: AgentEvent) => void, outcome: (turn: GrokTurnOutcome) => void): void {
    this.flush(emit);
    this.endOpenTools(emit, turn.kind === 'aborted' ? 'interrupted' : 'ended');
    if (this.grokTurn) {
      // Grok's own turn is no SDK task turn: its usage stays pending and is reported with the next one.
      this.grokTurn = false;
      this.closedGrokTurns += 1;
      return;
    }
    this.flushUsage(emit);
    if (turn.kind === 'failed') {
      // The vendored OAR outcome owns the class and marks one a text rule chose; the SDK adds no rule of its own.
      outcome({
        kind: 'failed', reason: typeof turn.reason === 'string' ? turn.reason : 'grok turn failed', failure: runtimeFailureClassOf(turn.failure),
        ...(turn.fromText === true ? { fromText: true as const } : {}),
      });
      return;
    }
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
      this.buffered.finish(toolCallId, emit);
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

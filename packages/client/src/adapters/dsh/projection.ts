import { BufferedToolUse } from '../buffered-tool-use';
import type { AgentEvent, RuntimeFailureClass } from '@byok-sdk/protocol';
import { RuntimeExecutionFailure, runtimeFailureClassOf } from '../../runtime-failure';
import type { DshRecord } from '../../runtime/dsh-session-runtime';

type Usage = Extract<AgentEvent, { type: 'usage' }>;
type Tokens = { input?: unknown; output?: unknown; reasoning?: unknown; cacheRead?: unknown };
/** The turn end the vendored dsh projection recorded, as `DshSession` reads it. */
export type DshTurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly failure: RuntimeFailureClass; readonly reason: string };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason });

/**
 * The structured tool input: dsh's complete native `arguments` string, never the
 * event's text. dsh replaces a model's malformed JSON with `{}` and refuses the
 * call, so anything but an object means the wire changed. Tool authorization
 * reads this object, so the session fails rather than run on an unseen input.
 */
function toolInput(native: unknown): Record<string, unknown> {
  const text = record(record(native)?.data)?.arguments;
  let parsed: unknown;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  const input = record(parsed);
  if (input === undefined) throw authority('dsh tool call arguments are not a JSON object');
  return input;
}

/** The text of one committed assistant message. */
function messageText(native: unknown): string {
  const content = record(record(record(native)?.data)?.message)?.content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => {
    const part = record(block);
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
  }).join('');
}

/**
 * Session records to `AgentEvent`s, from the events OAR derived beside each
 * native frame. Text comes from the durable `assistant/message`: one `progress`
 * per committed message, so a failed attempt's stream adds nothing. OAR reports
 * each session's tokens cumulatively from open; usage sums their differences.
 * Context occupancy and all other events belong to the root session only.
 */
export class DshProjection {
  private readonly tools = new Map<string, string>();
  private readonly buffered = new BufferedToolUse();
  private readonly billed = new Map<string, Tokens>();
  private pending?: Usage;

  constructor(private readonly rootSessionId: string, private readonly model: string) {}

  /** Events for one record; `outcome` receives the root turn end, after its events. */
  consume(input: DshRecord, emit: (event: AgentEvent) => void, outcome: (turn: DshTurnOutcome) => void): void {
    if (input.kind !== 'frame') return;
    const root = input.sessionId === this.rootSessionId && input.agentPath.length === 0;
    const body = record(input.body);
    if (root && body?.type === 'session/event:assistant/message') {
      const text = messageText(body.native);
      if (text.length > 0) emit({ type: 'progress', text });
    }
    const events = body?.events;
    if (!Array.isArray(events)) return;
    let ended: Record<string, unknown> | undefined;
    for (const value of events) {
      const event = record(value);
      if (event?.kind === 'usage') {
        this.usage(record(event.usage), input.sessionId, root);
        continue;
      }
      if (!root) continue;
      switch (event?.kind) {
        case 'model':
          // The SDK patch and the open name this route; a request on another one means they did not apply.
          if (event.model !== this.model) throw authority('dsh session does not run the configured provider route and model');
          break;
        case 'tool_call_started':
          if (typeof event.callId !== 'string' || typeof event.tool !== 'string') break;
          this.tools.set(event.callId, event.tool);
          this.buffered.start({ type: 'tool_use', tool: event.tool, toolCallId: event.callId, input: toolInput(body?.native) });
          this.buffered.observe(event.callId, undefined, false, true, emit);
          break;
        case 'tool_call_ended': {
          if (typeof event.callId !== 'string') break;
          const tool = this.tools.get(event.callId) ?? 'tool';
          this.buffered.finish(event.callId, emit);
          this.tools.delete(event.callId);
          emit({
            type: 'tool_result', tool, toolCallId: event.callId,
            output: { ...(event.content === undefined ? {} : { content: event.content }) },
            ...(event.result === 'failed' ? { isError: true } : {}),
          });
          break;
        }
        case 'turn_ended':
          ended = record(event.outcome) ?? {};
          break;
        default:
          break;
      }
    }
    if (ended !== undefined) this.endTurn(ended, emit, outcome);
  }

  /** A transport close cannot invent a turn outcome, but must keep the observed usage. */
  takePendingUsage(): Usage | undefined {
    const usage = this.pending;
    this.pending = undefined;
    return usage;
  }

  private endTurn(turn: Record<string, unknown>, emit: (event: AgentEvent) => void, outcome: (turn: DshTurnOutcome) => void): void {
    for (const [toolCallId, tool] of this.tools) {
      this.buffered.finish(toolCallId, emit);
      emit({ type: 'tool_result', tool, toolCallId, output: { status: turn.kind === 'aborted' ? 'interrupted' : 'ended', reason: 'closed at turn end; runtime did not report the call ended' } });
    }
    this.tools.clear();
    const usage = this.takePendingUsage();
    if (usage !== undefined) emit(usage);
    if (turn.kind === 'failed') {
      outcome({ kind: 'failed', reason: typeof turn.reason === 'string' ? turn.reason : 'dsh turn failed', failure: runtimeFailureClassOf(turn.failure) });
      return;
    }
    outcome({ kind: turn.kind === 'aborted' ? 'aborted' : 'completed' });
  }

  private usage(report: Record<string, unknown> | undefined, sessionId: string, root: boolean): void {
    if (report === undefined) return;
    const next: Usage = { ...(this.pending ?? { type: 'usage' }) };
    const context = root ? record(report.context) : undefined;
    const contextTokens = count(context?.tokens);
    const contextWindow = count(context?.contextWindow);
    if (contextTokens !== undefined) next.contextTokens = contextTokens;
    if (contextWindow !== undefined && contextWindow > 0) next.contextWindow = contextWindow;
    if (contextTokens !== undefined || next.contextWindow !== undefined) next.contextSource = 'provider';
    const tokens = record(report.tokens) as Tokens | undefined;
    if (tokens !== undefined && count(tokens.input) !== undefined && count(tokens.output) !== undefined) {
      const billed = this.billed.get(sessionId);
      for (const [from, to] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cachedInputTokens'], ['reasoning', 'reasoningTokens']] as const) {
        const value = count(tokens[from]);
        const prior = count(billed?.[from]) ?? 0;
        if (value !== undefined && value >= prior) next[to] = (next[to] ?? 0) + value - prior;
      }
      this.billed.set(sessionId, tokens);
    }
    if (Object.keys(next).length > 1) this.pending = next;
  }
}

import { BufferedToolUse } from '../buffered-tool-use';
import type { AgentEvent, RuntimeFailureClass } from '@byok-sdk/protocol';
import type { McpEventIdentities, McpEventIdentity } from '../../mcp/event-identity';
import { runtimeFailureClassOf } from '../../runtime-failure';
import type { AcpRecord } from '../../runtime/acp-session-runtime';
import type { McpToolsetToolObservation } from '../../types';

/** The turn end the vendored ACP turn machinery recorded, as `AgySession` reads it. */
export type AgyTurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly failure: RuntimeFailureClass; readonly reason: string; readonly fromText?: true };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Exact admitted agy names (`mcp_<server>_<tool>`, verbatim), never split from
 * a runtime label. A name two tools share is ambiguous and gets no identity.
 */
export function agyMcpEventIdentities(observation: McpToolsetToolObservation = {}): McpEventIdentities {
  const byName = new Map<string, McpEventIdentity | null>();
  for (const [server, { tools }] of Object.entries(observation)) {
    for (const { name: tool } of tools) {
      const name = `mcp_${server}_${tool}`;
      byName.set(name, byName.has(name) ? null : Object.freeze({ server, tool }));
    }
  }
  return new Map([...byName].filter((entry): entry is [string, McpEventIdentity] => entry[1] !== null));
}



/** The SDK classifies a tool call by `command` and `path`, which agy spells `CommandLine` and `Path`. */
function toolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'run_command' && typeof input.CommandLine === 'string') return { ...input, command: input.CommandLine };
  if (['read_file', 'write_file', 'edit_file'].includes(tool) && typeof input.Path === 'string') return { ...input, path: input.Path };
  return input;
}

/**
 * Root-session ACP records to `AgentEvent`s, from the runtime-neutral events
 * OAR derived beside each native frame. agy has no verified child identity, so
 * only root frames exist here. Streamed text is buffered and emitted as one
 * `progress` per text run. agy reports no usage events.
 */
export class AgyProjection {
  private text = '';
  private readonly tools = new Map<string, string>();
  private readonly buffered = new BufferedToolUse();

  constructor(private readonly rootSessionId: string, private readonly identities: McpEventIdentities) {}

  /** Events for one record; `outcome` receives the root turn end, after its events. The session owns `turn_end`. */
  consume(input: AcpRecord, emit: (event: AgentEvent) => void, outcome: (turn: AgyTurnOutcome) => void): void {
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
      const input = raw === undefined || tool === undefined ? raw : toolInput(tool, raw);
      this.buffered.observe(updateId, input, update?.rawInput !== undefined, events.some(value => record(value)?.kind === 'tool_call_input') || ['in_progress', 'completed', 'failed', 'cancelled'].includes(String(update?.status)), emit);
    };
    if (!events.some(value => record(value)?.kind === 'tool_call_ended')) observe();
    let ended: Record<string, unknown> | undefined;
    for (const value of events) {
      const event = record(value);
      switch (event?.kind) {
        case 'text_delta':
          if (typeof event.text === 'string') this.text += event.text;
          break;
        case 'tool_call_started': {
          if (typeof event.callId !== 'string' || typeof event.tool !== 'string') break;
          this.flush(emit);
          this.tools.set(event.callId, event.tool);
          const mcp = this.identities.get(event.tool);
          this.buffered.start({ type: 'tool_use', tool: event.tool, toolCallId: event.callId, ...(mcp === undefined ? {} : { mcp }) });
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
          const mcp = this.identities.get(tool);
          emit({
            type: 'tool_result', tool, toolCallId: event.callId,
            output: { ...(event.content === undefined ? {} : { content: event.content }), ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }) },
            ...(event.result === 'failed' ? { isError: true } : {}),
            ...(mcp === undefined ? {} : { mcp }),
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

  private endTurn(turn: Record<string, unknown>, emit: (event: AgentEvent) => void, outcome: (turn: AgyTurnOutcome) => void): void {
    this.flush(emit);
    for (const [toolCallId, tool] of this.tools) {
      this.buffered.finish(toolCallId, emit);
      emit({ type: 'tool_result', tool, toolCallId, output: { status: turn.kind === 'aborted' ? 'interrupted' : 'ended', reason: 'closed at turn end; runtime did not report the call ended' } });
    }
    this.tools.clear();
    if (turn.kind === 'failed') {
      // The vendored OAR outcome owns the class and marks one a text rule chose; the SDK adds no rule of its own.
      outcome({
        kind: 'failed', reason: typeof turn.reason === 'string' ? turn.reason : 'agy turn failed', failure: runtimeFailureClassOf(turn.failure),
        ...(turn.fromText === true ? { fromText: true as const } : {}),
      });
      return;
    }
    outcome({ kind: turn.kind === 'aborted' ? 'aborted' : 'completed' });
  }

  private flush(emit: (event: AgentEvent) => void): void {
    if (this.text.length === 0) return;
    const text = this.text;
    this.text = '';
    emit({ type: 'progress', text });
  }
}

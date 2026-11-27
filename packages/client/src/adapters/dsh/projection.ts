import { accumulateUsage, normalizeOarToolContent, objectRecord as record, projectProviderContext } from '../shared-rules.js';
import { AcpChildTurns } from '../acp-turn-buffer.js';
import { BufferedToolUse } from '../buffered-tool-use.js';
import type { AgentEvent, RuntimeFailureClass } from '@byok-sdk/protocol';
import type { McpEventIdentities, McpEventIdentity } from '../../mcp/event-identity.js';
import { qualifiedMcpToolName } from '../../mcp/projection.js';
import { RuntimeExecutionFailure, runtimeFailureClassOf } from '../../runtime-failure.js';
import type { DshRecord } from '../../runtime/dsh-session-runtime.js';
import type { McpToolsetToolObservation } from '../../types.js';

const DSH_MAX_QUALIFIED_MCP_NAME = 64;

/**
 * Exact admitted dsh MCP names (`mcp__<server>__<tool>`, verbatim up to 64
 * chars). Longer names are hash-shortened by dsh and stay unattributed rather
 * than guessed; a name two tools share is ambiguous and gets no identity.
 */
export function dshMcpEventIdentities(observation: McpToolsetToolObservation = {}): McpEventIdentities {
  const byName = new Map<string, McpEventIdentity | null>();
  for (const [server, { tools }] of Object.entries(observation)) {
    for (const { name: tool } of tools) {
      const name = qualifiedMcpToolName(server, tool);
      if (name.length > DSH_MAX_QUALIFIED_MCP_NAME) continue;
      byName.set(name, byName.has(name) ? null : Object.freeze({ server, tool }));
    }
  }
  return new Map([...byName].filter((entry): entry is [string, McpEventIdentity] => entry[1] !== null));
}

function projectDshMcpToolResult(
  event: Record<string, unknown>,
  native: unknown,
): { output: Record<string, unknown>; isError: boolean } {
  const message = record(record(record(native)?.data)?.message);
  const isError = event.result === 'failed' || message?.isError === true;
  let content: unknown[];
  if (Array.isArray(message?.content)) {
    content = message.content;
  } else if (typeof message?.content === 'string') {
    content = [{ type: 'text', text: message.content }];
  } else {
    content = normalizeOarToolContent(event.content);
  }
  const structuredContent = message?.structuredContent !== undefined && message.structuredContent !== null
    ? message.structuredContent
    : undefined;
  return {
    output: {
      content,
      ...(structuredContent === undefined ? {} : { structuredContent }),
    },
    isError,
  };
}

type Usage = Extract<AgentEvent, { type: 'usage' }>;
type Tokens = { input?: unknown; output?: unknown; reasoning?: unknown; cacheRead?: unknown };
/** The turn end the vendored dsh projection recorded, as `DshSession` reads it. */
export type DshTurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly failure: RuntimeFailureClass; readonly reason: string };

const authority = (reason: string) =>
  new RuntimeExecutionFailure({ phase: 'run', retry: 'non-retryable', reason });

/**
 * The structured tool input: dsh's complete native `arguments` string, never the
 * event's text. dsh replaces a model's malformed JSON with `{}` and refuses the
 * call. The private record can withhold a credential-bearing object. The
 * public event omits that input and retains the tool identity.
 */
function toolInput(native: unknown): Record<string, unknown> | undefined {
  const nativeData = record(native)?.data;
  if (native === '[redacted]' || nativeData === '[redacted]') return undefined;
  const text = record(nativeData)?.arguments;
  let parsed: unknown;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === '[redacted]') return undefined;
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
 * The terminal usage remains the session-wide total with the root context.
 */
export class DshProjection {
  private readonly tools = new Map<string, { tool: string; agentPath?: string[]; mcp?: McpEventIdentity }>();
  private readonly buffered = new BufferedToolUse();
  private readonly billed = new Map<string, Tokens>();
  private pending?: Usage;

  private readonly children: AcpChildTurns;

  constructor(rootSessionId: string, private readonly identities: McpEventIdentities = new Map()) {
    this.children = new AcpChildTurns(rootSessionId);
  }

  /** Events for one record; `outcome` receives the root turn end, after its events. */
  consume(input: DshRecord, emit: (event: AgentEvent) => void, outcome: (turn: DshTurnOutcome) => void): void {
    if (input.kind !== 'frame') return;
    const body = record(input.body);
    const events = body?.events;
    if (!Array.isArray(events)) return;
    const path = this.children.route(input.sessionId, input.agentPath, events, body?.byokRoot);
    const root = path?.length === 0;
    const attribution = path === undefined || root ? {} : { agentPath: [...path] };
    const identify = (id: string) => root ? id : JSON.stringify([input.sessionId, path, id]);
    if (path !== undefined && body?.type === 'session/event:assistant/message') {
      const text = messageText(body.native);
      if (text.length > 0) emit({ type: 'progress', text, ...attribution });
    }
    let ended: Record<string, unknown> | undefined;
    for (const value of events) {
      const event = record(value);
      if (event?.kind === 'usage') {
        this.usage(record(event.usage), JSON.stringify([input.sessionId, path]), root, attribution.agentPath, emit);
        continue;
      }
      if (path === undefined) continue;
      switch (event?.kind) {
        case 'tool_call_started': {
          if (typeof event.callId !== 'string' || typeof event.tool !== 'string') break;
          const callId = identify(event.callId);
          const mcp = this.identities.get(event.tool);
          this.tools.set(callId, { tool: event.tool, ...attribution, ...(mcp === undefined ? {} : { mcp }) });
          const args = toolInput(body?.native);
          this.buffered.start({
            type: 'tool_use',
            tool: event.tool,
            toolCallId: callId,
            ...(args === undefined ? {} : { input: args }),
            ...attribution,
            ...(mcp === undefined ? {} : { mcp }),
          });
          this.buffered.observe(callId, undefined, false, true, emit);
          break;
        }
        case 'tool_call_ended': {
          if (typeof event.callId !== 'string') break;
          const callId = identify(event.callId);
          const tracked = this.tools.get(callId);
          const tool = tracked?.tool ?? 'tool';
          this.buffered.finish(callId, emit);
          this.tools.delete(callId);
          const mcp = tracked?.mcp ?? this.identities.get(tool);
          if (mcp !== undefined) {
            const projected = projectDshMcpToolResult(event, body?.native);
            emit({
              type: 'tool_result', tool, toolCallId: callId, ...attribution, mcp,
              output: projected.output,
              ...(projected.isError ? { isError: true } : {}),
            });
            break;
          }
          emit({
            type: 'tool_result', tool, toolCallId: callId, ...attribution,
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
    if (path !== undefined) this.children.lifecycle(input.sessionId, path, events, emit);
    if (root && ended !== undefined) this.endTurn(ended, emit, outcome);
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
      emit({
        type: 'tool_result', ...tool, toolCallId,
        ...(tool.mcp === undefined ? {} : { isError: true }),
        output: { status: turn.kind === 'aborted' ? 'interrupted' : 'ended', reason: 'closed at turn end; runtime did not report the call ended' },
      });
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

  private usage(report: Record<string, unknown> | undefined, sessionId: string, root: boolean, agentPath: string[] | undefined, emit: (event: AgentEvent) => void): void {
    if (report === undefined) return;
    const next: Usage = { ...(this.pending ?? { type: 'usage' }) };
    const context = root ? record(report.context) : undefined;
    projectProviderContext(next, context);
    const baseline = this.billed.get(sessionId);
    const tokens = accumulateUsage(next, record(report.tokens), baseline);
    if (tokens !== undefined) this.billed.set(sessionId, tokens);
    if (agentPath !== undefined) {
      const child: Usage = { type: 'usage' };
      projectProviderContext(child, record(report.context));
      accumulateUsage(child, tokens, baseline);
      if (Object.keys(child).length > 1) emit({ ...child, agentPath });
    }
    if (Object.keys(next).length > 1) this.pending = next;
  }
}

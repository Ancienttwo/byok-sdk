import { objectRecord as record } from '../shared-rules.js';
import { AcpChildTurns, AcpTurnBuffer } from '../acp-turn-buffer.js';
import type { AgentEvent, RuntimeFailureClass } from '@byok-sdk/protocol';
import type { McpEventIdentities, McpEventIdentity } from '../../mcp/event-identity.js';
import { runtimeFailureClassOf } from '../../runtime-failure.js';
import type { AcpRecord } from '../../runtime/acp-session-runtime.js';
import type { McpToolsetToolObservation } from '../../types.js';

/** The turn end the vendored ACP turn machinery recorded, as `AgySession` reads it. */
export type AgyTurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly failure: RuntimeFailureClass; readonly reason: string; readonly fromText?: true; readonly resetsAt?: string };


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

/** Projects ACP records per conversation. Only the root can settle the SDK turn. */
export class AgyProjection {
  private readonly root = new AcpTurnBuffer();
  private readonly children: AcpChildTurns;

  constructor(rootSessionId: string, private readonly identities: McpEventIdentities) {
    this.children = new AcpChildTurns(rootSessionId);
  }

  consume(input: AcpRecord, emit: (event: AgentEvent) => void, outcome: (turn: AgyTurnOutcome) => void): void {
    if (input.kind !== 'frame') return;
    const body = record(input.body);
    if (!Array.isArray(body?.events)) return;
    const events = body.events;
    this.children.link(events);
    const path = this.children.path(input.sessionId, input.agentPath);
    if (path === undefined) return;
    const root = path.length === 0;
    const buffer = root ? this.root : this.children.buffer(input.sessionId, path);
    const turn = buffer.consume(events, record(record(body.native)?.update), emit, {
      input: toolInput, mcp: tool => this.identities.get(tool),
    });
    if (turn !== undefined) {
      buffer.end(emit, turn.kind === 'aborted');
      buffer.flushUsage(emit);
    }
    this.children.lifecycle(input.sessionId, path, events, emit);
    if (!root || turn === undefined) return;
    this.children.flush(emit);
    if (turn.kind === 'failed') {
      // The vendored OAR outcome owns the class and marks one a text rule chose; the SDK adds no rule of its own.
      outcome({
        kind: 'failed', reason: typeof turn.reason === 'string' ? turn.reason : 'agy turn failed', failure: runtimeFailureClassOf(turn.failure),
        ...(turn.fromText === true ? { fromText: true as const } : {}),
        ...(typeof turn.resetsAt === 'string' ? { resetsAt: turn.resetsAt } : {}),
      });
      return;
    }
    outcome({ kind: turn.kind === 'aborted' ? 'aborted' : 'completed' });
  }

}

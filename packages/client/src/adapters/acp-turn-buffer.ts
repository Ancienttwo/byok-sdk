import type { AgentEvent } from '@byok-sdk/protocol';
import { BufferedToolUse } from './buffered-tool-use.js';
import { accumulateUsage, objectRecord as record, projectProviderContext } from './shared-rules.js';

type Usage = Extract<AgentEvent, { type: 'usage' }>;
type Emit = (event: AgentEvent) => void;

export class AcpTurnBuffer {
  private text = '';
  private readonly tools = new Map<string, string>();
  private readonly buffered = new BufferedToolUse();
  private billed?: Record<string, unknown>;
  private pending?: Usage;

  constructor(readonly agentPath: readonly string[] = []) {}

  consume(events: readonly unknown[], update: Record<string, unknown> | undefined, emit: Emit, options: {
    readonly input?: (tool: string, raw: Record<string, unknown>) => Record<string, unknown>;
    readonly mcp?: (tool: string) => { server: string; tool: string } | undefined;
    readonly draft?: (text: string) => void;
  } = {}): Record<string, unknown> | undefined {
    const at = this.attribution;
    const qualify = (id: string) => at.agentPath === undefined ? id : JSON.stringify([at.agentPath, id]);
    const updateId = typeof update?.toolCallId === 'string' ? qualify(update.toolCallId) : undefined;
    const observe = () => {
      if (updateId === undefined) return;
      const raw = record(update?.rawInput);
      const tool = this.tools.get(updateId);
      const input = raw === undefined || tool === undefined || options.input === undefined ? raw : options.input(tool, raw);
      this.buffered.observe(updateId, input, update?.rawInput !== undefined, events.some(value => record(value)?.kind === 'tool_call_input') || ['in_progress', 'completed', 'failed', 'cancelled'].includes(String(update?.status)), emit);
    };
    if (!events.some(value => record(value)?.kind === 'tool_call_ended')) observe();
    let ended: Record<string, unknown> | undefined;
    for (const value of events) {
      const event = record(value);
      switch (event?.kind) {
        case 'text_delta':
          if (typeof event.text !== 'string') break;
          this.text += event.text;
          options.draft?.(event.text);
          break;
        case 'tool_call_started': {
          if (typeof event.callId !== 'string' || typeof event.tool !== 'string') break;
          this.flushText(emit);
          const toolCallId = qualify(event.callId);
          this.tools.set(toolCallId, event.tool);
          const mcp = options.mcp?.(event.tool);
          this.buffered.start({ type: 'tool_use', tool: event.tool, toolCallId, ...at, ...(mcp === undefined ? {} : { mcp }) });
          observe();
          break;
        }
        case 'tool_call_ended': {
          if (typeof event.callId !== 'string') break;
          this.flushText(emit);
          observe();
          const toolCallId = qualify(event.callId);
          const tool = this.tools.get(toolCallId) ?? 'tool';
          this.buffered.finish(toolCallId, emit);
          this.tools.delete(toolCallId);
          const mcp = options.mcp?.(tool);
          emit({
            type: 'tool_result', tool, toolCallId, ...at,
            output: { ...(event.content === undefined ? {} : { content: event.content }), ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }) },
            ...(event.result === 'failed' ? { isError: true } : {}),
            ...(mcp === undefined ? {} : { mcp }),
          });
          break;
        }
        case 'usage':
          this.usage(record(event.usage));
          break;
        case 'turn_ended':
          ended = record(event.outcome) ?? {};
          break;
      }
    }
    return ended;
  }

  flushText(emit: Emit): void {
    if (this.text.length === 0) return;
    emit({ type: 'progress', text: this.text, ...this.attribution });
    this.text = '';
  }

  end(emit: Emit, interrupted: boolean): void {
    this.flushText(emit);
    for (const [toolCallId, tool] of this.tools) {
      this.buffered.finish(toolCallId, emit);
      emit({ type: 'tool_result', tool, toolCallId, ...this.attribution,
        output: { status: interrupted ? 'interrupted' : 'ended', reason: 'closed at turn end; runtime did not report the call ended' } });
    }
    this.tools.clear();
  }

  takePendingUsage(): Usage | undefined {
    const usage = this.pending;
    this.pending = undefined;
    return usage;
  }

  flushUsage(emit: Emit): void {
    const usage = this.takePendingUsage();
    if (usage !== undefined) emit(usage);
  }

  private get attribution(): { agentPath?: string[] } {
    return this.agentPath.length === 0 ? {} : { agentPath: [...this.agentPath] };
  }

  private usage(report: Record<string, unknown> | undefined): void {
    if (report === undefined) return;
    const next: Usage = { ...(this.pending ?? { type: 'usage' }) };
    projectProviderContext(next, record(report.context));
    const tokens = accumulateUsage(next, record(report.tokens), this.billed);
    if (tokens !== undefined) this.billed = tokens;
    if (Object.keys(next).length > 1) this.pending = { ...next, ...this.attribution };
  }
}

/** ACP puts separate conversations in sessionId, and verifies the parent in session_linked. */
export class AcpChildTurns {
  private readonly paths = new Map<string, readonly string[]>();
  private readonly turns = new Map<string, AcpTurnBuffer>();
  private readonly tasks = new Map<string, readonly string[]>();

  constructor(private readonly rootId: string) {}

  path(sessionId: string, agentPath: readonly string[]): readonly string[] | undefined {
    if (agentPath.length > 0) return agentPath;
    return sessionId === this.rootId ? [] : this.paths.get(sessionId);
  }

  buffer(sessionId: string, path: readonly string[]): AcpTurnBuffer {
    const key = JSON.stringify([sessionId, path]);
    let turn = this.turns.get(key);
    if (turn === undefined) {
      turn = new AcpTurnBuffer(path);
      this.turns.set(key, turn);
    }
    return turn;
  }

  link(events: readonly unknown[]): void {
    for (const value of events) {
      const event = record(value);
      if (event?.kind !== 'session_linked' || typeof event.parent !== 'string' || typeof event.child !== 'string' || event.child === this.rootId) continue;
      const parent = this.path(event.parent, []);
      if (parent !== undefined && !parent.includes(event.child) && !this.paths.has(event.child)) {
        this.paths.set(event.child, [...parent, event.child]);
      }
    }
  }

  lifecycle(sessionId: string, path: readonly string[], events: readonly unknown[], emit: Emit): void {
    for (const value of events) {
      const event = record(value);
      if (typeof event?.taskId !== 'string' || event.taskId.length === 0) continue;
      const key = JSON.stringify([sessionId, path, event.taskId]);
      if (event.kind === 'task_started' && event.taskType === 'agent' && !this.tasks.has(key)) {
        const childPath = typeof event.childSessionId === 'string' ? this.paths.get(event.childSessionId) : undefined;
        const agentPath = childPath ?? [...path, typeof event.childSessionId === 'string' && event.childSessionId !== '' ? event.childSessionId : event.taskId];
        this.tasks.set(key, agentPath);
        emit({ type: 'subagent_start', agentPath: [...agentPath] });
      } else if (event.kind === 'task_ended') {
        const agentPath = this.tasks.get(key);
        if (agentPath === undefined) continue;
        this.tasks.delete(key);
        for (const turn of this.turns.values()) {
          if (turn.agentPath.length !== agentPath.length || !turn.agentPath.every((part, index) => part === agentPath[index])) continue;
          turn.end(emit, event.status === 'stopped');
          turn.flushUsage(emit);
        }
        emit({ type: 'subagent_end', agentPath: [...agentPath] });
      }
    }
  }

  flush(emit: Emit): void {
    for (const turn of this.turns.values()) {
      turn.flushText(emit);
      turn.flushUsage(emit);
    }
  }
}

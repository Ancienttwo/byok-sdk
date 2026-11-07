import type { AgentEvent } from '@byok-sdk/protocol';

type ToolUse = Extract<AgentEvent, { type: 'tool_use' }>;

/** Retain the native input until ACP reports it complete or starts the call. */
export class BufferedToolUse {
  private readonly calls = new Map<string, { event: ToolUse; emitted: boolean }>();

  start(event: ToolUse): void {
    this.calls.set(event.toolCallId!, { event, emitted: false });
  }

  observe(id: string, input: unknown, hasInput: boolean, ready: boolean, emit: (event: AgentEvent) => void): void {
    const call = this.calls.get(id);
    if (!call || call.emitted) return;
    if (hasInput) {
      const { input: _previous, ...event } = call.event;
      call.event = input === undefined ? event : { ...event, input };
    }
    if (ready) {
      call.emitted = true;
      emit(call.event);
    }
  }

  finish(id: string, emit: (event: AgentEvent) => void): void {
    this.observe(id, undefined, false, true, emit);
    this.calls.delete(id);
  }

  drain(emit: (event: AgentEvent) => void): void {
    for (const id of this.calls.keys()) this.finish(id, emit);
  }
}

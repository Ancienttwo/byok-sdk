import {
  AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES,
  createEnvelope,
  type AgentEvent,
  type AgentRef,
  type Envelope,
} from '@byok-sdk/protocol';

interface AgentMessageDraftPublisherOptions {
  taskId: string;
  agentRef: AgentRef;
  maxBytes: number;
  maxCoalesceMs: number;
  progressEventsAreMessages: boolean;
  getServerCapabilities: () => readonly string[];
  send: (envelope: Envelope) => void;
}

/** Display-only text. No durable storage or acknowledgement belongs to this lane. */
export class AgentMessageDraftPublisher {
  private revision = 1;
  private offset = 0;
  private emittedText = '';
  private pending = '';
  private resetPending = false;
  private overflow = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: AgentMessageDraftPublisherOptions) {}

  /** Keep the same text run as TaskRunner.finalTextParts. */
  push(event: AgentEvent): void {
    if (!this.canSend()) return;
    if (event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'needs_approval') {
      this.reset();
    } else if (event.type === 'progress') {
      if (this.options.progressEventsAreMessages && event.text.trim() !== '') this.reset();
      if (this.overflow) return;
      this.pending += event.text;
      this.drain(false, false);
    } else {
      return;
    }
    if (!this.overflow && (this.pending !== '' || this.resetPending) && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain(true, false);
      }, this.options.maxCoalesceMs);
      this.timer.unref?.();
    }
  }

  /** Flush synchronously before agent.message.publish enters the ordered outbox. */
  flush(): void {
    this.clearTimer();
    this.drain(true, true);
  }

  /** Reconcile the display text with the bounded body selected for publication. */
  finalize(body: string): void {
    this.flush();
    if (!this.canSend()) return;
    const text = body.toWellFormed();
    if (this.emittedText === text) return;
    this.reset();
    this.pending = text;
    this.flush();
  }

  /** Publish and terminal paths both retire this task's display lane. */
  stop(): void {
    this.clearTimer();
    this.stopped = true;
    this.pending = '';
    this.emittedText = '';
    this.resetPending = false;
  }

  private reset(): void {
    this.clearTimer();
    this.revision += 1;
    this.offset = 0;
    this.emittedText = '';
    this.pending = '';
    this.resetPending = true;
    this.overflow = false;
  }

  private canSend(): boolean {
    if (this.stopped) return false;
    if (this.options.getServerCapabilities().includes('agent-message-draft')) return true;
    // A withdrawn advertisement ends this ephemeral lane. Do not replay it.
    this.stop();
    return false;
  }

  private drain(force: boolean, final: boolean): void {
    if (!this.canSend() || this.overflow) return;
    // A runtime can split a UTF-16 surrogate pair between progress events.
    // Hold its first half until the next event or the final publish flush.
    const last = this.pending.charCodeAt(this.pending.length - 1);
    const held = !final && last >= 0xd800 && last <= 0xdbff ? this.pending.slice(-1) : '';
    const text = (held === '' ? this.pending : this.pending.slice(0, -1)).toWellFormed();
    const bytes = Buffer.from(text, 'utf8');
    const remaining = this.options.maxBytes - this.offset;
    const overflow = bytes.length > remaining;
    const accepted = utf8PrefixLength(bytes, Math.min(bytes.length, remaining));
    let consumed = 0;
    while (consumed < accepted) {
      const rest = bytes.subarray(consumed, accepted);
      if (!force && !overflow && rest.length < AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES) break;
      const size = utf8PrefixLength(rest, Math.min(rest.length, AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES));
      consumed += size;
      this.emit(rest.subarray(0, size).toString('utf8'), overflow && consumed === accepted);
    }
    if (overflow && accepted === 0) this.emit('', true);
    else if (force && this.resetPending && bytes.length === 0) this.emit('', false);
    this.pending = overflow ? '' : bytes.subarray(consumed).toString('utf8') + held;
    this.overflow = overflow;
    if (overflow) this.clearTimer();
  }

  private emit(text: string, overflow: boolean): void {
    this.options.send(createEnvelope('agent.message.draft', {
      agentRef: this.options.agentRef,
      revision: this.revision,
      offset: this.offset,
      text,
      ...(overflow ? { overflow: true as const } : {}),
    }, { taskId: this.options.taskId }));
    this.offset += Buffer.byteLength(text, 'utf8');
    this.emittedText += text;
    this.resetPending = false;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** A prefix must end before a continuation byte, never inside a code point. */
function utf8PrefixLength(bytes: Buffer, limit: number): number {
  while (limit > 0 && limit < bytes.length && (bytes[limit]! & 0xc0) === 0x80) limit -= 1;
  return limit;
}

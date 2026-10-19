import type { AgentEvent } from '@byok-sdk/protocol';
import type { RuntimeAdapterDescriptor, Session } from '../types';

/**
 * Octop ③ (#553): a local, content-free diagnostic that says whether the SDK
 * saw the whole event trajectory of one started execution. `TaskRunner`
 * publishes it after the semantic terminal is committed, and it never changes
 * that terminal: not its type, not `retryable`, not outcome application, and
 * it never starts a retry.
 *
 * - `complete`: the adapter declares an evidence source, every tool call has
 *   exactly one result, no frame was dropped or invented, and the runtime sent
 *   `turn_end`. It is about collection only; a failed task can be complete.
 * - `partial`: a declared source with at least one gap.
 * - `unknown`: no declared source, or more open tool calls than the record
 *   tracks. A Host that has no record for a terminal also shows `unknown`.
 */
export type ExecutionRecordStatus = 'complete' | 'partial' | 'unknown';

/**
 * Why a declared record is not complete. A record lists only the gaps it saw,
 * each with its count.
 *
 * - `unpaired_tool_call`: a `tool_use` with no result when the terminal was
 *   decided, with no `toolCallId`, or with an id that was already used.
 * - `orphan_tool_result`: a `tool_result` with no `toolCallId`, or for an id
 *   that no open call had.
 * - `duplicate_tool_result`: a second result for an answered id.
 * - `synthetic_tool_result`: a result the adapter made itself ({@link Session.evidence}).
 * - `decode_dropped`: runtime output the adapter could not decode ({@link Session.evidence}).
 * - `unmapped_frame`: runtime frames of an unexpected type ({@link Session.evidence}).
 * - `stream_ended_early`: the runtime ended or failed its event stream before `turn_end`.
 * - `no_turn_end`: the daemon decided the terminal (cancel, reject, limit,
 *   shutdown) before `turn_end`.
 * - `spill_unstored`: a tool input or output too large to travel inline whose
 *   full bytes could not be stored (`spill.unstoredReason`).
 */
export type ExecutionRecordGap =
  | 'unpaired_tool_call'
  | 'orphan_tool_result'
  | 'duplicate_tool_result'
  | 'synthetic_tool_result'
  | 'decode_dropped'
  | 'unmapped_frame'
  | 'stream_ended_early'
  | 'no_turn_end'
  | 'spill_unstored';

/** Why a record is `unknown`. */
export type ExecutionRecordUnknown = 'source_not_declared' | 'evidence_overflow';

/** One started execution's record. Counts and closed codes only: never a tool input, output, path or reason text. */
export interface ExecutionRecord {
  taskId: string;
  terminal: 'complete' | 'failed' | 'cancelled';
  status: ExecutionRecordStatus;
  source: 'event-stream' | 'none';
  gaps: Array<{ reason: ExecutionRecordGap; count: number }>;
  unknownReason?: ExecutionRecordUnknown;
}

/** Open tool calls one execution tracks. One more makes its record `unknown` (`evidence_overflow`). */
export const MAX_OPEN_TOOL_CALLS = 4096;

/**
 * Builds one execution's record from the events `TaskRunner.pump` accepts for
 * the task, before they are batched. In memory only, and it never awaits. It
 * stops at the terminal decision, because the pump stops passing it events
 * there. The adapter counts it reads at `finish` cover the whole session up to
 * `Session.close()`, so a frame cut short while the runtime shuts down is a
 * gap too.
 */
export class ExecutionRecordAccumulator {
  private readonly open = new Set<string>();
  /** The latest answered ids, kept only to tell a repeated result from an orphan. Bounded like `open`. */
  private readonly answered = new Set<string>();
  private readonly counts: Record<ExecutionRecordGap, number> = {
    unpaired_tool_call: 0,
    orphan_tool_result: 0,
    duplicate_tool_result: 0,
    synthetic_tool_result: 0,
    decode_dropped: 0,
    unmapped_frame: 0,
    stream_ended_early: 0,
    no_turn_end: 0,
    spill_unstored: 0,
  };
  private turnEnded = false;
  private streamEndedEarly = false;
  private overflowed = false;

  constructor(
    private readonly taskId: string,
    private readonly source: RuntimeAdapterDescriptor['trajectoryEvidence'],
    private readonly session: Pick<Session, 'evidence'>,
  ) {}

  observe(event: AgentEvent): void {
    if (this.source === undefined || this.overflowed) return;
    switch (event.type) {
      case 'tool_use':
        if (event.spill?.unstoredReason !== undefined) this.counts.spill_unstored += 1;
        this.openCall(event.toolCallId);
        return;
      case 'tool_result':
        if (event.spill?.unstoredReason !== undefined) this.counts.spill_unstored += 1;
        this.answerCall(event.toolCallId);
        return;
      case 'turn_end':
        this.turnEnded = true;
        return;
      default:
        return;
    }
  }

  /** The runtime ended or failed its event stream on its own, before the daemon decided a terminal. */
  streamEnded(): void {
    if (!this.turnEnded) this.streamEndedEarly = true;
  }

  /** Reads `Session.evidence()` once, so call it after `Session.close()` resolved. */
  finish(terminal: ExecutionRecord['terminal']): ExecutionRecord {
    if (this.source === undefined) {
      return { taskId: this.taskId, terminal, status: 'unknown', source: 'none', gaps: [], unknownReason: 'source_not_declared' };
    }
    if (this.overflowed) {
      return { taskId: this.taskId, terminal, status: 'unknown', source: this.source, gaps: [], unknownReason: 'evidence_overflow' };
    }
    const counts = { ...this.counts };
    counts.unpaired_tool_call += this.open.size;
    if (!this.turnEnded) counts[this.streamEndedEarly ? 'stream_ended_early' : 'no_turn_end'] += 1;
    const evidence = this.session.evidence?.();
    if (evidence !== undefined) {
      counts.decode_dropped += evidenceCount(evidence.decodeDropped);
      counts.unmapped_frame += evidenceCount(evidence.unmappedFrames);
      counts.synthetic_tool_result += evidenceCount(evidence.syntheticToolResults);
    }
    const gaps = (Object.keys(counts) as ExecutionRecordGap[])
      .filter(reason => counts[reason] > 0)
      .map(reason => ({ reason, count: counts[reason] }));
    return { taskId: this.taskId, terminal, status: gaps.length === 0 ? 'complete' : 'partial', source: this.source, gaps };
  }

  private openCall(id: string | undefined): void {
    // No id, or an id already in use: this call cannot be paired with a result of its own.
    if (id === undefined || this.open.has(id) || this.answered.has(id)) {
      this.counts.unpaired_tool_call += 1;
      return;
    }
    if (this.open.size === MAX_OPEN_TOOL_CALLS) {
      this.overflowed = true;
      return;
    }
    this.open.add(id);
  }

  private answerCall(id: string | undefined): void {
    if (id !== undefined && this.open.delete(id)) {
      this.answered.add(id);
      if (this.answered.size > MAX_OPEN_TOOL_CALLS) {
        const oldest = this.answered.values().next().value;
        if (oldest !== undefined) this.answered.delete(oldest);
      }
      return;
    }
    this.counts[id !== undefined && this.answered.has(id) ? 'duplicate_tool_result' : 'orphan_tool_result'] += 1;
  }
}

/** An adapter count that is not a non-negative safe integer is a contract violation, never a silent zero. */
function evidenceCount(value: number): number {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new TypeError('Session.evidence() returned a count that is not a non-negative safe integer');
}

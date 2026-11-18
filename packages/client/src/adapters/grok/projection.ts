import { AcpChildTurns, AcpTurnBuffer } from '../acp-turn-buffer.js';
import { objectRecord as record } from '../shared-rules.js';
import type { AgentEvent, RuntimeFailureClass } from '@byok-sdk/protocol';
import { runtimeFailureClassOf } from '../../runtime-failure.js';
import type { AcpRecord } from '../../runtime/acp-session-runtime.js';
import type { MessageDraftDelta } from '../../types.js';

type Usage = Extract<AgentEvent, { type: 'usage' }>;
/** The turn end the vendored ACP turn machinery recorded, as `GrokSession` reads it. */
export type GrokTurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly failure: RuntimeFailureClass; readonly reason: string; readonly fromText?: true };


/** Projects each ACP conversation independently and tracks SDK/native turns only at the root. */
export class GrokProjection {
  private readonly root = new AcpTurnBuffer();
  private readonly children: AcpChildTurns;
  /** The SDK prompt's input id, and whether the drained prompt request carrying it was recorded. */
  private sdkTurn?: { readonly inputId: string; drained: boolean };
  /** OAR adopted a turn Grok runs on its own (a background command or sub-agent wake) as the active turn. */
  private grokTurn = false;
  private closedGrokTurns = 0;
  /** Grok's id for the SDK prompt it runs, and whether a later queue report names another running prompt (#1942). */
  private sdkPrompt?: { id: string; superseded: boolean };

  constructor(rootSessionId: string) {
    this.children = new AcpChildTurns(rootSessionId);
  }

  /** The SDK sends a prompt named `inputId`, directly or through OAR's held input. */
  beginSdkTurn(inputId: string): void {
    this.sdkTurn = { inputId, drained: false };
    this.sdkPrompt = undefined;
  }
  endSdkTurn(): void {
    this.sdkTurn = undefined;
    this.sdkPrompt = undefined;
  }
  /** Grok reported a running prompt other than the SDK's while the SDK turn is still open: it has ended that prompt. */
  get sdkPromptSuperseded(): boolean {
    return this.sdkPrompt?.superseded === true;
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
    if (input.kind !== 'frame') return;
    const body = record(input.body);
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0 && body?.native === undefined) return;
    this.children.link(events);
    const path = this.children.path(input.sessionId, input.agentPath);
    if (path === undefined) return;
    const update = record(record(body?.native)?.update);
    if (path.length > 0) {
      const child = this.children.buffer(input.sessionId, path);
      const ended = child.consume(events, update, emit);
      if (ended !== undefined) {
        child.end(emit, ended.kind === 'aborted');
        child.flushUsage(emit);
      }
      this.children.lifecycle(input.sessionId, path, events, emit);
      return;
    }
    this.observeRunning(body, events);
    const ended = this.root.consume(events, update, emit, {
      draft: text => emit({ type: 'message_draft_delta', text, startsMessage: false }),
    });
    this.children.lifecycle(input.sessionId, path, events, emit);
    // A native turn reported after this frame's turn end belongs to the next prompt.
    let afterEnd = false;
    let grokTurnAfterEnd = false;
    for (const value of events) {
      const event = record(value);
      if (event?.kind === 'turn_ended') afterEnd = true;
      if (event?.kind !== 'turn_active' || event.inputId !== undefined) continue;
      if (afterEnd) grokTurnAfterEnd = true;
      else if (this.sdkTurn?.drained !== true) this.grokTurn = true;
    }
    if (ended !== undefined) this.endTurn(ended, emit, outcome);
    if (grokTurnAfterEnd) this.grokTurn = true;
  }

  /**
   * Grok runs one prompt at a time and names it in `_x.ai/queue/changed`. The
   * report that carries the SDK turn's `turn_active` names the SDK prompt; a
   * later one naming another prompt, or none, means Grok ended the SDK prompt
   * although its answer is not published yet.
   */
  private observeRunning(body: Record<string, unknown> | undefined, events: readonly unknown[]): void {
    if (this.sdkTurn === undefined || body?.type !== '_x.ai/queue/changed') return;
    // A replayed report is history, as the vendored native-turn tracker reads it (native-turns.ts).
    if (record(record(body.native)?._meta)?.isReplay === true) return;
    const running = record(body.native)?.runningPromptId;
    const id = typeof running === 'string' ? running : '';
    const sdkStart = events.some((value) => {
      const event = record(value);
      return event?.kind === 'turn_active' && (event.inputId === this.sdkTurn!.inputId || (event.inputId === undefined && this.sdkTurn!.drained));
    });
    if (sdkStart && id !== '') this.sdkPrompt = { id, superseded: false };
    else if (this.sdkPrompt !== undefined && id !== this.sdkPrompt.id) this.sdkPrompt.superseded = true;
  }

  private endTurn(turn: Record<string, unknown>, emit: (event: AgentEvent) => void, outcome: (turn: GrokTurnOutcome) => void): void {
    this.root.end(emit, turn.kind === 'aborted');
    this.children.flush(emit);
    if (this.grokTurn) {
      // Grok's own turn is no SDK task turn: its usage stays pending and is reported with the next one.
      this.grokTurn = false;
      this.closedGrokTurns += 1;
      return;
    }
    this.root.flushUsage(emit);
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
    return this.root.takePendingUsage();
  }

  flushChildUsage(emit: (event: AgentEvent) => void): void {
    this.children.flush(emit);
  }
}

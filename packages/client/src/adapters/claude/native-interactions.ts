import {
  NativeInteractionController,
  NativeInteractionError,
  type NativeInteractionEndReason,
  type NativeInteractionOptions,
  type NativeInteractionResponse,
  type NativeQuestion,
} from '../../native-interactions';
import { snapshotPlainData } from '../../util/plain-data';
import type { ClaudeStreamMessage } from './events';

export const CLAUDE_NATIVE_INTERACTION_CAPABILITIES = Object.freeze({
  approvalDecisions: Object.freeze(['allow-once', 'deny', 'cancel'] as const),
  structuredQuestions: true,
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function invalid(): never {
  throw new NativeInteractionError('invalid_request', 'malformed or unsupported Claude native control request');
}

/** Question and option IDs are local indices; wire answers use exact original text/labels. */
function parseQuestions(input: Record<string, unknown>): NativeQuestion[] {
  if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 32) invalid();
  const prompts = new Set<string>();
  return input.questions.map((question: unknown, index: number) => {
    if (!record(question) || !text(question.question) || prompts.has(question.question)
      || !text(question.header) || typeof question.multiSelect !== 'boolean'
      || !Array.isArray(question.options) || !question.options.length || question.options.length > 128) invalid();
    prompts.add(question.question);
    const labels = new Set<string>();
    const options = question.options.map((option: unknown, optionIndex: number) => {
      if (!record(option) || !text(option.label) || labels.has(option.label) || typeof option.description !== 'string') invalid();
      labels.add(option.label);
      return { id: String(optionIndex), label: option.label, description: option.description };
    });
    return { id: String(index), prompt: question.question, header: question.header, options, multiple: question.multiSelect, allowText: true };
  });
}

/** One opt-in bridge per owned Claude process. It never grants persistent permissions. */
export class ClaudeNativeInteractionBridge {
  private readonly controller: NativeInteractionController;
  private readonly active = new Map<string, string>();
  private readonly seen = new Set<string>();
  private write: ((frame: Record<string, unknown>) => Promise<void>) | undefined;
  private sessionRef: string | undefined;
  private accepting = false;
  private ended = false;

  constructor(private readonly options: NativeInteractionOptions, expectedSessionRef?: string) {
    this.sessionRef = expectedSessionRef;
    this.controller = new NativeInteractionController({
      ...options,
      onResolved: receipt => {
        for (const [nativeId, requestId] of this.active) {
          if (requestId === receipt.requestId) this.active.delete(nativeId);
        }
        return options.onResolved?.(receipt);
      },
      onFatal: error => this.fail(error),
    });
  }

  get channel() { return this.controller.channel; }

  bind(write: (frame: Record<string, unknown>) => Promise<void>): void { this.write = write; }

  beginTurn(): void {
    if (this.ended) throw new NativeInteractionError('closed', 'Claude native process generation is closed');
    this.accepting = true;
  }

  endTurn(reason: NativeInteractionEndReason): void {
    this.accepting = false;
    for (const requestId of this.active.values()) this.controller.withdraw(requestId, reason);
    this.active.clear();
  }

  close(reason: NativeInteractionEndReason = 'process-exited'): void {
    this.ended = true;
    this.accepting = false;
    this.controller.close(reason);
    this.active.clear();
  }

  receive(message: ClaudeStreamMessage): void {
    if (this.ended) return;
    if (message.type === 'system' && message.subtype === 'init') {
      if (!text(message.session_id) || (this.sessionRef !== undefined && this.sessionRef !== message.session_id)) {
        this.fail(new NativeInteractionError('invalid_request', 'Claude native session identity changed or is missing'));
      } else this.sessionRef = message.session_id;
      return;
    }
    if (message.type === 'result') { this.endTurn('turn-ended'); return; }
    if (message.type === 'control_cancel_request') {
      if (!text(message.request_id)) { this.fail(new NativeInteractionError('invalid_request', 'Claude cancellation has no request ID')); return; }
      const requestId = this.active.get(message.request_id);
      if (requestId !== undefined) this.controller.withdraw(requestId, 'provider-cancelled');
      return;
    }
    if (message.type !== 'control_request') return;
    try { this.open(message); }
    catch (error) {
      // An unrecognized/ambiguous request cannot safely be answered. Dispose
      // the owned process instead of silently ignoring or approving it.
      this.fail(error instanceof NativeInteractionError ? error : new NativeInteractionError('invalid_request', 'Claude native control request is not bounded inert JSON'));
    }
  }

  private open(message: ClaudeStreamMessage): void {
    if (!text(message.request_id) || !this.accepting || !this.sessionRef || !this.write) invalid();
    const id = message.request_id;
    if (this.seen.has(id)) throw new NativeInteractionError('duplicate_request', 'Claude native request ID was reused in this process generation');
    if (this.seen.size >= (this.options.maxRequests ?? 4096)) throw new NativeInteractionError('capacity', 'Claude native request lifetime bound exceeded');
    this.seen.add(id);
    const request = snapshotPlainData(message.request, { maxDepth: 8 });
    if (!record(request) || request.subtype !== 'can_use_tool' || !text(request.tool_name) || !record(request.input)
      || (request.tool_use_id !== undefined && !text(request.tool_use_id))
      || Buffer.byteLength(JSON.stringify(request)) > 64 * 1024) invalid();
    const originalInput = request.input;
    const questions = request.tool_name === 'AskUserQuestion' ? parseQuestions(originalInput) : undefined;
    const native = {
      id, method: 'can_use_tool', sessionRef: this.sessionRef,
      ...(request.tool_use_id === undefined ? {} : { itemId: request.tool_use_id }),
    };
    const respond = (response: Record<string, unknown>) => this.write!({
      type: 'control_response', response: { subtype: 'success', request_id: id, response },
    });
    const cancel = (reason: 'deadline' | 'cancelled') => {
      // Claude's interrupt cancels the turn, including any other pending prompts.
      this.accepting = false;
      for (const [nativeId, requestId] of this.active) {
        if (nativeId !== id) this.controller.withdraw(requestId, 'interrupted');
      }
      return respond({
        behavior: 'deny', message: reason === 'deadline' ? 'Native interaction timed out' : 'Native interaction cancelled', interrupt: true,
      });
    };
    const opened = this.controller.open(questions === undefined
      ? {
        native, kind: 'approval', title: text(request.title) ? request.title : `Allow ${request.tool_name}?`,
        details: {
          toolName: request.tool_name, input: originalInput,
          ...(text(request.description) ? { description: request.description } : {}),
          ...(text(request.blocked_path) ? { blockedPath: request.blocked_path } : {}),
          ...(text(request.decision_reason) ? { decisionReason: request.decision_reason } : {}),
        },
        decisions: CLAUDE_NATIVE_INTERACTION_CAPABILITIES.approvalDecisions,
      }
      : { native, kind: 'question', questions }, {
      respond: (response: NativeInteractionResponse) => {
        if (response.kind === 'approval') {
          if (response.decision === 'allow-once') return respond({ behavior: 'allow', updatedInput: originalInput });
          if (response.decision === 'deny') return respond({ behavior: 'deny', message: 'Native permission denied' });
          return cancel('cancelled');
        }
        if (response.kind !== 'question' || questions === undefined) return cancel('cancelled');
        const answers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
        for (const question of questions) {
          const answer = response.answers.find(value => value.questionId === question.id)!;
          const labels = answer.selectedOptionIds.map(id => question.options.find(option => option.id === id)!.label);
          if (answer.text?.trim()) labels.push(answer.text);
          answers[question.prompt] = question.multiple ? labels : labels[0]!;
        }
        return respond({ behavior: 'allow', updatedInput: { questions: originalInput.questions, answers } });
      },
      cancel,
    });
    this.active.set(id, opened.requestId);
  }

  private fail(error: NativeInteractionError): void {
    if (this.ended) return;
    this.close('process-exited');
    try { void Promise.resolve(this.options.onFatal(error)).catch(() => {}); } catch { /* owner already received the terminal failure */ }
  }
}

import type { Readable, Writable } from 'node:stream';
import {
  type NativeInteractionChannel,
  type NativeInteractionHostOptions,
  type NativeInteractionReceipt,
  type NativeInteractionRequest,
  type NativeInteractionResponse,
  type Session,
} from '@byok-sdk/client';
import { NativeInteractionError } from '@byok-sdk/client/adapters';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_REQUESTS = 256;
interface Entry {
  readonly request: NativeInteractionRequest;
  readonly channel: NativeInteractionChannel;
  displayed: boolean;
  submitted: boolean;
  responses: number;
}

/** Inert JSON rendering: provider text cannot emit terminal controls or spoof a new line. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Local single-operator presentation, not remote authentication or a persistence layer. */
export class TerminalInteractionHost {
  readonly nativeInteractions: NativeInteractionHostOptions;
  private session?: Session;
  private readonly entries = new Map<string, Entry>();
  private readonly printedReceipts = new Set<string>();
  private ended = false;
  private buffer = '';
  private bufferBytes = 0;
  private discarding = false;
  private stopInput?: () => void;
  private inputFailure?: () => void;
  private outputFailed = false;
  private readonly outputEnded = () => {
    if (this.outputFailed) return;
    this.outputFailed = true;
    this.stopInput?.();
    this.inputFailure?.();
  };

  constructor(
    readonly hostSessionId: string,
    readonly taskId: string,
    private readonly output: Writable,
    timeoutMs = 60_000,
  ) {
    // Install before startup can print anything. A borrowed terminal may close
    // while prepare/start is still in progress, before input has been attached.
    output.on('error', this.outputEnded);
    output.on('close', this.outputEnded);
    output.on('finish', this.outputEnded);
    this.nativeInteractions = {
      timeoutMs, maxRequests: MAX_REQUESTS, maxPending: 16,
      onRequest: (request, channel) => this.receive(request, channel),
      onResolved: receipt => this.receipt(receipt),
    };
  }

  bind(session: Session): void {
    this.assertOutputAvailable();
    if (this.session || this.ended || !session.interactions) throw new Error('Host session cannot bind');
    this.session = session;
    for (const entry of this.entries.values()) this.present(entry);
  }

  private receive(request: NativeInteractionRequest, channel: NativeInteractionChannel): void {
    if (this.ended || this.entries.size >= MAX_REQUESTS || this.entries.has(request.requestId)) {
      throw new Error('Host is not accepting native requests');
    }
    const entry: Entry = { request, channel, displayed: false, submitted: false, responses: 0 };
    this.entries.set(request.requestId, entry);
    if (this.session) this.present(entry);
  }

  private present(entry: Entry): void {
    const { request, channel } = entry;
    if (!this.session || channel !== this.session.interactions
      || request.generation !== channel.generation || request.native.sessionRef !== this.session.sessionRef) {
      throw new Error('Native request is outside this Host session');
    }
    if (!channel.pending().some(p => p.requestId === request.requestId) || Date.now() >= request.expiresAt) return;
    // This terminal is deliberately not a secure secret-entry surface. Never render secret prompts.
    if (request.kind === 'question' && request.questions.some(q => q.secret)) {
      this.write('unavailable', { requestId: request.requestId, reason: 'secret-input-unsupported' });
      void channel.respond({ requestId: request.requestId, kind: 'cancel' }).catch(() => {
        this.write('error', { code: 'secret-cancel-failed' });
        this.inputFailure?.();
      });
      return;
    }
    entry.displayed = true;
    const binding = { hostSessionId: this.hostSessionId, taskId: this.taskId,
      generation: request.generation, requestId: request.requestId };
    this.write('request', { ...binding, expiresAt: request.expiresAt, native: request.native,
      ...(request.kind === 'approval'
        ? { kind: request.kind, title: request.title, details: request.details, decisions: request.decisions }
        : { kind: request.kind, questions: request.questions }) });
    this.write('answer-template', { ...binding, ...(request.kind === 'approval'
      ? { kind: 'approval', decision: '<choose an offered decision>' }
      : { kind: 'question', answers: request.questions.map(q => ({ questionId: q.id,
        selectedOptionIds: [], ...(q.allowText ? { text: '<explicit answer>' } : {}) })) }) });
    this.write('cancel-template', { ...binding, kind: 'cancel' });
  }

  /** Every answer is an explicit line from this local operator, never provider output. */
  async answer(line: string): Promise<void> {
    try {
      if (this.ended || !this.session?.interactions) throw new Error('host-closed');
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('input-too-large');
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new Error('invalid-json'); }
      if (!record(value)) throw new Error('invalid-envelope');
      const allowed = ['hostSessionId', 'taskId', 'generation', 'requestId', 'kind',
        ...(value.kind === 'approval' ? ['decision'] : value.kind === 'question' ? ['answers'] : [])];
      if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid-envelope');
      if (value.hostSessionId !== this.hostSessionId || value.taskId !== this.taskId) throw new Error('wrong-host-task');
      const entry = typeof value.requestId === 'string' ? this.entries.get(value.requestId) : undefined;
      if (!entry?.displayed) throw new Error('unknown-request');
      const { request, channel } = entry;
      if (channel !== this.session.interactions || value.generation !== channel.generation
        || request.generation !== channel.generation || request.native.sessionRef !== this.session.sessionRef) {
        throw new Error('stale-generation');
      }
      // Only an already-submitted request can read its SDK tombstone. First answers
      // must still be pending. The SDK also rechecks state at the actual write.
      if (!entry.submitted && (Date.now() >= request.expiresAt
        || !channel.pending().some(p => p.requestId === request.requestId))) throw new Error('request-not-pending');
      const { hostSessionId: _host, taskId: _task, generation: _generation, ...response } = value;
      entry.submitted = true;
      try {
        const receipt = await channel.respond(response as NativeInteractionResponse);
        this.receipt(receipt, entry.responses++ > 0);
      } catch (error) {
        if (error instanceof NativeInteractionError && error.code === 'invalid_response'
          && channel.pending().some(p => p.requestId === request.requestId)) entry.submitted = false;
        throw error;
      }
    } catch (error) {
      // Never echo untrusted input, answer text, provider exception messages, or secrets.
      const known = ['host-closed', 'input-too-large', 'invalid-json', 'invalid-envelope',
        'wrong-host-task', 'unknown-request', 'stale-generation', 'request-not-pending'];
      this.write('error', { code: error instanceof NativeInteractionError ? error.code
        : error instanceof Error && known.includes(error.message) ? error.message : 'response-failed' });
    }
  }

  /** Bounded newline parser; EOF/error means close, never answer/retry/resume. */
  connectInput(input: Readable, onEnd: () => void): void {
    if (this.ended) { onEnd(); return; }
    if (this.stopInput) throw new Error('input already connected');
    this.inputFailure = onEnd;
    input.setEncoding('utf8');
    const data = (chunk: string) => {
      // Consume incrementally rather than retaining an arbitrary input chunk/line.
      for (const character of chunk) {
        if (character === '\n') {
          const line = this.buffer; this.buffer = ''; this.bufferBytes = 0;
          if (this.discarding) this.discarding = false;
          else if (line.trim()) void this.answer(line);
        } else if (!this.discarding) {
          this.buffer += character;
          this.bufferBytes += Buffer.byteLength(character);
          if (this.bufferBytes > MAX_LINE_BYTES) {
            this.buffer = ''; this.bufferBytes = 0; this.discarding = true;
            this.write('error', { code: 'input-too-large' });
          }
        }
      }
    };
    const end = () => { this.stopInput?.(); onEnd(); };
    input.on('data', data); input.once('end', end); input.once('error', end);
    this.stopInput = () => { input.off('data', data); input.off('end', end); input.off('error', end);
      this.buffer = ''; this.bufferBytes = 0; this.discarding = false; };
    if (input.readableEnded || input.destroyed || this.outputFailed) end();
  }

  stop(): void { this.ended = true; this.stopInput?.(); }
  assertOutputAvailable(): void {
    if (this.outputFailed || this.output.destroyed || this.output.writableEnded) {
      this.outputEnded();
      throw new Error('Host output is unavailable');
    }
  }
  /** Only release borrowed-stream listeners after SDK process disposal succeeds. */
  releaseOutput(): void {
    this.output.off('error', this.outputEnded);
    this.output.off('close', this.outputEnded);
    this.output.off('finish', this.outputEnded);
    this.inputFailure = undefined;
  }
  private receipt(receipt: NativeInteractionReceipt, explicit = false): void {
    const duplicate = this.printedReceipts.has(receipt.requestId);
    if (duplicate && !explicit) return;
    this.printedReceipts.add(receipt.requestId);
    this.write('receipt', { ...receipt, duplicate, meaning: 'local-transport-write-only' });
  }
  write(type: string, data: unknown): void {
    if (this.outputFailed || this.output.destroyed || this.output.writableEnded) {
      this.outputEnded(); return;
    }
    try { this.output.write(`${type} ${safeJson(data)}\n`); }
    catch {
      // Runtime output failure must not escape an input event or an ignored
      // observer promise. The owner is already disposing; startup explicitly
      // checks assertOutputAvailable() inside its ownership boundary.
      this.outputEnded();
    }
  }
}

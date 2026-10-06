import { randomUUID } from 'node:crypto';
import { snapshotPlainData } from './util/plain-data';

/** Native permission scope is explicit. There is intentionally no persistent grant. */
export type NativeApprovalDecision = 'allow-once' | 'allow-session' | 'deny' | 'cancel';
export interface NativeInteractionCapabilities {
  readonly approvalDecisions: readonly NativeApprovalDecision[];
  readonly structuredQuestions: boolean;
}
export interface NativeInteractionIdentity {
  /** Exact provider wire ID, including its original string/number type. */
  readonly id: string | number;
  readonly method: string;
  readonly sessionRef: string;
  readonly turnId?: string;
  readonly itemId?: string;
}
export interface NativeQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly header?: string;
  readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  readonly multiple: boolean;
  readonly allowText: boolean;
  readonly secret?: boolean;
}
export type NativeInteractionInput = {
  readonly native: NativeInteractionIdentity;
} & (
  | { readonly kind: 'approval'; readonly title: string; readonly decisions: readonly NativeApprovalDecision[] }
  | { readonly kind: 'question'; readonly questions: readonly NativeQuestion[] }
);
export type NativeInteractionRequest = NativeInteractionInput & {
  /** SDK identity, unique across process generations, never a tool call ID. */
  readonly requestId: string;
  readonly generation: string;
  readonly expiresAt: number;
};
export interface NativeQuestionAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly text?: string;
}
export type NativeInteractionResponse = { readonly requestId: string } & (
  | { readonly kind: 'approval'; readonly decision: NativeApprovalDecision }
  | { readonly kind: 'question'; readonly answers: readonly NativeQuestionAnswer[] }
  | { readonly kind: 'cancel' }
);
export type NativeInteractionEndReason = 'provider-cancelled' | 'interrupted' | 'turn-ended' | 'process-exited' | 'closed';
export interface NativeInteractionReceipt {
  readonly requestId: string;
  readonly status: 'responded' | 'cancelled' | 'timed-out' | 'failed';
  readonly reason?: NativeInteractionEndReason | 'deadline' | 'transport';
}
/** Local host surface. A snapshot contains only requests still awaiting a decision. */
export interface NativeInteractionChannel {
  readonly generation: string;
  pending(): readonly NativeInteractionRequest[];
  respond(response: NativeInteractionResponse): Promise<NativeInteractionReceipt>;
}
export interface NativeInteractionOptions {
  readonly onRequest: (request: NativeInteractionRequest, channel: NativeInteractionChannel) => void | Promise<void>;
  readonly onResolved?: (receipt: NativeInteractionReceipt) => void | Promise<void>;
  /** Required owner action for an uncertain/failed native write; normally terminate the owned process. */
  readonly onFatal: (error: NativeInteractionError) => void | Promise<void>;
  readonly timeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly maxPending?: number;
  /** All request identities/tombstones are retained up to this lifetime bound; none are evicted/reused. */
  readonly maxRequests?: number;
}
export interface NativeInteractionTransport {
  respond(response: NativeInteractionResponse): Promise<void>;
  cancel(reason: 'deadline' | 'cancelled'): Promise<void>;
}
export type NativeInteractionErrorCode =
  | 'invalid_request' | 'invalid_response' | 'unknown_request' | 'duplicate_request'
  | 'response_conflict' | 'request_settled' | 'closed' | 'capacity' | 'transport';
export class NativeInteractionError extends Error {
  constructor(readonly code: NativeInteractionErrorCode, message: string) {
    super(message);
    this.name = 'NativeInteractionError';
  }
}
interface Entry {
  readonly request: NativeInteractionRequest;
  readonly transport: NativeInteractionTransport;
  readonly completion: Promise<NativeInteractionReceipt>;
  readonly complete: (receipt: NativeInteractionReceipt) => void | Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  writeTimer?: ReturnType<typeof setTimeout>;
  state: 'pending' | 'responding' | 'settled';
  writeStarted?: boolean;
  responseKey?: string;
  receipt?: NativeInteractionReceipt;
}
const decisions: readonly NativeApprovalDecision[] = ['allow-once', 'allow-session', 'deny', 'cancel'];
const MAX_BYTES = 64 * 1024;
const error = (code: NativeInteractionErrorCode, message: string) => new NativeInteractionError(code, message);
function boundedInteger(value: number, name: string, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`invalid ${name}`);
  return value;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[], code: NativeInteractionErrorCode): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw error(code, 'unknown interaction field');
}
function snapshot<T>(value: T, code: NativeInteractionErrorCode): T {
  let encoded: string;
  let copy: T;
  try { copy = snapshotPlainData(value, { maxDepth: 8, allowUndefined: true }) as T; encoded = JSON.stringify(copy); } catch { throw error(code, 'interaction must be bounded inert JSON data'); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_BYTES) throw error(code, 'interaction exceeds the payload bound');
  function freeze(item: unknown): void {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  }
  freeze(copy);
  return copy;
}
function validateInput(input: NativeInteractionInput): void {
  if (!object(input) || !object(input.native)) throw error('invalid_request', 'native identity is required');
  keys(input, input.kind === 'approval' ? ['native', 'kind', 'title', 'decisions'] : ['native', 'kind', 'questions'], 'invalid_request');
  const native = input.native;
  keys(native, ['id', 'method', 'sessionRef', 'turnId', 'itemId'], 'invalid_request');
  if (!(text(native.id) || (typeof native.id === 'number' && Number.isSafeInteger(native.id))) || !text(native.method) || !text(native.sessionRef)
    || (native.turnId !== undefined && !text(native.turnId)) || (native.itemId !== undefined && !text(native.itemId))) {
    throw error('invalid_request', 'invalid native request identity');
  }
  if (input.kind === 'approval') {
    if (!text(input.title) || !Array.isArray(input.decisions) || !input.decisions.length
      || new Set(input.decisions).size !== input.decisions.length || input.decisions.some(d => !decisions.includes(d))) {
      throw error('invalid_request', 'invalid approval decisions');
    }
  } else if (input.kind === 'question') {
    if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 32) throw error('invalid_request', 'invalid questions');
    const ids = new Set<string>();
    for (const q of input.questions) {
      if (!object(q)) throw error('invalid_request', 'invalid question');
      keys(q, ['id', 'prompt', 'header', 'options', 'multiple', 'allowText', 'secret'], 'invalid_request');
      if (!text(q.id) || ids.has(q.id) || !text(q.prompt) || typeof q.multiple !== 'boolean' || typeof q.allowText !== 'boolean'
        || (q.header !== undefined && !text(q.header)) || (q.secret !== undefined && typeof q.secret !== 'boolean')
        || !Array.isArray(q.options) || q.options.length > 128 || (!q.options.length && !q.allowText)) throw error('invalid_request', 'invalid question');
      ids.add(q.id);
      const opts = new Set<string>();
      for (const option of q.options) {
        if (!object(option)) throw error('invalid_request', 'invalid question option');
        keys(option, ['id', 'label', 'description'], 'invalid_request');
        if (!text(option.id) || opts.has(option.id) || !text(option.label) || (option.description !== undefined && typeof option.description !== 'string')) throw error('invalid_request', 'invalid question option');
        opts.add(option.id);
      }
    }
  } else throw error('invalid_request', 'unsupported interaction kind');
}
function normalizeResponse(request: NativeInteractionRequest, input: NativeInteractionResponse): NativeInteractionResponse {
  const response = snapshot(input, 'invalid_response');
  if (!object(response) || response.requestId !== request.requestId) throw error('invalid_response', 'invalid response identity');
  keys(response, response.kind === 'approval' ? ['requestId', 'kind', 'decision'] : response.kind === 'question' ? ['requestId', 'kind', 'answers'] : ['requestId', 'kind'], 'invalid_response');
  if (response.kind === 'cancel') return Object.freeze({ requestId: response.requestId, kind: 'cancel' });
  if (response.kind === 'approval' && request.kind === 'approval' && request.decisions.includes(response.decision)) return Object.freeze({ requestId: response.requestId, kind: 'approval', decision: response.decision });
  if (response.kind !== 'question' || request.kind !== 'question' || !Array.isArray(response.answers) || response.answers.length !== request.questions.length) {
    throw error('invalid_response', 'response does not match the requested interaction');
  }
  const answers = new Map<string, NativeQuestionAnswer>();
  for (const answer of response.answers) {
    if (!object(answer)) throw error('invalid_response', 'invalid question answer');
    keys(answer, ['questionId', 'selectedOptionIds', 'text'], 'invalid_response');
    if (!text(answer.questionId) || answers.has(answer.questionId)) throw error('invalid_response', 'duplicate or invalid question answer');
    answers.set(answer.questionId, answer as unknown as NativeQuestionAnswer);
  }
  const normalized = request.questions.map(q => {
    const answer = answers.get(q.id);
    if (!answer || !Array.isArray(answer.selectedOptionIds) || answer.selectedOptionIds.some(id => !q.options.some(o => o.id === id))
      || new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length
      || (!q.multiple && answer.selectedOptionIds.length > 1)
      || (answer.text !== undefined && (!q.allowText || typeof answer.text !== 'string'))
      || (!answer.selectedOptionIds.length && !answer.text?.trim())) throw error('invalid_response', 'answer is outside the question schema');
    return { questionId: q.id, selectedOptionIds: [...answer.selectedOptionIds].sort(), ...(answer.text === undefined ? {} : { text: answer.text }) };
  });
  return snapshot({ requestId: response.requestId, kind: 'question', answers: normalized }, 'invalid_response');
}

/**
 * One process lifetime's request registry. A resumed runtime gets a new controller;
 * native IDs from its previous process are never reconstructed or replayed here.
 * This is a local adapter/Host seam, not a remote authorization or persistence API.
 */
export class NativeInteractionController {
  readonly channel: NativeInteractionChannel;
  private readonly entries = new Map<string, Entry>();
  private readonly nativeIds = new Set<string>();
  private readonly generation = randomUUID();
  private readonly timeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly maxPending: number;
  private readonly maxRequests: number;
  private closed = false;
  private fatal = false;
  constructor(private readonly options: NativeInteractionOptions) {
    if (typeof options.onRequest !== 'function' || typeof options.onFatal !== 'function') throw new TypeError('native interaction handlers are required');
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 60_000, 'interaction timeout');
    this.writeTimeoutMs = boundedInteger(options.writeTimeoutMs ?? 1_000, 'interaction write timeout');
    this.maxPending = boundedInteger(options.maxPending ?? 32, 'interaction pending bound', 4096);
    this.maxRequests = boundedInteger(options.maxRequests ?? 4096, 'interaction lifetime bound', 65536);
    this.channel = Object.freeze({
      generation: this.generation,
      pending: () => Object.freeze([...this.entries.values()].filter(e => e.state === 'pending').map(e => e.request)),
      respond: (response: NativeInteractionResponse) => this.respond(response),
    });
  }
  open(input: NativeInteractionInput, transport: NativeInteractionTransport): NativeInteractionRequest {
    if (this.closed) throw error('closed', 'interaction process generation is closed');
    const copy = snapshot(input, 'invalid_request');
    validateInput(copy);
    const nativeKey = JSON.stringify([typeof copy.native.id, copy.native.id]);
    if (this.nativeIds.has(nativeKey)) throw error('duplicate_request', 'native request ID was already used in this process generation');
    if (this.entries.size >= this.maxRequests || [...this.entries.values()].filter(e => e.state !== 'settled' || e.writeStarted).length >= this.maxPending) throw error('capacity', 'native interaction capacity exceeded');
    const request = snapshot({ ...copy, requestId: `${this.generation}:${this.entries.size + 1}`, generation: this.generation, expiresAt: Date.now() + this.timeoutMs }, 'invalid_request') as NativeInteractionRequest;
    let complete!: (receipt: NativeInteractionReceipt) => void | Promise<void>;
    const completion = new Promise<NativeInteractionReceipt>(resolve => { complete = resolve; });
    const entry: Entry = { request, transport, completion, complete, state: 'pending' };
    this.entries.set(request.requestId, entry);
    this.nativeIds.add(nativeKey);
    entry.timer = setTimeout(() => this.write(entry, () => transport.cancel('deadline'), { requestId: request.requestId, status: 'timed-out', reason: 'deadline' }), this.timeoutMs);
    const observerFailed = () => this.write(entry, () => transport.cancel('cancelled'), { requestId: request.requestId, status: 'cancelled' });
    try { void Promise.resolve(this.options.onRequest(request, this.channel)).catch(observerFailed); }
    catch { observerFailed(); }
    return request;
  }
  /** Provider cancellation/turn end does not write another native answer. */
  withdraw(requestId: string, reason: NativeInteractionEndReason = 'provider-cancelled'): void {
    const entry = this.entries.get(requestId);
    if (entry && entry.state !== 'settled') this.settle(entry, { requestId, status: 'cancelled', reason });
  }
  /** Process exit/close invalidates all outstanding requests, without replay or transport writes. */
  close(reason: NativeInteractionEndReason = 'closed'): void {
    this.closed = true;
    for (const entry of this.entries.values()) this.withdraw(entry.request.requestId, reason);
  }
  private async respond(input: NativeInteractionResponse): Promise<NativeInteractionReceipt> {
    const copied = snapshot(input, 'invalid_response');
    if (!object(copied) || !text(copied.requestId)) throw error('invalid_response', 'invalid response identity');
    const entry = this.entries.get(copied.requestId);
    if (!entry) throw error('unknown_request', 'request is not from this process generation');
    const response = normalizeResponse(entry.request, copied);
    const key = JSON.stringify(response);
    if (entry.responseKey !== undefined) {
      if (entry.responseKey !== key) throw error('response_conflict', 'request already has a different response');
      return entry.completion;
    }
    if (entry.state !== 'pending') throw error('request_settled', 'request is no longer awaiting an answer');
    entry.responseKey = key;
    this.write(entry, () => response.kind === 'cancel' ? entry.transport.cancel('cancelled') : entry.transport.respond(response), {
      requestId: response.requestId, status: response.kind === 'cancel' ? 'cancelled' : 'responded',
    });
    return entry.completion;
  }
  private write(entry: Entry, operation: () => Promise<void>, receipt: NativeInteractionReceipt): void {
    if (entry.state !== 'pending') return;
    entry.state = 'responding';
    clearTimeout(entry.timer);
    const fail = () => {
      // Cancellation settles the request, not ownership of an already-started write.
      if (entry.state === 'settled' && !entry.writeStarted) return;
      entry.writeStarted = false;
      clearTimeout(entry.writeTimer);
      this.settle(entry, { requestId: entry.request.requestId, status: 'failed', reason: 'transport' });
      this.close('process-exited');
      if (!this.fatal) {
        this.fatal = true;
        try { void Promise.resolve(this.options.onFatal(error('transport', 'native interaction write failed or its outcome is uncertain'))).catch(() => {}); } catch { /* state is already closed */ }
      }
    };
    entry.writeTimer = setTimeout(fail, this.writeTimeoutMs);
    // Fence before the microtask so synchronous cancellation/exit prevents a queued write.
    void Promise.resolve().then(() => {
      if (entry.state === 'responding') { entry.writeStarted = true; return operation(); }
    }).then(() => {
      entry.writeStarted = false;
      clearTimeout(entry.writeTimer);
      if (entry.state === 'responding') this.settle(entry, receipt);
    }, fail);
  }
  private settle(entry: Entry, receipt: NativeInteractionReceipt): void {
    if (entry.state === 'settled') return;
    entry.state = 'settled';
    clearTimeout(entry.timer);
    if (!entry.writeStarted) clearTimeout(entry.writeTimer);
    entry.receipt = Object.freeze(receipt);
    entry.complete(entry.receipt);
    try { void Promise.resolve(this.options.onResolved?.(entry.receipt)).catch(() => {}); } catch { /* observer failure cannot replay a decision */ }
  }
}

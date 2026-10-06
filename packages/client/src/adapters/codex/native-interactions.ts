import {
  NativeInteractionController, NativeInteractionError, type NativeInteractionChannel, type NativeInteractionHostOptions,
  type NativeInteractionIdentity, type NativeQuestion,
} from '../../native-interactions';
import { snapshotPlainData } from '../../util/plain-data';

export interface CodexNativeReply {
  respond(value: Record<string, unknown>): Promise<void>;
  reject(code: number, message: string): Promise<void>;
  cancelled(): void;
}
const approvals = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
const key = (id: string | number) => JSON.stringify([typeof id, id]);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** Qualified against Codex rust-v0.160.0. Not an MCP elicitation or dynamic-tool bridge. */
export class CodexNativeInteractions {
  readonly channel: NativeInteractionChannel;
  private readonly controller: NativeInteractionController;
  private ended = false;
  private accepting = false;
  private activeTurn: string | undefined;
  private readonly seen = new Set<string>();
  private readonly maxRequests: number;
  private readonly requests = new Map<string, { requestId: string; turnId: string; reply: CodexNativeReply }>();
  constructor(private readonly sessionRef: () => string, options: NativeInteractionHostOptions, onFatal: () => void) {
    this.maxRequests = options.maxRequests ?? 4096;
    this.controller = new NativeInteractionController({ ...options, onFatal });
    this.channel = this.controller.channel;
  }
  receive(id: string | number, method: string, raw: Record<string, unknown>, reply: CodexNativeReply): void {
    if (this.ended || !this.accepting) throw new NativeInteractionError('closed', 'native interaction turn is not accepting requests');
    if (!(text(id) || (typeof id === 'number' && Number.isSafeInteger(id)))) throw new NativeInteractionError('invalid_request', 'invalid native RPC request ID');
    const wireKey = key(id);
    if (this.seen.has(wireKey)) throw new NativeInteractionError('duplicate_request', 'native RPC request ID already used');
    if (this.seen.size >= this.maxRequests) throw new NativeInteractionError('capacity', 'native RPC lifetime request bound exceeded');
    this.seen.add(wireKey);
    if (!approvals.has(method) && method !== 'item/tool/requestUserInput') {
      void reply.reject(-32601, 'unsupported native interaction').catch(() => {});
      return;
    }
    // Native frames are untrusted data; never expose mutable transport-owned objects to a Host.
    let params: Record<string, unknown>;
    try {
      params = snapshotPlainData(raw, { maxDepth: 8 }) as Record<string, unknown>;
      if (Buffer.byteLength(JSON.stringify(params)) > 64 * 1024 || !record(params)
        || params.threadId !== this.sessionRef() || !text(params.turnId) || params.turnId !== this.activeTurn || !text(params.itemId)) throw new Error('invalid native identity');
    } catch {
      void reply.reject(-32602, 'invalid native interaction identity or payload').catch(() => {});
      return;
    }
    const native: NativeInteractionIdentity = { id, method, sessionRef: params.threadId as string, turnId: params.turnId as string, itemId: params.itemId as string };
    const forget = () => this.requests.delete(wireKey);
    let questions: readonly NativeQuestion[] | undefined;
    if (!approvals.has(method)) {
      try { questions = parseQuestions(params.questions); }
      catch { void reply.reject(-32602, 'invalid native questions').catch(() => {}); return; }
    }
    const request = this.controller.open(questions === undefined ? {
      kind: 'approval', native,
      title: method === 'item/fileChange/requestApproval' ? 'Approve file changes' : 'Approve command execution',
      details: params,
      decisions: ['allow-once', 'allow-session', 'deny', 'cancel'],
    } : { kind: 'question', native, questions }, {
      respond: async response => {
        try {
        if (response.kind === 'approval') {
          const decisions = { 'allow-once': 'accept', 'allow-session': 'acceptForSession', deny: 'decline', cancel: 'cancel' } as const;
          await reply.respond({ decision: decisions[response.decision] });
        } else if (response.kind === 'question') {
          // Provider question IDs and option labels remain keys/values; no steer or synthetic prompt.
          const answers: Record<string, { answers: string[] }> = Object.create(null);
          for (const answer of response.answers) {
            answers[answer.questionId] = { answers: [...answer.selectedOptionIds, ...(answer.text ? [answer.text] : [])] };
          }
          await reply.respond({ answers });
        }
        } finally { forget(); }
      },
      cancel: async () => {
        try {
        if (questions === undefined) await reply.respond({ decision: 'cancel' });
        // User-input has no cancel-result variant. Reject its RPC rather than forge an empty answer.
        else await reply.reject(-32000, 'native user input cancelled');
        } finally { forget(); }
      },
    });
    this.requests.set(wireKey, { requestId: request.requestId, turnId: params.turnId as string, reply });
  }
  beginTurn(): void {
    if (this.ended) throw new NativeInteractionError('closed', 'native interaction process generation is closed');
    this.accepting = true;
    this.activeTurn = undefined;
  }
  notification(method: string, params: Record<string, unknown>): void {
    if (this.ended || params.threadId !== this.sessionRef()) return;
    if (method === 'turn/started' && this.accepting && record(params.turn) && text(params.turn.id)) this.activeTurn = params.turn.id;
    if (method === 'serverRequest/resolved' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
      const wireKey = key(params.requestId); const pending = this.requests.get(wireKey);
      if (pending) { this.requests.delete(wireKey); this.controller.withdraw(pending.requestId, 'provider-cancelled'); pending.reply.cancelled(); }
    }
    if (method === 'turn/completed' && record(params.turn) && params.turn.id === this.activeTurn) { this.activeTurn = undefined; this.accepting = false; }
    if ((method === 'turn/completed' || method === 'turn/started') && record(params.turn) && text(params.turn.id)) {
      for (const [wireKey, pending] of this.requests) if (method === 'turn/completed' ? pending.turnId === params.turn.id : pending.turnId !== params.turn.id) {
        this.requests.delete(wireKey); this.controller.withdraw(pending.requestId, 'turn-ended'); pending.reply.cancelled();
      }
    }
  }
  interrupt(): void {
    this.accepting = false;
    this.activeTurn = undefined;
    for (const pending of this.requests.values()) { this.controller.withdraw(pending.requestId, 'interrupted'); pending.reply.cancelled(); }
    this.requests.clear();
  }
  close(reason: 'closed' | 'process-exited' = 'closed'): void {
    this.ended = true;
    this.accepting = false;
    this.controller.close(reason);
    for (const pending of this.requests.values()) { try { pending.reply.cancelled(); } catch { /* terminal record budget may already be exhausted */ } }
    this.requests.clear();
  }
}
function parseQuestions(value: unknown): readonly NativeQuestion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error('invalid questions');
  return value.map(q => {
    if (!record(q) || !text(q.id) || !text(q.question) || typeof q.header !== 'string' || typeof q.isOther !== 'boolean' || typeof q.isSecret !== 'boolean'
      || (q.options !== null && !Array.isArray(q.options))) throw new Error('invalid question');
    const options = (q.options ?? []).map((option: unknown) => {
      if (!record(option) || !text(option.label) || typeof option.description !== 'string') throw new Error('invalid option');
      return { id: option.label, label: option.label, description: option.description };
    });
    return { id: q.id, prompt: q.question, ...(q.header ? { header: q.header } : {}), options, multiple: false, allowText: q.isOther || q.options === null, secret: q.isSecret };
  });
}

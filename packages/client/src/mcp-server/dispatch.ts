/**
 * JSON-RPC 2.0 classification and per-session id bookkeeping.
 *
 * Everything here runs BEFORE a tool handler can be reached. A message that
 * does not classify as a well-formed request never reaches `callTool`, which is
 * the point: a server's tool logic should never have to defend itself against a
 * malformed envelope, and today's four hand-rolled helpers each do, differently.
 */

/** A JSON-RPC 2.0 id this core will answer: a string, or an INTEGER number. `0` is valid and common. */
export type McpServerRequestId = string | number;

export type ClassifiedMessage =
  | { readonly kind: 'request'; readonly id: McpServerRequestId; readonly method: string; readonly params: Record<string, unknown> | undefined }
  | { readonly kind: 'notification'; readonly method: string; readonly params: Record<string, unknown> | undefined }
  /** `id` is `undefined` when no usable id could be read at all — the one case where a response may omit or null it. */
  | { readonly kind: 'invalid'; readonly id: McpServerRequestId | undefined; readonly message: string };

/**
 * The official client sends monotonic INTEGER ids starting at `0`
 * (`_requestMessageId = 0`), so every id test must be a type test. `if (!id)`
 * and `if (id)` are both bugs against a real peer's very first request.
 */
export function isUsableRequestId(value: unknown): value is McpServerRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

function namedParams(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Classifies one already-parsed JSON value.
 *
 * The id is read FIRST, so a message that is invalid for some other reason
 * still echoes the id the peer can correlate. A batch array is classified
 * `invalid` rather than expanded: this core does not implement batch receipt,
 * which is exactly why the advertised version list excludes every revision that
 * makes receiving one a MUST.
 */
export function classifyJsonRpcMessage(value: unknown): ClassifiedMessage {
  if (Array.isArray(value)) {
    return { kind: 'invalid', id: undefined, message: 'JSON-RPC batch arrays are not supported' };
  }
  if (value === null || typeof value !== 'object') {
    return { kind: 'invalid', id: undefined, message: 'a JSON-RPC message must be an object' };
  }
  const message = value as Record<string, unknown>;
  const carriesId = Object.prototype.hasOwnProperty.call(message, 'id');
  const usableId = carriesId && isUsableRequestId(message.id) ? (message.id as McpServerRequestId) : undefined;

  if (message.jsonrpc !== '2.0') {
    return { kind: 'invalid', id: usableId, message: 'jsonrpc must be exactly "2.0"' };
  }
  if (carriesId && usableId === undefined) {
    return { kind: 'invalid', id: undefined, message: 'id must be a string or an integer number' };
  }
  if (typeof message.method !== 'string') {
    return { kind: 'invalid', id: usableId, message: 'method must be a string' };
  }
  if (message.params !== undefined && namedParams(message.params) === undefined && !Array.isArray(message.params)) {
    return { kind: 'invalid', id: usableId, message: 'params must be an object or an array' };
  }
  const params = namedParams(message.params);
  if (usableId === undefined) {
    return { kind: 'notification', method: message.method, params };
  }
  return { kind: 'request', id: usableId, method: message.method, params };
}

/**
 * Per-session record of every request id already answered.
 *
 * BOUNDED, deliberately. A session that issues more than `capacity` distinct
 * ids can no longer detect a replay of an EVICTED id; that is the trade taken
 * against an unbounded set a peer could grow on purpose. The official client's
 * ids are monotonic integers from 0, so eviction never produces a false
 * positive against a real peer.
 */
export class SeenRequestIds {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** `true` when this id has already been used in this session. */
  has(id: McpServerRequestId): boolean {
    return this.seen.has(SeenRequestIds.key(id));
  }

  /** Records the id, evicting the oldest once `capacity` is reached. */
  add(id: McpServerRequestId): void {
    const key = SeenRequestIds.key(id);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }

  /** `"7"` and `7` are different JSON-RPC ids and must not collide. */
  static key(id: McpServerRequestId): string {
    return typeof id === 'string' ? `s:${id}` : `n:${id}`;
  }
}

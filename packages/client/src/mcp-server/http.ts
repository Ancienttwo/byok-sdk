import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { classifyJsonRpcMessage, isUsableRequestId, SeenRequestIds } from './dispatch';
import { MCP_SERVER_MAX_PENDING_BYTES } from './framing';
import { MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS, McpServerToolError, serveMcpOverStdio, type McpServerHandle, type McpServerOptions } from './index';

/** Maximum accepted HTTP request body, in UTF-8 bytes. */
export const MCP_HTTP_MAX_BODY_BYTES = 4 * 1_048_576;
const HTTP_VERSIONS = MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS.filter(version => version !== '2024-11-05');

export interface McpHttpServerOptions extends Omit<McpServerOptions, 'input' | 'output' | 'onClose' | 'maxLineBytes'> {
  /** Stateful by default. Stateless mode retains no sessions and disallows SSE. */
  readonly sessionMode?: 'stateful' | 'stateless';
  /** Trusted public origin, e.g. https://host.example. Never derive it from the request Host header. */
  readonly origin: string;
  /** Positive integer, at most MCP_HTTP_MAX_BODY_BYTES. */
  readonly maxBodyBytes?: number;
  /** Bounds idle sessions as well as emitter subscriptions. Default 64. Applies only in stateful mode. */
  readonly maxSessions?: number;
  /** Idle lifetime without pending core replies. SSE alone does not keep a session alive. Default 15 minutes. Applies only in stateful mode. */
  readonly idleTimeoutMs?: number;
}

export interface McpHttpServer {
  /** Mount at one MCP endpoint after Host authentication. Each authenticated caller owns a separate instance. */
  fetch(request: Request): Promise<Response>;
  /** Abort calls, close SSE streams and release all session resources. Idempotent. */
  close(): void;
}

interface PendingReply { resolve(response: Response): void; status: number; token?: string | number; requestId?: string | number; stream?: ReadableStreamDefaultController<Uint8Array> }
interface Session {
  id: string;
  version: string;
  touchedAt: number;
  input: PassThrough;
  output: Writable;
  core?: McpServerHandle;
  pending: Map<string, PendingReply>;
  sse?: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

function positiveInteger(value: number, name: string, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new TypeError(`invalid ${name}`);
  return value;
}

function trustedOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new TypeError('origin must be HTTPS or loopback HTTP, without a path or credentials');
  }
  return value;
}

function accepts(header: string | null, mediaType: string): boolean {
  return (header ?? '').split(',').some(entry => {
    const [type, ...parameters] = entry.trim().toLowerCase().split(';');
    return type === mediaType && !parameters.some(parameter => /^q\s*=\s*0(?:\.0*)?$/.test(parameter.trim()));
  });
}

/**
 * Streamable HTTP framing for the existing bounded MCP core. No tool semantics,
 * listener, auth or caller ledger. The Host owns routing, TLS and authentication.
 * Sessions are scoped to this instance; never share it between authenticated callers.
 */
export function createMcpHttpServer(options: McpHttpServerOptions): McpHttpServer {
  const origin = trustedOrigin(options.origin);
  if (options.sessionMode !== undefined && !['stateful', 'stateless'].includes(options.sessionMode)) throw new TypeError('invalid sessionMode');
  const stateless = options.sessionMode === 'stateless';
  if (stateless && options.toolsListChanged) throw new TypeError('stateless HTTP MCP does not support toolsListChanged');
  const maxBodyBytes = positiveInteger(options.maxBodyBytes ?? MCP_HTTP_MAX_BODY_BYTES, 'maxBodyBytes', MCP_HTTP_MAX_BODY_BYTES);
  const maxSessions = positiveInteger(options.maxSessions ?? 64, 'maxSessions');
  const idleTimeoutMs = positiveInteger(options.idleTimeoutMs ?? 15 * 60_000, 'idleTimeoutMs');
  const maxInFlight = positiveInteger(options.maxInFlight ?? 64, 'maxInFlight');
  positiveInteger(options.maxOutboundFrameBytes ?? 1_048_576, 'maxOutboundFrameBytes');
  if (options.tools.length === 0 || new Set(options.tools.map(tool => tool.name)).size !== options.tools.length) {
    throw new TypeError('HTTP MCP requires a nonempty list of uniquely named tools');
  }
  const sessions = new Map<string, Session>();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let closed = false;
  let pendingCount = 0;
  let runningTools = 0;
  const textEncoder = new TextEncoder();
  const failure = (status: number, message: string) => new Response(message, { status, headers: { 'cache-control': 'no-store' } });

  function finishReply(session: Session, key: string, response: Response): void {
    const reply = session.pending.get(key);
    if (!reply) return;
    session.pending.delete(key);
    pendingCount--;
    session.touchedAt = Date.now();
    if (reply.stream) {
      if (response.status >= 400) reply.stream.error(new Error(`MCP stream terminated (${response.status})`));
      else reply.stream.close();
    }
    else reply.resolve(response);
  }

  function endSse(session: Session): void {
    const controller = session.sse;
    session.sse = undefined;
    controller?.close();
  }

  function dispose(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    session.core?.close();
    for (const key of session.pending.keys()) finishReply(session, key, failure(503, 'MCP session closed'));
    endSse(session);
    session.input.destroy();
    session.output.destroy();
  }

  function evictOldestIdleSession(): boolean {
    let oldest: Session | undefined;
    for (const candidate of sessions.values()) {
      if (candidate.pending.size === 0 && (!oldest || candidate.touchedAt < oldest.touchedAt)) oldest = candidate;
    }
    if (!oldest) return false;
    dispose(oldest);
    return true;
  }

  function deliver(session: Session, frame: string): void {
    const message = JSON.parse(frame) as Record<string, unknown>;
    if (message.method === 'notifications/progress') {
      const token = (message.params as Record<string, unknown>).progressToken;
      for (const [key, reply] of session.pending) {
        if (reply.stream && reply.token === token) {
          const bytes = textEncoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
          if ((reply.stream.desiredSize ?? 0) < bytes.byteLength) {
            session.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: reply.requestId } })}\n`);
            finishReply(session, key, failure(503, 'MCP progress buffer limit'));
          } else reply.stream.enqueue(bytes);
          return;
        }
      }
      return;
    }
    if ('method' in message) {
      if (session.sse) {
        const bytes = textEncoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        if ((session.sse.desiredSize ?? 0) < bytes.byteLength) endSse(session);
        else session.sse.enqueue(bytes);
      }
      return;
    }
    const key = isUsableRequestId(message.id) ? SeenRequestIds.key(message.id) : 'invalid';
    const reply = session.pending.get(key);
    if (reply?.stream) {
      const bytes = textEncoder.encode(`event: message\ndata: ${frame.trimEnd()}\n\n`);
      if ((reply.stream.desiredSize ?? 0) >= bytes.byteLength) reply.stream.enqueue(bytes);
      else { reply.stream.error(new Error('MCP response buffer limit')); reply.stream = undefined; }
    }
    if (reply) finishReply(session, key, new Response(frame.trimEnd(), { status: reply.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(stateless ? {} : { 'mcp-session-id': session.id }) } }));
  }

  function createSession(version: string, bootstrap?: string): Session {
    const session: Session = { id: randomUUID(), version, touchedAt: Date.now(), input: new PassThrough(),
      output: new Writable({ write(chunk, _encoding, callback) { deliver(session, chunk.toString()); callback(); } }),
      pending: new Map(), closed: false };
    session.core = serveMcpOverStdio({ ...options, input: session.input, output: session.output,
      maxLineBytes: Math.max(maxBodyBytes, bootstrap === undefined ? 0 : Buffer.byteLength(bootstrap)), maxInFlight, onClose: () => dispose(session),
      callTool: async call => {
        // Keep cancelled, uncooperative handlers counted until they settle,
        // even after their HTTP response or session has closed.
        if (runningTools >= maxInFlight) throw new McpServerToolError(-32000, 'HTTP MCP tool limit reached');
        runningTools++;
        try { return await options.callTool(call); }
        finally { runningTools--; }
      } });
    if (!session.closed) {
      sessions.set(session.id, session);
      if (bootstrap !== undefined) session.input.write(`${bootstrap}\n`);
    }
    return session;
  }

  async function body(request: Request): Promise<string | Response> {
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBodyBytes)) {
      void request.body?.cancel().catch(() => {});
      return failure(413, 'MCP body limit exceeded');
    }
    if (!request.body) return '';
    if (readers.size >= maxInFlight) return failure(503, 'Too many MCP request bodies');
    const reader = request.body.getReader();
    readers.add(reader);
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBodyBytes) {
          void reader.cancel().catch(() => {});
          return failure(413, 'MCP body limit exceeded');
        }
        parts.push(next.value);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
    } catch { return failure(400, 'Invalid MCP request body'); }
    finally { readers.delete(reader); reader.releaseLock(); }
  }

  const sweep = stateless ? undefined : setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.pending.size === 0 && now - session.touchedAt >= idleTimeoutMs) dispose(session);
    }
  }, Math.min(idleTimeoutMs, 60_000));
  sweep?.unref();

  return {
    async fetch(request) {
      if (closed) return failure(503, 'MCP server closed');
      const requestOrigin = request.headers.get('origin');
      if (requestOrigin !== null && requestOrigin !== origin) return failure(403, 'Invalid Origin');
      const version = request.headers.get('mcp-protocol-version');
      if (version !== null && !HTTP_VERSIONS.includes(version)) return failure(400, 'Unsupported MCP protocol version');
      if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
        return new Response(null, { status: 405, headers: { allow: stateless ? 'POST' : 'POST, GET, DELETE' } });
      }
      if (stateless && request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
      const sessionId = request.headers.get('mcp-session-id');
      if (stateless && sessionId !== null) return failure(400, 'Stateless MCP does not accept session IDs');
      let session = sessionId === null ? undefined : sessions.get(sessionId);
      if (sessionId !== null && !session) return failure(404, 'Unknown MCP session');
      if (session && version !== null && version !== session.version) return failure(400, 'MCP protocol version mismatch');
      if (request.method !== 'POST') {
        if (!session) return failure(400, 'MCP session required');
        session.touchedAt = Date.now();
        if (request.method === 'DELETE') { dispose(session); return new Response(null, { status: 204 }); }
        if (!options.toolsListChanged) return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
        if (!accepts(request.headers.get('accept'), 'text/event-stream')) return failure(406, 'Accept text/event-stream required');
        if (session.sse) return failure(409, 'An MCP event stream is already open');
        const current = session;
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(value) { controller = value; current.sse = value; },
          cancel() { if (current.sse === controller) current.sse = undefined; },
        }, new ByteLengthQueuingStrategy({ highWaterMark: MCP_SERVER_MAX_PENDING_BYTES }));
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'mcp-session-id': session.id } });
      }
      if (!accepts(request.headers.get('accept'), 'application/json') || !accepts(request.headers.get('accept'), 'text/event-stream')) {
        return failure(406, 'Accept application/json and text/event-stream required');
      }
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return failure(415, 'Content-Type application/json required');
      }
      const text = await body(request);
      if (text instanceof Response) return text;
      if (closed) return failure(503, 'MCP server closed');
      let message: unknown;
      try { message = JSON.parse(text); } catch { return failure(400, 'Invalid JSON'); }
      const frame = JSON.stringify(message);
      // JSON number spellings can grow during canonicalization (9e20, for
      // example). Refuse only this POST before it can breach the core's line
      // bound and abort unrelated calls in the same session.
      if (Buffer.byteLength(frame, 'utf8') > maxBodyBytes) return failure(413, 'MCP encoded message limit exceeded');
      const classified = classifyJsonRpcMessage(message);
      const meta = classified.kind === 'request' && classified.method === 'tools/call' ? classified.params?._meta : undefined;
      const token = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>).progressToken : undefined;
      const progressToken = typeof token === 'string' || (typeof token === 'number' && Number.isFinite(token)) ? token : undefined;
      if (stateless && progressToken !== undefined) return failure(400, 'Stateless MCP does not support progress streams');
      if (stateless) {
        const initializing = classified.kind === 'request' && classified.method === 'initialize';
        if (!initializing && version === null) return failure(400, 'MCP protocol version required in stateless mode');
        if (classified.kind === 'notification') {
          // There is no cross-request call registry; do not claim cancellation.
          if (classified.method === 'notifications/cancelled') return failure(400, 'Stateless MCP does not support cross-request cancellation');
          return new Response(null, { status: 202 });
        }
        if (pendingCount >= maxInFlight) return failure(503, 'Too many MCP requests');
        const offered = classified.kind === 'request' ? classified.params?.protocolVersion : undefined;
        if (initializing && offered === '2024-11-05') return failure(400, 'Legacy stdio protocol is not supported over HTTP');
        const selected = initializing ? (typeof offered === 'string' && HTTP_VERSIONS.includes(offered) ? offered : HTTP_VERSIONS[0]!) : version!;
        // Initialize only this request's core. Its private reply is discarded.
        const privateId = classified.id === '__http_initialize' ? '__http_initialize_2' : '__http_initialize';
        const bootstrap = initializing ? undefined : JSON.stringify({ jsonrpc: '2.0', id: privateId, method: 'initialize', params: { protocolVersion: selected } });
        session = createSession(selected, bootstrap);
      } else if (!session) {
        if (classified.kind !== 'request' || classified.method !== 'initialize') return failure(400, 'Initialize an MCP session first');
        if (pendingCount >= maxInFlight) return failure(503, 'Too many MCP requests');
        const offered = classified.params?.protocolVersion;
        if (offered === '2024-11-05') return failure(400, 'Legacy stdio protocol is not supported over HTTP');
        if (sessions.size >= maxSessions && !evictOldestIdleSession()) return failure(503, 'MCP session limit reached');
        const selected = typeof offered === 'string' && HTTP_VERSIONS.includes(offered) ? offered : HTTP_VERSIONS[0]!;
        session = createSession(selected);
      } else if (classified.kind === 'request' && classified.method === 'initialize') {
        return failure(400, 'MCP session already initialized');
      }
      if (session.closed) return failure(503, 'MCP session closed');
      session.touchedAt = Date.now();
      if (classified.kind === 'notification') {
        session.input.write(`${frame}\n`);
        if (classified.method === 'notifications/cancelled' && isUsableRequestId(classified.params?.requestId)) {
          // No JSON-RPC response may follow a cancelled call. End its POST
          // with the transport's accepted/no-content status, which standard
          // clients accept without trying to parse a missing JSON result.
          finishReply(session, SeenRequestIds.key(classified.params.requestId), new Response(null, { status: 202 }));
        }
        return new Response(null, { status: 202 });
      }
      const key = classified.id === undefined ? 'invalid' : SeenRequestIds.key(classified.id);
      if (session.pending.has(key)) return failure(400, 'MCP request id already in flight');
      if (pendingCount >= maxInFlight) return failure(503, 'Too many MCP requests');
      if (progressToken !== undefined && [...session.pending.values()].some(reply => reply.token === progressToken)) {
        return failure(400, 'MCP progress token already in flight');
      }
      const current = session;
      const response = new Promise<Response>(resolve => {
        const reply: PendingReply = { resolve, status: classified.kind === 'invalid' ? 400 : 200 };
        current.pending.set(key, reply);
        if (progressToken !== undefined) {
          reply.token = progressToken;
          reply.requestId = classified.id;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) { reply.stream = controller; },
            cancel() {
              reply.stream = undefined;
              current.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: classified.id } })}\n`);
              finishReply(current, key, new Response(null, { status: 202 }));
            },
          }, new ByteLengthQueuingStrategy({ highWaterMark: MCP_SERVER_MAX_PENDING_BYTES }));
          resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'mcp-session-id': current.id } }));
        }
        pendingCount++;
        current.input.write(`${frame}\n`);
      });
      return stateless ? response.finally(() => dispose(current)) : response;
    },
    close() {
      if (closed) return;
      closed = true;
      if (sweep !== undefined) clearInterval(sweep);
      for (const reader of readers) void reader.cancel().catch(() => {});
      for (const session of sessions.values()) dispose(session);
    },
  };
}

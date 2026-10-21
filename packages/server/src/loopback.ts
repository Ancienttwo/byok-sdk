import { randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';

/** Durable, identity-scoped, immutable port assignment. Implement claim atomically. */
export interface LoopbackPortStore {
  /** null means a genuinely new identity; corrupt or missing existing state must throw. */
  read(): Promise<number | null>;
  /** Insert candidate only if absent, then return the durable winning port. Never overwrite. */
  claim(candidate: number): Promise<number>;
}
export type LoopbackHandler = (request: Request) => Response | Promise<Response>;
export interface LoopbackListenerOptions {
  portStore: LoopbackPortStore;
  /** Called after binding and durable readback. URL is trusted configuration, never request input. */
  createHandler(serverUrl: string): LoopbackHandler | Promise<LoopbackHandler>;
  /** Defaults to [24000, 32768). Applies only to new identities. */
  portRange?: { min: number; maxExclusive: number };
  /** Maximum actual request bytes, including chunked uploads. Default 2 MiB. */
  maxBodyBytes?: number;
  /**
   * Exact loopback browser origins (http or https; localhost, 127.0.0.1 or [::1]) admitted with CORS.
   * Default none: every Origin is refused. Never grants credentials; Cookie stays refused.
   */
  allowedOrigins?: readonly string[];
  signal?: AbortSignal;
}
export interface LoopbackListener {
  readonly serverUrl: string;
  /** Closes only this listener and its connections, not the SDK or persisted assignment. */
  close(): Promise<void>;
}

function port(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError('Invalid persisted loopback port');
  return value;
}
function loopbackOrigin(value: string): string {
  let url: URL | undefined;
  try { url = new URL(value); } catch { /* reported below */ }
  if (!url || url.origin !== value || (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new TypeError('Allowed origins must be canonical loopback http(s) origins');
  }
  return value;
}
const CORS_METHODS = 'GET, POST, DELETE';
const CORS_HEADERS = 'authorization, content-type, accept, last-event-id, mcp-session-id, mcp-protocol-version';
function refuse(response: ServerResponse, status: number): void {
  response.writeHead(status, { Connection: 'close', 'Content-Length': '0' });
  response.end();
}
/** Returns the admitted CORS origin, null for a request without Origin, or false to refuse. */
function admit(request: IncomingMessage, expectedHost: string, allowedOrigins: ReadonlySet<string>): string | null | false {
  if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) return false;
  let hosts = 0;
  let origin: string | null = null;
  const metadata = new Map<string, string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase();
    const value = request.rawHeaders[i + 1]!;
    if (name === 'host' && (++hosts !== 1 || value !== expectedHost)) return false;
    if (name === 'cookie') return false;
    if (name === 'origin') {
      if (origin !== null || !allowedOrigins.has(value)) return false;
      origin = value;
    }
    if (name.startsWith('sec-fetch-')) {
      if (metadata.has(name)) return false;
      metadata.set(name, value);
    }
  }
  for (const [name, value] of metadata) {
    // Node/undici native fetch emits mode:cors without other browser metadata.
    if (name === 'sec-fetch-mode' && value === 'cors') continue;
    // An allowed page is cross-site to 127.0.0.1 (localhost differs), so the origin list decides, not the site value.
    if (origin !== null && (name === 'sec-fetch-site' || (name === 'sec-fetch-dest' && value === 'empty'))) continue;
    return false;
  }
  return hosts === 1 ? origin : false;
}

/** Own a loopback socket before committing an identity's immutable URL. Never adopts another process's listener. */
export async function listenLoopback(options: LoopbackListenerOptions): Promise<LoopbackListener> {
  const range = { ...(options.portRange ?? { min: 24000, maxExclusive: 32768 }) };
  if (!Number.isInteger(range.min) || !Number.isInteger(range.maxExclusive) || range.min < 1 || range.maxExclusive > 65536 || range.min >= range.maxExclusive) {
    throw new RangeError('Invalid loopback port range');
  }
  const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) throw new RangeError('Invalid loopback body limit');
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(loopbackOrigin));
  const { portStore, createHandler, signal } = options;
  signal?.throwIfAborted();
  const startup = async <T>(operation: Promise<T>): Promise<T> => {
    if (!signal) return operation;
    if (signal.aborted) { void operation.catch(() => {}); throw signal.reason; }
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([operation, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  };
  let server: Server | undefined;
  let handler: LoopbackHandler | undefined;
  let expectedHost = '';
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    handler = undefined;
    if (closing) return closing;
    const owned = server;
    server = undefined;
    if (!owned) return Promise.resolve();
    closing = new Promise<void>((resolve) => {
      owned.close(() => resolve());
      owned.closeAllConnections();
    }).finally(() => { closing = undefined; });
    return closing;
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const adapter = getRequestListener(async (request) => {
    const active = handler;
    if (!active) return new Response(null, { status: 503 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBodyBytes) {
            void reader.cancel().catch(() => {});
            return new Response(null, { status: 413, headers: { Connection: 'close' } });
          }
          chunks.push(next.value);
        }
      } catch {
        return new Response(null, { status: 400, headers: { Connection: 'close' } });
      }
    }
    // Buffer completely before dispatch: rejected uploads cannot cause application side effects.
    const body = reader ? Buffer.concat(chunks, size) : undefined;
    const bounded = new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal });
    if (!handler) return new Response(null, { status: 503 });
    return active(bounded);
  }, { overrideGlobalObjects: false });
  const receive = (request: IncomingMessage, response: ServerResponse) => {
    const origin = admit(request, expectedHost, allowedOrigins);
    if (origin === false) { refuse(response, 403); return; }
    if (origin !== null) {
      // Merged into every later writeHead, so 503/413/400 stay readable by the allowed page.
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (!handler) { refuse(response, 503); return; }
    if (origin !== null && request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined) {
      // Preflight is answered here and never reaches the handler.
      response.writeHead(204, { 'Access-Control-Allow-Methods': CORS_METHODS, 'Access-Control-Allow-Headers': CORS_HEADERS,
        'Access-Control-Max-Age': '600', 'Content-Length': '0' });
      response.end();
      return;
    }
    if (origin !== null) response.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    const length = request.headers['content-length'];
    if (length !== undefined && Number(length) > maxBodyBytes) { refuse(response, 413); return; }
    // Fetch has no GET/HEAD body, so refuse framing that its adapter would otherwise omit.
    if ((request.method === 'GET' || request.method === 'HEAD') &&
        (request.headers['transfer-encoding'] !== undefined || (length !== undefined && Number(length) !== 0))) {
      refuse(response, 400); return;
    }
    if (request.headers.expect) response.writeContinue();
    void adapter(request, response);
  };
  const bind = async (selected: number) => {
    signal?.throwIfAborted();
    expectedHost = `127.0.0.1:${selected}`;
    const candidate = createServer(receive);
    server = candidate;
    candidate.on('checkContinue', receive);
    candidate.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy()); });
    candidate.on('connect', (_request, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy()); });
    try {
      await startup(new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { candidate.off('listening', ready); reject(error); };
        const ready = () => { candidate.off('error', failed); resolve(); };
        candidate.once('error', failed);
        candidate.once('listening', ready);
        candidate.listen({ host: '127.0.0.1', port: selected, exclusive: true });
      }));
      signal?.throwIfAborted();
    } catch (error) {
      await close();
      throw error;
    }
  };
  try {
    const persisted = await startup(portStore.read());
    signal?.throwIfAborted();
    let selected: number;
    if (persisted !== null) {
      selected = port(persisted);
      await bind(selected);
    } else {
      const tried = new Set<number>();
      let lastError: unknown;
      selected = 0;
      for (let attempt = 0; attempt < 16 && tried.size < range.maxExclusive - range.min; attempt++) {
        let candidate = randomInt(range.min, range.maxExclusive);
        while (tried.has(candidate)) candidate = candidate + 1 === range.maxExclusive ? range.min : candidate + 1;
        tried.add(candidate);
        try { await bind(candidate); selected = candidate; break; } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
          lastError = error;
        }
      }
      if (!selected) throw lastError;
      const winner = port(await startup(portStore.claim(selected)));
      signal?.throwIfAborted();
      if (winner !== selected) { await close(); selected = winner; await bind(selected); }
    }
    const confirmed = await startup(portStore.read());
    if (confirmed !== selected) throw new Error('Loopback port assignment changed during startup');
    signal?.throwIfAborted();
    const serverUrl = `http://127.0.0.1:${selected}`;
    const ready = await startup(Promise.resolve(createHandler(serverUrl)));
    signal?.throwIfAborted();
    handler = ready;
    return { serverUrl, close: async () => { signal?.removeEventListener('abort', onAbort); await close(); } };
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    await close();
    throw error;
  }
}

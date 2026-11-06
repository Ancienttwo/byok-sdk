import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream';

export const AGY_GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

const KEY_HEADER = 'x-goog-api-key';
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const NOT_FORWARDED_UP = new Set([...HOP_BY_HOP, 'host', 'authorization', KEY_HEADER]);
const NOT_RELAYED_DOWN = new Set(HOP_BY_HOP);

const without = (headers: IncomingHttpHeaders, dropped: ReadonlySet<string>): OutgoingHttpHeaders =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name)));

const refuse = (response: ServerResponse, code: number, status: string, message: string): void => {
  response.writeHead(code, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error: { code, message, status } }));
};

export interface AgyGeminiProxyOptions {
  /** The real Gemini API key. It stays in this process. */
  apiKey: string;
  /** The task's runtime environment: the only source of `HTTP(S)_PROXY` and `NO_PROXY` for the upstream connection. */
  environment: NodeJS.ProcessEnv;
  /** Internal test seam, never reachable from a request or a public type. */
  upstreamOrigin?: string | undefined;
}

export interface AgyGeminiProxy {
  /** Loopback base URL for agy's `GOOGLE_GEMINI_BASE_URL`. */
  readonly url: string;
  /** Per-session token for agy's `GEMINI_API_KEY`. */
  readonly token: string;
  close(): Promise<void>;
}

/**
 * Forwards agy's model requests to the Gemini API so the real key never enters
 * agy's environment, which agy hands whole to every command and stdio MCP
 * server it starts. Those children can still spend quota through this proxy
 * during the session, but they cannot take the key.
 */
export async function startAgyGeminiProxy({ apiKey, environment, upstreamOrigin = AGY_GEMINI_ORIGIN }: AgyGeminiProxyOptions): Promise<AgyGeminiProxy> {
  const upstream = new URL(upstreamOrigin);
  const transport = upstream.protocol === 'https:' ? https : http;
  let agent: http.Agent;
  try {
    agent = new transport.Agent({ keepAlive: true, proxyEnv: environment });
  } catch {
    // Node's message quotes the proxy URL, which may carry a password.
    throw new Error('agy Gemini proxy: the runtime environment holds an invalid proxy URL');
  }
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(token);
  const holdsToken = (value: string | string[] | undefined): boolean => {
    if (typeof value !== 'string') return false;
    const presented = Buffer.from(value);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  };

  const server = http.createServer((request, response) => {
    let target: URL;
    try {
      // Only the path and query survive this parse: absolute-form and
      // protocol-relative targets name a host here that is never used.
      target = new URL(request.url ?? '/', upstream);
    } catch {
      return refuse(response, 400, 'INVALID_ARGUMENT', 'agy Gemini proxy: malformed request target');
    }
    if (![request.headers[KEY_HEADER], ...target.searchParams.getAll('key')].some(holdsToken))
      return refuse(response, 401, 'UNAUTHENTICATED', 'agy Gemini proxy: request does not carry the session token');
    target.searchParams.delete('key');

    const forwarded = transport.request(upstream, {
      agent,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...without(request.headers, NOT_FORWARDED_UP), [KEY_HEADER]: apiKey },
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, without(upstreamResponse.headers, NOT_RELAYED_DOWN));
      response.flushHeaders();
      pipeline(upstreamResponse, response, () => {});
    });
    forwarded.on('error', () => {
      if (response.headersSent) response.destroy();
      else refuse(response, 502, 'UNAVAILABLE', 'agy Gemini proxy: upstream request failed');
    });
    response.on('close', () => forwarded.destroy());
    pipeline(request, forwarded, () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address}:${port}`,
    token,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
      agent.destroy();
    }),
  };
}

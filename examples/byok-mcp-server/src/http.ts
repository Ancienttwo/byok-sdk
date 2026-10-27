import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpHttpServer, type McpHttpServer } from '@byok-sdk/client/mcp-server/http';
import type { McpServerToolDefinition } from '@byok-sdk/client/mcp-server';
import { BetaLedger } from './ledger';
import { BetaError, scope, type Caller, type Scope } from './model';

export interface ScopedTool {
  readonly definition: McpServerToolDefinition;
  /** Explicit policy. Only discovery tools should use authenticated-only access. */
  readonly scope: Scope | 'authenticated';
  /** Only authenticated caller handles reach this Host-owned callback. */
  call(caller: Caller, args: Readonly<Record<string, unknown>> | undefined, signal: AbortSignal): Promise<Record<string, unknown>>;
}
/** One line per HTTP request. It never carries the Authorization header, the token or a request body. */
export interface AccessEntry {
  readonly ts: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly keyId?: string;
  /** Set when the request ran a tool call: its tool name and, for a refusal, the refusal code. */
  readonly rpc?: 'tools/call';
  readonly tool?: string;
  readonly toolError?: string;
}
export interface BetaMcpOptions {
  readonly ledger: BetaLedger;
  readonly origin: string;
  readonly serverInfo: { name: string; version: string };
  readonly tools: readonly ScopedTool[];
  /** Host-owned access log sink, called after each request is answered. */
  readonly onAccess?: (entry: AccessEntry) => void;
}
type ToolTrace = { tool?: string; toolError?: string };

function refusal(error: BetaError): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code, message: error.message,
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) }) }] };
}

/** Host-mounted auth/scope boundary. B3 supplies task tools; B2 invents none. */
export function createBetaMcpServer(options: BetaMcpOptions): McpHttpServer {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) {
    throw new TypeError('Select one canonical HTTPS or loopback HTTP origin');
  }
  if (!options.tools.length) throw new TypeError('Register at least one Host tool');
  const tools = new Map<string, ScopedTool>();
  for (const tool of options.tools) {
    const name = tool.definition.name;
    if (!/^byok_[\w-]{1,59}$/.test(name) || tools.has(name) || typeof tool.call !== 'function') throw new TypeError('Invalid Host tool registration');
    tools.set(name, Object.freeze({ definition: structuredClone(tool.definition), call: tool.call,
      scope: tool.scope === 'authenticated' ? 'authenticated' : scope(tool.scope) }));
  }
  const transports = new Map<string, McpHttpServer>();
  const drop = (keyId: string) => { transports.get(keyId)?.close(); transports.delete(keyId); };
  const unsubscribe = options.ledger.onRevocation(drop);
  let closed = false;
  const unavailable = () => new Response('Beta MCP service unavailable', { status: 503 });
  // B1 runs tool calls inside the request's async context; this ties a call back to its access line.
  const trace = new AsyncLocalStorage<ToolTrace>();

  async function answer(request: Request, seen: { keyId?: string }): Promise<Response> {
    if (closed) return unavailable();
    const from = request.headers.get('origin');
    if (from !== null && from !== options.origin) return new Response('Invalid Origin', { status: 403 });
    try {
      const caller = options.ledger.authenticate(request.headers.get('authorization'));
      seen.keyId = caller.keyId;
      let transport = transports.get(caller.keyId);
      if (!transport) {
        const allowed = [...tools.values()].filter(tool => tool.scope === 'authenticated' || caller.scopes.includes(tool.scope));
        if (!allowed.length) return new Response('No authorized tools', { status: 403 });
        transport = createMcpHttpServer({ origin: options.origin, serverInfo: options.serverInfo, tools: allowed.map(tool => tool.definition),
          callTool: async call => {
            const traced = trace.getStore();
            if (traced) traced.tool = call.name;
            try {
              const tool = tools.get(call.name);
              if (!tool) throw new BetaError('not_found', 'Resource not found');
              options.ledger.authorize(caller, tool.scope === 'authenticated' ? undefined : tool.scope);
              return await tool.call(caller, call.arguments, call.signal);
            } catch (error) {
              const refused = error instanceof BetaError ? error : new BetaError('unavailable', 'Tool request could not be completed');
              if (traced) traced.toolError = refused.code;
              return refusal(refused);
            }
          },
        });
        transports.set(caller.keyId, transport);
      }
      return await transport.fetch(request);
    } catch (error) {
      if (error instanceof BetaError && error.code === 'unauthorized') {
        return new Response('Invalid byok bot key', { status: 401,
          headers: { 'www-authenticate': 'Bearer realm="byok-mcp"', 'cache-control': 'no-store' } });
      }
      return unavailable();
    }
  }

  return {
    async fetch(request) {
      const seen: { keyId?: string } = {};
      const traced: ToolTrace = {};
      const response = await trace.run(traced, () => answer(request, seen));
      if (options.onAccess) {
        try {
          options.onAccess({ ts: new Date().toISOString(), method: request.method, path: new URL(request.url).pathname,
            status: response.status, ...(seen.keyId ? { keyId: seen.keyId } : {}),
            ...(traced.tool ? { rpc: 'tools/call' as const, tool: traced.tool } : {}), ...(traced.toolError ? { toolError: traced.toolError } : {}) });
        } catch (error) {
          console.error('byok MCP access log write failed:', error instanceof Error ? error.message : error);
        }
      }
      return response;
    },
    close() {
      if (closed) return;
      closed = true; unsubscribe();
      for (const transport of transports.values()) transport.close();
      transports.clear();
    },
  };
}

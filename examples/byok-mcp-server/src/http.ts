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
export interface BetaMcpOptions {
  readonly ledger: BetaLedger;
  readonly origin: string;
  readonly serverInfo: { name: string; version: string };
  readonly tools: readonly ScopedTool[];
}

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

  return {
    async fetch(request) {
      if (closed) return unavailable();
      const from = request.headers.get('origin');
      if (from !== null && from !== options.origin) return new Response('Invalid Origin', { status: 403 });
      try {
        const caller = options.ledger.authenticate(request.headers.get('authorization'));
        let transport = transports.get(caller.keyId);
        if (!transport) {
          const allowed = [...tools.values()].filter(tool => tool.scope === 'authenticated' || caller.scopes.includes(tool.scope));
          if (!allowed.length) return new Response('No authorized tools', { status: 403 });
          transport = createMcpHttpServer({ origin: options.origin, serverInfo: options.serverInfo, tools: allowed.map(tool => tool.definition),
            callTool: async call => {
              try {
                const tool = tools.get(call.name);
                if (!tool) throw new BetaError('not_found', 'Resource not found');
                options.ledger.authorize(caller, tool.scope === 'authenticated' ? undefined : tool.scope);
                return await tool.call(caller, call.arguments, call.signal);
              } catch (error) {
                return refusal(error instanceof BetaError ? error : new BetaError('unavailable', 'Tool request could not be completed'));
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
    },
    close() {
      if (closed) return;
      closed = true; unsubscribe();
      for (const transport of transports.values()) transport.close();
      transports.clear();
    },
  };
}

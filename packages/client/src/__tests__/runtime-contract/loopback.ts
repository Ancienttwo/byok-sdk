import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The two network endpoints of a runtime contract run. Neither forwards
 * anything: the egress recorder refuses every proxied request and records its
 * target, and the loopback provider answers model requests from a fixed
 * script, so no run spends real credits (the #1058 / #1072 pattern).
 */

export interface EgressAttempt {
  /** `detect` while a detect() probe runs, `turn` otherwise. */
  readonly phase: 'detect' | 'turn';
  readonly method: string;
  readonly target: string;
}

export interface EgressRecorder {
  readonly attempts: EgressAttempt[];
  phase: EgressAttempt['phase'];
  /** Proxy variables for a runtime environment; loopback stays direct. */
  readonly env: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as AddressInfo).port;
};

const close = (server: Server): Promise<void> => new Promise(resolve => {
  server.close(() => resolve());
  server.closeAllConnections();
});

/**
 * An HTTP(S) proxy that records each attempt and answers 403. It sees only
 * clients that honor the proxy variables; `NODE_USE_ENV_PROXY` makes Node's
 * own fetch honor them. A client that ignores them is not observed here.
 */
export async function startEgressRecorder(): Promise<EgressRecorder> {
  const attempts: EgressAttempt[] = [];
  const state = { phase: 'turn' as EgressAttempt['phase'] };
  const server = createServer((request, response) => {
    request.socket.on('error', () => {});
    attempts.push({ phase: state.phase, method: request.method ?? 'GET', target: request.url ?? '' });
    response.writeHead(403, { connection: 'close' }).end('runtime contract: external requests are refused');
  });
  server.on('connect', (request: IncomingMessage, socket) => {
    socket.on('error', () => {});
    attempts.push({ phase: state.phase, method: 'CONNECT', target: request.url ?? '' });
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  const port = await listen(server);
  const proxy = `http://127.0.0.1:${port}`;
  const env = {
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost',
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: '127.0.0.1,localhost',
    NODE_USE_ENV_PROXY: '1',
  };
  return {
    attempts, env, close: () => close(server),
    get phase() { return state.phase; },
    set phase(value) { state.phase = value; },
  };
}

export type ProviderWire = 'openai-responses' | 'openai-chat' | 'anthropic-messages';

/** One model-visible tool, as the wire names it. */
export interface ProviderTool {
  /** The name the model calls. */
  readonly name: string;
  /** Responses API namespace (Codex groups MCP tools under `mcp__<server>`). */
  readonly namespace?: string;
}

export interface ProviderRequest {
  readonly method: string;
  readonly path: string;
  /** Raw request body; marker checks search it. */
  readonly text: string;
  readonly tools: readonly ProviderTool[];
  /** Tool results already in the conversation. */
  readonly toolResults: number;
  /** Model request (as opposed to a token count, model list or other auxiliary call). */
  readonly model: boolean;
}

export type ProviderStep =
  | { readonly kind: 'tool'; readonly tool: ProviderTool; readonly args: Record<string, unknown> }
  | { readonly kind: 'text'; readonly chunks: readonly string[] };

export type ProviderScript = (request: ProviderRequest) => ProviderStep;

export interface LoopbackProvider {
  readonly baseUrl: string;
  readonly origin: string;
  readonly requests: ProviderRequest[];
  /** Whether any request body carried `marker`. */
  saw(marker: string): boolean;
  close(): Promise<void>;
}

export const CONTRACT_REPLY_CHUNKS = Object.freeze(['runtime ', 'contract ', 'reply']);

/**
 * The default script: call the first tool `pick` selects once, then reply
 * with streamed text. A request without that tool (titles, summaries, a
 * token count) gets the text reply.
 */
export function callOnceThenReply(
  pick: (tools: readonly ProviderTool[]) => ProviderTool | undefined,
  args: Record<string, unknown>,
): ProviderScript {
  return request => {
    const tool = request.toolResults === 0 ? pick(request.tools) : undefined;
    return tool === undefined ? { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS } : { kind: 'tool', tool, args };
  };
}

/**
 * MCP tool `tool` of server `server` in each spelling a runtime uses:
 * `mcp__<server>__<tool>`, a Responses namespace `mcp__<server>`, or a
 * `<server>`-prefixed name with an optional `mcp_` prefix.
 */
export function mcpTool(server: string, tool: string): (tools: readonly ProviderTool[]) => ProviderTool | undefined {
  const flat = new RegExp(`^(?:mcp_{1,2})?${server}_{1,2}${tool}$`);
  return tools => tools.find(candidate => candidate.namespace === `mcp__${server}` ? candidate.name === tool : flat.test(candidate.name));
}

/**
 * A runtime that defers MCP tools behind its own search: the model searches,
 * reads the qualified name of `tool` from the search result, then invokes it
 * through the runtime's call bridge. The search query never spells the name,
 * so the name can only come from the result.
 */
export function searchThenCall(bridge: {
  readonly search: string;
  readonly searchArgs: Record<string, unknown>;
  readonly call: string;
  readonly callArgs: (name: string) => Record<string, unknown>;
}, tool: string): ProviderScript {
  const found = new RegExp(`\\\\?"([A-Za-z0-9_-]+_${tool})\\\\?"`);
  return request => {
    const search = request.tools.find(candidate => candidate.name === bridge.search);
    const call = request.tools.find(candidate => candidate.name === bridge.call);
    if (search !== undefined && request.toolResults === 0) return { kind: 'tool', tool: search, args: bridge.searchArgs };
    const name = found.exec(request.text)?.[1];
    if (call !== undefined && request.toolResults === 1 && name !== undefined) return { kind: 'tool', tool: call, args: bridge.callArgs(name) };
    return { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS };
  };
}

type Json = Record<string, unknown>;
const records = (value: unknown): Json[] => Array.isArray(value) ? value.filter((item): item is Json => item !== null && typeof item === 'object') : [];

function view(wire: ProviderWire, body: Json): Pick<ProviderRequest, 'tools' | 'toolResults'> {
  if (wire === 'openai-responses') {
    const tools = records(body.tools).flatMap((tool): ProviderTool[] => tool.type === 'namespace'
      ? records(tool.tools).map(inner => ({ name: String(inner.name), namespace: String(tool.name) }))
      : typeof tool.name === 'string' ? [{ name: tool.name }] : []);
    return { tools, toolResults: records(body.input).filter(item => item.type === 'function_call_output').length };
  }
  if (wire === 'openai-chat') {
    const tools = records(body.tools).flatMap(tool => {
      const fn = tool.function as Json | undefined;
      return typeof fn?.name === 'string' ? [{ name: fn.name }] : [];
    });
    return { tools, toolResults: records(body.messages).filter(message => message.role === 'tool').length };
  }
  const tools = records(body.tools).flatMap(tool => typeof tool.name === 'string' ? [{ name: tool.name }] : []);
  const toolResults = records(body.messages).flatMap(message => records(message.content)).filter(block => block.type === 'tool_result').length;
  return { tools, toolResults };
}

function isModelRequest(wire: ProviderWire, method: string, path: string): boolean {
  if (method !== 'POST') return false;
  if (wire === 'openai-responses') return path.endsWith('/responses');
  if (wire === 'openai-chat') return path.endsWith('/chat/completions');
  return path.endsWith('/messages');
}

let sequence = 0;

function sse(response: ServerResponse, frames: ReadonlyArray<readonly [string | undefined, unknown]>): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  response.end(frames.map(([event, data]) => `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join(''));
}

function respondResponses(response: ServerResponse, step: ProviderStep): void {
  const id = `resp_contract_${++sequence}`;
  const item = step.kind === 'tool'
    ? { type: 'function_call', id: `fc_${sequence}`, call_id: `call_${sequence}`, name: step.tool.name,
      ...(step.tool.namespace === undefined ? {} : { namespace: step.tool.namespace }), arguments: JSON.stringify(step.args), status: 'completed' }
    : { type: 'message', id: `msg_${sequence}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: step.chunks.join(''), annotations: [] }] };
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  sse(response, [
    ['response.created', { type: 'response.created', response: { id, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0,
      item: { ...item, status: 'in_progress', ...(step.kind === 'tool' ? { arguments: '' } : { content: [] }) } }],
    ...(step.kind === 'tool'
      ? [['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: JSON.stringify(step.args) }] as const]
      : [
        ['response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } }] as const,
        ...step.chunks.map(delta => ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta }] as const),
      ]),
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response: { id, status: 'completed', output: [item], usage } }],
  ]);
}

function respondChat(response: ServerResponse, step: ProviderStep, stream: boolean, model: string): void {
  const base = { id: `chatcmpl-contract-${++sequence}`, created: 0, model };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!stream) {
    const message = step.kind === 'tool'
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${sequence}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.args) } }] }
      : { role: 'assistant', content: step.chunks.join('') };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...base, object: 'chat.completion',
      choices: [{ index: 0, message, finish_reason: step.kind === 'tool' ? 'tool_calls' : 'stop' }], usage }));
    return;
  }
  const chunk = { ...base, object: 'chat.completion.chunk' };
  const deltas = step.kind === 'tool'
    ? [{ role: 'assistant', tool_calls: [{ index: 0, id: `call_${sequence}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.args) } }] }]
    : step.chunks.map((content, index) => ({ ...(index === 0 ? { role: 'assistant' } : {}), content }));
  sse(response, [
    ...deltas.map(delta => [undefined, { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] }] as const),
    [undefined, { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: step.kind === 'tool' ? 'tool_calls' : 'stop' }] }],
    [undefined, { ...chunk, choices: [], usage }],
    [undefined, '[DONE]'],
  ]);
}

function respondAnthropic(response: ServerResponse, step: ProviderStep, stream: boolean, model: string): void {
  const block = step.kind === 'tool'
    ? { type: 'tool_use', id: `toolu_contract_${++sequence}`, name: step.tool.name, input: step.args }
    : { type: 'text', text: step.chunks.join('') };
  const message = { id: `msg_contract_${++sequence}`, type: 'message', role: 'assistant', model, content: [block],
    stop_reason: step.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
    return;
  }
  sse(response, [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: step.kind === 'tool' ? { ...block, input: {} } : { type: 'text', text: '' } }],
    ...(step.kind === 'tool'
      ? [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.args) } }] as const]
      : step.chunks.map(text => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }] as const)),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** A scripted model endpoint speaking one wire format on 127.0.0.1. */
export async function startLoopbackProvider(wire: ProviderWire, script: ProviderScript, model = 'contract-model'): Promise<LoopbackProvider> {
  const requests: ProviderRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const method = request.method ?? 'GET';
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const text = Buffer.concat(chunks).toString('utf8');
      let body: Json = {};
      try { body = text ? JSON.parse(text) as Json : {}; } catch { /* recorded as text only */ }
      const model_ = isModelRequest(wire, method, path);
      const recorded: ProviderRequest = { method, path, text, model: model_, ...(model_ ? view(wire, body) : { tools: [], toolResults: 0 }) };
      requests.push(recorded);
      if (!model_) {
        if (method === 'GET' && path.endsWith('/models')) {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'byok-contract' }], models: [] }));
        } else if (path.endsWith('/count_tokens')) {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }));
        } else {
          response.writeHead(404, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error: { message: `runtime contract: no route ${method} ${path}` } }));
        }
        return;
      }
      const step = script(recorded);
      const stream = body.stream === true;
      if (wire === 'openai-responses') respondResponses(response, step);
      else if (wire === 'openai-chat') respondChat(response, step, stream, model);
      else respondAnthropic(response, step, stream, typeof body.model === 'string' ? body.model : model);
    });
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    baseUrl: wire === 'anthropic-messages' ? origin : `${origin}/v1`,
    requests,
    saw: marker => requests.some(request => request.text.includes(marker)),
    close: () => close(server),
  };
}

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isAbsolute } from 'node:path';
import type { AgentRef, RuntimeOperationManifest } from './types';

/** Native arguments are preserved; command/path projections never interpret shell syntax. */
export interface ToolExecutionCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly command?: string;
  readonly paths: readonly string[];
  readonly nativeAgentId?: string;
  readonly parentToolCallId?: string;
}

export interface BeforeToolRequest extends ToolExecutionCall {
  /** SDK-bound parent identity, including for native subagents. */
  readonly taskId: string;
  readonly agentRef?: AgentRef;
  readonly runtimeId: string;
  /** Aborted on timeout or session disposal. A late allow never executes the tool. */
  readonly signal: AbortSignal;
}
export type BeforeToolDecision = { readonly decision: 'allow' } | { readonly decision: 'deny'; readonly reason: string };
export interface BeforeToolOptions {
  readonly onRequest: (request: BeforeToolRequest) => BeforeToolDecision | Promise<BeforeToolDecision>;
  /** Local callback deadline, 1–60000 ms; defaults to 5000 ms. */
  readonly timeoutMs?: number;
}
export type ToolExecutionDenialCode = 'tool_policy_denied' | 'tool_policy_error' | 'tool_policy_timeout' | 'tool_policy_unavailable';
export type ToolExecutionVerdict = { readonly decision: 'allow' } | {
  readonly decision: 'deny'; readonly code: ToolExecutionDenialCode; readonly reason: string;
};

export { ToolExecutionUnsupportedError } from './runtime-failure';

export function normalizeBeforeToolOptions(options: BeforeToolOptions | undefined): BeforeToolOptions | undefined {
  if (options === undefined) return undefined;
  if (!options || typeof options.onRequest !== 'function') throw new TypeError('beforeTool.onRequest must be a function');
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('beforeTool.timeoutMs must be an integer from 1 to 60000');
  return Object.freeze({ onRequest: options.onRequest, timeoutMs });
}

/** Private loopback IPC address; never a remote Host endpoint. */
export interface ToolExecutionGateConfig {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

export function parseToolExecutionGateConfig(value: unknown): ToolExecutionGateConfig {
  if (!record(value) || !text(value.url) || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 60_000
    || Object.keys(value).some(key => !['url', 'token', 'timeoutMs'].includes(key))) throw new Error('invalid tool execution gate config');
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/before-tool'
    || url.username || url.password || url.search || url.hash) throw new Error('tool execution gate must use SDK loopback IPC');
  return Object.freeze({ url: value.url, token: value.token, timeoutMs: value.timeoutMs as number });
}

function parseCall(value: unknown): ToolExecutionCall {
  if (!record(value) || !text(value.toolCallId) || !text(value.toolName) || !record(value.input)
    || typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || !Array.isArray(value.paths) || value.paths.some(path => typeof path !== 'string')
    || ['command', 'nativeAgentId', 'parentToolCallId'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) {
    throw new Error('invalid tool execution call');
  }
  return {
    toolCallId: value.toolCallId, toolName: value.toolName, input: value.input, cwd: value.cwd,
    paths: Object.freeze([...value.paths]) as readonly string[],
    ...(value.command === undefined ? {} : { command: value.command as string }),
    ...(value.nativeAgentId === undefined ? {} : { nativeAgentId: value.nativeAgentId as string }),
    ...(value.parentToolCallId === undefined ? {} : { parentToolCallId: value.parentToolCallId as string }),
  };
}
const deny = (code: ToolExecutionDenialCode, reason: string): ToolExecutionVerdict => ({ decision: 'deny', code, reason });
export function formatToolExecutionDenial(verdict: Extract<ToolExecutionVerdict, { decision: 'deny' }>): string {
  return `${verdict.code}: ${verdict.reason}`;
}

/** A timeout settles the tool decision even if the Host ignores cancellation. */
export async function evaluateBeforeToolRequest(
  options: BeforeToolOptions, request: Omit<BeforeToolRequest, 'signal'>, signal?: AbortSignal,
): Promise<ToolExecutionVerdict> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort('timeout'), options.timeoutMs ?? 5_000);
  const abortVerdict = (): ToolExecutionVerdict => controller.signal.reason === 'timeout'
    ? deny('tool_policy_timeout', 'Local tool policy timed out')
    : deny('tool_policy_unavailable', 'Local tool policy is unavailable');
  let removeAbort = () => {};
  const aborted = new Promise<ToolExecutionVerdict>(resolve => {
    const listener = () => resolve(abortVerdict());
    controller.signal.addEventListener('abort', listener, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', listener);
    if (controller.signal.aborted) listener();
  });
  const decision = controller.signal.aborted ? Promise.resolve(abortVerdict()) : Promise.resolve().then(async (): Promise<ToolExecutionVerdict> => {
    try {
      const value: unknown = await options.onRequest(Object.freeze({ ...request, signal: controller.signal }));
      if (record(value) && value.decision === 'allow') return { decision: 'allow' };
      if (record(value) && value.decision === 'deny' && typeof value.reason === 'string') return deny('tool_policy_denied', value.reason);
      return deny('tool_policy_error', 'Local tool policy returned an invalid decision');
    } catch { return deny('tool_policy_error', 'Local tool policy failed'); }
  });
  try { return await Promise.race([decision, aborted]); }
  finally { clearTimeout(timer); removeAbort(); signal?.removeEventListener('abort', abort); }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('tool execution request exceeds 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Each gate owns one immutable parent task identity and lives exactly as long as its runtime. */
export async function startToolExecutionGate(input: {
  options: BeforeToolOptions;
  manifest: RuntimeOperationManifest;
  runtimeId: string;
}): Promise<{ readonly config: ToolExecutionGateConfig; close(): Promise<void> }> {
  const options = normalizeBeforeToolOptions(input.options)!;
  const timeoutMs = options.timeoutMs!;
  const taskId = input.manifest.taskId;
  const agentRef = input.manifest.agentRef === undefined ? undefined : Object.freeze({ ...input.manifest.agentRef });
  const runtimeId = input.runtimeId;
  const token = randomBytes(32).toString('hex');
  const active = new Set<AbortController>();
  let closed = false;
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/before-tool' || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const raw = await readBody(request);
      const call = parseCall(raw);
      if (closed) controller.abort('closed');
      const verdict = await evaluateBeforeToolRequest(options, { ...call, taskId, runtimeId,
        ...(agentRef === undefined ? {} : { agentRef }) }, controller.signal);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(verdict));
    } catch {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(deny('tool_policy_error', 'Invalid local tool policy request')));
    } finally {
      clearTimeout(timer);
      active.delete(controller);
    }
  });
  server.requestTimeout = timeoutMs + 1_000;
  server.headersTimeout = timeoutMs + 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('tool execution IPC did not bind');
  const config = Object.freeze({ url: `http://127.0.0.1:${address.port}/before-tool`, token, timeoutMs });
  let closing: Promise<void> | undefined;
  return { config, close() {
    if (closing) return closing;
    closed = true;
    for (const controller of active) controller.abort('closed');
    closing = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    return closing;
  } };
}

export async function requestToolExecutionDecision(config: ToolExecutionGateConfig, call: ToolExecutionCall): Promise<ToolExecutionVerdict> {
  try {
    const response = await fetch(config.url, {
      method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(call), signal: AbortSignal.timeout(config.timeoutMs + 1_000), redirect: 'error',
    });
    if (!response.ok) return deny('tool_policy_unavailable', 'Local tool policy is unavailable');
    const value: unknown = await response.json();
    if (record(value) && value.decision === 'allow') return { decision: 'allow' };
    const codes: readonly string[] = ['tool_policy_denied', 'tool_policy_error', 'tool_policy_timeout', 'tool_policy_unavailable'];
    if (record(value) && value.decision === 'deny' && typeof value.code === 'string' && codes.includes(value.code) && typeof value.reason === 'string') {
      return deny(value.code as ToolExecutionDenialCode, value.reason);
    }
  } catch { /* Missing or malformed IPC authority never grants execution. */ }
  return deny('tool_policy_unavailable', 'Local tool policy is unavailable');
}

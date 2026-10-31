import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isAbsolute } from 'node:path';
import type { ToolAuthorizationDenialCode, ToolAuthorizationGate, ToolAuthorizationVerdict, ToolCall } from './tool-authorization';
import type { FileScopeGrant } from './file-scope-guard';
import {
  FILE_SCOPE_GUARD_CODES, FILE_SCOPE_GUARD_REASONS, SCOPED_FILE_TOOL_NAMES,
  type FileScopeGuardCode, type FileScopeGuardReason,
} from './file-scope-types';
import type { ScopedFileDenial } from './file-scope-tools';
import { fileScopeGateBinding } from './file-scope-gate-binding';

/**
 * Private loopback address of one runtime's `auto` gate. SDK-owned child sessions
 * read the token from a private launch file, so it authenticates the channel, not
 * a boundary against same-user code.
 */
export interface ToolAuthorizationIpcConfig {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
}
/** Inherited only by SDK-owned native child sessions; the root comes from the digest-bound launch. */
export const TOOL_AUTHORIZATION_GATE_ENV = 'BYOK_TOOL_AUTHORIZATION_GATE';
const MAX_TIMEOUT_MS = 86_400_000;
const DENIAL_CODES: readonly ToolAuthorizationDenialCode[] = ['tool_authorization_denied', 'tool_authorization_unavailable'];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
const unavailable = (reason = 'tool authorization is unavailable'): ToolAuthorizationVerdict =>
  ({ decision: 'deny', code: 'tool_authorization_unavailable', reason });

export function parseToolAuthorizationIpcConfig(value: unknown): ToolAuthorizationIpcConfig {
  if (!record(value) || !text(value.url) || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > MAX_TIMEOUT_MS
    || Object.keys(value).some(key => !['url', 'token', 'timeoutMs'].includes(key))) throw new Error('invalid tool authorization gate config');
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/authorize-tool'
    || url.username || url.password || url.search || url.hash) throw new Error('tool authorization gate must use SDK loopback IPC');
  return Object.freeze({ url: value.url, token: value.token, timeoutMs: value.timeoutMs as number });
}

export function setToolAuthorizationGateEnv(config: ToolAuthorizationIpcConfig | null, filePath: string): void {
  if (config === null) delete process.env[TOOL_AUTHORIZATION_GATE_ENV];
  else {
    writeFileSync(filePath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    process.env[TOOL_AUTHORIZATION_GATE_ENV] = filePath;
  }
}

/** Malformed inherited configuration must never turn a gated child into an ungated session. */
export function readToolAuthorizationGateEnv(): ToolAuthorizationIpcConfig | undefined {
  const filePath = process.env[TOOL_AUTHORIZATION_GATE_ENV];
  return filePath === undefined ? undefined : parseToolAuthorizationIpcConfig(JSON.parse(readFileSync(filePath, 'utf8')));
}

function parseCall(value: unknown): ToolCall {
  if (!record(value) || !text(value.toolCallId) || !text(value.toolName) || !record(value.input)
    || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)
    || ['nativeAgentId', 'parentToolCallId'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) {
    throw new Error('invalid tool call');
  }
  return {
    toolCallId: value.toolCallId, toolName: value.toolName, input: value.input, cwd: value.cwd,
    ...(value.nativeAgentId === undefined ? {} : { nativeAgentId: value.nativeAgentId as string }),
    ...(value.parentToolCallId === undefined ? {} : { parentToolCallId: value.parentToolCallId as string }),
  };
}

const FILE_SCOPE_ACCESS: readonly string[] = Object.freeze(['read', 'write']);

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000\r\n]/u.test(value)
    ? value : undefined;
}

/** The child may only report the closed deny shape; paths and content are never accepted. */
function parseFileScopeDenial(value: unknown): ScopedFileDenial {
  if (!record(value) || Object.keys(value).some((key) => !['toolCallId', 'toolName', 'code', 'reason', 'rootId', 'access'].includes(key))) {
    throw new Error('invalid file scope denial');
  }
  const toolName = boundedText(value.toolName, 128);
  if (toolName === undefined || !(SCOPED_FILE_TOOL_NAMES as readonly string[]).includes(toolName)) throw new Error('invalid file scope denial tool');
  if (typeof value.code !== 'string' || !(FILE_SCOPE_GUARD_CODES as readonly string[]).includes(value.code)) {
    throw new Error('invalid file scope denial code');
  }
  if (typeof value.reason !== 'string' || !(FILE_SCOPE_GUARD_REASONS as readonly string[]).includes(value.reason)) {
    throw new Error('invalid file scope denial reason');
  }
  const toolCallId = value.toolCallId === undefined ? undefined : boundedText(value.toolCallId, 256);
  if (value.toolCallId !== undefined && toolCallId === undefined) throw new Error('invalid file scope denial call id');
  const rootId = value.rootId === undefined ? undefined : boundedText(value.rootId, 128);
  if (value.rootId !== undefined && rootId === undefined) throw new Error('invalid file scope denial root');
  if (value.access !== undefined && (typeof value.access !== 'string' || !FILE_SCOPE_ACCESS.includes(value.access))) {
    throw new Error('invalid file scope denial access');
  }
  return Object.freeze({
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName: toolName as ScopedFileDenial['toolName'],
    code: value.code as FileScopeGuardCode,
    reason: value.reason as FileScopeGuardReason,
    ...(rootId === undefined ? {} : { rootId }),
    ...(value.access === undefined ? {} : { access: value.access as 'read' | 'write' }),
  });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('tool authorization request exceeds 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** One loopback endpoint per runtime process, closed with the runtime. */
export async function startToolAuthorizationIpc(
  gate: ToolAuthorizationGate,
): Promise<{ readonly config: ToolAuthorizationIpcConfig; readonly fileScope?: FileScopeGrant; close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const binding = fileScopeGateBinding(gate);
  let closed = false;
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.url === '/file-scope-audit') {
      if (binding === undefined) {
        response.writeHead(404).end();
        return;
      }
      try {
        binding.onDeny(parseFileScopeDenial(await readBody(request)));
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
      return;
    }
    if (request.url !== '/authorize-tool') {
      response.writeHead(404).end();
      return;
    }
    let verdict: ToolAuthorizationVerdict;
    try {
      const call = parseCall(await readBody(request));
      verdict = closed ? unavailable() : await gate.authorize(call);
    } catch {
      verdict = unavailable('invalid tool authorization request');
    }
    if (closed && verdict.decision === 'allow') verdict = unavailable();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(verdict));
  });
  server.requestTimeout = gate.timeoutMs + 5_000;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('tool authorization IPC did not bind');
  const config = Object.freeze({ url: `http://127.0.0.1:${address.port}/authorize-tool`, token, timeoutMs: gate.timeoutMs });
  let closing: Promise<void> | undefined;
  return { config, ...(binding === undefined ? {} : { fileScope: binding.grant }), close() {
    if (closing) return closing;
    closed = true;
    closing = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    return closing;
  } };
}

/**
 * Report one scoped-tool denial to the daemon's local audit. The deny has
 * already been enforced in the runtime when this runs; a transport failure
 * returns false and is never turned into an allow.
 */
export async function reportFileScopeDenial(config: ToolAuthorizationIpcConfig, denial: ScopedFileDenial): Promise<boolean> {
  try {
    const response = await fetch(new URL('/file-scope-audit', config.url), {
      method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(denial), signal: AbortSignal.timeout(5_000), redirect: 'error',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Any transport or shape failure denies: a missing authority never grants execution. */
export async function requestToolAuthorization(config: ToolAuthorizationIpcConfig, call: ToolCall): Promise<ToolAuthorizationVerdict> {
  try {
    const response = await fetch(config.url, {
      method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(call), signal: AbortSignal.timeout(config.timeoutMs + 5_000), redirect: 'error',
    });
    if (!response.ok) return unavailable();
    const value: unknown = await response.json();
    if (record(value) && value.decision === 'allow') return { decision: 'allow' };
    if (record(value) && value.decision === 'deny' && typeof value.code === 'string'
      && (DENIAL_CODES as readonly string[]).includes(value.code) && typeof value.reason === 'string') {
      return { decision: 'deny', code: value.code as ToolAuthorizationDenialCode, reason: value.reason };
    }
  } catch { /* fall through */ }
  return unavailable();
}

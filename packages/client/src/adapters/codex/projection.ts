import path from 'node:path';
import type { AgentEvent } from '@byok-sdk/protocol';
import { RuntimeExecutionFailure } from '../../runtime-failure';

/** Structural SPI: complete kernel records enter here; only the explicit BYOK native origin is interpreted. */
export interface CodexRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly kind: string;
  readonly body: unknown;
}
interface StreamState {
  readonly seen: Map<number, readonly AgentEvent[]>;
  readonly active: Map<string, { tool: string; toolCallId: string }>;
  readonly delivered: Set<string>;
  lastUsage?: Extract<AgentEvent, { type: 'usage' }>;
  activeTurnId?: string;
  baseline: Record<string, unknown> | null;
  zeroBaseline: boolean;
  latestTotals?: Record<string, unknown>;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const failure = (reason: string) =>
  new RuntimeExecutionFailure({
    phase: 'run',
    category: 'authority',
    retry: 'non-retryable',
    reason,
  });
const idOf = (item: Record<string, unknown>): string => {
  if (typeof item.id !== 'string' || item.id.trim().length === 0)
    throw failure('codex tool item had no authoritative tool call id');
  return item.id;
};
const contentTypes: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.py': 'text/x-python',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.csv': 'text/csv',
};

/** Each stream object is a separate record identity; seq and derived ordinal are local to it. */
export class CodexProjection {
  private readonly streams = new WeakMap<object, StreamState>();
  constructor(
    private readonly workspaceDir: string,
    private readonly rootThreadId: string,
    private readonly fresh = true,
  ) {}

  consume(
    stream: object,
    input: CodexRecord,
    emit: (event: AgentEvent) => void,
  ): void {
    let state = this.streams.get(stream);
    if (!state) {
      state = {
        seen: new Map(),
        active: new Map(),
        delivered: new Set(),
        baseline: this.fresh ? {} : null,
        zeroBaseline: this.fresh,
      };
      this.streams.set(stream, state);
    }
    let events = state.seen.get(input.seq);
    if (events === undefined) {
      events = this.project(state, input);
      state.seen.set(input.seq, events);
    }
    for (const [ordinal, event] of events.entries()) {
      const key = `${input.seq}:${ordinal}`;
      if (state.delivered.has(key)) continue;
      emit(event); // a failed required consumer propagates; already-delivered ordinals are not replayed.
      state.delivered.add(key);
    }
  }

  /** A transport close cannot invent a turn outcome, but must retain observed metering. */
  takePendingUsage(stream: object): Extract<AgentEvent, { type: 'usage' }> | undefined {
    const state = this.streams.get(stream);
    const usage = state?.lastUsage;
    if (state) delete state.lastUsage;
    return usage;
  }

  private project(
    state: StreamState,
    input: CodexRecord,
  ): readonly AgentEvent[] {
    const body = record(input.body);
    if (input.kind !== 'frame' || body?.origin !== 'byok-native') return [];
    const params = record(body.native) ?? {};
    const method = body.type;
    const sessionId =
      typeof params.threadId === 'string' ? params.threadId : input.sessionId;
    const isRoot =
      sessionId === this.rootThreadId && input.agentPath.length === 0;
    // Child terminal/usage cannot complete or charge the parent; child tool identities are qualified below.
    if (
      !isRoot &&
      (method === 'turn/completed' ||
        method === 'thread/tokenUsage/updated' ||
        method === 'error')
    )
      return [];
    if (method === 'turn/started' && isRoot) {
      const turnId = record(params.turn)?.id;
      if (typeof turnId === 'string') state.activeTurnId = turnId;
      return [];
    }
    if (
      isRoot &&
      typeof params.turnId === 'string' &&
      state.activeTurnId !== undefined &&
      params.turnId !== state.activeTurnId
    )
      return [];
    if (method === 'thread/tokenUsage/updated') {
      // total is thread-cumulative; a boundary delta includes every model call in this turn.
      // Fresh threads have a known zero baseline; resume needs an observed baseline, never a fabricated zero.
      const tokenUsage = record(params.tokenUsage);
      const contextTokens = record(tokenUsage?.last)?.totalTokens;
      const contextWindow = tokenUsage?.modelContextWindow;
      const context: Extract<AgentEvent, { type: 'usage' }> = { type: 'usage' };
      if (typeof contextTokens === 'number' && Number.isSafeInteger(contextTokens) && contextTokens >= 0) context.contextTokens = contextTokens;
      if (typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0) context.contextWindow = contextWindow;
      if (context.contextTokens !== undefined || context.contextWindow !== undefined || state.lastUsage?.contextSource !== undefined) context.contextSource = 'provider';
      const usage = record(tokenUsage?.total);
      if (!usage) {
        if (state.activeTurnId !== undefined && context.contextSource !== undefined) {
          const { contextTokens: _tokens, contextWindow: _window, contextSource: _source, ...cost } = state.lastUsage ?? { type: 'usage' as const };
          state.lastUsage = { ...cost, ...context };
        }
        return [];
      }
      state.latestTotals = usage;
      if (state.activeTurnId === undefined) {
        state.baseline = usage;
        state.zeroBaseline = false;
        return [];
      }
      const out: Extract<AgentEvent, { type: 'usage' }> = { ...context };
      for (const [native, key] of [
        ['inputTokens', 'inputTokens'],
        ['cachedInputTokens', 'cachedInputTokens'],
        ['outputTokens', 'outputTokens'],
        ['reasoningOutputTokens', 'reasoningTokens'],
      ] as const) {
        const value = usage[native];
        const prior =
          state.baseline?.[native] ?? (state.zeroBaseline ? 0 : undefined);
        if (
          typeof value === 'number' &&
          Number.isInteger(value) &&
          typeof prior === 'number' &&
          Number.isInteger(prior) &&
          value >= prior &&
          prior >= 0
        )
          out[key] = value - prior;
      }
      if (Object.keys(out).length > 1) state.lastUsage = out;
      return []; // the consumer stops at turn_end, so flush the latest usage immediately before it.
    }
    if (method === 'error') {
      const err = record(params.error);
      return [
        {
          type: 'error',
          message:
            typeof err?.message === 'string'
              ? err.message
              : 'codex reported an error',
        },
      ];
    }
    if (method === 'turn/completed') {
      const turn = record(params.turn);
      const status = turn?.status;
      const events: AgentEvent[] = [];
      if (status === 'interrupted') {
        for (const active of state.active.values())
          events.push({
            type: 'tool_result',
            ...active,
            output: {
              status: 'interrupted',
              reason:
                'closed after turn interruption; runtime did not report item completion',
            },
          });
      }
      state.active.clear();
      if (state.lastUsage) events.push(state.lastUsage);
      delete state.lastUsage;
      if (state.latestTotals) {
        state.baseline = state.latestTotals;
        state.zeroBaseline = false;
      }
      if (status === 'failed') {
        const error = record(turn?.error);
        events.push({
          type: 'error',
          message:
            typeof error?.message === 'string'
              ? error.message
              : 'codex turn failed',
        });
        return events;
      }
      if (status !== 'completed' && status !== 'interrupted')
        throw failure('codex turn ended without an authoritative status');
      events.push({ type: 'turn_end' });
      return events;
    }
    if (method !== 'item/started' && method !== 'item/completed') return [];
    const item = record(params.item);
    if (!item) return [];
    const started = method === 'item/started';
    if (item.type === 'agentMessage')
      return !started && typeof item.text === 'string'
        ? [{ type: 'progress', text: item.text }]
        : [];
    if (item.type === 'error')
      return typeof item.message === 'string'
        ? [{ type: 'error', message: item.message }]
        : [];
    const names: Record<string, string> = {
      commandExecution: 'command_execution',
      fileChange: 'file_change',
      mcpToolCall: 'mcp_tool_call',
      webSearch: 'web_search',
    };
    const tool = typeof item.type === 'string' ? names[item.type] : undefined;
    if (!tool) return [];
    const localId = idOf(item);
    const toolCallId = isRoot
      ? localId
      : JSON.stringify([sessionId, input.agentPath, localId]);
    const activeKey = JSON.stringify([sessionId, input.agentPath, toolCallId]);
    const changes = Array.isArray(item.changes)
      ? item.changes.map((value) => {
          const row = record(value);
          if (!row) return value;
          const nativeKind = record(row.kind);
          return {
            ...row,
            kind: typeof row.kind === 'string' ? row.kind : nativeKind?.type,
            ...(typeof nativeKind?.movePath === 'string'
              ? { movePath: nativeKind.movePath }
              : {}),
          };
        })
      : [];
    const inputValue =
      item.type === 'commandExecution'
        ? { command: item.command }
        : item.type === 'fileChange'
          ? { changes }
          : item.type === 'mcpToolCall'
            ? {
                server: item.server,
                tool: item.tool,
                arguments: item.arguments,
              }
            : { query: item.query };
    if (started) {
      state.active.set(activeKey, { tool, toolCallId });
      return [{ type: 'tool_use', tool, toolCallId, input: inputValue }];
    }
    state.active.delete(activeKey);
    const output =
      item.type === 'commandExecution'
        ? {
            command: item.command,
            aggregatedOutput: item.aggregatedOutput,
            exitCode: item.exitCode,
            status: item.status,
          }
        : item.type === 'fileChange'
          ? { changes, status: item.status }
          : item.type === 'mcpToolCall'
            ? { result: item.result, error: item.error, status: item.status }
            : { query: item.query, status: item.status };
    const events: AgentEvent[] = [
      { type: 'tool_result', tool, toolCallId, output },
    ];
    if (item.type === 'fileChange')
      for (const change of changes) {
        const row = record(change);
        if (typeof row?.path !== 'string' || row.kind === 'delete') continue;
        const target =
          typeof row.movePath === 'string' ? row.movePath : row.path;
        const name = path.relative(this.workspaceDir, target);
        if (!name || name.startsWith('..') || path.isAbsolute(name)) continue;
        events.push({
          type: 'artifact',
          name,
          contentType:
            contentTypes[path.extname(name).toLowerCase()] ??
            'application/octet-stream',
        });
      }
    return events;
  }
}

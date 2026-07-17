import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '@byok/protocol';

/**
 * A raw parsed line from `claude --output-format stream-json`. Shapes vary
 * a lot by `type` (and, for `system`, by `subtype`) — see the doc comments
 * on the individual mapping functions below for the concrete shapes this
 * was empirically captured against. Kept as a loose bag rather than a full
 * discriminated union for the same reason pi's `PiRpcMessage` is: this
 * module only needs a handful of fields off of each frame.
 */
export interface ClaudeStreamMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Cross-message correlation state a single {@link ClaudeSession} (in
 * `../claude-adapter.ts`) owns for its whole lifetime.
 *
 * Unlike pi's `tool_execution_start`/`tool_execution_end` frames (which
 * both carry `toolName` directly, so `../pi/events.ts` can stay a pure,
 * stateless function), claude's Messages-API-shaped transcript splits a
 * tool call across two DIFFERENT frame types: the `assistant` frame's
 * `tool_use` content block carries `{id, name, input}`, but the later
 * `user` frame's `tool_result` content block carries only `{tool_use_id,
 * content, is_error}` — no tool name at all. Since this protocol's own
 * `AgentEvent` schema requires `tool_result.tool: string`, this mapper has
 * no choice but to remember `tool_use_id -> name` from the `tool_use` block
 * and look it up when the matching `tool_result` arrives later. This is a
 * genuine, disclosed structural difference from pi, not an arbitrary
 * design choice — see the M2-a report for the full reasoning.
 */
export interface ToolUseCorrelation {
  readonly toolNameByUseId: Map<string, string>;
}

export function createToolUseCorrelation(): ToolUseCorrelation {
  return { toolNameByUseId: new Map() };
}

export interface MapClaudeMessageOptions {
  /** `ctx.workspaceDir` for the task — used only to compute a workspace-relative `name` for a possible `artifact` AgentEvent (see `tryBuildArtifactEvent`'s doc comment). */
  workspaceDir: string;
}

export interface MapClaudeMessageResult {
  events: AgentEvent[];
  /**
   * Set when this exact frame (or, for `assistant`/`user` frames, one
   * content block inside it) was genuinely unrecognized — a frame/subtype/
   * block-type this adapter has never been told to expect — as opposed to
   * routine bookkeeping this mapper deliberately ignores (see
   * `ROUTINE_CLAUDE_SYSTEM_SUBTYPES` and the `thinking`/`redacted_thinking`
   * cases below). The caller (`ClaudeSession`'s event iterator) is
   * responsible for actually recording it (via
   * `ClaudeProcessClient.recordUnmappedFrame`) — mirrors pi's
   * `ROUTINE_PI_EVENT_TYPES` check living in `PiSession`'s iterator rather
   * than inside `mapPiMessageToAgentEvent` itself. At most one label per
   * call even if a frame has several unmapped things in it — sufficient
   * for the "did this regress" self-diagnosing purpose this exists for,
   * without needing a list.
   */
  unmappedLabel?: string;
}

/**
 * `system` frame subtypes empirically observed on real stream-json output
 * from the installed claude 2.1.212 binary that carry no `AgentEvent`
 * equivalent — routine bookkeeping, deliberately ignored:
 *
 * - `init`: session/turn start. Carries `session_id`, `tools`, `cwd`,
 *   `permissionMode`, etc. `session_id` specifically is NOT read here —
 *   `ClaudeProcessClient.waitForInit()` (`process-client.ts`) captures it
 *   directly off the raw line as part of this adapter's own
 *   `start()`/sessionRef bookkeeping, since it's needed before any
 *   `AgentEvent` mapping is even relevant.
 * - `hook_started` / `hook_response`: fired when the user's own Claude Code
 *   installation has configured lifecycle hooks (e.g. `SessionStart`) —
 *   machine/config-specific, not part of this protocol's surface at all.
 * - `thinking_tokens`: periodic token-count-estimate bookkeeping emitted
 *   while the model is reasoning; no user-visible content.
 *
 * A `system` frame whose `subtype` is NOT in this set is treated as
 * genuinely unmapped (see `mapClaudeMessageToAgentEvents`'s `system` case)
 * rather than silently folded into "system frames are always routine" —
 * this is deliberately finer-grained than lumping the whole `system` type
 * together, so a future/unobserved subtype (e.g. something compaction- or
 * budget-related) shows up as a one-time warning instead of disappearing
 * the way the pi adapter's own root-cause hang (a real settle event with no
 * mapping, silently swallowed) did before that bug was found.
 */
export const ROUTINE_CLAUDE_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'init',
  'hook_started',
  'hook_response',
  'thinking_tokens',
]);

/** Claude tool names whose successful `tool_result` may correspond to a file written into the task workspace — see `tryBuildArtifactEvent`. `Write` is fully empirically confirmed (real `tool_use_result.filePath`/`.type:"create"` shape captured live); `Edit`/`NotebookEdit` are included by the same reasoning/convention as `permission-mapping.ts`'s `Glob`/`Grep` note — not independently re-verified frame-by-frame here. */
const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);

const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.py': 'text/x-python',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

/** Best-effort, extension-based content-type guess — deliberately not a full MIME sniffer (out of scope; `AgentEventSchema.artifact.contentType` just needs a non-empty string). */
function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * `assistant` frames carry ONE new Messages-API content block per frame in
 * every live capture this adapter's empirical probes observed (never
 * multiple) — this still iterates the whole `content` array defensively
 * rather than assuming array length 1, since nothing in claude's own
 * documented wire contract guarantees that stays true.
 */
function mapAssistant(msg: ClaudeStreamMessage, correlation: ToolUseCorrelation): MapClaudeMessageResult {
  const message = msg.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return { events: [] };

  const events: AgentEvent[] = [];
  let unmappedLabel: string | undefined;

  for (const raw of content) {
    const block = raw as { type?: unknown; [key: string]: unknown };
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') {
          events.push({ type: 'progress', text: block.text });
        }
        break;

      case 'tool_use':
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          correlation.toolNameByUseId.set(block.id, block.name);
          events.push({ type: 'tool_use', tool: block.name, input: block.input });
        }
        break;

      // Deliberately NOT mapped to `progress` — mirrors pi's own choice to
      // ignore `thinking_delta` sub-events (see `../pi/events.ts`). Two
      // independent reasons: (1) the daemon's `task-runner.ts` folds every
      // `progress` event's text into `task.complete.summary` verbatim —
      // surfacing raw model reasoning there would leak internal
      // chain-of-thought to whatever SaaS embeds this SDK; (2) on several
      // current-generation models this content is empty by design anyway
      // (`display: "omitted"` is the default — see the claude-api skill's
      // "Thinking & Effort" reference) even though it was NOT empty in this
      // task's own live captures against `claude-haiku-4-5`. `redacted_thinking`
      // is a documented Anthropic Messages API block type never observed
      // live here; treated identically for the same reasoning.
      case 'thinking':
      case 'redacted_thinking':
        break;

      default:
        unmappedLabel = unmappedLabel ?? `assistant-block:${String(block.type)}`;
    }
  }

  return { events, unmappedLabel };
}

/**
 * `user` frames in stream-json output are NOT a human sending input — they
 * are claude echoing a `tool_result` back into the transcript (the same
 * "user" role the underlying Messages API uses for tool results). Two
 * concrete verbatim shapes captured live:
 *
 * Denied (no permission granted, headless — see `../claude-adapter.ts`'s
 * doc comment for the full approval-model finding):
 * ```json
 * {"type":"user","message":{"role":"user","content":[{"type":"tool_result",
 *   "content":"Claude requested permissions to write to <path>, but you
 *   haven't granted it yet.","is_error":true,"tool_use_id":"toolu_..."}]},
 *  "tool_use_result":"Error: Claude requested permissions to write to
 *   <path>, but you haven't granted it yet."}
 * ```
 *
 * Successful Write (the shape `tryBuildArtifactEvent` reads):
 * ```json
 * {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_...",
 *   "type":"tool_result","content":"File created successfully at: <path> ..."}]},
 *  "tool_use_result":{"type":"create","filePath":"<absolute path>",
 *   "content":"...","structuredPatch":[],"originalFile":null,"userModified":false}}
 * ```
 *
 * `content` on the `tool_result` block was only ever observed as a plain
 * string in this task's captures (never the content-block-array shape the
 * general Messages API allows) — `output.content` below is passed through
 * as `unknown` regardless, so a future array shape still round-trips
 * correctly without a mapping change.
 */
function mapUser(msg: ClaudeStreamMessage, correlation: ToolUseCorrelation, options: MapClaudeMessageOptions): MapClaudeMessageResult {
  const message = msg.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return { events: [] };

  const events: AgentEvent[] = [];
  let unmappedLabel: string | undefined;

  for (const raw of content) {
    const block = raw as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
    if (block.type !== 'tool_result') {
      unmappedLabel = unmappedLabel ?? `user-block:${String(block.type)}`;
      continue;
    }

    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
    // Falls back to 'unknown' rather than dropping the event: the
    // AgentEventSchema requires a non-empty `tool` string, and a
    // correlation miss here would mean this adapter's own
    // tool_use<->tool_result bookkeeping has a bug — worth surfacing to the
    // caller as a (still-delivered) event with an honest sentinel name,
    // never silently swallowing real tool-result data.
    const tool = (toolUseId && correlation.toolNameByUseId.get(toolUseId)) || 'unknown';
    const isError = block.is_error === true;
    events.push({ type: 'tool_result', tool, output: { content: block.content, isError } });

    if (!isError && FILE_WRITING_TOOLS.has(tool)) {
      const artifact = tryBuildArtifactEvent(msg, options.workspaceDir);
      if (artifact) events.push(artifact);
    }
  }

  return { events, unmappedLabel };
}

/**
 * Real claude has no dedicated "artifact" wire message the way pi's fixture
 * fakes one (see `../pi/events.ts`'s doc comment on that case) — but for a
 * successful `Write` (confirmed shape above), the SAME `user` frame's
 * top-level `tool_use_result.filePath` sibling field gives this adapter
 * something pi never had: a real, live-observed, absolute path to the file
 * claude just wrote. This turns it into a workspace-relative `name` for the
 * protocol's `artifact` `AgentEvent`.
 *
 * A written file OUTSIDE `workspaceDir` never produces an artifact event —
 * this is not just defensive coding, it is the concrete fix for a real,
 * confirmed case: `--permission-mode plan` writes its own plan document to
 * `~/.claude/plans/<slug>.md`, the user's actual home directory, regardless
 * of cwd (see `permission-mapping.ts`'s doc comment on that finding). That
 * path always resolves outside `workspaceDir` and must never be reported to
 * the daemon as this task's artifact.
 */
function tryBuildArtifactEvent(msg: ClaudeStreamMessage, workspaceDir: string): AgentEvent | undefined {
  const toolUseResult = msg.tool_use_result as { filePath?: unknown } | undefined;
  const filePath = toolUseResult && typeof toolUseResult.filePath === 'string' ? toolUseResult.filePath : undefined;
  if (!filePath) return undefined;

  // `workspaceDir` (`ctx.workspaceDir`) and the absolute `filePath` claude
  // reports can each be expressed through a different symlink alias of the
  // same real location — hit empirically on macOS, where `os.tmpdir()`
  // itself is a symlink (`/var/folders/... -> /private/var/folders/...`)
  // and a spawned child process's own `process.cwd()` reports the
  // REALPATH-resolved form regardless of which alias `cwd` was set to when
  // spawning it. Comparing the raw strings directly misclassifies a file
  // that genuinely IS inside the workspace as outside it purely because of
  // which alias each side happened to use — confirmed live: this silently
  // dropped every artifact event for a workspace created under this
  // machine's own `os.tmpdir()` before this fix. Resolve both through
  // `realpath` before comparing — mirrors `task-runner.ts`'s own
  // `openArtifact()`, which resolves the exact same alias-mismatch class
  // for its downstream containment check.
  //
  // Realpath is applied to the *directory*, not the file itself: the file
  // is expected to exist by the time this runs against real claude output
  // (the tool_result frame only arrives after the write actually
  // happened), but resolving the directory rather than the leaf path keeps
  // this correct even when it doesn't (a stale/removed artifact, or a pure
  // unit test constructing a `tool_use_result` without writing real bytes)
  // — falls back to the raw directory on a realpath failure (e.g. it too
  // doesn't exist), matching `openArtifact`'s own defensive fallback.
  const realWorkspaceDir = tryRealpath(workspaceDir) ?? workspaceDir;
  const fileDir = path.dirname(filePath);
  const realFileDir = tryRealpath(fileDir) ?? fileDir;
  const realFilePath = path.join(realFileDir, path.basename(filePath));

  const relative = path.relative(realWorkspaceDir, realFilePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }

  return { type: 'artifact', name: relative, contentType: guessContentType(filePath) };
}

function tryRealpath(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/**
 * `result` is claude's real "whole run settled" signal (the direct
 * counterpart to pi's `agent_end` — see `../pi/events.ts`'s doc comment on
 * why that distinction mattered there). Confirmed live: it is always the
 * LAST frame of a turn, whether the turn succeeded (`is_error:false`,
 * `subtype:"success"`) or failed before ever reaching the model (e.g. an
 * unresolvable `--resume` target: `subtype:"error_during_execution"`,
 * `is_error:true`, `errors:["No conversation found with session ID: ..."]`,
 * process exit code 1 — but STILL a clean, parseable stream-json frame,
 * unlike pi's equivalent bad-invocation case which produces no structured
 * output at all and forces the adapter to fall back to a raw stderr tail).
 * `is_error` (not `subtype`) is the field this switches on, since it is a
 * plain boolean rather than a string this adapter would otherwise need to
 * pattern-match against every observed/unobserved subtype spelling.
 *
 * `usage` (pre-freeze protocol addition — see `extractClaudeUsageEvent`'s
 * doc comment) is extracted on BOTH branches, not just success: a real
 * mid-generation API error could still carry partial usage, and an empty/
 * absent `usage` (the confirmed shape on the pre-flight "no conversation
 * found" failure — no model call was ever made) just yields no event, same
 * as the success path. Ordering is load-bearing: `usage`, when present, is
 * placed BEFORE `turn_end`/`error` in the returned array — `ClaudeSession`'s
 * event iterator (`../claude-adapter.ts`) buffers this array and drains it
 * in order, and `task-runner.ts`'s `pump()` returns the instant it sees
 * `turn_end`, so anything queued after it would never be read. `error` does
 * not end the read loop the same way, so the ordering there is for
 * consistency rather than a delivery requirement.
 */
function mapResult(msg: ClaudeStreamMessage): MapClaudeMessageResult {
  const usageEvent = extractClaudeUsageEvent(msg.usage);
  // Cross-model review finding: success must require `is_error === false`
  // EXPLICITLY — the previous `!== true` check treated a MISSING or
  // non-boolean `is_error` (a malformed/future `result` frame) as success
  // too, which would have reported task.complete for a turn that never
  // actually said it succeeded. `result` is the wire's own terminal signal
  // (see this function's own doc comment above) — never inferred.
  if (msg.is_error === false) {
    const events: AgentEvent[] = usageEvent ? [usageEvent, { type: 'turn_end' }] : [{ type: 'turn_end' }];
    return { events };
  }
  const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === 'string') : [];
  const message =
    msg.is_error === true
      ? errors.length > 0
        ? errors.join('; ')
        : typeof msg.result === 'string' && msg.result.length > 0
          ? msg.result
          : 'claude reported an error result'
      : `claude result frame had a missing/invalid is_error flag (got ${JSON.stringify(msg.is_error)}) — treating as failure, fail-closed`;
  const events: AgentEvent[] = usageEvent ? [usageEvent, { type: 'error', message }] : [{ type: 'error', message }];
  return { events };
}

/**
 * Maps the `result` frame's `usage` object to a `usage` `AgentEvent`, or
 * `undefined` when nothing usable is present. Field names and shape
 * confirmed via a live minimal probe against the installed claude 2.1.212
 * binary (same version this adapter's other captures were made against —
 * see `claude-adapter.ts`'s class doc comment): a real `result.usage` looks
 * like `{"input_tokens":2,"cache_creation_input_tokens":35649,
 * "cache_read_input_tokens":0,"output_tokens":24,"server_tool_use":{...},
 * "service_tier":"standard",...}` — the standard Anthropic Messages API
 * usage shape, carried through verbatim by the Claude Code CLI.
 *
 * Mapping choices:
 * - `inputTokens` <- `input_tokens` verbatim.
 * - `cachedInputTokens` <- `cache_read_input_tokens` (tokens actually SERVED
 *   from a prior cache — the same "reused, cheaper" semantic as codex's
 *   `cached_input_tokens`). Deliberately NOT `cache_creation_input_tokens`
 *   (the cost of WRITING a new cache entry — a distinct, more-expensive-not-
 *   cheaper concept the wire schema has no separate slot for; dropped
 *   rather than conflated).
 * - `outputTokens` <- `output_tokens` verbatim.
 * - `reasoningTokens` / `totalTokens`: never populated for claude — neither
 *   a separate reasoning-token count nor a combined total appears anywhere
 *   in real claude output (thinking-block content is folded into
 *   `output_tokens`, not counted separately), so these stay absent rather
 *   than fabricated.
 */
function extractClaudeUsageEvent(rawUsage: unknown): AgentEvent | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;
  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = toNonNegativeInt(usage.input_tokens);
  const cachedInputTokens = toNonNegativeInt(usage.cache_read_input_tokens);
  const outputTokens = toNonNegativeInt(usage.output_tokens);
  if (inputTokens === undefined && cachedInputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  const event: Extract<AgentEvent, { type: 'usage' }> = { type: 'usage' };
  if (inputTokens !== undefined) event.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) event.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) event.outputTokens = outputTokens;
  return event;
}

/** Matches `AgentEventSchema`'s `usage` fields (`z.number().int().nonnegative().optional()`) — anything else (missing, a string, a float, negative) is treated as not-reported rather than coerced. */
function toNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Map one raw claude stream-json line to zero or more normalized
 * `AgentEvent`s (a single `user` frame can produce two: `tool_result` plus
 * a derived `artifact`). See the per-`type` mapping functions above for the
 * concrete, empirically-captured shapes each branch handles.
 */
export function mapClaudeMessageToAgentEvents(
  msg: ClaudeStreamMessage,
  correlation: ToolUseCorrelation,
  options: MapClaudeMessageOptions,
): MapClaudeMessageResult {
  switch (msg.type) {
    case 'assistant':
      return mapAssistant(msg, correlation);
    case 'user':
      return mapUser(msg, correlation, options);
    case 'result':
      return mapResult(msg);
    case 'system': {
      const subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined;
      if (subtype && ROUTINE_CLAUDE_SYSTEM_SUBTYPES.has(subtype)) return { events: [] };
      return { events: [], unmappedLabel: `system:${subtype ?? 'unknown'}` };
    }
    // Per-turn rate-limit-window bookkeeping, unconditionally emitted
    // alongside every result — no `AgentEvent` equivalent, routine.
    case 'rate_limit_event':
      return { events: [] };
    default:
      return { events: [], unmappedLabel: `top-level:${String(msg.type)}` };
  }
}

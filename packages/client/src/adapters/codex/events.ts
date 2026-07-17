import path from 'node:path';
import type { AgentEvent } from '@byok/protocol';
import type { CodexRawEvent } from './process-runner';

/**
 * `codex exec --json` event catalog, empirically captured (raw JSONL frames,
 * not inferred from docs) driving the real installed `codex-cli 0.144.5`
 * across: plain chat, file writes (`apply_patch`-style), shell commands,
 * network attempts, sandbox denials, an invalid-model API error, and a
 * SIGTERM-killed-then-resumed thread. Two nesting levels: top-level frames
 * (`thread.started`, `turn.started`, `item.started`, `item.completed`,
 * `turn.completed`, `turn.failed`, and a top-level `error` distinct from any
 * item), and — inside `item.started`/`item.completed` — a nested `item.type`
 * (`agent_message`, `command_execution`, `file_change`, `error`).
 *
 * `thread.started` (always the first line codex ever prints, both for a
 * fresh `codex exec` and for `codex exec resume`) is deliberately NOT
 * handled here — it's consumed directly by `../codex-adapter.ts`'s
 * `runCodexTurn` to resolve `Session.sessionRef` before this mapper ever
 * sees a line, mirroring how pi's adapter resolves a fresh session id via
 * `get_state` before constructing its `Session` (`../pi/pi-adapter.ts`'s
 * `resolveFreshSessionId`). It's still listed in
 * {@link ROUTINE_CODEX_EVENT_TYPES} for defensiveness, in case it were ever
 * unexpectedly seen again mid-stream.
 *
 * No case here ever produces `{type: 'needs_approval'}` — deliberately, not
 * an oversight. `codex exec` (this build) has no wire-visible signal for it
 * at all: a sandbox-denied action under any approval policy resolves
 * internally with no pause an external caller could ever answer — confirmed
 * empirically (a `sandbox_mode=read-only` write attempt, and separately an
 * `approval_policy=untrusted` shell command outside the sandbox's own
 * trusted-command allowlist, both either just ran when the sandbox allowed
 * it or were silently auto-denied when it didn't, narrated only as a normal
 * `agent_message` — never a distinct event this mapper could hook). See
 * `../codex-adapter.ts`'s `resolveApproval`, which throws rather than
 * pretending to support a resume path that cannot exist on the wire.
 */
export function mapCodexEventToAgentEvents(evt: CodexRawEvent, workspaceDir: string): AgentEvent[] {
  switch (evt.type) {
    case 'turn.completed': {
      // `usage` (input/cached-input/output/reasoning-output token counts) —
      // pre-freeze protocol change (see `packages/protocol/src/agent-event.ts`)
      // added a `usage` AgentEvent variant specifically for this data, which
      // was real and present here but had no wire slot before that. Mapped
      // 1:1 from codex's own field names (`extractCodexUsageEvent` below);
      // no `total_tokens` field has ever been observed on real codex output,
      // so `totalTokens` is never populated here — never synthesized by
      // summing, per this adapter's "forward only what's actually reported"
      // convention.
      //
      // Ordering is load-bearing, not stylistic: `usage` is placed BEFORE
      // `turn_end` in the returned array. `codex-adapter.ts`'s `runCodexTurn`
      // pushes each element of this array onto the session's queue in order,
      // and `task-runner.ts`'s `pump()` returns immediately (ending the read
      // loop) the instant it sees `turn_end` — an event queued AFTER it would
      // never be drained. See `../claude/events.ts`'s `mapResult`, which has
      // the identical ordering constraint for the same reason.
      const usageEvent = extractCodexUsageEvent(evt.usage);
      return usageEvent ? [usageEvent, { type: 'turn_end' }] : [{ type: 'turn_end' }];
    }

    case 'turn.failed':
      // The real turn-level failure signal — NOT `item.completed{type:
      // 'error'}` (see below, which is informational/non-fatal and can
      // appear even on a fully successful turn). Deliberately does NOT also
      // synthesize a `turn_end`: task-runner.ts's `pump()` only treats an
      // explicit `turn_end` as success, and an events iterable that ends
      // without one already reports `task.fail` on its own (the codex
      // process exits non-zero right after this frame, ending the stream
      // naturally) — so this only needs to make the failure reason visible
      // via `task.progress` before that happens.
      return [{ type: 'error', message: extractErrorMessage(evt.error) ?? 'codex turn failed' }];

    case 'error':
      // Top-level (not nested in an item) — empirically seen paired
      // immediately before a `turn.failed`, carrying the same underlying API
      // error message (itself a JSON-encoded string from the provider
      // response) verbatim, deliberately not re-parsed — forwarding exactly
      // what codex reported is more honest than guessing at its structure.
      return [{ type: 'error', message: typeof evt.message === 'string' ? evt.message : 'codex reported an error' }];

    case 'item.started':
      return mapItem(evt.item, 'started', workspaceDir);

    case 'item.completed':
      return mapItem(evt.item, 'completed', workspaceDir);

    // `thread.started`/`turn.started` carry no AgentEvent-mappable content —
    // see the module doc comment above for why `thread.started` is handled
    // upstream instead. Both are also listed in ROUTINE_CODEX_EVENT_TYPES.
    case 'thread.started':
    case 'turn.started':
      return [];

    default:
      return []; // caller (codex-adapter.ts) records this as an unmapped frame unless isRoutineCodexEvent(evt)
  }
}

/**
 * Maps `turn.completed.usage` to a `usage` `AgentEvent`, or `undefined` when
 * nothing usable is present (e.g. `usage: {}`, empirically also seen on real
 * codex — never emit a content-free `usage` event just because the key
 * existed). Field names are verbatim from real codex output — confirmed live
 * against the installed `codex-cli` binary while building this mapping
 * (`turn.completed` -> `{"usage":{"input_tokens":24963,"cached_input_tokens":
 * 9984,"output_tokens":5,"reasoning_output_tokens":0}}`), matching the
 * shape this adapter's own fixture (`fake-codex.mjs`) and unit tests already
 * encoded from the ORIGINAL M2-b capture. `0` is a real, reportable value
 * (not absence) for every one of these fields — only a non-number/missing
 * value is treated as "not reported".
 */
function extractCodexUsageEvent(rawUsage: unknown): AgentEvent | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;
  const usage = rawUsage as Record<string, unknown>;
  const inputTokens = toNonNegativeInt(usage.input_tokens);
  const cachedInputTokens = toNonNegativeInt(usage.cached_input_tokens);
  const outputTokens = toNonNegativeInt(usage.output_tokens);
  const reasoningTokens = toNonNegativeInt(usage.reasoning_output_tokens);
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  const event: Extract<AgentEvent, { type: 'usage' }> = { type: 'usage' };
  if (inputTokens !== undefined) event.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) event.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) event.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) event.reasoningTokens = reasoningTokens;
  return event;
}

/** Matches `AgentEventSchema`'s `usage` fields (`z.number().int().nonnegative().optional()`) — anything else (missing, a string, a float, negative) is treated as not-reported rather than coerced. */
function toNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

type ItemPhase = 'started' | 'completed';

function mapItem(rawItem: unknown, phase: ItemPhase, workspaceDir: string): AgentEvent[] {
  if (!rawItem || typeof rawItem !== 'object') return [];
  const item = rawItem as Record<string, unknown>;
  const itemType = item.type;

  switch (itemType) {
    case 'agent_message': {
      // Empirically only ever observed as `item.completed` — codex delivers
      // the whole message atomically, not as streamed token deltas the way
      // pi's `text_delta` does (see `../pi/events.ts`). An `item.started`
      // for `agent_message` has never been seen; if it ever is, this falls
      // through to the empty-array default and gets flagged as unmapped
      // (see `isRoutineCodexEvent`/`unmappedFrameKey`) rather than silently
      // treated as equivalent to `.completed`.
      if (phase !== 'completed') return [];
      return typeof item.text === 'string' ? [{ type: 'progress', text: item.text }] : [];
    }

    case 'command_execution': {
      const command = typeof item.command === 'string' ? item.command : undefined;
      if (phase === 'started') {
        return command !== undefined ? [{ type: 'tool_use', tool: 'command_execution', input: { command } }] : [];
      }
      return [
        {
          type: 'tool_result',
          tool: 'command_execution',
          output: {
            command,
            aggregatedOutput: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status,
          },
        },
      ];
    }

    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (phase === 'started') {
        return [{ type: 'tool_use', tool: 'file_change', input: { changes } }];
      }
      return [
        { type: 'tool_result', tool: 'file_change', output: { changes, status: item.status } },
        ...extractArtifactEvents(changes, workspaceDir),
      ];
    }

    case 'error': {
      // Informational/warning-level, NOT necessarily a task failure — e.g.
      // "Exceeded skills context budget..." (this environment's installed
      // skill count exceeds codex's own model-visible budget) appeared as
      // `item_0` on EVERY single empirical capture made while building this
      // adapter, success or failure alike, and "Model metadata for `<bad
      // model>` not found. Defaulting to fallback metadata..." appeared
      // ahead of a turn that otherwise still ran. Forwarded honestly as an
      // `AgentEvent` (task-runner.ts's `pump()` already tolerates `error`
      // AgentEvents as non-fatal progress — see its own `sendArtifact`
      // failure handling, which does the same) rather than pattern-matching
      // on message text to guess which `error` items "really" matter, which
      // would be fragile and machine-specific (this exact notice may not
      // even appear on a machine with fewer installed codex skills).
      return typeof item.message === 'string' ? [{ type: 'error', message: item.message }] : [];
    }

    default:
      return [];
  }
}

/**
 * `file_change` items report the changed file's ABSOLUTE path. Converting to
 * a workspace-relative name before emitting an `artifact` AgentEvent matters
 * for two independent reasons, not just style:
 *
 * 1. `task-runner.ts`'s `openArtifact(workspaceDir, name)` resolves `name`
 *    via `path.resolve(realWorkspaceDir, name)` — and `path.resolve` returns
 *    an absolute second argument VERBATIM, discarding `realWorkspaceDir`
 *    entirely (unlike `path.join`). Handing it codex's raw absolute path
 *    would only happen to pass its containment check by coincidence (when
 *    that absolute path happens to already be textually prefixed by the
 *    realpath'd workspace dir) rather than by the intended, robust
 *    relative-path contract every other adapter's artifact name follows
 *    (pi's fixture, e.g., always uses a simple relative filename).
 * 2. It lets this mapper itself fail closed — skip, don't forward — a
 *    `file_change` that (for whatever reason) landed outside the given
 *    `workspaceDir` (`path.relative` starting with `..`), rather than
 *    silently handing task-runner.ts's own containment check a path it has
 *    to reject on this adapter's behalf.
 *
 * `contentType` is a best-effort extension guess: `file_change` items report
 * only `path`/`kind`, never a content type (unlike pi's synthetic artifact
 * message, which carries one directly) — `application/octet-stream` for
 * anything not in the small known-extension table below is an honest "don't
 * know" default, not a wrong guess dressed up as a real one.
 */
function extractArtifactEvents(changes: unknown[], workspaceDir: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const rawChange of changes) {
    if (!rawChange || typeof rawChange !== 'object') continue;
    const change = rawChange as Record<string, unknown>;
    const absolutePath = typeof change.path === 'string' ? change.path : undefined;
    const kind = typeof change.kind === 'string' ? change.kind : undefined;
    if (!absolutePath || kind === 'delete') continue; // nothing to upload for a deletion

    const relative = path.relative(workspaceDir, absolutePath);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) continue; // outside the workspace — never trust/forward (see doc comment above)

    events.push({ type: 'artifact', name: relative, contentType: guessContentType(relative) });
  }
  return events;
}

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
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

function guessContentType(relativePath: string): string {
  return CONTENT_TYPE_BY_EXTENSION[path.extname(relativePath).toLowerCase()] ?? 'application/octet-stream';
}

function extractErrorMessage(rawError: unknown): string | undefined {
  if (typeof rawError === 'string') return rawError;
  if (!rawError || typeof rawError !== 'object') return undefined;
  const message = (rawError as Record<string, unknown>).message;
  return typeof message === 'string' ? message : undefined;
}

/** Top-level codex event types with no `AgentEvent` equivalent, by design (not "not yet handled") — kept in sync with the switch cases above sharing this comment. Used only for observability, mirroring pi's `ROUTINE_PI_EVENT_TYPES`: `codex-adapter.ts`'s per-line pump only records a frame as genuinely unmapped (`unmappedFrameKey` + a one-time console.warn) when it maps to an empty array AND its type isn't in this set. */
export const ROUTINE_CODEX_EVENT_TYPES: ReadonlySet<string> = new Set(['thread.started', 'turn.started']);

export function isRoutineCodexEvent(evt: CodexRawEvent): boolean {
  return ROUTINE_CODEX_EVENT_TYPES.has(evt.type);
}

/** Diagnostic key for unmapped-frame accounting: for `item.*` frames, folds in the nested `item.type` (e.g. `"item.completed:reasoning"`) so a never-seen item shape is distinguishable from a never-seen top-level type. */
export function unmappedFrameKey(evt: CodexRawEvent): string {
  if (evt.type === 'item.started' || evt.type === 'item.completed') {
    const item = evt.item;
    const itemType = item && typeof item === 'object' && typeof (item as Record<string, unknown>).type === 'string' ? (item as Record<string, unknown>).type : 'unknown';
    return `${evt.type}:${String(itemType)}`;
  }
  return evt.type;
}

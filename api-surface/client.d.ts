// ==== @byok-sdk/client dist/adapters/claude/claude-adapter.d.ts ====
import { type RuntimeAdapter, type RuntimeDetectResult, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult } from '../../types';
import { type ResolvedBin } from './resolve-bin';
import { type ResolvedApprovalMcpBin } from './resolve-approval-mcp-bin';
import { type SpawnFn } from './process-client';
import { APPROVAL_MCP_SERVER_NAME } from '../../sdk-reserved-mcp';
/** The MCP server NAME this adapter registers `byok-approval-mcp` under in the generated `--mcp-config` — combined with {@link APPROVAL_TOOL_NAME} (single-sourced from `bin/approval-mcp-server.ts` so the two can never independently drift) to form the `mcp__<server>__<tool>` identifier `--permission-prompt-tool` expects. Defined in `sdk-reserved-mcp.ts` beside the other SDK-owned server names, and re-exported from here, its original home, so the host-config rejection and the toolset-grant rule read one list. */
export { APPROVAL_MCP_SERVER_NAME };
export interface ClaudeAdapterOptions {
    /** Override bin resolution — tests substitute the fake-claude fixture script. */
    resolveBin?: () => ResolvedBin;
    /** Override process spawning — tests substitute a fake spawn. */
    spawnFn?: SpawnFn;
    /** M4 Phase 3: override `byok-approval-mcp` bin resolution — tests substitute a fixture script instead of computing a real dist path. Mirrors `resolveBin` above. */
    resolveApprovalMcpBin?: () => ResolvedApprovalMcpBin;
}
/**
 * Claude Code runtime adapter (`claude -p --input-format stream-json
 * --output-format stream-json`) — the M2-a counterpart to `../pi/pi-adapter.ts`.
 * Every behavioral claim in this file's own doc comments and its sibling
 * modules (`events.ts`, `permission-mapping.ts`, `process-client.ts`) was
 * empirically reproduced against the real installed `claude` 2.1.212 binary
 * on a logged-in machine (per this task's own "do NOT trust docs over the
 * real binary" mandate — `claude --help` was actively wrong/misleading for
 * `--allowedTools`, see `permission-mapping.ts`) — not inferred from
 * training-data recall or the Claude API/Agent-SDK docs, which describe a
 * DIFFERENT product surface (the Messages API, not this CLI's headless
 * wire format).
 *
 * ## The central finding: claude's headless approval model has no
 * `needs_approval` pause, at all
 *
 * This is the first real use of the `needs_approval` /
 * `Session.resolveApproval` seam any adapter in this codebase has
 * implemented (pi never emits `needs_approval` — see `PiSession
 * .resolveApproval`'s own doc comment) — so this finding directly informs
 * the M2-c protocol-freeze decision on that seam.
 *
 * Empirically (see the M2-a report for the full live-capture evidence):
 * spawning `claude -p` **non-interactively** with a tool call that would
 * normally prompt a human is resolved **synchronously, before the turn
 * continues** — there is no pause, no wait, no later resumption point:
 *
 * - Under `--permission-mode default` (or no flag at all — headless has no
 *   TTY to interactively ask), an unapproved tool call is immediately
 *   AUTO-DENIED with a synthesized `tool_result`
 *   (`"Claude requested permissions to write to <path>, but you haven't
 *   granted it yet."`, `is_error:true`) and the run continues normally to
 *   its own `result` frame — no hang, and nothing this adapter could ever
 *   resume later even if it wanted to.
 * - Under a permissive `--permission-mode` (`acceptEdits`/`bypassPermissions`),
 *   the call is auto-GRANTED, again synchronously, again with nothing to
 *   pause on.
 *
 * There is consequently no claude stream-json frame this adapter could
 * ever map to the protocol's `needs_approval` `AgentEvent` — the decision
 * is always already made by the time any frame reaches this adapter at
 * all. `resolveApproval()` below throws a descriptive error rather than
 * silently no-op'ing, mirroring `PiSession.resolveApproval`'s own
 * documented reasoning exactly: a caller that ever receives
 * `task.approve`/`task.reject` for one of this adapter's tasks implies
 * something upstream expected approval support this adapter genuinely does
 * not have.
 *
 * `PermissionPolicy.mode: 'confirm'` — the policy mode whose whole point is
 * "ask a human, then proceed" — was therefore rejected outright at
 * `start()` through M2/M3 (fail-closed, see `permission-mapping.ts`), never
 * silently downgraded to auto-accept or auto-deny.
 *
 * ## M4 Phase 3 update: a genuine out-of-band pause DOES exist — it is
 * just invisible to everything written above
 *
 * `--permission-prompt-tool` (a DIFFERENT flag from `--permission-mode`,
 * undocumented in `claude --help`'s own output on the installed 2.1.216
 * binary but empirically confirmed accepted — an unrecognized flag is
 * rejected outright with `error: unknown option`, this one is not) makes
 * claude block a turn on a real MCP round-trip to a server it spawns
 * itself, waiting for that server to answer allow/deny before continuing —
 * genuinely pausing, for real wall-clock time (live-verified: an instant
 * allow/deny, AND a deliberate multi-second delayed answer, both worked
 * identically; only a permission-prompt-tool call that never answers AT
 * ALL was found to make claude abandon the turn on its own, after roughly
 * 1.5s — never actually reachable by this design, since the bundled
 * `bin/byok-approval-mcp.ts` always eventually answers within its own
 * configured ceiling).
 *
 * Everything above this section remains true and is NOT superseded by
 * this: claude's own stream-json output still emits nothing while this
 * pause is in progress — the gap between a `tool_use` frame and its
 * `tool_result` is indistinguishable from ordinary model latency on the
 * wire, and there is still no `needs_approval`-shaped frame this adapter's
 * event mapper could ever produce. The pause is real, but it is invisible
 * to `ClaudeSession.events` and to `task-runner.ts`'s `pump()` entirely —
 * it is only ever observable from OUTSIDE this adapter's own process, by
 * the separate MCP-server child process claude itself spawns. This is why
 * `confirm` mode's daemon-side wiring (`task-runner.ts`'s `requestApproval`,
 * `types.ts`'s `ApprovalChannel`) is driven from the control socket, not
 * from any `AgentEvent` — see those files' own doc comments for the full
 * design this finding drove. `confirm` is now SUPPORTED (see
 * `permission-mapping.ts` and `resolveApproval()` below), still fail-closed
 * whenever no approval channel was actually wired up for this session.
 *
 * ## Steering was also found unsupported (a second, related finding)
 *
 * Live-probed via a persistent `--input-format stream-json` process:
 * writing a second `{"type":"user",...}` message to stdin WHILE a turn is
 * still generating does NOT redirect that in-flight turn — it QUEUES as a
 * separate, subsequent turn, processed only after the first one reaches
 * its own `result`. This is genuinely useful for `followUp()` (a new turn
 * "after [the session] has gone idle" — exactly the queued-after-result
 * case), but it is not what `Session.steer`'s "inject steering text into a
 * running turn (mid-stream)" contract promises. `capabilities().steer` is
 * therefore `false`, and `steer()` throws rather than silently behaving
 * like a queued follow-up under a name that implies live redirection.
 */
export declare class ClaudeAdapter implements RuntimeAdapter {
    private readonly options;
    readonly descriptor: import("..").RuntimeAdapterDescriptor;
    constructor(options?: ClaudeAdapterOptions);
    detect(): Promise<RuntimeDetectResult>;
    prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
    private startPrepared;
    /**
     * `claude auth status --json` is claude's OWN non-secret login-state
     * signal (see the credential-isolation rule on `RuntimeAdapter` in
     * `../../types.ts`) — empirically confirmed live on this logged-in
     * machine to report `{"loggedIn":true,"authMethod":"claude.ai",
     * "apiProvider":"firstParty","email":"...","orgId":"...","orgName":"...",
     * "subscriptionType":"max"}`, with no token/key material anywhere in it.
     * This spawns the binary and parses ONLY its own reported status — it
     * never reads `~/.claude` or any credential file itself, matching pi's
     * `authPresent` computation being limited to environment-variable
     * *names* (`../pi/pi-adapter.ts`'s `KNOWN_PROVIDER_ENV_VARS`), just via
     * claude's own equivalent non-secret probe instead (claude's auth is
     * OAuth-session-based via `claude auth login`, not primarily an env var,
     * so pi's env-var-presence approach doesn't apply here the same way).
     * A failed/unparseable probe (binary present but not logged in, a future
     * claude release changing this output shape, etc.) fails closed to
     * `false` — this never affects `present`, which is solely about whether
     * `--version` itself succeeded.
     */
    private probeAuthPresent;
    private resolveBin;
}
// ==== @byok-sdk/client dist/adapters/claude/events.d.ts ====
import type { AgentEvent } from '@byok-sdk/protocol';
import { RuntimeExecutionFailure } from '../../runtime-failure';
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
export declare function createToolUseCorrelation(): ToolUseCorrelation;
export interface MapClaudeMessageOptions {
    /** `ctx.workspaceDir` for the task — used only to compute a workspace-relative `name` for a possible `artifact` AgentEvent (see `tryBuildArtifactEvent`'s doc comment). */
    workspaceDir: string;
}
export interface MapClaudeMessageResult {
    events: AgentEvent[];
    /** Present only when this frame is authoritative terminal failure evidence. */
    terminalFailure?: RuntimeExecutionFailure;
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
export declare const ROUTINE_CLAUDE_SYSTEM_SUBTYPES: ReadonlySet<string>;
/**
 * Map one raw claude stream-json line to zero or more normalized
 * `AgentEvent`s (a single `user` frame can produce two: `tool_result` plus
 * a derived `artifact`). See the per-`type` mapping functions above for the
 * concrete, empirically-captured shapes each branch handles.
 */
export declare function mapClaudeMessageToAgentEvents(msg: ClaudeStreamMessage, correlation: ToolUseCorrelation, options: MapClaudeMessageOptions): MapClaudeMessageResult;
// ==== @byok-sdk/client dist/adapters/claude/process-client.d.ts ====
import { spawn } from 'node:child_process';
import type { ClaudeStreamMessage } from './events';
export type SpawnFn = typeof spawn;
export interface ClaudeProcessClientOptions {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    spawnFn?: SpawnFn;
    /**
     * DI seam scoped to ADOPTION only (`../process-tree.ts`'s
     * `adoptOwnedProcessTree`), so the win32 job-object branch is exercisable
     * from POSIX. Disposal keeps `process.platform` as its own authority — this
     * must never silently reroute the taskkill sweep on a real host.
     */
    platform?: NodeJS.Platform;
    /** DI seam for the win32 job-object backstop; see `../win32-job-object.ts`. */
    jobObject?: {
        assign(pid: number): Promise<void>;
    };
}
/**
 * NDJSON process transport for `claude -p --input-format stream-json
 * --output-format stream-json`.
 *
 * Structurally simpler than pi's `PiRpcClient` in one real way, and
 * different (not simpler) in another:
 *
 * - No request/response correlation. pi's RPC mode replies to each command
 *   with a `{type:"response", id, success, ...}` — claude's stream-json has
 *   no such acknowledgement at all; writing a `{"type":"user",...}` line
 *   just starts (or queues) a turn, and the ONLY confirmation is the
 *   ordinary event stream itself (starting with a `system/init` frame).
 *   There is therefore no `pending` id->resolver map here.
 * - `waitForInit()` exists specifically to compensate for that missing
 *   ack: pi's `start()` fails fast because a bad flag/auth error rejects
 *   the pending `send()` promise for the first command. Claude's own
 *   `AsyncQueue.end()` (used for the `events` stream) is a CLEAN,
 *   non-throwing end — a process that crashes before ever emitting a line
 *   would otherwise look, from the async-iteration protocol alone, exactly
 *   like a session that legitimately produced zero events, silently
 *   swallowing the real failure. `waitForInit()` is a dedicated promise
 *   that resolves with the real `session_id` once claude's own
 *   `system/init` frame arrives, or rejects with the same enriched
 *   exit-error `events` would otherwise swallow — this is what lets
 *   `ClaudeAdapter.start()` fail loudly and immediately for a bad
 *   `--resume` target etc., mirroring pi's own fail-fast contract with a
 *   mechanism suited to claude's ack-less protocol instead of copying pi's
 *   request/response one verbatim.
 *
 * Framing, stderr-ring, and unmapped-frame-tally-in-exit-error all mirror
 * `../pi/rpc-client.ts`'s already-proven design directly (LF-delimited
 * JSONL, `node:readline` avoided for the same U+2028/U+2029 reason pi's
 * doc comment explains, `close` not `exit` for the same complete-stderr
 * guarantee) — these are generic, sound patterns, not pi-specific logic,
 * so re-implementing them independently here (rather than importing from
 * `../pi/`) keeps this adapter fully self-contained, matching this repo's
 * existing per-adapter isolation.
 */
export declare class ClaudeProcessClient {
    private readonly child;
    private buffer;
    private readonly eventQueue;
    private closed;
    private exitError;
    private readonly closedPromise;
    private resolveClosed;
    private disposalAttempt;
    /** Resolves once this tree is backstopped (see `adoptOwnedProcessTree`); rejects with the adoption failure, having already terminated the tree. */
    private readonly adopted;
    /** Set before the fail-closed termination starts, so it — not the exit code of the kill we ourselves requested — becomes this client's exit error. */
    private adoptionFailure;
    private readonly stderrRing;
    private readonly unmappedFrameCounts;
    private sessionId;
    private initWaiter;
    constructor(options: ClaudeProcessClientOptions);
    /**
     * Write a new user turn onto stdin (`--input-format stream-json`'s wire
     * shape: `{"type":"user","message":{"role":"user","content":[{"type":
     * "text","text":...}]}}`). Used identically for the very first turn
     * (`ClaudeAdapter.start()`) and any later same-session turn
     * (`ClaudeSession.followUp()`) — empirically confirmed live that claude
     * keeps a `--input-format stream-json` process alive across multiple
     * sequential turns on ONE persistent process/session (same `session_id`
     * reported on each turn's own `system/init` and `result` frames), only
     * exiting when stdin is closed or the process is killed. This is the
     * mechanism `followUp()` relies on instead of spawning a fresh
     * `--resume`'d process per follow-up.
     */
    writeUserMessage(text: string): void;
    /**
     * Resolves with claude's own `session_id` once its `system/init` frame
     * arrives (see this class's doc comment for why this exists at all).
     * Idempotent: once resolved, further calls resolve immediately with the
     * same id; if the process already closed before init ever arrived,
     * every call rejects with that same exit error.
     */
    waitForInit(): Promise<string>;
    /** Every parsed stream-json line — `system/init` is consumed internally (see `waitForInit`) but is also forwarded here like any other frame, so routine-frame accounting in `ClaudeSession`'s mapper stays uniform. */
    get events(): AsyncIterable<ClaudeStreamMessage>;
    /** Local transport diagnostic retained when the process closes; consumers classify it at the session boundary. */
    get terminalError(): Error | undefined;
    /**
     * Record a claude stream-json frame/subtype/content-block label that
     * `ClaudeSession`'s event iterator (`../claude-adapter.ts`) decided has
     * no `AgentEvent` mapping and isn't routine bookkeeping (see
     * `events.ts`'s `MapClaudeMessageResult.unmappedLabel` doc comment) —
     * i.e. genuinely unexpected traffic. Mirrors pi's
     * `PiRpcClient.recordUnmappedFrame` exactly: logs once per distinct
     * label, folds the running tally into a later exit error for a
     * post-mortem without separate log scraping.
     */
    recordUnmappedFrame(label: string): void;
    /**
     * Immediate process-tree termination request. `dispose()` is the settlement
     * receipt, so this stays fire-and-forget: an interrupt must not block on a
     * terminator. A request that could not be spawned is left unrecorded, so
     * `dispose()` re-issues it and raises the typed `stage:'signal'` failure —
     * swallowing it here loses nothing.
     */
    kill(): void;
    waitClosed(): Promise<void>;
    dispose(): Promise<void>;
    private processTreeOptions;
    /**
     * Backstop this tree, or tear it down. Adoption failure is a start-time
     * precondition, not a degraded mode: the child is terminated through the one
     * disposal authority and the failure is re-thrown, which is what makes
     * `waitForInit()` — and therefore `ClaudeAdapter.start()` — fail before any
     * session is published. Both cleanup attempts are best-effort because the
     * adoption failure, not a terminator's own complaint, is the reason to report.
     */
    private adoptOwnedTree;
    private onData;
    private onLine;
    private onStderr;
    /** Mirrors pi's `buildExitError` exactly — stderr tail + unmapped-frame tally folded into one self-diagnosing message. */
    private buildExitError;
    private onClosed;
}
// ==== @byok-sdk/client dist/adapters/claude/resolve-approval-mcp-bin.d.ts ====
import { type SdkHelperHostConfig } from '../../sdk-reserved-helper-host';
export interface ResolvedApprovalMcpBin {
    command: string;
    args: string[];
    source: 'env' | 'dist' | 'host';
}
/**
 * Resolve `byok-approval-mcp` — the small stdio MCP server
 * (`bin/byok-approval-mcp.ts`) `claude`'s own `--permission-prompt-tool`
 * spawns as ITS child process (see that file's doc comment, and
 * `permission-mapping.ts`'s `confirm`-mode doc comment, for the full design).
 *
 * Unlike `resolveClaudeBin` (the end user's own separately-installed,
 * separately-authenticated CLI, resolved via bare-name PATH lookup),
 * `byok-approval-mcp` is a script THIS SAME `@byok-sdk/client` package ships —
 * bare-name PATH lookup is NOT safe for it: `@byok-sdk/client` is typically a
 * project-local dependency, so its `node_modules/.bin/byok-approval-mcp`
 * symlink is only on PATH for processes that inherit THAT project's own
 * shell/PATH, not reliably for a background OS service (launchd/systemd
 * often run with a stripped-down PATH that omits project-local
 * `node_modules/.bin` entirely — see `templates/service/**`). Resolving an
 * ABSOLUTE path to this package's own compiled bin avoids depending on PATH
 * at all.
 *
 * `BYOK_APPROVAL_MCP_BIN` overrides everything when set — the injectable
 * seam for tests (mirrors `BYOK_CLAUDE_BIN`/`BYOK_PI_BIN`), letting a test
 * substitute a fixture script instead of computing any real path. The
 * override is a single command string with no separate args (tests don't
 * need to invoke it any differently than `node <script>`); the real default
 * below is `node <absolute-path-to-the-built-bin>`.
 *
 * The default computation is deliberately anchored to THIS module's own
 * `import.meta.url`, resolved once at the real production entry point: when
 * `@byok-sdk/client` is built (`tsup.config.ts`), this file's code ends up
 * bundled into `dist/index.js` at the package root, with `dist/bin/
 * byok-approval-mcp.js` as its direct sibling (same layout `byok-agent.js`
 * already uses) — `path.join(path.dirname(fileURLToPath(import.meta.url)),
 * 'bin', 'byok-approval-mcp.js')` is therefore correct for that one real
 * shape. It is NOT correct for this file's own unbundled TypeScript source
 * location (`src/adapters/claude/` is two directories deeper than `src/`),
 * but nothing in this codebase ever reaches this fallback unbundled — every
 * test that exercises `confirm` mode sets `BYOK_APPROVAL_MCP_BIN` explicitly
 * (see `claude-adapter.test.ts`), exactly like `BYOK_CLAUDE_BIN` already
 * does for the real `claude` binary.
 */
export declare function resolveApprovalMcpBin(host?: SdkHelperHostConfig): ResolvedApprovalMcpBin;
// ==== @byok-sdk/client dist/adapters/claude/resolve-bin.d.ts ====
export interface ResolvedBin {
    command: string;
    source: 'env' | 'path';
}
/**
 * Resolve the `claude` (Claude Code) CLI executable.
 *
 * Unlike pi (`../pi/resolve-bin.ts`), this package does NOT bundle a
 * matched `claude` build as a dependency. Claude Code is the end
 * user's own globally-installed, individually-authenticated CLI (`claude
 * auth login`, tied to their Anthropic/claude.ai account) — there is
 * nothing useful to vendor: a bundled copy could never carry the user's own
 * login state, and the credential-isolation rule (see `../../types.ts`'s
 * `RuntimeAdapter` doc comment — this adapter must never read, proxy, or
 * forward `~/.claude`'s own auth storage) means this adapter has no
 * business managing a claude install at all, only spawning whatever `claude`
 * the user already has authenticated on their PATH.
 *
 * Resolution is therefore deliberately two-tier, not three like pi's:
 * `BYOK_CLAUDE_BIN` overrides everything when set (the injectable seam for
 * in-process tests — mirrors `BYOK_PI_BIN` and substitutes the
 * `fake-claude.mjs` fixture ahead of a real claude install, exactly as pi's
 * own override does), otherwise this falls back to the literal command name
 * `claude`, resolved via the child process's own PATH lookup — there is no
 * package-resolution tier in between.
 */
export declare function resolveClaudeBin(): ResolvedBin;
// ==== @byok-sdk/client dist/adapters/codex/codex-adapter.d.ts ====
import { type SdkHelperHostConfig } from '../../sdk-reserved-helper-host';
import { type RuntimeAdapter, type RuntimeDetectResult, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult } from '../../types';
import { type ResolvedBin } from './resolve-bin';
import { type SpawnFn } from './process-runner';
export interface CodexAdapterOptions {
    sdkHelperHost?: SdkHelperHostConfig;
    /** Override bin resolution — tests substitute the fake-codex fixture script. */
    resolveBin?: () => ResolvedBin;
    /** Override process spawning — tests substitute a fake spawn. */
    spawnFn?: SpawnFn;
}
/**
 * `RuntimeAdapter` for the OpenAI Codex CLI (`codex exec --json`), the M2-b
 * counterpart to `../pi/pi-adapter.ts`. Every empirical claim in this file
 * and its sibling modules (`events.ts`, `permission-mapping.ts`,
 * `process-runner.ts`) was driven live against the real installed `codex-cli
 * 0.144.5` in a scratch directory before being encoded — repeating the pi
 * adapter's own M0-3 discipline ("docs lied and shipped a nonexistent flag")
 * independently found the exact same bug class on codex:
 *
 *   - `codex exec --help` documents `-a`/`--ask-for-approval`; the real
 *     parser rejects it outright on `codex exec` ("unexpected argument").
 *   - `-s`/`--sandbox` works on a fresh `codex exec` but is rejected outright
 *     on `codex exec resume` (whose own --help correctly omits it).
 *   - `codex exec resume` does NOT auto-inherit the sandbox mode a session
 *     was originally started with — a read-only-started session's write
 *     SUCCEEDED on a bare resume with no sandbox override re-passed,
 *     silently falling back to this machine's own ambient config default.
 *   - This task's own brief assumed SIGINT for `interrupt()`; empirically,
 *     `codex exec` ignores SIGINT entirely (a 60s `sleep` ran to completion
 *     despite SIGINT at t=4s) — SIGTERM is used instead (confirmed to work:
 *     immediate exit, no orphaned children, thread stays resumable after).
 *
 * See `./permission-mapping.ts` and `./process-runner.ts` for the full
 * per-finding writeups (sandbox scope, network, approval model, resume
 * mechanics, stdin handling).
 *
 * Architecture, and how it differs from pi: pi is one long-lived `pi --mode
 * rpc` process for a whole session's lifetime, driven by a bidirectional
 * JSONL request/response protocol (`../pi/rpc-client.ts`). `codex exec` has
 * no such thing — it's a one-shot batch process per turn, prompt in via
 * argv, JSONL out via stdout, process exits. `CodexSession` here instead
 * spawns a fresh `CodexProcessRunner` for every turn (the initial `start()`
 * and every later `followUp()`), and forwards each one's mapped events into
 * one shared, session-lifetime `AsyncQueue` — the thing `Session.events`
 * actually exposes. `sessionRef` is codex's own `thread_id`, learned from
 * `thread.started`, which is reliably the first JSONL line codex ever prints
 * (confirmed across every empirical capture, fresh starts and resumes
 * alike) — `runCodexTurn` below awaits specifically for that line before
 * resolving, mirroring pi's own "resolve a real session id before
 * constructing the Session, fail closed if you can't" discipline
 * (`../pi/pi-adapter.ts`'s `resolveFreshSessionId`, finding F8).
 */
export declare class CodexAdapter implements RuntimeAdapter {
    private readonly options;
    readonly descriptor: import("..").RuntimeAdapterDescriptor;
    constructor(options?: CodexAdapterOptions);
    detect(): Promise<RuntimeDetectResult>;
    /**
     * `authPresent` without ever reading `~/.codex/auth.json` (credential-
     * isolation rule, `../../types.ts`): spawns codex's OWN `login status`
     * subcommand and interprets its human-readable report — the exact
     * "non-secret signal" this adapter is required to use, and cleaner than
     * pi's env-var-name check since codex's real credential model (on the
     * reference machine) is a ChatGPT OAuth session, not an env var.
     *
     * Two independently-verified channel gotchas apply here, the "pi lesson"
     * yet again:
     *   - `codex login status`'s human-readable "Logged in using ChatGPT"
     *     message prints on STDERR, not stdout — both streams are checked
     *     here for exactly that reason. pi's `--version` is the same class of
     *     hazard from the other direction: its channel has moved between pi
     *     releases (see ../pi/pi-adapter.ts), so neither stream is assumed.
     *   - The NOT-logged-in message/exit-code shape was deliberately never
     *     empirically tested: this machine has a real, live ChatGPT login, and
     *     running `codex logout` to observe the negative case would have
     *     broken that login for the rest of this session/machine. The match
     *     below is intentionally conservative (`/logged in (using|with)/i`,
     *     not a bare `"logged in"` substring) specifically because a bare
     *     substring check would false-positive on a plausible negative message
     *     like "Not logged in" (itself containing the substring "logged in").
     *     This is a documented, known gap — flagged for M2-c / a follow-up
     *     empirical pass on a logged-out machine, not asserted as verified.
     */
    private probeAuthPresent;
    prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
    private startPrepared;
    private resolveBin;
}
// ==== @byok-sdk/client dist/adapters/codex/process-runner.d.ts ====
import { RuntimeExecutionFailure } from '../../runtime-failure';
import { spawn } from 'node:child_process';
export type SpawnFn = typeof spawn;
/**
 * One parsed line of `codex exec --json` / `codex exec resume --json`
 * output. Field shapes vary by `type` (see `./events.ts`'s module doc
 * comment for the empirically-captured catalog), so this stays a loose bag
 * rather than a full discriminated union, mirroring `PiRpcMessage` in
 * `../pi/rpc-client.ts`.
 */
export interface CodexRawEvent {
    type: string;
    [key: string]: unknown;
}
export interface CodexProcessOptions {
    command: string;
    args: string[];
    instruction?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    spawnFn?: SpawnFn;
    /** Called once per parsed JSONL line, in arrival order. */
    onEvent: (evt: CodexRawEvent) => void;
    onFailure?: (error: RuntimeExecutionFailure) => void;
    /**
     * DI seam scoped to ADOPTION only (`../process-tree.ts`'s
     * `adoptOwnedProcessTree`), so the win32 job-object branch is exercisable
     * from POSIX. Disposal keeps `process.platform` as its own authority — this
     * must never silently reroute the taskkill sweep on a real host.
     */
    platform?: NodeJS.Platform;
    /** DI seam for the win32 job-object backstop; see `../win32-job-object.ts`. */
    jobObject?: {
        assign(pid: number): Promise<void>;
    };
}
export declare const CODEX_MAX_FRAME_BYTES: number;
export declare const CODEX_MAX_DEFERRED_BYTES: number;
export declare const CODEX_MAX_STDERR_BYTES: number;
/**
 * Spawns and streams ONE `codex exec` / `codex exec resume` invocation — i.e.
 * exactly one turn.
 *
 * Unlike pi (a single long-lived RPC server process for a whole session's
 * lifetime — see `../pi/rpc-client.ts`), `codex exec` is a one-shot batch
 * process per turn with no persistent request/response channel: it takes its
 * prompt from stdin with the documented `-` positional, streams JSONL to stdout for the one turn
 * it's running, and exits. `../codex-adapter.ts`'s `CodexSession` constructs
 * a fresh `CodexProcessRunner` for every turn (the initial `start()` and
 * every later `followUp()`), forwarding each one's lines into the same
 * long-lived event queue.
 *
 * Prompt stdin is closed with EOF immediately after writing. This is a one-shot
 * input channel; steer and approvals are not multiplexed over it.
 */
export declare class CodexProcessRunner {
    private readonly child;
    private readonly onEvent;
    private readonly frameChunks;
    private frameBytes;
    private deferredBytes;
    private stderrBytes;
    private transportFailure;
    private readonly onFailure;
    private readonly stderrRing;
    private closed;
    private exitCode;
    private exitSignal;
    private readonly closedPromise;
    private resolveClosed;
    private disposalAttempt;
    /** Resolves once this tree is backstopped (see `adoptOwnedProcessTree`); rejects with the adoption failure, having already terminated the tree. */
    private readonly adopted;
    /** Set before the fail-closed termination starts; `buildExitError` reports it instead of the exit status of the kill we ourselves requested. */
    private adoptionFailure;
    private adoption;
    /**
     * Lines parsed before adoption settled. Unlike pi and claude, this runner has
     * no first awaited operation of its own to gate on — its caller reads the
     * FIRST event as the authoritative thread id. Holding events until the tree
     * is backstopped is what keeps that caller from publishing a session for a
     * tree the job object never took.
     */
    private readonly deferredEvents;
    constructor(options: CodexProcessOptions);
    private finishClosing;
    /** Resolves once the child process has fully exited (both exit and stdio-flush guaranteed — see the `close` listener above). Never rejects. */
    waitClosed(): Promise<void>;
    get isClosed(): boolean;
    /**
     * Immediate tree termination request. SIGTERM on POSIX: SIGINT was empirically confirmed
     * to be silently ignored by `codex exec` (a real, direct test — a 60s
     * shell `sleep` ran to full, unaffected completion despite SIGINT sent at
     * t=4s) — a genuine, evidence-based correction to this task's own initial
     * assumption ("interrupt: SIGINT — POSIX here"). SIGTERM was separately
     * confirmed to terminate the process immediately (exit code 143) with no
     * orphaned child processes left behind (the shell command it was running
     * died with it), and — critically — the underlying codex thread remained
     * cleanly resumable afterward via `codex exec resume` (no corruption from
     * killing mid-turn). `taskkill /T /F` on Windows, mirroring
     * `../pi/rpc-client.ts`'s own cross-platform convention.
     *
     * Fire-and-forget by design: an interrupt must not block on a terminator,
     * and `dispose()` is the settlement receipt. A request that could not be
     * spawned is left unrecorded, so `dispose()` re-issues it and raises the
     * typed `stage:'signal'` failure — swallowing it here loses nothing.
     */
    kill(): void;
    dispose(): Promise<void>;
    private processTreeOptions;
    /**
     * Backstop this tree, or tear it down. Adoption failure is a start-time
     * precondition, not a degraded mode: the child is terminated through the one
     * disposal authority, every parsed line is dropped instead of delivered, and
     * the resulting close makes the caller's own `waitClosed()` race reject with
     * the adoption failure (`buildExitError`) before a thread id is published.
     * Both cleanup attempts are best-effort because the adoption failure, not a
     * terminator's own complaint, is the reason to report.
     */
    private adoptOwnedTree;
    /** Arrival-order delivery, held back until the tree is backstopped (see `deferredEvents`). */
    private deliver;
    /**
     * Builds a descriptive error folding in the exit code/signal and the stderr
     * tail — mirrors `PiRpcClient.buildExitError`'s reasoning: a post-mortem on a
     * failed start/resume should never need separately re-running codex by hand
     * with a raw JSONL logger to learn why.
     *
     * A tree this runner could not backstop is the one exception: that process
     * exited because THIS runner killed it, so `exit code=null, signal=SIGKILL`
     * plus an empty stderr tail would bury the only reason anyone can act on.
     */
    buildExitError(context: string): Error;
    private failTransport;
    private onData;
    private parseLine;
    private onStderr;
}
// ==== @byok-sdk/client dist/adapters/codex/resolve-bin.d.ts ====
export interface ResolvedBin {
    command: string;
    source: 'env' | 'path';
}
/**
 * Resolve the codex CLI executable.
 *
 * Like pi and Claude Code, the real OpenAI Codex CLI (empirically `codex-cli
 * 0.144.5` on the machine this adapter was built/verified against, installed
 * at a plain PATH location — not inside this repo's `node_modules`) is not
 * published as an npm package this SDK could sensibly depend on: it's a
 * standalone global install (native installer / `npm i -g @openai/codex` /
 * homebrew, depending on platform and version). There is no package-relative
 * resolution to attempt: use an explicit override for tests, else a bare
 * PATH lookup.
 *
 * `BYOK_CODEX_BIN` overrides PATH lookup — substituting the fake-codex test
 * fixture, exactly like `BYOK_PI_BIN` does for pi. The `byok-agent` CLI bin
 * only ever constructs `new CodexAdapter()` with no options (mirroring
 * `createDaemon`'s pi wiring), so an out-of-process substitution (e.g. a
 * future e2e harness swapping in a fake binary ahead of a real codex install)
 * has no other seam to use.
 */
export declare function resolveCodexBin(): ResolvedBin;
// ==== @byok-sdk/client dist/adapters/index.d.ts ====
export type { RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeAdapterRejectedOperation, RuntimeAdapterPreparedOperation, PreparedRuntimeOperation, RuntimeOperationManifest, RuntimeOperationStartInput, RuntimeCapabilities, RuntimeDetectResult, } from '../types';
export type { RuntimeEnvironmentRequirements } from '../daemon/environment';
export { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
export type { RuntimeDisposalFailureInput, RuntimeDisposalStage, RuntimeExecutionFailureInput, RuntimeFailureCategory, RuntimeFailurePhase, RuntimeRetryDisposition, } from '../runtime-failure';
export { PiAdapter } from './pi/pi-adapter';
export type { PiAdapterOptions, PiByokLauncherConfig } from './pi/pi-adapter';
export { PI_PACKAGE_NAME } from './pi/resolve-bin';
export { ClaudeAdapter } from './claude/claude-adapter';
export type { ClaudeAdapterOptions } from './claude/claude-adapter';
export { CodexAdapter } from './codex/codex-adapter';
export type { CodexAdapterOptions } from './codex/codex-adapter';
// ==== @byok-sdk/client dist/adapters/pi/pi-adapter.d.ts ====
import type { RuntimeInstallationObservationContext } from '../../types';
import type { ProviderProfileBinding } from '@byok-sdk/protocol';
import { type RuntimeAdapter, type RuntimeDetectResult, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult } from '../../types';
import { type ResolvedBin } from './resolve-bin';
import { type SpawnFn } from './rpc-client';
/**
 * Known provider credential env var *names* (never values) — see the
 * credential-isolation rule on `RuntimeAdapter`. `detect()` only checks
 * whether one of these names is set; it never reads pi's own auth storage
 * (`~/.pi/...`) or any file contents. Not exhaustive (pi supports ~30
 * providers); covers the common ones for a useful `authPresent` signal.
 */
export interface PiAdapterOptions {
    /** Override bin resolution — tests substitute the fake-pi fixture script. */
    resolveBin?: () => ResolvedBin;
    /** Override process spawning — tests substitute a fake spawn. */
    spawnFn?: SpawnFn;
    /**
     * Separate-process BYOK credential boundary. The launcher receives only
     * non-secret selection/config paths, resolves the OS credential itself,
     * and transparently proxies the pinned Pi RPC process.
     */
    byokLauncher?: PiByokLauncherConfig;
    /** Admission-time exact local profile check. Tests may replace the process boundary. */
    validateProviderProfileBinding?: (binding: ProviderProfileBinding, launcher: PiByokLauncherConfig) => Promise<void>;
}
export interface PiByokLauncherConfig {
    command: string;
    /** Optional fixed launcher arguments, before BYOK's required arguments. */
    args?: string[];
    profileDbPath: string;
    sessionDir: string;
    macosKeychainPath?: string;
    secretServicePrefix?: string;
}
export declare function validatePiByokLauncherConfig(launcher: PiByokLauncherConfig | undefined): void;
export declare class PiAdapter implements RuntimeAdapter {
    private readonly options;
    readonly descriptor: import("..").RuntimeAdapterDescriptor;
    constructor(options?: PiAdapterOptions);
    detectInstallation(context: RuntimeInstallationObservationContext, signal?: AbortSignal): Promise<RuntimeDetectResult>;
    detect(): Promise<RuntimeDetectResult>;
    prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
    private resolveBin;
}
// ==== @byok-sdk/client dist/adapters/pi/resolve-bin.d.ts ====
/**
 * The module specifier every Pi import and resolution in this package uses.
 *
 * IMPORTANT (empirically verified 2026-07-16, see the M0-3 report): the name
 * `@mariozechner/pi` — the identifier this task was originally briefed with —
 * is NOT the coding agent. On npm it resolves to an unrelated "CLI tool for
 * managing vLLM deployments on GPU pods" (bin: `pi-pods`). The real coding
 * agent was `@mariozechner/pi-coding-agent`, which is now deprecated in
 * favor of this package. pi is a core BYOK capability, not an optional
 * enhancement or an unversioned global executable.
 *
 * This constant is the *resolution specifier* only. The *installed identity*
 * behind it is a separate fact: `packages/client/package.json` pins this
 * specifier to an exact npm alias (`npm:<name>@<x.y.z>`), because the SDK ships
 * a fork of the upstream runtime. The specifier and the on-disk path stay
 * `@earendil-works/pi-coding-agent`, so every import site and every extension
 * path is unchanged; only the manifest inside that directory carries the fork's
 * own name and version. `resolvePiRuntimeIdentity()` derives that identity from
 * the same manifest entry, so there is exactly one authority for both.
 */
export declare const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export interface ResolvedBin {
    command: string;
    source: 'package' | 'env';
}
/** The exact package `PI_PACKAGE_NAME` must resolve to on disk. */
export interface PiRuntimeIdentity {
    /** Manifest `name` of the installed runtime (the fork's own scope). */
    readonly name: string;
    /** Manifest `version` of the installed runtime. */
    readonly version: string;
}
/**
 * Read the exact Pi runtime identity this build of `@byok-sdk/client` pins,
 * from the one place that declares it: the client's own manifest dependency on
 * `PI_PACKAGE_NAME`.
 */
export declare function resolvePiRuntimeIdentity(): PiRuntimeIdentity;
/**
 * Resolve the pi CLI executable from the required package installed alongside
 * `@byok-sdk/client`. There is intentionally no automatic PATH fallback: a
 * global `pi` would create a second, unversioned authority for this contract.
 *
 * `BYOK_PI_BIN` explicitly overrides the package when set: `PiAdapterOptions.resolveBin`
 * is the injectable seam for in-process tests, but the `byok-agent` CLI bin
 * only ever constructs `new PiAdapter()` with no options (see `createDaemon`),
 * so an out-of-process substitution (e.g. examples/basic's e2e run swapping
 * in the fake-pi fixture, or a single-file product injecting its required
 * Node 22.22+ pi sidecar) has no other seam to use.
 *
 * Deliberately does NOT use `createRequire(...).resolve()`: this package is
 * pure ESM with no `require` export condition (`exports["."]` only offers
 * `import`), so CJS-style resolution fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. It also does NOT resolve the
 * `./package.json` subpath directly (also not exported); instead it resolves
 * the package's main entry via `import.meta.resolve` and walks upward to the
 * enclosing package root.
 *
 * That root's manifest name is NOT `PI_PACKAGE_NAME`: the specifier is an npm
 * alias for the SDK's fork, so the installed manifest carries the fork's own
 * name and version. Both are compared against the pin, and a mismatch fails
 * closed instead of launching an unverified runtime.
 */
export declare function resolvePiBin(): ResolvedBin;
// ==== @byok-sdk/client dist/adapters/pi/rpc-client.d.ts ====
import { spawn } from 'node:child_process';
export type SpawnFn = typeof spawn;
/**
 * A pi RPC-mode message: either a `{type:"response", id, success, ...}` reply
 * to a command we sent, or an unsolicited event/extension-UI-request. Field
 * shapes vary by `type` (see docs.md / this task's live probes), so this
 * stays a loose bag rather than a full discriminated union — M0 only needs
 * a handful of fields off of each.
 */
export interface PiRpcMessage {
    type: string;
    id?: string;
    [key: string]: unknown;
}
export interface PiRpcClientOptions {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    spawnFn?: SpawnFn;
    /** Explicit GUI-owned interaction lane; omission retains unattended cancellation. */
    extensionUi?: {
        mode: 'hold';
        onRequest: (request: PiRpcMessage) => void;
    };
    /** Synchronous observation before command receipts resolve, for an owned relay. */
    onFrame?: (frame: PiRpcMessage) => void;
    /**
     * DI seam scoped to ADOPTION only (`../process-tree.ts`'s
     * `adoptOwnedProcessTree`), so the win32 job-object branch is exercisable
     * from POSIX. Disposal keeps `process.platform` as its own authority — this
     * must never silently reroute the taskkill sweep on a real host.
     */
    platform?: NodeJS.Platform;
    /** DI seam for the win32 job-object backstop; see `../win32-job-object.ts`. */
    jobObject?: {
        assign(pid: number): Promise<void>;
    };
}
/**
 * JSONL request/response + event-stream client for `pi --mode rpc`.
 *
 * Framing per pi's own docs/rpc.md: strict JSONL, LF (`\n`) as the only
 * record delimiter (a trailing `\r` is stripped; this deliberately does NOT
 * use `node:readline`, which pi's docs call out as non-compliant because it
 * also splits on U+2028/U+2029 — valid inside JSON strings).
 *
 * Responses are correlated by `id`, never by arrival order: empirically,
 * pi's responses do not preserve request order (an immediate parse-failure
 * response can overtake a slower in-flight command's response).
 */
export declare class PiRpcClient {
    private readonly options;
    private readonly child;
    private buffer;
    private nextId;
    private readonly pending;
    private readonly eventQueue;
    private closed;
    private exitError;
    private readonly closedPromise;
    private resolveClosed;
    private disposalAttempt;
    /** Resolves once this tree is backstopped (see `adoptOwnedProcessTree`); rejects with the adoption failure, having already terminated the tree. */
    private readonly adopted;
    /** Set before the fail-closed termination starts, so it — not the exit code of the kill we ourselves requested — becomes this client's exit error. */
    private adoptionFailure;
    /** Bounded tail of recent stderr lines — pi discarded this entirely before (nothing ever read `child.stderr`), which is exactly why finding #1 (`Error: Unknown option: --session-id`, exit 1) had to be root-caused by hand instead of reading it off a thrown error. See `buildExitError`. */
    private readonly stderrRing;
    /** Count of pi RPC message types `PiSession` (pi-adapter.ts) has told us have no `AgentEvent` mapping and aren't routine bookkeeping — see `recordUnmappedFrame`. */
    private readonly unmappedFrameCounts;
    constructor(options: PiRpcClientOptions);
    /**
     * Send a command, resolved with its correlated `response` message.
     *
     * Adoption is awaited FIRST — this is `PiAdapter.start()`'s first awaited
     * operation, so an unbackstopped tree never receives the initial prompt and
     * never yields a session. The wait costs one settled-promise turn once the
     * tree is adopted; every later command sees it already resolved.
     */
    send(command: Record<string, unknown> & {
        type: string;
        id?: string;
    }): Promise<PiRpcMessage>;
    /** Every non-response, non-`extension_ui_request` line — the latter is answered directly by this client (see `respondToExtensionUiRequest`) and never enqueued. */
    get events(): AsyncIterable<PiRpcMessage>;
    /** Local transport diagnostic retained when the process closes; consumers must classify it explicitly. */
    get terminalError(): Error | undefined;
    /**
     * Record a pi RPC message `type` that `PiSession` (pi-adapter.ts) decided
     * has no `AgentEvent` mapping and isn't routine bookkeeping (see
     * `events.ts`'s `ROUTINE_PI_EVENT_TYPES`) — i.e. genuinely unexpected
     * traffic. Logs once per distinct type (not per occurrence, so a
     * repeating unmapped type can't spam stdout); the running tally is also
     * folded into this client's exit-time error message (`buildExitError`) so
     * a post-mortem on a failed/hung task has it without separate log scraping.
     */
    recordUnmappedFrame(type: string): void;
    /**
     * Immediate process-tree termination request. `dispose()` is the settlement
     * receipt, so this stays fire-and-forget: an interrupt must not block on a
     * terminator. A request that could not be spawned is left unrecorded, so
     * `dispose()` re-issues it and raises the typed `stage:'signal'` failure —
     * swallowing it here loses nothing.
     */
    kill(): void;
    waitClosed(): Promise<void>;
    dispose(): Promise<void>;
    private processTreeOptions;
    /**
     * Backstop this tree, or tear it down. Adoption failure is a start-time
     * precondition, not a degraded mode: the child is terminated through the one
     * disposal authority and the failure is re-thrown, which is what makes the
     * first `send()` — and therefore `PiAdapter.start()` — fail before any
     * session is published. Both cleanup attempts are best-effort because the
     * adoption failure, not a terminator's own complaint, is the reason to report.
     */
    private adoptOwnedTree;
    private onData;
    private onLine;
    /** Write an explicit host-owned response; completion is a transport receipt only. */
    respondExtensionUi(response: {
        id: string;
        cancelled?: true;
        confirmed?: boolean;
        value?: string;
    }): Promise<void>;
    /**
     * Answer pi's extension-UI blocking protocol headlessly (rpc.md's
     * "Extension UI Protocol"). Fail-closed policy, stated explicitly because
     * it's a security-relevant default, not an incidental one: this NEVER
     * approves or picks a value on the caller's behalf — every dialog method
     * (`select`/`confirm`/`input`/`editor`) gets `{cancelled: true}`, the one
     * response shape rpc.md documents as valid for all four uniformly
     * ("Dismiss any dialog method... the extension receives `undefined` (for
     * select/input/editor) or `false` (for confirm)"). An extension asking
     * e.g. `confirm("Delete everything?")` gets a firm decline, never a
     * guessed approval — this adapter has no human in the loop to ask, and
     * silently approving would defeat any extension that uses these dialogs
     * specifically as a permission gate. Fire-and-forget methods
     * (`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`) get no
     * reply at all — sending one would itself violate rpc.md ("Responses are
     * sent for dialog methods only").
     */
    private respondToExtensionUiRequest;
    private onStderr;
    /**
     * finding #1 ("bad flag → instant exit", e.g. the `--session-id`/
     * `--exclude-tools` bugs this task fixes): the daemon used to report only
     * `pi process exited (code=1, signal=null)` — accurate but useless for
     * diagnosing *why* without re-running pi by hand with a raw JSONL logger,
     * exactly as this task's own root-cause investigation had to. Folding in
     * the stderr tail and any unmapped-frame tally makes that self-diagnosing
     * from the thrown error alone.
     */
    private buildExitError;
    private onClosed;
}
// ==== @byok-sdk/client dist/adapters/pi/runtime-descendant-plan.d.ts ====
import { type ImplementationSpawnBindingV1, type RuntimeDescendantEdgeV1, type RuntimeDescendantPolicyV1, type RuntimeEntryV1 } from '@byok-sdk/implementation-identity';
export interface RuntimeDescendantDeclarationV1 {
    readonly descendantPolicy: RuntimeDescendantPolicyV1;
    readonly edges: readonly RuntimeDescendantEdgeV1[];
}
export interface RuntimeDescendantTemplateV1 {
    readonly kind: RuntimeEntryV1;
    readonly template: ImplementationSpawnBindingV1;
    readonly templateDigest: string;
}
export interface RuntimeDescendantPlanV1 {
    readonly format: 'byok.runtime-launch-plan';
    readonly version: 1;
    readonly selfKind: RuntimeEntryV1;
    readonly policy: RuntimeDescendantPolicyV1;
    readonly edges: readonly RuntimeDescendantEdgeV1[];
    readonly templates: readonly RuntimeDescendantTemplateV1[];
}
/** The finite type closure is independent of instance depth/budget admission. */
export declare function requiredRuntimePlanKinds(selfKind: RuntimeEntryV1, policy: RuntimeDescendantPolicyV1, edges: readonly RuntimeDescendantEdgeV1[]): readonly RuntimeEntryV1[];
export declare function runtimeRecordCommonFields<T extends {
    readonly launchArgv: readonly string[];
}>(record: T): Omit<T, 'launchArgv'>;
/** Validate raw template bytes before any V1 parser projection changes member order. */
export declare function parseRuntimeDescendantPlan(value: unknown, selfKind: RuntimeEntryV1, selfBinding: ImplementationSpawnBindingV1, expectedDeclaration?: RuntimeDescendantDeclarationV1): RuntimeDescendantPlanV1 | null;
/** Assemble already measured rows; this helper never resolves or measures Host records. */
export declare function createRuntimeDescendantPlan(selfKind: RuntimeEntryV1, selfBinding: ImplementationSpawnBindingV1, declaration?: RuntimeDescendantDeclarationV1, templates?: readonly Pick<RuntimeDescendantTemplateV1, 'kind' | 'template'>[]): RuntimeDescendantPlanV1 | null;
// ==== @byok-sdk/client dist/adapters/pi/runtime-launch.d.ts ====
import { type ImplementationSpawnBindingV1, type ToolImplementationAuthority, type ResolvedRuntimeImplementationV1 } from '@byok-sdk/implementation-identity';
import { type RuntimeLaunchDecisionV1, type RuntimeLaunchKindV1 } from '../../daemon/tool-implementation-identity';
import { type RuntimeDescendantPlanV1 } from './runtime-descendant-plan';
export interface PiRuntimeLaunchResources {
    readonly kind: RuntimeLaunchKindV1;
    readonly declaration: ResolvedRuntimeImplementationV1;
    readonly decision: RuntimeLaunchDecisionV1;
    readonly binding: ImplementationSpawnBindingV1;
    readonly descendantPlan: RuntimeDescendantPlanV1 | null;
    readonly env: Readonly<Record<string, string>>;
    readonly sessionCwd: string;
    readonly credentialSource: 'pi-auth-store' | 'keys-profile';
    /** A single client-owned cleanup authority, idempotent across declined/start/terminal paths. */
    release(): Promise<void>;
}
export declare function resolvePiRuntimeLaunch(options: {
    authority?: ToolImplementationAuthority;
    kind: RuntimeLaunchKindV1;
    sessionCwd: string;
    env: Readonly<Record<string, string | undefined>>;
    projectionRoot: string;
    keysSessionDir?: string;
    /** Evaluated only after an explicitly unconfigured authority decision. */
    resolveDevInvocation: () => {
        command: string;
        entry?: string;
    };
}): Promise<PiRuntimeLaunchResources>;
// ==== @byok-sdk/client dist/agent-home.d.ts ====
import { type AgentHomeProjectionOutcome, type AgentHomeProjectionPayload, type AgentRef } from '@byok-sdk/protocol';
export type { AgentRef } from '@byok-sdk/protocol';
export declare const AGENT_HOME_DIRECTORY = "agents";
export declare const AGENT_HOME_INTERNAL_DIRECTORY = ".byok";
export declare const AGENT_HOME_PROJECTION_STATE_FILE = "agent-home-projection.json";
export declare class AgentHomeError extends Error {
    constructor(message: string);
}
export declare class AgentRefValidationError extends AgentHomeError {
    constructor(message: string);
}
export declare class AgentHomeResolutionError extends AgentHomeError {
    constructor(message: string);
}
export declare class AgentHomeCollisionError extends AgentHomeResolutionError {
    constructor(message: string);
}
export declare class AgentHomeBusyError extends AgentHomeError {
    constructor(message: string);
}
/** A malformed persisted lease is integrity failure, never retryable contention. */
export declare class AgentHomeLeaseCorruptError extends AgentHomeResolutionError {
    constructor(message: string);
}
export interface AgentHomeResolution {
    readonly agentRef: AgentRef;
    /** Absolute branded storage root supplied by the host, after realpath. */
    readonly hostStorageRoot: string;
    /** SDK-owned `<hostStorageRoot>/agents` authority, after realpath. */
    readonly agentsRoot: string;
    /** Canonical absolute Agent home. This is also the runtime cwd. */
    readonly homeDir: string;
    readonly canonicalHome: string;
}
export interface AgentHomeProjectionInput extends AgentHomeResolution {
    readonly cwd: string;
}
export interface AgentHomeProjectionApplyInput extends AgentHomeProjectionInput {
    readonly requestId: string;
    readonly projectionHash: string;
    readonly projection: unknown;
}
/**
 * Optional downstream projection hook. The SDK supplies the canonical home;
 * the host supplies opaque, redacted product content and never joins
 * `agents/<agentId>` itself. The SDK does not parse the projected content.
 */
export interface AgentHomeProjection {
    /** Optional creation/task-time host preparation retained as a distinct lifecycle. */
    prepare?(input: AgentHomeProjectionInput): void | Promise<void>;
    /**
     * Task-free opaque desired-state consumer. It must atomically and
     * idempotently ensure its own durable bytes because exact revision/hash
     * requests may replay after local derived-file loss or transport failure.
     */
    apply?(input: AgentHomeProjectionApplyInput): void | Promise<void>;
}
export type AgentHomeProjectionFunction = (input: AgentHomeProjectionInput) => void | Promise<void>;
export type AgentHomeProjectionApplyFunction = (input: AgentHomeProjectionApplyInput) => void | Promise<void>;
export interface AgentHomeLease {
    readonly leaseId: string;
    readonly agentRef: AgentRef;
    readonly canonicalHome: string;
    readonly cwd: string;
    /** Filesystem identity captured under the writer lease; task-scoped memory rechecks it before pinning a descriptor. */
    readonly homeIdentity: Readonly<{
        dev: bigint;
        ino: bigint;
    }>;
    release(): Promise<void>;
}
export interface AgentHomeBinding {
    readonly resolution: AgentHomeResolution;
    readonly lease: AgentHomeLease;
}
export interface AgentHomeExecutionLease extends AgentHomeLease {
    /** Fresh tasks are task-keyed until the runtime returns its durable session id. */
    bindSession(sessionRef: string): Promise<void>;
}
export interface AgentHomeExecutionBinding {
    readonly resolution: AgentHomeResolution;
    readonly lease: AgentHomeExecutionLease;
}
export declare function validateAgentRef(value: unknown): AgentRef;
/**
 * SDK-owned deterministic Agent-home layout. The downstream supplies exactly
 * one absolute branded storage root; there is deliberately no host path
 * resolver and no second workspace authority.
 */
export declare class AgentHomeLayout {
    private readonly hostStorageRootInput;
    private readonly agentIdByCanonicalHome;
    private canonicalRoot?;
    constructor(hostStorageRoot: string);
    resolve(agentRefInput: AgentRef): Promise<AgentHomeResolution>;
    /**
     * Pure canonical-home derivation for read-only callers, such as the
     * pre-admission single-writer count. It validates the AgentRef and joins
     * exactly the same `<hostStorageRoot>/agents/<agentId>` segments
     * {@link AgentHomeLayout.resolve} would, canonicalizing only the components
     * that already exist.
     *
     * It deliberately creates no directory, takes no cross-process mutation
     * gate and records no Agent binding, so an offer the host vetoes after the
     * count leaves nothing behind on disk. `resolve()` stays the only path that
     * may materialize a home or bind it to an Agent identity.
     *
     * An `agents` root or `agents/<agentId>` leaf that already exists but is a
     * symlink (or any non-directory) is rejected here with the same error class
     * and message `resolve()` raises for it, so an in-root `two -> one` link
     * fails closed instead of silently keying the count of `one`. A leaf that
     * does not exist yet is not an error: this derivation runs before the home
     * is materialized. A home canonicalizing outside the `agents` root stays
     * rejected as before.
     */
    canonicalHomePath(agentRefInput: AgentRef): Promise<string>;
    /**
     * Prove the canonical root is materializable and writable before the daemon
     * advertises Agent-home capability. No Agent identity or persistent Agent
     * file is created by this preflight.
     */
    preflight(): Promise<void>;
    /**
     * Construction-time validation is deliberately non-mutating. The actual
     * writable preflight runs asynchronously after daemon ownership is acquired
     * and before transport/capability publication, where it can participate in
     * the cross-process relocation gate without a sync shadow lock.
     */
    preflightSync(): void;
    private resolveRoot;
    private acquireRootMutationGate;
}
export declare function stableAgentHomeOwnerId(storeDir: string, productId: string): string;
/** One-writer lease backed by both a process registry and an exclusive marker. */
export declare class AgentHomeLeaseManager {
    private static readonly held;
    private readonly ownerId;
    constructor(options?: {
        ownerId?: string;
    });
    acquire(resolution: AgentHomeResolution): Promise<AgentHomeLease>;
    private openLeaseMarker;
}
/**
 * WP0: counts-only readback of the per-canonical-Agent-home Attempt cap and
 * what one daemon currently holds against it. Deliberately carries no home
 * path, agentId or taskId: it exists so an operator can see that a home is
 * still busy — including the fail-closed case where a failed `Session.close()`
 * keeps the slot held after the task itself is gone — not to enumerate Agents.
 * Projected into both `Daemon.status()` and the authenticated local control
 * status (`create-daemon.ts`).
 */
export interface AgentHomeExecutionStatus {
    /** Effective `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome` for this daemon. */
    maxConcurrentMutableSessionsPerAgentHome: number;
    /** Canonical Agent homes this daemon currently holds at least one execution lease in. */
    activeHomes: number;
    /** Total Attempts holding an execution lease across those homes. */
    activeAttempts: number;
}
/**
 * Session-scoped execution leases share one process-owned home marker. The
 * marker remains until the final session exits, so relocation still sees the
 * Agent home as active, while different sessions no longer exclude each other.
 *
 * This layer counts; it does not cap. How many Attempts may be active in one
 * canonical home is a daemon admission decision made once, before any side
 * effect, by `TaskRunner.handleOffer`'s per-home busy gate reading
 * {@link AgentHomeExecutionLeaseManager.activeAttemptCount} against
 * `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome` (default 1).
 */
export declare class AgentHomeExecutionLeaseManager {
    private readonly manager;
    private static readonly groups;
    private static readonly queues;
    constructor(manager: AgentHomeLeaseManager);
    acquire(resolution: AgentHomeResolution, input: {
        readonly taskId: string;
        readonly sessionRef?: string;
    }): Promise<AgentHomeExecutionLease>;
    /**
     * WP0: Attempts currently holding an execution lease on this exact
     * canonical home, across every lane and every session. This is the number
     * the daemon's admission gate reads before any side effect — see
     * `TaskRunner.handleOffer`'s per-home busy gate.
     *
     * Derived from the one lease registry above rather than a second tally, so
     * it inherits the lease lifecycle exactly: an entry appears at `acquire()`,
     * survives `bindSession()` (which rekeys in place), and disappears only at
     * `release()`, which the task runner calls after the attempt is terminal
     * AND `Session.close()` resolved. A failed disposal never reaches
     * `release()`, so the slot stays held — fail closed, the same posture as
     * `runtime-disposal-failed`. Crash residue needs nothing extra here: a
     * restarted daemon starts with an empty registry and reclaims the on-disk
     * marker only under the same stable owner identity (`openLeaseMarker`).
     *
     * Counted regardless of which lease manager owns the group: the invariant
     * being protected is the filesystem path (`MEMORY.md`, `notes/`, `.git`),
     * not the owner identity.
     */
    activeAttemptCount(canonicalHome: string): number;
    /**
     * Counts-only readback for daemon/control status. Scoped to this manager's
     * own leases, so the number describes this daemon rather than every home
     * any manager in the process happens to hold. Never exposes a home path.
     */
    activeAttemptSummary(): {
        readonly homes: number;
        readonly attempts: number;
    };
    mutate<T>(binding: AgentHomeExecutionBinding, operation: () => Promise<T>): Promise<T>;
    private exclusive;
}
/** Coordinates SDK-owned initialization, optional projection, and the lease. */
export declare class AgentHomeManager {
    readonly layout: AgentHomeLayout;
    readonly projection?: AgentHomeProjection;
    readonly leaseManager: AgentHomeLeaseManager;
    readonly executionLeaseManager: AgentHomeExecutionLeaseManager;
    constructor(options: {
        hostStorageRoot: string;
        projection?: AgentHomeProjection;
        leaseManager?: AgentHomeLeaseManager;
    });
    prepare(agentRef: AgentRef): Promise<AgentHomeBinding>;
    /** Validate the configured root before capability publication. */
    preflight(): Promise<void>;
    /** Synchronous construction-time preflight for strict Agent-only admission. */
    preflightSync(): void;
    /** Resolve and lease without applying downstream projection side effects. */
    acquire(agentRef: AgentRef): Promise<AgentHomeBinding>;
    acquireExecution(agentRef: AgentRef, input: {
        readonly taskId: string;
        readonly sessionRef?: string;
    }): Promise<AgentHomeExecutionBinding>;
    /** Initialize only after any requested session exact-match has succeeded. */
    initialize(binding: AgentHomeBinding): Promise<void>;
    initializeExecution(binding: AgentHomeExecutionBinding): Promise<void>;
    mutateExecution<T>(binding: AgentHomeExecutionBinding, operation: () => Promise<T>): Promise<T>;
    private initializeResolved;
    supportsTaskFreeProjection(): boolean;
    /**
     * Apply one task-free projection under the same canonical-home writer lease
     * used by Agent execution. The host hook owns an atomic/idempotent ensure of
     * its opaque product bytes, so an exact desired-state replay invokes it again
     * before returning `idempotent`. Only a successful new-state hook followed
     * by the SDK-owned fsynced ordering record can return `applied`.
     */
    project(input: AgentHomeProjectionPayload): Promise<AgentHomeProjectionOutcome>;
}
export declare function createAgentHomeProjection(prepare: AgentHomeProjectionFunction): AgentHomeProjection;
/**
 * Create the task-free atomic/idempotent opaque desired-state consumer.
 * Exact revision/hash delivery may invoke it again before an idempotent receipt;
 * no task-time fallback is inferred.
 */
export declare function createAgentHomeProjectionConsumer(apply: AgentHomeProjectionApplyFunction): AgentHomeProjection;
// ==== @byok-sdk/client dist/agent-memory/index.d.ts ====
/**
 * `@byok-sdk/client/agent-memory` — the embedded-host composition surface for
 * Agent memory.
 *
 * A product that embeds this SDK instead of running the daemon (no second
 * control plane, no `control.sock`) already owns the pieces the daemon would
 * otherwise own for it: the canonical Agent home under `AGENT_HOME_DIRECTORY`,
 * the lease that pins it, and the signed/notarized macOS helper binary. What it
 * cannot own is the memory authority itself — the compare-and-swap semantics,
 * the audit record, the platform gate, and the exact path policy the model is
 * allowed to name. Those must stay in one place or two implementations drift.
 *
 * This entry therefore exports exactly the pieces `daemon/task-runner.ts`
 * composes for an in-daemon Agent task, minus the daemon:
 *
 * - `AgentMemoryService`             — task-scoped recall/save authority.
 * - `captureAgentMemorySnapshot`     — the post-close bounded snapshot.
 * - `openAgentMemoryFilesystemHelper`— admission of the host's macOS helper.
 * - `serveAgentMemoryMcpOverStdio`   — the two memory tools over stdio.
 * - `prependAgentMemoryGuidance`     — the prompt half of the path contract.
 *
 * Three things are deliberately absent, and this file is the record of why.
 *
 * 1. The control client. `connectControlClient`/`ControlClient` are not
 *    exported from this package at all (see `src/index.ts`) and must not become
 *    reachable here: they also carry `shutdown`, approval resolution, and the
 *    raw task-event stream. The shipped `byok-agent-memory-mcp` bin reaches the
 *    same service *through* that socket; an embedded host reaches it directly,
 *    which is the entire reason this entry exists.
 *
 * 2. The transport. Nothing reachable from this entry may import `ws`, the
 *    daemon composition, or any transport module. Importing a single memory
 *    symbol from the root entry drags daemon transport into a host
 *    bundle; the subpath exists so it does not. `__tests__/agent-memory-entry-
 *    constraints.test.ts` walks this module graph and `scripts/check-agent-
 *    memory-entry.mjs` re-checks the built bundle.
 *
 * 3. Hosted projection. `AgentMemoryRedactor`, `AgentMemoryProjectionPort`,
 *    `AgentMemoryHostedProjection` and `snapshotAndProjectAgentMemory` stay off
 *    this entry. Projection is a network surface, and a credential-blind
 *    transport for it does not exist yet; an embedded host gets the local
 *    snapshot and nothing that sends it anywhere.
 *
 * Platform semantics are unchanged by this entry, not re-stated in it: Linux
 * uses the native descriptor backend, macOS requires the host's external
 * helper, and Windows stays fail-closed. `isAgentMemorySecureFilesystemAvailable`
 * is the single gate a host consults before offering memory at all.
 */
/** Per-task memory authority: `recall`/`save` under sha256 compare-and-swap, bound to one exact active Agent task context. */
export { AgentMemoryService } from '../daemon/agent-memory';
/** Bounded, audited snapshot of the Agent's local memory files, taken after `Session.close()` while the home lease still exists. */
export { captureAgentMemorySnapshot } from '../daemon/agent-memory';
/** The single source of truth for which relative path a model may name: `MEMORY.md` or `notes/<safe-relative>.md`. */
export { validateAgentMemoryPath } from '../daemon/agent-memory';
/** The sole platform gate for the memory write authority: native Linux, macOS only with the host's helper, Windows never. */
export { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
/** Base failure for every rejected memory operation. */
export { AgentMemoryError } from '../daemon/agent-memory';
/** Compare-and-swap failure carrying the expected and actual content revisions. */
export { AgentMemoryRevisionConflictError } from '../daemon/agent-memory';
/** The exact active-task binding required to construct the service; every field is validated on each call. */
export type { AgentMemoryTaskContext } from '../daemon/agent-memory';
/** One memory file as the snapshot sees it: relative path, sha256 revision, byte count, content. */
export type { AgentMemoryFile } from '../daemon/agent-memory';
/** A bounded set of memory files plus their total byte count. */
export type { AgentMemorySnapshot } from '../daemon/agent-memory';
/** Result of `recall`, including the metadata-only audit warning when the audit write failed but the read did not. */
export type { AgentMemoryRecallResult } from '../daemon/agent-memory';
/** Result of `save`, distinguishing a replace (with new revision) from a delete. */
export type { AgentMemorySaveResult } from '../daemon/agent-memory';
/** Metadata-only signal that the audit record could not be written; the source operation still succeeded. */
export type { AgentMemoryAuditWarning } from '../daemon/agent-memory';
/** Whether this platform can admit an external filesystem helper at all (macOS only today). */
export { isAgentMemoryFilesystemHelperSupported } from '../daemon/agent-memory-fs-helper';
/** Admits the host's absolute signed/notarized helper binary and returns the root-pinned filesystem for one Agent home. */
export { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
/** Root-bound filesystem authority the service operates through; the host supplies it only on macOS. */
export type { AgentMemoryFilesystem } from '../daemon/agent-memory-filesystem';
/** One file's state as reported by that filesystem authority. */
export type { AgentMemoryFilesystemFileState } from '../daemon/agent-memory-filesystem';
/** Product-owned deployment pointer to the helper binary; the SDK never searches PATH. */
export type { AgentMemoryFilesystemHelperConfig } from '../daemon/agent-memory-filesystem';
/** Serves `memory_recall`/`memory_save` as a stdio MCP server over host-provided streams. */
export { serveAgentMemoryMcpOverStdio } from '../bin/agent-memory-mcp-server';
/** MCP tool name a host must allowlist for reads. */
export { AGENT_MEMORY_RECALL_TOOL_NAME } from '../bin/agent-memory-mcp-server';
/** MCP tool name a host must allowlist for writes. */
export { AGENT_MEMORY_SAVE_TOOL_NAME } from '../bin/agent-memory-mcp-server';
/** The two calls the stdio server delegates to; an `AgentMemoryService` satisfies it directly. */
export type { AgentMemoryMcpDeps } from '../bin/agent-memory-mcp-server';
/** Runtime-neutral instructions telling the model how to use `MEMORY.md` and `notes/`. */
export { AGENT_MEMORY_GUIDANCE } from '../daemon/memory-guidance';
/** Prepends that guidance to an Agent instruction, exactly as the daemon's task runner does. */
export { prependAgentMemoryGuidance } from '../daemon/memory-guidance';
/** The validated Agent identity carried by `AgentMemoryTaskContext`. */
export type { AgentRef } from '../agent-home';
// ==== @byok-sdk/client dist/assertion-client/index.d.ts ====
/**
 * `@byok-sdk/client/assertion-client` — the assertion request surface for a
 * sibling local process, without the daemon graph.
 *
 * A Host toolset server is the shape this entry exists for: a short-lived
 * stdio process the daemon spawns for one task, whose entire job is to take the
 * `BYOK_HOST_TOOLSET_CONTEXT` nonce it was started with, ask the running daemon
 * for one short-lived task assertion, and present it to the product's cloud.
 * It never runs a daemon, never drives a coding-agent runtime, and never
 * touches the transport.
 *
 * Importing `requestTaskAssertion` from the package root gave it all three
 * anyway. The root entry composes `createDaemon`, which reaches
 * `@earendil-works/pi-coding-agent` and, through it, `@modelcontextprotocol/sdk`
 * and `ajv` — and the root graph's top-level `@modelcontextprotocol/client`
 * import carries a dist that embeds an `ajv` provider built on `new Function`.
 * A host that runs its toolset servers under a CSP, a locked-down runtime, or
 * any policy that refuses runtime code generation could not use the function it
 * needed because of code it never called.
 *
 * So this entry re-exports exactly the two request functions and their public
 * option/result types from `../daemon/assertion-client`, whose own transitive
 * imports are only `@byok-sdk/core`, `@byok-sdk/protocol`,
 * `../bin/control-client`, `../daemon/control-protocol` and `../daemon/store`
 * (plus `zod` through core's protocol types). Nothing else may be added here.
 *
 * Two things are deliberately absent, and this file is the record of why.
 *
 * 1. The control client. `connectControlClient`/`ControlClient` are not
 *    exported from this package at all (see `src/index.ts` and
 *    `../daemon/assertion-client`'s own doc comment) and must not become
 *    reachable here: the same socket also carries `shutdown`, approval
 *    resolution, and the raw task-event stream. A caller that needs one
 *    capability gets one function.
 *
 * 2. Everything else on the root entry. This is not a second package index.
 *    `__tests__/dist-subpath-closure.test.ts` walks the built bundle and fails
 *    on any import specifier that is not a node builtin, `@byok-sdk/core`,
 *    `@byok-sdk/protocol`, or a relative path, and on any trace of `ajv`,
 *    `pi-coding-agent`, `@modelcontextprotocol/client`, or runtime code
 *    generation.
 *
 * The root entry still exports these two functions and keeps doing so; this
 * entry is a narrower door to the same authority, not a replacement for it.
 */
/** Asks a running daemon for one short-lived task assertion bound to the caller's `BYOK_HOST_TOOLSET_CONTEXT` nonce. */
export { requestTaskAssertion } from '../daemon/assertion-client';
/** Asks a running daemon for one short-lived device assertion scoped to an allowlisted audience. */
export { requestDeviceAssertion } from '../daemon/assertion-client';
/** Everything `requestTaskAssertion` needs: the daemon's `productId`/`storeDir`, the context nonce, the exact audience, and an optional round-trip bound. */
export type { RequestTaskAssertionOptions } from '../daemon/assertion-client';
/** The daemon's nine refusal codes plus `unavailable` and `bad_response`, kept as an open string union so a newer daemon's code surfaces verbatim. */
export type { RequestTaskAssertionErrorCode } from '../daemon/assertion-client';
/** Typed result: a parsed `TaskAssertionEnvelopeV1` with its expiry, or a refusal code and reason. Never throws for an expected outcome. */
export type { RequestTaskAssertionResult } from '../daemon/assertion-client';
/** Everything `requestDeviceAssertion` needs: the daemon's `productId`/`storeDir`, the exact audience, and an optional round-trip bound. */
export type { RequestDeviceAssertionOptions } from '../daemon/assertion-client';
/** The daemon's six refusal codes plus `unavailable` and `bad_response`, kept as an open string union for the same reason. */
export type { RequestDeviceAssertionErrorCode } from '../daemon/assertion-client';
/** Typed result: a parsed `DeviceAssertionEnvelopeV1` with its expiry, or a refusal code and reason. Never throws for an expected outcome. */
export type { RequestDeviceAssertionResult } from '../daemon/assertion-client';
// ==== @byok-sdk/client dist/bin/agent-memory-mcp-server.d.ts ====
import { type McpServerToolCall, type McpServerToolDefinition } from '../mcp-server';
export declare const AGENT_MEMORY_RECALL_TOOL_NAME = "memory_recall";
export declare const AGENT_MEMORY_SAVE_TOOL_NAME = "memory_save";
export interface AgentMemoryMcpDeps {
    recall(input: {
        path: string;
        ifRevision?: string;
    }): Promise<{
        path: string;
        revision: string;
        content: string;
        auditWarning?: {
            code: 'agent_memory_audit_unavailable';
        };
    }>;
    save(input: {
        op: 'replace' | 'delete';
        path: string;
        expectedRevision: string;
        content?: string;
    }): Promise<{
        path: string;
        revision?: string;
        deleted: boolean;
    }>;
}
/** The exact tools this server advertises. The JSON Schema literals are product authority and reach the peer verbatim. */
export declare const AGENT_MEMORY_TOOLS: readonly McpServerToolDefinition[];
/**
 * One `tools/call`, returning the JSON-RPC `result` payload. The path policy,
 * the compare-and-swap contract and the exact accepted argument set stay here;
 * envelope, framing and protocol faults belong to `../mcp-server`.
 */
export declare function handleAgentMemoryToolCall(call: McpServerToolCall, deps: AgentMemoryMcpDeps): Promise<Record<string, unknown>>;
export declare function serveAgentMemoryMcpOverStdio(input: {
    deps: AgentMemoryMcpDeps;
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
}): void;
// ==== @byok-sdk/client dist/bin/team-tmux-view.d.ts ====
export type TmuxRunner = (file: string, args: readonly string[]) => Promise<{
    stdout?: string;
    stderr?: string;
}>;
export declare class TeamTmuxViewError extends Error {
    readonly code: 'unsupported_platform' | 'invalid_tmux_binary' | 'tmux_unavailable';
    constructor(code: 'unsupported_platform' | 'invalid_tmux_binary' | 'tmux_unavailable', message: string);
}
export interface OpenTeamTmuxViewInput {
    tmuxBin: string;
    sessionName: string;
    watcherCommand: string;
    watcherArgs: readonly string[];
    platform?: NodeJS.Platform;
    run?: TmuxRunner;
}
export declare function openTeamTmuxView(input: OpenTeamTmuxViewInput): Promise<{
    sessionName: string;
}>;
// ==== @byok-sdk/client dist/daemon/agent-content-audit-store.d.ts ====
import type { AgentContentAuditReceipt } from './agent-content-read';
/**
 * A durable audit ledger for explicit Agent content reads.
 *
 * This store deliberately knows only the content-free receipt shape. It does
 * not accept a payload, pathname, MIME body, or a caller-supplied extension
 * point. The content-read policy engine is the only component that should
 * produce receipts; keeping the ledger narrow makes accidentally persisting a
 * preview or transcript body a type- and runtime-visible failure.
 */
export declare class AgentContentAuditStoreError extends Error {
    constructor(message: string);
}
/**
 * Append-only, fsynced JSONL receipt store. A new instance can read the same
 * path after a daemon restart; no in-memory cursor is authoritative.
 */
export declare class AgentContentAuditStore {
    /**
     * `agent.content.read` creates a policy engine per envelope. Queue ownership
     * must therefore be keyed by the canonical Agent-home ledger path, not an
     * individual store instance.
     */
    private static readonly queues;
    readonly filePath: string;
    constructor(filePath: string);
    /** The daemon may address this ledger only through an AgentHomeLayout resolution. */
    static forCanonicalAgentHome(canonicalHome: string): AgentContentAuditStore;
    append(receipt: AgentContentAuditReceipt): Promise<AgentContentAuditReceipt>;
    readAll(): Promise<readonly AgentContentAuditReceipt[]>;
    /** Explicit name for restart/readback integrations. */
    readback(): Promise<readonly AgentContentAuditReceipt[]>;
    private readAllUnlocked;
    private enqueue;
}
// ==== @byok-sdk/client dist/daemon/agent-content-read.d.ts ====
import { AgentHomeLayout, type AgentRef } from '../agent-home';
import { AgentContentAuditStore } from './agent-content-audit-store';
export declare const AGENT_CONTENT_READ_SURFACES: readonly ['workspace', 'transcript', 'artifact'];
export type AgentContentReadSurface = (typeof AGENT_CONTENT_READ_SURFACES)[number];
/** Additive capability names. Each surface is independently admitted. */
export declare const AGENT_CONTENT_READ_CAPABILITIES: Readonly<{
    readonly workspace: "agent-content-workspace-read";
    readonly transcript: "agent-content-transcript-read";
    readonly artifact: "agent-content-artifact-read";
}>;
export declare const AGENT_CONTENT_READ_CAPABILITY_WORKSPACE: "agent-content-workspace-read";
export declare const AGENT_CONTENT_READ_CAPABILITY_TRANSCRIPT: "agent-content-transcript-read";
export declare const AGENT_CONTENT_READ_CAPABILITY_ARTIFACT: "agent-content-artifact-read";
export declare const AGENT_CONTENT_READ_DECISIONS: readonly ['allow', 'deny'];
export type AgentContentReadDecision = (typeof AGENT_CONTENT_READ_DECISIONS)[number];
/**
 * Reasons are stable policy observations, not user-facing prose. A denied
 * read has exactly one reason and never returns any bytes.
 */
export declare const AGENT_CONTENT_READ_REASONS: readonly ['invalid-request', 'policy-disabled', 'capability-missing', 'policy-revision-mismatch', 'absolute-target', 'non-relative-target', 'dot-segment', 'sensitive-name', 'root-not-allowlisted', 'root-invalid', 'path-escape', 'target-missing', 'symlink', 'not-regular-file', 'byte-limit', 'mime-not-allowlisted', 'text-not-allowlisted', 'text-decode-failed', 'identity-mismatch'];
export type AgentContentReadReason = (typeof AGENT_CONTENT_READ_REASONS)[number];
export type AgentContentReadDropReason = AgentContentReadReason;
export type AgentContentActorKind = 'user' | 'agent' | 'system';
export interface AgentContentReadActor {
    readonly kind: AgentContentActorKind;
    readonly id: string;
}
/** Exact identity copied from the persisted Agent session handoff. */
export interface AgentContentSessionIdentity {
    readonly agentRef: AgentRef;
    readonly sessionRef: string;
    readonly runtimeId: string;
    readonly cwd: string;
}
export type AgentContentReadRoot = {
    readonly kind: 'agent-home';
} | {
    readonly kind: 'runtime-allowlisted';
    readonly root: string;
};
/** The policy is one authority; no semantic defaults are inferred from a request. */
export interface AgentContentReadPolicy {
    readonly enabled: true;
    readonly capability: string;
    readonly root: AgentContentReadRoot;
    readonly policyRevision: string;
    /** Positive hard limit applied before allocating the file contents. */
    readonly maxBytes: number;
    /** Positive hard limit for an explicitly requested UTF-8 decode. */
    readonly maxTextBytes: number;
    /** Exact MIME strings. Wildcards are not accepted. */
    readonly allowedMimeTypes: readonly string[];
    /** Exact subset of allowedMimeTypes permitted with decodeAs=utf8. */
    readonly textMimeTypes: readonly string[];
    /** Product additions may tighten this list; SDK-reserved names cannot be removed. */
    readonly sensitiveNames?: readonly string[];
    /** Transcript reads must bind to this persisted identity, unless a resolver is supplied. */
    readonly expectedTranscriptIdentity?: AgentContentSessionIdentity;
}
export type AgentContentReadPolicySelection = 'disabled' | AgentContentReadPolicy;
export type ContentReadPolicy = AgentContentReadPolicy;
export interface AgentContentReadRequest {
    readonly requestId: string;
    readonly actor: AgentContentReadActor;
    readonly tenantId: string;
    readonly deviceId: string;
    readonly agentRef: AgentRef;
    readonly surface: AgentContentReadSurface;
    /** Portable, slash-separated relative target. */
    readonly relativeTarget: string;
    /** Caller-declared MIME. No extension or content inference is performed. */
    readonly mimeType: string;
    readonly capability: string;
    readonly policyRevision: string;
    /** Optional narrower request bound; it can never widen policy.maxBytes. */
    readonly maxBytes?: number;
    /** Optional narrower request MIME declaration; it can never widen policy allowlist. */
    readonly allowedMimeTypes?: readonly string[];
    /** Omit for bytes; utf8 is explicit and bounded by maxTextBytes. */
    readonly decodeAs?: 'bytes' | 'utf8';
    /** Required for transcript; optional for workspace/artifact projections. */
    readonly session?: AgentContentSessionIdentity;
}
export interface AgentContentAuditReceipt {
    readonly version: 1;
    readonly requestId: string;
    readonly actor: AgentContentReadActor;
    readonly tenantId: string;
    readonly deviceId: string;
    readonly agentRef: AgentRef;
    readonly surface: AgentContentReadSurface;
    readonly session?: AgentContentSessionIdentity;
    /** Canonical relative target only; no absolute pathname is ever recorded. */
    readonly relativeTarget: string;
    readonly policyRevision: string;
    readonly byteCount: number;
    readonly contentHash?: string;
    readonly decision: AgentContentReadDecision;
    readonly reason?: AgentContentReadReason;
    readonly recordedAt: string;
}
export interface AgentContentReadAllowed {
    readonly decision: 'allow';
    readonly surface: AgentContentReadSurface;
    readonly relativeTarget: string;
    readonly mimeType: string;
    readonly byteCount: number;
    readonly contentHash: string;
    readonly content: Uint8Array;
    readonly text?: string;
    readonly receipt: AgentContentAuditReceipt;
}
export interface AgentContentReadDenied {
    readonly decision: 'deny';
    readonly surface: AgentContentReadSurface;
    readonly relativeTarget: string;
    readonly reason: AgentContentReadReason;
    readonly receipt: AgentContentAuditReceipt;
}
export type AgentContentReadResult = AgentContentReadAllowed | AgentContentReadDenied;
export type AgentContentReadDecisionRecord = AgentContentReadResult;
export declare class AgentContentReadPolicyError extends Error {
    constructor(message: string);
}
export declare class AgentContentReadRequestError extends Error {
    constructor(message: string);
}
export declare class AgentContentReadAuditError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export interface AgentContentReadPolicyEngineOptions {
    readonly agentHomeLayout?: AgentHomeLayout;
    readonly policies: Readonly<Record<AgentContentReadSurface, AgentContentReadPolicySelection>>;
    readonly capabilities: Iterable<string>;
    readonly runtimeAllowlistedRoots?: readonly string[];
    readonly auditStore: AgentContentAuditStore;
    /** Optional all-surface session gate for hosts that require a live handoff before every read. */
    readonly resolveSessionIdentity?: (request: AgentContentReadRequest) => Promise<AgentContentSessionIdentity | undefined> | AgentContentSessionIdentity | undefined;
    /** Binds transcript claims to AgentSessionHandoffStore-backed exact identity. */
    readonly resolveTranscriptIdentity?: (request: AgentContentReadRequest) => Promise<AgentContentSessionIdentity | undefined> | AgentContentSessionIdentity | undefined;
}
export declare const SDK_RESERVED_CONTENT_NAMES: readonly string[];
export declare function createAgentContentReadPolicy(input: AgentContentReadPolicy): AgentContentReadPolicy;
/**
 * Independent local content-read policy engine. It reads one explicitly
 * requested file at a time; it never walks, mirrors, indexes, or parses an
 * Agent home or runtime directory.
 */
export declare class AgentContentReadPolicyEngine {
    private readonly options;
    private readonly policies;
    private readonly capabilities;
    private readonly runtimeRoots;
    private readonly runtimeRootCache;
    private readonly resolveSessionIdentity?;
    private readonly resolveTranscriptIdentity?;
    constructor(options: AgentContentReadPolicyEngineOptions);
    read(input: AgentContentReadRequest): Promise<AgentContentReadResult>;
    /** Alias used by integration adapters that call the operation request. */
    readContent(request: AgentContentReadRequest): Promise<AgentContentReadResult>;
    /** A request is one bounded read, never a directory listing or recursive mirror. */
    request(request: AgentContentReadRequest): Promise<AgentContentReadResult>;
    private resolveRoot;
    private validateRuntimeRoot;
    private checkSessionIdentity;
    private checkTranscriptIdentity;
    private deny;
    private appendReceipt;
}
// ==== @byok-sdk/client dist/daemon/agent-egress-controller.d.ts ====
import type { AgentEvent } from '@byok-sdk/protocol';
import type { AgentRef } from '../agent-home';
import { type AgentEgressDropReason, type AgentEgressDropReceipt, type AgentEgressPolicy, type AgentEgressStatus } from './agent-egress-policy';
import { type AgentReliableAck, type AgentContentReceiptWithoutReliableIdentity, type AgentReliableEgressRecord } from './agent-egress-spool';
import { type AgentEgressSanitizer } from './agent-egress-sanitizer';
export interface AgentEgressControllerOptions {
    readonly policy: Readonly<AgentEgressPolicy>;
    /** Authenticated tenant identity, never accepted from an egress event. */
    readonly tenantId?: string;
    readonly sanitizer?: AgentEgressSanitizer;
}
export interface AgentEgressProgressInput {
    readonly agentRef?: AgentRef;
    readonly taskId: string;
    readonly events: readonly AgentEvent[];
    readonly serverCapabilities: readonly string[];
}
export interface AgentEgressReliableInput {
    readonly homeDir: string;
    readonly agentRef: AgentRef;
    readonly payload: unknown;
    readonly sessionRef: string;
    readonly taskId?: string;
    readonly eventId?: string;
}
export interface AgentEgressContentReceiptInput {
    readonly homeDir: string;
    readonly agentRef: AgentRef;
    /** The content-free payload before the spool supplies stable event/cursor identity. */
    readonly payload: AgentContentReceiptWithoutReliableIdentity;
    readonly taskId?: string;
}
export type AgentEgressReliableAppendResult = Readonly<{
    ok: true;
    record: AgentReliableEgressRecord;
}> | Readonly<{
    ok: false;
    reason: AgentEgressDropReason;
}>;
/**
 * The one daemon-owned policy consumer. Reliable and latest-value retain
 * distinct types and stores; retries are sends, and only exact acknowledgments
 * retire durable records.
 */
export declare class AgentEgressController {
    private readonly options;
    private readonly latest;
    private readonly spools;
    private readonly spoolOpens;
    private reliableAppendTail;
    private readonly latestStatus;
    private readonly reliableStatus;
    private readonly drops;
    private active;
    constructor(options: AgentEgressControllerOptions);
    get policy(): Readonly<AgentEgressPolicy>;
    /** Permanently fail closed after its authenticated enrollment is replaced. */
    deactivate(): void;
    status(): AgentEgressStatus;
    dropReceipts(): readonly AgentEgressDropReceipt[];
    noteTransportDrop(reason: AgentEgressDropReason, agentRef?: AgentRef): void;
    /** Project before TaskRunner builds a `task.progress` envelope. */
    projectLatestValue(input: AgentEgressProgressInput): readonly AgentEvent[];
    appendReliable(input: AgentEgressReliableInput): Promise<AgentEgressReliableAppendResult>;
    /**
     * Content decisions are reliable facts too. They never enter the generic
     * egress payload authority: the spool persists their exact protocol payload
     * with `wireType: agent.content.receipt` before any transport attempt.
     */
    appendContentReceipt(input: AgentEgressContentReceiptInput): Promise<AgentEgressReliableAppendResult>;
    /** Retires only the record whose full Agent/tenant/revision/id/cursor tuple matches. */
    acknowledge(ack: AgentReliableAck): Promise<boolean>;
    /** Re-open every existing Agent-local spool before retrying stable records after restart. */
    recover(agentsRoot: string): Promise<void>;
    reliableRecords(): readonly AgentReliableEgressRecord[];
    /** Missing ack capability holds records in their reliable lane; it never makes them lossy. */
    retryableReliableRecords(serverCapabilities: readonly string[]): readonly AgentReliableEgressRecord[];
    private spoolFor;
    private bindSpool;
    private tenantPendingBytes;
    private withAppendTail;
    private noteDrop;
}
// ==== @byok-sdk/client dist/daemon/agent-egress-policy.d.ts ====
import { type AgentEgressDropReason, type AgentEgressPolicy, type AgentEvent } from '@byok-sdk/protocol';
export type { AgentEgressDropReason, AgentEgressPolicy } from '@byok-sdk/protocol';
export interface AgentEgressDropReceipt {
    lane: 'latest-value' | 'reliable';
    reason: AgentEgressDropReason;
    agentId?: string;
    tenantId?: string;
    eventId?: string;
    occurredAt: string;
}
export interface AgentEgressLaneStatus {
    pendingEvents: number;
    pendingBytes: number;
    replaced: number;
    dropped: number;
    lastDropReason?: AgentEgressDropReason;
}
export interface AgentEgressStatus {
    policyRevision: string;
    latestValue: AgentEgressLaneStatus;
    reliable: AgentEgressLaneStatus;
}
/** Safe policy selected only when the host has not opted into content. */
export declare const DEFAULT_AGENT_EGRESS_POLICY: Readonly<AgentEgressPolicy>;
export declare class AgentEgressPolicyError extends Error {
    constructor(message: string);
}
/** Resolve/validate once at construction; unknown policy shapes never become an implicit default. */
export declare function resolveAgentEgressPolicy(policy: AgentEgressPolicy | undefined): Readonly<AgentEgressPolicy>;
/**
 * Default activity projection. Every retained string is SDK-authored; no
 * runtime trajectory, tool, prompt, environment, argv, path, or credential
 * value survives this transformation.
 *
 * Each case CONSTRUCTS a fresh event from SDK-authored literals rather than
 * editing the incoming one, which is what makes the guarantee total rather
 * than a list of fields someone remembered to strip. `spill` on
 * `tool_use`/`tool_result` is covered by exactly that: a `BlobRef` is a
 * readable locator for the omitted tool payload — content, not metadata — so
 * it never survives a metadata-status projection, and neither do the byte
 * counts that would leak the payload's size.
 */
export declare function metadataStatusEvent(event: AgentEvent): AgentEvent;
export declare function eventBytes(event: AgentEvent): number;
// ==== @byok-sdk/client dist/daemon/agent-egress-sanitizer.d.ts ====
import { type Envelope } from '@byok-sdk/protocol';
import { type AgentEgressDropReason, type AgentEgressPolicy } from './agent-egress-policy';
export interface AgentEgressSanitizerContext {
    readonly lane: 'latest-value' | 'reliable';
    readonly policyRevision: string;
    readonly envelopeType?: string;
    readonly agentId?: string;
    readonly tenantId?: string;
}
/**
 * Optional named host redaction hook for an explicitly contentful policy.
 * It receives the SDK-projected value, never a second raw wire
 * representation. Throwing/refusing drops the event; callers never receive
 * an original-payload fallback.
 */
export type AgentEgressSanitizer = (value: unknown, context: AgentEgressSanitizerContext) => unknown;
export declare class AgentEgressSanitizationError extends Error {
    readonly reason: AgentEgressDropReason;
    constructor(message: string, reason?: AgentEgressDropReason);
}
export type SanitizedEnvelope = Readonly<{
    ok: true;
    envelope: Envelope;
}> | Readonly<{
    ok: false;
    reason: AgentEgressDropReason;
}>;
/**
 * The one envelope-boundary sanitizer used before either transport sees an
 * envelope. It parses the final value through the frozen protocol so a
 * broken custom sanitizer also fails locally, before WS bytes or long-poll
 * JSON can be created.
 */
export declare function sanitizeEgressEnvelope(envelope: Envelope, policy: Readonly<AgentEgressPolicy>, sanitizer: AgentEgressSanitizer | undefined, context?: Omit<AgentEgressSanitizerContext, 'lane' | 'policyRevision' | 'envelopeType'> & {
    lane?: 'latest-value' | 'reliable';
    /** Set only from the active task's frozen terminalProjection, never payload inference. */
    resultDocumentSelected?: boolean;
}): SanitizedEnvelope;
/** Sanitizes a reliable payload before it is hashed/appended, never after. */
export declare function sanitizeReliablePayload(payload: unknown, policy: Readonly<AgentEgressPolicy>, sanitizer: AgentEgressSanitizer | undefined, context?: Omit<AgentEgressSanitizerContext, 'lane' | 'policyRevision'>): unknown;
// ==== @byok-sdk/client dist/daemon/agent-egress-spool.d.ts ====
import { type AgentContentReceiptPayload } from '@byok-sdk/protocol';
import type { AgentRef } from '../agent-home';
import { type AgentEgressPolicy, type AgentEgressDropReason } from './agent-egress-policy';
export declare const AGENT_EGRESS_DIRECTORY: string;
export declare const AGENT_RELIABLE_SPOOL_FILENAME = "reliable-v1.jsonl";
/** A spool row's intended envelope type, never inferred from its payload. */
export declare const AGENT_RELIABLE_WIRE_TYPES: readonly ['agent.egress.reliable', 'agent.content.receipt'];
export type AgentReliableWireType = (typeof AGENT_RELIABLE_WIRE_TYPES)[number];
type OmitReliableIdentity<T> = T extends unknown ? Omit<T, 'eventId' | 'cursor'> : never;
export type AgentContentReceiptWithoutReliableIdentity = OmitReliableIdentity<AgentContentReceiptPayload>;
export interface AgentReliableEgressRecord {
    readonly schema: 1;
    readonly wireType: AgentReliableWireType;
    readonly agentRef: AgentRef;
    readonly tenantId: string;
    readonly policyRevision: string;
    readonly eventId: string;
    readonly cursor: number;
    readonly payload: unknown;
    readonly payloadHash: string;
    readonly byteCount: number;
    readonly createdAt: string;
    readonly sessionRef?: string;
    readonly taskId?: string;
}
export interface AgentReliableAppendInput {
    readonly agentRef: AgentRef;
    readonly tenantId: string;
    readonly policyRevision: string;
    readonly payload: unknown;
    readonly sessionRef?: string;
    readonly taskId?: string;
    readonly eventId?: string;
    readonly createdAt?: string;
}
/**
 * Content receipts use the existing durable spool but retain their own wire
 * type and validated receipt payload. The request id is the stable event id:
 * a retried local read cannot mint a competing receipt identity.
 */
export interface AgentContentReceiptAppendInput {
    readonly agentRef: AgentRef;
    readonly tenantId: string;
    readonly policyRevision: string;
    readonly sessionRef: string;
    readonly payload: AgentContentReceiptWithoutReliableIdentity;
    readonly taskId?: string;
}
export interface AgentReliableAck {
    readonly agentRef: AgentRef;
    readonly tenantId: string;
    readonly sessionRef: string;
    readonly policyRevision: string;
    readonly eventId: string;
    readonly cursor: number;
}
export declare class AgentReliableSpoolError extends Error {
    constructor(message: string);
}
export declare class AgentReliableQuotaError extends AgentReliableSpoolError {
    readonly reason: Extract<AgentEgressDropReason, 'quota_exceeded' | 'backpressure'>;
    constructor(reason: Extract<AgentEgressDropReason, 'quota_exceeded' | 'backpressure'>, message: string);
}
/**
 * Per-Agent durable append-before-send log. It is deliberately separate from
 * the inbound task journal: its only truth is outbound reliable egress
 * pending/exact-ack state.
 */
export declare class AgentReliableSpool {
    readonly homeDir: string;
    readonly spoolPath: string;
    private readonly pending;
    private readonly file;
    private nextCursor;
    private logEntries;
    private writeTail;
    private constructor();
    static open(homeDir: string): Promise<AgentReliableSpool>;
    get pendingEvents(): number;
    get pendingBytes(): number;
    records(): readonly AgentReliableEgressRecord[];
    append(input: AgentReliableAppendInput, policy: Readonly<AgentEgressPolicy>, tenantPendingBytes: number): Promise<AgentReliableEgressRecord>;
    /**
     * Append one complete, protocol-validated content receipt before its first
     * send. `eventId` is fixed to `requestId`; the durable spool alone allocates
     * the positive cursor, then validates the final payload before fsync.
     */
    appendContentReceipt(input: AgentContentReceiptAppendInput, policy: Readonly<AgentEgressPolicy>, tenantPendingBytes: number): Promise<AgentReliableEgressRecord>;
    /** Exact matching ack is the only transition which retires a record. */
    acknowledge(ack: AgentReliableAck): Promise<boolean>;
    private load;
    private appendEntry;
    private compact;
    private exclusive;
}
export interface LatestValueRecord {
    readonly agentRef: AgentRef;
    readonly tenantId: string;
    readonly event: import('@byok-sdk/protocol').AgentEvent;
    readonly byteCount: number;
    readonly updatedAt: string;
}
/** In-memory latest-value state; it is never replayed as durable history. */
export declare class AgentLatestValueState {
    private readonly recordsByAgent;
    offer(record: Omit<LatestValueRecord, 'byteCount' | 'updatedAt'>, policy: Readonly<AgentEgressPolicy>): Readonly<{
        accepted: true;
        replaced: boolean;
        record: LatestValueRecord;
    }> | Readonly<{
        accepted: false;
        reason: Extract<AgentEgressDropReason, 'quota_exceeded' | 'backpressure'>;
    }>;
    get pendingEvents(): number;
    get pendingBytes(): number;
}
export {};
// ==== @byok-sdk/client dist/daemon/agent-memory-filesystem.d.ts ====
/**
 * Root-bound filesystem authority used by Agent memory. Implementations must
 * pin the exact leased Agent-home object, reject symlink/reparse traversal,
 * and keep every operation relative to that pinned root.
 */
export interface AgentMemoryFilesystem {
    read(path: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState>;
    replace(path: string, expectedRevision: string, content: string, maxBytes: number): Promise<AgentMemoryFilesystemFileState>;
    delete(path: string, expectedRevision: string): Promise<void>;
    append(path: string, content: string, maxBytes: number): Promise<void>;
    walk(path: string, maxEntries: number): Promise<readonly string[]>;
    close(): Promise<void>;
}
export interface AgentMemoryFilesystemFileState {
    readonly exists: boolean;
    readonly content: string;
    readonly revision: string;
    readonly byteCount: number;
}
/** Product-owned deployment pointer. The SDK never searches PATH. */
export interface AgentMemoryFilesystemHelperConfig {
    readonly helperBin: string;
}
// ==== @byok-sdk/client dist/daemon/agent-memory-fs-helper.d.ts ====
import type { AgentHomeLease } from '../agent-home';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem';
export declare const AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL = 2;
export declare const AGENT_MEMORY_FILESYSTEM_HELPER_VERSION = "2";
export declare function isAgentMemoryFilesystemHelperSupported(): boolean;
export declare function openAgentMemoryFilesystemHelper(input: Readonly<{
    helperBin: string;
    canonicalHome: string;
    homeIdentity: AgentHomeLease['homeIdentity'];
}>): Promise<AgentMemoryFilesystem>;
// ==== @byok-sdk/client dist/daemon/agent-memory.d.ts ====
import { AGENT_MEMORY_PROJECTION_CAPABILITY, type AgentMemoryProjectionMutation } from '@byok-sdk/protocol';
import { type AgentHomeLease, type AgentRef } from '../agent-home';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem';
export declare const AGENT_MEMORY_AUDIT_FILENAME = "agent-memory-audit-v1.jsonl";
/** v2 is one atomically replaced state file, never an append-only log. */
export declare const AGENT_MEMORY_OUTBOX_FILENAME = "agent-memory-redacted-outbox-v2.json";
export declare const AGENT_MEMORY_MAX_FILE_BYTES: number;
export declare const AGENT_MEMORY_MAX_SNAPSHOT_BYTES: number;
export declare const AGENT_MEMORY_MAX_SNAPSHOT_FILES = 128;
export declare const AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES = 512;
/** One atomically replaced audit/outbox state must fit the cross-platform helper contract. */
export declare const AGENT_MEMORY_MAX_LOCAL_LOG_BYTES: number;
export declare class AgentMemoryError extends Error {
    constructor(message: string);
}
export declare class AgentMemoryRevisionConflictError extends AgentMemoryError {
    readonly expectedRevision: string;
    readonly actualRevision: string;
    constructor(expectedRevision: string, actualRevision: string);
}
export interface AgentMemoryTaskContext {
    readonly taskId: string;
    readonly tenantId: string;
    readonly deviceId: string;
    readonly agentRef: AgentRef;
    readonly sessionRef: string;
    readonly runtimeId: string;
    readonly canonicalHome: string;
    readonly leaseId: string;
    readonly homeIdentity: AgentHomeLease['homeIdentity'];
    /** Optional task-scoped external root handle; omission selects the native Linux backend. */
    readonly filesystem?: AgentMemoryFilesystem;
}
export interface AgentMemoryFile {
    readonly path: string;
    readonly revision: string;
    readonly byteCount: number;
    readonly content: string;
}
export interface AgentMemorySnapshot {
    readonly files: readonly AgentMemoryFile[];
    readonly totalBytes: number;
}
/**
 * Embedder-owned redaction authority. Its output is opaque bytes: the local
 * relative paths, source revisions, and raw source content never enter the
 * outbox or projection port.
 */
export interface AgentMemoryRedactor {
    redact(input: Readonly<AgentMemorySnapshot>): Promise<Uint8Array> | Uint8Array;
}
/** Host-issued projection binding; no model-provided consent boolean exists. */
export interface AgentMemoryProjectionGrant {
    readonly grantRef: AgentMemoryProjectionMutation['grantRef'];
    readonly writerEpoch: AgentMemoryProjectionMutation['writerEpoch'];
    readonly policyRevision: AgentMemoryProjectionMutation['policyRevision'];
}
export interface AgentMemoryRedactedOutboxRecord {
    readonly version: 2;
    readonly mutation: AgentMemoryProjectionMutation;
    readonly createdAt: string;
}
/**
 * Optional bridge to a complete hosted client. It receives the canonical,
 * already-redacted protocol mutation only; this package intentionally owns no
 * consent, cloud transport, or raw-source upload fallback.
 */
export interface AgentMemoryProjectionPort {
    publish(input: Readonly<{
        mutation: AgentMemoryProjectionMutation;
    }>): Promise<{
        readonly accepted: boolean;
    }>;
}
/**
 * Replay exposes only ordering metadata. The redacted mutation body remains in
 * the durable outbox and is never copied into a task-close error or outcome.
 */
export type AgentMemoryProjectionReplayDrainedOutcome = Readonly<{
    readonly status: 'drained';
}>;
export type AgentMemoryProjectionReplayPendingOutcome = Readonly<{
    readonly status: 'pending';
    readonly writerEpoch: number;
    readonly sourceSeq: number;
    readonly mutationId: string;
}>;
export type AgentMemoryProjectionReplayOutcome = AgentMemoryProjectionReplayDrainedOutcome | AgentMemoryProjectionReplayPendingOutcome;
export declare class AgentMemoryProjectionReplayPendingError extends AgentMemoryError {
    readonly outcome: AgentMemoryProjectionReplayPendingOutcome;
    constructor(outcome: AgentMemoryProjectionReplayPendingOutcome);
}
/** Every member is mandatory before network projection is permitted. */
export interface AgentMemoryHostedProjection {
    readonly capability?: typeof AGENT_MEMORY_PROJECTION_CAPABILITY;
    readonly grant?: AgentMemoryProjectionGrant;
    readonly redactor?: AgentMemoryRedactor;
    readonly port?: AgentMemoryProjectionPort;
}
/** Model input can name one allowed file, never a root, directory, glob, or internal SDK state. */
export declare function validateAgentMemoryPath(value: unknown): string;
/**
 * The sole platform gate for the Agent-memory write authority. Linux retains
 * the native procfs descriptor backend. macOS requires the explicit external
 * helper that passed its local race proof. Windows remains unavailable rather
 * than selecting an unproved fallback.
 */
export declare function isAgentMemorySecureFilesystemAvailable(externalHelperConfigured?: boolean): boolean;
export interface AgentMemoryAuditWarning {
    /** Metadata-only signal: the local source operation already succeeded. */
    readonly code: 'agent_memory_audit_unavailable';
}
export interface AgentMemoryRecallResult {
    readonly path: string;
    readonly revision: string;
    readonly content: string;
    readonly auditWarning?: AgentMemoryAuditWarning;
}
export interface AgentMemorySaveResult {
    readonly path: string;
    readonly revision?: string;
    readonly deleted: boolean;
    readonly auditWarning?: AgentMemoryAuditWarning;
}
export declare class AgentMemoryService {
    private readonly input;
    constructor(input: AgentMemoryTaskContext);
    recall(input: {
        readonly path: unknown;
        readonly ifRevision?: unknown;
    }): Promise<Readonly<AgentMemoryRecallResult>>;
    save(input: {
        readonly op: unknown;
        readonly path: unknown;
        readonly expectedRevision: unknown;
        readonly content?: unknown;
    }): Promise<Readonly<AgentMemorySaveResult>>;
}
/** Bounded stable snapshot, called after Session.close() while the Agent lease still exists. */
export declare function captureAgentMemorySnapshot(input: AgentMemoryTaskContext): Promise<AgentMemorySnapshot>;
export declare class AgentMemoryRedactedOutbox {
    private readonly context;
    private readonly grant;
    readonly filePath: string;
    private state;
    private fileRevision;
    private writeTail;
    private constructor();
    static open(input: AgentMemoryTaskContext, grant: AgentMemoryProjectionGrant): Promise<AgentMemoryRedactedOutbox>;
    pending(): readonly AgentMemoryRedactedOutboxRecord[];
    append(bytes: Uint8Array): Promise<AgentMemoryRedactedOutboxRecord>;
    replay(port: AgentMemoryProjectionPort): Promise<AgentMemoryProjectionReplayOutcome>;
    private load;
    private loadBody;
    private admitGrant;
    private persist;
    private exclusive;
}
/** Missing capability, grant, redactor, or port has exactly zero network side effects. */
export declare function snapshotAndProjectAgentMemory(input: AgentMemoryTaskContext, projection: AgentMemoryHostedProjection | undefined): Promise<void>;
// ==== @byok-sdk/client dist/daemon/agent-session-handoff-store.d.ts ====
import { type AgentRef } from '../agent-home';
export type AgentTerminalCause = 'complete' | 'failed' | 'cancelled';
export interface AgentSessionHandoff {
    readonly agentRef: AgentRef;
    /** Task that created the native runtime session. */
    readonly taskId: string;
    readonly sessionRef: string;
    readonly runtimeId: string;
    /** Canonical Agent home and runtime cwd; these are intentionally one value. */
    readonly cwd: string;
    readonly leaseId: string;
    readonly terminalCause?: AgentTerminalCause;
    readonly terminalReason?: string;
    readonly updatedAt: string;
}
export interface AgentSessionHandoffMatch {
    readonly agentRef: AgentRef;
    readonly sessionRef: string;
    readonly runtimeId: string;
    readonly cwd: string;
}
export interface AgentTaskTerminalEvidence {
    readonly agentRef: AgentRef;
    readonly taskId: string;
    readonly runtimeId: string;
    /** Canonical Agent home and sealed runtime cwd. */
    readonly cwd: string;
    readonly leaseId: string;
    /** Present when adapter start succeeded but handoff persistence failed. */
    readonly sessionRef?: string;
    readonly terminalCause: 'failed';
    readonly terminalReason: string;
    readonly updatedAt: string;
}
export interface AgentTaskTerminalMatch {
    readonly agentRef: AgentRef;
    readonly taskId: string;
    readonly runtimeId: string;
    readonly cwd: string;
}
export declare class AgentSessionHandoffStoreError extends Error {
    constructor(message: string);
}
export declare class AgentSessionHandoffCorruptError extends AgentSessionHandoffStoreError {
    constructor(message: string);
}
export declare class AgentSessionHandoffMismatchError extends AgentSessionHandoffStoreError {
    constructor(message: string);
}
/**
 * Durable, fail-closed session evidence stored inside the canonical Agent
 * home. Each session gets one hash-addressed append-only JSONL ledger under
 * `.byok/runtime-sessions/`; session text never becomes a pathname. Unlike
 * the legacy SessionWorkspaceStore, corrupt bytes are never interpreted as a
 * missing mapping.
 */
export declare class AgentSessionHandoffStore {
    private readonly queues;
    get(expected: AgentSessionHandoffMatch): Promise<AgentSessionHandoff | undefined>;
    /** Append-only readback for audit/recovery; every historical terminal remains visible. */
    history(expected: AgentSessionHandoffMatch): Promise<readonly AgentSessionHandoff[]>;
    /** Exact identity check used before a strict Agent resume is admitted. */
    requireMatch(expected: AgentSessionHandoffMatch): Promise<AgentSessionHandoff>;
    /** Append-only, fsynced write. The caller awaits this before task.started. */
    record(input: Omit<AgentSessionHandoff, 'updatedAt' | 'terminalCause' | 'terminalReason'>): Promise<AgentSessionHandoff>;
    /** Records the first terminal cause without changing the exact handoff identity. */
    recordTerminal(expected: AgentSessionHandoffMatch, cause: AgentTerminalCause, reason?: string): Promise<AgentSessionHandoff>;
    /**
     * Persists a claimed Agent task failure that happened before an active
     * session handoff existed. Callers await the fsync before sending
     * `task.fail`, so cloud state can never outrun the Agent-local evidence.
     */
    recordTaskTerminal(input: Omit<AgentTaskTerminalEvidence, 'updatedAt' | 'terminalCause'>): Promise<AgentTaskTerminalEvidence>;
    getTaskTerminal(expectedInput: AgentTaskTerminalMatch): Promise<AgentTaskTerminalEvidence | undefined>;
    private filePath;
    private taskTerminalFilePath;
    private enqueue;
    private load;
    private loadAll;
    private loadTaskTerminal;
    private append;
}
// ==== @byok-sdk/client dist/daemon/approvals.d.ts ====
/**
 * M4 Phase 2: minimal pending-approval registry backing the control
 * socket's `approvals.list`/`approvals.resolve` methods.
 *
 * Nothing PRODUCES an approval yet in Phase 2 — every one of the three
 * bundled runtime adapters (pi/claude/codex) still has no interactive
 * `needs_approval` path (see `create-daemon.ts`'s `toRuntimeInfoCapabilities`
 * doc comment) — so `list()` always returns `[]` and `resolve()` always
 * throws {@link ApprovalNotFoundError} against a real daemon today. This
 * class exists now so Phase 3 (the claude permission-prompt path) only has
 * to call `register()` from wherever it detects a prompt; the control-socket
 * plumbing (`control-server.ts`'s method registry, the CLI's `approve`/
 * `reject` commands) is already wired end-to-end against this same registry.
 */
export type ApprovalDecision = 'approve' | 'reject';
/**
 * M4 (additive-minor, `task.approval_resolved`): distinguishes a resolution
 * that arrived over the wire (a server-sent `task.approve`/`task.reject`,
 * relayed here via `RuntimeOperationStartInput.approvalChannel.resolve` — `task-runner.ts`'s
 * `handleOffer`) from one this device decided on its own (the local
 * `approvals.resolve` control-socket RPC, a fail-closed `requestApproval`
 * timeout, or a fail-closed finish/eviction rejection). `TaskRunner` uses
 * this to decide whether to report `task.approval_resolved` back to the
 * server: a wire-triggered resolution is something the server already knows
 * about (it sent the decision itself) and must never be echoed back;
 * everything else is new information only the device has, and — capability
 * permitting — gets reported. `'local'` is the default (see `resolve()`
 * below) precisely because it's the common case: every call site in this
 * module and `task-runner.ts` except the one wire-relay closure is local by
 * construction.
 */
export type ApprovalOrigin = 'wire' | 'local';
/** What `approvals.list` returns per pending approval — deliberately small; a runtime-specific payload (e.g. the exact tool call awaiting approval) is Phase 3's concern, not this registry's. */
export interface PendingApproval {
    approvalId: string;
    taskId: string;
    summary?: string;
    createdAt: string;
}
export declare class ApprovalNotFoundError extends Error {
    constructor(approvalId: string);
}
/** Cap on simultaneously pending approvals — generous for any plausible concurrent-approval workload, and existing purely as a defensive bound (mirrors `task-runner.ts`'s `MAX_TRACKED_TASK_IDS`/`observer.ts`'s `MAX_TRACKED_TASKS`), not a real-world limit this is expected to ever approach. */
export declare const MAX_PENDING_APPROVALS = 200;
type ResolveCallback = (decision: ApprovalDecision, reason: string | undefined, origin: ApprovalOrigin) => void;
/**
 * `register()`/`resolve()` are the producer/consumer halves of one pending
 * approval: a future runtime adapter integration calls `register()` when it
 * pauses a task awaiting a decision and gets called back via `onResolve`
 * once `resolve()` is invoked (locally, or — Phase 2's actual wiring — via
 * the control socket's `approvals.resolve` RPC). `list()` is a pure read
 * for `approvals.list`.
 */
export declare class ApprovalRegistry {
    private readonly pending;
    /**
     * Registers a new pending approval, evicting the OLDEST entry first if
     * already at {@link MAX_PENDING_APPROVALS} — bounded, not unbounded
     * growth, for a long-lived daemon. The evicted entry's own `onResolve` is
     * called (as a reject, with a reason naming the eviction) rather than
     * simply dropped: whatever registered it (a future Phase 3 producer,
     * e.g. a paused runtime session awaiting a decision) is very likely
     * still waiting on that callback firing at all — silently stranding it
     * would leave that producer hanging forever instead of unblocking it
     * with a clear, if unwelcome, outcome.
     */
    register(approval: PendingApproval, onResolve: ResolveCallback): void;
    list(): PendingApproval[];
    /**
     * Throws {@link ApprovalNotFoundError} for an unknown/already-resolved id —
     * never silently no-ops, since a caller (the control socket's
     * `approvals.resolve`) needs to distinguish "resolved" from "nothing to
     * resolve".
     *
     * `origin` defaults to `'local'` (see {@link ApprovalOrigin}'s own doc
     * comment for why that's the correct default, not just a convenient one):
     * every existing caller of this method — the control socket's
     * `approvals.resolve` RPC (`create-daemon.ts`), `TaskRunner`'s
     * `requestApproval` timeout and `finish()` fail-closed cleanup
     * (`task-runner.ts`) — resolves a decision this device made on its own.
     * The one exception, a server-sent wire `task.approve`/`task.reject`
     * relayed through `RuntimeOperationStartInput.approvalChannel.resolve`
     * (`task-runner.ts`'s `handleOffer`), passes `'wire'` explicitly.
     */
    resolve(approvalId: string, decision: ApprovalDecision, reason?: string, origin?: ApprovalOrigin): void;
}
export {};
// ==== @byok-sdk/client dist/daemon/assertion-client.d.ts ====
import { type DeviceAssertionEnvelopeV1, type TaskAssertionEnvelopeV1 } from '@byok-sdk/core';
import { type AssertionIssueErrorCode, type TaskAssertionIssueErrorCode } from './control-protocol';
/**
 * Plan `device-assertion-broker`: the ONE public entry point a sibling local
 * process uses to obtain a device assertion from an already-running daemon.
 *
 * This module is the entire public surface of the control socket, and that is
 * deliberate. `connectControlClient`/`ControlClient` are NOT exported from the
 * package index and must not become exported: they can also `shutdown` the
 * daemon, resolve approvals, and subscribe to the raw task feed, and once any
 * of that is reachable from outside this package it is a compatibility surface
 * forever. A host that needs one specific capability gets one specific
 * function; `packages/client/src/__tests__/assertion-client.test.ts` pins that
 * the index exports nothing else. See also `bin/control-client.ts`'s own doc
 * comment for why connecting never throws.
 */
export interface RequestDeviceAssertionOptions {
    /** Same `productId` the daemon was configured with — selects which daemon's socket to dial. */
    productId: string;
    /** Same `storeDir` the daemon was configured with. Defaults to `~/.byok/<productId>`, exactly as the daemon's own default does. */
    storeDir?: string;
    /** The exact audience string, which must appear verbatim in the daemon's configured allowlist. */
    audience: string;
    /** Bound on the control-socket round trip, ms. Default 10s (the control client's own default). */
    timeoutMs?: number;
}
/**
 * The six refusals the daemon itself can answer with (see
 * `ASSERTION_ISSUE_ERROR_CODES`, `control-protocol.ts`) plus the two this
 * function can produce on its own:
 *
 * - `unavailable` — no reachable daemon control socket (not running, wrong
 *   `productId`/`storeDir`, or an unreadable control token). This is a local
 *   fact, NOT a statement about the device's pairing or revocation state.
 * - `bad_response` — a daemon answered, but with something that is not a
 *   well-formed assertion envelope. Fail-closed: a malformed envelope is never
 *   passed through to a caller who would then present it to a cloud.
 *
 * Typed as an open string union so an unrecognized wire code (a newer daemon
 * against an older caller) surfaces verbatim instead of being flattened into
 * something misleading.
 */
export type RequestDeviceAssertionErrorCode = AssertionIssueErrorCode | 'unavailable' | 'bad_response' | (string & {});
export type RequestDeviceAssertionResult = {
    ok: true;
    assertion: DeviceAssertionEnvelopeV1;
    expiresAt: string;
} | {
    ok: false;
    code: RequestDeviceAssertionErrorCode;
    reason: string;
};
/**
 * Asks a running daemon for one short-lived device assertion scoped to
 * `audience`.
 *
 * Never throws for an expected outcome — a missing daemon, a denied audience,
 * a revoked or unpaired device, and a daemon mid-shutdown all come back as
 * `{ok: false, code, reason}`, the same typed-result convention
 * `connectControlClient` already uses. The caller decides what to do about
 * each; nothing here retries, falls back, or degrades.
 *
 * What this function does NOT do, on purpose: cache the assertion, inspect the
 * claims to decide anything, or re-request on expiry. The assertion is
 * deliberately short-lived, and a cache here would be a second, unaudited copy
 * of a credential living outside the daemon that minted it.
 */
export declare function requestDeviceAssertion(options: RequestDeviceAssertionOptions): Promise<RequestDeviceAssertionResult>;
/**
 * Contract §8.1 / §8.2(1): ask a running daemon for one task-scoped assertion,
 * for one upcoming tool invocation.
 *
 * `contextToken` is the `BYOK_HOST_TOOLSET_CONTEXT` value the daemon injected
 * into THIS process's environment when it started this task's toolset server.
 * The caller passes it explicitly and this function never reads it from
 * `process.env` itself — a helper that went looking for the variable would work
 * just as well inside a process the daemon never spawned for this task, which
 * is precisely the substitution the nonce exists to prevent. Reading the
 * environment is the child's own decision, made once, at its own entry point.
 *
 * §8.1 again, on what this function must NOT grow: no cache, no refresh, no
 * retry. Every tool call takes a NEW assertion with a NEW `jti`, and so does
 * every transport retry of the same call — one credential held across
 * invocations is a task pass, which is the thing the whole lane is built to not
 * be. Retrying is the caller's decision, and a retry means calling this again.
 */
export interface RequestTaskAssertionOptions {
    /** Same `productId` the daemon was configured with — selects which daemon's socket to dial. */
    productId: string;
    /** Same `storeDir` the daemon was configured with. Defaults to `~/.byok/<productId>`. */
    storeDir?: string;
    /** The `BYOK_HOST_TOOLSET_CONTEXT` nonce this process was started with. Never read from the environment here. */
    contextToken: string;
    /** The exact audience string, which must appear verbatim in the daemon's configured allowlist. */
    audience: string;
    /** Bound on the control-socket round trip, ms. Default 10s (the control client's own default). */
    timeoutMs?: number;
}
/**
 * The nine refusals the daemon itself can answer with (see
 * `TASK_ASSERTION_ISSUE_ERROR_CODES`, `control-protocol.ts`) plus the two this
 * function produces on its own, with the same meanings they have in
 * {@link RequestDeviceAssertionErrorCode}.
 *
 * Note what a caller may NOT conclude from `context_token_invalid`: it does not
 * distinguish "this token was never real" from "this task has finished and been
 * cleaned up". The daemon collapses those deliberately, and a caller that
 * reconstructs the difference by timing or retrying is reading an oracle that is
 * not offered.
 */
export type RequestTaskAssertionErrorCode = TaskAssertionIssueErrorCode | 'unavailable' | 'bad_response' | (string & {});
export type RequestTaskAssertionResult = {
    ok: true;
    assertion: TaskAssertionEnvelopeV1;
    expiresAt: string;
} | {
    ok: false;
    code: RequestTaskAssertionErrorCode;
    reason: string;
};
/**
 * Asks a running daemon for one short-lived task assertion.
 *
 * Never throws for an expected outcome, exactly like
 * {@link requestDeviceAssertion}: a missing daemon, a denied audience, an
 * unknown or revoked context, a revoked or unpaired device, and a daemon
 * mid-shutdown all come back as `{ok: false, code, reason}`.
 *
 * A device assertion is NOT an acceptable answer here and cannot become one:
 * this calls `task_assertion.issue`, and the envelope is parsed with
 * `parseTaskAssertionEnvelope`, which rejects a device envelope outright rather
 * than passing it on to a caller who would then present it as task authority.
 */
export declare function requestTaskAssertion(options: RequestTaskAssertionOptions): Promise<RequestTaskAssertionResult>;
// ==== @byok-sdk/client dist/daemon/auth-manager.d.ts ====
import { DeviceStore, type DeviceRecord } from './store';
import type { DeviceCredentialStore, InMemoryDeviceCredentialStore } from './device-credential-store';
/**
 * Thrown when the server has revoked this device: a 401 on `/byok/challenge`
 * or `/byok/token` (protocol §6.3). The only recourse is a fresh
 * `/byok/pair` — callers must surface a clear "re-pair needed" state and
 * must NOT retry the renewal in a loop.
 */
export declare class DeviceRevokedError extends Error {
    constructor(message?: string);
}
/**
 * Thrown when the local AuthManager deadline or shutdown cancels its own
 * in-flight request. This is deliberately distinct from `DeviceRevokedError`:
 * only an actual challenge/token HTTP 401 is server authority for revocation.
 */
export declare class AuthRequestAbortedError extends Error {
    readonly reason: 'deadline' | 'stopped';
    constructor(reason: 'deadline' | 'stopped');
}
export interface AuthManagerOptions {
    serverUrl: string;
    store: DeviceStore;
    /** Internal-only credential custody seam. Product construction uses store.credentials. */
    credentials?: DeviceCredentialStore | InMemoryDeviceCredentialStore;
    deviceName?: string;
    /**
     * Optional resolver for the client-hashed physical machine identity sent
     * with `POST /byok/pair` (protocol §6.1). Resolved once per pair attempt; a
     * resolver that yields `undefined` omits the field entirely rather than
     * sending a placeholder, because the server treats its presence as
     * permission to supersede this machine's prior active device rows.
     */
    machineId?: () => Promise<string | undefined>;
    /** Upper bound for one pair/challenge/token fetch plus its response-body read. */
    authRequestDeadlineMs?: number;
    /** Called once revocation is detected, so a caller (ConnectionManager) can stop retrying and surface the state instead of looping. */
    onRevoked?: () => void;
}
/**
 * Owns device pairing and the access token lifecycle (protocol §6):
 * generates/reuses the device Ed25519 keypair, pairs, and renews the access
 * token both proactively (before expiry) and reactively (on a 401 from any
 * caller). This is the single source of truth for "the current valid JWT"
 * that WS connects, blob HTTP calls, and the long-poll fallback all use.
 */
export declare class AuthManager {
    private readonly opts;
    private record;
    private renewing;
    private proactiveTimer;
    private revoked;
    private stopped;
    private pairing;
    private credentialMutationTail;
    /** The sole cancellation authority for the request currently inside the serialized credential mutation. */
    private activeRequest;
    private readonly credentials;
    private readonly requestDeadlineMs;
    constructor(opts: AuthManagerOptions);
    get deviceId(): string | undefined;
    isRevoked(): boolean;
    /** Internal signer read: always recompose metadata with the current OS secret authority. */
    readCurrent(): Promise<DeviceRecord | undefined>;
    /** Load a previously-paired device record from disk, if any (idempotent — a second call is a no-op once loaded). */
    loadExisting(): Promise<DeviceRecord | undefined>;
    /** `POST /byok/pair` (v2): generates a device keypair on first pair, reuses it on any subsequent (e.g. post-revocation) re-pair. */
    pair(pairingCode: string): Promise<DeviceRecord>;
    /** The current, non-expired access token — renews first if it's expired or close to it. Throws {@link DeviceRevokedError} if the device has been revoked. */
    getValidAccessToken(): Promise<string>;
    /** Force a renewal regardless of the cached token's remaining lifetime — the reactive path, used after a caller sees a 401. */
    handleUnauthorized(): Promise<string>;
    stop(): Promise<void>;
    private renew;
    private doRenew;
    /** Always throws — `never` return type lets call sites use `if (x === 401) this.markRevoked();` without an explicit `return`/`throw` of their own. */
    private markRevoked;
    private scheduleProactiveRenewal;
    /**
     * Bounds one complete auth exchange rather than fetch alone. Keeping the
     * controller active through `json()`/`text()` makes a non-cooperative or
     * partial response body cancellable by the same authority that owns fetch.
     */
    private runRequest;
    private runCredentialMutation;
    /** Read the current paired authority afresh; metadata without its OS secret is re-pair required. */
    private loadRecord;
}
// ==== @byok-sdk/client dist/daemon/blob-client.d.ts ====
import type { BlobRef } from '@byok-sdk/protocol';
import type { AuthManager } from './auth-manager';
export type BlobRequestAbortReason = 'deadline' | 'cancelled';
/** A blob request/body read did not complete before its deadline or its owner cancelled it. */
export declare class BlobRequestAbortedError extends Error {
    readonly reason: BlobRequestAbortReason;
    constructor(reason: BlobRequestAbortReason);
}
export interface BlobClientOptions {
    /** Bound for each individual HTTP request and response-body read. Default: 15 seconds. */
    requestDeadlineMs?: number;
    /** Daemon lifecycle authority; aborting it stops all in-flight blob I/O. */
    signal?: AbortSignal;
}
export interface BlobRequestOptions {
    /** Task lifecycle authority; aborting it stops this transfer before finalization. */
    signal?: AbortSignal;
}
/** Seam `TaskRunner` depends on, so tests can substitute a fake without spinning up real HTTP endpoints. */
export interface BlobResolver {
    resolveInstruction(blobRef: BlobRef, options?: BlobRequestOptions): Promise<string>;
    uploadArtifact(content: string | Uint8Array, contentType: string, options?: BlobRequestOptions & {
        readonly idempotencyKey?: string;
    }): Promise<BlobRef>;
}
/**
 * HTTP-side blob transfer (protocol §7): resolving an instruction `blobRef`
 * into its actual content, and uploading an artifact too large to inline.
 * Both require a valid bearer token, handled via `authedFetch`.
 */
export declare class BlobClient implements BlobResolver {
    #private;
    private readonly serverUrl;
    private readonly auth;
    private readonly options;
    private readonly requestDeadlineMs;
    constructor(serverUrl: string, auth: AuthManager, options?: BlobClientOptions);
    /** `blobRef` -> `GET /byok/blobs/:id/url` -> fetch the presigned download URL -> text content. Always resolves fresh rather than trusting any inlined `BlobRef.url`, per docs/protocol.md §7. */
    resolveInstruction(blobRef: BlobRef, options?: BlobRequestOptions): Promise<string>;
    /** `POST /byok/blobs` -> PUT the bytes to the presigned URL -> finalize into a `BlobRef`. */
    uploadArtifact(content: string | Uint8Array, contentType: string, options?: BlobRequestOptions & {
        readonly idempotencyKey?: string;
    }): Promise<BlobRef>;
}
// ==== @byok-sdk/client dist/daemon/connection-manager.d.ts ====
import type { HarnessInfo } from '@byok-sdk/protocol';
import { type CapabilityFlag, type Envelope, type RuntimeInfo, type ToolsetId } from '@byok-sdk/protocol';
import { AuthManager } from './auth-manager';
import type { CursorStore } from './cursor-store';
import { type FleetJitter } from './deterministic-jitter';
import { ReplayCursorTooOldError } from './replay-cursor';
export { ReplayCursorTooOldError } from './replay-cursor';
/** The lifecycle of the daemon's one long-poll connection. */
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'revoked';
export interface ConnectionManagerOptions {
    serverUrl: string;
    deviceId: string;
    productId: string;
    capabilities: CapabilityFlag[];
    /** U4a Local Agent release version, sent unchanged in `conn.hello`. */
    clientVersion?: string;
    runtimes: RuntimeInfo[];
    harnesses?: HarnessInfo[];
    /** Reads current sorted logical IDs from the validated local registry for every `conn.hello`. */
    getConfiguredToolsets?: () => readonly ToolsetId[];
    auth: AuthManager;
    cursorStore: CursorStore;
    /**
     * May return a promise; `ConnectionManager` awaits it before considering
     * this envelope "processed" (findings F2/F3 — see `deliver`/`process`
     * below). A handler that throws/rejects is caught here, not propagated.
     */
    onEnvelope: (envelope: Envelope) => void | Promise<void>;
    onStateChange?: (state: ConnectionState) => void;
    /** Await durable disposition before retiring the exact accepted/rejected bytes. */
    onOutboundAccepted?: (envelopes: readonly Envelope[]) => Promise<void>;
    onOutboundRejected?: (envelope: Envelope) => Promise<void>;
    onOutboundQueued?: (envelope: Envelope) => void;
    beforeOutboundPost?: (envelopes: readonly Envelope[]) => void;
    /** Backoff between failed long-poll HTTP attempts. Default 2s. */
    longPollRetryDelayMs?: number;
    /** Minimum delay before the next long-poll request after an empty (no-events) response. Default 250ms. */
    longPollIdleDelayMs?: number;
    fleetJitter?: FleetJitter;
    onOperationalOutcome?: (outcome: 'success' | 'failure', source: 'reconnect' | 'upload') => void;
    onTerminalError?: (error: ReplayCursorTooOldError) => void;
}
export interface RejectedOutboundEnvelope {
    readonly envelope: Envelope;
    readonly reason: 'inbound_rejected';
}
/**
 * Owns the daemon's one authenticated long-poll connection to the server.
 * Every received envelope passes through the same cursor-dedupe/persistence
 * logic (protocol §9), so redelivery remains safe after an HTTP retry or a
 * daemon restart.
 *
 * `send()` (Design B, finding N4) pushes onto a single shared outbox this
 * class owns and drains through `POST /byok/messages`; long-poll is a full
 * bidirectional transport, not a receive-only path. See `drainOutbox`.
 */
export declare class ConnectionManager {
    private readonly opts;
    private readonly fleetJitter;
    private readonly longPoll;
    private uploadRetryAttempt;
    private started;
    private connected;
    private cursor;
    /**
     * Finding F3 (at-most-once redelivery): the lowest `task.*` envelope `seq`
     * whose handler failed and hasn't yet been successfully reprocessed. While
     * set, the cursor is frozen at its pre-failure value even if later
     * envelopes succeed — advancing past a still-unresolved failure would
     * mean a future reconnect's redelivery skips it forever (it's <= the
     * persisted cursor), which is exactly the bug this fixes. Cleared once an
     * envelope carrying this exact seq is reprocessed (via redelivery after a
     * reconnect) and succeeds; everything from there back up to the new
     * cursor gets safely re-attempted too, relying on the idempotency
     * guarantees in docs/protocol.md §9.
     */
    private stalledAtSeq;
    /** Drain barrier for independently running handlers; not an admission lock. */
    private processingChain;
    private cursorInitialization;
    private completionTail;
    private readonly controlTails;
    /**
     * Design B (finding N4): the ONE outbound queue holds `Envelope` OBJECTS,
     * never re-encoded/rebuilt strings, so a
     * resend after a failed send attempt is byte-identical to the original
     * (same `id`), which is what lets the server's per-(deviceId,id) dedup
     * (Wave 1) recognize it as a safe no-op retry rather than a second
     * application (protocol §9).
     */
    private readonly outbox;
    /** Terminally rejected outbound envelopes, retained as a bounded observable quarantine. */
    private readonly rejectedOutboundEnvelopes;
    /**
     * Finding F5(b): how many envelopes `drainOutbox` has
     * currently spliced OUT of `this.outbox` for an in-flight (not yet
     * confirmed delivered) `postBatch` call — 0 the rest of the time. See
     * `outboxLength`'s own doc comment for why this needs to be tracked
     * separately from `this.outbox.length` at all.
     */
    private inFlightBatchSize;
    private draining;
    private stopped;
    private revoked;
    private terminalError;
    private settledWaiters;
    private pendingCursorSave;
    /** Admission dedup while an individual handler is running. */
    private readonly inFlightSeqs;
    /** Successful side effects retained until their durable acknowledgement. */
    private readonly processedSeqs;
    private readonly failedEnvelopes;
    /** Received work lacking a successful handler receipt, including malformed frames. */
    private readonly unresolvedSeqs;
    /**
     * Finding P3: the pending `drainOutbox` long-poll retry backoff, if any —
     * cancellable so `enterRevoked()` can unblock it immediately instead of
     * waiting out the rest of the delay before the loop notices `revoked` and
     * exits. See `drainRetryDelay`.
     */
    private cancelPendingDrainRetry;
    /**
     * The capabilities the current server response advertised — untyped
     * `string[]` for forward compatibility. An advertisement is scoped to the
     * current long-poll response stream and is cleared after an HTTP failure,
     * terminal shutdown, or revocation. This keeps capability-gated outbound
     * messages fail-closed until the current server has explicitly advertised
     * support.
     */
    private serverCapabilities;
    constructor(opts: ConnectionManagerOptions);
    start(): Promise<void>;
    /**
     * Design B (finding N4): push onto the single shared outbox and try to
     * drain it now. Never routes directly to either transport itself — see
     * `drainOutbox`.
     */
    send(envelope: Envelope): void;
    /** Publish a fresh local configuration snapshot while this daemon is running. */
    refreshHello(): void;
    /**
     * POSTs the outbox through long-poll in chunks of at most
     * `MAX_MESSAGES_PER_BATCH` (finding P1) — the server hard-caps a single
     * `/byok/messages` batch there (`MessagesSendRequestSchema`, protocol
     * §8.2) and 400s the WHOLE request if it's exceeded, which — before this
     * fix — meant more than that queued during an outage produced an oversize
     * batch that the server would reject forever, since the client re-queued
     * and retried the identical (still oversize) batch unchanged. Each chunk
     * is one `LongPollClient.postBatch` call; on success the loop continues
     * (more may still be queued, or the next chunk still needs sending), on
     * failure that SAME chunk is unshifted back (order-preserving, same
     * Envelope objects/ids — never rebuilt, so a retry is exactly the resend
     * Wave 1's server-side dedup expects) and retried after a short backoff,
     * Re-entrancy is guarded by `draining`: a call arriving while a drain is
     * already in progress just returns — the in-progress loop's own
     * `while (this.outbox.length > 0)` check picks up anything newly pushed.
     */
    private drainOutbox;
    /**
     * Finding P3: backoff delay for `drainOutbox`'s long-poll retry loop.
     * Unlike a plain `setTimeout`-based wait, this is (a) cancellable —
     * `enterRevoked()` calls `cancelPendingDrainRetry()` to unblock an
     * in-flight wait immediately instead of leaving `drainOutbox` parked here
     * for up to the rest of the delay before it next checks `this.revoked` —
     * and (b) unref'd, so the timer never keeps the Node process alive by
     * itself while nothing else (such as the live long-poll GET) legitimately is.
     */
    private drainRetryDelay;
    /**
     * The capabilities the latest successful `GET /byok/events` response
     * advertised. Empty before a successful response and after a failed one.
     */
    getServerCapabilities(): readonly string[];
    getTerminalError(): ReplayCursorTooOldError | undefined;
    isConnected(): boolean;
    isRevoked(): boolean;
    /**
     * Resolves after the first successful long-poll response establishes the
     * authenticated connection.
     *
     * Rejects with {@link DeviceRevokedError} — instead of hanging until
     * `timeoutMs` — if the device turns out to be revoked while settling (or
     * already was): a cold `daemon.start()` against an already-revoked device
     * must fail fast, not surface a generic timeout (protocol §6.3).
     */
    waitForConnection(timeoutMs?: number): Promise<void>;
    /**
     * Stops the long-poll transport and waits for every in-flight envelope handler
     * (the F3 FIFO chain) and the most recent cursor write to actually land on
     * disk — otherwise a `stop()` racing a just-processed envelope's
     * persistence could lose that cursor advance, or leave a handler running
     * unobserved after the daemon reports itself stopped.
     *
     * Finding F5(b) (cross-model adversarial review): `drainTimeoutMs`, when
     * passed, bounds how long this waits for the shared outbox (`this.outbox`
     * — Design B) to actually finish draining BEFORE flipping `this.stopped`
     * and stopping the transport. Before this fix, `stop()` set `stopped`
     * synchronously and never waited for `drainOutbox` at all: an envelope
     * `send()` had just pushed moments earlier (e.g. `TaskRunner.shutdownTask`'s
     * own `task.fail`, sent right before `create-daemon.ts`'s
     * `performControlShutdown` calls this) could still be sitting UNSENT in
     * `this.outbox` — mid long-poll retry backoff, or simply not yet picked up
     * by the fire-and-forget `drainOutbox()` `send()` kicked off — and this
     * method would happily proceed to `stopped = true` regardless,
     * after which NOTHING ever drains it again: silently lost, even though
     * `TaskRunner` believed it had been sent. `drainTimeoutMs` omitted (the
     * default) preserves the EXACT prior behavior for every other existing
     * caller (an ordinary `daemon.stop()`/`unpair()`) — only the control-socket
     * shutdown path opts into the bounded wait (see `create-daemon.ts`'s
     * `performControlShutdown`). This can never claim delivery that didn't
     * happen: on a timeout, whatever's still queued stays exactly where it is
     * (readable via {@link outboxLength} immediately after this resolves) —
     * it does NOT force-flush or pretend success.
     */
    stop(drainTimeoutMs?: number): Promise<void>;
    /**
     * Finding F5(b): how many envelopes are neither confirmed delivered NOR
     * safely re-queued — meant to be read right after a bounded {@link stop}
     * call returns, to know honestly whether the drain actually finished (0)
     * or timed out with something still stuck (>0). See `create-daemon.ts`'s
     * `performControlShutdown`, which surfaces this on the `shutdown-complete`
     * audit event rather than silently claiming everything was delivered.
     *
     * Deliberately `this.outbox.length + this.inFlightBatchSize`, NOT just
     * `this.outbox.length` alone: `drainOutbox`'s long-poll branch SPLICES a
     * batch out of `this.outbox` before awaiting `postBatch` (so a concurrent
     * `send()` sees an accurate, non-double-counted queue) — while that POST
     * is in flight (or, this finding's whole point, genuinely STALLED and
     * never resolving), those envelopes have already left `this.outbox` but
     * are not delivered either. Reading `this.outbox.length` alone at exactly
     * that moment would undercount to 0 — silently implying full delivery
     * for the one case (a hung POST) this finding exists to catch honestly.
     */
    outboxLength(): number;
    /** A bounded terminal quarantine for operator inspection; these entries are never retried. */
    rejectedOutbox(): readonly RejectedOutboundEnvelope[];
    /**
     * Finding F5(b): polls {@link outboxLength} (not `this.outbox.length`
     * alone — see that method's own doc comment for why a spliced-out,
     * in-flight batch would otherwise be invisible here) rather than hooking
     * a single `drainOutbox()` promise directly — a drain in progress can
     * itself loop through multiple retry/backoff cycles (`drainRetryDelay`)
     * while the server is unreachable, and a fresh, INDEPENDENT
     * `drainOutbox()` call can also be triggered concurrently (`send()`) —
     * polling the one thing
     * that actually matters (is anything still undelivered) can never go
     * stale the way capturing one specific in-flight promise reference
     * could. Kicks off one more `drainOutbox()` attempt itself first
     * (harmless no-op if one is already running — see its own re-entrancy
     * guard) in case nothing is currently actively retrying, so this bounded
     * wait isn't just passively hoping something else happens to be making
     * progress.
     */
    private waitForOutboxDrained;
    /**
     * Findings F2 + F3. Two rules, both pinned in docs/protocol.md §1.2/§9:
     *
     * - F2 (redelivery dead on reconnect): cursor accounting covers ONLY
     *   `task.*` envelopes. `conn.ack` carries a `seq` too (required by the
     *   schema for schema uniformity across every server->daemon type), but a
     *   reconnecting server sends it BEFORE replaying the backlog and always
     *   assigns it the next (i.e. highest-so-far) per-device seq — advancing
     *   the cursor for it would make every backlog envelope's (necessarily
     *   lower) seq look already-delivered and drop it. `conn.*` envelopes
     *   never advance the cursor.
     * - F3 (at-most-once): the old code persisted the cursor advance BEFORE
     *   `onEnvelope` even ran (fire-and-forget) — a handler that then failed
     *   left a redelivery-proof envelope permanently marked processed. Inbound
     *   handlers may run independently; their receipt commits are serialized.
     *   The cursor only advances
     *   AFTER the handler resolves successfully; a rejection leaves the
     *   cursor where it was (see `stalledAtSeq`), so a future reconnect's
     *   redelivery re-attempts it — safe because every server->daemon type is
     *   documented idempotent (protocol §9).
     */
    private deliver;
    /** A committed terminal can settle a failed offer receipt even if cloud
     * cancellation has since filtered that offer from mailbox replay. */
    retryTaskReceipts(taskId: string): void;
    /** Only a durable acknowledgement can deduplicate a whole prefix. */
    private dedupWatermark;
    private process;
    /** Recorded synchronously at receive, before a later successful receipt can commit. */
    private noteValidationFailure;
    private advanceCursor;
    private quarantineRejectedOutbound;
    private notifySettled;
    private noteConnected;
    private noteDisconnected;
    private enterReplayCursorTooOld;
    private enterRevoked;
}
// ==== @byok-sdk/client dist/daemon/control-protocol.d.ts ====
import { type TaskState } from '@byok-sdk/protocol';
import type { ApprovalDecision, PendingApproval } from './approvals';
import type { StorageCategory } from './journal/journal';
import type { StoragePressureState } from './journal/storage-policy';
import type { OperationalHealthSnapshot } from './operational-health';
import type { LocalAgentReleaseIdentity } from '../release-identity';
import type { McpToolsetConfig, McpToolsetRegistryStatus } from '../types';
import type { AgentHomeExecutionStatus } from '../agent-home';
import type { InputPreparationCancelParamsV1, InputPreparationLookupParamsV1, InputPreparationReceiptV1, InputPreparationRequestV1 } from '../input-preparation';
/**
 * M4 Phase 2: shared local-IPC contract between the daemon's control server
 * (`control-server.ts`) and the CLI's control client (`bin/control-client.ts`)
 * — frame shapes, endpoint path/pipe-name derivation, and the HMAC handshake
 * math. Both sides import from here so the two can never independently drift
 * (e.g. a mismatched HMAC label string, or a socket path computed two
 * slightly different ways).
 *
 * Transport: NDJSON (one JSON object per line) over a Unix domain socket
 * (darwin/linux) or a Windows named pipe — both addressed by the same
 * path-like string via Node's `net` module, so neither `control-server.ts`
 * nor `bin/control-client.ts` needs to special-case the transport itself,
 * only the path/pipe-name derivation below.
 */
export declare const CONTROL_PROTOCOL_VERSION = 1;
/** Handshake must complete within this long, on both sides — see each side's own timer. */
export declare const HANDSHAKE_TIMEOUT_MS = 3000;
/**
 * The Unix domain socket path for a daemon rooted at `storeDir`. Prefers
 * `<storeDir>/control.sock` (keeps every one of this daemon's local state
 * files under one directory, which is already created+chmod'd 0700 by the
 * time this matters — see `control-server.ts`'s `startControlServer`);
 * falls back, whenever the natural path would risk exceeding {@link
 * UNIX_SOCKET_PATH_SOFT_LIMIT}, to a short, deterministic path nested under
 * a PER-DAEMON PRIVATE subdirectory of {@link CONTROL_SOCKET_FALLBACK_ROOT}
 * — derived from a hash of `storeDir` alone, so both the daemon and any CLI
 * invocation pointed at the same `storeDir` independently compute the
 * identical fallback path.
 *
 * That root was `os.tmpdir()` until it was proven to break both halves of
 * that sentence: it reads `TMPDIR`, so the daemon (under a service manager)
 * and the CLI (in an operator shell) derived DIFFERENT addresses for one
 * store, and under a `TMPDIR` nested in the same long tree the fallback came
 * out LONGER than the path it escaped — `bind()` `EINVAL`, and the daemon
 * ran on with no control socket at all.
 *
 * Nested one level deep (rather than a bare `<hash>.sock` file directly in
 * that shared, world-traversable root) specifically so
 * `control-server.ts`'s `bindControlEndpoint` can create+chmod that
 * subdirectory 0700 BEFORE ever binding inside it — the directory's own
 * mode gates traversal into it regardless of the socket file's own
 * (briefly default-permissioned, until the post-bind `chmod`) mode, closing
 * what would otherwise be a real window for another user on the same
 * machine to reach a socket living directly in a shared tmpdir.
 */
export declare function controlSocketPath(storeDir: string): string;
/**
 * The Windows named pipe name for a daemon identified by `productId` +
 * (`path.resolve`-normalized) `storeDir`. Named pipes have no filesystem
 * path (no stale-file cleanup concern the way Unix sockets have — see
 * `control-server.ts`), but DO share one flat namespace across the whole
 * machine, so the name must be scoped to this exact daemon instance: two
 * different products, or two different store directories (e.g. two agents
 * of the same product — see `templates/service/README.md`'s "running
 * multiple agents" section), must never collide. `storeDir` is resolved
 * before hashing so a trivial path-form difference (trailing slash, etc.)
 * between the two sides can't split the name.
 *
 * NOT keyed by the OS user: a WinSW-installed service runs the daemon under
 * the Windows service account (e.g. `SYSTEM`) while the operator CLI runs
 * as the interactive user, so both sides must derive the identical name
 * from the same `storeDir` alone. Impostor servers are defeated by the
 * mutual HMAC handshake below, not by pipe-name secrecy — keying by user
 * was security theater that broke the service-account topology.
 */
export declare function controlPipeName(productId: string, storeDir: string): string;
/**
 * Dispatches to {@link controlPipeName} on `win32`, {@link controlSocketPath}
 * everywhere else. `platform` defaults to `process.platform`; overridable
 * for tests exercising a specific platform's branch on any host (mirrors
 * `lifecycle/create-service-lifecycle.ts`'s identical `platform` override —
 * the REAL win32 named-pipe semantics can only be proven on actual Windows,
 * which CI's `ipc-smoke` job does; this override just makes the PATH-CHOICE
 * logic itself testable everywhere).
 */
export declare function controlEndpointPath(productId: string, storeDir: string, platform?: NodeJS.Platform): string;
/** Where the daemon writes its per-session control-auth token (see the handshake section below). Always a real file, even on Windows (pipes have no path of their own to piggyback secrets on). */
export declare function controlTokenPath(storeDir: string): string;
export declare function randomNonceHex(): string;
/** What the server proves to the client: it holds `token`, bound to the client's own nonce so a captured proof can't be replayed against a different handshake. */
export declare function computeServerProof(token: string, clientNonce: string): string;
/** What the client proves to the server, symmetrically, bound to the server's nonce. */
export declare function computeClientAuth(token: string, serverNonce: string): string;
/** Constant-time hex-string comparison (`crypto.timingSafeEqual` requires equal-length buffers; a length mismatch is itself a safe, immediate "not equal" — no early-exit on content). */
export declare function timingSafeEqualHex(a: string, b: string): boolean;
export interface ClientHello {
    v: 1;
    hello: 'client';
    nonce: string;
}
export interface ServerHello {
    v: 1;
    hello: 'server';
    proof: string;
    nonce: string;
}
export interface ClientAuth {
    v: 1;
    auth: string;
}
export interface ServerReady {
    v: 1;
    ready: true;
}
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function parseClientHello(value: unknown): ClientHello | undefined;
export declare function parseServerHello(value: unknown): ServerHello | undefined;
export declare function parseClientAuth(value: unknown): ClientAuth | undefined;
export declare function parseServerReady(value: unknown): ServerReady | undefined;
export interface RawControlRequest {
    /** Not narrowed to `1` here on purpose — an unexpected value is a `bad_version` RESPONSE, not a parse failure; see `control-server.ts`. */
    v: unknown;
    id: string;
    method: string;
    params?: unknown;
}
/** Loose shape check for an incoming request line: only `id`/`method` need to be well-formed for the server to be able to respond at all (including a `bad_version`/`unknown_method` response) — `v` is deliberately passed through unvalidated. */
export declare function parseRawControlRequest(value: unknown): RawControlRequest | undefined;
export interface ControlErrorShape {
    code: string;
    message: string;
}
export interface ControlResponseOk {
    v: 1;
    id: string;
    ok: true;
    result?: unknown;
    /** Present (and `true`) only on the final frame of a streaming method — see `control-server.ts`'s dispatch. */
    done?: true;
}
export interface ControlResponseErr {
    v: 1;
    id: string;
    ok: false;
    error: ControlErrorShape;
}
export type ControlResponse = ControlResponseOk | ControlResponseErr;
export interface ControlEventFrame {
    v: 1;
    id: string;
    event: unknown;
}
export declare function encodeFrame(frame: unknown): string;
/** Thrown by a method handler to control the wire error `{code, message}` a caller sees — anything else thrown surfaces as a generic `internal_error`. See `control-server.ts`'s dispatch and `bin/control-client.ts`'s `request()` (which re-throws this same class on the client side). */
export declare class ControlError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Bound on a single NDJSON line's byte length. Every real frame this
 * protocol ever sends (handshake frames, requests/responses/events) is well
 * under this — it exists purely as a defensive cap against a misbehaving or
 * hostile peer streaming an unterminated line forever to grow `pending`
 * without bound. Exceeding it is a fail-closed condition: {@link
 * NdjsonLineReader.push} throws, and every caller (`control-server.ts`,
 * `bin/control-client.ts`) destroys the connection on that throw.
 */
export declare const MAX_LINE_BYTES: number;
/**
 * Buffers raw socket bytes and yields complete lines. Splits on the raw byte
 * `0x0a` BEFORE any UTF-8 decoding (mirrors `bin/audit-log.ts`'s
 * `followAuditLog`) — `0x0A` can only ever appear as an actual newline in
 * valid UTF-8, so this never risks decoding a multi-byte character that
 * happened to straddle a chunk boundary.
 */
export declare class NdjsonLineReader {
    private pending;
    /** @throws if the still-unterminated remainder exceeds {@link MAX_LINE_BYTES} — see that constant's own doc comment. */
    push(chunk: Buffer): string[];
}
export interface ControlActiveTask {
    taskId: string;
    state: TaskState;
}
/**
 * M4 Phase 4 (part B.3, observability): a cheap per-active-task queue-depth
 * watermark for the `status` result. The IDEAL metric here would be each
 * runtime adapter's own event-queue depth (`util/async-queue.ts`'s
 * `AsyncQueue`) — but that queue lives inside each adapter's concrete
 * `Session` implementation, and `Session.events` (`types.ts`) is typed only
 * as a plain `AsyncIterable<AgentEvent>`, which has no queryable backlog
 * size; reaching it would mean adding a new method to the `Session`
 * interface AND implementing it in all three bundled adapters
 * (pi/claude/codex), which is out of scope for this pass. This instead
 * reflects two things `TaskRunner` already cheaply knows about the SAME
 * task without any new plumbing: how much progress is buffered locally
 * (not yet flushed as a `task.progress` batch), and how many out-of-band
 * approval requests are currently in flight for it. See
 * `task-runner.ts`'s `getQueueWatermarks` for how each field is computed.
 */
export interface TaskQueueWatermark {
    taskId: string;
    /** Events buffered in this task's `ProgressBatcher`, not yet flushed as a `task.progress` batch. */
    progressBatcherPending: number;
    /** Approval requests currently in flight for this task: 1 if one is actively dispatched (registered + `task.await_approval` sent) plus however many more are queued behind it (M4 Phase 4 fold-in — see `TaskRunner.requestApproval`). */
    pendingApprovals: number;
}
/**
 * S3b (L-003): local storage usage and pressure, as the `status` method
 * reports them (architecture §12.7.2.1).
 *
 * Named `storage*` throughout, NOT `watermark*`: {@link TaskQueueWatermark}
 * above is a per-task progress-buffer depth and has nothing to do with disk.
 * Two unrelated concepts sharing a name on one status result is how an
 * operator reads the wrong number during an incident.
 *
 * Present only when a daemon actually runs a storage policy
 * (`DaemonConfig.hostedJournal.storagePolicy`). Absent means "not measured",
 * which is a different statement from "measured, and fine" — so it is an
 * absent field rather than a zeroed one.
 */
export interface ControlStorageStatus {
    /** §12.7.2.1's four states. `hard-pressure` declines new offers; `emergency` refuses to ack at all. */
    pressureState: StoragePressureState;
    /** `maxStoreBytes` — the budget `usedBytes` is measured against. */
    budgetBytes: number;
    /** Total across every category below, as of `measuredAt`. */
    usedBytes: number;
    /** Bytes available to this daemon on the store's filesystem — the free-space axis of the watermark, independent of the budget. */
    freeBytes: number;
    measuredAt: string;
    /** The five §12.7.2.1 categories, always reported separately — a single total cannot drive a category-scoped cleanup order or a category-scoped never-delete list. */
    categories: ControlStorageCategoryUsage[];
    /** The most recent bounded WAL checkpoint + incremental vacuum, if one has run in this daemon's lifetime. */
    lastCompaction?: ControlStorageCompaction;
}
export interface ControlStorageCategoryUsage {
    category: StorageCategory;
    bytes: number;
    /** `true` when this is a host-reported or sampled figure rather than one measured off the filesystem. */
    approximate: boolean;
}
export interface ControlStorageCompaction {
    checkpointed: boolean;
    walFramesRemaining: number;
    pagesVacuumed: number;
    durationMs: number;
    at: string;
}
/** Result shape for the `status` method — see `create-daemon.ts`'s control-method wiring for how each field is sourced, and `bin/format.ts`'s `formatLiveStatusLines` for how the CLI renders it. */
export interface ControlStatusResult {
    /** Process-immutable Local Agent application release; absent only for an older control peer. */
    localAgentRelease?: Readonly<LocalAgentReleaseIdentity>;
    pid: number;
    uptimeMs: number;
    paired: boolean;
    deviceId?: string;
    /** The connection state machine's current value: `'open'`, `'revoked'`, `'closed'`, or `'connecting'`. */
    transport: string;
    activeTasks: ControlActiveTask[];
    runtimeIds: string[];
    /** M4 Phase 4 (part B.3): per-active-task queue watermarks — see {@link TaskQueueWatermark}. */
    queueWatermarks: TaskQueueWatermark[];
    /**
     * Finding F4 (cross-model adversarial review): the actual pending
     * approvals currently dispatched — the SAME entries `approvals.list`
     * returns (`ApprovalRegistry.list()`), surfaced here too so a single
     * `status` call can show an operator every `approvalId` they'd need to
     * `approve`/`reject`, without a second control-socket round trip. This is
     * `approvalsPending`'s own source list (`approvalsPending ===
     * approvals.length`, always).
     */
    approvals: PendingApproval[];
    /** M4 Phase 4 (part B.3): total approvals currently DISPATCHED (registered) across the whole daemon — the same count `approvals.list` returns, surfaced here too for a one-call status view. */
    approvalsPending: number;
    /** S3b (L-003): local storage usage + pressure — see {@link ControlStorageStatus}. Absent unless a storage policy is configured. */
    storage?: ControlStorageStatus;
    /** Local lifecycle/retry budget. This is not the transport state above. */
    operationalHealth: OperationalHealthSnapshot;
    /** Redacted content-addressed status from the daemon's single local registry. */
    toolsets: McpToolsetRegistryStatus;
    /**
     * WP0: per-canonical-Agent-home execution serialization, counts only —
     * see {@link AgentHomeExecutionStatus}. Absent only for an older control
     * peer that predates the cap.
     */
    agentHomeExecution?: AgentHomeExecutionStatus;
}
export interface ToolsetsReloadParams {
    expectedRevision: string;
    mcpToolsets: Record<string, McpToolsetConfig>;
}
/** Maximum opaque pairing-code payload accepted over local control IPC. */
export declare const ENROLLMENT_PAIRING_CODE_MAX_BYTES = 1024;
export interface EnrollmentPairParams {
    pairingCode: string;
}
/**
 * Exact shape gate for service-identity pairing. The code is opaque server
 * authority: this only bounds transport bytes and rejects unknown fields; it
 * never parses, normalizes or logs the code.
 */
export declare function parseEnrollmentPairParams(value: unknown): EnrollmentPairParams | undefined;
/** Shape-only parser; executable definition validation remains registry-owned. */
export declare function parseToolsetsReloadParams(value: unknown): ToolsetsReloadParams | undefined;
export interface ApprovalsListResult {
    approvals: PendingApproval[];
}
export type { ApprovalDecision, PendingApproval } from './approvals';
export interface ApprovalsResolveParams {
    approvalId: string;
    decision: ApprovalDecision;
    reason?: string;
}
export declare function parseApprovalsResolveParams(value: unknown): ApprovalsResolveParams | undefined;
/**
 * M4 Phase 3: the control method `byok-approval-mcp` (`bin/byok-approval-mcp.ts`)
 * calls FROM a claude-spawned MCP-server child process — a genuinely
 * different OS process from the daemon, reachable only over this same
 * control socket (see `../types.ts`'s `ApprovalChannel` doc comment for the
 * full why). `taskId` correlates the request to an active task;
 * `summary` is a short, human-readable description of the gated action
 * (carried verbatim into the wire `task.await_approval.summary`).
 */
export interface ApprovalsRequestParams {
    taskId: string;
    summary: string;
}
export declare function parseApprovalsRequestParams(value: unknown): ApprovalsRequestParams | undefined;
/** Result of `approvals.request` — the outcome `byok-approval-mcp` translates into its own MCP `allow`/`deny` answer. */
export interface ApprovalsRequestResult {
    approved: boolean;
    reason?: string;
}
export interface AgentMessagePublishParams {
    contextToken: string;
    contentType: 'text/plain' | 'text/markdown';
    body: string;
}
export declare function parseAgentMessagePublishParams(value: unknown): AgentMessagePublishParams | undefined;
export interface AgentMessagePublishResult {
    messageId: string;
    state: 'staged' | 'pending';
}
export interface AgentMemoryRecallParams {
    contextToken: string;
    path: string;
    ifRevision?: string;
}
export interface AgentMemorySaveParams {
    contextToken: string;
    op: 'replace' | 'delete';
    path: string;
    expectedRevision: string;
    content?: string;
}
/** Parser only validates the local IPC shape. Agent identity and memory root stay daemon-owned. */
export declare function parseAgentMemoryRecallParams(value: unknown): AgentMemoryRecallParams | undefined;
export declare function parseAgentMemorySaveParams(value: unknown): AgentMemorySaveParams | undefined;
/**
 * Params for `assertion.issue`: a sibling local process (the host's own CLI,
 * installed alongside this daemon) asking the daemon to mint one short-lived,
 * audience-scoped device assertion with the paired device key. See
 * `@byok-sdk/core`'s `device-assertion.ts` for the envelope, and
 * `create-daemon.ts`'s handler for the six fail-closed gates every call passes
 * through in a fixed order.
 *
 * One field, and nothing else. In particular there is deliberately no caller
 * identity, no requested TTL, and no requested claim set: every process running
 * as this UID can reach the control socket, so anything a caller "tells" the
 * daemon about itself is decoration, and a caller-chosen lifetime is just the
 * TTL ceiling handed to whoever asks.
 */
export interface AssertionIssueParams {
    audience: string;
}
/**
 * Bound on the `audience` a caller may send, in UTF-8 bytes — mirrors
 * `@byok-sdk/core`'s `DEVICE_ASSERTION_AUDIENCE_MAX_BYTES`. Restated here rather
 * than imported so the WIRE bound is checked before anything reaches the claim
 * schema: this is the frame-level shape gate, and it must reject an oversized
 * value without that value ever reaching a signer or an audit line.
 */
export declare const ASSERTION_AUDIENCE_MAX_BYTES = 256;
/**
 * Strict shape check. `undefined` means `bad_request` — a distinct gate from
 * `audience_denied` (see `create-daemon.ts`): "you sent something that is not a
 * request" and "you asked for an audience you may not have" are different
 * facts, and collapsing them would let a caller probe the allowlist by
 * malforming requests.
 *
 * Rejects an unknown key outright rather than ignoring it. A tolerated extra
 * field is how a future caller comes to believe it can influence the claim set.
 */
export declare function parseAssertionIssueParams(value: unknown): AssertionIssueParams | undefined;
/**
 * Result of `assertion.issue`. `assertion` is the full signing envelope
 * (`DeviceAssertionEnvelopeV1`), carried as an opaque JSON value on this wire —
 * the caller hands it to the host's cloud, which parses and verifies it with
 * core's own `verifyDeviceAssertion`. `expiresAt` is repeated outside the
 * envelope purely so a caller can schedule a refresh without parsing claims it
 * has no business interpreting.
 */
export interface AssertionIssueResult {
    assertion: unknown;
    expiresAt: string;
}
/**
 * The six `ControlError` codes `assertion.issue` can answer with, in the exact
 * order the handler checks them (`create-daemon.ts`). Each one is a distinct
 * refusal with a distinct cause; none of them ever signs anything.
 *
 * - `assertion_disabled` — this daemon has no `deviceAssertion` config, or an
 *   empty audience allowlist. The feature is OFF by default.
 * - `bad_request` — params were not `{audience: string}` within the byte bound.
 * - `audience_denied` — the audience is not in the configured allowlist. The
 *   message never echoes the allowlist: a refusal must not be an enumeration
 *   oracle.
 * - `shutting_down` — a shutdown has been requested. Closes the window between
 *   the shutdown RPC being acknowledged and the control socket actually
 *   closing, during which a device that is being unpaired could otherwise still
 *   mint credentials.
 * - `revoked` — the server has revoked this device.
 * - `not_paired` — there is no device record on disk (never paired, or already
 *   cleared).
 */
export declare const ASSERTION_ISSUE_ERROR_CODES: readonly ['assertion_disabled', 'bad_request', 'audience_denied', 'shutting_down', 'revoked', 'not_paired'];
export type AssertionIssueErrorCode = (typeof ASSERTION_ISSUE_ERROR_CODES)[number];
/**
 * Params for `task_assertion.issue`: the MCP child of ONE admitted host
 * toolset server asking the daemon to mint a task-scoped assertion for one
 * upcoming tool invocation.
 *
 * A SEPARATE method from `assertion.issue`, not an optional field on it. The
 * two lanes have zero interchange (§8.1): a device caller must not be able to
 * reach the task signer by adding a field, and a task caller must not be able
 * to fall back to a device assertion by dropping one. Two methods make that a
 * property of the dispatch table rather than of a branch inside one handler.
 *
 * Exactly two fields, and in particular NOT `taskId`, `agentRef` or
 * `toolsetId`: those are what the assertion asserts, and they come from the
 * daemon's own registry entry for `contextToken`. Every process running as this
 * UID can reach the control socket, so a caller-supplied identity would be
 * synthesized authority — the nonce is evidence precisely because only the
 * child the daemon spawned for this task ever received it.
 */
export interface TaskAssertionIssueParams {
    contextToken: string;
    audience: string;
}
/**
 * Bound on the `contextToken` a caller may send. The daemon's own nonce is 43
 * characters (32 CSPRNG bytes, base64url); this frame-level bound simply stops
 * an unbounded string from reaching the registry lookup or an audit line, the
 * same role `ASSERTION_AUDIENCE_MAX_BYTES` plays for the audience.
 */
export declare const TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES = 256;
/**
 * Strict shape check. `undefined` means `bad_request`.
 *
 * Rejects an unknown key outright — including `taskId`/`agentRef`/`toolsetId`.
 * A tolerated extra field here is exactly how a caller would come to believe it
 * can influence the claim set, which is the one thing this lane exists to
 * prevent.
 */
export declare function parseTaskAssertionIssueParams(value: unknown): TaskAssertionIssueParams | undefined;
/**
 * Result of `task_assertion.issue`. `assertion` is a full
 * `TaskAssertionEnvelopeV1`, carried opaquely on this wire exactly as the
 * device lane carries its own envelope.
 */
export interface TaskAssertionIssueResult {
    assertion: unknown;
    expiresAt: string;
}
/**
 * The nine `ControlError` codes `task_assertion.issue` can answer with, in the
 * exact order the handler checks them (`create-daemon.ts`). The device lane's
 * six are unchanged and in the same relative order — the task lane inherits the
 * device gates rather than defining a second, looser sequence — with one gate
 * ahead of them that only this lane has, and two behind them that make it
 * task-scoped:
 *
 * - `capability_undeclared` — contract §8.1's capability gate
 *   (`host-mcp-task-context`) is not in place: either this daemon issues no
 *   assertions at all, or it has not read a deployment declaration that names
 *   the capability. Checked immediately after `assertion_disabled` and BEFORE
 *   the params are even parsed, because a daemon that cannot serve this lane
 *   has nothing to say about the shape of a request for it. §8.3 is what makes
 *   this a refusal rather than a degradation: an undeclared task lane is
 *   `unavailable`, never a reason to reach for a device assertion.
 *
 * - `context_token_invalid` — no registry entry for this token. Deliberately
 *   the SAME answer for "never existed" and "existed, and its task has since
 *   been cleaned up": distinguishing them would turn the refusal into a probe
 *   for which tasks this device has run.
 * - `context_revoked` — the entry exists and its task's authority has been
 *   withdrawn locally (cancel accepted, terminal reached, or shutdown). This is
 *   the daemon's SECOND fail-closed layer (I12): the authoritative revocation
 *   point is the host's own cancel/End commit, and an assertion already in a
 *   caller's hands is not recalled by this refusal.
 */
export declare const TASK_ASSERTION_ISSUE_ERROR_CODES: readonly ['assertion_disabled', 'capability_undeclared', 'bad_request', 'audience_denied', 'shutting_down', 'revoked', 'not_paired', 'context_token_invalid', 'context_revoked'];
export type TaskAssertionIssueErrorCode = (typeof TASK_ASSERTION_ISSUE_ERROR_CODES)[number];
export type ShutdownReason = 'unpair' | 'operator';
export interface ShutdownParams {
    reason?: ShutdownReason;
}
export declare function parseShutdownParams(value: unknown): ShutdownParams;
export interface TeamWorkspaceCreateParams {
    workspaceId: string;
    members: string[];
    limits: {
        maxMembers: number;
        maxMessages: number;
        maxBytes: number;
    };
}
export interface TeamWorkspaceJoinParams {
    workspaceId: string;
    memberId: string;
    ttlMs?: number;
}
export interface TeamContextParams {
    context: string;
}
export interface TeamMessagePostParams extends TeamContextParams {
    body: string;
    contentType?: string;
}
export interface TeamMessageReadParams extends TeamContextParams {
    afterSeq?: number;
}
export interface TeamMessageAckParams extends TeamContextParams {
    throughSeq: number;
}
export interface TeamMessageInspectParams {
    workspaceId: string;
    afterSeq?: number;
}
export declare function parseTeamWorkspaceCreateParams(value: unknown): TeamWorkspaceCreateParams | undefined;
export declare function parseTeamWorkspaceJoinParams(value: unknown): TeamWorkspaceJoinParams | undefined;
export declare function parseTeamContextParams(value: unknown): TeamContextParams | undefined;
export declare function parseTeamMessagePostParams(value: unknown): TeamMessagePostParams | undefined;
export declare function parseTeamMessageReadParams(value: unknown): TeamMessageReadParams | undefined;
/** Exact local operator RPC; the shared read-parameter shape has no model identity fields. */
export declare function parseTeamNotificationSnapshotParams(value: unknown): TeamMessageReadParams | undefined;
export declare function parseTeamMessageAckParams(value: unknown): TeamMessageAckParams | undefined;
export declare function parseTeamMessageInspectParams(value: unknown): TeamMessageInspectParams | undefined;
/**
 * The three wire methods of the B-P2 local primitive, named the way every other
 * unary method on this socket is named (`<snake_case noun>.<verb>`, e.g.
 * `toolsets.reload`, `task_assertion.issue`).
 *
 * `prepare` is the closest task-free precedent to `toolsets.reload`: it mutates
 * only daemon-local durable state behind the existing HMAC handshake, creates
 * no task, claim, Execution or nonce, and returns a receipt rather than a
 * capability.
 */
export declare const INPUT_PREPARATION_PREPARE_METHOD = "input_preparation.prepare";
export declare const INPUT_PREPARATION_LOOKUP_METHOD = "input_preparation.lookup";
export declare const INPUT_PREPARATION_CANCEL_METHOD = "input_preparation.cancel";
/** Result of all three methods: exactly one receipt, never a bare digest or a raw artifact. */
export interface InputPreparationResult {
    receipt: InputPreparationReceiptV1;
}
/**
 * Bound on one identifier-shaped wire string (`requestId`, `deviceId`,
 * `agentRef`, `profileId`, revisions, digests). Frame-level only: the values
 * themselves are authority-owned and are never parsed or normalized here.
 */
export declare const INPUT_PREPARATION_IDENTIFIER_MAX_BYTES = 512;
/**
 * Why `input_preparation.prepare` params were refused.
 *
 * Two distinct codes, because they are two distinct facts. `bad_request` is
 * "this is not the shape" — a wrong type, a missing field, an unknown extra.
 * `unsupported_input` is "this is the OLD shape": the caller sent a key this
 * contract retired, which means it is asserting authority over the tool
 * manifest that version 2 moved onto the device. Answering that with a generic
 * shape error would leave the caller adjusting field types forever.
 */
export type InputPreparationRequestParseResult = {
    readonly ok: true;
    readonly request: InputPreparationRequestV1;
} | {
    readonly ok: false;
    readonly code: 'bad_request' | 'unsupported_input';
    readonly detail: string;
};
/**
 * Strict shape gate for `input_preparation.prepare`.
 *
 * Every object is key-exact: an unknown field anywhere in the request is a
 * rejection, never an ignored extra — a tolerated field is how a caller comes
 * to believe it can influence the compiled body, the runtime identity or the
 * policy this daemon enforces.
 *
 * This gate validates SHAPE only. Scope authority, policy revision, runtime
 * identity, the tool manifest and every limit are resolved by
 * `input-preparation-service.ts`; none of them can be asserted here by a
 * caller.
 */
export declare function parseInputPreparationRequestParams(value: unknown): InputPreparationRequestParseResult;
/** Strict shape gate for `input_preparation.lookup`. */
export declare function parseInputPreparationLookupParams(value: unknown): InputPreparationLookupParamsV1 | undefined;
/** Strict shape gate for `input_preparation.cancel`. Same two fields as lookup, and no third. */
export declare function parseInputPreparationCancelParams(value: unknown): InputPreparationCancelParamsV1 | undefined;
// ==== @byok-sdk/client dist/daemon/create-daemon.d.ts ====
import type { AgentEgressPolicy, RuntimeId } from '@byok-sdk/protocol';
import type { PermissionPolicy } from '@byok-sdk/protocol';
import type { RuntimeAdapter, GitWorkspaceConfig, McpToolsetConfig, McpToolsetObservation, McpToolsetRegistryStatus, McpToolsetReloadReceipt } from '../types';
import { type AgentHomeExecutionStatus, type AgentHomeProjection } from '../agent-home';
import type { AgentRef } from '../agent-home';
import { type LocalAgentReleaseIdentity } from '../release-identity';
import { type InputPreparationAuthorityResolver, type InputPreparationCounterAdapter, type InputPreparationLimitsPolicyV1 } from '../input-preparation';
import type { ToolImplementationAuthority } from './tool-implementation-identity';
import { type OperationalHealthSnapshot } from './operational-health';
import { type DaemonEventListener, type DaemonTaskInfo, type Unsubscribe } from './observer';
import { GitWorkspaceManager } from './git-workspace';
import { GitWorkspaceStore } from './git-workspace-store';
import { type DeviceEnrollment } from './store';
import { type LocalTaskJournal } from './journal/journal';
import { type JournalOpenFaultSeam } from './journal/sqlite-support';
import { LocalStoragePressureEngine, type LocalStoragePolicyInput } from './journal/storage-policy';
import { type ResultDocumentExtractor } from './task-runner';
import { type ProgressBatcherOptions } from './progress-batcher';
import { type AgentEgressReliableAppendResult } from './agent-egress-controller';
import { type AgentEgressStatus } from './agent-egress-policy';
import { type AgentEgressSanitizer } from './agent-egress-sanitizer';
import type { McpLaunchCwdConfig } from './trusted-launch-cwd';
import { type SdkHelperHostConfig } from '../sdk-reserved-helper-host';
import { type AgentMemoryHostedProjection } from './agent-memory';
import type { AgentMemoryFilesystemHelperConfig } from './agent-memory-filesystem';
import { type AgentContentReadRoot } from './agent-content-read';
/**
 * Optional white-label product display info — purely opaque passthrough
 * (never interpreted, validated, or rendered by the daemon itself). Carried
 * through to `DaemonStatus.branding` (see `status()` below) so a downstream
 * CLI or audit log can render/stamp product identity without the daemon
 * needing to know anything about presentation. Deliberately a small,
 * open-ish shape rather than an exhaustive theming schema — add fields here
 * only as concrete consumers (CLI UX, audit log) need them.
 */
export interface DaemonBranding {
    /** Product/company name for banners, prompts, audit log entries, etc. */
    displayName?: string;
    /** Support/help URL surfaced alongside branding. */
    supportUrl?: string;
    /** Brand accent color (any CSS-color-like string — hex, name, etc.); not parsed or validated here. */
    accent?: string;
}
/**
 * S3b (L-002): opt-in durable local journal for hosted deployments
 * (architecture §12.7.2).
 *
 * Explicit and off by default, because it changes what an ack MEANS. With no
 * journal configured (the self-hosted default this SDK has always shipped),
 * the daemon's redelivery cursor advances on handler success exactly as
 * before. With one configured, every inbound envelope is committed and fsynced
 * to `<storeDir>/daemon.db` BEFORE the handler resolves — and since
 * `ConnectionManager` only advances the cursor once the handler resolves
 * (`connection-manager.ts`), acking before committing stops being something
 * this daemon can express, rather than something it is careful not to do.
 *
 * Turning this on when the runtime has no working `node:sqlite` is a typed
 * construction failure, not a downgrade to a file journal — see
 * `JournalUnavailableError`. That refusal is the point (§12.7.2): a journal
 * that does not fsync loses tasks only under power-cut timings, so it passes
 * every test anyone will ever run against it.
 */
export interface HostedJournalConfig {
    /**
     * The backend. Only `sqlite` today, and spelled out rather than implied by
     * the section's presence so adding a second one later is an additive change
     * to a closed set instead of a re-interpretation of an existing config.
     */
    mode: 'sqlite';
    /** Bound on waiting for the journal's write lock, ms. Defaults to the journal's own bound. */
    busyTimeoutMs?: number;
    /** Per-record byte bound. Defaults to the journal's own bound; oversized records are refused, never truncated. */
    maxRecordBytes?: number;
    /**
     * S3b (L-003): opt-in local storage policy — §12.7.2.1's watermarks,
     * classified GC, and bounded WAL compaction. See `LocalStoragePolicyInput`
     * (`journal/storage-policy.ts`); `maxStoreBytes` and `minFreeBytes` are the
     * only two a host must supply.
     *
     * Optional WITHIN hosted journal mode, and off by default there too: a
     * journal without a policy is a daemon that records durably and never
     * declines, which is exactly the right behaviour on a host that manages its
     * own disk. Setting it is what turns local storage into an admission-control
     * input — hard pressure declines new offers (retryably) while terminal
     * flush, delete, export and recovery keep running, and `emergency` refuses
     * to ack at all rather than acking a row it cannot durably record.
     */
    storagePolicy?: LocalStoragePolicyInput;
}
export interface DaemonConfig {
    /** Distribution-owned application release; observability only, never a protocol/capability gate. */
    localAgentRelease: LocalAgentReleaseIdentity;
    productName: string;
    productId: string;
    serverUrl: string;
    /** Bounds one AuthManager pair/challenge/token exchange, including response-body reads. */
    authRequestDeadlineMs?: number;
    deviceName?: string;
    /**
     * Optional override for the client-hashed physical machine identity sent
     * with `POST /byok/pair` (protocol §6.1). Defaults to `resolveMachineId`
     * over this product id, which probes one OS identifier and hashes it; a
     * host that has its own machine authority can supply it here, and one that
     * wants no supersession at all supplies `async () => undefined`.
     */
    machineId?: () => Promise<string | undefined>;
    workspaceRoot: string;
    /**
     * Strict Agent execution boundary. The host selects one absolute branded
     * storage root; the SDK alone composes `agents/<agentId>`, initializes the
     * durable home, and binds it as runtime cwd. `projection` may write opaque,
     * redacted host content into the canonical home supplied by the SDK.
     */
    agentHome?: {
        hostStorageRoot: string;
        projection?: AgentHomeProjection;
    };
    /** Optional, one-way hosted projection. Without all guards it has zero network activity. */
    agentMemory?: AgentMemoryHostedProjection;
    /**
     * Product-owned external secure-filesystem helper. The path must be absolute;
     * the SDK never searches PATH or bundles a native addon. Required for Phase
     * 2 on macOS. Windows remains fail-closed pending its native race proof.
     */
    agentMemoryFilesystem?: AgentMemoryFilesystemHelperConfig;
    /**
     * Explicit composition for SDK-reserved MCP helpers when this daemon is
     * embedded in a single-file/SEA product executable. The product entrypoint
     * must also call `runSdkReservedHelperCommand()` before its own CLI parser.
     */
    sdkHelperHost?: SdkHelperHostConfig;
    /**
     * Refuse legacy task offers locally. This is an additive capability only
     * after the SDK-owned Agent home has passed construction-time preflight.
     */
    strictAgentOnly?: boolean;
    /**
     * WP0: how many Attempts this daemon lets execute CONCURRENTLY in one
     * canonical Agent home, across every lane and every session. Default
     * {@link DEFAULT_MAX_CONCURRENT_MUTABLE_SESSIONS_PER_AGENT_HOME} (1).
     *
     * The canonical home is every Agent session's cwd, so each concurrent
     * Attempt in it is another writer of the same `MEMORY.md`, `notes/` and
     * `.git`. At the default, a second offer for a home that already has an
     * active Attempt is declined retryably before adapter preparation, the
     * claim, or any process side effect — the busy-home contract downstream
     * hosts already depend on.
     *
     * Raising it above 1 is an explicit host choice that re-enables the
     * 0.12.0 concurrent-session behaviour, including its co-writing exposure;
     * the SDK never falls back to it on its own. Validated up front, the same
     * way `maxTaskOutputBytes` is: a positive safe integer, so `0`, a negative
     * number, `NaN` and a non-integer are construction errors rather than a
     * silently reinterpreted "unlimited".
     */
    maxConcurrentMutableSessionsPerAgentHome?: number;
    /**
     * Explicit Agent-local/cloud egress selection. Omission still enforces the
     * SDK metadata/status projection, but does not advertise or admit the new
     * policy/reliable protocol surface.
     */
    agentEgress?: AgentEgressConfig;
    /**
     * Disabled by default. Enables local-only Git checkpoint repositories for
     * legacy task workspaces. Mutually exclusive with `agentHome`: strict Agent
     * execution has one canonical workspace authority.
     */
    gitWorkspace?: GitWorkspaceConfig;
    /** Disabled by default. Enables the durable local task journal — see {@link HostedJournalConfig}. */
    hostedJournal?: HostedJournalConfig;
    /**
     * Restricts which runtimes this daemon will ever use — enforced in two
     * places that must stay consistent: `createDaemon` (this file) builds its
     * bundled adapter set FROM this list (unset = all three bundled adapters
     * — pi, claude, codex; set = exactly the listed runtime ids, unknown ids
     * ignored — see `buildDefaultAdapters`), and `TaskRunner.pickAdapter`
     * (`task-runner.ts`) separately fail-closed-rejects any `task.offer`
     * naming a runtime outside this list regardless of which adapters were
     * constructed. `createDaemonWithAdapters` callers supply their own
     * `adapters` array directly, so for them this field is enforcement-only,
     * unchanged from M1/M2.
     */
    runtimeAllowlist?: string[];
    /**
     * Separate-process Pi BYOK credential boundary. Required only for a
     * `dispatchSelection` in the BYOK lane; subscription runtimes and legacy
     * Pi tasks do not invoke it.
     */
    piByokLauncher?: import('../adapters/pi/pi-adapter').PiByokLauncherConfig;
    /**
     * M5 batch-3 (workstream 1): explicit auto-select priority order for
     * `TaskRunner.pickAdapter`'s no-explicit-runtime branch (`task-runner.ts`)
     * — tried in listed order; the first candidate that is both PRESENT
     * (`adapter.detect()`) and CAPABLE (declares the offer's
     * `PermissionPolicy.mode` in its own `descriptor.capabilities.permissionModes` —
     * see `adapterSupportsMode`) wins. Unset defaults to
     * `DEFAULT_RUNTIME_PREFERENCE` (`task-runner.ts`): `['claude', 'codex',
     * 'pi']` — pi LAST, deliberately.
     *
     * Product decision: pi is this SDK's FALLBACK runtime, not its default.
     * Before this field existed, the auto-select path had no notion of
     * priority at all — it simply walked `deps.adapters` in whatever order
     * `buildDefaultAdapters`/the embedder constructed them, which for
     * `createDaemon`'s bundled set meant `ALL_RUNTIME_IDS`'s construction
     * order (`['pi', 'claude', 'codex']`) doubled as the de-facto selection
     * priority — silently making pi the default winner whenever it was
     * present, for no better reason than being listed first in an array never
     * meant to encode a priority. This field makes the real priority an
     * explicit, independently-configurable decision instead of an accident of
     * construction order — see `ALL_RUNTIME_IDS`'s own doc comment below for
     * the construction-vs-selection-order split this introduces.
     *
     * Only affects the auto-select (no `task.offer.runtime`) path — an offer
     * naming an explicit runtime is unaffected (unchanged semantics: that
     * exact adapter is used, or the offer is declined; never a fallback
     * substitution). Independent of `runtimeAllowlist` above (which restricts
     * WHICH runtimes are eligible at all): this only orders the attempt
     * sequence among whatever that allowlist, if set, already let through.
     */
    runtimePreference?: RuntimeId[];
    /**
     * The device operator's configured policy CEILING — every `task.offer`'s
     * own policy is merged against this and fail-closed-rejected if it asks
     * for more latitude than this allows (`daemon/policy.ts`'s
     * `computeEffectivePolicy`).
     *
     * M5 batch-3 (workstream 1): `workspaceRoot` set on THIS ceiling is still
     * merged into the effective policy handed to an adapter as
     * `ctx.policy.workspaceRoot` (`computeEffectivePolicy` is unchanged) — but
     * no bundled adapter (pi/claude/codex) actually reads or enforces it;
     * every adapter derives its real confinement from `ctx.workspaceDir` (the
     * daemon-created per-task directory) instead — see docs/security.md's
     * "Workspace confinement is a convention, not a sandbox" section. Setting
     * it here is therefore silently inert rather than actively dangerous by
     * itself (an OFFER independently asking for its OWN `workspaceRoot` is a
     * separate, fail-closed-declined case — see `TaskRunner.handleOffer` —
     * precisely because THAT looks like a live security control when it
     * isn't). `start()` below logs a loud, one-time `console.warn` whenever
     * this ceiling sets `workspaceRoot`, so an operator who configured it
     * expecting real enforcement finds out immediately instead of trusting a
     * control nothing honors.
     */
    permissionDefaults?: PermissionPolicy;
    storeDir?: string;
    /**
     * Opt-in host composition for a daemon launched under a different OS
     * principal than the interactive CLI (notably a WinSW service). When true,
     * an unpaired daemon holds the normal writer lease and exposes only the
     * existing HMAC-authenticated local control surface so `enrollment.pair`
     * can persist the credential under the daemon's own OS token. Absent by
     * default: ordinary foreground `start()` keeps rejecting an unpaired device.
     */
    serviceEnrollment?: {
        readonly enabled: true;
    };
    /** Optional white-label branding — see `DaemonBranding`. Carried through verbatim to `status().branding`. */
    branding?: DaemonBranding;
    /**
     * M5: per-device, per-runtime escape hatch into the environment allowlist
     * `task-runner.ts` builds each task's spawn environment from
     * (`daemon/environment.ts`'s `buildRuntimeEnv`) — keyed by runtime id
     * (`'pi' | 'claude' | 'codex'`, though not typed that narrowly here since
     * an id with no matching adapter is simply never looked up). `allow`
     * entries are exact variable names or `*`-suffixed prefixes, merged in
     * alongside that runtime adapter's own declared
     * `descriptor.environmentRequirements` — this can never override the hard
     * `BYOK_*` deny (see `environment.ts`'s own doc comment).
     */
    runtimeEnvironment?: Record<string, {
        allow?: string[];
    }>;
    /**
     * Device-local registry behind wire-level `requiredToolsets` ids. Only
     * logical ids cross the SaaS wire; MCP executable definitions stay here.
     * The first slice supports stdio servers (`command` + `args`) only and
     * deliberately has no task-provided env/header/secret surface.
     */
    mcpToolsets?: Record<string, McpToolsetConfig>;
    /**
     * M5: explicit escape hatch for `url.ts`'s `assertServerUrlAllowed` — see
     * that function's own doc comment for the full allow/deny rule. Default
     * (unset/`false`): a `serverUrl` using plaintext `http:` is only
     * accepted when its host is loopback (`localhost`/`*.localhost`,
     * `127.0.0.0/8`, `::1`); anything else over plaintext throws a typed
     * `InsecureServerUrlError` from `pair()`/`start()` below, BEFORE any
     * network call is attempted, rather than silently sending the pairing
     * code / device credentials to a remote host in the clear. Set this
     * `true` only when you have deliberately decided to accept that risk
     * (e.g. a trusted private network with no TLS terminator in front of the
     * server) — doing so also logs a loud `console.warn` (see
     * `checkServerUrl`, this file) every time it actually changes the
     * outcome. Never overrides an unsupported scheme (anything other than
     * `http:`/`https:`), which is refused unconditionally.
     */
    dangerouslyAllowInsecureRemote?: boolean;
    /**
     * M5 batch-3 (workstream 2): caps accumulated (approximate,
     * serialized-event-length) agent-event output bytes this daemon will
     * tolerate for a single task before tearing it down as a resource-limit
     * violation (`task.fail`, `retryable: false`, reason prefixed
     * `resource limit exceeded: maxTaskOutputBytes` — see
     * `MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX`, `task-runner.ts`) — see
     * `TaskRunner.pump`'s own doc comment for exactly what's counted and what
     * isn't. Default {@link DEFAULT_MAX_TASK_OUTPUT_BYTES} (64 MiB) when
     * unset.
     *
     * `0` or a negative number is a config validation error, thrown
     * synchronously from `createDaemonWithAdapters`/`createDaemon` — NOT a
     * supported way to disable the cap. Pass `Number.POSITIVE_INFINITY`
     * explicitly instead to opt out of enforcement altogether.
     */
    maxTaskOutputBytes?: number;
    /** Legacy artifact bytes only: default 16 MiB/file and 64 MiB/task, independent of event output limits. */
    artifactLimits?: {
        maxFileBytes: number;
        maxTaskBytes: number;
    };
    /** Admission and startup deadline, including pure detect/prepare waits; unresolved process owners remain quarantined. Default 30 seconds. */
    startupTimeoutMs?: number;
    /**
     * Per-EVENT inline ceiling (default {@link DEFAULT_MAX_INLINE_EVENT_BYTES},
     * 64 KiB) for the two `AgentEvent` fields a runtime authors freely:
     * `tool_use.input` and `tool_result.output`. An event whose serialization
     * exceeds this leaves `TaskRunner.pump` with that field replaced by a
     * UTF-8-safe head/tail preview (`{ preview: { head, tail } }`) and an
     * additive `spill` descriptor; the full JSON serialization is uploaded to
     * the blob plane under an idempotent, content-addressed key, and
     * `spill.blob` is where a consumer reads it back. If the upload fails the
     * preview still ships, carrying `spill.unstoredReason` instead — omission
     * is always described, never silent.
     *
     * This is a per-event bound, orthogonal to `maxTaskOutputBytes` (a
     * whole-task total, counted AFTER spilling) and to
     * `progressBatch.maxBatchBytes` (a per-batch wire budget).
     *
     * **Consumer contract:** `spill`'s presence is the only signal that the
     * inline field is a preview. A consumer that renders `tool_result.output`
     * without checking `spill` renders a truncation as the whole result.
     *
     * Must be a positive safe integer of at least
     * {@link MIN_MAX_INLINE_EVENT_BYTES} (4096) — below that a legitimate
     * `spill` descriptor no longer fits inside the cap it exists to enforce.
     * Anything else (0, negative, non-integer, `NaN`,
     * `Number.POSITIVE_INFINITY`) is a config validation error thrown
     * synchronously from `createDaemonWithAdapters`/`createDaemon`; there is
     * no opt-out, because "unbounded event" is exactly the state this exists
     * to prevent.
     */
    maxInlineEventBytes?: number;
    /**
     * Host-owned batching policy for normalized `task.progress` events.
     * `maxBatchBytes`, when set, measures exactly the UTF-8 bytes of
     * `JSON.stringify(events)` and must match the deployment's activity-ingress
     * budget. It is deliberately unset by default because that ingress ceiling
     * is deployment policy, not a frozen protocol constant.
     */
    progressBatch?: ProgressBatcherOptions;
    /**
     * additive-minor (`task.complete.document`): the seam through which this
     * product turns a finished task's final output text into the STRUCTURED
     * terminal result the wire carries as `task.complete.document`, and the
     * server projects into `TaskResult.document`.
     *
     * `extract(finalOutput, task)` is called exactly once per task, at the
     * moment `task.complete` is built, with the same text that becomes
     * `summary` (the concatenated `progress` events for that task) plus the
     * task's `taskId`/`sessionRef`. Return `undefined` for "no structured
     * result this time". Everything about the document's SHAPE is the
     * product's business — the SDK never inspects, validates, or transforms
     * it; extraction logic (prompting for JSON, parsing a fenced block,
     * validating against the product's own schema) is product glue and belongs
     * in this callback, not in the SDK.
     *
     * The SDK enforces exactly two wire rules, via the protocol's own
     * `checkResultDocument`: the value must be JSON-serializable, and at most
     * `RESULT_DOCUMENT_MAX_BYTES` (1 MiB) as canonical JSON. Stay under ~512
     * KiB in practice (docs/protocol.md); a bigger result belongs in an
     * artifact, not here.
     *
     * FAIL-CLOSED, never silent: if the extractor throws, returns a promise
     * (the seam is synchronous and the runtime enforces it — an unawaited
     * promise would be encoded as an empty document), produces something
     * unsendable, or produces a document while the connected server never
     * advertised the `result-document` capability (an old server would strip
     * the field on arrival without a word), the task is reported as
     * `task.fail` with `retryable: false` and a reason prefixed
     * `result document undeliverable` — see
     * `RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX` (`task-runner.ts`).
     * Completing a task while quietly discarding the structured result it
     * exists to produce is not an option this SDK offers.
     *
     * Omitted entirely by default, in which case the completion path is
     * unchanged in every respect — no extractor call, no capability check, and
     * a `task.complete` payload byte-identical to the one sent before this
     * field existed.
     */
    resultDocument?: {
        readonly extract: ResultDocumentExtractor;
    };
    /**
     * M5 batch-3 (workstream 2): deadline bound on the graceful-shutdown
     * sequence's own wait for `TaskRunner.shutdownActiveTasks` to finish
     * interrupting/failing every active task before this daemon proceeds to
     * actually stop regardless — see `runShutdownSequence`'s own doc comment
     * for the full sequence this bounds, and for why every graceful-shutdown
     * path (`stop()`, `unpair()`, the control socket's `shutdown` RPC) now
     * shares it. Default 10s (`SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS`) — the same
     * bound the control-socket shutdown path already used before this field
     * existed.
     */
    shutdownGraceMs?: number;
    /**
     * Cadence for the `online` presence heartbeat (§12.3), when — and only when
     * — the deployment's capability declaration contains `presence.hints` (see
     * `capabilities-client.ts`; a deployment that declares nothing, or one this
     * daemon could not read a declaration from, publishes nothing at all).
     *
     * Every field is optional and defaults to `presence-publisher.ts`'s own
     * constants, which are chosen against the hosted defaults. `ttlMs` and
     * `minimumIntervalMs` describe THE DEPLOYMENT's hint TTL and publication
     * throttle as this operator understands them: the daemon never learns either
     * from the wire, and uses them only to validate `intervalMs` sits strictly
     * between them — a cadence outside that band is rejected synchronously here,
     * the same way `maxTaskOutputBytes` is above, rather than degrading into a
     * rate-limited or flickering hint nobody sees an error for.
     */
    presence?: PresenceConfig;
    /**
     * Plan `device-assertion-broker`: opt-in local assertion broker — lets a
     * sibling process on this same machine (typically the host's own CLI,
     * installed alongside this daemon) ask the daemon, over the already
     * authenticated control socket, to mint a short-lived audience-scoped
     * assertion signed with the paired device key. See
     * {@link DeviceAssertionConfig}.
     *
     * OFF by default, and off is expressed two ways that mean the same thing: an
     * absent section, or a present one with an empty `audiences` list. Both make
     * `assertion.issue` answer `assertion_disabled` without looking at anything
     * else. A new local authentication surface does not get to be on because
     * someone left a config key behind.
     */
    deviceAssertion?: DeviceAssertionConfig;
    /**
     * B-P2 local primitive: the task-free `input_preparation.*` control surface
     * (`docs/researches/runtime-input-preparation-contract.md` §10.3).
     *
     * OFF by default. An absent section keeps the whole feature disabled and
     * makes all three methods answer `input_preparation_unconfigured` — there is
     * no default limits policy and no default authority, by the Owner-approved
     * limits boundary of 2026-09-14. The counter inside the section is
     * OPTIONAL: without one, preparations settle on the compiler's own byte
     * evidence. A PRESENT section with an
     * invalid policy is a construction error, the same discipline
     * `deviceAssertion` and the presence cadence already follow: a daemon that
     * starts with an allowance nobody validated is a daemon whose operator
     * believes a limit is in force.
     */
    inputPreparation?: InputPreparationDaemonConfig;
    /**
     * Operator input to the MCP toolset launch boundary
     * (`./trusted-launch-cwd.ts`), forwarded verbatim to
     * `TaskRunnerDeps.mcpLaunchCwd`.
     *
     * Absent means the platform default directory and — only when this process
     * is provably plain Node — `process.execPath` as the launcher interpreter.
     * Neither default is assumed: both are proven per offer, and an offer whose
     * boundary this daemon cannot prove is declined non-retryably rather than
     * started without one.
     *
     * A PRESENT section is validated here, at construction, the same discipline
     * `deviceAssertion` and `inputPreparation` follow: a non-absolute `dir`, or a
     * `launcherInterpreter` that is not an existing regular file, is a
     * construction error rather than a per-offer decline nobody reads. What
     * cannot be decided here is deliberately left to the resolver: whether the
     * directory is still non-writable is a fact about the filesystem NOW, so it
     * is proven once per offer and never cached.
     */
    mcpLaunchCwd?: McpLaunchCwdConfig;
    /**
     * The host's install-record authority for MCP toolset server
     * implementations (`./tool-implementation-identity.ts`), forwarded verbatim
     * to `TaskRunnerDeps.toolImplementationAuthority`.
     *
     * This SDK ships NO resolver and NO default, and there is nothing to
     * validate here: an absent section is the supported state, and it means
     * every implementation identity this daemon resolves is
     * `resolver_unconfigured`. An absolute path is not an attestation, so a
     * daemon without this section proves nothing about which executable serves a
     * tool call and says so rather than implying otherwise.
     *
     * What a PRESENT authority buys is the refusal: an install it attested is
     * re-measured before every spawn of that server, and a spawn whose artifact
     * no longer measures the same is declined non-retryably.
     */
    toolImplementationAuthority?: ToolImplementationAuthority;
}
/**
 * The local preparation surface. The limits policy and the authority are
 * required together: a policy without an authority would answer questions it
 * cannot back.
 *
 * The counter is OPTIONAL. Without one a preparation compiles, persists and
 * can reach ready with no counter call and no `maxCounterCallsPerScope`
 * reservation consumed: the size evidence is the artifact's
 * `requestBytes`, measured by this daemon's own compiler, and the numeric
 * budget (window, template constant, output reserve, fit) is Host authority.
 * With one, the counter is called once per preparation and its evidence must
 * be provider-authoritative and covered for the receipt to be ready.
 */
export interface InputPreparationDaemonConfig {
    /** Required explicit byte / call / deadline / retention policy. No field has a default. */
    limits: InputPreparationLimitsPolicyV1;
    /** The trusted local device/Agent/Profile authority. Unavailable authority rejects. */
    authorityResolver: InputPreparationAuthorityResolver;
    /**
     * The separately authorized, optional counter. This package ships no
     * fallback counting of any kind and no numeric budget.
     */
    counter?: InputPreparationCounterAdapter;
}
export interface AgentEgressConfig {
    /** Exact policy the daemon is willing to consume from an Agent offer. */
    policy: AgentEgressPolicy;
    /** Named redaction hook for explicit contentful trajectory only. */
    sanitizer?: AgentEgressSanitizer;
    /**
     * Device-local additions required to make one server-selected transfer
     * policy executable. These values only supplement `policy.transfers`: a
     * locally configured surface never enables a server-disabled transfer, and
     * cannot widen its maxBytes or MIME authority.
     */
    contentRead?: AgentContentReadConfig;
}
/** Local root and text handling authority for one independently-gated surface. */
export interface AgentContentReadSurfaceConfig {
    readonly root: AgentContentReadRoot;
    readonly maxTextBytes: number;
    readonly textMimeTypes: readonly string[];
    readonly sensitiveNames?: readonly string[];
}
/**
 * Host-local portions of the content-read contract. The audit ledger has no
 * host path option: SDK composition fixes it per Agent home.
 */
export interface AgentContentReadConfig {
    readonly workspace?: AgentContentReadSurfaceConfig;
    readonly transcript?: AgentContentReadSurfaceConfig;
    readonly artifact?: AgentContentReadSurfaceConfig;
    readonly runtimeAllowlistedRoots?: readonly string[];
}
export interface AgentReliableEgressInput {
    agentRef: AgentRef;
    sessionRef: string;
    /** Exact runtime identity from the durable Agent-home handoff. */
    runtimeId: string;
    /** Exact task identity from the same durable Agent-home handoff. */
    taskId: string;
    payload: unknown;
    eventId?: string;
}
/**
 * Plan `device-assertion-broker`. Two fields, both about what this daemon will
 * refuse.
 *
 * Every field is validated synchronously at construction, the same way
 * `maxTaskOutputBytes` and the presence cadence are — a misconfigured
 * authentication surface must fail when the daemon is built, not on the first
 * call that needed it.
 */
export interface DeviceAssertionConfig {
    /**
     * The EXACT audience strings this daemon will mint for. Matched with
     * `Set.has` — exact string equality, never a prefix or suffix or subdomain
     * rule.
     *
     * Prefix matching is the classic hole here: an allowlist entry of
     * `salesko-api` under a `startsWith` rule also admits `salesko-api.evil.com`,
     * and a suffix rule admits `evil-salesko-api`. There is no configuration
     * that turns this into a pattern match, because there is no pattern-matching
     * code to configure.
     *
     * An empty list means the feature is off (see
     * `DaemonConfig.deviceAssertion`). Duplicate entries, empty entries, and
     * entries over 256 UTF-8 bytes are construction errors — a duplicate is
     * usually a copy-paste that hid a typo'd second entry, and silently
     * de-duplicating it would hide it for good.
     */
    audiences: string[];
    /**
     * Assertion lifetime, ms. Default
     * `DEVICE_ASSERTION_DEFAULT_TTL_MS` (120s), hard ceiling
     * `DEVICE_ASSERTION_MAX_TTL_MS` (300s) — both from `@byok-sdk/core`, which
     * enforces the same ceiling again at verification time, so a daemon patched
     * to ignore this one still cannot get a longer-lived assertion accepted.
     *
     * Deliberately NOT caller-selectable over the control socket: a lifetime a
     * caller can ask for is a lifetime every caller asks the maximum of.
     */
    ttlMs?: number;
}
export interface PresenceConfig {
    /** Heartbeat cadence. Default 30s. */
    intervalMs?: number;
    /** The deployment's presence hint TTL. Default 90s (core §12.7.5 suggests 60-120s). */
    ttlMs?: number;
    /** The deployment's minimum interval between accepted publications. Default 5s. */
    minimumIntervalMs?: number;
}
export interface DaemonStatus {
    /** Process-immutable Local Agent application release captured at construction. */
    localAgentRelease: Readonly<LocalAgentReleaseIdentity>;
    paired: boolean;
    connected: boolean;
    /** True once the server has revoked this device (401 on challenge/token, protocol §6.3). The only recourse is calling `pair()` again — the daemon does not keep retrying on its own. */
    revoked: boolean;
    deviceId?: string;
    activeTaskCount: number;
    /** Exact terminal results retained for journal retry; nonzero requires recovery. */
    pendingTerminalCommits: number;
    /** Passthrough of `DaemonConfig.branding` — `undefined` when the product configured none. See `DaemonBranding`. */
    branding?: DaemonBranding;
    /** Local lifecycle/retry budget, separate from transport fallback state. */
    operationalHealth: OperationalHealthSnapshot;
    /** Redacted, content-addressed device-local MCP registry status. */
    toolsets: McpToolsetRegistryStatus;
    /** Content-free egress lane watermarks and typed last-drop facts. */
    egress: AgentEgressStatus;
    /** WP0: per-canonical-Agent-home execution serialization — see {@link AgentHomeExecutionStatus}. */
    agentHomeExecution: AgentHomeExecutionStatus;
}
export interface Daemon {
    /** Pairing result is intentionally credential-blind. */
    pair(pairingCode: string): Promise<DeviceEnrollment>;
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): DaemonStatus;
    /** Append one sanitized reliable record before its first transport attempt. */
    publishReliableAgentEgress?(input: AgentReliableEgressInput): Promise<AgentEgressReliableAppendResult>;
    /** Atomically replace the local registry when its current revision matches. */
    reloadMcpToolsets(mcpToolsets: Record<string, McpToolsetConfig> | undefined, expectedRevision: string): McpToolsetReloadReceipt;
    /** Record one explicit host-owned lifecycle observation for a configured toolset. */
    reportMcpToolsetObservation(toolsetId: string, expectedDefinitionRevision: string, observation: McpToolsetObservation): void;
    /**
     * M3-2a: local observability — subscribe to live `DaemonEvent`s (task
     * feed, connection/pairing state changes, runtime-detection results) as
     * they happen on THIS daemon, no SaaS-side polling required. Returns an
     * unsubscribe function; a listener that throws is caught and logged, never
     * propagated (see `observer.ts`). Purely additive: emitting these never
     * changes `status()` or any existing wire/task behavior.
     */
    subscribe(listener: DaemonEventListener): Unsubscribe;
    /** M3-2a: current locally-known tasks and their derived state/summary (for a `tasks` CLI subcommand) — reflects only what this daemon has observed since it started; see `observer.ts`'s `DaemonObserver.tasks`. */
    tasks(): DaemonTaskInfo[];
    /**
     * M3-2a: clears this device's persisted identity/credentials and
     * disconnects — the next `start()` throws until `pair()` is called again.
     * Safe to call at any point in the daemon's lifecycle (never paired,
     * paired-but-not-started, or running).
     */
    unpair(): Promise<void>;
    /**
     * M3-2a: locally resolve a task currently paused on `needs_approval` —
     * drives the exact same code path a server-sent `task.approve` does
     * (`TaskRunner.handleApprove`), invoked directly instead of over the wire.
     * Honest-but-currently-unexercised: none of the three bundled adapters
     * (pi/claude/codex) ever actually pauses for approval — each one's
     * `resolveApproval` throws unconditionally (see `toRuntimeInfoCapabilities`'s
     * doc comment below) — so calling this against a task on this daemon today
     * always fails that task with a clear reason instead of resuming it,
     * exactly as an honest, doing-nothing-magic implementation should. Ready
     * for the day a runtime adapter implements real interactive approval, with
     * no further changes needed here. A no-op (resolves immediately) for a
     * `taskId` this daemon doesn't currently have active.
     */
    approve(taskId: string): Promise<void>;
    /** M3-2a: same as {@link approve} but rejects — see that method's doc comment. */
    reject(taskId: string, reason?: string): Promise<void>;
}
/** Custom adapter composition. Available custom descriptors are published through
 * the capability-gated harness inventory; built-in RuntimeId remains closed. */
export interface DaemonOverrides {
    /** Test-only synchronous kill points; never supplied by production configuration. */
    executionRecoveryFault?: (step: 'terminal:before-send' | 'terminal:queued' | 'outbound:before-post' | 'outbound:after-ack') => void;
    /** M4 Phase 3: overrides `TaskRunner`'s default out-of-band approval wait (`DEFAULT_APPROVAL_TIMEOUT_MS`, 10 minutes) before an unanswered `requestApproval` force-resolves as a fail-closed rejection. */
    approvalTimeoutMs?: number;
    /** Finding F5: overrides for the control-socket shutdown path's own bounded waits — see `TaskRunner.shutdownTask`'s and `ConnectionManager.stop`'s own doc comments. Both default to 5s; neither affects an ordinary (non-shutdown-RPC) `daemon.stop()` call. */
    shutdown?: {
        /** Bound on how long `shutdownTask` waits for a single task's own `session.interrupt()` before giving up on it specifically and reporting `task.fail` anyway. Default `DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS`. */
        taskInterruptTimeoutMs?: number;
        /** Bound on how long the control-socket shutdown path waits for the outbox to actually drain before closing the connection. Default `DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS`. */
        outboxDrainTimeoutMs?: number;
    };
    longPoll?: {
        /** Backoff between failed long-poll HTTP attempts. Default 2s. */
        retryDelayMs?: number;
        /** Minimum delay before the next long-poll request after an empty (no-events) response — avoids busy-looping against a server that responds instantly. Default 250ms. */
        idleDelayMs?: number;
    };
    /**
     * Test/product injection seam for the local Git workspace boundary. The
     * supplied manager/store are used only when `config.gitWorkspace` is enabled;
     * an absent Git config therefore cannot accidentally activate either object.
     */
    gitWorkspace?: {
        manager?: GitWorkspaceManager;
        store?: GitWorkspaceStore;
    };
    /**
     * S3b: injection seam for the durable local journal, mirroring
     * `gitWorkspace` above — used only when `config.hostedJournal` is set, so an
     * absent journal config cannot accidentally activate a supplied object. Also
     * the host-injected-implementation path §12.7.2 allows: a backend other than
     * `SqliteLocalTaskJournal` is acceptable if it meets the same durability
     * contract (a resolved `appendEnvelope` means fsynced), and unacceptable
     * otherwise — this seam does not verify that, the host asserting it does.
     *
     * A journal supplied here is NOT closed by `stop()`; whoever injected it
     * owns its lifetime.
     */
    hostedJournal?: {
        journal?: LocalTaskJournal;
        /** Test-only post-open SQLite initialization fault seam. */
        openFaults?: JournalOpenFaultSeam;
        /**
         * S3b (L-003): injection seam for the storage pressure engine, same rule
         * as `journal` above — used only when `config.hostedJournal` is set, and
         * NOT started or stopped by this daemon. Whoever injects one owns its
         * cadence, which is what lets the disk-pressure matrix drive `tick()` by
         * hand with fake usage/free providers and no timer at all.
         *
         * An injected engine still answers both questions the daemon asks it
         * (admission under hard pressure, ack-critical refusal under emergency)
         * and still backs the `storage` section of the control-socket status.
         */
        pressureEngine?: LocalStoragePressureEngine;
    };
}
/**
 * Plan `device-assertion-broker` (codex round-2 F3): the internal, NON-public
 * test seam for observing assertion issuance.
 *
 * This is NOT reachable through `DaemonConfig`/`DaemonOverrides`, and is NOT
 * re-exported from the package `index.ts` — a test imports it straight from
 * this module. That isolation is the point. The earlier `DaemonOverrides.
 * deviceAssertion.mint` seam replaced the SIGNER, which meant a production
 * embedder (`DaemonOverrides` is public API) could inject a callback that
 * received the whole `DeviceRecord` — private key included — and exfiltrate it
 * or forge claims.
 *
 * `onIssued` is a strict OBSERVER, called only AFTER a real, successful sign,
 * with non-secret metadata ONLY (`jti`, `audience`). It cannot see the private
 * key, cannot alter the signature, the claims, or the audit event, and cannot
 * be reached from any public type. A test counts these calls to prove a gate
 * rejection never reached the signer (a rejection never calls `onIssued`).
 */
export interface AssertionIssueProbe {
    onIssued(meta: {
        jti: string;
        audience: string;
    }): void;
}
export declare function createDaemonWithAdapters(config: DaemonConfig, adapters: RuntimeAdapter[], overrides?: DaemonOverrides): Daemon;
/**
 * codex round-2 F3: the real builder. Exported from THIS module but NOT from
 * the package `index.ts`, so the optional `assertionProbe` (an
 * {@link AssertionIssueProbe} post-sign observer) is reachable only by tests
 * importing this module directly — never through any public type. The public
 * `createDaemonWithAdapters` above forwards without it, so production has no
 * observer and no signer-injection surface at all.
 */
export declare function buildDaemonWithAdapters(config: DaemonConfig, adapters: RuntimeAdapter[], overrides?: DaemonOverrides, assertionProbe?: AssertionIssueProbe): Daemon;
/**
 * Public white-label entry point (M0-M3): the "5-line launcher" — a product
 * only needs a `DaemonConfig`, no hand-built adapter list. The bundled
 * adapter set is built from `config.runtimeAllowlist` (see
 * `buildDefaultAdapters` and that field's own doc comment for the exact
 * unset-vs-set contract); with no `runtimeAllowlist` configured, the default
 * is ALL THREE bundled adapters (pi, claude, codex), not pi alone: M0/M1
 * hard-wired pi-only unconditionally, which meant any product wanting
 * claude/codex had to drop to `createDaemonWithAdapters` and hand-build
 * adapters just to get a runtime that was already built into this SDK.
 * `detectRuntimes` only ever advertises what's actually present on the
 * device (protocol §10 gap #4), so constructing an adapter for a runtime the
 * device doesn't have costs one quick failed `--version` probe at `start()`
 * and is otherwise invisible — there's no reason to withhold it by default.
 * Products that DO want to restrict to a subset set `runtimeAllowlist`
 * (also independently enforced at task-pick time — see
 * `TaskRunnerDeps.runtimeAllowlist` / `TaskRunner.pickAdapter`); products
 * needing something this can't build (custom adapter options, a fourth
 * in-house runtime, test stubs) use `createDaemonWithAdapters` directly.
 */
export declare function createDaemon(config: DaemonConfig): Daemon;
// ==== @byok-sdk/client dist/daemon/cursor-store.d.ts ====
/**
 * Persists the highest processed server->daemon envelope `seq` per
 * (server, device) pair (protocol §9, at-least-once redelivery), so a
 * restarted daemon can send an accurate `conn.hello.cursor` and the server
 * can skip re-delivering envelopes it already knows were handled. Keyed by a
 * hash of `serverUrl` + `deviceId` together (not just `serverUrl`) so
 * filenames stay filesystem-safe regardless of scheme/port/path.
 *
 * Finding F5 (stale cursor across re-pair): `POST /byok/pair` always mints a
 * brand new `deviceId` (see `packages/server/src/http.ts`), including on a
 * re-pair against the same `serverUrl` (e.g. recovering from revocation,
 * protocol §6.3). A cursor keyed by `serverUrl` alone would hand the fresh
 * device's very first connection a stale, unrelated cursor value left over
 * from whatever device previously used this URL — the new device's own
 * server-side outbox starts its `seq` counter back at 1, so that stale
 * cursor would make the server's redelivery filter (`seq > cursor`) throw
 * away every legitimate envelope sent to it. Keying by the pair means a new
 * deviceId always starts with a genuinely fresh (absent) cursor entry;
 * `clear()` additionally lets `create-daemon.ts`'s `pair()` proactively wipe
 * the previous device's entry for this `serverUrl` as a hygiene measure.
 */
export declare class CursorStore {
    private readonly storeDir;
    constructor(storeDir: string);
    private fileFor;
    load(serverUrl: string, deviceId: string): Promise<number | undefined>;
    save(serverUrl: string, deviceId: string, cursor: number): Promise<void>;
    /** Remove any persisted cursor for (serverUrl, deviceId) — a no-op if none exists. Called from `pair()` (finding F5) so a device that's about to be replaced never leaves a cursor a future, unrelated device could somehow inherit. */
    clear(serverUrl: string, deviceId: string): Promise<void>;
}
// ==== @byok-sdk/client dist/daemon/deterministic-jitter.d.ts ====
export type JitterDomain = 'reconnect' | 'upload' | 'maintenance';
export interface DeterministicJitterInput {
    seed: string;
    domain: JitterDomain;
    sequence: number;
    baseMs: number;
    ratio?: number;
}
/**
 * Stable, domain-separated fleet jitter. The same identity/domain/sequence
 * always produces the same integer delay, while a different domain cannot
 * accidentally reuse the same hash stream. There is deliberately no random
 * fallback: callers must have loaded the device identity before constructing
 * an automatic retry loop.
 */
export declare function deterministicJitterMs(input: DeterministicJitterInput): number;
export interface FleetJitter {
    delay(domain: JitterDomain, sequence: number, baseMs: number): number;
}
export declare function createFleetJitter(productId: string, deviceId: string): FleetJitter;
// ==== @byok-sdk/client dist/daemon/device-credential-store.d.ts ====
/** Secret fields inside the internal complete enrollment authority. */
export interface DeviceCredentials {
    readonly accessToken: string;
    readonly expiresAt: string;
    readonly devicePrivateKeyPem: string;
}
/** Non-secret deterministic projection of the authenticated enrollment. */
export interface DeviceMetadata {
    readonly deviceId: string;
    readonly tenantId: string;
    readonly devicePublicKey: string;
}
/**
 * The single local enrollment authority. Keeping identity and credential
 * bytes in one OS-managed entry prevents a crash from composing a token/key
 * from one pairing response with metadata from another.
 */
export type DeviceRecord = DeviceMetadata & DeviceCredentials;
/**
 * The one durable authority allowed before a first pairing response is
 * received. It keeps the generated key immutable across a lost response, so
 * an exact server-side retry can prove the same public-key binding.
 */
export interface FirstPairingAttempt {
    readonly kind: 'first-pairing-attempt-v1';
    readonly deviceName: string;
    readonly devicePublicKey: string;
    readonly devicePrivateKeyPem: string;
    readonly machineId?: string;
}
export interface DeviceCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
export type DeviceCommandRunner = (executable: string, args: readonly string[], stdin?: string) => Promise<DeviceCommandResult>;
/** Typed unavailability; callers must surface re-pair/operational failure, never write a file fallback. */
export declare class DeviceCredentialStoreUnavailableError extends Error {
    constructor(message?: string);
}
export declare class DeviceCredentialStoreError extends Error {
    constructor(message: string);
}
export interface DeviceCredentialStoreOptions {
    readonly productId: string;
    readonly platform?: NodeJS.Platform;
    readonly commandRunner?: DeviceCommandRunner;
}
/**
 * Internal OS-backed authority for the bearer token and device private key.
 * The constructor deliberately accepts no path or backend selector: real
 * callers get the platform provider; tests import this internal module and
 * inject a double directly.
 */
export declare class DeviceCredentialStore {
    #private;
    constructor(options: DeviceCredentialStoreOptions);
    read(): Promise<DeviceRecord | undefined>;
    readFirstPairingAttempt(): Promise<FirstPairingAttempt | undefined>;
    saveFirstPairingAttempt(attempt: FirstPairingAttempt): Promise<void>;
    replace(record: DeviceRecord): Promise<void>;
    /** Returns true only after the sole secret authority is confirmed absent. */
    clear(): Promise<boolean>;
}
/** Test-only double; it is intentionally internal and never selected by a production config. */
export declare class InMemoryDeviceCredentialStore {
    #private;
    read(): Promise<DeviceRecord | undefined>;
    readFirstPairingAttempt(): Promise<FirstPairingAttempt | undefined>;
    saveFirstPairingAttempt(attempt: FirstPairingAttempt): Promise<void>;
    replace(record: DeviceRecord): Promise<void>;
    clear(): Promise<boolean>;
}
export declare function runDeviceCommand(executable: string, args: readonly string[], stdin?: string): Promise<DeviceCommandResult>;
// ==== @byok-sdk/client dist/daemon/device-proof-signer.d.ts ====
import { type DeviceProofEnvelopeV1 } from '@byok-sdk/core';
import type { AuthManager } from './auth-manager';
export interface DeviceProofRequest {
    readonly method: string;
    /** Exact origin-relative path, including the query string when present. */
    readonly path: string;
    readonly operation: string;
    readonly resource: string;
    readonly requestId: string;
    readonly body: Uint8Array;
    readonly issuedAt?: string;
    readonly expiresAt?: string;
    readonly nonce?: string;
}
/** Local signing seam consumed by the truth client. It never exposes key bytes. */
export interface DeviceProofSigner {
    sign(request: DeviceProofRequest): Promise<DeviceProofEnvelopeV1>;
}
export interface StoredDeviceProofSignerOptions {
    readonly auth: Pick<AuthManager, 'readCurrent'>;
    /** Explicit host configuration. Pairing/bearer state is never mined for tenant identity. */
    readonly tenantId: string;
    readonly productId: string;
    readonly keyId: string;
    readonly keyEpoch: number;
    readonly clock?: () => Date;
}
/**
 * Signs request-bound S6 proofs with the paired device identity key.
 *
 * The authenticated enrollment authority is read for every signature rather
 * than cached: clearing the OS credential immediately removes local signing
 * authority. Canonicalization is
 * imported from `@byok-sdk/core`, the one frozen byte authority; this module only
 * supplies the Node Ed25519 operation.
 */
export declare class StoredDeviceProofSigner implements DeviceProofSigner {
    #private;
    private readonly options;
    constructor(options: StoredDeviceProofSignerOptions);
    sign(request: DeviceProofRequest): Promise<DeviceProofEnvelopeV1>;
}
// ==== @byok-sdk/client dist/daemon/environment.d.ts ====
export { LOADER_ENV_DENY_PATTERNS, loaderEnvInjections } from '@byok-sdk/implementation-identity';
/**
 * M5: per-runtime environment allowlist for spawned agent child processes.
 *
 * Before this module existed, `task-runner.ts` built every task's
 * `RuntimeOperationStartInput.env` as `process.env` verbatim — the daemon's OWN full
 * environment, unfiltered, handed to whichever runtime CLI (`pi`/`claude`/
 * `codex`) `pickAdapter` selected. Any credential-shaped variable sitting in
 * the daemon's own environment for a completely unrelated reason (an
 * `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`, `GITHUB_TOKEN` set for the
 * daemon's OWN deployment, nothing to do with any coding-agent runtime) was
 * therefore inherited by every single spawned agent process — a
 * credential-leak gap, not a deliberate design choice.
 *
 * {@link buildRuntimeEnv} replaces that blanket passthrough with an explicit
 * allowlist, built fresh per task from three layers:
 *
 * 1. A small, always-included platform baseline ({@link BASE_PLATFORM_ALLOWLIST}
 *    / {@link WINDOWS_BASE_ALLOWLIST}) — the bare minimum any CLI needs to
 *    resolve its own binaries/libraries, find a home/temp directory, and
 *    behave sanely in a non-interactive shell.
 * 2. Whatever ADDITIONAL names the *specific* runtime adapter about to be
 *    spawned declares it actually needs
 *    (`RuntimeAdapter.descriptor.environmentRequirements` — see
 *    `../types.ts`). A descriptor that declares no names gets the platform
 *    baseline only; descriptors are required and frozen before claim.
 * 3. A per-device, per-runtime operator override (`DaemonConfig
 *    .runtimeEnvironment` — see `create-daemon.ts`) — a local escape hatch
 *    for a product/operator that knows it needs one more variable forwarded
 *    to one specific runtime on this one device.
 *
 * One hard, unconditional deny always wins over all three layers above,
 * including the operator's own override: `BYOK_*`, this SDK's own
 * control-plane variables, must never reach a spawned agent process — see
 * {@link HARD_DENY_PATTERNS}.
 *
 * Every name in every list may be an exact match or a `*`-suffixed prefix
 * (e.g. `'LC_*'` matches `LC_ALL`, `LC_CTYPE`, ...).
 */
/**
 * What one runtime adapter declares it needs beyond the always-included
 * platform baseline. Declared in the required frozen
 * `RuntimeAdapter.descriptor.environmentRequirements` (`../types.ts`).
 */
export interface RuntimeEnvironmentRequirements {
    /**
     * Extra non-secret, config-discovery-shaped variable names this runtime's
     * own CLI reads (e.g. a `<RUNTIME>_CONFIG_DIR`-style override) — anything
     * that isn't itself a credential. Optional: most adapters need nothing
     * beyond the platform baseline.
     */
    baseNames?: readonly string[];
    /**
     * Credential/auth variable names this runtime's own CLI reads to
     * authenticate (e.g. a provider API key). Kept as its own field (distinct
     * from `baseNames`) so a product's own security review can reason about
     * "what credential-shaped names does this runtime get" as a single,
     * explicit list per adapter — see e.g. the pi adapter's
     * `KNOWN_PROVIDER_ENV_VARS`.
     */
    credentialNames?: readonly string[];
}
/** Inputs to {@link buildRuntimeEnv}. */
export interface BuildRuntimeEnvOptions {
    /**
     * The daemon's own ambient environment (normally `process.env`). Never
     * mutated — every returned variable is copied into a fresh object.
     */
    ambient: NodeJS.ProcessEnv;
    /**
     * The selected runtime adapter's own declared requirements —
     * `undefined` means "platform baseline only" for this helper. The public
     * RuntimeAdapter descriptor always supplies this object before TaskRunner
     * invokes the helper.
     */
    requirements?: RuntimeEnvironmentRequirements;
    /**
     * This device's own operator-configured escape hatch for this one runtime
     * (`DaemonConfig.runtimeEnvironment?.[adapterId]?.allow`) — merged in like
     * any other allowlist entry, still subject to the hard deny below.
     */
    locallyAllowedNames?: readonly string[];
    /**
     * Test seam: which platform's extra base vars to include
     * ({@link WINDOWS_BASE_ALLOWLIST} vs none) — defaults to `process.platform`
     * so callers never have to think about it, while still letting a test
     * exercise the win32 branch deterministically on any host OS.
     */
    platform?: NodeJS.Platform;
}
/**
 * Build the environment one specific runtime's spawned child process should
 * actually receive — a fresh object, never `options.ambient` itself and
 * never mutated in place. See this module's own doc comment for the full
 * allow/deny model.
 */
export declare function buildRuntimeEnv(options: BuildRuntimeEnvOptions): Record<string, string>;
// ==== @byok-sdk/client dist/daemon/git-workspace-store.d.ts ====
import type { GitErrorCategory, GitWorkspaceObservation } from './git-workspace';
export type GitWorkspacePhase = 'preparing' | 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'salvage';
export interface GitWorkspaceLedgerRecord {
    workspaceId: string;
    taskId: string;
    workspaceDir: string;
    sessionRef?: string;
    phase: GitWorkspacePhase;
    baseline?: string;
    current?: string;
    commitsSinceBaseline: number;
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
    createdAt: string;
    updatedAt: string;
    errorCategory?: GitErrorCategory;
}
export interface GitWorkspaceLedger {
    version: 1;
    records: GitWorkspaceLedgerRecord[];
}
/** Private, versioned, serialized recovery ledger for local Git workspaces. */
export declare class GitWorkspaceStore {
    readonly storeDir: string;
    readonly filePath: string;
    private queue;
    private readonly maxRecords;
    constructor(storeDir: string, options?: {
        maxRecords?: number;
    });
    initialize(): Promise<void>;
    list(): Promise<GitWorkspaceLedgerRecord[]>;
    get(workspaceId: string): Promise<GitWorkspaceLedgerRecord | undefined>;
    findBySession(sessionRef: string): Promise<GitWorkspaceLedgerRecord | undefined>;
    findBySessionAnyPhase(sessionRef: string): Promise<GitWorkspaceLedgerRecord | undefined>;
    attachSession(workspaceId: string, sessionRef: string): Promise<void>;
    upsert(record: GitWorkspaceLedgerRecord): Promise<void>;
    updateObservation(workspaceId: string, observation: GitWorkspaceObservation, phase?: GitWorkspacePhase, errorCategory?: GitErrorCategory): Promise<void>;
    /** Marks old preparation/active records interrupted without reviving protocol tasks. */
    reconcile(validate?: (record: GitWorkspaceLedgerRecord) => Promise<boolean>): Promise<void>;
    private prune;
    private enqueue;
    private load;
    private save;
}
export declare const GIT_WORKSPACE_LEDGER_FILE = "git-workspaces.json";
export declare const GIT_WORKSPACE_LEDGER_MAX_RECORDS = 500;
// ==== @byok-sdk/client dist/daemon/git-workspace.d.ts ====
export interface GitWorkspaceConfig {
    mode: 'local-checkpoints';
}
export type GitErrorCategory = 'git-unavailable' | 'git-timeout' | 'git-output-limit' | 'git-command-failed' | 'workspace-root-invalid' | 'workspace-root-conflict' | 'workspace-not-owned' | 'repository-root-mismatch' | 'repository-invalid' | 'lease-busy' | 'ledger-invalid';
/**
 * Runtime projection of {@link GitErrorCategory}: every union member, once,
 * in union order — the single source of truth the CLI's stable-output
 * validators (`bin/format.ts`, `bin/audit-log.ts`, `bin/tasks-view.ts`,
 * `bin/commands/workspaces.ts`) project from when deciding which category
 * strings from ledger records are stable enough to render, so those filters
 * can never drift from the union. The `satisfies` half rejects a string
 * that isn't a union member; the `AssertExhaustive` proof below rejects a
 * union member missing from this list — extending either side alone is a
 * compile error. The runtime half (no duplicates, every consumer projects
 * exactly this list) is `__tests__/git-category-drift.test.ts`.
 */
export declare const GIT_ERROR_CATEGORIES: readonly ["git-unavailable", "git-timeout", "git-output-limit", "git-command-failed", "workspace-root-invalid", "workspace-root-conflict", "workspace-not-owned", "repository-root-mismatch", "repository-invalid", "lease-busy", "ledger-invalid"];
/**
 * Runtime projection of `GitWorkspacePhase` (the type itself lives in
 * `git-workspace-store.ts`; the projection lives here beside
 * {@link GIT_ERROR_CATEGORIES} so both category/phase single sources ship
 * from one module) — same exhaustiveness contract, consumed by
 * `bin/tasks-view.ts`'s phase filter.
 */
export declare const GIT_WORKSPACE_PHASES: readonly ["preparing", "active", "completed", "failed", "cancelled", "interrupted", "salvage"];
export declare class GitWorkspaceError extends Error {
    readonly category: GitErrorCategory;
    constructor(category: GitErrorCategory, message?: string);
}
export interface GitCommandResult {
    code: number;
    stdout: string;
    stderr: string;
}
export interface GitCommandOptions {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
}
export type GitRunner = (args: readonly string[], options?: GitCommandOptions) => Promise<GitCommandResult>;
declare const DEFAULT_TIMEOUT_MS = 5000;
declare const DEFAULT_MAX_OUTPUT_BYTES: number;
export declare function stableGitWorkspaceOwnerId(storeDir: string, productId: string): string;
/** A bounded, no-shell runner for the small Git command allowlist. */
export declare const defaultGitRunner: GitRunner;
export interface GitWorkspaceOptions {
    run?: GitRunner;
    timeoutMs?: number;
    maxOutputBytes?: number;
    platform?: NodeJS.Platform;
    ownerId?: string;
}
export interface GitWorkspaceObservation {
    workspaceDir: string;
    head?: string;
    baseline?: string;
    headChanged: boolean;
    commitsSinceBaseline: number;
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
}
export interface GitWorkspaceLease {
    readonly workspaceDir: string;
    readonly sessionRef?: string;
    release(): void;
}
/** Local Git checkpoint manager. It never invokes a shell or mutating Git command other than init. */
export declare class GitWorkspaceManager {
    readonly workspaceRoot: string;
    readonly ownerId: string;
    private readonly run;
    private readonly timeoutMs;
    private readonly maxOutputBytes;
    private readonly platform;
    constructor(workspaceRoot: string, options?: GitWorkspaceOptions);
    static validateConfig(value: unknown): GitWorkspaceConfig | undefined;
    preflight(): Promise<void>;
    ensureOwnerMarker(): Promise<void>;
    prepareFresh(workspaceDir: string): Promise<GitWorkspaceObservation>;
    /** Validate an already prepared repository without creating directories or running mutating Git commands. */
    validateExisting(workspaceDir: string): Promise<GitWorkspaceObservation>;
    observe(workspaceDir: string, baseline?: string): Promise<GitWorkspaceObservation>;
    acquireLease(workspaceDir: string, sessionRef?: string): Promise<GitWorkspaceLease>;
    static guidance(): string;
    static prependGuidance(instruction: string): string;
    private commandOptions;
    private read;
    private readTopLevel;
    private assertTaskRoot;
    private assertExistingAncestry;
    private assertExistingTaskRoot;
}
export declare const GIT_WORKSPACE_OWNER_MARKER = ".byok-git-workspace-owner.json";
export declare const LOCAL_GIT_WORKSPACE_GUIDANCE: string;
export declare function prependGitWorkspaceGuidance(instruction: string): string;
export declare function isGitWorkspaceConfig(value: unknown): value is GitWorkspaceConfig;
export declare function canonicalWorkspaceRoot(value: string): Promise<string>;
export { DEFAULT_MAX_OUTPUT_BYTES as GIT_WORKSPACE_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS as GIT_WORKSPACE_TIMEOUT_MS };
// ==== @byok-sdk/client dist/daemon/input-preparation-store.d.ts ====
import { INPUT_PREPARATION_ARTIFACT_FORMAT, INPUT_PREPARATION_RECORD_FORMAT, INPUT_PREPARATION_VERSION, type InputPreparationBindingV1, type InputPreparationArtifactSummaryV1, type InputPreparationCounterEvidenceV1, type InputPreparationModelV1, type InputPreparationPinV1, type InputPreparationProjectionV1, type InputPreparationResidualKeyV1, type InputPreparationStateV1 } from '../input-preparation';
/**
 * Durable request / receipt / artifact persistence for the B-P2 local
 * primitive (`docs/researches/runtime-input-preparation-contract.md` §10.3.5,
 * §10.3.6, §10.3.8).
 *
 * One durable namespace, `(authenticated scope, Agent, preparation requestId)`,
 * bound to the entire normalized request digest. This file owns exactly that
 * namespace plus the retained artifact bytes; it chooses no policy number,
 * resolves no authority and places no counter call. Everything above it is
 * `input-preparation-service.ts`.
 *
 * It does enforce the bounds that service hands it, because a bound is only
 * real where the write is: admission is decided inside the same serialized
 * closure that appends the record, never on a value someone read first.
 *
 * Durability comes from the package's existing primitives, not from `rename`
 * alone: the record log is a `DurableJsonlFile` (append + fsync + directory
 * fsync, and QUARANTINED after any uncertain write until the log is
 * revalidated), and each artifact is an `atomicWriteFile` with `fsync`. An
 * uncertain write is therefore an error the caller sees, never a silent
 * success — §10.3.8.
 *
 * Two horizons, deliberately separate:
 *
 * - `artifactExpiresAt = createdAt + retentionMs` — after this the retained
 *   bytes are removed and the receipt reports `artifact_expired`.
 * - `recordExpiresAt = artifactExpiresAt + retryHorizonMs` — the TOMBSTONE
 *   outlives its own artifact by the whole advertised retry horizon, which is
 *   what makes "an expired key cannot silently become a fresh call inside that
 *   horizon" true rather than aspirational: a duplicate `requestId` inside the
 *   horizon still finds a record, and a found record never triggers a second
 *   counter call.
 */
/**
 * The durable RECORD schema version, and nothing else.
 *
 * Deliberately separate from `INPUT_PREPARATION_VERSION`, which versions the
 * wire shapes — the control request, the receipt, the retained artifact. Those
 * are what two parties agree on; this one is what one daemon's own on-disk log
 * is written in, and the two move for different reasons. Bumping the wire
 * version because a private durable field became required would make every
 * peer re-negotiate a contract that did not change; reusing the wire version
 * for the log would make the log's meaning depend on an agreement it is not a
 * party to.
 *
 * 3 was the first version in which `model` is a required durable fact (a
 * prepared launch must re-present the counted model identity as an INDEPENDENT
 * expectation, and the only other copy of it lives inside the retained
 * envelope, which the native contract forbids using as its own expectation).
 *
 * 4 is the first version whose artifact carries the native compiler's
 * structural projection contract — `projection` plus a classified `residual`
 * list — in place of the single opaque `coverage` label version 3 wrote. A
 * version-3 record cannot be read forward: nothing can honestly decide whether
 * a record frozen under an opaque label had a content-complete projection or
 * which residual keys its request carried, and inventing either is precisely
 * the shadow accounting this contract forbids.
 *
 * 5 is the first version written against the 0.86 runtime contract: the
 * retained snapshot carries `prompt.skills` and `prompt.toolGuidelines` in
 * place of `prompt.formattedSkills`, and the artifact's projection declares
 * contract v3. A version-4 record cannot be read forward either — its prompt
 * was rendered by a renderer this build no longer has, so the request it
 * describes cannot be re-derived, and translating it would be inventing bytes.
 *
 * 6 is the first version written under bounded admission: the successful
 * terminal state is `prepared` (it was `counted`), counter evidence carries no
 * `kind`, a record may reach `prepared` with no counter at all, and a record
 * holding an artifact states `requestContentTextOnly`. A version-5 record
 * cannot be read forward: its terminal state names a lifecycle this build no
 * longer has, and nothing can honestly say whether its D was text only
 * without re-reading bytes the record never vouched for.
 *
 * A record at any other version is refused — see
 * {@link InputPreparationUnsupportedRecordVersionError}. There is no
 * compatibility read.
 */
export declare const INPUT_PREPARATION_RECORD_VERSION = 6;
/** The durable idempotency key. Never a task id, and never caller-asserted: `scopeId` comes from the trusted authority grant. */
export interface InputPreparationRecordKey {
    readonly scopeId: string;
    readonly agentRef: string;
    readonly requestId: string;
}
export interface InputPreparationRecord {
    readonly format: typeof INPUT_PREPARATION_RECORD_FORMAT;
    /** The RECORD schema version — see {@link INPUT_PREPARATION_RECORD_VERSION}. Not the wire version. */
    readonly version: typeof INPUT_PREPARATION_RECORD_VERSION;
    readonly recordId: string;
    readonly key: InputPreparationRecordKey;
    /** Digest over the whole normalized request, scope and runtime identity. */
    readonly requestDigest: string;
    readonly state: InputPreparationStateV1;
    readonly binding: InputPreparationBindingV1;
    /**
     * The exact model identity the request was compiled for.
     *
     * Durable, and BESIDE the binding rather than inside it. Beside, because the
     * binding is the wire projection a receipt discloses and a model identity
     * carries a base URL and a cost table a receipt has no business publishing.
     * Durable, because a prepared launch must re-present it to the native
     * verifier as an INDEPENDENT expectation — the only other copy of it lives
     * inside the retained envelope, and the native contract is explicit that a
     * value read out of the envelope can never serve as its own expectation.
     */
    readonly model: InputPreparationModelV1;
    readonly artifact?: InputPreparationArtifactSummaryV1;
    /**
     * Whether D — the retained provider request — carries text content parts
     * only (`adapters/pi/input-preparation.ts`'s
     * `preparedRequestContentIsTextOnly`). Written in the same durable
     * transition that retains the artifact, and present exactly when
     * `artifact` is: it is a fact about those bytes, decided once, so readiness
     * reads it rather than re-parsing D.
     */
    readonly requestContentTextOnly?: boolean;
    /** Present only when a configured counter answered. Absent is a legal, ready-capable state. */
    readonly counter?: InputPreparationCounterEvidenceV1;
    /** Retained bytes attributable to this record, counted against the per-scope aggregate. */
    readonly artifactBytes: number;
    /** Counter invocations this record has consumed. Never decremented; always 0 without a counter. */
    readonly counterCalls: number;
    /** Stable code on a terminal non-`prepared` state; never provider or stack text. */
    readonly detail?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly artifactExpiresAt: string;
    readonly recordExpiresAt: string;
    /** The committed Execution that consumed this record, written once by {@link InputPreparationStore.pin}. */
    readonly pin?: InputPreparationPinV1;
}
/** The retained immutable artifact. `requestBody` is D verbatim. */
export interface InputPreparationArtifact {
    readonly format: typeof INPUT_PREPARATION_ARTIFACT_FORMAT;
    readonly version: typeof INPUT_PREPARATION_VERSION;
    readonly recordId: string;
    readonly requestDigest: string;
    readonly envelopeDigest: string;
    readonly toolManifestDigest: string;
    /** D — the exact provider request body bytes, unchanged. */
    readonly requestBody: string;
    /** P(D) — the counted projection, unchanged. */
    readonly counterProjection: string;
    /** What the native compiler proved about P(D), copied verbatim off the envelope. */
    readonly projection: InputPreparationProjectionV1;
    /** Every top-level key of D outside P(D), classified by the native compiler. */
    readonly residual: readonly InputPreparationResidualKeyV1[];
    /** The native envelope, retained verbatim so a later consumer re-verifies rather than recompiles. */
    readonly envelope: unknown;
}
export declare function isTerminalInputPreparationState(state: InputPreparationStateV1): boolean;
/** Same key, different normalized request digest. Never resolved by overwriting either side. */
export declare class InputPreparationConflictError extends Error {
    readonly recordId: string;
    constructor(recordId: string);
}
/** A durable write was uncertain, or the log is quarantined pending revalidation. */
export declare class InputPreparationDurabilityError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/**
 * A bound the caller passed in was already spent when the write was about to
 * happen.
 *
 * The store owns no policy: every number it compares against arrives on the
 * call that asks for the write. What it does own is the only moment at which
 * that comparison is meaningful — inside the serialized tail, in the same
 * closure as the append. A caller that read an aggregate and then asked for a
 * write would be deciding on a snapshot another caller can invalidate before
 * the write lands (§10.3.7).
 */
export type InputPreparationLimitDetail = 'in_flight_limit_exceeded' | 'scope_aggregate_bytes_exceeded' | 'counter_call_limit_exceeded';
export declare class InputPreparationLimitError extends Error {
    readonly detail: InputPreparationLimitDetail;
    constructor(detail: InputPreparationLimitDetail, message: string);
}
/** The stored record or artifact does not match what was persisted. */
export declare class InputPreparationIntegrityError extends Error {
    constructor(message: string);
}
/**
 * The log holds a record written in a schema version this build does not
 * support.
 *
 * A refusal, never a migration and never a compatibility read: the older shape
 * is missing facts a prepared Execution cannot be launched without, and a store
 * that silently held records it could not honor would be worse than one that
 * says so. The refusal happens during replay, BEFORE the store is open, so it
 * performs zero writes and zero cleanup — the log and every artifact beside it
 * are left exactly as found for an operator to dispose of explicitly.
 */
export declare class InputPreparationUnsupportedRecordVersionError extends InputPreparationIntegrityError {
    readonly recordId: string;
    readonly recordVersion: unknown;
    readonly logPath: string;
    readonly reason = "unsupported_record_version";
    constructor(recordId: string, recordVersion: unknown, logPath: string);
}
export interface InputPreparationStoreOptions {
    /** The daemon's store directory. The subtree below it is created 0700 on open. */
    readonly storeDir: string;
    readonly retentionMs: number;
    readonly retryHorizonMs: number;
    readonly now?: () => number;
}
export interface ReserveInput {
    readonly key: InputPreparationRecordKey;
    readonly requestDigest: string;
    readonly binding: InputPreparationBindingV1;
    /** See {@link InputPreparationRecord.model}. */
    readonly model: InputPreparationModelV1;
    /**
     * The caller's in-flight bound, enforced in the same closure that appends the
     * new record. Never consulted for a key that already exists: reading back an
     * existing durable fact is not a new admission.
     */
    readonly maxInFlight: number;
}
/** The bounds one artifact retention is admitted against. Supplied by the caller, compared here. */
export interface ArtifactCommitBounds {
    readonly maxScopeAggregateBytes: number;
}
/** The bounds one counter reservation is admitted against: retention plus the counter-call allowance. */
export interface CounterReservationBounds extends ArtifactCommitBounds {
    readonly maxCounterCallsPerScope: number;
}
export interface ArtifactCommitInput {
    readonly recordId: string;
    /** The immutable artifact, written inside the same closure that charges its bytes. */
    readonly artifact: InputPreparationArtifact;
    /** The identities and sizes the receipt publishes. */
    readonly summary: InputPreparationArtifactSummaryV1;
    /** See {@link InputPreparationRecord.requestContentTextOnly}. */
    readonly requestContentTextOnly: boolean;
    readonly bounds: ArtifactCommitBounds;
}
export interface CounterReservationInput extends ArtifactCommitInput {
    readonly bounds: CounterReservationBounds;
}
export type ReserveOutcome = {
    readonly kind: 'created';
    readonly record: InputPreparationRecord;
} | {
    readonly kind: 'existing';
    readonly record: InputPreparationRecord;
};
/**
 * The result of one compare-and-set against a record's single pin slot.
 *
 * `occupied` is not an error: it is the answer the losing runner of a race is
 * supposed to get, and it carries the record so the caller can report WHICH
 * Execution holds it.
 */
export type PinOutcome = {
    readonly kind: 'pinned';
    readonly record: InputPreparationRecord;
} | {
    readonly kind: 'occupied';
    readonly record: InputPreparationRecord;
};
/** The mutable fields one durable transition may set. Identity and key are immutable. */
export interface RecordPatch {
    readonly state?: InputPreparationStateV1;
    readonly artifact?: InputPreparationArtifactSummaryV1;
    readonly counter?: InputPreparationCounterEvidenceV1;
    readonly artifactBytes?: number;
    readonly counterCalls?: number;
    readonly detail?: string;
}
export interface ScopeUsage {
    readonly artifactBytes: number;
    readonly counterCalls: number;
    readonly liveRecords: number;
}
/** `recordId` is a digest of the key, so two scopes can never collide and no key value ever becomes a filename. */
export declare function inputPreparationRecordId(key: InputPreparationRecordKey): string;
export declare class InputPreparationStore {
    private readonly options;
    private readonly root;
    private readonly artifactDir;
    private readonly now;
    private log;
    private records;
    /** Serializes every mutation so two callers never interleave a read-modify-append. */
    private tail;
    private opened;
    constructor(options: InputPreparationStoreOptions);
    /**
     * Create the subtree, replay the log and confirm the recovered bytes.
     *
     * Replay alone is not a durability receipt — `confirmRecovered()` fsyncs what
     * was read back before any of it is treated as fact, which is the same rule
     * `DurableJsonlFile` documents for its own consumers.
     */
    open(): Promise<void>;
    private replay;
    /**
     * Re-open and revalidate a quarantined log.
     *
     * `DurableJsonlFile` latches after an uncertain write and refuses every later
     * append. That latch is the contract, so recovery is explicit: read the log
     * back, confirm the recovered bytes, and only then accept writes again.
     */
    revalidate(): Promise<void>;
    /**
     * Drop this instance's replayed state.
     *
     * Nothing on disk is touched: the log and the artifacts are the durable
     * facts, and this only ends one process's view of them. After it, every read
     * refuses instead of answering `undefined` — which is the whole point, since
     * a closed store and an empty one would otherwise be indistinguishable to a
     * caller. Re-opening replays from disk again.
     */
    close(): void;
    private assertOpen;
    /** Serialize a mutation behind every mutation already queued. */
    private enqueue;
    private append;
    /**
     * Durably reserve the key BEFORE anything is compiled or counted.
     *
     * Same key and same digest returns the existing record — the caller decides
     * whether that is a completed receipt, a pending fact or a terminal
     * interruption. Same key and a DIFFERENT digest conflicts: neither side is
     * overwritten, because one of the two callers is wrong about what it asked
     * for and guessing which is how a counted artifact gets swapped underneath a
     * receipt.
     *
     * The in-flight admission is decided HERE, in the same closure as the append,
     * because two different requestIds share no caller-side lock: a bound checked
     * before this closure is a bound two concurrent admissions can both pass.
     */
    reserve(input: ReserveInput): Promise<ReserveOutcome>;
    /** Append one durable transition. Terminal records never transition again. */
    update(recordId: string, patch: RecordPatch): Promise<InputPreparationRecord>;
    /**
     * Every read asserts the store is open, for one reason: an unopened store
     * and an empty store are indistinguishable from the in-memory map, and they
     * mean opposite things. `undefined` from an unopened store would read as "no
     * such record on this device" while the record sits durably on disk — which
     * is exactly how a restart turns a counted preparation into
     * `preparation_not_found`. Refusing is the only answer that cannot be
     * mistaken for an answer about the durable state.
     */
    get(recordId: string): InputPreparationRecord | undefined;
    find(key: InputPreparationRecordKey): InputPreparationRecord | undefined;
    /** Every live record, for tests and for the aggregate below. */
    list(): readonly InputPreparationRecord[];
    /**
     * Retained bytes and consumed counter calls for one authenticated scope.
     *
     * Both survive restart because both are fields of the durable record, not
     * in-memory counters — which is exactly what stops a restart from becoming a
     * fresh counter-call allowance.
     */
    scopeUsage(scopeId: string): ScopeUsage;
    /**
     * Records that are neither terminal nor expired, across every scope.
     *
     * Expiry is part of the question, not a detail GC will get to eventually: a
     * `reserved` record whose owning run died holds no work, and letting it keep
     * a slot past its own record horizon would turn an abandoned key into a
     * permanent hole in the in-flight allowance.
     */
    inFlightCount(nowMs?: number): number;
    private artifactPath;
    /**
     * Admit one counter call: check the caller's bounds, persist the immutable
     * artifact (fsynced, 0600, D verbatim) and durably reserve the call — all in
     * ONE serialized closure. The record moves to `counting`.
     *
     * Fusing the three is the point. Retained bytes and consumed counter calls
     * are per-SCOPE aggregates, so they are shared by requests that share nothing
     * else: different requestIds are different records, different keys and
     * different caller-side locks. Checking the aggregate anywhere but here would
     * be a read another admission can invalidate before the write lands, which is
     * exactly how two concurrent requests both pass a bound of one.
     *
     * The artifact is written after the bounds pass and before the record is
     * charged, so a refused admission leaves no retained bytes behind and a
     * charged record always has its artifact on disk.
     */
    commitCounterReservation(input: CounterReservationInput): Promise<InputPreparationRecord>;
    /**
     * Retain the artifact of a preparation that has NO counter configured and
     * settle it as `prepared` — the same serialized closure, the same retention
     * bound and the same fsynced write as {@link commitCounterReservation}, but
     * no counter call is reserved: `counterCalls` stays 0 and the scope's
     * counter-call allowance is neither read nor charged.
     */
    commitPreparedArtifact(input: ArtifactCommitInput): Promise<InputPreparationRecord>;
    /**
     * The one retention closure behind both commits. `maxCounterCallsPerScope`
     * is present exactly when a counter call is being reserved; its absence is
     * what makes the transition land on `prepared` instead of `counting`.
     */
    private commitArtifact;
    /**
     * The absolute path of one record's retained artifact.
     *
     * Exposed because a prepared Execution is handed a PATH, not bytes: the
     * artifact carries D, P(D) and the whole native envelope, and there is
     * exactly one retained copy of it. A second inline representation crossing to
     * the adapter would be a second authority over the same bytes. Deriving the
     * path anywhere else would be a second authority over the layout instead.
     */
    artifactPathOf(record: InputPreparationRecord): string;
    /**
     * Bind one committed Execution to this record, or report that another one
     * already did.
     *
     * A compare-and-set, inside the same serialized closure as the append, for
     * the same reason every other admission in this file is: two runners racing
     * the same reference share no caller-side lock, so a `pin === undefined`
     * check made before this closure is a check both of them pass. The loser gets
     * `occupied` with the pin that won, and its caller sends zero claim and
     * dispatches nothing.
     *
     * Idempotent for the SAME Execution: a replay that re-presents the identical
     * taskId and manifest digest reads back `pinned` with the record it already
     * has, because re-deriving the same seal is not a second consumer. A
     * different taskId, or the same taskId with a different sealed manifest, is
     * `occupied` — it is a different Execution.
     *
     * Only a `prepared` record with a retained artifact may be pinned: a pin on a
     * record that has no artifact would keep a tombstone alive forever without
     * ever being launchable.
     */
    pin(recordId: string, pin: InputPreparationPinV1): Promise<PinOutcome>;
    /**
     * Release the pin this Execution holds.
     *
     * Scoped to the holder on purpose: `taskId` must match, so a task cannot
     * release a record another Execution consumed. Releasing a record that is
     * already unpinned is not an error — the pin's job is done either way, and a
     * terminal path that had to know whether it ever pinned would grow a second
     * answer to a question the record already holds.
     *
     * WHEN a pin is released is a single rule: the Execution reached a terminal.
     * Not at claim, not at start, not when the session closes — a record stays
     * pinned for exactly as long as the Execution that consumed it can still be
     * running, which is also exactly as long as GC must not collect it.
     */
    unpin(recordId: string, taskId: string): Promise<InputPreparationRecord>;
    /**
     * Read the artifact back and re-check the identity it claims.
     *
     * The digest comparison is integrity, not authorization: authority was
     * already resolved before the caller reached this method.
     */
    readArtifact(record: InputPreparationRecord): Promise<InputPreparationArtifact | undefined>;
    /**
     * Drop expired artifacts and, one retry horizon later, expired records.
     *
     * A pinned record is never collected — not its artifact and not its
     * tombstone. That is what makes a pin meaningful: the Execution holding it
     * has not reached a terminal yet, so the bytes it is about to send (or is
     * sending) must still be on disk, whatever the retention horizon says. The
     * horizon resumes the moment `unpin` lands.
     */
    gc(nowMs?: number, preserveInFlight?: boolean): Promise<{
        artifactsRemoved: number;
        recordsRemoved: number;
    }>;
}
// ==== @byok-sdk/client dist/daemon/journal/journal.d.ts ====
/**
 * The daemon's durable local journal port (sprint S3.3 / architecture
 * §12.7.2).
 *
 * The journal is NOT a debug log. It is the correctness precondition for
 * acking the hosted mailbox: the cloud retires a mailbox row when the daemon's
 * next poll carries a cursor past it (§12.7.3 — "领走即弃" means *cursor moved
 * past*, not *read*), so the moment the cursor advances over an envelope, that
 * envelope exists nowhere but this machine. Everything in this file exists to
 * make "the bytes are durable" a fact the cursor can be gated on.
 *
 * Two shapes here are load-bearing and deliberate:
 *
 * - **Bounded records.** The journal stores reliability metadata and small
 *   bounded bytes. Prompts, tool output, artifacts, workspaces, and blobs stay
 *   on the filesystem and are referenced, never inlined (§12.7.2). An oversized
 *   record is rejected with {@link JournalRecordTooLargeError} rather than
 *   silently truncated — a truncated envelope is not the envelope, and a
 *   journal that quietly stores something else than what arrived is worse than
 *   one that refuses.
 * - **Cleanable categories are a closed set that excludes protected data.**
 *   §12.7.2.1's never-auto-delete list (unacked envelopes, Running/
 *   AwaitApproval tasks, unconfirmed terminals, anything carrying a recovery
 *   marker, user workspaces, provider secrets, quarantine evidence) is
 *   enforced by {@link CleanableCategory} not having names for those things,
 *   so the cleanup path cannot ask for one. A runtime filter would put the
 *   never-delete list one bug away from deleting recovery evidence exactly
 *   once, in production.
 */
/**
 * The journal's one hash function, shared by every producer so a stored digest
 * and a recomputed one are comparable without a second convention. `sha256:`
 * prefixed because the algorithm has to travel with the value — an unprefixed
 * hex string is a hash of unknown provenance the day this changes.
 */
export declare function journalHash(bytes: string): string;
/**
 * Who this daemon is, as recorded on every journal row (§12.7.2's minimum
 * fact set, first three entries). Carried explicitly rather than captured at
 * construction because `deviceId` is only known after `AuthManager`
 * `loadExisting()` resolves, strictly after the journal is built.
 */
export interface JournalIdentity {
    readonly tenantId: string;
    readonly productId: string;
    readonly deviceId: string;
}
/**
 * One inbound envelope, as received from the mailbox and about to be made
 * durable. `bytes` is the canonical v1 encoding (`encodeEnvelope`) of the
 * envelope this daemon parsed — the frozen codec's round-trip guarantee is
 * what makes that a faithful record — and `bytesHash` is its digest, so a
 * later reader can tell a redelivery of the same envelope from a different
 * envelope reusing an id.
 */
export interface ReceivedEnvelopeRecord {
    readonly identity: JournalIdentity;
    readonly envelopeId: string;
    /** The envelope's `task_id`, when it carries one. Required whenever {@link opensTask} is true. */
    readonly taskId?: string;
    /** The mailbox `seq` this envelope arrived at — the received cursor (§12.7.2's minimum fact set). */
    readonly seq: number;
    /** Canonical v1 bytes. Bounded — see {@link JournalRecordTooLargeError}. */
    readonly bytes: string;
    /** `sha256:<hex>` over {@link bytes}. */
    readonly bytesHash: string;
    readonly receivedAt: string;
    /**
     * Whether this envelope OPENS a local task record, i.e. whether the same
     * transaction must also create the `journal_task` row §12.7.3 requires
     * ("v1 bytes 与本机 task record 已在同一个本机 transaction durable append").
     * The caller decides this from the envelope's own type — it is the one
     * party that already knows, and re-deriving it inside the journal would put
     * a second copy of protocol semantics somewhere it does not belong.
     */
    readonly opensTask: boolean;
}
/**
 * What {@link LocalTaskJournal.appendEnvelope} hands back. The cursor may
 * advance past {@link seq} once — and only once — this exists.
 */
export interface JournalReceipt {
    readonly envelopeId: string;
    readonly seq: number;
    readonly bytesHash: string;
    readonly committedAt: string;
    /**
     * `false` when this exact envelope id was ALREADY durable and this call
     * changed nothing — the redelivery case (§8.3's at-least-once wire means
     * every envelope can arrive twice; a crash between commit and ack
     * guarantees at least one will). A `false` here is a successful, correct
     * outcome, not an error: it says the bytes are durable, which is all the
     * cursor needed to know.
     */
    readonly created: boolean;
}
/** The admission decision for an offered task, as recorded on `journal_task`. */
export interface AdmissionRecord {
    readonly taskId: string;
    readonly admitted: boolean;
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly claimedRuntime?: string;
    /** Digest of the effective policy this task runs under — the policy itself is not stored (bounded records). */
    readonly effectivePolicyHash?: string;
    /** Filesystem reference to the task's workspace. A path, never its contents. */
    readonly workspaceRef?: string;
    readonly decidedAt: string;
}
/**
 * One local execution-state transition. Idempotent by {@link transitionId}:
 * a replayed transition (recovery re-running a step, a redelivered envelope
 * driving the same move) records nothing new.
 */
export interface LocalTransitionRecord {
    readonly transitionId: string;
    readonly taskId: string;
    readonly from?: string;
    readonly to: string;
    readonly occurredAt: string;
    /** Small bounded free-form note. Not a place for tool output. */
    readonly detail?: string;
}
/** Whether the cloud has confirmed the terminal this daemon produced (§12.7.3's "terminal 生成后、truth 写入前" window). */
export type TerminalTruthState = 'pending' | 'confirmed' | 'failed';
/**
 * One immutable canonical terminal and its delivery projection. Bytes are the
 * replay authority; the hash is checked against them, never used as a substitute.
 */
export interface LocalTerminalRecord {
    readonly taskId: string;
    readonly terminalType: 'complete' | 'failed' | 'cancelled' | 'declined';
    readonly bytes: string;
    readonly payloadHash: string;
    readonly truthState: TerminalTruthState;
    /** How many times delivery to the cloud has been attempted. */
    readonly attempt: number;
    readonly lastError?: string;
    readonly recordedAt: string;
    /** Committed atomically with the original interruption report. */
    readonly recovery?: RecoveryOutcome;
}
/** A task the journal knows about that has no terminal and no recovery marker — i.e. one this daemon was in the middle of when it stopped. */
export interface RecoverableTask {
    readonly taskId: string;
    readonly envelopeId: string;
    readonly seq: number;
    readonly identity: JournalIdentity;
    readonly localState: string;
    readonly claimedRuntime?: string;
    readonly workspaceRef?: string;
    readonly updatedAt: string;
    readonly envelopeBytes: string;
}
/**
 * What recovery decided about a task. `interrupted` is the honest default for
 * a daemon restart: local runtime sessions do not survive the process, so the
 * task is recorded as interrupted rather than pretended back into life — the
 * same semantics `GitWorkspaceStore.reconcile()` already applies to a lease
 * whose owner is gone. Nothing here deletes anything; a row that has been
 * through recovery carries a marker, and §12.7.2.1 forbids auto-deleting
 * those.
 */
export type RecoveryDisposition = 'resumed' | 'interrupted' | 'abandoned';
export interface RecoveryOutcome {
    readonly disposition: RecoveryDisposition;
    readonly reason?: string;
    readonly occurredAt?: string;
}
/**
 * The five storage categories §12.7.2.1 requires to be measured SEPARATELY —
 * the cleanup order and the never-delete list are both category-scoped, so a
 * single "bytes used" number cannot drive either.
 */
export type StorageCategory = 'journal' | 'cache' | 'log' | 'workspace' | 'quarantine';
export interface CategoryUsage {
    readonly bytes: number;
    /** `true` when this is a host-reported or sampled figure rather than a measured one. */
    readonly approximate: boolean;
}
export interface LocalStorageUsage {
    readonly measuredAt: string;
    readonly totalBytes: number;
    readonly categories: Readonly<Record<StorageCategory, CategoryUsage>>;
}
/**
 * The categories automatic cleanup may act on, in §12.7.2.1's order. This
 * union is the never-auto-delete list's enforcement: `quarantine`,
 * unacked envelopes, live tasks, unconfirmed terminals, recovery-marked rows,
 * and user-designated workspaces have NO name here, so no cleanup call can
 * name one. Adding a member is therefore a deliberate, reviewable act rather
 * than a filter that silently stops matching.
 */
export type CleanableCategory = 
/** Expired upload/download temp files and rebuildable caches. */
'expired-temp'
/** Rotated logs past their retention. */
 | 'rotated-log'
/** Journal rows for tasks whose terminal the cloud has confirmed and that carry no recovery marker. */
 | 'confirmed-journal'
/** Generated workspaces the HOST explicitly marked ephemeral, for tasks already terminal. */
 | 'ephemeral-workspace'
/** Local artifacts with no remaining reference, after a reference scan plus grace period. */
 | 'orphan-artifact';
export interface CleanupCandidate {
    readonly candidateId: string;
    readonly category: CleanableCategory;
    /** What to act on — a filesystem path, or a journal key. Interpreted by the cleanup worker, never by the journal. */
    readonly ref: string;
    readonly eligibleAt: string;
    readonly reason: string;
    readonly attempts: number;
    readonly lastError?: string;
}
export interface CleanupResult {
    readonly candidateId: string;
    readonly outcome: 'deleted' | 'skipped' | 'failed';
    readonly bytesReclaimed?: number;
    readonly error?: string;
    readonly at: string;
}
export interface CompactOptions {
    /**
     * `passive` never blocks a concurrent reader/writer and may checkpoint
     * nothing; `truncate` waits for the WAL to be fully applied and resets it.
     * Both are maintenance calls and belong off the active-task hot path
     * (§12.7.2).
     */
    readonly checkpoint?: 'passive' | 'truncate';
    /** Upper bound on freelist pages returned to the filesystem this pass. Bounded so compaction cannot monopolise the single writer. */
    readonly incrementalVacuumPages?: number;
}
export interface CompactResult {
    readonly checkpointed: boolean;
    /** WAL frames still outstanding after the checkpoint attempt — `0` means the WAL was fully applied. */
    readonly walFramesRemaining: number;
    readonly pagesVacuumed: number;
    readonly durationMs: number;
}
/**
 * The daemon-local durable journal (sprint S3.3's minimum API, verbatim,
 * plus {@link close}).
 *
 * A port, not an implementation detail: architecture §12.7.2 lets a host
 * inject its own backend, but only one that meets the same durability
 * contract. `SqliteLocalTaskJournal` is the shipped production implementation;
 * a plain JSON/JSONL store is explicitly NOT an acceptable substitute in
 * hosted mode, because it cannot honour the one property this interface exists
 * for — that `appendEnvelope` resolving means the bytes survived a power cut.
 */
export interface LocalTaskJournal {
    /**
     * Make one inbound envelope durable. Resolving means committed and fsynced;
     * only then may the mailbox cursor advance past `record.seq`.
     *
     * Idempotent by envelope id: appending the same envelope twice returns the
     * original receipt with `created: false` and writes nothing new. That is
     * what makes redelivery — which the at-least-once wire guarantees will
     * happen after any crash between commit and ack — a no-op rather than a
     * second side effect.
     */
    appendEnvelope(record: ReceivedEnvelopeRecord): Promise<JournalReceipt>;
    /** Record the admission decision for a task whose offer envelope is already durable. */
    recordAdmission(record: AdmissionRecord): Promise<void>;
    /** Record one local execution-state transition. Idempotent by transition id. */
    recordTransition(record: LocalTransitionRecord): Promise<void>;
    /** Record (or update the retry state of) a task's terminal. Idempotent by task id: a replay with the same payload hash is a no-op beyond retry bookkeeping. */
    recordTerminal(record: LocalTerminalRecord): Promise<void>;
    /** Exact original terminal bytes, including rejected records, until acknowledged. */
    listPendingTerminals(identity: JournalIdentity): Promise<LocalTerminalRecord[]>;
    /** A successful authenticated transport disposition, bound to the original bytes. */
    confirmTerminal(taskId: string, payloadHash: string): Promise<void>;
    rejectTerminal(taskId: string, payloadHash: string, reason: string): Promise<void>;
    /** Includes old interruption markers without reports; they must not hide pending work. */
    listRecoveryTasks(identity: JournalIdentity): Promise<RecoverableTask[]>;
    readTask(taskId: string, identity: JournalIdentity): Promise<RecoverableTask | undefined>;
    /** Tasks with no terminal and no recovery marker — what this daemon was in the middle of when it last stopped. */
    listRecoverable(): Promise<RecoverableTask[]>;
    /** Close out one recoverable task by writing its recovery marker. Never deletes; a marked row is on §12.7.2.1's never-auto-delete list. */
    markRecovered(taskId: string, outcome: RecoveryOutcome): Promise<void>;
    /** Per-category storage usage (§12.7.2.1) — the input to the watermark state machine. */
    measureUsage(): Promise<LocalStorageUsage>;
    /** Cleanup candidates eligible at `now`, oldest first, at most `limit`. Only {@link CleanableCategory} members can ever appear. */
    listCleanupCandidates(now: Date, limit: number): Promise<CleanupCandidate[]>;
    /** Record what the cleanup worker actually did with a candidate. */
    markCleanupResult(result: CleanupResult): Promise<void>;
    /** Bounded WAL checkpoint + incremental vacuum. Maintenance only; never on the envelope path. */
    compact(options: CompactOptions): Promise<CompactResult>;
    /**
     * Release the underlying handle. Beyond S3.3's minimum API — the daemon
     * owns this object's lifetime and has to be able to end it, and the crash
     * matrix needs an explicit "clean shutdown" to contrast against dropping
     * the reference without one.
     */
    close(): Promise<void>;
}
/**
 * Thrown when hosted journal mode is configured on a runtime that cannot
 * provide a real SQLite backend.
 *
 * This is architecture §12.7.2's no-silent-downgrade rule made executable:
 * "为兼容 Node 20 而退回的普通文件实现不能冒充 production durability." A daemon
 * that acks a mailbox on the strength of a journal that does not fsync loses
 * tasks only under power-cut timings — it passes every happy-path test it will
 * ever be given. Refusing to start is the only honest behaviour, so this is
 * thrown from CONSTRUCTION, before a single envelope has been accepted.
 */
export declare class JournalUnavailableError extends Error {
    constructor(reason: string, options?: {
        cause?: unknown;
    });
}
/**
 * Thrown when the journal database is unreadable and has been moved aside.
 *
 * The database is renamed (with its WAL/SHM siblings) into
 * `<storeDir>/quarantine/`, timestamped, alongside a manifest naming the
 * reason — and then this is thrown. Nothing is deleted and nothing is
 * silently rebuilt: a fresh empty database opened over a corrupt one would
 * report "no recoverable tasks" for a machine that has some, and destroy the
 * only evidence of why. §12.7.2.1 puts quarantine on the never-auto-delete
 * list; clearing it is an explicit operator action.
 */
export declare class JournalCorruptError extends Error {
    readonly dbPath: string;
    readonly quarantinePath: string;
    constructor(dbPath: string, quarantinePath: string, reason: string, options?: {
        cause?: unknown;
    });
}
/**
 * Thrown when a record exceeds the journal's per-record byte bound.
 *
 * The journal holds reliability metadata and small bounded bytes; large
 * payloads live on the filesystem and are referenced (§12.7.2). Rejecting is
 * the point — truncating would make the stored envelope a different envelope
 * than the one acked, which is precisely the failure this whole subsystem
 * exists to rule out.
 */
export declare class JournalRecordTooLargeError extends Error {
    readonly field: string;
    readonly actualBytes: number;
    readonly limitBytes: number;
    constructor(field: string, actualBytes: number, limitBytes: number);
}
/** Thrown when a record references a task the journal has no row for — a transition or terminal for a task whose offer envelope was never appended. Fail-closed: the alternative is inventing the missing task row, which would fabricate recovery evidence. */
export declare class JournalUnknownTaskError extends Error {
    readonly taskId: string;
    constructor(taskId: string, operation: string);
}
/** Thrown when the journal is used after {@link LocalTaskJournal.close}. */
export declare class JournalClosedError extends Error {
    constructor(operation: string);
}
// ==== @byok-sdk/client dist/daemon/journal/sqlite-journal.d.ts ====
import { type JournalIdentity, type AdmissionRecord, type CategoryUsage, type CleanableCategory, type CleanupCandidate, type CleanupResult, type CompactOptions, type CompactResult, type JournalReceipt, type LocalStorageUsage, type LocalTaskJournal, type LocalTerminalRecord, type LocalTransitionRecord, type RecoverableTask, type RecoveryOutcome, type ReceivedEnvelopeRecord, type StorageCategory } from './journal';
import { JournalHandleCleanupError, type JournalOpenFaultSeam } from './sqlite-support';
export { JournalHandleCleanupError };
/** The single database file, per §12.7.2's "建议单库 `<storeDir>/daemon.db`". */
export declare const JOURNAL_DB_FILENAME = "daemon.db";
/** Where a database that failed to open is moved to. On §12.7.2.1's never-auto-delete list. */
export declare const JOURNAL_QUARANTINE_DIRNAME = "quarantine";
/**
 * Default per-record byte bound. Generous next to a real `task.offer` (an
 * instruction plus a policy object — kilobytes), tight enough that an
 * envelope carrying an inlined artifact is refused instead of turning the
 * journal into a blob store. See {@link JournalRecordTooLargeError}.
 */
export declare const DEFAULT_MAX_RECORD_BYTES: number;
/** Default bound on how long a write waits for the write lock before failing. */
export declare const DEFAULT_JOURNAL_BUSY_TIMEOUT_MS = 5000;
/**
 * Named points inside a write where {@link JournalFaultSeam} may throw.
 *
 * These exist so the crash matrix can put a failure at an exact ordering
 * boundary — "after the envelope row, before the task row", "after the receipt,
 * before the commit" — deterministically, with no wall clock and no real
 * process kill. Same DI shape as `EnsureSecureDirOptions.run`
 * (`util/secure-dir.ts`): a seam the production path never supplies, exercised
 * from any host.
 */
export type JournalFaultStep = 'append:before-begin' | 'append:after-envelope' | 'append:after-task' | 'append:after-receipt' | 'append:before-commit' | 'append:after-commit' | 'admission:before-commit' | 'transition:before-commit' | 'terminal:before-commit' | 'terminal:after-commit' | 'recovery:after-commit' | 'confirm:before-commit' | 'confirm:after-commit' | 'recovery:before-commit' | 'cleanup:before-commit' | 'prune:before-commit';
export interface JournalFaultSeam {
    /** Throw to simulate a crash or IO error at exactly this step. Return normally to proceed. */
    onStep?(step: JournalFaultStep): void;
}
export interface SqliteLocalTaskJournalOptions {
    /** The daemon's store directory. The database lives at `<storeDir>/daemon.db` and quarantine at `<storeDir>/quarantine/`. */
    readonly storeDir: string;
    /** Bound on waiting for the write lock. Default {@link DEFAULT_JOURNAL_BUSY_TIMEOUT_MS}. */
    readonly busyTimeoutMs?: number;
    /** Per-record byte bound. Default {@link DEFAULT_MAX_RECORD_BYTES}. */
    readonly maxRecordBytes?: number;
    /** Test seam — see {@link JournalFaultSeam}. Never supplied in production. */
    readonly faults?: JournalFaultSeam;
    /** Test seam for post-open/pre-return SQLite initialization failures. Never supplied in production. */
    readonly openFaults?: JournalOpenFaultSeam;
    /** Injected clock, so receipt/quarantine timestamps are deterministic under test. Defaults to the real one. */
    readonly clock?: () => Date;
}
/** The categories `measureUsage` reports. Host-reported ones default to zero-approximate rather than being guessed at. */
declare const HOST_REPORTED_CATEGORIES: readonly StorageCategory[];
export declare class SqliteLocalTaskJournal implements LocalTaskJournal {
    #private;
    constructor(options: SqliteLocalTaskJournalOptions);
    /**
     * The ack-critical path. Envelope bytes, the task record it opens, and the
     * idempotency receipt all land in ONE transaction, or none of them do.
     *
     * The receipt lookup happens INSIDE that transaction rather than as a cheap
     * pre-check outside it: `BEGIN IMMEDIATE` already holds the write lock by
     * then, so "is this a redelivery?" and "write it" cannot be separated by
     * another writer. The duplicate answer is served from the stored receipt,
     * so a redelivery returns the ORIGINAL commit time and hash — the caller
     * learns the bytes are durable and that this call changed nothing, which is
     * exactly what the cursor needed.
     */
    appendEnvelope(record: ReceivedEnvelopeRecord): Promise<JournalReceipt>;
    recordAdmission(record: AdmissionRecord): Promise<void>;
    /**
     * Idempotent by transition id. `INSERT OR IGNORE` decides it: when the row
     * already exists nothing is inserted AND the task's `local_state` is left
     * alone, so replaying an old transition cannot drag a task's state
     * backwards — which is precisely what recovery replaying a stored sequence
     * would otherwise do.
     */
    recordTransition(record: LocalTransitionRecord): Promise<void>;
    /**
     * First terminal wins, matching the cloud's own receipt rule (§12.6.4:
     * 不覆写第一份事实). A repeat carrying the SAME payload hash is a delivery
     * retry and updates only the retry bookkeeping (`truth_state`, `attempt`,
     * `last_error`); a repeat carrying a DIFFERENT hash is a second, distinct
     * terminal for a task that already has one, and is recorded nowhere — the
     * first fact stands.
     */
    recordTerminal(record: LocalTerminalRecord): Promise<void>;
    readTask(taskId: string, identity: JournalIdentity): Promise<RecoverableTask | undefined>;
    listRecoveryTasks(identity: JournalIdentity): Promise<RecoverableTask[]>;
    listPendingTerminals(identity: JournalIdentity): Promise<LocalTerminalRecord[]>;
    confirmTerminal(taskId: string, payloadHash: string): Promise<void>;
    rejectTerminal(taskId: string, payloadHash: string, reason: string): Promise<void>;
    /**
     * What this daemon was in the middle of: a task whose offer envelope is
     * durable, that has no terminal, that was not declined, and that recovery
     * has not already closed out.
     *
     * A task with a terminal is NOT here even when the cloud has not confirmed
     * it — that is terminal REDELIVERY (§12.7.3's "terminal 生成后、truth 写入前"
     * row), a different track with different evidence, and folding the two
     * together would have recovery re-admit a task that already finished.
     */
    listRecoverable(): Promise<RecoverableTask[]>;
    /**
     * Writes the recovery marker. Idempotent and additive: a task already
     * marked is left exactly as it was (the FIRST recovery decision is the real
     * one), and no path here deletes anything — §12.7.2.1 puts recovery-marked
     * records on the never-auto-delete list, and this is what puts them there.
     */
    markRecovered(taskId: string, outcome: RecoveryOutcome): Promise<void>;
    /**
     * Per-category bytes (§12.7.2.1). `journal` and `quarantine` are MEASURED
     * off the filesystem — they are this object's own footprint, so guessing
     * would be inexcusable. `cache`/`log`/`workspace` are owned by other
     * subsystems, so they come from whatever they last reported into
     * `local_storage_usage`; with nothing reported the answer is an explicit
     * zero-marked-approximate, never a fabricated estimate.
     */
    measureUsage(): Promise<LocalStorageUsage>;
    /**
     * Record what another subsystem measured for a category it owns. Beyond
     * S3.3's minimum API and deliberately restricted to the three categories
     * this journal does NOT measure itself — reporting a number for `journal`
     * or `quarantine` would let a stale figure override a measured one.
     */
    reportCategoryUsage(category: (typeof HOST_REPORTED_CATEGORIES)[number], usage: CategoryUsage): Promise<void>;
    /**
     * Register something the cleanup worker may act on. Beyond S3.3's minimum
     * API (which has no producer for the candidate table), and the only way a
     * row gets in: `category` is typed {@link CleanableCategory}, so protected
     * data has no spelling that would let it be enqueued in the first place.
     */
    enqueueCleanupCandidate(candidate: {
        readonly candidateId: string;
        readonly category: CleanableCategory;
        readonly ref: string;
        readonly eligibleAt: string;
        readonly reason: string;
    }): Promise<void>;
    listCleanupCandidates(now: Date, limit: number): Promise<CleanupCandidate[]>;
    /**
     * `deleted`/`skipped` resolve the candidate; `failed` does NOT — it bumps
     * the attempt count and records the error, leaving the row eligible again.
     * That asymmetry is what makes a cleanup worker crash safe in either order:
     * crash after deleting the file but before marking, and the candidate is
     * retried against a file that is already gone (a no-op the worker reports as
     * `deleted`); crash after marking but before deleting, and the metadata says
     * resolved for something still on disk, which the next reference scan
     * re-enqueues. Neither order can lose protected data, because protected data
     * cannot be a candidate at all.
     */
    markCleanupResult(result: CleanupResult): Promise<void>;
    /**
     * §12.7.2.1's cleanup step 3: drop one task's journal rows, but ONLY when
     * the cloud has confirmed its terminal and it carries no recovery marker.
     *
     * Beyond S3.3's minimum API, and the ONLY deletion path this journal has.
     * The eligibility test is the first statement INSIDE the transaction that
     * would delete, so "is this row protected?" and "delete it" cannot be
     * separated by another writer marking it recovered in between — a check
     * performed outside the write lock is a check that can go stale, and the row
     * it goes stale on is recovery evidence.
     *
     * The idempotency receipt goes with the rows. That is deliberate and it is
     * what `retentionMs['confirmed-journal']` exists to protect: once the receipt
     * is gone, a redelivery of that envelope would be appended as new, so the
     * candidate's retention MUST outlast the mailbox redelivery window
     * (`storage-policy.ts`'s `DEFAULT_RETENTION_MS` carries the longest default
     * of the five for exactly this reason). Keeping the receipt forever would
     * trade that risk for an unbounded table, which is the growth this step is
     * here to stop.
     *
     * Returns `false` — having deleted nothing — when the guard refuses.
     */
    pruneConfirmedJournalTask(taskId: string): Promise<boolean>;
    /**
     * WAL checkpoint plus a BOUNDED incremental vacuum. Maintenance only — it
     * goes through the same single-writer queue as everything else, so it can
     * never run concurrently with an ack-critical append, and `incrementalVacuumPages`
     * caps how long one pass can hold that queue.
     */
    compact(options: CompactOptions): Promise<CompactResult>;
    close(): Promise<void>;
}
// ==== @byok-sdk/client dist/daemon/journal/sqlite-support.d.ts ====
import type { DatabaseSync } from 'node:sqlite';
/** Every post-construction boundary crossed before a journal handle is returned to its owner. */
export type JournalOpenStep = 'after-open' | 'after-auto-vacuum' | 'after-wal' | 'after-foreign-keys' | 'after-synchronous' | 'after-header-read';
/**
 * Test-only fault seam for proving that every post-open initialization failure
 * closes the native handle before control returns to the journal constructor.
 */
export interface JournalOpenFaultSeam {
    onStep?(step: JournalOpenStep): void;
    /** Test-only close override; production always calls `DatabaseSync.close()`. */
    close?(db: DatabaseSync): void;
}
/**
 * Initialization failed after SQLite returned a native handle, and closing
 * that handle also failed. Callers must retain their cross-process ownership
 * lease because the helper can no longer prove that no writer remains alive.
 */
export declare class JournalHandleCleanupError extends Error {
    readonly failures: readonly unknown[];
    constructor(message: string, failures: readonly unknown[]);
}
/**
 * Whether `nodeVersion` (a `major.minor.patch` string shaped like
 * `process.versions.node`) is new enough for `node:sqlite` to exist at all.
 * A version-string heuristic only — `node:sqlite` shipped in 22.5.0 behind
 * `--experimental-sqlite` and became usable unflagged later, so a runtime
 * passing this can still fail to load the module. {@link isSqliteAvailable}
 * is the authoritative check; this one only exists to turn the common
 * "Node too old" case into a specific message. Unparsable input returns
 * `true` (the `require` below is the real gate; don't false-negative on a
 * version shape this hasn't seen).
 */
export declare function isSqliteCapableNodeVersion(nodeVersion: string): boolean;
/**
 * Synchronously load `node:sqlite` via `createRequire` rather than a dynamic
 * `import()`. `DatabaseSync`'s entire API is synchronous, and the journal is
 * constructed synchronously from `createDaemonWithAdapters` alongside every
 * other daemon-local store (`DeviceStore`, `CursorStore`, ...) — an async
 * factory here would leak into every one of those call sites for nothing.
 * `node:sqlite` is a built-in, so `require` resolves it even from this
 * `"type": "module"` package. Memoized: the throw is re-derived per call from
 * the version check rather than cached, which keeps the failure message
 * accurate without keeping a rejected value around.
 */
export declare function loadSqliteModule(): typeof import('node:sqlite');
/**
 * Whether `node:sqlite` can ACTUALLY be loaded right now. This is what the
 * journal's own test suites use for `describe.skipIf(!isSqliteAvailable())`
 * (the same idiom `@byok-sdk/server`'s SQLite suites already use), and what
 * `createDaemonWithAdapters` calls before constructing a hosted journal so
 * the refusal is a typed, up-front error instead of a cryptic
 * `Cannot find module 'node:sqlite'` from deep inside the first append.
 */
export declare function isSqliteAvailable(): boolean;
/**
 * Open (or create) the journal database at `path` with the durability
 * settings architecture §12.7.2 pins, in the order they have to be applied:
 *
 * 1. `auto_vacuum = INCREMENTAL` — MUST precede table creation. `auto_vacuum`
 *    is only settable on a database with no schema yet; setting it afterward
 *    is silently ignored, and `compact()`'s `PRAGMA incremental_vacuum` would
 *    then be a no-op that reports success.
 * 2. `journal_mode = WAL` — a reader and the single writer proceed without
 *    blocking each other, and it is what makes "drop the instance, reopen the
 *    same file" (the entire crash-matrix method) reliable.
 * 3. `foreign_keys = ON` — the journal's tables are a real graph
 *    (transition -> task -> envelope); an orphan row here is corrupted
 *    recovery evidence, not a tolerable inconsistency.
 * 4. `synchronous = FULL` — every ack-critical transaction fsyncs before it
 *    reports committed. This is THE setting the "durable append then cursor
 *    ack" ordering rests on; NORMAL would let the WAL commit land in the OS
 *    page cache, so the cursor could advance over an envelope a power cut
 *    then erases. Applied database-wide rather than per-transaction: the
 *    journal's whole reason to exist is ack-critical writes, and the
 *    maintenance paths that do not need it (checkpoint, incremental vacuum)
 *    are off the hot path anyway.
 *
 * `busyTimeoutMs` bounds how long a write waits on the lock before throwing
 * `SQLITE_BUSY` — bounded on purpose, so contention surfaces as an error the
 * caller sees rather than an unbounded stall on the envelope path.
 *
 * Throws whatever `node:sqlite` throws (module load failure, a corrupt file,
 * an unreadable directory). Every caller is `SqliteLocalTaskJournal`'s
 * constructor, which turns each of those into its own typed error — see
 * `sqlite-journal.ts`.
 */
export declare function openJournalDatabase(path: string, busyTimeoutMs: number, faults?: JournalOpenFaultSeam): DatabaseSync;
/**
 * Restrict the journal database and its WAL/SHM siblings to owner-only
 * read/write. The journal holds raw task envelopes (instructions, policy) with
 * no other access-control layer of its own, so it must not be left at whatever
 * the process umask would give it. Call AFTER the schema exists, so the
 * WAL/SHM files SQLite creates lazily on first write are already there; a
 * sibling that does not exist yet is skipped rather than treated as an error.
 */
export declare function secureJournalFilePermissions(dbPath: string): void;
// ==== @byok-sdk/client dist/daemon/journal/storage-policy.d.ts ====
/**
 * `LocalStoragePolicy`, the watermark state machine, and the classified GC
 * engine (architecture §12.7.2.1).
 *
 * §12.7.2 gives the daemon a database it must not lose. This file is the other
 * half of that promise: a machine that runs out of disk cannot commit an
 * ack-critical transaction, and a daemon that keeps acking mailbox rows it
 * cannot durably record is losing tasks. So local storage stops being an
 * operational afterthought and becomes an admission-control input.
 *
 * Three shapes here are load-bearing:
 *
 * - **The state machine is §12.7.2.1's table, not a threshold check.** Four
 *   states with distinct *behaviours*: `normal` runs unhurried maintenance;
 *   `pressure` alerts and cleans only what can be rebuilt; `hard-pressure`
 *   stops taking NEW work while everything that finishes existing work keeps
 *   running; `emergency` refuses to ack at all. The difference between
 *   `hard-pressure` and `emergency` is the whole design: one declines offers
 *   (a task the dispatcher can place elsewhere), the other freezes the cursor
 *   (a task the mailbox will redeliver). Neither deletes anything to make room.
 * - **Cleanup is ordered and bounded, and it cannot name protected data.**
 *   The order is §12.7.2.1's 1-5, verbatim. The categories are
 *   {@link CleanableCategory}, which has no member for an unacked envelope, a
 *   `Running` task, an unconfirmed terminal, a recovery-marked row, a user
 *   workspace, or quarantine evidence — so no amount of pressure can express
 *   deleting one. Under pressure the order is TRUNCATED to its rebuildable
 *   prefix rather than extended: being short of disk is the worst moment to
 *   start deleting durable records, and the two cheap categories are the ones
 *   that give space back immediately.
 * - **Everything measurable is injected.** Usage comes from the journal, free
 *   space from a provider (`fs.statfs` in production), time from a clock, and
 *   the cadence from a caller-driven `tick()`. There is no wall-clock race
 *   anywhere in this file's behaviour, which is what lets the S3.4 disk-pressure
 *   matrix assert state transitions instead of waiting for them.
 */
import type { CategoryUsage, CleanableCategory, CleanupCandidate, CleanupResult, CompactResult, LocalStorageUsage, LocalTaskJournal, StorageCategory } from './journal';
/** §12.7.2.1's recommended soft watermark: "达到约 80% budget". */
export declare const DEFAULT_SOFT_BUDGET_RATIO = 0.8;
/** §12.7.2.1's recommended hard watermark: "达到约 90% budget". */
export declare const DEFAULT_HARD_BUDGET_RATIO = 0.9;
/**
 * Free bytes below which one ack-critical transaction can no longer be
 * guaranteed, i.e. §12.7.2.1's `emergency` trigger. Sized for a WAL frame
 * batch plus the checkpoint headroom a `synchronous=FULL` commit needs, not
 * for a single row — a commit that cannot grow the WAL fails as surely as one
 * that cannot grow the database.
 */
export declare const DEFAULT_ACK_CRITICAL_RESERVE_BYTES: number;
/** Upper bound on how many candidates one cleanup pass may act on. Bounded so a pass cannot monopolise the journal's single writer. */
export declare const DEFAULT_CLEANUP_BATCH_LIMIT = 64;
/** Upper bound on freelist pages one compaction pass returns to the filesystem. */
export declare const DEFAULT_INCREMENTAL_VACUUM_PAGES = 64;
/** Unhurried maintenance cadence while `normal` — §12.7.2.1's "常规低频 GC/compaction". */
export declare const DEFAULT_NORMAL_COMPACTION_INTERVAL_MS: number;
/** The accelerated cadence §12.7.2.1 asks for at `pressure` and above ("加快 journal compaction"). */
export declare const DEFAULT_PRESSURE_COMPACTION_INTERVAL_MS: number;
/**
 * Per-category retention, as milliseconds between something becoming garbage
 * and becoming ELIGIBLE for automatic cleanup (§12.7.5).
 *
 * `confirmed-journal` is deliberately the longest: pruning a journal row also
 * drops its idempotency receipt, so its retention MUST outlast the mailbox
 * redelivery window, or a very late redelivery would re-append an envelope
 * this device already finished. `orphan-artifact` carries §12.7.5's 24-hour
 * grace period, which is the reference scan's safety margin, not a guess.
 */
export declare const DEFAULT_RETENTION_MS: Readonly<Record<CleanableCategory, number>>;
/**
 * Log rotation parameters (§12.7.2.1 lists them among a `LocalStoragePolicy`'s
 * minimum contents).
 *
 * This SDK does not own the daemon's log writer — the host does. These are
 * therefore the CONTRACT a host's rotator reads, and the reason they live here
 * rather than in host config is that the rotated files they produce become
 * `rotated-log` cleanup candidates governed by the same retention above. Two
 * separate numbers for "when to rotate" and "when to delete" is exactly how a
 * disk fills up with files nobody owns.
 */
export interface LogRotationPolicy {
    /** Rotate the active log once it exceeds this size. */
    readonly maxFileBytes: number;
    /** How many rotated generations to keep before the oldest becomes a `rotated-log` cleanup candidate. */
    readonly keepFiles: number;
}
export declare const DEFAULT_LOG_ROTATION: LogRotationPolicy;
/** Bounded compaction scheduling — see {@link LocalStoragePressureEngine.tick}. */
export interface CompactionPolicy {
    readonly incrementalVacuumPages: number;
    readonly normalIntervalMs: number;
    readonly pressureIntervalMs: number;
}
/**
 * The host-injected policy, resolved and validated (§12.7.2.1: "由 host/daemon
 * config 注入，至少包含 `maxStoreBytes`、`minFreeBytes`、soft/hard watermark、
 * 各数据类别的 retention、workspace policy 与 log rotation").
 */
export interface LocalStoragePolicy {
    /** Total bytes this daemon's store directory may occupy. The budget the soft/hard ratios apply to. */
    readonly maxStoreBytes: number;
    /** Free bytes on the store's filesystem below which this device is at HARD pressure regardless of its own budget. */
    readonly minFreeBytes: number;
    /** Free bytes below which this device is at SOFT pressure. Defaults to twice {@link minFreeBytes}, so pressure engages one doubling before the floor. */
    readonly softMinFreeBytes: number;
    readonly softBudgetRatio: number;
    readonly hardBudgetRatio: number;
    readonly ackCriticalReserveBytes: number;
    readonly retentionMs: Readonly<Record<CleanableCategory, number>>;
    readonly logRotation: LogRotationPolicy;
    readonly cleanupBatchLimit: number;
    readonly compaction: CompactionPolicy;
}
/** What a host actually writes. Everything but the two budget numbers has a §12.7.2.1 default. */
export interface LocalStoragePolicyInput {
    maxStoreBytes: number;
    minFreeBytes: number;
    softMinFreeBytes?: number;
    softBudgetRatio?: number;
    hardBudgetRatio?: number;
    ackCriticalReserveBytes?: number;
    retentionMs?: Partial<Record<CleanableCategory, number>>;
    logRotation?: Partial<LogRotationPolicy>;
    cleanupBatchLimit?: number;
    compaction?: Partial<CompactionPolicy>;
}
/**
 * Thrown when a storage policy is internally inconsistent or out of range.
 *
 * Rejected at CONSTRUCTION, before a daemon exists, for the same reason
 * `JournalUnavailableError` is: a policy whose hard watermark sits below its
 * soft one, or whose budget is zero, produces a daemon that behaves plausibly
 * until the day it matters. There is no clamping and no "closest sensible
 * value" here — a misconfigured durability policy is a configuration bug to
 * fix, not a number to guess at.
 */
export declare class LocalStoragePolicyError extends Error {
    constructor(field: string, reason: string);
}
/**
 * Thrown by {@link LocalStoragePressureEngine.assertAckCriticalAllowed} while
 * the device is in `emergency`.
 *
 * Thrown from the daemon's envelope handler, BEFORE the journal append, which
 * is what makes it §12.7.2.1's "fail-closed，不 ack 新 mailbox row": the
 * handler rejects, so `ConnectionManager` records a stall instead of advancing
 * the cursor, so the mailbox keeps the row and redelivers it. The task is not
 * lost — it is left where it is still safe, which is the cloud.
 */
export declare class LocalStorageEmergencyError extends Error {
    constructor(reason: string);
}
/**
 * Validate and fill in a host's policy. The ONE place a `LocalStoragePolicy`
 * comes into existence, so every consumer downstream can treat its fields as
 * already checked.
 */
export declare function resolveLocalStoragePolicy(input: LocalStoragePolicyInput): LocalStoragePolicy;
/**
 * When something that became garbage at `since` becomes eligible for automatic
 * cleanup. The ONE place retention turns into a timestamp, so a producer
 * calling `enqueueCleanupCandidate` and this engine consuming it agree by
 * construction rather than by two matching constants.
 */
export declare function cleanupEligibleAt(policy: LocalStoragePolicy, category: CleanableCategory, since: Date): string;
/**
 * §12.7.2.1's four states, verbatim:
 *
 * | state | trigger | behaviour |
 * | --- | --- | --- |
 * | `normal` | below soft | unhurried GC/compaction |
 * | `pressure` | ≥ soft budget, or free below the soft minimum | alert; clean only rebuildable/expired categories; accelerate compaction |
 * | `hard-pressure` | ≥ hard budget, or free below the hard minimum | stop admitting new ordinary tasks; terminal/truth flush, delete, export and recovery all continue |
 * | `emergency` | one ack-critical transaction can no longer be guaranteed | fail closed: do not ack new mailbox rows; preserve existing recovery evidence |
 */
export type StoragePressureState = 'normal' | 'pressure' | 'hard-pressure' | 'emergency';
export interface StorageMeasurement {
    readonly usage: LocalStorageUsage;
    readonly freeBytes: number;
}
/**
 * The state machine itself — a pure function of policy, measurement, and
 * whether an ack-critical write has already been observed to fail.
 *
 * Evaluated worst-first: `emergency` is not "very bad pressure", it is a
 * different claim (the next commit may not land), so it is decided before any
 * budget arithmetic. `latchedFailure` exists because the cheapest evidence
 * that a transaction cannot complete is one that already did not: a disk-full
 * error from an ack-critical write is a fact, where free-space arithmetic is
 * an estimate.
 */
export declare function computePressureState(policy: LocalStoragePolicy, measurement: StorageMeasurement, latchedFailure?: string): StoragePressureState;
/**
 * §12.7.2.1's cleanup order, 1-5:
 *
 * 1. expired upload/download temp files and rebuildable caches;
 * 2. rotated logs past their retention;
 * 3. journal rows for tasks whose terminal the cloud confirmed and that carry
 *    no recovery marker — **compact first, then batch delete**;
 * 4. host-marked ephemeral workspaces for tasks already terminal;
 * 5. orphan artifacts, after a reference scan plus grace period.
 *
 * Under pressure the order is TRUNCATED to steps 1-2, not extended. Steps 3-5
 * touch durable records, need a compaction or a reference scan first, and give
 * their space back slowly; steps 1-2 are pure rebuildable garbage and give it
 * back immediately. Deleting durable evidence is exactly the wrong reflex when
 * the disk is nearly full, so it stays on the unhurried `normal` cadence where
 * a mistake is recoverable.
 */
export declare function cleanupOrderFor(state: StoragePressureState): readonly CleanableCategory[];
/** What a {@link CleanupExecutor} did with one candidate. Mirrors {@link CleanupResult} minus the bookkeeping the engine fills in. */
export interface CleanupExecution {
    readonly outcome: 'deleted' | 'skipped' | 'failed';
    readonly bytesReclaimed?: number;
    readonly error?: string;
}
/**
 * Performs one candidate's actual deletion.
 *
 * A seam rather than a method because the journal owns metadata and the
 * filesystem owns bytes, and the crash window BETWEEN them (delete the file,
 * die before marking; mark, die before deleting) is S3.4 point 12. Keeping
 * them separate is what lets that window be tested at all.
 *
 * It receives a {@link CleanupCandidate}, whose `category` is a
 * {@link CleanableCategory} — so an executor cannot be handed protected data
 * even by a caller trying to.
 */
export type CleanupExecutor = (candidate: CleanupCandidate) => Promise<CleanupExecution>;
/** `confirmed-journal` candidates address a journal task, not a path. This prefix is that distinction, spelled out. */
export declare const JOURNAL_TASK_REF_PREFIX = "task:";
/**
 * The default cleanup worker: filesystem removal for the four path-addressed
 * categories, and a delegated journal prune for `confirmed-journal`.
 *
 * Two deliberate behaviours:
 *
 * - **A missing path is `deleted`, not `failed`.** That is S3.4 point 12's
 *   first order (file gone, metadata not yet marked) converging on retry: the
 *   retry finds nothing to do and says so, rather than looping forever on a
 *   candidate whose work is already done.
 * - **A relative `ref` is refused.** Cleanup resolves paths against nothing —
 *   a relative ref would delete whatever the daemon's cwd happens to make it,
 *   which is not a bug worth having once.
 */
export declare function createFilesystemCleanupExecutor(options?: {
    readonly pruneJournalTask?: (taskId: string) => Promise<boolean>;
}): CleanupExecutor;
/** What the status surface renders, and what a `tick()` hands back. */
export interface StorageStatusSnapshot {
    readonly state: StoragePressureState;
    readonly measuredAt: string;
    readonly budgetBytes: number;
    readonly usedBytes: number;
    readonly freeBytes: number;
    readonly categories: Readonly<Record<StorageCategory, CategoryUsage>>;
    readonly lastCompaction?: CompactResult & {
        readonly at: string;
    };
}
export type StoragePressureEvent = 
/** §12.7.2.1's "发出告警" — emitted on every transition, including back down to `normal`. */
{
    readonly kind: 'state-changed';
    readonly from: StoragePressureState;
    readonly to: StoragePressureState;
    readonly snapshot: StorageStatusSnapshot;
} | {
    readonly kind: 'cleanup';
    readonly result: CleanupResult;
    readonly category: CleanableCategory;
} | {
    readonly kind: 'compaction';
    readonly result: CompactResult;
};
export interface StorageTickResult {
    readonly state: StoragePressureState;
    readonly snapshot: StorageStatusSnapshot;
    readonly cleaned: readonly CleanupResult[];
    readonly compaction?: CompactResult;
}
export interface TimerLike {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}
export interface LocalStoragePressureEngineOptions {
    readonly policy: LocalStoragePolicy | LocalStoragePolicyInput;
    readonly journal: LocalTaskJournal;
    /** Free bytes on the store's filesystem. `fs.statfs` in production (see {@link createStatfsFreeBytesProvider}); a fixed number under test. */
    readonly freeBytesProvider: () => number | Promise<number>;
    /** Performs deletions. Defaults to {@link createFilesystemCleanupExecutor}. */
    readonly executor?: CleanupExecutor;
    readonly clock?: () => Date;
    readonly onEvent?: (event: StoragePressureEvent) => void;
    /** Reports only the scheduler's own maintenance pass outcome; never includes task-domain failures. */
    readonly onMaintenanceOutcome?: (outcome: 'success' | 'failure') => void;
    /** Injected so `start()`'s periodic driver is substitutable; the matrix never uses it and drives {@link LocalStoragePressureEngine.tick} directly. */
    readonly timers?: TimerLike;
}
/**
 * Drives §12.7.2.1: measure, decide the state, clean in order, compact within
 * bounds — and answer the two questions the rest of the daemon asks
 * ({@link admissionGuard}, {@link assertAckCriticalAllowed}).
 *
 * The cadence is a caller-driven {@link tick}. `start()` merely arranges for
 * something to call it periodically, so a host with its own scheduler can skip
 * it entirely, and the disk-pressure matrix can advance state deterministically
 * with no timer at all. Nothing here runs on the envelope or task hot path:
 * the only two things the hot path calls are the two synchronous questions,
 * both of which read a field.
 */
export declare class LocalStoragePressureEngine {
    #private;
    readonly policy: LocalStoragePolicy;
    constructor(options: LocalStoragePressureEngineOptions);
    get state(): StoragePressureState;
    /** The last measured snapshot, or `undefined` before the first {@link tick}. */
    snapshot(): StorageStatusSnapshot | undefined;
    /**
     * §12.7.2.1's hard-pressure row, as a `TaskRunnerDeps.admissionGuard`:
     * "停止接收新的普通 task；仍允许 terminal/truth flush、删除、导出、doctor 与
     * 恢复操作".
     *
     * The decline is RETRYABLE because pressure is a property of this device at
     * this moment — a dispatcher re-routing the task to another device genuinely
     * helps, and the same device may take it in a minute. Nothing in this method
     * touches the disk; it reads the state the last tick computed, so an offer
     * arriving between ticks is answered instantly.
     */
    admissionGuard(): {
        readonly admit: true;
    } | {
        readonly admit: false;
        readonly reason: string;
        readonly retryable: boolean;
    };
    /** Throws {@link LocalStorageEmergencyError} while in `emergency`. Called immediately before every ack-critical journal append. */
    assertAckCriticalAllowed(): void;
    /**
     * Latch `emergency` from an ack-critical write that ACTUALLY failed.
     *
     * A commit that returned `SQLITE_FULL` is stronger evidence than any free-space
     * estimate, and it must not be forgotten on the next tick just because the
     * arithmetic happens to look survivable. The latch clears only when a tick
     * measures a genuinely `normal` device — not `pressure`, not `hard-pressure`:
     * coming back from "the disk refused a write" requires actual headroom, not a
     * borderline reading.
     */
    noteAckCriticalFailure(reason: string): void;
    /**
     * One maintenance pass: measure, transition, clean in order, compact if due.
     *
     * Ordered this way on purpose — the cleanup pass acts on the state THIS
     * measurement produced, so a device that just crossed into pressure cleans on
     * the same tick it alerts, rather than one cadence later.
     */
    tick(): Promise<StorageTickResult>;
    /** Begin periodic ticking. A host with its own scheduler need never call this. */
    start(): void;
    stop(): Promise<void>;
}
/**
 * Production free-space provider: bytes available to an unprivileged process
 * on the filesystem holding `dir`.
 *
 * `bavail`, not `bfree` — the reserved blocks `bfree` includes are not space
 * this daemon can write into, and treating them as headroom is how a device
 * discovers it is out of disk at commit time instead of at measurement time.
 */
export declare function createStatfsFreeBytesProvider(dir: string): () => Promise<number>;
// ==== @byok-sdk/client dist/daemon/mcp-tools-probe.d.ts ====
import type { McpStdioServerConfig } from '../types';
import { McpAuthorityError } from '../mcp/client';
import { type McpServerObservation } from '../mcp/observation';
import type { ToolImplementationIdentityV1 } from './tool-implementation-identity';
/**
 * The daemon's admission-time use of the shared MCP core (`../mcp/`).
 *
 * This file owns the admission POLICY — the deadlines an offer may wait on and
 * what the runner does with a failure — and nothing else. The connection, the
 * byte bounds, the name rules and the descriptor shape all belong to the core,
 * so the observation the daemon admits on and the one the Pi extension
 * projects its tools from are the same code reading the same server.
 */
export declare const MCP_TOOLS_PROBE_TIMEOUT_MS = 10000;
/**
 * The single admission budget for observing ALL of one task's projected
 * toolset servers, however many there are.
 *
 * `handleOffer` runs inside its connection's FIFO, so anything it awaits also
 * delays the `task.cancel` / `task.approve` / next-offer envelopes queued
 * behind it. Observing a toolset's servers one after another would multiply
 * the per-server timeout by the server count — a device configured to the
 * current ceiling (16 toolsets × 16 servers) could hold the control channel
 * for minutes on a single unresponsive command. The runner therefore starts
 * every observation at once and gives each one this same deadline, so total
 * admission latency is bounded by one timeout regardless of server count, and
 * each one still kills its own child when the deadline expires.
 */
export declare const MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS = 10000;
export interface McpToolsProbeOptions {
    /** Prefix used in every error message, so a failure names the thing that failed. */
    label?: string;
    timeoutMs?: number;
    /**
     * The exact base environment the RUNTIME child of this task receives
     * (`buildRuntimeEnv`, `./environment.ts`) — never `process.env`. The probe
     * spawns a host-configured command, so it must not become the one place the
     * daemon's own ambient credentials (an `AWS_SECRET_ACCESS_KEY` or
     * `DATABASE_URL` set for the daemon's own deployment, this SDK's own
     * `BYOK_*` control-plane variables) reach a server the real runtime path
     * would have filtered out. Required, deliberately: a caller that forgets it
     * fails to compile rather than silently reinstating the blanket passthrough.
     */
    env: Readonly<Record<string, string>>;
    /**
     * Working directory for the probed child — the same directory the runtime
     * CLI is spawned in, so a server resolving relative paths sees what it will
     * see for real. Omitted only when no such directory is resolved before
     * admission.
     */
    cwd?: string;
    /**
     * What this daemon established about the implementation behind this server
     * (`./tool-implementation-identity.ts`), forwarded to the shared MCP core so
     * the probe spawn re-measures an attested one before starting it.
     *
     * Absent means nothing was claimed. The core refuses the spawn rather than
     * demoting the claim, so a probe of an attested server that no longer
     * measures the same fails with an {@link McpAuthorityError} and the task
     * declines permanently.
     */
    implementation?: ToolImplementationIdentityV1;
}
/**
 * Observe one projected toolset server: start it, complete `initialize` +
 * `tools/list`, and return everything it reported about itself.
 *
 * No `tools/call` is ever sent, so an authenticated task binding stays unused
 * until the real runtime invokes it. The child is always killed before this
 * resolves — the observation proves the server can start and enumerate its
 * tools; the runtime spawns its own copy.
 */
export declare function probeMcpServer(serverName: string, server: Readonly<McpStdioServerConfig>, options: McpToolsProbeOptions): Promise<McpServerObservation>;
/**
 * The names-only form, for the one caller that proves a helper can START
 * rather than deciding what a model may call: the Agent message helper
 * preflight (`./agent-message-mcp-preflight.ts`).
 */
export declare function probeMcpServerTools(serverName: string, server: Readonly<McpStdioServerConfig>, options: McpToolsProbeOptions): Promise<readonly string[]>;
/**
 * A probe failure caused by the server's own ANSWER rather than by its
 * environment — an ungrantable tool name, a malformed tool entry, an oversized
 * stream. Retrying cannot change it: the same configured command reports the
 * same thing next time. Callers use this to decline the task permanently
 * instead of re-offering it forever (see `task-runner.ts`).
 *
 * The classification is the core's; the retry decision it drives is the
 * daemon's.
 */
export { McpAuthorityError };
// ==== @byok-sdk/client dist/daemon/memory-guidance.d.ts ====
/**
 * Runtime-neutral instructions for an Agent's model-authored local memory.
 *
 * This is deliberately prompt guidance only: the SDK does not read memory
 * content, infer durable values, or auto-inject files into the operation.
 */
export declare const AGENT_MEMORY_GUIDANCE: string;
export declare function prependAgentMemoryGuidance(instruction: string): string;
// ==== @byok-sdk/client dist/daemon/observer.d.ts ====
import { type AgentEvent, type BlobRef, type Envelope, type RuntimeInfo, type TaskState } from '@byok-sdk/protocol';
import type { ConnectionState } from './connection-manager';
/**
 * M3-2a: local observability for the daemon — the seam a CLI (M3-2b) drives a
 * live task feed, a task list, and approve/reject/unpair from, all LOCALLY
 * against a running daemon (no SaaS-side polling required).
 *
 * Sourcing, without editing `task-runner.ts`: `TaskRunner` never calls
 * anything in this file directly and has no notion it exists. Every
 * task-lifecycle transition it makes is already observable from OUTSIDE the
 * class through two seams `create-daemon.ts` itself owns and constructs:
 *
 * - `TaskRunnerDeps.send` (the callback `TaskRunner` calls for every
 *   `task.claim` / `task.started` / `task.progress` / `task.artifact` /
 *   `task.await_approval` / `task.complete` / `task.fail` / `task.decline` /
 *   `task.cancelled` it ever emits) — `create-daemon.ts` already builds this
 *   closure itself (`send: (envelope) => connection?.send(envelope)`); this
 *   module just gets a chance to look at the same envelope before it goes
 *   out. See `handleOutboundEnvelope`.
 * - `ConnectionManagerOptions.onEnvelope`/`onStateChange` — likewise already
 *   `create-daemon.ts`'s own closures (`(envelope) =>
 *   runner?.handleEnvelope(envelope)`, `(state) => { connectionState = state;
 *   }`). `onEnvelope` additionally exposes the raw INBOUND offer variants —
 *   the one event class with no corresponding outbound envelope of its own — see
 *   `handleInboundEnvelope`.
 *
 * Neither seam required adding anything to `TaskRunnerDeps`/`TaskRunner`
 * itself: both were already plain functions `create-daemon.ts` constructs,
 * so wrapping them (call this module first, then the real behavior,
 * unchanged) is the entire integration.
 */
/** Every local event kind this daemon can emit — see {@link DaemonEvent}. */
export type DaemonEventKind = DaemonEvent['kind'];
export type DaemonEvent = {
    kind: 'offered';
    ts: string;
    taskId: string;
    runtime?: string;
} | {
    kind: 'claimed';
    ts: string;
    taskId: string;
    claimedRuntime?: string;
} | {
    kind: 'started';
    ts: string;
    taskId: string;
}
/** One per normalized `AgentEvent` (not one per `task.progress` batch) — matches "a live task feed" better than re-exposing the wire's own batching. */
 | {
    kind: 'progress';
    ts: string;
    taskId: string;
    event: AgentEvent;
} | {
    kind: 'artifact';
    ts: string;
    taskId: string;
    name: string;
    contentType: string;
    inline?: string;
    blobRef?: BlobRef;
}
/**
 * Finding F4: `approvalId` is populated whenever `TaskRunner` dispatched
 * this approval THROUGH the normal `requestApproval`/`onApprovalDispatched`
 * path (see `noteApprovalDispatched`) — `undefined` only for a
 * hypothetical caller of `handleOutboundEnvelope` that never went through
 * that hook (there is no other producer of `task.await_approval` today).
 * This is the one piece of information an operator needs to actually
 * call `approve`/`reject` (or the `approvals` CLI command) against this
 * specific pending decision — before this fix, nothing surfaced it
 * outside the control socket's `approvals.list`/`approvals.request`
 * internals.
 */
 | {
    kind: 'awaiting-approval';
    ts: string;
    taskId: string;
    summary: string;
    approvalId?: string;
} | {
    kind: 'completed';
    ts: string;
    taskId: string;
    summary: string;
    sessionRef: string;
}
/**
 * Covers BOTH a post-claim `task.fail` and a pre-claim `task.decline` —
 * `preClaim` distinguishes the two. This mirrors the protocol's own
 * `Offered -> Failed` convention (docs/protocol.md "Declined vs. Failed";
 * `TASK_TRANSITIONS`, `@byok-sdk/protocol`): a decline and a failure are the
 * same outcome from a dispatcher's point of view, so this module doesn't
 * invent a parallel `declined` kind the wire model itself doesn't have.
 */
 | {
    kind: 'failed';
    ts: string;
    taskId: string;
    reason: string;
    retryable: boolean;
    preClaim?: boolean;
} | {
    kind: 'cancelled';
    ts: string;
    taskId: string;
    reason?: string;
} | {
    kind: 'connection';
    ts: string;
    state: ConnectionState;
} | {
    kind: 'paired';
    ts: string;
    deviceId: string;
} | {
    kind: 'unpaired';
    ts: string;
} | {
    kind: 'runtimes-detected';
    ts: string;
    runtimes: RuntimeInfo[];
}
/** M4 Phase 2: the control socket's `shutdown` RPC was invoked — emitted once, before this daemon starts tearing itself down, so it lands in the audit log via the exact same subscribe->append plumbing every other event already uses (see `bin/commands/start.ts`). Informational only — do NOT gate any teardown decision on this event; see `shutdown-complete`. */
 | {
    kind: 'shutdown-requested';
    ts: string;
    reason: string;
}
/**
 * M4 Phase 2: emitted once, AFTER the control-socket-driven shutdown
 * sequence has fully finished — active tasks reported failed over the
 * (at that point still-open) connection, then the connection/control
 * socket actually closed (see `create-daemon.ts`'s `performControlShutdown`,
 * which calls this last). This is the event `bin/commands/start.ts` must
 * wait for before treating the daemon as done: reacting to
 * `shutdown-requested` instead would race `daemon.stop()` against the
 * still-in-flight `task.fail` send and silently drop it (confirmed via a
 * real regression — see `daemon-control-socket.test.ts`).
 *
 * Finding F5(b): `undeliveredOutboxCount`, when defined, is the honest
 * post-drain read of `ConnectionManager.outboxLength()` — 0 means the
 * bounded outbox drain (see `ConnectionManager.stop`) genuinely finished
 * before the connection closed; a positive number means that many
 * envelopes (almost certainly including a `task.fail`
 * `shutdownActiveTasks` just enqueued) never actually left the outbox.
 * `undefined` only for a hypothetical caller of `noteShutdownComplete`
 * that didn't pass one — `create-daemon.ts`'s own `performControlShutdown`
 * (the only real producer of this event) always does.
 */
 | {
    kind: 'shutdown-complete';
    ts: string;
    reason: string;
    undeliveredOutboxCount?: number;
}
/**
 * M4 Phase 3 hardening: a wire `task.approve`/`task.reject` (or this
 * device's own redelivered copy of one) arrived for an out-of-band
 * approval a DIFFERENT, faster path (a racing local `approvals.resolve`
 * over the control socket, or this exact decision arriving twice) had
 * already resolved — `TaskRunner.handleApprove`/`handleReject`
 * (`task-runner.ts`) emit this instead of failing the task a second time.
 * Audit-only: never gates any teardown/task-state decision, purely a
 * record that a stale message was seen and correctly ignored — see
 * `NoPendingApprovalError`'s own doc comment (`task-runner.ts`) for the
 * full race this closes.
 */
 | {
    kind: 'stale-approval-decision';
    ts: string;
    taskId: string;
    decision: 'approve' | 'reject';
    reason?: string;
} | {
    kind: 'git-workspace';
    ts: string;
    taskId: string;
    workspaceId: string;
    phase: string;
    headChanged?: boolean;
    commitsSinceBaseline?: number;
    dirty?: {
        staged: number;
        unstaged: number;
        untracked: number;
        conflicted: number;
    };
    errorCategory?: string;
} | {
    kind: 'runtime-disposal-failed';
    ts: string;
    taskId: string;
    runtimeId: string;
    stage: 'signal' | 'quiescence' | 'cleanup';
    reason: string;
}
/**
 * Plan `device-assertion-broker`: one `assertion.issue` control call
 * resolved — either an assertion was minted (`issued`) or one of the six
 * fail-closed gates refused (`denied`, with `reason` naming which one; see
 * `ASSERTION_ISSUE_ERROR_CODES`, `control-protocol.ts`).
 *
 * ONE kind for both outcomes, so an operator reading the feed sees the
 * issuance rate and the refusal rate on the same line shape rather than
 * having to correlate two.
 *
 * The signature and the envelope bytes are NOT fields of this event and
 * never can be. That is structural, not a redaction rule: `bin/audit-log.ts`
 * can only drop what it is handed, and an event type that cannot carry a
 * signature cannot leak one into a durable file no matter how the audit
 * projection is later edited. What IS carried is the metadata an incident
 * needs — which audience, which `jti` (so a suspect assertion presented to
 * the host's cloud can be traced back to the exact local call that minted
 * it), and when it expires.
 *
 * codex round-2 F4 — the union is split by `result` for the same structural
 * reason: on the ISSUED path `audience` came from this daemon's own
 * configured allowlist (operator-authored, safe verbatim), but on the DENIED
 * path it is whatever the CALLER sent — free text that could be a PEM, a
 * signature, or any secret shaped as an audience. So the denied variant has
 * NO raw `audience` field at all; it carries only `audienceSize` (a byte
 * count), computed at event-construction time (`noteDeviceAssertion`). The
 * raw denied audience therefore never reaches the observer feed, `format.ts`,
 * daemon stdout, or the audit file — there is no field to carry it, rather
 * than a redactor that has to remember to strip it.
 *
 * Contract §8.2(1): `task_assertion.issue` resolves onto this SAME event kind
 * with `lane: 'task'`, so an operator reads one issuance/refusal stream rather
 * than correlating two. `lane` is required precisely so the two credential
 * kinds stay distinguishable in the local ledger; `taskId` accompanies the
 * task lane once the daemon has resolved which task the call belongs to.
 *
 * What is NOT a field here, and never can be: the
 * `BYOK_HOST_TOOLSET_CONTEXT` nonce. It is the task lane's entire authority —
 * a value that reaches a log is a value an operator's log shipper can replay
 * — so, exactly like the signature, there is no field to carry it rather than
 * a redactor that must remember to strip it.
 */
 | {
    kind: 'device-assertion';
    ts: string;
    result: 'issued';
    lane: AssertionLane;
    audience: string;
    jti: string;
    expiresAt: string;
    taskId?: string;
} | {
    kind: 'device-assertion';
    ts: string;
    result: 'denied';
    lane: AssertionLane;
    reason: string;
    audienceSize?: number;
    taskId?: string;
};
/** Which assertion lane a `device-assertion` event belongs to (contract §8.1: the two have zero interchange). */
export type AssertionLane = 'device' | 'task';
export type DaemonEventListener = (event: DaemonEvent) => void;
export type Unsubscribe = () => void;
/** `daemon.tasks()`'s per-task view — current local state + whatever summary/outcome was last reported for it. */
export interface DaemonTaskInfo {
    taskId: string;
    state: TaskState;
    runtime?: string;
    /** Actual runtime selected for this task, as reported by the outbound `task.claim` payload. Distinct from `runtime`, which remains the requested offer runtime. */
    claimedRuntime?: string;
    /** Last known human-readable text for this task's current state: an await-approval summary, a complete summary, or a fail/cancel reason — whichever was most recently reported. */
    summary?: string;
    /** Only set once this task has actually reached `task.complete`. */
    sessionRef?: string;
    /** `true` only when `state === 'Failed'` resulted from a pre-claim `task.decline` rather than a post-claim `task.fail` — see the `DaemonEvent` `failed` variant's doc comment. */
    declined?: boolean;
    updatedAt: string;
}
/**
 * M3-B parity (see `task-runner.ts`'s `MAX_TRACKED_TASK_IDS` doc comment,
 * same rationale): this daemon is meant to run as a long-lived background
 * service, so a per-task registry that only ever grows is a slow memory
 * leak. Only TERMINAL entries (`Complete`/`Failed`/`Cancelled`) are ever
 * evicted, oldest first — active entries are never removed here, the same
 * way `TaskRunner.tasks` itself is bounded by real concurrency rather than
 * an explicit cap.
 */
export declare const MAX_TRACKED_TASKS = 2000;
/**
 * Owns both halves of the local observability surface: the pub/sub
 * (`subscribe`/`emit`) and the derived per-task registry (`tasks`). A plain
 * `Set<listener>` with `subscribe` returning its own removal closure — not
 * `node:events`' `EventEmitter` — keeps unsubscribe trivially leak-free
 * (delete-by-reference, no string event names, no listener-count footguns)
 * and keeps `DaemonEvent` a single typed union instead of a per-event-name
 * overload table.
 */
export declare class DaemonObserver {
    private readonly listeners;
    private readonly taskInfo;
    /**
     * Finding F4: `approvalId` for a taskId's NEXT `task.await_approval`,
     * stashed by `noteApprovalDispatched` and consumed (read + deleted) the
     * moment `handleOutboundEnvelope`'s `task.await_approval` case actually
     * emits the corresponding `awaiting-approval` event — see that hook's own
     * doc comment for why this is always populated first (both calls happen
     * synchronously, in that order, from `TaskRunner.dispatchApproval`).
     * Read-and-delete keeps this self-bounding: an entry never outlives the
     * one event it was stashed for, so this can never leak across a
     * long-lived daemon's lifetime the way an evict-on-schedule cache would
     * need explicit bookkeeping to avoid.
     */
    private readonly pendingApprovalIdByTask;
    subscribe(listener: DaemonEventListener): Unsubscribe;
    /** Current locally-known tasks, in first-seen order. */
    tasks(): DaemonTaskInfo[];
    /**
     * Feed a raw INBOUND (server -> daemon) envelope. Deliberately narrow: only
     * either offer variant produces a local event here — every other inbound type
     * (`task.cancel`/`task.steer`/`task.approve`/`task.reject`) is a
     * best-effort notification whose OWN observable effect already surfaces
     * through the daemon's outbound envelopes (`task.cancelled`, `task.progress`
     * resuming, `task.fail`, ...) — see `handleOutboundEnvelope`, which is
     * where those are actually reported from.
     */
    handleInboundEnvelope(envelope: Envelope): void;
    /**
     * Feed a raw OUTBOUND (daemon -> server) envelope — this is where every
     * task-lifecycle local event actually comes from: `TaskRunner` already
     * calls `deps.send(...)` for each of these at exactly the moment its own
     * state machine decides the transition happened.
     */
    handleOutboundEnvelope(envelope: Envelope): void;
    noteConnectionState(state: ConnectionState): void;
    notePaired(deviceId: string): void;
    noteUnpaired(): void;
    noteRuntimesDetected(runtimes: RuntimeInfo[]): void;
    /** M4 Phase 2: see the `shutdown-requested` `DaemonEvent` variant's own doc comment. */
    noteShutdownRequested(reason: string): void;
    /** M4 Phase 2: see the `shutdown-complete` `DaemonEvent` variant's own doc comment (finding F5(b): `undeliveredOutboxCount`). */
    noteShutdownComplete(reason: string, undeliveredOutboxCount?: number): void;
    /**
     * Plan `device-assertion-broker`: see the `device-assertion` `DaemonEvent`
     * variant's own doc comment. The parameter type is what keeps the signature
     * out — there is no field to pass one through.
     *
     * codex round-2 F4: the DENIED caller can pass its raw `audience` here, but
     * it is converted to a byte SIZE the instant the event is constructed and the
     * raw string is dropped — it is never placed on the emitted `DaemonEvent`, so
     * it cannot reach a subscriber, `format.ts`, stdout, or the audit file. The
     * ISSUED `audience` came from the allowlist and is kept verbatim.
     *
     * Contract §8.2(1): `lane` defaults to `'device'` for the existing caller and
     * is passed explicitly by the task lane, which also passes the `taskId` its
     * nonce registry resolved. There is no parameter for the context token, for
     * the same structural reason there is none for the private key.
     */
    noteDeviceAssertion(event: {
        result: 'issued';
        lane?: AssertionLane;
        taskId?: string;
        audience: string;
        jti: string;
        expiresAt: string;
    } | {
        result: 'denied';
        lane?: AssertionLane;
        taskId?: string;
        reason: string;
        audience?: string;
    }): void;
    /** M4 Phase 3 hardening: see the `stale-approval-decision` `DaemonEvent` variant's own doc comment. */
    noteStaleApprovalDecision(taskId: string, decision: 'approve' | 'reject', reason?: string): void;
    noteGitWorkspace(event: {
        taskId: string;
        workspaceId: string;
        phase: string;
        headChanged?: boolean;
        commitsSinceBaseline?: number;
        dirty?: {
            staged: number;
            unstaged: number;
            untracked: number;
            conflicted: number;
        };
        errorCategory?: string;
    }): void;
    noteRuntimeDisposalFailure(event: {
        taskId: string;
        runtimeId: string;
        stage: 'signal' | 'quiescence' | 'cleanup';
        reason: string;
    }): void;
    /**
     * Finding F4: wired from `TaskRunnerDeps.onApprovalDispatched`, called
     * synchronously by `TaskRunner.dispatchApproval` BEFORE its own
     * `deps.send(createEnvelope('task.await_approval', ...))` — stashes
     * `approvalId` so `handleOutboundEnvelope`'s `task.await_approval` case
     * (triggered by that very `send` call) can attach it to the
     * `awaiting-approval` `DaemonEvent` it emits. Never emits anything
     * itself — purely a handoff, same as `upsertTask`'s bookkeeping role for
     * other events.
     */
    noteApprovalDispatched(taskId: string, approvalId: string): void;
    private upsertTask;
    /**
     * Finding P2/#11 (observer half): the "no terminal entry to evict" branch
     * used to just give up and leave the registry unbounded for as long as
     * every tracked task stayed nonterminal (many concurrent/stuck offers that
     * never reach Complete/Failed/Cancelled — the exact case this cap exists
     * for, since a normal quickly-resolving workload always has terminal
     * entries to evict well before this). Falling back to "never evict" here
     * defeats the whole point of `MAX_TRACKED_TASKS`. Fix: fall back to
     * evicting the OLDEST entry regardless of state (same insertion-order
     * idiom as everywhere else this file/`task-runner.ts` bound a collection),
     * logged since it's a real, if rare, observability loss — this registry is
     * a local READ-MODEL only (see the module doc comment), never consulted by
     * `TaskRunner`'s own state machine, so evicting a still-active task's
     * entry here can't affect that task's actual execution — it only means
     * `tasks()`/a CLI's task list can no longer show it until it reports
     * another transition (which re-inserts it via `upsertTask`).
     */
    private evictIfNeeded;
    /**
     * Listener errors are caught here so a broken subscriber (e.g. a CLI's
     * rendering bug) can never propagate back into the real send/onEnvelope
     * path this module wraps — see this file's own module doc comment.
     *
     * Finding #6: `DaemonEventListener` is typed `(event: DaemonEvent) =>
     * void`, but TypeScript's structural typing does not stop a caller from
     * subscribing an `async` function (or anything else returning a promise)
     * where a void-returning callback is expected — nothing here ever
     * validates that at runtime. The `try`/`catch` below only ever catches a
     * SYNCHRONOUS throw; an async listener doesn't throw synchronously, it
     * RETURNS an already-rejected (or later-rejecting) promise, which sails
     * straight past that catch. Left unhandled, that promise's rejection
     * becomes an `unhandledRejection` on the process — which, depending on
     * the host's Node version/flags, can crash the entire daemon over one
     * subscriber's bug (e.g. a CLI's own progress renderer awaiting something
     * that throws). Fix: treat the listener's return value as "possibly a
     * promise" regardless of its declared type, and attach a `.catch` so a
     * later rejection is caught and logged exactly like a synchronous throw,
     * never left to become unhandled. This call stays synchronous itself
     * (never `await`s a listener) — `emit` is invoked from the send/cursor
     * path (`handleOutboundEnvelope`/`handleInboundEnvelope`, wired in
     * directly from `create-daemon.ts`'s `send`/`onEnvelope` closures) and
     * must never make a subscriber's own async work a precondition for
     * cursor advancement or the next envelope being processed.
     */
    private emit;
}
// ==== @byok-sdk/client dist/daemon/operational-health.d.ts ====
import { promises as fs } from 'node:fs';
export type OperationalHealthState = 'healthy' | 'degraded' | 'recovering';
export type OperationalFailureSource = 'reconnect' | 'upload' | 'maintenance' | 'lifecycle';
export interface OperationalCrashRecord {
    detectedAt: string;
    previousRunStartedAt: string;
}
export declare const OPERATIONAL_HEALTH_FILENAME = "operational-health.json";
export declare const MAX_OPERATIONAL_HEALTH_FILE_BYTES: number;
export interface OpenOperationalHealthFile {
    handle: Awaited<ReturnType<typeof fs.open>>;
    stat: import('node:fs').BigIntStats;
}
/**
 * Bind the pathname to a regular-file handle before any bytes are read.
 * POSIX additionally gets O_NOFOLLOW/O_NONBLOCK. On Windows those flags are
 * unavailable, so the pre-open lstat plus handle/path identity checks are the
 * fail-closed authority: a static reparse point is rejected before open, and
 * a raced replacement cannot match the already-observed inode/file state.
 */
export declare function openOperationalHealthFile(storeDir: string): Promise<OpenOperationalHealthFile | undefined>;
export type OperationalHealthFileInspection = {
    status: 'missing';
} | {
    status: 'valid';
    sizeBytes: number;
    state: OperationalHealthState;
    failureCount: number;
    crashCount: number;
    currentRunStartedAt?: string;
    lastCrashAt?: string;
} | {
    status: 'corrupt';
    sizeBytes: number;
    reason: string;
} | {
    status: 'unavailable';
    sizeBytes?: number;
    reason: string;
};
export type OperationalHealthSnapshot = {
    availability: 'available';
    state: OperationalHealthState;
    failureCount: number;
    windowMs: number;
    failureThreshold: number;
    crashCount: number;
    lastCrashAt?: string;
    currentRunStartedAt?: string;
} | {
    availability: 'unavailable';
    reason: string;
};
export interface OperationalHealthOptions {
    windowMs?: number;
    failureThreshold?: number;
    maxFailures?: number;
    maxCrashes?: number;
    clock?: () => Date;
    runId?: () => string;
    pid?: number;
}
export declare class OperationalHealthTracker {
    #private;
    constructor(storeDir: string, options?: OperationalHealthOptions);
    startRun(): Promise<OperationalHealthSnapshot>;
    recordFailure(source: OperationalFailureSource): Promise<void>;
    recordSuccess(_source: OperationalFailureSource): Promise<void>;
    markCleanStop(): Promise<void>;
    snapshot(): OperationalHealthSnapshot;
}
/**
 * Read-only S7-b inspection seam. Unlike `OperationalHealthTracker.startRun`,
 * this never writes a run marker, prunes history, or repairs malformed bytes;
 * doctor can therefore report on an offline daemon without changing the very
 * evidence it is inspecting.
 */
declare function inspectOperationalHealthHandle(handle: Awaited<ReturnType<typeof fs.open>>, expected?: import('node:fs').BigIntStats): Promise<Exclude<OperationalHealthFileInspection, {
    status: 'missing';
}>>;
/**
 * Open a pathname-bound regular-file handle before inspecting. POSIX uses
 * no-follow/non-blocking flags; Windows uses the pre-open and post-open
 * pathname/handle identity checks in openOperationalHealthFile.
 */
export declare function inspectOperationalHealthFile(storeDir: string): Promise<OperationalHealthFileInspection>;
export { inspectOperationalHealthHandle };
// ==== @byok-sdk/client dist/daemon/progress-batcher.d.ts ====
import type { AgentEvent } from '@byok-sdk/protocol';
export type ProgressEmitter = (seq: number, events: AgentEvent[]) => void;
export interface ProgressBatcherOptions {
    /** Flush immediately once this many events are buffered. Default 10. */
    maxBatchSize?: number;
    /** Otherwise flush at most this often (ms) while events are pending. Default 250 (~4/sec). */
    flushIntervalMs?: number;
    /**
     * Optional deployment-owned ceiling for the UTF-8 bytes in the serialized
     * `events[]` array. Unset means no byte ceiling; hosts should inject the
     * same value their activity ingress enforces.
     */
    maxBatchBytes?: number;
}
export declare class ProgressEventTooLargeError extends Error {
    readonly actualBytes: number;
    readonly maxBatchBytes: number;
    constructor(actualBytes: number, maxBatchBytes: number);
}
export declare function validateProgressBatcherOptions(options?: ProgressBatcherOptions): void;
/**
 * Coalesces a task's `AgentEvent`s into seq-ordered `task.progress` batches:
 * flush immediately at `maxBatchSize` events, otherwise at most every
 * `flushIntervalMs` while anything is buffered. One instance per task —
 * `seq` is a per-task monotonic counter starting at 1.
 */
export declare class ProgressBatcher {
    private readonly emit;
    private buffer;
    private seq;
    private timer;
    private readonly maxBatchSize;
    private readonly flushIntervalMs;
    private readonly maxBatchBytes;
    constructor(emit: ProgressEmitter, options?: ProgressBatcherOptions);
    push(event: AgentEvent): void;
    /** M4 Phase 4 (part B.3, observability): events buffered right now, not yet flushed as a `task.progress` batch — a cheap per-task queue-depth watermark for the daemon's control-socket `status` result (see `task-runner.ts`'s `getQueueWatermarks`). */
    get pendingCount(): number;
    flush(): void;
    /** Stop the pending flush timer without flushing (used on teardown). */
    stop(): void;
    private ensureTimer;
    private clearTimer;
}
// ==== @byok-sdk/client dist/daemon/replay-cursor.d.ts ====
/**
 * The server retained no contiguous replay history after the cursor the
 * daemon acknowledged. This is terminal for the current device enrollment:
 * retrying the same cursor can only repeat the loss condition.
 */
export declare class ReplayCursorTooOldError extends Error {
    readonly recoverableFrom?: number | undefined;
    constructor(recoverableFrom?: number | undefined);
}
// ==== @byok-sdk/client dist/daemon/resolve-agent-memory-mcp-bin.d.ts ====
import { type SdkHelperHostConfig } from '../sdk-reserved-helper-host';
export interface ResolvedAgentMemoryMcpBin {
    readonly command: string;
    readonly args: readonly string[];
}
/** Resolve the SDK-owned stdio Agent-memory MCP helper shipped beside the client bundle. */
export declare function resolveAgentMemoryMcpBin(externalHelperConfigured?: boolean, host?: SdkHelperHostConfig): ResolvedAgentMemoryMcpBin | undefined;
// ==== @byok-sdk/client dist/daemon/resolve-agent-message-mcp-bin.d.ts ====
import { type SdkHelperHostConfig } from '../sdk-reserved-helper-host';
export interface ResolvedAgentMessageMcpBin {
    readonly command: string;
    readonly args: readonly string[];
}
/** Resolve the SDK-owned stdio MCP helper shipped beside the client bundle. */
export declare function resolveAgentMessageMcpBin(host?: SdkHelperHostConfig): ResolvedAgentMessageMcpBin;
// ==== @byok-sdk/client dist/daemon/session-workspace-store.d.ts ====
/** What's recoverable for a given `sessionRef` — see the class doc comment. */
export interface SessionWorkspaceRecord {
    workspaceDir: string;
    /**
     * The underlying runtime's own resumable session identifier.
     */
    runtimeSessionId: string;
    /** Additive workspace kind; missing legacy values remain plain. */
    workspaceKind?: 'plain' | 'git';
    /** Opaque private Git workspace ledger identifier. */
    gitWorkspaceId?: string;
}
/**
 * Persists `sessionRef -> {workspaceDir, runtimeSessionId}` across daemon
 * restarts (finding #3 from the 2026-07-16 live GLM run): a `task.offer`
 * carrying a `sessionRef` this device has previously reported (via a prior
 * task's `task.complete.sessionRef`) reuses that exact workspace directory
 * as the new task's cwd — which is what lets a runtime adapter's own resume
 * mechanism (e.g. pi's `--session <id>`, scoped to the cwd/project a session
 * was created under — see pi-adapter.ts) actually find the session again.
 * An unknown or absent `sessionRef` is simply not in this map, and
 * `task-runner.ts` treats that identically to "no sessionRef was ever
 * offered" — fresh workspace, fresh session.
 *
 * One JSON file under `storeDir`, mirroring `DeviceStore`/`CursorStore`'s
 * own persistence style: always read/write straight through to disk, no
 * in-memory cache that could go stale or need invalidating across multiple
 * `TaskRunner`/daemon instances sharing the same `storeDir` (exactly the
 * "map persisted across daemon restart" requirement).
 *
 * Two correctness properties `task-runner.ts` depends on, neither of which
 * a bare `fs.writeFile` + independent `fs.readFile` calls actually gives
 * you:
 *
 * 1. **No torn reads.** `record()` is deliberately fire-and-forgotten from
 *    `handleOffer` (see its call site) — it must never block `task.started`
 *    on a disk write. But a bare `fs.writeFile` is not atomic: it truncates
 *    the file before writing the new bytes, so a `get()` racing an
 *    in-flight `record()` on another task's offer can `JSON.parse` a
 *    half-written file, fail, and silently fall back to `{}` (see `load()`)
 *    — resolving what should have been a resume to a fresh workspace.
 *    `save()` below instead writes to a private temp file in the same
 *    directory and `fs.rename`s it onto the real path, which POSIX
 *    guarantees is atomic when both paths share a filesystem (true here —
 *    same directory): any concurrent reader sees either the fully-old or
 *    fully-new bytes, never a partial write.
 * 2. **No lost updates.** Two `record()` calls for two different
 *    `sessionRef`s that overlap (both `load()` the same on-disk snapshot,
 *    each mutate their own key into their own in-memory copy, then `save()`
 *    back to back) would otherwise let the second `save()` overwrite the
 *    first's key with a snapshot that never saw it — each individual
 *    `save()` being atomic does not prevent this. `enqueue()` below chains
 *    every `get()`/`record()` through one serial promise queue per
 *    instance, so no two load-modify-save cycles (or a read and a
 *    concurrent write) ever interleave.
 */
export declare class SessionWorkspaceStore {
    private readonly filePath;
    /**
     * Serial "mutex" queue: every `get()`/`record()` chains its work off this
     * promise and replaces it, so operations on this instance always run
     * one-at-a-time, in call order — never interleaved. The queue's own tail
     * is never allowed to reject (a failed task must not wedge every
     * subsequent caller behind a rejected promise); the failure still
     * propagates to that call's own caller via the returned promise.
     */
    private queue;
    constructor(storeDir: string);
    get(sessionRef: string): Promise<SessionWorkspaceRecord | undefined>;
    record(sessionRef: string, entry: SessionWorkspaceRecord): Promise<void>;
    /** See the class doc comment's "no lost updates" property. */
    private enqueue;
    private load;
    private save;
}
// ==== @byok-sdk/client dist/daemon/skill-pack-installer.d.ts ====
import { type CapabilityDeclaration } from '@byok-sdk/core';
import type { AuthManager } from './auth-manager';
/**
 * The hosted capability this pipeline gates on. A plain string, not an import
 * from `@byok-sdk/cloud`: the daemon must not gain a dependency on the hosted
 * implementation, and ADR-010 makes capability names deployment vocabulary that
 * core validates the shape of but never the meaning of. Same rule the presence
 * producer's `PRESENCE_HINTS_CAPABILITY` follows.
 */
export declare const SKILL_PACKS_CAPABILITY = "skills.pack";
/** Directory under `dataDir` this module owns end to end. */
export declare const SKILL_PACKS_DIRNAME = "skill-packs";
/** Per-pack pointer at the installed content-addressed revision. */
export declare const SKILL_PACK_LOCK_FILENAME = "lock.json";
/** Append-only install/refusal record, beside the packs it describes. */
export declare const SKILL_PACK_AUDIT_FILENAME = "audit.jsonl";
export declare const SKILL_PACK_LOCK_SCHEMA = "byok-skill-pack-lock-v1";
/**
 * Ceiling on a single HTTP response this pipeline will read into memory.
 *
 * Deliberately derived from the pack cap rather than chosen independently: the
 * largest legitimate manifest list is bounded by what a pack may declare, and a
 * response beyond that is refused before it is parsed rather than after. A
 * transfer cap that is not evaluated is the exact failure this plan set out not
 * to repeat.
 */
export declare const SKILL_PACK_RESPONSE_MAX_BYTES: number;
export declare const SKILL_PACK_INSTALL_ERROR_CODES: readonly ['capability_unavailable', 'transport_failed', 'response_invalid', 'response_too_large', 'manifest_invalid', 'content_rejected', 'store_unsafe'];
export type SkillPackInstallErrorCode = (typeof SKILL_PACK_INSTALL_ERROR_CODES)[number];
/**
 * Every way an install can be refused, as one type with a `code`.
 *
 * Code-based branching rather than a class per failure — the same idiom
 * `@byok-sdk/core` uses — because a caller only ever needs two decisions from
 * this: "was the channel unavailable" (retry later, or the deployment simply
 * does not offer it) versus "was the content refused" (a publication problem
 * nobody on this device can fix by retrying).
 */
export declare class SkillPackInstallError extends Error {
    readonly code: SkillPackInstallErrorCode;
    readonly packName: string | undefined;
    constructor(code: SkillPackInstallErrorCode, message: string, options?: {
        cause?: unknown;
        packName?: string;
    });
}
/** What a device recorded about one installed pack. Mirrors `lock.json` on disk. */
export interface SkillPackLock {
    readonly schema: typeof SKILL_PACK_LOCK_SCHEMA;
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly content_hash: string;
    /** The deployment the pack came from, normalized to its http(s) origin. Never a token, never a path. */
    readonly source: string;
    readonly installed_at: string;
    readonly files: readonly {
        readonly path: string;
        readonly sha256: string;
        readonly bytes: number;
    }[];
}
export interface InstalledSkillPack {
    readonly name: string;
    readonly lock: SkillPackLock;
    /** Absolute path of the content-addressed revision `lock.json` points at. */
    readonly directory: string;
}
export interface InstallSkillPacksOptions {
    /** The SDK data directory. A daemon passes its `storeDir`; the pack tree lives beside its other private state. */
    readonly dataDir: string;
    readonly serverUrl: string;
    readonly auth: AuthManager;
    /** The declaration read from `GET /byok/capabilities`. Never re-derived here, and never assumed. */
    readonly declaration: CapabilityDeclaration;
    readonly signal?: AbortSignal;
}
export interface SkillPackInstallResult {
    readonly installed: readonly InstalledSkillPack[];
    /** Packs already present at the same content hash. Re-installing is a no-op, not a rewrite. */
    readonly unchanged: readonly string[];
}
/** The store root this module owns. */
export declare function skillPacksRoot(dataDir: string): string;
/**
 * Fetches, verifies and installs every pack this deployment offers.
 *
 * @throws {SkillPackInstallError} `capability_unavailable` before any request
 * is issued when the declaration does not name `skills.pack`.
 */
export declare function installSkillPacks(options: InstallSkillPacksOptions): Promise<SkillPackInstallResult>;
/**
 * Every pack this device has a valid lock for, sorted by name.
 *
 * Reads only the locks — never the pack bytes — so a caller listing what is
 * installed pays nothing for packs it is not about to project.
 */
export declare function listInstalledSkillPacks(dataDir: string): Promise<readonly InstalledSkillPack[]>;
export interface ProjectedSkillPack {
    readonly name: string;
    readonly contentHash: string;
    readonly targetDir: string;
    readonly files: readonly string[];
}
/**
 * Copies an installed pack's files into a host-chosen directory.
 *
 * Copy, not symlink, and re-verified on the way out: the store is on the same
 * machine as whatever else runs there, so the bytes are hashed again and
 * compared against the lock before they are handed to a runtime. An install
 * that was verified last week is not evidence about the file on disk today.
 *
 * @throws {SkillPackInstallError} `store_unsafe` for a missing pack, a symlink
 * anywhere in the pack, or a file whose bytes no longer match the lock.
 */
export declare function projectSkillPack(dataDir: string, name: string, targetDir: string): Promise<ProjectedSkillPack>;
// ==== @byok-sdk/client dist/daemon/store.d.ts ====
import { type EnsureSecureDirOptions } from '../util/secure-dir';
import { DeviceCredentialStore, InMemoryDeviceCredentialStore, type DeviceMetadata } from './device-credential-store';
export type { DeviceMetadata, DeviceRecord } from './device-credential-store';
/**
 * Non-secret projection of an authenticated device enrollment. This is the
 * complete permitted `device.json` shape. The complete record, including
 * these authenticated metadata fields and secret bytes, lives atomically in
 * DeviceCredentialStore; this file is only its deterministic projection.
 *
 * Internal only: the package root exposes DeviceEnrollment/status, never this
 * storage record.
 */
/** Public credential-blind result of explicit pairing. */
export interface DeviceEnrollment {
    readonly deviceId: string;
}
export interface DeviceEnrollmentStatusOptions {
    productId: string;
    storeDir?: string;
}
/** Credential-blind cold read model for host setup and diagnostics. */
export type DeviceEnrollmentStatus = {
    state: 'unpaired';
} | {
    state: 'paired';
    deviceId: string;
} | {
    state: 're_pair_required';
};
/**
 * A durable enrollment record cannot be used by any steady-state path. Only
 * the explicit pair operation may replace it with a fresh authenticated row.
 */
export declare class DeviceRecordRePairRequiredError extends Error {
    constructor();
}
/**
 * Persists only bounded non-secret enrollment projection. The paired bearer
 * token and private key are never accepted here and are owned by the internal
 * OS DeviceCredentialStore.
 */
export declare class DeviceStore {
    private readonly secureDirOptions?;
    /** Process-local keyed doubles preserve restart semantics in isolated tests. */
    private static readonly testCredentials;
    private readonly filePath;
    /** Internal test seam. Product construction always supplies productId and gets an OS store. */
    readonly credentials: DeviceCredentialStore | InMemoryDeviceCredentialStore;
    /**
     * `secureDirOptions` is a test-only DI seam (mirrors `EnsureSecureDirOptions`'s
     * own `run`/`platform` overrides) — every real caller omits it, getting
     * real `ensureSecureDir(storeDir)` behavior unchanged. It exists so
     * finding R4's fail-closed contract ("on win32, an `icacls` failure makes
     * `save()` — and thus `AuthManager.pair()` — reject with a clear typed
     * `SecureDirHardeningError` instead of silently persisting an
     * ACL-unprotected credential") is verifiable from a real `darwin`/`linux`
     * CI/dev machine, not just asserted.
     */
    constructor(storeDir: string, secureDirOptions?: EnsureSecureDirOptions | undefined, productId?: string);
    static defaultDir(productId: string): string;
    /**
     * Resolve the one store pathname every daemon/CLI component must share.
     * A configured relative path is anchored once at process entry rather than
     * being reinterpreted after a diagnostics operation temporarily changes
     * cwd to pin a quarantine directory inode.
     */
    static resolveDir(productId: string, configured?: string): string;
    load(): Promise<DeviceMetadata | undefined>;
    /**
     * Read and remove the exact bounded, no-follow device record under the
     * caller's mutation lease. The hard-link guard keeps the inspected inode
     * identifiable until the synchronous pathname check and unlink complete.
     */
    remove(): Promise<DeviceMetadata | undefined>;
    /** Rebuild only the non-secret projection, while the caller owns the store lease. */
    reconcileMetadata(authority: DeviceMetadata): Promise<boolean>;
    save(record: DeviceMetadata): Promise<void>;
    private openBounded;
}
/**
 * Read the canonical device store without projecting credential or tenant
 * material. A legacy/tampered record remains distinct from an absent record so
 * hosts can require explicit re-pair instead of silently changing semantics.
 * Filesystem and pathname-safety failures intentionally remain errors.
 */
export declare function readDeviceEnrollmentStatus(options: DeviceEnrollmentStatusOptions): Promise<DeviceEnrollmentStatus>;
// ==== @byok-sdk/client dist/daemon/task-runner.d.ts ====
import { type AgentMessageContentType, type AgentEgressPolicy, type Envelope, type PermissionPolicy, type RuntimeId, type TerminalProjectionSelection, type TaskOfferPayload, type TaskOfferForAgentPayload, type TaskOfferForAgentWithEgressPayload, type TaskOfferForAgentWithEgressFreshPayload, type TaskOfferPreparedPayload, type TaskOfferWithToolsetsPayload } from '@byok-sdk/protocol';
import { type McpStdioServerConfig, type McpToolsetConfig, type RuntimeAdapter } from '../types';
import type { InputPreparationStore } from './input-preparation-store';
import { type InputPreparationRuntimeIdentityV1 } from '../input-preparation';
import { AgentHomeManager, type AgentRef } from '../agent-home';
import { AgentSessionHandoffStore, type AgentTerminalCause } from './agent-session-handoff-store';
import { type RuntimeDisposalStage } from '../runtime-failure';
import { type ApprovalDecision, type ApprovalOrigin, type ApprovalRegistry } from './approvals';
import type { BlobResolver } from './blob-client';
import type { TaskQueueWatermark } from './control-protocol';
import { type McpLaunchCwdConfig } from './trusted-launch-cwd';
import { type ToolImplementationAuthority, type ToolImplementationFsProbe } from './tool-implementation-identity';
import type { LocalAgentReleaseIdentity } from '../release-identity';
import { type ProgressBatcherOptions } from './progress-batcher';
import type { SessionWorkspaceStore } from './session-workspace-store';
import type { GitWorkspaceManager, GitWorkspaceObservation } from './git-workspace';
import type { GitWorkspaceStore, GitWorkspacePhase } from './git-workspace-store';
import type { AgentEgressController } from './agent-egress-controller';
import { type McpToolsProbeOptions } from './mcp-tools-probe';
import { type McpServerObservation } from '../mcp/observation';
import type { ResolvedAgentMessageMcpBin } from './resolve-agent-message-mcp-bin';
import type { ResolvedAgentMemoryMcpBin } from './resolve-agent-memory-mcp-bin';
import { type AgentMemoryAuditWarning, type AgentMemoryHostedProjection } from './agent-memory';
/**
 * M4 Phase 3: default wait for `requestApproval` (see its own doc comment)
 * before force-resolving an unanswered out-of-band approval as a fail-closed
 * rejection — generous enough for a real human to actually notice and act on
 * an approval prompt, short enough that a genuinely abandoned task doesn't
 * tie up daemon/task bookkeeping forever. Overridable via
 * `TaskRunnerDeps.approvalTimeoutMs` (ultimately `DaemonConfig`-configurable —
 * see `create-daemon.ts`).
 */
export declare const DEFAULT_APPROVAL_TIMEOUT_MS: number;
/**
 * Finding F5(a) (cross-model adversarial review): bound on how long
 * `shutdownTask` waits for a single task's OWN `session.interrupt()` before
 * giving up on it specifically and reporting `task.fail` anyway. Without an
 * INNER bound here, a hung `interrupt()` (a misbehaving runtime adapter
 * whose promise never settles) meant `task.fail` for THAT task was never
 * sent at all — not eventually, not ever — because the send was sequenced
 * strictly AFTER the `await`. The OUTER deadline
 * `create-daemon.ts`'s `performControlShutdown` races `shutdownActiveTasks`
 * against (`SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS`) does not help: racing at
 * that layer only unblocks the CALLER to proceed to `stop()`/closing the
 * connection — it does nothing to unstick THIS function's own
 * still-suspended `await`, which just keeps running (harmlessly, since
 * nothing awaits it anymore) in the background forever after, its
 * `deps.send` line never reached. Deliberately shorter than the outer
 * 10s deadline so one hung task's own interrupt can't itself consume the
 * whole outer budget and starve however many OTHER tasks
 * `shutdownActiveTasks` awaits concurrently via `Promise.all`. Overridable
 * via `TaskRunnerDeps.shutdownInterruptTimeoutMs` (ultimately
 * `DaemonOverrides.shutdown.taskInterruptTimeoutMs` — see `create-daemon.ts`).
 */
export declare const DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS = 5000;
/** Bounded retry before terminal publication degrades observably. */
export declare const AGENT_TERMINAL_EVIDENCE_MAX_ATTEMPTS = 3;
/**
 * M4 Phase 4 (fold-in from the P3 gate): bound on how many `requestApproval`
 * calls may sit QUEUED (not yet dispatched — see that method's own doc
 * comment) for the same task at once. Claude's parallel tool use can fire
 * more than one concurrent approval request for the same taskId; this is a
 * defensive ceiling on that fan-out, mirroring `approvals.ts`'s own
 * `MAX_PENDING_APPROVALS` (a whole-daemon cap) one level down (a per-task
 * cap) — not a realistic workload limit. A request arriving once a task's
 * queue is already at this size is rejected fail-closed immediately, the
 * same shape `requestApproval` already uses for an unknown/inactive taskId.
 */
export declare const MAX_PENDING_APPROVALS_PER_TASK = 16;
/**
 * M4 Phase 3 hardening (orchestrator-directed fix): thrown by the
 * `ctx.approvalChannel.resolve` closure built in `handleOffer` below when
 * this task has no CURRENTLY pending out-of-band approval to resolve.
 * Distinguished from a plain `Error` specifically so `handleApprove`/
 * `handleReject` can tell "a wire task.approve/task.reject arrived for an
 * approval a DIFFERENT, faster path (a racing local `approvals.resolve`, or
 * this exact decision arriving twice) already resolved" — a benign,
 * expected race, audit-worthy but never task-state-affecting — apart from
 * "the session's own resolveApproval() failed for some other, genuine
 * reason" (an adapter-level problem, which still fails the task exactly as
 * before). Only ever thrown for an adapter that actually wires up a real
 * approval channel (claude, under `confirm` mode) — pi/codex's own
 * `resolveApproval()` still throw their own unrelated, adapter-specific
 * "not supported at all" errors, which are NOT instances of this class and
 * therefore still fall through to the pre-existing fail-the-task behavior,
 * unchanged.
 */
export declare class NoPendingApprovalError extends Error {
    readonly taskId: string;
    constructor(taskId: string);
}
/**
 * M3-B: cap for both `finishedTaskIds` and `pendingCancelled` below (each
 * gains one entry per finished/cancelled task and was never pruned) — fine
 * for the short-lived CLI invocations M0-M2 ran as, but M3 turns the daemon
 * into a background service meant to stay up for weeks, so unbounded growth
 * here is a real, if slow, memory leak. Each collection evicts its OLDEST
 * (first-inserted) entry once over this cap — the same bounded-ring idiom
 * `ConnectionHub`'s per-device dedup window already uses server-side
 * (packages/server/src/hub.ts's `DEDUP_RING_CAPACITY`), just applied here to
 * task ids. `Map`/`Set` iterate in insertion order (ECMA-262), so "oldest"
 * always means "finished/cancelled longest ago" — neither collection is
 * touched on a read, only on insert, so eviction order depends purely on
 * insertion time. See `finishedTaskIds` and `pendingCancelled`'s own doc
 * comments below for why a cap this size can't remove an entry either
 * invariant still needs.
 */
export declare const MAX_TRACKED_TASK_IDS = 2000;
/**
 * M5 batch-3 (workstream 2): stable, documented reason PREFIX a `task.fail`
 * carries when `payload.limits.maxDurationMs` (daemon-authoritative
 * wall-clock enforcement — see `armMaxDurationTimer`) is exceeded. Only the
 * prefix itself is the contract an embedder can match against
 * (`reason.startsWith(...)`); everything after it is human-readable detail,
 * not part of the stable shape.
 */
export declare const MAX_DURATION_EXCEEDED_REASON_PREFIX = "resource limit exceeded: maxDurationMs";
/** M5 batch-3 (workstream 2): same contract as {@link MAX_DURATION_EXCEEDED_REASON_PREFIX}, for `DaemonConfig.maxTaskOutputBytes` — see `TaskRunner.pump`'s own per-event byte counting. */
export declare const MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX = "resource limit exceeded: maxTaskOutputBytes";
/** Stable fail-closed reason for one normalized event that cannot fit the configured activity batch budget. */
export declare const MAX_PROGRESS_BATCH_BYTES_EXCEEDED_REASON_PREFIX = "resource limit exceeded: progressBatch.maxBatchBytes";
/**
 * additive-minor (`task.complete.document`): same stable-PREFIX contract as
 * {@link MAX_DURATION_EXCEEDED_REASON_PREFIX} above, carried by every
 * `task.fail` this daemon reports because a configured
 * `DaemonConfig.resultDocument` extractor produced a document that could not
 * be delivered — over the cap, not JSON-serializable, or destined for a
 * server that never advertised the `result-document` capability. All three
 * are `retryable: false`: none of them can come out differently on a retry
 * against the same server with the same extractor. Everything after the
 * prefix is human-readable detail (including the measured size), not part of
 * the stable shape.
 *
 * There is deliberately no "send it anyway" or "send it truncated" path.
 * A document is the task's PRIMARY structured result, so quietly dropping or
 * mangling it would report success while destroying the thing the task
 * existed to produce.
 */
export declare const RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX = "result document undeliverable";
/**
 * Bounded admission: the stable reason PREFIX a prepared Execution's
 * `task.fail` carries when any one of its provider calls reported prompt
 * tokens AT OR ABOVE the context window of the model its frozen request D was
 * compiled for (`RuntimePreparedLaunchV1.expected.model.contextWindow`).
 *
 * A purely numeric classification over the runtime's own usage observation:
 * no provider error text is read, no pattern is matched, and the upstream
 * runtime's heuristic overflow detector is deliberately not consulted. The
 * execution is torn down and fails closed (`retryable: false`) — the same D
 * re-sent against the same window would overflow again. Everything after the
 * prefix is human-readable detail.
 */
export declare const PREPARED_CONTEXT_OVERFLOW_REASON_PREFIX = "context_overflow";
/**
 * Bounded admission: the stable reason PREFIX a prepared Execution's
 * `task.fail` carries when it cannot produce the prepared observation — it
 * settled with no provider usage observed at all, or one of its provider calls
 * reported no positive, representable prompt token count. A prepared result
 * without that observation cannot be checked against the byte bound it was
 * admitted under, so it is never accepted as success (`retryable: false`).
 *
 * A reported prompt of zero is "unavailable", not "zero": D is never empty, and
 * the Pi runtime initialises a call's usage to zeros and leaves them there when
 * the provider streams no usage.
 */
export declare const PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX = "usage_unavailable";
/**
 * The task identity handed to a {@link ResultDocumentExtractor} alongside the
 * final output text. Deliberately minimal — identity only, no session
 * handle, no workspace path, no adapter: this seam exists to turn text the
 * runtime already produced into the product's own JSON, not to become a
 * general-purpose end-of-task callback with access to the daemon's innards.
 */
export interface ResultDocumentTask {
    readonly taskId: string;
    readonly sessionRef: string;
    /** Exact offer-scoped second projection; absent for legacy and message-only offers. */
    readonly terminalProjection?: Readonly<TerminalProjectionSelection>;
}
/**
 * Host-supplied glue that turns a finished task's final output into the
 * product's structured terminal result (`task.complete.document`). Returning
 * `undefined` means "this task has no structured result" for legacy offers.
 * An explicit `terminalProjection.mode: 'result-document'` instead treats
 * `undefined` as a fail-closed missing required document.
 *
 * SYNCHRONOUS by contract, like every other single-purpose callback on
 * `TaskRunnerDeps`, and the runtime ENFORCES that rather than trusting it:
 * the returned value is treated as data and JSON-encoded as-is, never
 * awaited, so a returned promise would encode to an empty document (`{}`) —
 * a well-formed, under-cap, and completely WRONG result. A thenable return
 * is therefore rejected exactly like a throw (`task.fail`, `retryable:
 * false`), because delivering a confidently wrong terminal result is worse
 * than delivering none.
 *
 * Throwing is a real outcome, not a nuisance: it fails the task
 * (`retryable: false`) rather than completing it without the result the
 * extractor was supposed to produce — see {@link
 * RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX}.
 */
export type ResultDocumentExtractor = (finalOutput: string, task: ResultDocumentTask) => unknown;
/**
 * M5 batch-3 (workstream 2): default cap (64 MiB) on accumulated
 * (approximate) agent-event output bytes this daemon tolerates for a single
 * task before tearing it down as a resource-limit violation — see
 * `TaskRunnerDeps.maxTaskOutputBytes` and `DaemonConfig.maxTaskOutputBytes`
 * (`create-daemon.ts`) for the full contract, including the
 * zero/negative-is-a-config-error / `Number.POSITIVE_INFINITY`-is-the-real-
 * opt-out pin.
 */
export declare const DEFAULT_MAX_TASK_OUTPUT_BYTES: number;
/**
 * WP0: default number of Attempts allowed to execute concurrently in one
 * canonical Agent home. One — the canonical home is every Agent session's
 * cwd, so a second concurrent Attempt is a second writer of the same
 * `MEMORY.md`, `notes/` and `.git`. Raising it is an explicit host choice
 * (`DaemonConfig.maxConcurrentMutableSessionsPerAgentHome`) that re-enables
 * the 0.12.0 co-writing exposure; there is no implicit fallback to it.
 */
export declare const DEFAULT_MAX_CONCURRENT_MUTABLE_SESSIONS_PER_AGENT_HOME = 1;
export interface TaskRunnerDeps {
    adapters: RuntimeAdapter[];
    runtimeAllowlist?: string[];
    /**
     * M5 batch-3 (workstream 1): auto-select priority order for `pickAdapter`'s
     * no-explicit-runtime branch — see `DaemonConfig.runtimePreference`'s own
     * doc comment (`create-daemon.ts`) for the full rationale behind this
     * existing at all. Unset defaults to {@link DEFAULT_RUNTIME_PREFERENCE}
     * (pi LAST, deliberately — product decision: pi is this SDK's fallback
     * runtime, not its default). Independent of `runtimeAllowlist` above
     * (which restricts WHICH runtimes are eligible at all) — this only orders
     * the attempt sequence among whatever that allowlist, if set, already let
     * through.
     */
    runtimePreference?: RuntimeId[];
    /** M5: see `DaemonConfig.runtimeEnvironment`'s own doc comment (`create-daemon.ts`) — the per-device, per-runtime env-allowlist override `handleOffer` merges into `buildRuntimeEnv`'s `locallyAllowedNames`. */
    runtimeEnvironment?: Record<string, {
        allow?: string[];
    }>;
    /** Reads the daemon's current validated device-local registry once per offer. */
    getMcpToolsets?: () => ReadonlyMap<string, McpToolsetConfig>;
    /**
     * The prepared-Execution lane. Absent on a daemon with no `inputPreparation`
     * section, and a `task.offer_prepared` arriving there is declined by name
     * rather than reinterpreted as an ordinary offer.
     *
     * It carries the durable store plus the three device facts a prepared
     * admission compares against, resolved by the daemon that already owns them —
     * never re-derived here, because a second derivation of the installed runtime
     * identity or the operator's policy revision is a second opinion about the
     * same configuration.
     */
    inputPreparationLane?: {
        readonly store: InputPreparationStore;
        /**
         * Await the store's open before the first record read.
         *
         * The prepared offer path is reachable on a freshly restarted daemon that
         * has served no prepare/lookup/cancel call yet, and a store that was never
         * opened holds an EMPTY map — which would make a perfectly good durable
         * record answer `preparation_not_found`. This is the preparation service's
         * own once-only `ensureOpen` latch, passed in rather than re-implemented:
         * the replay that recovers the log stays the service's, so this lane adds
         * no second open authority and no second replay path.
         */
        readonly open: () => Promise<void>;
        /** The VERIFIED installed runtime/compiler identity every artifact is bound to. */
        readonly runtime: InputPreparationRuntimeIdentityV1;
        /** The operator's configured limits-policy revision currently in force. */
        readonly policyRevision: string;
        /** `toolsetId` -> definition revision, from one registry read per call. */
        readonly toolsetDefinitionRevisions: () => ReadonlyMap<string, string>;
    };
    /**
     * Operator input to the MCP toolset launch boundary
     * (`./trusted-launch-cwd.ts`). Unset means the platform default directory
     * and — only when this process is provably plain Node — `process.execPath`
     * as the launcher interpreter. Neither default is assumed: both are proven
     * at admission, and an offer that needs a boundary this daemon cannot prove
     * is declined non-retryably instead of being started without one.
     */
    mcpLaunchCwd?: McpLaunchCwdConfig;
    /**
     * The host's install-record authority for MCP toolset server
     * implementations (`./tool-implementation-identity.ts`).
     *
     * Unset means EVERY implementation identity resolves to
     * `resolver_unconfigured` — this SDK ships no resolver and no default. It is
     * not a degradation: an unconfigured daemon simply proves nothing about its
     * executors and says so, and no spawn is refused for a claim nobody made.
     */
    toolImplementationAuthority?: ToolImplementationAuthority;
    /** Test seam for the implementation measurement; see {@link ToolImplementationFsProbe}. */
    toolImplementationFsProbe?: ToolImplementationFsProbe;
    permissionDefaults?: PermissionPolicy;
    workspaceRoot: string;
    /** Strict Agent offer authority. Absent means legacy offers never resolve an Agent home. */
    agentHome?: AgentHomeManager;
    /** Local authority: legacy offers are declined after journal/dedup/cancel precedence. */
    strictAgentOnly?: boolean;
    /**
     * WP0: how many Attempts may execute concurrently in ONE canonical Agent
     * home — see `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome`'s own
     * doc comment (`create-daemon.ts`) for the validated contract. Unset
     * defaults to {@link DEFAULT_MAX_CONCURRENT_MUTABLE_SESSIONS_PER_AGENT_HOME}.
     */
    maxConcurrentMutableSessionsPerAgentHome?: number;
    /** Exact host-selected policy accepted by `task.offer_for_agent_with_egress`. */
    agentEgressPolicy?: Readonly<AgentEgressPolicy>;
    /** Always-present projection/sanitizer consumer; it defaults to metadata-only. */
    agentEgress?: AgentEgressController;
    /** Durable exact-match Agent session handoff authority. */
    agentSessionHandoffs?: AgentSessionHandoffStore;
    deviceId: string;
    send: (envelope: Envelope) => void;
    awaitTerminalCommit?: (taskId: string) => Promise<void>;
    /** Fsync the execution commitment before claim/runtime side effects. */
    beforeClaim?: (taskId: string, runtime: string) => Promise<void>;
    blobClient: BlobResolver;
    batcherOptions?: ProgressBatcherOptions;
    /**
     * Finding #3 (session/workspace continuity): persists `sessionRef ->
     * workspaceDir` across daemon restarts so a `task.offer` naming a
     * previously-reported `sessionRef` reuses that exact workspace instead of
     * a fresh `workspaceRoot/<taskId>` — see `handleOffer` and
     * `SessionWorkspaceStore`'s own doc comment.
     */
    sessionWorkspaces: SessionWorkspaceStore;
    gitWorkspaceManager?: GitWorkspaceManager;
    gitWorkspaceStore?: GitWorkspaceStore;
    onGitWorkspaceEvent?: (event: {
        taskId: string;
        workspaceId: string;
        phase: GitWorkspacePhase;
        observation?: GitWorkspaceObservation;
        errorCategory?: string;
    }) => void;
    /** Local-only evidence that a semantic terminal outcome could not yet release its runtime ownership. */
    onRuntimeDisposalFailure?: (event: {
        taskId: string;
        runtimeId: string;
        stage: RuntimeDisposalStage;
        reason: string;
    }) => void;
    /**
     * Local audit signal emitted only after bounded Agent-home terminal
     * evidence retries are exhausted. The wire terminal still proceeds so a
     * cloud task cannot remain Claimed/Running forever behind auxiliary local
     * storage failure.
     */
    onAgentTerminalEvidenceFailure?: (event: {
        taskId: string;
        agentRef: AgentRef;
        runtimeId: string;
        cwd: string;
        cause: AgentTerminalCause;
        reason?: string;
        attempts: number;
        error: string;
    }) => void;
    /**
     * M4 Phase 3: this daemon's control-socket identity + the shared registry
     * backing the control socket's own `approvals.list`/`approvals.resolve`
     * methods (`create-daemon.ts` constructs ONE `ApprovalRegistry` and passes
     * the SAME instance here) — see `requestApproval`'s own doc comment for
     * why `TaskRunner` needs a handle on all three. `storeDir`/`productId` are
     * copied verbatim into every prepared operation's approval channel.
     */
    approvalRegistry: ApprovalRegistry;
    storeDir: string;
    productId: string;
    /** Authenticated enrollment tenant projection; required by Agent message durability/recovery. */
    tenantId?: string;
    /**
     * The already-resolved, process-immutable U4a Local Agent release identity.
     * `TaskRunner` only consumes this value; it never creates, normalizes, or
     * revalidates a second version authority. It remains optional for direct
     * internal harnesses and old embedders: absence omits terminal usage rather
     * than fabricating a client version.
     */
    localAgentRelease?: Readonly<LocalAgentReleaseIdentity>;
    /** Default `requestApproval` timeout — see {@link DEFAULT_APPROVAL_TIMEOUT_MS}. */
    approvalTimeoutMs?: number;
    /**
     * M4 Phase 3 hardening: called by `handleApprove`/`handleReject` instead of
     * failing the task when the referenced approval turns out to be stale
     * (see {@link NoPendingApprovalError}) — an audit-only signal, never
     * gating any task-state decision. `create-daemon.ts` wires this to
     * `DaemonObserver.noteStaleApprovalDecision`, the same way every other
     * locally-observable daemon event reaches the audit log/`tasks --follow`.
     * Optional so a caller that doesn't care about this audit trail (e.g. a
     * minimal test harness) isn't forced to supply one.
     */
    onStaleApprovalDecision?: (taskId: string, decision: ApprovalDecision, reason?: string) => void;
    /**
     * Finding F4 (cross-model adversarial review): operators had no way to
     * ever learn a pending approval's `approvalId` short of reading raw
     * audit-log JSON — `approve`/`reject` require one, but nothing surfaced
     * it. Called synchronously from `dispatchApproval`, BEFORE `deps.send`'s
     * own `task.await_approval` — `create-daemon.ts` wires this to
     * `DaemonObserver.noteApprovalDispatched`, which stashes `approvalId`
     * keyed by `taskId` so the observer's `task.await_approval` handling
     * (triggered by that very `deps.send` call, synchronously, right after
     * this) can attach it to the `awaiting-approval` `DaemonEvent` it emits
     * (see `observer.ts`'s own doc comment). Optional so a minimal test
     * harness that doesn't care about this audit-trail detail isn't forced
     * to supply one — mirrors `onStaleApprovalDecision`'s own contract.
     */
    onApprovalDispatched?: (taskId: string, approvalId: string) => void;
    /** Overrides the bounded soft-interrupt window before authoritative `Session.close()` disposal begins. */
    shutdownInterruptTimeoutMs?: number;
    startupTimeoutMs?: number;
    /**
     * M5 batch-3 (workstream 2): overrides {@link DEFAULT_MAX_TASK_OUTPUT_BYTES}
     * — see that constant's own doc comment and `DaemonConfig.maxTaskOutputBytes`
     * (`create-daemon.ts`) for the full contract. Validated (rejecting
     * zero/negative) at the `DaemonConfig` layer, not here — this seam trusts
     * its caller, same as every other optional numeric override on this
     * interface (`shutdownInterruptTimeoutMs`, `approvalTimeoutMs`).
     */
    maxTaskOutputBytes?: number;
    artifactLimits?: {
        maxFileBytes: number;
        maxTaskBytes: number;
    };
    /**
     * Per-event inline ceiling for `tool_use.input` / `tool_result.output` —
     * see `DaemonConfig.maxInlineEventBytes` (`create-daemon.ts`) for the full
     * contract and {@link DEFAULT_MAX_INLINE_EVENT_BYTES} for the default.
     * Validated (positive safe integer, at least
     * `MIN_MAX_INLINE_EVENT_BYTES`) at the `DaemonConfig` layer, not here —
     * this seam trusts its caller, same as `maxTaskOutputBytes` above.
     */
    maxInlineEventBytes?: number;
    /**
     * M4 (additive-minor, `task.approval_resolved`): the capabilities advertised
     * by the CURRENT transport's server (`conn.ack` on WS, the latest successful
     * events response on long-poll) — read fresh at call time (mirrors
     * `getCursor`/`getToken`'s own
     * "read fresh, not captured once" convention elsewhere in this codebase),
     * since the capability is learned asynchronously, after this `TaskRunner`
     * is already constructed (`create-daemon.ts`'s `start()` builds `deps`
     * before `connection` exists). `create-daemon.ts` wires this to
     * `ConnectionManager.getServerCapabilities`. Optional, and treated as "no
     * capabilities" when absent, so a minimal test harness that doesn't care
     * about this gate isn't forced to supply one — see `sendApprovalResolved`.
     */
    getServerCapabilities?: () => readonly string[];
    /**
     * Contract §8.1 / §8.3: is the task lane's capability gate in place right
     * now — this daemon can sign, AND it has read a deployment declaration naming
     * `host-mcp-task-context`?
     *
     * Read fresh at offer time for the same reason `getServerCapabilities` is:
     * `create-daemon.ts` builds these deps before the declaration has been read.
     *
     * ABSENT MEANS UNAVAILABLE, not "assume yes". A runner with no way to ask
     * whether the gate is open has not been told that it is, and §8.1 gives this
     * lane zero fallback — so it injects no nonce, an MCP child gets no
     * `BYOK_HOST_TOOLSET_CONTEXT`, and a standalone run fails explicitly
     * (§8.2(1)) instead of quietly reaching for some other identity.
     */
    hostTaskContextAvailable?: () => boolean;
    /** Wait for the current deployment declaration before freezing host toolset env. */
    prepareHostTaskContext?: (taskId: string, signal: AbortSignal) => Promise<void>;
    /**
     * S3b (L-002): a pre-claim veto on new offers, consulted once per offer
     * immediately after the redelivery-dedup check and ahead of every other
     * admission check in `handleOffer`.
     *
     * It exists for local storage pressure (architecture §12.7.2.1's hard
     * watermark: "停止接收新的普通 task；仍允许 terminal/truth flush、删除、导出、
     * doctor 与恢复操作"). Placing it here rather than deeper in `handleOffer`
     * is what makes that split real: an offer never reaches adapter selection,
     * workspace creation, or `task.claim`, so declining costs nothing on disk —
     * while every path that FINISHES existing work runs through code this seam
     * is not on, and keeps working.
     *
     * Synchronous, matching every other single-purpose callback on this
     * interface. A decline is `retryable` by the guard's own decision — pressure
     * is a property of THIS device at THIS moment, so a dispatcher re-routing
     * the task elsewhere genuinely helps; a guard declining for a reason that
     * will not change says so.
     *
     * Optional and absent by default: with no guard supplied, `handleOffer`
     * behaves exactly as it did before this seam existed.
     */
    admissionGuard?: (offer: {
        readonly taskId: string;
        readonly payload: AcceptedOfferPayload;
    }) => AdmissionGuardDecision;
    /**
     * additive-minor (`task.complete.document`): the host's structured-result
     * extractor, consulted once per task at the moment `task.complete` is
     * built — see {@link ResultDocumentExtractor} and `DaemonConfig
     * .resultDocument` (`create-daemon.ts`) for the full contract.
     *
     * Optional, and absent by default: with no extractor supplied, the
     * completion path is byte-identical to what it was before this seam
     * existed — no document is computed, no capability is consulted, and
     * `task.complete` carries exactly the fields it always did.
     */
    resultDocument?: {
        readonly extract: ResultDocumentExtractor;
    };
    /** SDK-owned, task-scoped MCP helper. Required only for offers declaring messageEgress. */
    agentMessageMcpBin?: Readonly<ResolvedAgentMessageMcpBin>;
    /**
     * Production pre-runtime executability/handshake gate for the exact message
     * helper config. `env` is the same allowlisted child environment the runtime
     * gets (`buildRuntimeEnv`), and `cwd` the same working directory, so the
     * helper is proved under the conditions it will actually run in.
     */
    agentMessageMcpPreflight?: (server: Readonly<McpStdioServerConfig>, env: Readonly<Record<string, string>>, cwd?: string) => Promise<void>;
    /**
     * Override the `initialize` + `tools/list` observation of a projected
     * toolset MCP server. Defaults to the real handshake
     * (`mcp-tools-probe.ts`); tests substitute a stub. It is deliberately NOT
     * optional-with-no-default the way `agentMessageMcpPreflight` is: an adapter
     * may only bind tools that were observed, so a runner with no observation at
     * all would silently project toolsets the model can list and never call.
     */
    mcpToolsetToolsProbe?: (serverName: string, server: Readonly<McpStdioServerConfig>, options: McpToolsProbeOptions) => Promise<McpServerObservation>;
    /** SDK-owned MCP helper injected only into strict Agent tasks. */
    agentMemoryMcpBin?: Readonly<ResolvedAgentMemoryMcpBin>;
    /** Explicit external secure-fs helper. No PATH discovery or bundled native addon exists. */
    agentMemoryFilesystemHelperBin?: string;
    /** Optional local-to-hosted redacted projection port. Omission is zero-network. */
    agentMemoryHostedProjection?: AgentMemoryHostedProjection;
}
/** See {@link TaskRunnerDeps.admissionGuard}. */
export type AdmissionGuardDecision = {
    readonly admit: true;
} | {
    readonly admit: false;
    readonly reason: string;
    readonly retryable: boolean;
};
type AcceptedOfferPayload = TaskOfferPayload | TaskOfferWithToolsetsPayload | TaskOfferForAgentPayload | TaskOfferForAgentWithEgressPayload | TaskOfferForAgentWithEgressFreshPayload | TaskOfferPreparedPayload;
/**
 * The SDK-owned environment variable that carries one host toolset server's
 * `BYOK_HOST_TOOLSET_CONTEXT` nonce (contract §8.1).
 *
 * Injected by the daemon beside `BYOK_STORE_DIR`/`BYOK_PRODUCT_ID` — the two a
 * child already needs to dial this daemon's control socket. A host's own
 * `mcpToolsets` registry still cannot supply an `env` block at all
 * (`toolset-registry.ts`), so this name can only ever hold a value the daemon
 * minted.
 */
export declare const HOST_TOOLSET_CONTEXT_ENV = "BYOK_HOST_TOOLSET_CONTEXT";
/**
 * What the daemon's `task_assertion.issue` handler learns about one token.
 *
 * Three outcomes, not a nullable entry: the handler must answer
 * `context_revoked` and `context_token_invalid` differently, and neither may
 * ever be reachable by a caller reading fields off an entry it should not see.
 * Only the `active` case carries claims, and it carries exactly the three the
 * envelope binds.
 */
export type HostToolsetContextLookup = {
    readonly status: 'active';
    readonly taskId: string;
    readonly agentRef: AgentRef;
    readonly toolsetId: string;
} | {
    readonly status: 'revoked';
} | {
    readonly status: 'unknown';
};
/**
 * Per-connection task orchestration: offer -> (decline | prepare -> seal ->
 * claim -> prepared operation -> started) -> seq-ordered progress batches -> complete/fail/
 * cancelled, plus approve/reject/cancel/steer handling.
 *
 * M1 rework (docs/protocol.md §3, §5, §10 — `packages/protocol` is frozen,
 * not editable here): pre-claim rejections (unknown/disallowed runtime,
 * policy exceeding this device's ceiling) now send `task.decline` and never
 * claim at all — `TASK_TRANSITIONS.Offered` gained a direct `-> Failed` edge
 * precisely so this no longer has to claim-then-fail. A successful claim is
 * followed by `task.started` only once the adapter session has actually
 * started (`task.claim` alone no longer implies `Running`). Cancellation
 * reports the explicit `task.cancelled` message instead of the old
 * `task.fail({reason:'cancelled'})` convention.
 */
export declare class TaskRunner {
    private readonly deps;
    private readonly tasks;
    private readonly pendingMessageTasks;
    private readonly messageOutboxesByHome;
    private readonly messageContextByToken;
    private readonly messageContextByTask;
    private readonly memoryContextByToken;
    private readonly memoryContextByTask;
    private readonly memoryInFlightByTask;
    private readonly memoryClosingTasks;
    private readonly memoryFilesystemByTask;
    /**
     * Contract §8.1: the `BYOK_HOST_TOOLSET_CONTEXT` nonce registry — one entry
     * per `(task, host toolset server)`, keyed by the opaque nonce the daemon
     * injected into that ONE child's environment and nowhere else.
     *
     * This map is the whole reason the task lane has authority at all. A device
     * assertion deliberately carries no caller identity (see
     * `device-assertion.ts`): under one UID every process can reach the control
     * socket, so a "who asked" field would be synthesized. The nonce is different
     * in kind — it is evidence, because the only way to hold one is to be the
     * process the daemon spawned for this exact task and server. Every claim the
     * task signer writes is read out of the entry here, never out of RPC params.
     *
     * Entries are RETAINED after revocation (`state: 'revoked'`) until the task's
     * resources are cleaned up, so the refusal can be the precise
     * `context_revoked` rather than collapsing into `context_token_invalid` the
     * instant a task is cancelled. After cleanup the entry is deleted and the two
     * refusals become indistinguishable on purpose — "this token is gone" must
     * not be a probe for which tasks this device has run.
     */
    private readonly hostToolsetContextByToken;
    /** Per-task index over {@link hostToolsetContextByToken}, so one cancel revokes every server's nonce at once. */
    private readonly hostToolsetContextTokensByTask;
    private readonly recoveredMessageOutboxes;
    private readonly recoveredMessageRetryTimers;
    /**
     * Finding F4 (cancel lost during the offer-processing window): a
     * `task.cancel` for a taskId that hasn't finished `handleOffer` yet (still
     * awaiting adapter detection / instruction resolution / workspace setup /
     * prepared operation `start()`) has no `this.tasks` entry to land on — it used to be
     * silently dropped, and the runtime session `handleOffer` was about to
     * register would then run an unsupervised ("zombie") turn nobody asked
     * for anymore. Recording the taskId here lets `handleOffer` consult it at
     * the two points where it can still safely react (see its body): before
     * claiming at all (decline instead of ever starting a session), and right
     * after the prepared operation resolves but before this task is registered as
     * active (tear the just-started session down immediately, before its
     * event loop ever pumps a single event). Consumed (deleted) at whichever
     * checkpoint handles it; a cancel for a taskId that's already active,
     * already finished, or never offered at all leaves a harmless entry that
     * nothing will ever consult.
     *
     * M3-B: that last sentence is exactly the unbounded-growth vector this
     * needed closed for long-lived operation — a cancel for a taskId nobody
     * ever claims (unknown, already active, or already finished) leaves a
     * permanent entry with nothing left to consume it. Bounded to
     * `MAX_TRACKED_TASK_IDS` via `setPendingCancelled` below, oldest evicted
     * first: safe because every entry this field's correctness actually
     * depends on is consumed (deleted) by one of `handleOffer`'s two
     * checkpoints within that SAME task's own offer-processing window — one
     * in-flight task's startup latency, nowhere near enough churn for eviction
     * to remove an entry still inside its consuming window before it's read.
     */
    private readonly pendingCancelled;
    /**
     * Finding #5 (Codex counterexample): taskIds currently INSIDE `handleOffer`
     * — from the moment it decides an offer is worth processing until it
     * reaches one of its own resolution points (decline, fail, the
     * checkpoint-2 cancel-teardown, or successful registration into
     * `this.tasks`). Bounded eviction on `pendingCancelled` (below) must never
     * remove an entry for a taskId in this set: doing so is exactly the bug —
     * block task A in prepared-operation `start()`, deliver A's own `task.cancel` (so
     * `pendingCancelled` gets an entry for A while A is still in-flight),
     * then deliver `MAX_TRACKED_TASK_IDS` more cancels for unrelated taskIds
     * nobody ever offered — under naive oldest-wins eviction, A's entry (the
     * single oldest) gets evicted purely because of unrelated churn, so when
     * the prepared operation finally resolves, checkpoint 2 finds no cancel marker
     * and the already-cancelled task starts a real session. See
     * `evictPendingCancelled` below for the fix, and
     * `task-runner-bounded-collections.test.ts` for a test mirroring this
     * exact scenario. Membership here is naturally tiny (bounded by this
     * device's real concurrent-offer-processing count, nowhere near
     * `MAX_TRACKED_TASK_IDS`), so scanning past it to find an evictable entry
     * costs nothing.
     */
    /**
     * `taskId` -> the preparation record this Execution pinned.
     *
     * The pin is a durable single-consumer claim on already-counted tokens, so it
     * is held for exactly as long as the Execution that took it can still be
     * running — and released at ONE moment, the Execution's terminal. Not at
     * claim, not at start, not when the session closes: GC must not collect a
     * record whose bytes a live process may still be sending.
     */
    private readonly preparationPinsByTask;
    private readonly inFlightOffers;
    /** Blob I/O before an offer becomes an active task still belongs to that offer's cancellation authority. */
    private readonly inFlightBlobAborts;
    /**
     * Finding P2 (Fix 2c): taskIds that have reached a terminal outcome
     * (Complete/Failed/Cancelled) this session — populated in `finish()`.
     * While `ConnectionManager`'s stalled-cursor long-poll re-pull is frozen
     * behind an unrelated failing seq, it can legitimately redeliver an
     * ALREADY-succeeded `task.offer` — the client's own cursor hasn't advanced
     * past it yet (docs/protocol.md §9's "cursor advance timing" rule
     * explicitly relies on redelivered handlers being idempotent for exactly
     * this reason). `handleOffer` must treat a redelivered offer for a taskId
     * that's already active (`this.tasks`) or already finished (this set) as
     * a no-op — never a second prepared-operation `start()` call, which would orphan the
     * first session.
     *
     * M3-B: unbounded otherwise — a long-lived daemon that's finished many
     * thousands of tasks over its uptime would keep every single taskId
     * forever. Bounded to `MAX_TRACKED_TASK_IDS` via `addFinishedTaskId`
     * below, oldest evicted first. Safe for the redelivery-idempotency
     * invariant above because the stalled-cursor scenario above redelivers
     * this device's own recent backlog for one connection, not an arbitrary
     * point in this daemon's whole history — this device would have to claim
     * and finish `MAX_TRACKED_TASK_IDS` more tasks before a genuinely-still-
     * pending redelivery for an older taskId even arrives, let alone gets
     * processed, for eviction to ever remove an entry that redelivery still
     * needed.
     *
     * Finding #5 (honesty follow-up): unlike `pendingCancelled`, plain
     * oldest-first eviction IS correct here — every entry in this set is
     * already fully resolved (finish() only adds a taskId after it reached a
     * terminal outcome), so there is no "in-flight" entry an eviction could
     * corrupt out from under a running `handleOffer()`. The assumption above
     * is a HEURISTIC bound, not a proof: it holds as long as no single
     * connection's genuinely-still-pending redelivery backlog ever exceeds
     * `MAX_TRACKED_TASK_IDS` finished tasks, which is a real (if distant)
     * possibility for an extremely long-stalled connection, not a
     * mathematical impossibility. Should it ever be violated, the failure
     * mode is strictly milder than `pendingCancelled`'s own pre-fix bug: a
     * redelivered `task.offer` for an evicted, already-finished taskId would
     * re-run `handleOffer` from scratch — at worst a duplicate
     * claim/start/complete for a task that already succeeded once — never a
     * task that should be dead starting a brand-new session against explicit
     * cancellation intent.
     */
    private readonly finishedTaskIds;
    /**
     * Bounded local receive dedup for strict legacy declines. A decline is not a
     * task terminal receipt, so it must never enter `finishedTaskIds`; retaining
     * it separately keeps replay idempotent without claiming or finishing work.
     */
    private readonly strictDeclinedTaskIds;
    /**
     * M4 Phase 2 (daemon control socket `shutdown` RPC): set once by
     * {@link stopAcceptingOffers}, checked at the very top of `handleOffer` —
     * see that method's own doc comment for why offers must stop being
     * claimed BEFORE currently-active tasks are reported failed in
     * {@link shutdownActiveTasks}, not after. Irreversible for this
     * `TaskRunner` instance; a fresh one is constructed on the daemon's next
     * `start()`.
     */
    private stoppingOffers;
    constructor(deps: TaskRunnerDeps);
    get activeTaskCount(): number;
    /**
     * Transport-boundary classification for the currently active task. Legacy
     * tasks and plain Agent-home offers are deliberately false: the additive
     * egress contract must never reclassify their existing wire semantics.
     */
    usesAgentEgress(taskId: string): boolean;
    /** Frozen offer authority for the outbound result-document lane. */
    selectsResultDocument(taskId: string): boolean;
    /** M5 batch-3 (workstream 2): effective `maxTaskOutputBytes` cap for this daemon — see {@link DEFAULT_MAX_TASK_OUTPUT_BYTES}'s own doc comment. */
    private get maxTaskOutputBytes();
    /** Effective per-event inline ceiling for this daemon — see `DaemonConfig.maxInlineEventBytes`. */
    private get maxInlineEventBytes();
    /** WP0: effective per-canonical-Agent-home Attempt cap — see {@link DEFAULT_MAX_CONCURRENT_MUTABLE_SESSIONS_PER_AGENT_HOME}. */
    private get maxConcurrentMutableSessionsPerAgentHome();
    /**
     * M4 Phase 4 (part B.3, observability): per-active-task queue watermarks
     * for the control socket's `status` result — see
     * `control-protocol.ts`'s `TaskQueueWatermark` doc comment for why this
     * reflects the daemon's own progress-batcher backlog and in-flight
     * approval count, not the adapter's own event-queue depth.
     */
    getQueueWatermarks(): TaskQueueWatermark[];
    /** Authenticated control-socket entry used only by the SDK-owned task MCP helper. */
    publishAgentMessage(input: {
        readonly contextToken: string;
        readonly contentType: AgentMessageContentType;
        readonly body: string;
    }): Promise<{
        messageId: string;
        state: 'staged' | 'pending';
    }>;
    /** Authenticated control-socket entry used only by the SDK-owned memory MCP helper. */
    recallAgentMemory(input: {
        readonly contextToken: string;
        readonly path: string;
        readonly ifRevision?: string;
    }): Promise<{
        path: string;
        revision: string;
        content: string;
        auditWarning?: AgentMemoryAuditWarning;
    }>;
    /** Authenticated control-socket entry used only by the SDK-owned memory MCP helper. */
    saveAgentMemory(input: {
        readonly contextToken: string;
        readonly op: 'replace' | 'delete';
        readonly path: string;
        readonly expectedRevision: string;
        readonly content?: string;
    }): Promise<{
        path: string;
        revision?: string;
        deleted: boolean;
    }>;
    /** Restore activated, unaccepted message drafts before transport admission on daemon restart. */
    recoverAgentMessageOutboxes(agentsRoot: string): Promise<void>;
    private agentMessageOutbox;
    /** A recovery terminal must not close first-message admission before this durable draft has a disposition. */
    hasPendingRecoveredAgentMessage(taskId: string): boolean;
    /** Retry stable recovered records after a transport handshake/re-handshake. */
    retryRecoveredAgentMessages(): void;
    private canPublishAgentMessage;
    /** All authors and startup use the same queue-time and post-I/O authority check. */
    private activateAgentMessage;
    private sendAgentMessageRecord;
    private handleAgentMessageDisposition;
    /** M4 Phase 2: stop claiming any FUTURE `task.offer` — see `stoppingOffers`'s own doc comment. Idempotent. */
    stopAcceptingOffers(): void;
    /**
     * Shutdown of every currently ACTIVE task for the control socket's
     * `shutdown` RPC. Soft interrupt remains bounded, but each task's
     * authoritative close receipt must settle successfully. Reports `task.fail` rather than
     * `task.cancelled` — these tasks aren't ending because the SERVER
     * cancelled them, they're ending because this device is shutting down.
     * `retryable: true` throughout: nothing about the task/policy itself was
     * ever at fault, only this device's own availability right now.
     *
     * Snapshots `this.tasks` into a plain array up front rather than iterating
     * the live `Map` — `finish()` (called per task below) deletes from that
     * same map as each shutdown settles, and a snapshot avoids relying on
     * "mutate while iterating" semantics being followed correctly here.
     *
     * Must be called AFTER {@link stopAcceptingOffers} and BEFORE the
     * connection is closed: the caller (`create-daemon.ts`'s
     * `performControlShutdown`) awaits this method to fully settle — every
     * `task.fail` actually enqueued via `deps.send` — before it ever calls
     * `stop()` (which closes the connection). Stopping offers first (rather
     * than closing the connection first) is what prevents a new
     * `task.offer` from being claimed in the window while these are being
     * torn down.
     *
     * This ordering invariant is NOT just about `performControlShutdown`'s
     * own internal statement order — it also depends on nothing ELSE
     * closing the connection first. A real regression (gatekeeper-caught,
     * fixed in `create-daemon.ts`/`bin/commands/start.ts`) had exactly that
     * happen: `start.ts` used to wake up on the EARLIER `shutdown-requested`
     * event (fired synchronously, before this method even calls
     * `session.interrupt()`) and call `daemon.stop()` itself, racing ahead
     * and closing the connection before this method's `task.fail` send ever
     * reached the outbox drain. `start.ts` now waits for the LATER
     * `shutdown-complete` event (emitted only after `performControlShutdown`'s
     * own `stop()` call has already resolved), so it can no longer race
     * ahead of this method — see `daemon-control-socket.test.ts`'s dedicated
     * regression test for the exact scenario.
     */
    /** Startup resources have an owner even before a Session can become active. */
    private startupRetryTimer;
    private readonly claimedHarnesses;
    private readonly homeReservations;
    private readonly startupOwners;
    private readonly startupDisposals;
    private disposeStartupOwner;
    private disposeStartupOwnerOnce;
    shutdownActiveTasks(reason: string): Promise<void>;
    /**
     * M5 batch-3 (workstream 2): the ONE shared per-task teardown sequence —
     * "reuse the exact interrupt/teardown machinery `shutdownActiveTasks`
     * uses, do not invent a second teardown path" applies to BOTH callers:
     * graceful daemon shutdown ({@link shutdownTask}, `retryable: true`) and
     * resource-limit enforcement ({@link failActiveTaskForResourceLimit},
     * `retryable: false`, wall-clock `maxDurationMs` / output-cap
     * `maxTaskOutputBytes`).
     *
     * Finding F5(a) (pre-existing, unchanged by this refactor):
     * `session.interrupt()` is raced against `timeoutMs`
     * ({@link DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS}, overridable via
     * `TaskRunnerDeps.shutdownInterruptTimeoutMs`) rather than awaited
     * unconditionally, so a hung `interrupt()` (a misbehaving adapter) can
     * never block `task.fail` from being sent at all.
     *
     * After the bounded soft interrupt, `finish()` always awaits the authoritative
     * `Session.close()` receipt. A failed receipt retains active/Git ownership;
     * shutdown surfaces the rejection while resource enforcement leaves local
     * evidence for a later retry.
     *
     * Re-checks task identity (`this.tasks.get(...) === active`) immediately
     * before sending `task.fail`: the interrupt race above has await
     * points during which a DIFFERENT path (a racing `task.cancel`/
     * `task.reject`, or the session completing normally on its own) may have
     * already finished this exact task and sent its own terminal message.
     * Sending a SECOND terminal message for an already-finished task would be
     * a genuine protocol bug, not a benign race — mirrors `pump()`'s own
     * identity-check guard for the same class of race.
     */
    private interruptBounded;
    private teardownActiveTask;
    /** Graceful-shutdown caller of {@link teardownActiveTask} — see `shutdownActiveTasks`'s own doc comment. `retryable: true`: nothing about the task/policy itself was ever at fault, only this device's own availability right now. */
    private shutdownTask;
    /**
     * M5 batch-3 (workstream 2): shared entry point for both resource-limit
     * enforcers (wall-clock `maxDurationMs` — {@link armMaxDurationTimer} —
     * and output-cap `maxTaskOutputBytes` — see `pump`). Looks the task up
     * FRESH by id and no-ops if it's already gone — finished via any other
     * path (normal completion, cancel, reject, daemon shutdown, or a
     * DIFFERENT resource-limit trip already caught it first). `retryable:
     * false` unconditionally: hitting a configured resource ceiling is never a
     * transient/environmental failure a retry could fix — the same task under
     * the same limits would just hit it again.
     */
    private failActiveTaskForResourceLimit;
    /**
     * M5 batch-3 (workstream 2): daemon-authoritative wall-clock enforcement
     * for `payload.limits.maxDurationMs` — previously accepted and silently
     * ignored (see `handleOffer`'s own doc comment on the `limits.maxTokens`
     * gate for the historical context this superseded). Armed once, at the
     * moment this task is registered as active (`handleOffer`, still inside
     * the synchronous construct -> register -> arm -> pump handoff — arming a
     * timer is synchronous, `setTimeout` never invokes its callback in the
     * same tick, so this doesn't reopen the race that handoff's own doc
     * comment guards against). Cleared unconditionally in `finish()` so every
     * terminal outcome leaves no dangling timer and can never double-fail an
     * already-finished task — the fresh `this.tasks.get` lookup in
     * `failActiveTaskForResourceLimit`/`teardownActiveTask`'s own identity
     * re-check is the second, belt-and-suspenders layer of that same guarantee
     * for the rare case the timer's callback was already scheduled before
     * `finish()` had a chance to clear it.
     */
    private armMaxDurationTimer;
    handleEnvelope(envelope: Envelope): Promise<void>;
    private handleOffer;
    private withAgentMessageMcp;
    private revokeAgentMessageContext;
    /** Injected only after strict Agent admission; a host registry may never replace this reserved name. */
    private withAgentMemoryMcp;
    /** Reconstruct all sensitive context from the active sealed task, never from MCP/model arguments. */
    private activeMemoryContext;
    private runMemoryOperation;
    private quiesceAndSnapshotAgentMemory;
    private bindAgentMemoryFilesystem;
    private closeAgentMemoryFilesystem;
    private revokeAgentMemoryContext;
    /**
     * Contract §8.1: mint one `BYOK_HOST_TOOLSET_CONTEXT` nonce per host toolset
     * server of this task and inject it into that server's child environment.
     *
     * Only the SDK injects here. `toolset-registry.ts` still rejects an `env`
     * block on a host-configured server outright, which is what makes this
     * variable un-forgeable from configuration: the name can only ever hold a
     * value this method minted.
     *
     * No `agentRef` means no nonce, and therefore no task lane at all for this
     * task. That is not a degradation to a device-only path — it is the envelope
     * schema being honest: `byok-task-assertion-v1` REQUIRES the frozen offer's
     * AgentRef, and a non-Agent offer has none to bind. Signing something weaker
     * and calling it a task assertion is exactly the fallback §8.1 forbids.
     */
    private withHostToolsetContext;
    /**
     * Contract §8.2(1) / I12: the daemon's SECOND fail-closed layer — stop
     * signing for this task, now.
     *
     * Called synchronously, before any `await`, from every point at which this
     * device learns the task's authority is over: an accepted cancel, any
     * semantic terminal, and shutdown. Entries are kept (not deleted) so the
     * refusal stays the precise `context_revoked` until the task's resources are
     * actually cleaned up.
     *
     * The honest limit, which belongs here as much as in the contract: the
     * AUTHORITATIVE revocation point is the host's own cancel/End commit. This
     * stops the daemon minting promptly; it does not recall an assertion already
     * in a caller's hands, and the host's admission check remains the layer that
     * refuses one.
     */
    private revokeHostToolsetContexts;
    /** Shutdown (contract §8.2(1)): no task on this device keeps a mintable context across it. */
    private revokeAllHostToolsetContexts;
    /** Task resource cleanup: drop the entries entirely, after which the refusal is `context_token_invalid`. */
    private deleteHostToolsetContexts;
    /**
     * The daemon's only view of the nonce registry (contract §8.2(1)).
     *
     * Returns the three claims the task envelope binds, or a refusal status —
     * never the entry itself, and never the token back. The caller (the
     * `task_assertion.issue` handler) may not add to, narrow, or substitute any
     * of these values: they ARE the assertion's task/Agent/toolset identity.
     */
    hostToolsetContext(contextToken: string): HostToolsetContextLookup;
    /** Protocol §7: an instruction too large to inline arrives as a `blobRef` — resolve it via the blob client rather than failing closed. */
    private resolveInstruction;
    /**
     * Resolve every requested logical id locally and reject missing/colliding
     * server authority before claim.
     *
     * `toolsetIdByServer` preserves the one fact the flattened `servers` map
     * loses: which frozen-offer toolset each server belongs to. Contract §8.2's
     * AR-2 fixes `toolsetId` as the wire's `toolset` field — a logical id from
     * `requiredToolsets`, which is what the Host checks a task assertion's claim
     * against. The server NAME is device-local configuration and would not match
     * anything in the frozen offer, so the mapping has to survive this step.
     */
    private resolveMcpServers;
    private pump;
    private publishSuccessfulCompletion;
    /**
     * Protocol §7: an `artifact` `AgentEvent` only names a file the runtime
     * wrote into the task workspace (`name`/`contentType` — it carries no
     * content of its own); this reads it from disk and sends the actual
     * `task.artifact` wire message — inline (base64) under 64KB, or via blob
     * upload above that, with a sha-256 `contentHash`.
     *
     * Finding F7/N5: `name` is untrusted (it's whatever the runtime/agent
     * reported — ultimately model-influenced) and used to be `path.join`'d
     * onto `workspaceDir` with no check that the result stayed inside it, so
     * `../../<anything>` (or an absolute `name`, which `path.resolve` accepts
     * verbatim as the whole path) could read and exfiltrate an arbitrary file
     * on the host as a task artifact. A later fix (`resolveArtifactPath`)
     * closed the traversal case by realpath-checking containment, but still
     * returned a path string that was reopened by pathname afterward — a
     * check-then-use TOCTOU race letting the final component be swapped for
     * an out-of-workspace symlink between the check and the read.
     * `openArtifact` now opens the file (with `O_NOFOLLOW`) and verifies the
     * resulting file descriptor directly; this reads from that same handle,
     * never re-opening by pathname. Read/upload failures (including a
     * rejected name or a blocked symlink swap) are also not silent: they
     * surface as a loud `error` `AgentEvent` batched into `task.progress`,
     * and are logged — the task itself can still reach `task.complete`
     * normally, but the dropped artifact is now visible in the event stream
     * rather than swallowed.
     */
    private sendArtifact;
    /** Loud, non-silent artifact failure (finding F7): logged, and folded into this task's own progress stream as an `error` AgentEvent rather than swallowed — the task itself can still complete normally, but the omission is now visible. */
    private reportArtifactError;
    private handleCancel;
    /** M3-B: bounded insert for `pendingCancelled` — see its class-level doc comment and `MAX_TRACKED_TASK_IDS`. Evicts the oldest SAFE-TO-EVICT entry once over cap — see `evictPendingCancelled` (finding #5: not simply "the oldest entry", which could be an in-flight offer's own cancel marker). */
    private setPendingCancelled;
    /**
     * Finding #5 (Codex counterexample — see `inFlightOffers`'s class-level
     * doc comment for the exact scenario): evicts the OLDEST entry that is
     * NOT a taskId currently inside `handleOffer`'s in-flight window, rather
     * than unconditionally the single oldest entry. `Map` iterates in
     * insertion order, so this is "oldest entry that's safe to drop," which
     * only differs from "the oldest entry, period" when that oldest entry
     * happens to belong to a task still being processed — exactly the case
     * that must never be evicted, since `handleOffer`'s own checkpoint 2
     * still needs to observe it.
     *
     * `inFlightOffers` is naturally tiny (bounded by this device's real
     * concurrent-offer-processing count — normally single digits, driven by
     * how many `task.offer`s are simultaneously mid-prepared-operation start() — nowhere
     * near `MAX_TRACKED_TASK_IDS`), so this scan is cheap in practice: it
     * finds a safe entry at or near the front almost always. The only case
     * where NO entry is safe to evict is every single tracked cancel
     * belonging to a currently in-flight offer, which would require this
     * device to have `MAX_TRACKED_TASK_IDS` offers mid-processing
     * simultaneously — implausible, but handled without corrupting anything:
     * this insert is simply allowed to leave the map one entry over cap
     * rather than evict something still needed, and it shrinks back under cap
     * as those in-flight offers resolve and their entries get CONSUMED
     * (deleted by `handleOffer` itself) rather than evicted.
     */
    private evictPendingCancelled;
    /**
     * S0/H-006: an inbound `task.steer` is normally impossible for a runtime
     * that cannot steer — the hub gates it at claim-time capability
     * (`steer_unsupported_runtime`) and never sends the envelope. If one
     * arrives anyway (a forged sender, a pre-gate server, a device whose
     * adapter set changed), the session throws {@link SteerUnsupportedError},
     * which is a PERMANENT property of that runtime, not a transient failure.
     *
     * Rethrowing it would hand it to `ConnectionManager.process()`
     * (`connection-manager.ts` `stalledAtSeq`), which freezes the cursor at
     * that seq and redelivers the same envelope forever — every retry
     * guaranteed to fail identically, and every later envelope for every
     * other task blocked behind it. So this is classified as a
     * non-retryable protocol/authority error: record it and return normally,
     * which acks the envelope and lets the cursor advance. Nothing is
     * swallowed — the steer simply has no reachable success state, and the
     * honest terminal action is to log it and move on.
     *
     * Every OTHER error stays transient and is rethrown untouched, preserving
     * the existing stall/redelivery semantics exactly.
     */
    private handleSteer;
    /**
     * M4 Phase 3: the daemon-side half of the out-of-band approval channel
     * (`types.ts`'s `ApprovalChannel`) — called from `create-daemon.ts`'s
     * `approvals.request` control method, itself called by `byok-approval-mcp`
     * (a claude-spawned MCP-server child process, NOT the adapter/session
     * in-process — see `ApprovalChannel`'s own doc comment for the full why
     * this seam exists at all rather than an `AgentEvent`).
     *
     * Deliberately independent of the dormant `needs_approval` `AgentEvent`
     * path in `pump()` below (~line 611): empirically confirmed (M4 Phase 3
     * STEP 0), claude's own stream-json output emits NOTHING while a
     * permission-prompt-tool call is outstanding — the gap between a `tool_use`
     * frame and its `tool_result` is invisible on the wire, indistinguishable
     * from ordinary model "thinking" latency. `pump()`'s for-await loop over
     * `active.session.events` therefore has no event to ever branch on for
     * this case; the ONLY signal that a task is paused arrives out-of-band,
     * over the control socket, which is exactly what this method is for. The
     * `needs_approval` path stays dormant, untouched, for a hypothetical
     * future adapter whose runtime DOES expose the pause on its own event
     * stream.
     *
     * Sends `task.await_approval` (protocol §5), registers a fresh entry in
     * `deps.approvalRegistry`, and races it against `deps.approvalTimeoutMs`
     * (default {@link DEFAULT_APPROVAL_TIMEOUT_MS}) — an unanswered request
     * force-resolves as a fail-closed rejection once the deadline passes. Both
     * that timeout AND a real decision (server wire `task.approve`/
     * `task.reject` via `handleApprove`/`handleReject` below, OR the local
     * CLI's `approvals.resolve` in `control-server.ts`) converge on the exact
     * same `ApprovalRegistry.resolve()` call — "first resolution wins, the
     * loser is a clean already-resolved no-op" is `ApprovalRegistry`'s own
     * existing guarantee, reused here rather than reimplemented.
     *
     * Fails closed immediately (no registry entry ever created) for a `taskId`
     * that isn't currently active on this device — a stale/unknown/
     * already-finished task has nothing to pause.
     *
     * M4 Phase 4 (fold-in from the P3 gate — concurrent-approval-overwrite
     * fix): claude's parallel tool use can call this MORE THAN ONCE for the
     * SAME task before the first call's approval is resolved — each parallel
     * tool call is its own independent `byok-approval-mcp` `tools/call`
     * request, and the MCP protocol lets several be in flight on one
     * connection at once (see `byok-approval-mcp.ts`'s own doc comment on
     * sharing one control-socket connection across them). Before this fix,
     * `active.pendingApprovalId = approvalId` above was unconditional — a
     * second concurrent call for the same task silently overwrote the first
     * call's id, so only the LATEST request was ever wire-resolvable
     * (`ctx.approvalChannel.resolve`, below, and any server `task.approve`/
     * `task.reject`, both resolve by looking up `active.pendingApprovalId`);
     * every earlier one could only ever time out.
     *
     * Fix: only ONE approval per task is ever actually DISPATCHED (registered
     * in `approvalRegistry` + `task.await_approval` sent + its own timeout
     * window running) at a time — see `dispatchApproval` below. A second
     * (third, ...) concurrent call for a task that already has one dispatched
     * queues (FIFO, `active.approvalQueue`) instead of overwriting anything,
     * and is only dispatched — with its OWN fresh approvalId and its OWN
     * timeout window starting at THAT dispatch, not at this call's arrival —
     * once the currently-dispatched one resolves (see
     * `dispatchNextQueuedApproval`). The MCP callers on the other end are
     * already independently blocked, each awaiting its own `requestApproval`
     * promise, so this added latency for a queued request is transparent to
     * them: nothing here changes what claude itself observes beyond "the
     * answer took a bit longer." Bounded by
     * {@link MAX_PENDING_APPROVALS_PER_TASK}: a request arriving once this
     * task's queue is already full is rejected fail-closed immediately,
     * mirroring the unknown/inactive-taskId case above.
     *
     * C1 (cross-model review, P1): `onOrigin`, if supplied, is invoked
     * synchronously — strictly BEFORE this method's own returned promise
     * resolves — with the `ApprovalOrigin` (`'wire' | 'local'`) the eventual
     * decision actually resolved through (see `ApprovalRegistry.resolve`'s own
     * `origin` parameter). Purely additive/internal: every existing caller
     * (`byok-approval-mcp.ts`, `create-daemon.ts`'s control socket, this file's
     * own tests) omits it and observes exactly the same `{approved, reason}`
     * resolution as before. `pump()`'s dormant `needs_approval` branch is the
     * one caller that supplies it, to decide whether it still needs to
     * forward the decision into `active.session.resolveApproval()` itself —
     * see that branch's own doc comment for why origin can't simply ride
     * along on the resolved value instead.
     */
    requestApproval(taskId: string, summary: string, onOrigin?: (origin: ApprovalOrigin) => void): Promise<{
        approved: boolean;
        reason?: string;
    }>;
    /**
     * Actually dispatch one approval request for `active`'s task: register it
     * in `deps.approvalRegistry`, send its `task.await_approval`, and start its
     * own `deps.approvalTimeoutMs` window — see `requestApproval`'s own doc
     * comment for why this is split out (only ever ONE dispatched per task at
     * a time; everything else queues). Called either immediately
     * (`requestApproval`, nothing else pending for this task) or from
     * `dispatchNextQueuedApproval` once the previously-dispatched request for
     * this same task resolves.
     *
     * C1: `onOrigin` — see `requestApproval`'s own doc comment — is forwarded
     * verbatim from whichever caller dispatched this (directly, or via
     * `QueuedApprovalRequest.onOrigin` once `dispatchNextQueuedApproval` pulls
     * it off the queue) and invoked from the registered `onResolve` callback
     * below, BEFORE `resolve(...)` — so it always fires strictly before this
     * method's own returned promise settles.
     */
    private dispatchApproval;
    /**
     * M4 (additive-minor, `task.approval_resolved` — see `messages.ts`'s own
     * doc comment on `TaskApprovalResolvedPayloadSchema` for the full wire
     * rationale): report a LOCALLY-resolved approval to the server
     * immediately, gated on the negotiated `approval_resolved` capability
     * (`deps.getServerCapabilities` — an old server that never advertises it
     * never receives this message; the daemon then falls back to the
     * pre-existing implicit-resume inference, unconditionally, exactly as
     * before this message existed — the N/N-1 compatibility path).
     *
     * Ordering (verified by `task-runner-approval-resolved.test.ts`): this is
     * called, and therefore `deps.send` pushes this envelope onto the outbox,
     * SYNCHRONOUSLY from the `onResolve` callback above — strictly BEFORE the
     * `resolve(...)` call on the very next line that unblocks whatever was
     * awaiting `requestApproval()`'s promise (`byok-approval-mcp`, ultimately
     * the paused runtime turn). Any further progress from the resumed session
     * can only be produced AFTER that unblock, which needs at least one more
     * microtask/event-loop turn — so `task.approval_resolved` is always queued
     * ahead of it with no extra bookkeeping needed here.
     */
    private sendApprovalResolved;
    /**
     * FIFO: once a task's currently-dispatched approval resolves (real
     * decision or timeout), dispatch the next queued request for that SAME
     * task, if any — see `requestApproval`'s own doc comment. A no-op when
     * nothing is queued.
     */
    private dispatchNextQueuedApproval;
    /**
     * Acceptance finding 1 (dormant `needs_approval` branch bypassing the
     * approval registry): resolves whatever `deps.approvalRegistry` entry
     * `pendingId` names (if any — a caller passes `undefined` when nothing was
     * pending to begin with), tagged `'wire'` — the same origin
     * `ctx.approvalChannel.resolve` already uses for a server-sent
     * `task.approve`/`task.reject` (see `ApprovalOrigin`'s own doc comment:
     * `'wire'` is what keeps `sendApprovalResolved` from echoing
     * `task.approval_resolved` back to a server that already knows this
     * decision, since it sent it).
     *
     * Needed because `active.session.resolveApproval()` is adapter-defined:
     * - A channel-based session (claude) already resolves this exact registry
     *   entry itself, via `ctx.approvalChannel.resolve` (`handleOffer` above)
     *   — by the time this runs, that entry is already gone, so this call
     *   throws `ApprovalNotFoundError`, swallowed below: the same
     *   first-resolution-wins race every other caller of `.resolve()` in this
     *   file already treats as benign (see e.g. `dispatchApproval`'s own
     *   timeout branch).
     * - A stream-based session (the dormant `needs_approval` path in `pump()`,
     *   now dispatched via `requestApproval` exactly like a real out-of-band
     *   approval) resolves ONLY through its own in-process `resolveApproval()`
     *   call — nothing else ever touches `deps.approvalRegistry` for it, so
     *   without this call its registry entry and `active.pendingApprovalId`
     *   would otherwise linger until this approval's own timeout (or the task
     *   finishing) instead of clearing the moment the decision actually lands
     *   — which would leave any OTHER approval queued behind it
     *   (`active.approvalQueue`) stuck waiting for that same timeout.
     *
     * Called from `handleApprove`/`handleReject` AFTER `active.session
     * .resolveApproval()` has already been given the decision — never before,
     * since for the channel-based case that call is what actually resolves
     * the registry entry `pendingId` names.
     *
     * CRITICAL follow-up to finding 1 above: `pendingId` is a required
     * parameter — deliberately NOT read from `active.pendingApprovalId` inside
     * this method (indeed, this method no longer takes `active` at all). For a
     * channel-based session (claude), the `await active.session
     * .resolveApproval()` in `handleApprove`/`handleReject` BELOW THIS CALL is
     * exactly what synchronously drives `ctx.approvalChannel.resolve` ->
     * `approvalRegistry.resolve(A)` -> A's own `onResolve`
     * (`dispatchApproval` above) -> `dispatchNextQueuedApproval` — and that
     * last step, still inside the SAME synchronous call and therefore still
     * strictly BEFORE the caller's own `await` settles, dispatches the next
     * queued approval (B) and reassigns `active.pendingApprovalId = B`. A
     * caller that read `active.pendingApprovalId` only AFTER that `await`
     * returned (as this method itself used to, before it took `pendingId` as a
     * parameter) would therefore observe B, not A — resolving B (silently,
     * with A's decision: an auto-approve or a force-reject of an approval no
     * one ever actually decided) instead of the already-gone entry for A this
     * call is actually meant to (harmlessly) no-op against. Callers now
     * capture the target id BEFORE that await (`handleApprove`/`handleReject`
     * below) so this can only ever be asked to resolve the id it was meant to
     * all along. See `task-runner-approval.test.ts`'s channel-routing
     * regression test for this exact interleaving reproduced end to end.
     */
    private clearPendingApproval;
    /**
     * Protocol §5 approval flow: the server's own state already moved
     * `AwaitApproval -> Running` before this best-effort notification arrives
     * (§4) — resuming the session is what makes `task.progress` continue.
     *
     * M4 Phase 3 hardening (orchestrator-directed fix): a wire `task.approve`
     * can legitimately arrive AFTER a different, faster path (a racing local
     * `approvals.resolve` over the control socket, or this exact message
     * redelivered) already resolved the SAME approval — `ApprovalRegistry`'s
     * own "first resolution wins" guarantee means `session.resolveApproval()`
     * throws {@link NoPendingApprovalError} for that loser, not because
     * anything is actually wrong. Before this fix, ANY thrown error here
     * (stale or genuine) failed the whole task — for the stale case that
     * meant a task the winning path had ALREADY correctly resumed (and which
     * may go on to complete normally) got marked `Failed` anyway, purely
     * because a second, now-meaningless notification arrived late. Stale is
     * now an audit-only no-op; a genuine failure (the session itself
     * couldn't resume for some real reason) still fails the task exactly as
     * before.
     */
    private handleApprove;
    /**
     * Protocol §5 approval flow: the server's own state already moved
     * `AwaitApproval -> Failed` before this best-effort notification arrives
     * (§4) — the daemon's job is just to stop the session and prove it via
     * `task.fail`.
     *
     * M4 Phase 3 hardening (orchestrator-directed fix): same race as
     * `handleApprove` above, but the pre-fix bug here was worse — this method
     * unconditionally interrupted the session and sent `task.fail` regardless
     * of whether `resolveApproval` even threw, so a stale/late wire
     * `task.reject` (the local CLI, or a racing wire approve, already
     * resolved this exact approval a different way) would tear down and fail
     * a task that was already correctly approved and possibly still running
     * fine. Now: a {@link NoPendingApprovalError} short-circuits to an
     * audit-only no-op BEFORE the interrupt/fail/finish sequence — nothing
     * about this task's state is touched. Any OTHER outcome (success, or a
     * genuine non-staleness error) falls through to the existing
     * interrupt+`task.fail`+finish sequence unchanged: the server's own
     * record already moved `AwaitApproval -> Failed` for a REAL reject
     * (§4's "server state is authoritative on its own action" rule), so the
     * daemon must still conform to that regardless of whether telling the
     * session about it succeeded.
     */
    private handleReject;
    /** Pre-claim, fail-closed rejection (protocol §3.2) — never claims first. */
    private decline;
    private fail;
    /**
     * Claimed Agent failures before ActiveTask registration still carry the
     * exact AgentRef and normally have Agent-local, fsynced terminal evidence
     * first. A bounded storage failure degrades observably but cannot strand
     * the already-claimed cloud task forever; the exact terminal still goes on
     * the wire and handleOffer's finally block releases the lease.
     */
    private failClaimedAgent;
    /**
     * Build the optional terminal observation from facts this running daemon
     * actually has. No offered `dispatchSelection` is echoed here: it is a
     * requested execution target, not an adapter-reported provider/model fact.
     * The bundled adapter event contracts currently expose token observations
     * (Codex and Claude) but no provider/model observation, so those keys stay
     * absent. Pi reports one native usage observation per provider call
     * (`adapters/pi/events.ts`), so its block carries the LAST call's figures —
     * telemetry, exactly like the other runtimes' — and a Pi run that reported
     * none omits the block rather than fabricating one from independently known
     * runtime, elapsed duration, or Local Agent version.
     *
     * "Reported none" includes a last observation that carries NEITHER token
     * count: Pi still emits a `usage` event for a call whose usage block was
     * unreadable (so the prepared lane can count the call), and a terminal block
     * built from it would be a usage observation with no usage in it.
     */
    private terminalInferenceUsagePayload;
    /**
     * The prepared-only terminal observation, present exactly on a prepared
     * Execution that observed at least one provider call's prompt. It is
     * evidence the Host checks its own budget ruling against, deliberately a
     * separate field from the telemetry-only `usage` block.
     */
    private preparedObservationPayload;
    /** Exact Agent identity projection for claim/terminal wire payloads. */
    private agentTerminalPayload;
    /**
     * additive-minor (`task.complete.document`): the whole daemon-side gate
     * between a configured {@link ResultDocumentExtractor} and the wire —
     * called once, from the `turn_end` completion path, immediately before
     * `task.complete` is built.
     *
     * `{deliver: true}` means "go on and send `task.complete`", carrying the
     * document when there is one. `{deliver: false}` means this method has
     * ALREADY reported `task.fail` and finished the task; the caller must
     * return without sending anything further.
     *
     * Four fail-closed branches, all `retryable: false` (see
     * {@link RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX} for why none of them
     * can succeed on a retry):
     *
     *   1. The extractor threw — its error is surfaced, never swallowed.
     *   2. The extractor returned a thenable, violating the synchronous
     *      contract in the one way that would otherwise ship a wrong answer.
     *   3. The document is over the cap, not JSON-serializable, or not plain
     *      JSON data, per `checkResultDocument` — the protocol's OWN check,
     *      imported rather than reimplemented, so this gate and the server's
     *      schema validation can never disagree about what is legal.
     *   4. The connected server never advertised `result-document`. Its
     *      tolerant `z.object()` would silently strip the field on arrival
     *      (`version.ts`'s own flag doc comment), so "send anyway" is not a
     *      degraded-but-working path — it is the task's primary structured
     *      result being deleted in transit with nothing reported anywhere.
     *
     * The capability is checked LAST, deliberately: a document that is itself
     * invalid is the host's own bug and is worth reporting as such even when
     * the connected server could not have accepted any document at all. It is
     * then re-checked once more by the caller after its own last await, since
     * a reconnect can invalidate this answer in between (F3).
     *
     * **Residual window (bounded, deliberately not hacked around).** Even the
     * caller's re-check happens before `ConnectionManager.send` hands the
     * envelope to a transport, and a queued envelope can outlive the
     * connection it was queued for: a reconnect between `send()` and the
     * outbox actually draining could still deliver this `task.complete` to a
     * rolled-back N-1 server that strips the document. Closing that would
     * mean teaching the transport outbox to inspect payload semantics and
     * mint a substitute `task.fail` for a task this runner already finished —
     * a second authority over terminal outcomes living in the queue, which is
     * worse than the window it closes. Documented instead, here and in
     * docs/protocol.md §7.2.
     */
    private resolveResultDocument;
    /**
     * Whether the CURRENTLY connected server advertised `result-document` —
     * read fresh on every call, never captured, because the answer changes
     * across a reconnect or transport switch (`ConnectionManager` clears the
     * old advertisement at the boundary, then repopulates it from a fresh WS
     * ack or successful poll response). An absent `getServerCapabilities` seam is
     * "no capabilities", the fail-closed reading.
     */
    private hasResultDocumentCapability;
    private observeGit;
    private updateGitPhaseBestEffort;
    /** Persist Agent terminal truth before wire when local storage is available. */
    private persistAgentTerminalEvidence;
    private retryAgentTerminalEvidence;
    private reportAgentTerminalEvidenceFailure;
    retryTerminalFinalization(taskId: string): Promise<void>;
    private readonly finalizationAttempts;
    private finish;
    private finishOnce;
    private reserveSemanticTerminal;
    /**
     * Release the preparation pin this Execution holds, if it took one.
     *
     * Best effort by design, and loudly: a pin that cannot be released costs
     * retention, not correctness — the record stays uncollectable until an
     * operator intervenes — whereas turning a release failure into a task-terminal
     * would rewrite an already-established result for a reason the task itself had
     * nothing to do with.
     */
    private releasePreparationPin;
    /** M3-B: bounded insert for `finishedTaskIds` — see its class-level doc comment and `MAX_TRACKED_TASK_IDS`. Evicts the oldest (first-inserted) entry once over cap, same idiom as `ConnectionHub.checkAndRecordDuplicate` (packages/server/src/hub.ts). */
    private addFinishedTaskId;
    private addStrictDeclinedTaskId;
    /** `reuseDir`, when set (a known sessionRef's recorded workspace), is used verbatim instead of a fresh `workspaceRoot/<taskId>` directory — `mkdir recursive` is idempotent either way, so ensuring-exists is safe to do unconditionally. */
    private resolveWorkspaceDir;
    /**
     * M5 batch-3 (workstream 1): selects which adapter runs this offer, now
     * gated on both PRESENCE (`adapter.detect()`, as before) and CAPABILITY
     * (`adapterSupportsMode` — can this adapter even express `policyMode`?
     * new in this batch) — pre-claim, in both the explicit-runtime and
     * auto-select branches.
     *
     * Explicit-runtime branch (`requestedRuntime` set): semantics otherwise
     * unchanged from before this batch — allowlist and known-adapter checks
     * first, THEN the new capability check, THEN presence. A capability
     * mismatch here is a permanent characteristic of naming THIS runtime with
     * THIS policy (e.g. pi never supports `confirm`, on any device, by
     * design — `pi/permission-mapping.ts`) — `retryable: false`, the same
     * class as "not in allowlist"/"unknown runtime" above it, since retrying
     * this exact (runtime, mode) pair anywhere changes nothing.
     *
     * Auto-select branch (`requestedRuntime` absent): candidates are ordered
     * by `runtimePreference` (default {@link DEFAULT_RUNTIME_PREFERENCE}) —
     * see `orderByPreference` — then walked in that order; a candidate that
     * can't express `policyMode` is skipped (not detected at all — capability
     * is checked first, cheaper than a real subprocess probe) and the walk
     * continues down the preference order, exactly as "skip non-supporting
     * adapters and continue down the order" describes. If NOTHING eligible
     * supports the mode, `retryable: true` — unlike the explicit branch, this
     * is device-specific (which runtimes happen to be installed here), so a
     * different device's installed runtime set might satisfy it.
     */
    private pickAdapter;
}
export {};
// ==== @byok-sdk/client dist/daemon/team-workspace.d.ts ====
/**
 * The local team channel is deliberately a small, versioned contract.  It is
 * not a task outbox and it has no cloud or runtime authority.  The state file
 * is an atomic envelope so a post, a receipt, or a membership change is
 * either wholly visible after a restart or not visible at all.
 */
export declare const TEAM_WORKSPACE_VERSION: 1;
export declare const TEAM_WORKSPACE_DIRECTORY: string;
export declare const TEAM_WORKSPACE_STATE_FILENAME = "state.json";
export declare const TEAM_WORKSPACE_DEFAULT_CONTENT_TYPE = "text/plain";
/** Bounds are intentionally smaller than the control protocol's 64 KiB line. */
export declare const TEAM_WORKSPACE_MAX_ID_BYTES = 128;
export declare const TEAM_WORKSPACE_MAX_BODY_BYTES: number;
export declare const TEAM_WORKSPACE_MAX_CONTENT_TYPE_BYTES = 128;
export declare const TEAM_WORKSPACE_MAX_MEMBERS = 256;
export declare const TEAM_WORKSPACE_MAX_MESSAGES = 100000;
export declare const TEAM_WORKSPACE_MAX_BYTES: number;
export declare const TEAM_WORKSPACE_DEFAULT_LEASE_TTL_MS: number;
export declare const TEAM_WORKSPACE_MIN_LEASE_TTL_MS = 1;
export declare const TEAM_WORKSPACE_MAX_LEASE_TTL_MS: number;
/** A stable, content-addressed registry revision. */
export type TeamWorkspaceRevision = `sha256:${string}`;
export interface TeamWorkspaceLimits {
    readonly maxMembers: number;
    readonly maxMessages: number;
    readonly maxBytes: number;
}
export interface TeamWorkspaceDefinition {
    readonly version: typeof TEAM_WORKSPACE_VERSION;
    readonly workspaceId: string;
    readonly revision: TeamWorkspaceRevision;
    readonly members: readonly string[];
    readonly limits: TeamWorkspaceLimits;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface TeamWorkspaceMemberReceipt {
    readonly workspaceId: string;
    readonly memberId: string;
    readonly acknowledgedThroughSeq: number;
    readonly deliveredThroughSeq: number;
    readonly registryRevision: TeamWorkspaceRevision;
    readonly updatedAt: string;
}
export interface TeamMessage {
    readonly version: typeof TEAM_WORKSPACE_VERSION;
    readonly workspaceId: string;
    readonly seq: number;
    readonly messageId: string;
    readonly senderMemberId: string;
    readonly body: string;
    readonly contentType: string;
    readonly byteCount: number;
    readonly contentHash: TeamWorkspaceRevision;
    readonly createdAt: string;
}
/**
 * The token is intentionally opaque to callers.  It is returned once from
 * lease issuance and only its digest is persisted; raw bearer material never
 * enters the durable state file.
 */
export interface TeamMemberLease {
    readonly opaqueToken: string;
    readonly workspaceId: string;
    readonly memberId: string;
    readonly registryRevision: TeamWorkspaceRevision;
    readonly expiresAt: string;
}
export interface CreateTeamWorkspaceInput {
    readonly workspaceId: string;
    readonly members: readonly string[];
    readonly limits: TeamWorkspaceLimits;
}
export interface UpdateTeamWorkspaceInput {
    readonly workspaceId: string;
    readonly expectedRevision: TeamWorkspaceRevision;
    readonly members: readonly string[];
    readonly limits?: TeamWorkspaceLimits;
}
export interface CreateTeamMemberLeaseInput {
    readonly workspaceId: string;
    readonly memberId: string;
    readonly ttlMs?: number;
}
export interface TeamPostMessageInput {
    readonly lease: TeamMemberLease;
    readonly body: string;
    readonly contentType?: string;
}
export interface TeamReadMessagesInput {
    readonly lease: TeamMemberLease;
    readonly afterSeq?: number;
}
export interface TeamAckMessagesInput {
    readonly lease: TeamMemberLease;
    readonly throughSeq: number;
}
export interface TeamMessageAcceptedReceipt {
    readonly accepted: true;
    readonly durable: true;
    readonly workspaceId: string;
    readonly memberId: string;
    readonly seq: number;
    readonly messageId: string;
    readonly message: TeamMessage;
}
export interface TeamReadMessagesResult {
    readonly workspaceId: string;
    readonly memberId: string;
    readonly messages: readonly TeamMessage[];
    readonly afterSeq: number;
    readonly deliveredThroughSeq: number;
    readonly receipt: TeamWorkspaceMemberReceipt;
}
export interface TeamAckReceipt {
    readonly accepted: true;
    readonly durable: true;
    readonly throughSeq: number;
    readonly receipt: TeamWorkspaceMemberReceipt;
}
export interface LocalTeamWorkspaceOptions {
    /** Test seam for deterministic lease expiry and timestamps. */
    readonly now?: () => number;
}
/** Common typed failure for all rejected local team operations. */
export declare class TeamWorkspaceError extends Error {
    constructor(message: string);
}
export declare class TeamWorkspaceValidationError extends TeamWorkspaceError {
    constructor(message: string);
}
export declare class TeamWorkspaceNotFoundError extends TeamWorkspaceError {
    readonly workspaceId: string;
    constructor(workspaceId: string);
}
export declare class TeamWorkspaceConflictError extends TeamWorkspaceError {
    constructor(message: string);
}
export declare class TeamWorkspaceQuotaError extends TeamWorkspaceError {
    readonly quota: 'members' | 'messages' | 'bytes';
    constructor(quota: 'members' | 'messages' | 'bytes', message: string);
}
export declare class TeamWorkspaceLeaseError extends TeamWorkspaceError {
    constructor(message: string);
}
export declare class TeamWorkspaceReceiptError extends TeamWorkspaceError {
    constructor(message: string);
}
export declare class TeamWorkspaceCorruptError extends TeamWorkspaceError {
    constructor(message: string);
}
/** Public fail-closed validators for control/MCP composition sites. */
export declare function validateTeamWorkspaceId(value: unknown): string;
export declare function validateTeamMemberId(value: unknown): string;
export declare function validateTeamMessageBody(value: unknown): string;
export declare function validateTeamContentType(value: unknown): string;
/** Encode the full lease as one opaque helper context; it is never model input. */
export declare function encodeTeamMemberContext(lease: TeamMemberLease): string;
/** Decode only the exact bounded lease shape emitted by {@link encodeTeamMemberContext}. */
export declare function decodeTeamMemberContext(value: unknown): TeamMemberLease;
/**
 * Local-only durable TeamWorkspace authority.  The service is intentionally
 * independent from TaskRunner and cloud protocol: a caller must first obtain
 * a member lease, and all message operations derive workspace/member identity
 * from that lease rather than accepting it from model input.
 */
export declare class LocalTeamWorkspace {
    private readonly rootDir;
    private readonly statePath;
    private readonly now;
    private readonly queueKey;
    constructor(storeDir: string, options?: LocalTeamWorkspaceOptions);
    /** Create the secure state directory; it is safe to call on every start. */
    initialize(): Promise<void>;
    createWorkspace(input: CreateTeamWorkspaceInput): Promise<TeamWorkspaceDefinition>;
    getWorkspace(workspaceId: string): Promise<TeamWorkspaceDefinition | undefined>;
    listWorkspaces(): Promise<readonly TeamWorkspaceDefinition[]>;
    /** Local operator read for the tmux pane; it does not create or advance a member receipt. */
    inspectMessages(workspaceId: string, afterSeq?: number): Promise<readonly TeamMessage[]>;
    /** CAS-guarded membership/limit update.  A revision change invalidates all leases. */
    updateWorkspace(input: UpdateTeamWorkspaceInput): Promise<TeamWorkspaceDefinition>;
    createMemberLease(input: CreateTeamMemberLeaseInput): Promise<TeamMemberLease>;
    revokeMemberLease(input: {
        readonly lease: TeamMemberLease;
    }): Promise<void>;
    /** Validate the opaque lease and return its daemon-owned identity. */
    validateMemberLease(lease: TeamMemberLease): Promise<Readonly<{
        workspaceId: string;
        memberId: string;
        registryRevision: TeamWorkspaceRevision;
        expiresAt: string;
    }>>;
    postMessage(input: TeamPostMessageInput): Promise<TeamMessageAcceptedReceipt>;
    /** Metadata-only operator notification view. Never advances delivery or acknowledgement. */
    notificationSnapshot(input: TeamReadMessagesInput): Promise<{
        workspaceId: string;
        memberId: string;
        registryRevision: TeamWorkspaceRevision;
        expiresAt: string;
        acknowledgedThroughSeq: number;
        latestPeerSeq: number | null;
    }>;
    readMessages(input: TeamReadMessagesInput): Promise<TeamReadMessagesResult>;
    ackMessages(input: TeamAckMessagesInput): Promise<TeamAckReceipt>;
    private resolveLease;
    private load;
    private save;
    private enqueue;
}
/** The longer name is useful at composition sites; both names denote one authority. */
export { LocalTeamWorkspace as LocalTeamWorkspaceService };
// ==== @byok-sdk/client dist/daemon/tool-implementation-identity.d.ts ====
import type { RuntimeIdV1, ToolImplementationAttestedV1, ToolImplementationIdentityV1, ToolImplementationUnavailableReasonV1 } from '@byok-sdk/implementation-identity';
export * from '@byok-sdk/implementation-identity';
/**
 * WHICH logical entry of the runtime a launch addresses.
 *
 * Two, and they are the two this SDK owns: the ordinary rpc lane and the
 * prepared lane. Both start through the reserved-helper entry shape
 * `<interpreter> <entry> __byok_sdk_helper <kind> …`, so the kind is the only
 * thing that differs between them and it is bound, not passed as text.
 */
export type RuntimeLaunchKindV1 = 'pi-rpc' | 'pi-prepared';
export declare const RUNTIME_LAUNCH_KINDS: readonly RuntimeLaunchKindV1[];
/**
 * The environment NAMES a runtime launch description commits a value for.
 *
 * Exactly one today: `PI_PACKAGE_DIR`, which probe p3 measured to be the
 * runtime's single read point for its own package layout (`config.js:313`) and
 * which probe p5 measured to be a hard startup dependency in the interpreted
 * layout. The description points it at {@link RuntimeLaunchDescriptionV1.assetRoot}
 * — the release's own asset directory — so the runtime reads the measured,
 * read-only theme JSON rather than whatever a writable projection directory
 * happens to contain.
 *
 * This is a commitment of NAMES, not values: it says which variables the launch
 * description is the authority for, so a consumer that sets one of them from
 * anywhere else is visibly wrong rather than quietly last-write-wins.
 */
export declare const RUNTIME_LAUNCH_ENV_COMMITMENT_NAMES: readonly string[];
/**
 * The ONE description of how a runtime child starts. Strict, immutable, and
 * derived from nothing but an attested install record plus the exact pin this
 * build of the SDK declares.
 *
 * Every field exists because the alternative was a value discovered at launch
 * time from something writable:
 *
 * - `command` / `entry` — the interpreter and the sealed bundle, taken from the
 *   attested identity itself, never rebuilt from a package shape, a resolved
 *   bin or `import.meta.resolve`. The object that was checked is the object
 *   that is spawned.
 * - `fixedArgv` — the reserved-helper prefix for {@link kind}, bound separately
 *   from task flags.
 * - `processCwd` — the SEALED launch cwd, which is the child's `process.cwd()`.
 *   It is not the Agent home. A writable process cwd executes `bunfig.toml`
 *   preload and `.env` before any JavaScript inside the entry can check
 *   anything, and probe p4 measured that a `photon_rs_bg.wasm` planted in it is
 *   opened and instantiated for real.
 * - `sessionCwd` — the Agent home, passed to the runtime EXPLICITLY. Probe p2
 *   measured that every tool resolves against the session cwd rather than the
 *   process cwd, so the two decouple safely; this field is what makes the split
 *   a stated contract instead of an inherited accident.
 * - `assetRoot` — the release's own asset directory, and the value the launch
 *   commits `PI_PACKAGE_DIR` to.
 * - `envCommitments` — see {@link RUNTIME_LAUNCH_ENV_COMMITMENT_NAMES}.
 *
 * This description includes the session cwd and explicitly bound per-launch directory values.
 * What it deliberately does NOT carry: task flags, model selection, session ids,
 * or credential values. Task arguments remain the consumer's responsibility
 * after the fixed prefix. The description digest binds this launch, including
 * its explicit session cwd and controlled directory values.
 */
export interface RuntimeLaunchDescriptionV1 {
    readonly runtimeId: RuntimeIdV1;
    readonly kind: RuntimeLaunchKindV1;
    readonly credentialSource: 'pi-auth-store' | 'keys-profile';
    readonly directoryValues: Readonly<Record<string, string>>;
    /** The interpreter's path, or the compiled artifact's. */
    readonly command: string;
    /** The sealed bundle the interpreter runs. Present iff the form is `interpreter+bundle`. */
    readonly entry?: string;
    readonly fixedArgv: readonly string[];
    readonly processCwd: string;
    readonly sessionCwd: string;
    readonly assetRoot: string;
    readonly envCommitments: readonly string[];
}
/** The per-launch inputs a description cannot derive from the record alone. */
export interface RuntimeLaunchInputV1 {
    readonly runtimeId: RuntimeIdV1;
    readonly kind: RuntimeLaunchKindV1;
    readonly credentialSource?: 'pi-auth-store' | 'keys-profile';
    readonly directoryValues?: Readonly<Record<string, string>>;
    /**
     * The Agent home this task runs in, passed to the runtime explicitly. It is
     * NOT the process cwd and must not be: that is the whole split.
     */
    readonly sessionCwd: string;
    /**
     * The exact pin this build of the SDK declares — `adapters/pi/resolve-bin.ts`'s
     * `resolvePiRuntimeIdentity()`. Passed in rather than read here so this module
     * performs no package resolution of its own: the identity authority reads the
     * filesystem to MEASURE, never to discover.
     */
    readonly pin: {
        readonly name: string;
        readonly version: string;
    };
}
/**
 * The canonical digest of one description, for binding.
 *
 * Taken over the description alone, with the keys inserted in sorted order so
 * the hashed bytes are a function of the content. It is what a consumer carries
 * from the moment the launch was decided to the moment the child is spawned:
 * the attested identity already binds the interpreter, the bundle, the sealed
 * assets, the asset root, the fixed argv (as the record's own `launchArgv`) and
 * the process cwd, and this digest additionally binds the per-launch session
 * cwd and the resolved kind — the two facts an identity cannot carry without
 * becoming a different identity for every task.
 */
export declare function runtimeLaunchDescriptionDigest(description: RuntimeLaunchDescriptionV1): string;
/**
 * Turn one attested identity into the description of the child it starts, or
 * say why it cannot.
 *
 * Every refusal below is `install_record_mismatch`, and for one reason: each is
 * the record failing to describe a launch this SDK can perform, not a file that
 * changed or a resolver that declined. There is no repair path and no default —
 * a missing asset root, a missing fork provenance, an argv prefix the host chose
 * for itself, or a sealed cwd that is the Agent home are all records that cannot
 * be launched, and a description invented over the top of one would be this SDK
 * attesting its own guess.
 */
export declare function deriveRuntimeLaunchDescription(identity: ToolImplementationAttestedV1, input: RuntimeLaunchInputV1): RuntimeLaunchDescriptionV1 | 'install_record_mismatch';
/**
 * Why a runtime launch was declined. Every unavailable reason EXCEPT
 * `resolver_unconfigured`, which is not a decline at all — see
 * {@link RuntimeLaunchDecisionV1}.
 */
export type RuntimeLaunchDeclineReasonV1 = Exclude<ToolImplementationUnavailableReasonV1, 'resolver_unconfigured'>;
/**
 * What a consumer is allowed to do with a runtime subject, as three cases that
 * cannot be confused for one another.
 *
 * The runtime subject is STRICTER than the MCP subject, and this type is where
 * that asymmetry is stated (§77 ruling 3). An MCP server whose implementation
 * is unproven still runs and the receipt says it is unproven; a RUNTIME whose
 * implementation is unproven does not run at all, because it is the process the
 * whole task executes inside and an unattested one makes every downstream
 * attestation decorative.
 *
 * - `attested` — the description and the identity it came from. The consumer
 *   spawns exactly this, after re-measuring.
 * - `unconfigured` — no {@link ToolImplementationAuthority} is wired in. This
 *   SDK ships no resolver, so it is the default state and it is the DEV path:
 *   the launch proceeds unattested, exactly as it does today. It is a separate
 *   arm rather than a decline reason so a consumer cannot decline the dev path
 *   by reading `kind` alone.
 * - `declined` — an authority IS configured and the runtime is not attested.
 *   The consumer refuses the task. It is a separate arm rather than a reason on
 *   `unconfigured` so a consumer cannot let a configured-but-unattested runtime
 *   through by reading `kind` alone either. The distinction is carried by the
 *   TYPE because it is the one distinction that decides whether credentials
 *   reach a child.
 */
export type RuntimeLaunchDecisionV1 = {
    readonly kind: 'attested';
    readonly description: RuntimeLaunchDescriptionV1;
    readonly identity: ToolImplementationAttestedV1;
} | {
    readonly kind: 'unconfigured';
    readonly reason: 'resolver_unconfigured';
} | {
    readonly kind: 'declined';
    readonly reason: RuntimeLaunchDeclineReasonV1;
};
/**
 * Decide one runtime launch from an already-resolved identity.
 *
 * Pure: it measures nothing and reads nothing. The measurement happened in
 * {@link resolveToolImplementationIdentity}, and it happens AGAIN in
 * {@link reverifyToolImplementationIdentity} immediately before the child is
 * spawned. This function only says which of the three cases the consumer is in.
 */
export declare function decideRuntimeLaunch(identity: ToolImplementationIdentityV1, input: RuntimeLaunchInputV1): RuntimeLaunchDecisionV1;
// ==== @byok-sdk/client dist/daemon/toolset-registry.d.ts ====
import { type ToolsetId } from '@byok-sdk/protocol';
import type { McpToolsetConfig, McpToolsetObservation, McpToolsetRegistryStatus, McpToolsetReloadReceipt } from '../types';
export type McpToolsetConfigInput = Record<string, McpToolsetConfig> | undefined;
export interface McpToolsetRegistrySnapshot {
    revision: string;
    toolsets: ReadonlyMap<string, McpToolsetConfig>;
    configuredToolsets: readonly ToolsetId[];
}
export declare class McpToolsetRevisionConflictError extends Error {
    readonly expectedRevision: string;
    readonly actualRevision: string;
    constructor(expectedRevision: string, actualRevision: string);
}
export declare class McpToolsetDefinitionRevisionConflictError extends Error {
    readonly toolsetId: string;
    readonly expectedRevision: string;
    readonly actualRevision: string;
    constructor(toolsetId: string, expectedRevision: string, actualRevision: string);
}
/** Single mutable owner of immutable-at-a-time device-local toolset snapshots. */
export declare class McpToolsetRegistry {
    private state;
    private observations;
    constructor(configured?: McpToolsetConfigInput);
    snapshot(): McpToolsetRegistrySnapshot;
    status(): McpToolsetRegistryStatus;
    reload(configured: McpToolsetConfigInput, expectedRevision: string): McpToolsetReloadReceipt;
    report(toolsetId: string, expectedDefinitionRevision: string, observation: McpToolsetObservation): void;
    private statusRows;
}
// ==== @byok-sdk/client dist/daemon/trusted-launch-cwd.d.ts ====
import type { McpLaunchAttestation, ResolvedMcpLaunchCwdLauncher } from '@byok-sdk/implementation-identity';
export type { McpLaunchAttestation, ResolvedMcpLaunchCwdLauncher } from '@byok-sdk/implementation-identity';
import type { McpStdioServerConfig } from '../types';
/**
 * The working directory an MCP toolset SERVER child is launched in, and why it
 * is not the Agent home.
 *
 * A `bun --compile` single-file binary reads `$cwd/bunfig.toml` and runs its
 * `preload` entries BEFORE any of the program's own code — verified on
 * Bun 1.4.2, and `--config=/dev/null` does not suppress it for a compiled
 * binary (it suppresses it only for the bare interpreter, because the flag
 * reaches the program's argv rather than the runtime). The only control point
 * is therefore the child's cwd.
 *
 * Until this module existed, every MCP toolset server child inherited the
 * canonical Agent home as its cwd — a directory the agent's own tools write to
 * by design. Any compiled server binary (Salesko's `salesko-agent mcp serve`
 * is one) could be handed arbitrary preload code by the agent it is supposed
 * to be serving.
 *
 * The RUNTIME process (the pi/claude/codex CLI itself) keeps the manifest cwd:
 * session resume and relative-path resolution depend on it, and it is not the
 * thing this boundary is about.
 *
 * Non-writability is PROVEN, never assumed from a mode bit: `resolve` attempts
 * to create a file in the candidate and requires the attempt to fail with
 * `EACCES`/`EPERM`/`EROFS`. A candidate that accepts the write is rejected
 * (and the probe file removed) even if its permissions looked right — mode
 * bits do not account for ACLs, for the effective uid, or for a filesystem
 * that was remounted read-write.
 *
 * The probe alone is not the boundary, because both of its premises are things
 * this uid can change:
 *
 * - A directory OWNED by this uid answers the probe with `EACCES` while its
 *   owner remains free to `chmod` it writable first. Ownership by another uid
 *   (root, for the intended immutable versioned release directory) is therefore
 *   required, not just a cleared write bit.
 * - `rename(2)` replaces a directory using write permission on its PARENT.
 *   A root-owned 0555 directory sitting inside a directory this uid can write
 *   is a directory this uid can swap out wholesale. So every ancestor up to the
 *   volume root is put through the identical check.
 *
 * WHAT DOES THE CHDIR, on each platform:
 *
 * - POSIX (darwin, linux): the trusted system `/bin/sh`, run as
 *   `sh -c 'cd -- "$0" && exec "$@"' <dir> <command> [...args]`. The shell is
 *   already on the machine, is root-owned and not group/other-writable (both
 *   proven here, not assumed), reads no rc file for `-c`, and `exec`s so the
 *   runtime CLI's child IS the server. No Node host is required, which is the
 *   point: a daemon embedded in a `bun --compile` product executable has a
 *   trusted launcher without attesting anything.
 * - win32: this package's `bin/byok-launch-cwd.mjs`, which needs a real Node
 *   host. A host that is not plain Node (Bun, Deno, a single-executable
 *   application) and attests no interpreter is REFUSED, fail-closed. There is
 *   deliberately no Windows shell path: `cmd.exe` has no `exec`, and its
 *   quoting rules are not something a boundary should be built on.
 *
 * A launch-cwd PASS asserts WHERE the server starts. It does not assert that
 * the launcher or the executor is the binary it claims to be — that is the
 * separate attested-install work.
 */
/** Operator-supplied inputs to {@link resolveTrustedLaunchCwd}. Both fields are optional and both are validated. */
export interface McpLaunchCwdConfig {
    /**
     * An absolute directory to launch MCP toolset servers in, in preference to
     * the platform default. It must still pass every check below — a configured
     * directory is a preference, never an exemption.
     *
     * The intended value is an immutable, root-owned versioned release
     * directory. `os.tmpdir()` and anything else this daemon's own uid can write
     * is rejected by the write probe: the agent runs at that same uid in the
     * common deployment, so such a directory isolates other users and nothing
     * else.
     */
    readonly dir?: string;
    /**
     * ESCAPE HATCH, not a supported path. An absolute path to a Node executable
     * used to run this package's `bin/byok-launch-cwd.mjs` for the runtimes whose
     * MCP configuration cannot express a per-server cwd (claude, codex).
     *
     * The supported launchers need no configuration: POSIX bootstraps through the
     * trusted system `/bin/sh`, and win32 runs the shipped launcher script on a
     * real Node host. This field exists for the deployment that has neither and
     * can attest a Node binary of its own. A host that sets it takes on proving
     * the binary it names is one the agent's uid cannot replace — nothing here
     * can prove that for an arbitrary path.
     */
    readonly launcherInterpreter?: string;
}
/**
 * Why one candidate directory failed, independent of where the candidate came
 * from. `is_writable` is the one that matters most: it means the write probe
 * SUCCEEDED, so this uid can create files there and the directory isolates
 * nobody the agent is not already running as.
 */
export type LaunchCwdRejection = 'not_absolute' | 'unreadable' | 'is_a_symlink' | 'not_a_directory' | 'is_writable'
/**
 * The candidate is owned by the uid this daemon runs as. A mode bit is not a
 * boundary against its own owner: the agent, running at that same uid, can
 * `chmod` the directory writable and then plant `bunfig.toml` in it. Only an
 * owner OUTSIDE this uid (root, in the intended immutable-release shape) puts
 * the directory beyond the agent's reach.
 */
 | 'owned_by_current_uid'
/**
 * An ancestor could not be inspected, is a symlink, is not a directory, is
 * owned by this uid, or accepted the write probe. Any of those lets this uid
 * `rename` the candidate out of the way and put its own directory at the same
 * path — the leaf's own mode never comes into it.
 */
 | 'ancestor_unreadable' | 'ancestor_is_a_symlink' | 'ancestor_not_a_directory' | 'ancestor_owned_by_current_uid' | 'ancestor_writable';
/**
 * `root_cannot_prove_write_boundary` is uid 0: no directory on the machine is
 * unwritable by this process, so the boundary cannot be proven at all. The
 * rest name which candidate was tried and how it failed.
 */
export type TrustedLaunchCwdUnavailableReason = 'root_cannot_prove_write_boundary' | 'no_platform_default_directory' | `configured_dir_${LaunchCwdRejection}` | `platform_default_${LaunchCwdRejection}`;
export type TrustedLaunchCwd = {
    readonly kind: 'resolved';
    readonly dir: string;
} | {
    readonly kind: 'unavailable';
    readonly reason: TrustedLaunchCwdUnavailableReason;
};
/** The three facts the POSIX launcher check reads off one path. */
export interface LaunchCwdShellStatEntry {
    readonly uid: number;
    /** The permission bits, as `st_mode` carries them. */
    readonly mode: number;
    readonly isFile: boolean;
}
/**
 * The `node:fs` calls {@link resolveMcpLaunchCwdLauncher} makes on the system
 * shell, as one injectable triple. Each call throws exactly as `fs` does when
 * the path cannot be inspected.
 */
export interface LaunchCwdShellStat {
    readonly lstat: (target: string) => LaunchCwdShellStatEntry;
    readonly stat: (target: string) => LaunchCwdShellStatEntry;
    readonly realpath: (target: string) => string;
}
/** Seam for the tests that must run the uid-0 and filesystem branches without being root. */
export interface TrustedLaunchCwdEnvironment {
    readonly platform?: NodeJS.Platform;
    readonly getuid?: () => number;
    readonly env?: Readonly<Record<string, string | undefined>>;
    /**
     * The system shell the POSIX launcher bootstraps through. Defaults to
     * `/bin/sh` and is overridden only by tests, which point it at a shell built
     * to fail one specific trust check.
     */
    readonly systemShell?: string;
    /**
     * How the shell's ownership and mode are read. Defaults to real `node:fs`.
     * Injected by the tests that must exercise a root-owned-but-group-writable
     * shell, which a non-root test process cannot create on disk.
     */
    readonly shellStat?: LaunchCwdShellStat;
}
/** Read-only facts only: success makes no ACL/non-writability claim and is not launch admission. */
export declare function inspectTrustedLaunchCwd(dir: string): Promise<TrustedLaunchCwd>;
/**
 * Resolve the directory every MCP toolset server child of this daemon is
 * launched in, or state why no such directory could be proven.
 *
 * Not memoized: the whole result is one `lstat` plus one failed `open`, and a
 * cached "resolved" would keep asserting a boundary after the directory it
 * names was remounted, replaced, or chmodded.
 */
export declare function resolveTrustedLaunchCwd(config?: McpLaunchCwdConfig, environment?: TrustedLaunchCwdEnvironment): Promise<TrustedLaunchCwd>;
/**
 * The POSIX bootstrap program, run as `sh -c <SCRIPT> <trustedCwd> <command>
 * [...args]`.
 *
 * `sh -c` assigns the first word after the program text to `$0` and the rest
 * to `$1...`, so `$0` is the trusted directory and `"$@"` is the target's argv
 * with no shell word splitting, no globbing and no quoting round trip: an
 * argument containing a space, a tab, a newline, a quote, `$(...)`, a backtick,
 * `*`, `;`, `&&`, `~` or non-ASCII bytes arrives byte-identical.
 *
 * `cd --` (rather than a bare `cd`) is what keeps a directory named `-L` or
 * `-P` from being read as an option. The target is reached through `exec`, so
 * the shell replaces itself and the runtime CLI's child IS the server: one
 * pid, signals and exit status pass through with nothing in between.
 *
 * `exec -- "$@"` is NOT used, and must not be: dash rejects it outright
 * (`exec: --: not found`, exit 127). The form below is the one verified on
 * dash 0.5.12, bash 5.2.37 invoked as `sh`, busybox ash, and macOS `/bin/sh`.
 *
 * `cd` is given an ABSOLUTE realpath by {@link wrapMcpServerWithLaunchCwd},
 * because a relative argument to `cd` is resolved through `CDPATH` — which is
 * why `CDPATH` (along with `ENV`, `BASH_ENV`, `SHELLOPTS`, `BASHOPTS` and
 * `PS4`) is in the loader deny list `daemon/environment.ts` enforces.
 */
export declare const MCP_LAUNCH_CWD_SHELL_SCRIPT = "cd -- \"$0\" && exec \"$@\"";
/**
 * Why no trusted launcher could be produced for this host. Every one of these
 * refuses the offer: there is no fallback launcher, because every fallback
 * available here is one the agent's own uid could have written.
 */
export type McpLaunchCwdLauncherUnavailableReason = 
/**
 * win32 only: this process is not a plain Node that would run the launcher
 * script it is handed (Bun, Deno, or a single-executable application), and
 * the operator attested no interpreter. A compiled Bun host is the case that
 * matters — it would read `$cwd/bunfig.toml` and run its `preload` before the
 * launcher's own first statement, which is the exact vector this boundary
 * closes.
 */
'launch_cwd_launcher_unavailable'
/** POSIX: `/bin/sh` could not be inspected at all. */
 | 'launch_cwd_shell_unreadable'
/** POSIX: `/bin/sh` resolves to something that is not a regular file. */
 | 'launch_cwd_shell_not_a_regular_file'
/**
 * POSIX: `/bin/sh`, or the symlink standing at that path, is not owned by
 * root. A shell this uid owns is a shell the agent can replace, and the
 * bootstrap would then be running the agent's own program.
 */
 | 'launch_cwd_shell_not_root_owned'
/** POSIX: `/bin/sh` is group- or world-writable, so its owner is not the only writer. */
 | 'launch_cwd_shell_writable';
export type McpLaunchCwdLauncher = ResolvedMcpLaunchCwdLauncher | {
    readonly kind: 'unavailable';
    readonly reason: McpLaunchCwdLauncherUnavailableReason;
};
/** The shipped launcher script, resolved from this package's own root so it works from `dist/` and from source. */
export declare function launchCwdScriptPath(): string;
export declare function resolveMcpLaunchCwdLauncher(config?: McpLaunchCwdConfig, environment?: TrustedLaunchCwdEnvironment): McpLaunchCwdLauncher;
/** What the daemon resolved once per offer and every adapter of that offer launches through. */
export interface McpLaunchBinding {
    /** The proven non-writable directory every MCP toolset server child starts in. */
    readonly cwd: string;
    /** Present only for adapters whose MCP configuration cannot carry a cwd. */
    readonly launcher?: ResolvedMcpLaunchCwdLauncher;
}
/**
 * Rewrite one server's `command`/`args` so the child reaches its real
 * executable already chdir'd into the trusted directory.
 *
 * argv is passed through structurally — no shell word splitting, no quoting,
 * no concatenation — so a server argument containing a space, a quote,
 * `$(...)`, a semicolon or a newline arrives byte-identical. The `shell`
 * launcher runs a fixed program text that never interpolates an argument into
 * itself; the arguments reach it as positional parameters.
 *
 * `env` is carried through untouched: it is the server's own task-scoped
 * authority and the launcher is not a place to edit it.
 *
 * Three refusals, all fail-closed, all specific to the fact that a shell now
 * stands between the runtime and the server:
 *
 * - A relative `cwd` would be resolved by `cd` through `CDPATH`, so the
 *   directory the boundary names must be absolute.
 * - A `command` starting with `-` would be read by `exec` as one of ITS own
 *   options rather than as the program to run.
 * - A relative `command` is a PATH lookup performed after the chdir, which is
 *   not the identity the binding attested. It is not resolved here — this
 *   module does not own a PATH lookup and is not the place to invent one — so
 *   it is refused.
 *
 * The last two are this wrapper's OWN boundary assertion, standing behind the
 * registry rule rather than substituting for it: `./toolset-registry.ts` already
 * refuses a non-absolute or option-like `command` at load, so an operator's
 * configuration can never reach here carrying one. These stay because this
 * function also wraps commands the registry never saw — the SDK's reserved
 * helpers — and because a wrapper that quietly launched whatever it was handed
 * would make the earlier rule the only thing holding the boundary up.
 */
export declare function wrapMcpServerWithLaunchCwd(server: Readonly<McpStdioServerConfig>, binding: McpLaunchBinding & {
    readonly launcher: ResolvedMcpLaunchCwdLauncher;
}): McpStdioServerConfig;
/**
 * The identity of the launch path, as a value a fingerprint can bind.
 *
 * Deliberately NOT folded into the toolset's `definitionRevision`
 * (`./toolset-registry.ts`): that digest is the operator's configured intent —
 * the `command`/`args` they wrote and the read/mutation classification they
 * declared. An SDK launcher upgrade is not a change to their configuration,
 * and making it one would churn every stored revision on every SDK release.
 * It is drift of a different fact, so it is bound as a different fact.
 *
 * `kind` is part of the bound value: a shell bootstrap and a Node launcher are
 * different launch mechanisms and must never fingerprint equal, even in the
 * degenerate case where they were handed the same two strings.
 */
export declare function mcpLaunchAttestation(binding: McpLaunchBinding): McpLaunchAttestation;
// ==== @byok-sdk/client dist/daemon/truth-memory-client.d.ts ====
import { type ContentHash, type TruthRecordKind, type TruthRecordSelector } from '@byok-sdk/core';
import type { DeviceProofSigner } from './device-proof-signer';
export interface TruthManifestRecord {
    readonly kind: TruthRecordKind;
    readonly recordKey: string;
    readonly rev: number;
    readonly contentHash: ContentHash;
    readonly byteSize: number;
    readonly label?: string;
    readonly updatedAt: string;
}
export interface TruthManifestQueryInput {
    readonly kind?: TruthRecordKind;
    readonly keyPrefix?: string;
    readonly limit?: number;
}
/** Cloud-agnostic local semantic selection. It sees metadata and no body bytes. */
export interface MemorySelector {
    select(manifest: readonly TruthManifestRecord[]): readonly TruthRecordSelector[] | Promise<readonly TruthRecordSelector[]>;
}
/** A body reaches this seam only after manifest equality, byte-size and SHA-256 checks. */
export interface VerifiedTruthRecord extends TruthManifestRecord {
    readonly bytes: Uint8Array;
}
/** The only value returned by `loadSelected`; runtime prompt/context shape stays host-owned. */
export interface LocalMemoryFilter<Context> {
    filter(records: readonly VerifiedTruthRecord[]): Context | Promise<Context>;
}
export interface TruthMemoryMetric {
    readonly kind: 'truth.snapshot.large';
    readonly selector: TruthRecordSelector;
    readonly byteSize: number;
    readonly thresholdBytes: number;
}
export interface TruthMemoryClientOptions {
    readonly serverUrl: string;
    readonly signer: DeviceProofSigner;
    /** Exact http(s) origins permitted to receive object-download grants. An empty list disables object reads. */
    readonly allowedObjectDownloadOrigins: readonly string[];
    readonly fetch?: typeof globalThis.fetch;
    readonly requestId?: () => string;
    readonly onMetric?: (metric: TruthMemoryMetric) => void;
}
export type TruthWriteBody = {
    readonly kind: 'inline';
    readonly content: string;
} | {
    readonly kind: 'object';
    readonly contentHash: string;
    readonly byteSize: number;
};
export interface TruthSnapshotWriteInput {
    readonly kind: 'profile' | 'memory';
    readonly recordKey: string;
    readonly expectedRev: number;
    readonly body: TruthWriteBody;
    readonly requestId: string;
    readonly label?: string;
}
export interface TruthSnapshotCandidateInput {
    readonly kind: 'profile' | 'memory';
    readonly recordKey: string;
    readonly expectedRev: number;
    readonly body: TruthWriteBody;
    readonly label?: string;
}
export interface TruthTerminalWriteInput {
    readonly taskId: string;
    readonly body: TruthWriteBody;
    readonly requestId: string;
    readonly label?: string;
    readonly snapshots?: readonly TruthSnapshotCandidateInput[];
}
export interface TruthWriteResult {
    readonly primary: TruthManifestRecord;
    readonly snapshots: readonly TruthManifestRecord[];
    readonly replayed: boolean;
}
export type TruthMemoryClientErrorCode = 'truth_http_failed' | 'truth_response_invalid' | 'truth_selection_invalid' | 'truth_manifest_changed' | 'truth_content_size_mismatch' | 'truth_content_hash_mismatch' | 'truth_object_url_rejected' | 'truth_write_invalid' | 'truth_write_confirmation_mismatch';
export declare class TruthMemoryClientError extends Error {
    readonly code: TruthMemoryClientErrorCode;
    readonly status?: number | undefined;
    constructor(code: TruthMemoryClientErrorCode, message: string, status?: number | undefined);
}
/** Proof-only client for S6 truth records. It never sends a bearer token. */
export declare class TruthMemoryClient {
    #private;
    private readonly options;
    constructor(options: TruthMemoryClientOptions);
    listManifest(query?: TruthManifestQueryInput): Promise<readonly TruthManifestRecord[]>;
    loadSelected<Context>(selector: MemorySelector, filter: LocalMemoryFilter<Context>, query?: TruthManifestQueryInput): Promise<Context>;
    writeSnapshot(input: TruthSnapshotWriteInput): Promise<TruthWriteResult>;
    writeTerminal(input: TruthTerminalWriteInput): Promise<TruthWriteResult>;
}
// ==== @byok-sdk/client dist/diagnostics/device-doctor.d.ts ====
import type { DaemonConfig } from '../daemon/create-daemon';
import type { RuntimeAdapter } from '../types';
import type { DiagnosticsSnapshot } from './types';
export type { DiagnosticsSnapshot, DiagnosticCheck, DiagnosticStatus } from './types';
export interface DiagnoseDeviceOptions {
    /** The same adapters used by an embedded host; omitted uses bundled adapters. */
    adapters?: RuntimeAdapter[];
    runtimeProbeTimeoutMs?: number;
}
/** Read-only device observation; does not read OS credentials or prove Agent readiness. */
export declare function diagnoseDevice(config: DaemonConfig, options?: DiagnoseDeviceOptions): Promise<DiagnosticsSnapshot>;
export interface RepairDeviceEnrollmentMetadataInput {
    confirmed: true;
    /** Obtain both from the host's authorized enrollment target, never from a guessed default. */
    expectedDeviceId: string;
    expectedTenantId: string;
}
export interface DeviceMetadataRepairResult {
    action: 'restore-enrollment-metadata';
    scope: 'device';
    /** Metadata readback only; does not imply renewed credentials or a running daemon. */
    status: 'repaired' | 'not-needed';
}
declare const MESSAGES: {
    readonly 'confirmation-required': 'Explicit confirmation is required for enrollment metadata repair.';
    readonly 'invalid-target': 'An explicit expected tenant and device are required.';
    readonly 'daemon-running': 'Stop the daemon before enrollment metadata repair.';
    readonly 'store-busy': 'The store is owned by another operation; enrollment metadata repair refused.';
    readonly 'authority-unavailable': 'The OS enrollment authority could not be read.';
    readonly 'authority-missing': 'No complete OS enrollment exists; use explicit authenticated pairing.';
    readonly 'target-mismatch': 'The OS enrollment does not match the expected tenant and device.';
    readonly 'projection-unavailable': 'The enrollment metadata could not be read safely; repair refused.';
    readonly 'repair-failed': 'Enrollment metadata repair did not complete; inspect the state before retrying.';
};
export type DeviceMetadataRepairErrorCode = keyof typeof MESSAGES;
/** Closed diagnostics only: no OS stderr, local paths, authority bytes or nested cause. */
export declare class DeviceMetadataRepairError extends Error {
    readonly code: DeviceMetadataRepairErrorCode;
    constructor(code: DeviceMetadataRepairErrorCode);
}
/**
 * Explicitly restore missing/valid-stale device.json from its existing OS authority.
 * Does not instantiate AuthManager, renew credentials, pair, or start a runtime.
 * Ordinary doctor remains credential-blind; only this confirmed action opens the OS store.
 */
export declare function repairDeviceEnrollmentMetadata(config: DaemonConfig, input: RepairDeviceEnrollmentMetadataInput): Promise<DeviceMetadataRepairResult>;
// ==== @byok-sdk/client dist/diagnostics/operator-actions.d.ts ====
import { type AgentRef } from '@byok-sdk/protocol';
import type { DaemonConfig } from '../daemon/create-daemon';
import type { OperationalHealthFixResult } from './types';
import type { DiagnoseDeviceOptions } from './device-doctor';
declare const MESSAGES: {
    readonly 'confirmation-required': 'Explicit confirmation is required for this local maintenance action.';
    readonly 'invalid-input': 'The maintenance action requires valid explicit inputs.';
    readonly 'daemon-running': 'Stop the host daemon before local maintenance.';
    readonly 'store-busy': 'Another operation owns the device store.';
    readonly 'agent-busy': 'Another operation owns the Agent home.';
    readonly 'target-mismatch': 'The stored device or Agent records do not match the authorized target.';
    readonly 'source-unavailable': 'The local source cannot be accessed safely; preserve it for inspection.';
    readonly 'output-exists': 'The selected output already exists; it will not be overwritten.';
    readonly 'operation-failed': 'The maintenance operation did not complete; preserve evidence before retrying.';
};
export type DeviceOperatorErrorCode = keyof typeof MESSAGES;
/** Closed codes only: never attach filesystem/OS error text, paths or nested causes. */
export declare class DeviceOperatorError extends Error {
    readonly code: DeviceOperatorErrorCode;
    constructor(code: DeviceOperatorErrorCode);
}
export interface ConfirmDeviceMaintenanceInput {
    confirmed: true;
}
export type DeviceHealthQuarantineResult = OperationalHealthFixResult & {
    action: 'quarantine-operational-health';
    scope: 'device';
};
export interface ExportDeviceSupportBundleInput extends DiagnoseDeviceOptions {
    /** Absolute, previously unused file in an existing directory. */
    outputPath: string;
}
export interface DeviceSupportBundleExportResult {
    action: 'export-support-bundle';
    scope: 'device';
    status: 'written';
    bundleVersion: 1;
}
export interface ArchiveAgentTerminalMessagesInput extends ConfirmDeviceMaintenanceInput {
    expectedTenantId: string;
    expectedDeviceId: string;
    /** Selects one Agent home. Historical profile revisions are preserved verbatim. */
    agentRef: AgentRef;
    /** Absolute NEW directory in an existing parent; contains sensitive audit bodies. */
    archiveDirectory: string;
}
export type AgentTerminalMessagesArchiveResult = {
    action: 'archive-terminal-messages';
    scope: 'agent';
} & ({
    status: 'not-needed';
} | {
    status: 'archived';
    archivedRecords: number;
    archiveFileName: string;
});
/** Quarantines confirmed-corrupt health only; the host owns supervisor stop/restart. */
export declare function quarantineDeviceOperationalHealth(config: DaemonConfig, input: ConfirmDeviceMaintenanceInput): Promise<DeviceHealthQuarantineResult>;
/** Read-only source observation; publishes only the SDK allowlisted bundle, never raw logs. */
export declare function exportDeviceSupportBundle(config: DaemonConfig, input: ExportDeviceSupportBundleInput): Promise<DeviceSupportBundleExportResult>;
/** Archive refused/revoked evidence for one Agent under device and Agent single-writer leases. */
export declare function archiveAgentTerminalMessages(config: DaemonConfig, input: ArchiveAgentTerminalMessagesInput): Promise<AgentTerminalMessagesArchiveResult>;
export {};
// ==== @byok-sdk/client dist/diagnostics/types.d.ts ====
import type { RuntimeDetectResult, RuntimeDetectionRefusalReason } from '../types';
import type { ControlStatusResult } from '../daemon/control-protocol';
import type { OperationalHealthFileInspection } from '../daemon/operational-health';
export type DiagnosticStatus = 'pass' | 'warn' | 'fail';
export interface DiagnosticCheck {
    id: 'config' | 'device' | 'runtimes' | 'control' | 'health' | 'journal' | 'workspace' | 'quarantine';
    status: DiagnosticStatus;
    summary: string;
}
export interface DiagnosticsSnapshot {
    version: 1;
    generatedAt: string;
    product: {
        nameHash: string;
        idHash: string;
    };
    system: {
        node: string;
        platform: NodeJS.Platform;
        arch: string;
        sqliteAvailable: boolean;
    };
    config: {
        serverProtocol: 'http' | 'https' | 'ws' | 'wss' | 'invalid' | 'unsupported';
        customStoreDir: boolean;
        hostedJournal: boolean;
        runtimeAllowlistCount?: number;
    };
    device: {
        status: 'paired' | 'unpaired' | 'unavailable';
        deviceIdHash?: string;
    };
    runtimes: Array<{
        idHash: string;
        present: boolean;
        outcome: RuntimeDetectResult['kind'];
        reason?: RuntimeDetectionRefusalReason;
        versionPresent: boolean;
        authPresent?: boolean;
        steer: boolean;
        resume: boolean;
        permissionModeCount: number;
    }>;
    control: {
        status: 'offline';
        reason: string;
    } | {
        status: 'online';
        pid: number;
        uptimeMs: number;
        transport: string;
        activeTaskCount: number;
        pendingApprovalCount: number;
        operationalHealth: ControlStatusResult['operationalHealth'];
        storage?: ControlStatusResult['storage'];
    };
    health: OperationalHealthFileInspection;
    journal: {
        status: 'missing' | 'present' | 'corrupt' | 'unavailable';
        sizeBytes?: number;
        walBytes?: number;
        integrity?: 'ok' | 'not-checked';
        reason?: string;
    };
    workspace: {
        status: 'available' | 'missing' | 'unavailable';
        writable?: boolean;
        reason?: string;
    };
    quarantine: {
        status: 'available' | 'missing' | 'unavailable';
        count: number;
        scannedCount: number;
        truncated: boolean;
        entries: Array<{
            nameHash: string;
            sizeBytes: number;
            modifiedAt: string;
        }>;
        reason?: string;
    };
    checks: DiagnosticCheck[];
}
export type OperationalHealthFixResult = {
    status: 'not-needed';
    reason: 'missing' | 'valid';
} | {
    status: 'quarantined';
    evidenceName: string;
    manifestName: string;
    sha256: string;
    sizeBytes: number;
};
// ==== @byok-sdk/client dist/index.d.ts ====
export type { RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeAdapterRejectedOperation, RuntimeAdapterPreparedOperation, PreparedRuntimeOperation, RuntimeOperationManifest, RuntimeOperationStartInput, RuntimeCapabilities, RuntimeDetectResult, RuntimeDetectionRefusalReason, RuntimeInstallationObservationContext, Session, GitWorkspaceConfig, McpLaunchBinding, McpLaunchCwdConfig, McpStdioServerConfig, McpToolsetConfig, McpToolsetLifecycleState, McpToolsetObservation, McpToolsetStatus, McpToolsetRegistryStatus, McpToolsetReloadReceipt, AgentEgressPolicy, LaunchCwdRejection, TrustedLaunchCwd, TrustedLaunchCwdUnavailableReason, } from './types';
export { resolveMcpLaunchCwdLauncher, resolveTrustedLaunchCwd } from './daemon/trusted-launch-cwd';
/**
 * The host install-record authority this SDK declares and never implements
 * (`daemon/tool-implementation-identity.ts`). A daemon constructed without one
 * resolves every tool implementation identity to `resolver_unconfigured`.
 *
 * `parseToolImplementationIdentity` is deliberately NOT exported: it is the
 * only function that turns a parsed value into an attested identity, and its
 * one caller is this package's own task-scoped configuration reader.
 */
export type { RuntimeEntryV1, RuntimeDescendantPolicyV1, RuntimeDescendantEdgeV1, RuntimeImplementationRecordV1, RuntimeImplementationResolutionV1, ToolImplementationAttestedV1, ToolImplementationAuthority, ToolImplementationIdentityV1, ToolImplementationInstallRecordV1, ToolImplementationInterpreterV1, ToolImplementationLocatorV1, ToolImplementationResolutionV1, ToolImplementationStatTupleV1, ToolImplementationUnavailableReasonV1, ToolImplementationUnavailableV1, } from '@byok-sdk/implementation-identity';
export { ToolImplementationReverifyError } from '@byok-sdk/implementation-identity';
export type { AgentRef } from './agent-home';
export { AgentHomeError, AgentRefValidationError, AgentHomeResolutionError, AgentHomeCollisionError, AgentHomeBusyError, AgentHomeLeaseCorruptError, AgentHomeLayout, AgentHomeLeaseManager, AgentHomeManager, createAgentHomeProjection, createAgentHomeProjectionConsumer, AGENT_HOME_PROJECTION_STATE_FILE, stableAgentHomeOwnerId, validateAgentRef, } from './agent-home';
export { AgentSessionHandoffStore, AgentSessionHandoffStoreError, AgentSessionHandoffCorruptError, AgentSessionHandoffMismatchError, } from './daemon/agent-session-handoff-store';
export type { AgentSessionHandoff, AgentSessionHandoffMatch, AgentTaskTerminalEvidence, AgentTaskTerminalMatch, AgentTerminalCause, } from './daemon/agent-session-handoff-store';
export type { AgentHomeResolution, AgentHomeProjection, AgentHomeProjectionInput, AgentHomeProjectionApplyInput, AgentHomeProjectionFunction, AgentHomeProjectionApplyFunction, AgentHomeLease, AgentHomeBinding, AgentHomeExecutionLease, AgentHomeExecutionBinding, AgentHomeExecutionStatus, } from './agent-home';
export { localStateRelocation, LocalStateRelocationError, LocalStateRelocationBusyError, LocalStateRelocationIntegrityError, } from './local-state-relocation';
export type { LocalStateRelocationInput, LocalStateRelocationLease, } from './local-state-relocation';
export { PolicyUnsupportedError, SteerUnsupportedError, freezeRuntimeAdapterDescriptor, sealRuntimeOperationManifest } from './types';
export type { RuntimeEnvironmentRequirements } from './daemon/environment';
export { resolveLocalAgentReleaseIdentity } from './release-identity';
export type { LocalAgentReleaseIdentity } from './release-identity';
export { BYOK_SDK_HELPER_SUBCOMMAND, resolveSdkReservedHelperBin, runSdkReservedHelperCommand, } from './sdk-reserved-helper-host';
export type { SdkHelperHostConfig, SdkReservedHelperKind, ResolvedSdkReservedHelperBin, } from './sdk-reserved-helper-host';
export { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeStartupDisposalFailure, RuntimeDisposalFailure, RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON, isRuntimeDisposalFailure, isRuntimeExecutionFailure, projectRuntimeBoundaryFailure, projectRuntimeExecutionFailure, } from './runtime-failure';
export type { RuntimeExecutionFailureInput, RuntimeDisposalFailureInput, RuntimeDisposalStage, RuntimeFailureCategory, RuntimeFailurePhase, RuntimeFailureProjection, RuntimeRetryDisposition, } from './runtime-failure';
export { GitWorkspaceManager, GitWorkspaceError, isGitWorkspaceConfig, prependGitWorkspaceGuidance } from './daemon/git-workspace';
export type { GitWorkspaceObservation, GitWorkspaceLease, GitWorkspaceOptions, GitErrorCategory } from './daemon/git-workspace';
export { GitWorkspaceStore } from './daemon/git-workspace-store';
export type { GitWorkspaceLedger, GitWorkspaceLedgerRecord, GitWorkspacePhase } from './daemon/git-workspace-store';
export { createDaemon, createDaemonWithAdapters } from './daemon/create-daemon';
export { LocalTeamWorkspace, LocalTeamWorkspaceService, TeamWorkspaceError, TeamWorkspaceValidationError, TeamWorkspaceNotFoundError, TeamWorkspaceConflictError, TeamWorkspaceQuotaError, TeamWorkspaceLeaseError, TeamWorkspaceReceiptError, TeamWorkspaceCorruptError, encodeTeamMemberContext, decodeTeamMemberContext, type TeamWorkspaceDefinition, type TeamWorkspaceLimits, type TeamMessage, type TeamMemberLease, type TeamWorkspaceMemberReceipt, } from './daemon/team-workspace';
export { openTeamTmuxView, TeamTmuxViewError, type OpenTeamTmuxViewInput } from './bin/team-tmux-view';
export type { Daemon, DaemonConfig, DaemonStatus, DaemonOverrides, DaemonBranding, HostedJournalConfig, DeviceAssertionConfig, InputPreparationDaemonConfig, AgentEgressConfig, AgentContentReadConfig, AgentContentReadSurfaceConfig, AgentReliableEgressInput, } from './daemon/create-daemon';
export { AgentMemoryError, AgentMemoryRevisionConflictError, isAgentMemorySecureFilesystemAvailable, AGENT_MEMORY_AUDIT_FILENAME, AGENT_MEMORY_OUTBOX_FILENAME, } from './daemon/agent-memory';
export type { AgentMemoryFilesystemHelperConfig } from './daemon/agent-memory-filesystem';
export type { AgentMemoryFile, AgentMemorySnapshot, AgentMemoryRedactor, AgentMemoryProjectionGrant, AgentMemoryProjectionPort, AgentMemoryHostedProjection, } from './daemon/agent-memory';
export type { AgentEgressDropReceipt, AgentEgressLaneStatus, AgentEgressStatus, } from './daemon/agent-egress-policy';
export type { AgentEgressSanitizer, AgentEgressSanitizerContext } from './daemon/agent-egress-sanitizer';
export { AGENT_CONTENT_READ_CAPABILITIES, AGENT_CONTENT_READ_CAPABILITY_WORKSPACE, AGENT_CONTENT_READ_CAPABILITY_TRANSCRIPT, AGENT_CONTENT_READ_CAPABILITY_ARTIFACT, } from './daemon/agent-content-read';
export type { AgentContentReadSurface, AgentContentReadDecision, AgentContentReadReason, AgentContentReadRoot, AgentContentReadPolicy, AgentContentReadPolicySelection, AgentContentReadRequest, AgentContentReadResult, AgentContentReadAllowed, AgentContentReadDenied, AgentContentSessionIdentity, AgentContentAuditReceipt, } from './daemon/agent-content-read';
export { McpToolsetRevisionConflictError, McpToolsetDefinitionRevisionConflictError, } from './daemon/toolset-registry';
export type { ProgressBatcherOptions } from './daemon/progress-batcher';
/**
 * Plan `device-assertion-broker`: the ONLY control-socket capability this
 * package exposes publicly. `connectControlClient`/`ControlClient` are
 * deliberately NOT exported and must never be — they also carry `shutdown`,
 * approval resolution and the raw task-event stream, and exporting the client
 * would make all of it public API in one line. See `daemon/assertion-client.ts`
 * and the constraint test that pins this.
 */
export { requestDeviceAssertion, requestTaskAssertion } from './daemon/assertion-client';
export type { RequestDeviceAssertionOptions, RequestDeviceAssertionResult, RequestDeviceAssertionErrorCode, RequestTaskAssertionOptions, RequestTaskAssertionResult, RequestTaskAssertionErrorCode, } from './daemon/assertion-client';
/**
 * Contract §8.1 / §8.2(1): the task lane's wire contract.
 *
 * `parseTaskAssertionIssueParams` is exported alongside the helper because it
 * IS the definition of what `task_assertion.issue` accepts — a host building
 * its own MCP child against this daemon needs the same strict shape the daemon
 * enforces, and a hand-rolled copy on the caller's side is how the two drift
 * apart. Nothing else about the control socket becomes public with it: this is
 * a pure function over a params value, not a way to reach the client.
 */
export { parseTaskAssertionIssueParams, TASK_ASSERTION_ISSUE_ERROR_CODES, TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES, } from './daemon/control-protocol';
export type { TaskAssertionIssueParams, TaskAssertionIssueResult, TaskAssertionIssueErrorCode, } from './daemon/control-protocol';
export type { OperationalHealthSnapshot, OperationalHealthState } from './daemon/operational-health';
/**
 * B-P2 local primitive (`docs/researches/runtime-input-preparation-contract.md`
 * §10.3 / §10.4): the task-free `input_preparation.*` control surface's public
 * contract.
 *
 * What becomes public here is the CONTRACT, not a way to reach the daemon:
 * the wire shapes a host must produce, the two seams it must supply (its local
 * device/Agent/Profile authority and its separately authorized counter), and
 * the required limits policy plus its validator. `connectControlClient` stays
 * unexported for the same reason it always has — see the assertion-client note
 * above.
 *
 * The three strict param parsers are exported alongside them because they ARE
 * the definition of what each method accepts. A host building its own caller
 * needs the same gate the daemon enforces; a hand-rolled copy is how the two
 * drift apart.
 */
export { INPUT_PREPARATION_ARTIFACT_FORMAT, INPUT_PREPARATION_ERROR_CODES, INPUT_PREPARATION_RECEIPT_FORMAT, INPUT_PREPARATION_RECORD_FORMAT, INPUT_PREPARATION_REQUEST_FORMAT, INPUT_PREPARATION_RETIRED_PROMPT_KEYS, INPUT_PREPARATION_RETIRED_REQUEST_KEYS, INPUT_PREPARATION_RETIRED_SNAPSHOT_KEYS, INPUT_PREPARATION_VERSION, InputPreparationPolicyError, validateInputPreparationLimits, } from './input-preparation';
export type { InputPreparationArtifactSummaryV1, InputPreparationAuthorityGrantV1, InputPreparationCompiledPromptSnapshotV1, InputPreparationCompiledSnapshotV1, InputPreparationAuthorityOutcomeV1, InputPreparationAuthorityResolver, InputPreparationSourceAuthorityRequestV1, InputPreparationSourceAuthorityOutcomeV1, InputPreparationBindingV1, InputPreparationCancelParamsV1, InputPreparationContextFileV1, InputPreparationCounterAdapter, InputPreparationCounterAuthorityV1, InputPreparationCounterEvidenceV1, InputPreparationCounterRequestV1, InputPreparationCounterResultV1, InputPreparationCounterTargetV1, InputPreparationCoverageProofV1, InputPreparationDenialReasonV1, InputPreparationDocsPathsV1, InputPreparationErrorCodeV1, InputPreparationHostCanonicalAssistantMessageV1, InputPreparationLimitsPolicyV1, InputPreparationLookupParamsV1, InputPreparationModelCostV1, InputPreparationMessageV1, InputPreparationModelV1, InputPreparationOptionsV1, InputPreparationPinV1, InputPreparationPromptSnapshotV1, InputPreparationReadinessReasonV1, InputPreparationReceiptV1, InputPreparationRequestV1, InputPreparationRuntimeIdentityV1, InputPreparationScopeClaimV1, InputPreparationSelectionV1, InputPreparationSkillV1, InputPreparationSnapshotV1, InputPreparationSourceV1, InputPreparationStateV1, InputPreparationToolV1, InputPreparationUserMessageV1, } from './input-preparation';
export { INPUT_PREPARATION_CANCEL_METHOD, INPUT_PREPARATION_IDENTIFIER_MAX_BYTES, INPUT_PREPARATION_LOOKUP_METHOD, INPUT_PREPARATION_PREPARE_METHOD, parseInputPreparationCancelParams, parseInputPreparationLookupParams, parseInputPreparationRequestParams, } from './daemon/control-protocol';
export type { InputPreparationResult } from './daemon/control-protocol';
export { journalHash, JournalUnavailableError, JournalCorruptError, JournalRecordTooLargeError, JournalUnknownTaskError, JournalClosedError, } from './daemon/journal/journal';
export type { LocalTaskJournal, JournalIdentity, JournalReceipt, ReceivedEnvelopeRecord, AdmissionRecord, LocalTransitionRecord, LocalTerminalRecord, TerminalTruthState, RecoverableTask, RecoveryOutcome, RecoveryDisposition, LocalStorageUsage, StorageCategory, CategoryUsage, CleanableCategory, CleanupCandidate, CleanupResult, CompactOptions, CompactResult, } from './daemon/journal/journal';
export { SqliteLocalTaskJournal, JOURNAL_DB_FILENAME, JOURNAL_QUARANTINE_DIRNAME } from './daemon/journal/sqlite-journal';
export type { SqliteLocalTaskJournalOptions } from './daemon/journal/sqlite-journal';
export { LocalStoragePressureEngine, LocalStoragePolicyError, LocalStorageEmergencyError, resolveLocalStoragePolicy, computePressureState, cleanupOrderFor, cleanupEligibleAt, createFilesystemCleanupExecutor, createStatfsFreeBytesProvider, JOURNAL_TASK_REF_PREFIX, DEFAULT_SOFT_BUDGET_RATIO, DEFAULT_HARD_BUDGET_RATIO, DEFAULT_ACK_CRITICAL_RESERVE_BYTES, DEFAULT_CLEANUP_BATCH_LIMIT, DEFAULT_INCREMENTAL_VACUUM_PAGES, DEFAULT_NORMAL_COMPACTION_INTERVAL_MS, DEFAULT_PRESSURE_COMPACTION_INTERVAL_MS, DEFAULT_RETENTION_MS, DEFAULT_LOG_ROTATION, } from './daemon/journal/storage-policy';
export type { LocalStoragePolicy, LocalStoragePolicyInput, LocalStoragePressureEngineOptions, LogRotationPolicy, CompactionPolicy, StoragePressureState, StoragePressureEvent, StorageMeasurement, StorageStatusSnapshot, StorageTickResult, CleanupExecutor, CleanupExecution, TimerLike, } from './daemon/journal/storage-policy';
export { readDeviceEnrollmentStatus } from './daemon/store';
export type { DeviceEnrollment, DeviceEnrollmentStatus, DeviceEnrollmentStatusOptions, } from './daemon/store';
/**
 * Plan `skill-pack-delivery-channel`: the device half of the `skills.pack`
 * channel. The install pipeline and the two read APIs are public because the
 * HOST, not this SDK, decides where a vendor CLI keeps its skills (K4) — a host
 * lists what is installed and projects the pack it wants into the directory its
 * own runtime reads. Nothing here ever writes to a vendor CLI's skill directory.
 */
export { SKILL_PACKS_CAPABILITY, SKILL_PACKS_DIRNAME, SKILL_PACK_AUDIT_FILENAME, SKILL_PACK_INSTALL_ERROR_CODES, SKILL_PACK_LOCK_FILENAME, SKILL_PACK_LOCK_SCHEMA, SKILL_PACK_RESPONSE_MAX_BYTES, SkillPackInstallError, installSkillPacks, listInstalledSkillPacks, projectSkillPack, skillPacksRoot, } from './daemon/skill-pack-installer';
export type { InstallSkillPacksOptions, InstalledSkillPack, ProjectedSkillPack, SkillPackInstallErrorCode, SkillPackInstallResult, SkillPackLock, } from './daemon/skill-pack-installer';
export { TruthMemoryClient, TruthMemoryClientError } from './daemon/truth-memory-client';
export type { LocalMemoryFilter, MemorySelector, TruthManifestQueryInput, TruthManifestRecord, TruthMemoryClientErrorCode, TruthMemoryClientOptions, TruthMemoryMetric, TruthSnapshotCandidateInput, TruthSnapshotWriteInput, TruthTerminalWriteInput, TruthWriteBody, TruthWriteResult, VerifiedTruthRecord, } from './daemon/truth-memory-client';
export type { ConnectionState } from './daemon/connection-manager';
export { ReplayCursorTooOldError } from './daemon/replay-cursor';
export { BlobClient, BlobRequestAbortedError } from './daemon/blob-client';
export type { BlobClientOptions, BlobRequestAbortReason, BlobRequestOptions, BlobResolver } from './daemon/blob-client';
export { DaemonObserver } from './daemon/observer';
export type { DaemonEvent, DaemonEventKind, DaemonEventListener, DaemonTaskInfo, Unsubscribe } from './daemon/observer';
export { createServiceLifecycle, UnsupportedServicePlatformError } from './lifecycle/create-service-lifecycle';
export type { CreateServiceLifecycleOptions } from './lifecycle/create-service-lifecycle';
export { nodeAgentProgram, sanitizeServiceName } from './lifecycle/service-types';
export type { NodeAgentProgramOptions, ServiceDefinition, ServiceInstallOptions, ServiceLifecycle, ServiceProgram, ServiceStatusResult, } from './lifecycle/service-types';
export { generateLaunchdPlist } from './lifecycle/launchd';
export { generateSystemdUnit } from './lifecycle/systemd';
export { generateWinswXml } from './lifecycle/winsw';
export { ensureSecureDir, buildIcaclsArgs, SecureDirHardeningError } from './util/secure-dir';
export type { EnsureSecureDirOptions } from './util/secure-dir';
export { PiAdapter } from './adapters/pi/pi-adapter';
export type { PiAdapterOptions, PiByokLauncherConfig } from './adapters/pi/pi-adapter';
export { PI_PACKAGE_NAME } from './adapters/pi/resolve-bin';
export { ClaudeAdapter } from './adapters/claude/claude-adapter';
export type { ClaudeAdapterOptions } from './adapters/claude/claude-adapter';
export { CodexAdapter, type CodexAdapterOptions } from './adapters/codex/codex-adapter';
export { diagnoseDevice, repairDeviceEnrollmentMetadata, DeviceMetadataRepairError } from './diagnostics/device-doctor';
export type { DiagnoseDeviceOptions, DiagnosticsSnapshot, DiagnosticCheck, DiagnosticStatus, RepairDeviceEnrollmentMetadataInput, DeviceMetadataRepairResult, DeviceMetadataRepairErrorCode, } from './diagnostics/device-doctor';
export { quarantineDeviceOperationalHealth, exportDeviceSupportBundle, archiveAgentTerminalMessages, DeviceOperatorError } from './diagnostics/operator-actions';
export type { ConfirmDeviceMaintenanceInput, DeviceHealthQuarantineResult, ExportDeviceSupportBundleInput, DeviceSupportBundleExportResult, ArchiveAgentTerminalMessagesInput, AgentTerminalMessagesArchiveResult, DeviceOperatorErrorCode } from './diagnostics/operator-actions';
// ==== @byok-sdk/client dist/input-preparation.d.ts ====
/**
 * B-P2 local primitive — public types for the task-free runtime input
 * preparation surface (`docs/researches/runtime-input-preparation-contract.md`
 * §10.3).
 *
 * This module is the ONE authority for the wire/receipt shapes the daemon's
 * `input_preparation.*` control methods speak. It deliberately imports nothing
 * from the native coding-agent package: the native envelope
 * (`PreparedSessionInputV3`) is an implementation fact owned by
 * `adapters/pi/input-preparation.ts`, and the only native-derived values that
 * ever cross this boundary are opaque digests, byte counts and the native
 * compiler's own structural projection contract, copied verbatim. A host
 * integrating against this surface therefore never has to resolve, or pin, the
 * native runtime's own type closure.
 *
 * What this surface is NOT, and must never quietly become:
 *
 * - It creates no task, claim, Execution, nonce or tool grant. Preparation is
 *   evidence about an input, not permission to run one (§10.3.1).
 * - A receipt reference and a digest prove CONTENT IDENTITY only. Neither is a
 *   bearer token: lookup and cancel are authorized by the same authenticated
 *   local scope that created the record, re-resolved on every call (§10.3.4).
 * - Pinning an artifact to a committed Execution is G3b. {@link
 *   InputPreparationPinV1} exists here only so that later binding is a field
 *   that was always reserved rather than a schema break; nothing in this
 *   package ever writes it.
 * - It states nothing of its own about token semantics. What P(D) covers is the
 *   native compiler's structural projection contract v3 — a {@link
 *   InputPreparationProjectionV1} and a classified {@link
 *   InputPreparationResidualKeyV1} list — copied verbatim off the envelope.
 *   Whether the residual keys are RULED is a Host accounting fact carried as
 *   {@link InputPreparationAccountingPolicyRefV1}; this package only checks
 *   applicability, never budget arithmetic.
 * - `ready` means "the preparation can be consumed": the artifact is intact and
 *   unexpired, its projection is content-complete, its residual keys are ruled
 *   by an applicable Host accounting policy, D is text only, and every
 *   executor identity is attested. A counter is OPTIONAL: when one is
 *   configured its evidence must be provider-authoritative and covered, and
 *   when none is configured no count is required at all — the size evidence is
 *   {@link InputPreparationArtifactSummaryV1.requestBytes}, the exact byte
 *   length of the frozen D. It is NOT Host budget admission: the window, the
 *   template constant and the fit ruling stay on the Host side of the
 *   accounting policy this surface only names.
 */
import { type PermissionMode } from '@byok-sdk/protocol';
import type { McpLaunchAttestation } from './daemon/trusted-launch-cwd';
import type { ToolImplementationIdentityV1 } from './daemon/tool-implementation-identity';
/** Wire format tag for a preparation request. One strict shape, one version. */
export declare const INPUT_PREPARATION_REQUEST_FORMAT = "byok.input-preparation.request";
/** Wire format tag for a preparation receipt. */
export declare const INPUT_PREPARATION_RECEIPT_FORMAT = "byok.input-preparation.receipt";
/** Durable record format tag — see `daemon/input-preparation-store.ts`. */
export declare const INPUT_PREPARATION_RECORD_FORMAT = "byok.input-preparation.record";
/** Durable artifact format tag — see `daemon/input-preparation-store.ts`. */
export declare const INPUT_PREPARATION_ARTIFACT_FORMAT = "byok.input-preparation.artifact";
/**
 * The single supported version of every shape in this module.
 *
 * Version 2 REMOVED caller-supplied `toolExecutors` and `snapshot.tools` from
 * the request and added `requiredToolsets` + `permissionMode`.
 *
 * Version 3 REMOVED the artifact summary's `coverage` string — a single opaque
 * label that said nothing checkable about what P(D) covers — and replaced it
 * with the native compiler's structural projection contract: {@link
 * InputPreparationArtifactSummaryV1.projection} and {@link
 * InputPreparationArtifactSummaryV1.residual}. The request and binding gained
 * {@link InputPreparationAccountingPolicyRefV1}, and counter evidence gained
 * {@link InputPreparationCounterProviderEvidenceV1}.
 *
 * Bumped to 4 by the 0.86 runtime rebase, which is a BREAKING wire change:
 * `prompt.formattedSkills` (a caller-rendered string) became
 * `prompt.skills` (the closed {@link InputPreparationSkillV1} set the native
 * renderer reads), `prompt.toolGuidelines` was added, `options.toolChoice`
 * narrowed to `auto | none`, and the projection contract moved to v3.
 *
 * Bumped to 5 by bounded admission, which is a BREAKING wire change: the
 * counter became optional, so the successful terminal state `counted` is now
 * `prepared` and the not-yet-terminal readiness reason `not_counted` is now
 * `not_prepared`; `counter_missing` is gone (no count is required — the size
 * evidence is `artifact.requestBytes`); counter results lost `kind`, whose
 * `bound` member no adapter could honestly state; and the readiness reason
 * `request_content_not_text` was added.
 *
 * Version 6 requires strict prepared egress. D and the fourteen admission
 * comparisons are unchanged; old artifacts are not read forward.
 *
 * The number itself is owned by `@byok-sdk/protocol`'s
 * `INPUT_PREPARATION_WIRE_VERSION`, because the device capability token
 * `agent-input-preparation-v<N>` is derived from it: the relay wire carries no
 * version field, so the token is what keeps a device and a cloud on different
 * versions from exchanging a preparation at all. One number, two projections.
 *
 * The request, receipt and retained artifact carry this number. The durable
 * record schema is versioned independently by INPUT_PREPARATION_RECORD_VERSION.
 * An artifact with an older wire version is refused rather than read through
 * a compatibility branch: its artifact was
 * frozen under a claim this version cannot re-derive, and there is no honest
 * value to translate a prompt rendered by another renderer into.
 */
export declare const INPUT_PREPARATION_VERSION: 6;
/**
 * Key-sorted JSON, so two structurally equal values always produce the same
 * bytes and therefore the same digest. Field ORDER must never be able to turn
 * one request into two idempotency keys, or one observed tool surface into two
 * observation digests.
 *
 * It lives beside the shapes it serializes rather than beside either of its
 * callers: `daemon/input-preparation-service.ts` digests the request with it
 * and `daemon/prepared-tool-surface.ts` digests the observed surface with it,
 * and two copies of a canonicalization are two canonicalizations.
 */
export declare function canonicalInputPreparationJson(value: unknown): string;
/** sha256 hex of one canonicalized value. The one digest spelling this surface uses. */
export declare function inputPreparationDigest(value: unknown): string;
/**
 * The scope values a caller CLAIMS. Every one of them is validated against the
 * configured {@link InputPreparationAuthorityResolver}'s trusted local records
 * before anything is compiled, stored or counted — HMAC possession proves only
 * that the caller is a local device operator, never that it owns this device
 * row, this Agent or this profile (§10.1's P1).
 */
export interface InputPreparationScopeClaimV1 {
    readonly deviceId: string;
    readonly agentRef: string;
    readonly profileId: string;
    readonly profileRevision: string;
}
/**
 * The canonical source snapshot this input was assembled from. The SDK does not
 * interpret either value: they are Host authority, carried so the receipt binds
 * the exact revision/digest a later consumer must re-present.
 */
export interface InputPreparationSourceV1 {
    readonly revision: string;
    readonly digest: string;
}
/**
 * The complete thinking-level -> effort mapping the launched model declares.
 *
 * All seven levels are present; `null` is the declaration that a level is
 * unsupported, which is a different fact from the level being missing.
 */
export interface InputPreparationThinkingLevelMapV1 {
    readonly off: string | null;
    readonly minimal: string | null;
    readonly low: string | null;
    readonly medium: string | null;
    readonly high: string | null;
    readonly xhigh: string | null;
    readonly max: string | null;
}
/**
 * The declared request-body compatibility of the launched model. Every member
 * is optional and none is ever defaulted: an absent flag means the
 * configuration declared none, and the native compiler owns what that means.
 */
export interface InputPreparationModelCompatV1 {
    readonly supportsStore?: boolean;
    readonly supportsDeveloperRole?: boolean;
    readonly supportsReasoningEffort?: boolean;
    readonly supportsUsageInStreaming?: boolean;
    readonly maxTokensField?: 'max_completion_tokens' | 'max_tokens';
    readonly thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling';
    readonly zaiToolStream?: boolean;
}
/**
 * The exact model identity the request is compiled for.
 *
 * `thinkingLevelMap` and `compat` are the body-affecting declarations the
 * launched model entry carries. They are optional because a configuration may
 * declare neither; absent stays absent on every carrier in this package, since
 * a model that gained a field on the way through would no longer equal the
 * session model the native verifier compares it to.
 */
export interface InputPreparationModelV1 {
    readonly id: string;
    readonly name: string;
    /** The only API this first support set compiles. Anything else rejects. */
    readonly api: 'openai-completions';
    readonly provider: string;
    readonly baseUrl: string;
    readonly reasoning: boolean;
    readonly input: readonly ('text' | 'image')[];
    readonly cost: InputPreparationModelCostV1;
    readonly contextWindow: number;
    readonly maxTokens: number;
    readonly thinkingLevelMap?: InputPreparationThinkingLevelMapV1;
    readonly compat?: InputPreparationModelCompatV1;
}
export interface InputPreparationModelCostV1 {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
}
/** Body-affecting options, frozen into D. Transport options are not on this wire. */
export interface InputPreparationOptionsV1 {
    readonly cacheRetention: 'none' | 'short' | 'long';
    readonly maxTokens: number;
    readonly temperature?: number;
    /**
     * Only the two plain string forms the native prepared boundary compiles. An
     * object tool choice is unsupported, and `required` is refused: the boundary
     * compiles through the simple stream path, which cannot express it.
     */
    readonly toolChoice?: 'auto' | 'none';
    /**
     * The requested thinking level. The native compiler maps it through the
     * launched model's own level map and clamps it exactly as the live session
     * does, so this value is never what reaches the body verbatim.
     */
    readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
export interface InputPreparationSelectionV1 {
    readonly model: InputPreparationModelV1;
    readonly options: InputPreparationOptionsV1;
}
/**
 * What the native compiler proved about ONE top-level key of D that lies
 * outside P(D).
 *
 * These classes describe STRUCTURE and nothing else. No class states, implies
 * or denies that a key influences a provider's token count — that is an
 * external accounting fact the compiler cannot prove and never asserts, and it
 * is precisely why this SDK re-derives nothing from them and routes the
 * question to a Host-authored {@link InputPreparationAccountingPolicyRefV1}
 * instead.
 *
 * The set is the native compiler's, copied verbatim. Widening it is a
 * registration against a new fork, not a parser relaxation: a value outside
 * this set is refused rather than carried through as an unclassified key.
 */
export type InputPreparationResidualValueClassV1 = 'constant' | 'boolean' | 'bounded_integer' | 'bounded_number' | 'finite_number' | 'closed_enum' | 'nonempty_string' | 'object_shape';
/** One residual key of D, with the only thing the native compiler proves about it: its shape. */
export interface InputPreparationResidualKeyV1 {
    readonly key: string;
    readonly valueClass: InputPreparationResidualValueClassV1;
}
/**
 * What the native compiler proves about P(D), copied verbatim off the envelope.
 *
 * `content_complete` — every context-derived byte of D is byte-identically
 * inside P(D), and every remaining top-level key of D was classified by the
 * compiler-owned table. `unknown` — D carries a key the table does not
 * classify, or a classified key whose value does not match its declared shape;
 * the compiler fails closed, claims nothing, and leaves `residual` empty.
 *
 * `digest` is SHA-256 over the exact `counterProjection` bytes. The SDK may
 * recompute it and refuse on mismatch; it never recomputes the KIND, because
 * the classification table belongs to the compiler and a second local copy of
 * it would be a shadow parser for the same semantic fact.
 */
export interface InputPreparationProjectionV1 {
    readonly version: 3;
    readonly kind: 'content_complete' | 'unknown';
    /** SHA-256 hex over the exact counted-projection bytes. */
    readonly digest: string;
}
/**
 * The Host's ruling about which residual keys its accounting already accounts
 * for, named on the request and recorded on the binding.
 *
 * It is HOST AUTHORITY, carried verbatim. This SDK performs exactly one check
 * against it — APPLICABILITY — and never any budget arithmetic:
 *
 * - every residual key the artifact carries must appear in `ruledResidualKeys`
 *   (otherwise {@link InputPreparationReadinessReasonV1} `residual_not_ruled`);
 * - `ruledRuntime` must equal this preparation's own runtime identity string,
 *   and `ruledTarget` must equal the counted target, or the ruling is about a
 *   different compiler or a different endpoint/model and does not apply here
 *   (`accounting_policy_inapplicable`).
 *
 * There is no default. A request that names none leaves the receipt carrying
 * `accounting_policy_missing`, because "nobody ruled on these keys" and "every
 * key is ruled" are different facts and only one of them is safe.
 */
export interface InputPreparationAccountingPolicyRefV1 {
    /** Opaque Host-assigned revision of the accounting ruling. Never interpreted here. */
    readonly revision: string;
    /** The runtime identity string this ruling was made for — {@link inputPreparationRuntimeIdentityString}. */
    readonly ruledRuntime: string;
    /** The endpoint/model this ruling was made for. */
    readonly ruledTarget: InputPreparationCounterTargetV1;
    /** Every residual key the Host's accounting already accounts for. */
    readonly ruledResidualKeys: readonly string[];
}
/** One authorized context file, exactly as the caller resolved it. Never read from disk here. */
export interface InputPreparationContextFileV1 {
    readonly path: string;
    readonly content: string;
}
/**
 * The three documentation locations the native prompt renderer names.
 *
 * These field names are this surface's own contract and deliberately do not
 * track the native runtime's parameter names; `adapters/pi/input-preparation.ts`
 * maps them onto whatever the pinned runtime calls them.
 */
export interface InputPreparationDocsPathsV1 {
    readonly readmePath: string;
    readonly docsPath: string;
    readonly examplesPath: string;
}
/**
 * One skill the native system prompt renders.
 *
 * Exactly the fields the renderer reads, and nothing else. A caller-supplied
 * PREFORMATTED skills block would be a second renderer of the same prompt
 * region, free to drift from what a live session emits; loader bookkeeping the
 * renderer never reads is absent because the caller cannot know it and this
 * SDK must not invent it.
 */
export interface InputPreparationSkillV1 {
    readonly name: string;
    readonly description: string;
    readonly filePath: string;
    readonly disableModelInvocation: boolean;
}
/**
 * Explicit, already-authorized inputs for the native system prompt renderer.
 *
 * `selectedTools` is deliberately NOT here. The native contract requires it to
 * equal the model-visible manifest exactly, and this version moved that
 * manifest onto the device — so a caller stating the list would be stating the
 * manifest through the prompt. The daemon fills it from the assembled surface
 * (see {@link InputPreparationCompiledPromptSnapshotV1}).
 *
 * `toolSnippets` and `toolGuidelines` stay caller-authored because both are
 * prompt TEXT, but their keys must name tools the assembled manifest actually
 * contains; the native compiler refuses either for a tool that is not in the
 * manifest, and nothing here papers over that.
 */
export interface InputPreparationPromptSnapshotV1 {
    readonly customPrompt?: string;
    readonly appendSystemPrompt?: string;
    readonly cwd: string;
    readonly toolSnippets: Readonly<Record<string, string>>;
    /** Guideline bullets each tool contributes, keyed by tool name. */
    readonly toolGuidelines: Readonly<Record<string, readonly string[]>>;
    readonly promptGuidelines: readonly string[];
    readonly contextFiles: readonly InputPreparationContextFileV1[];
    /** The skills the prompt renders. Empty means no skills. */
    readonly skills: readonly InputPreparationSkillV1[];
    readonly docsPaths: InputPreparationDocsPathsV1;
}
/** The caller's prompt snapshot plus the tool-name list the daemon derived. */
export interface InputPreparationCompiledPromptSnapshotV1 extends InputPreparationPromptSnapshotV1 {
    /** Exactly the assembled manifest's tool names, in its canonical order. */
    readonly selectedTools: readonly string[];
}
/**
 * One model-visible user message.
 *
 * Text-only. Multimodal content and any extra field are NOT accepted and are
 * NOT inferred: they reject as `unsupported_input` (§10.3.2 — unknown input
 * rejects rather than filling gaps).
 */
export interface InputPreparationUserMessageV1 {
    readonly role: 'user';
    readonly content: string;
    readonly timestamp: number;
}
/**
 * One host-canonical assistant text message.
 *
 * A DIFFERENT fact from a provider-generated assistant turn, and the two are
 * never interchanged: the host asserts this text was already said, and no
 * provider generated it here. It therefore carries no `api`, `provider`,
 * `model`, `usage` or `stopReason`, and none of those may be fabricated for it
 * — a preparation that invented provenance would be counting a turn nobody
 * produced. The native contract makes `origin` the discriminant, and a present
 * key rather than a value: an assistant message without it is a provenance
 * claim this surface cannot check, so it rejects as `unsupported_input`.
 */
export interface InputPreparationHostCanonicalAssistantMessageV1 {
    readonly role: 'assistant';
    readonly origin: 'host_canonical';
    /** Text. The native shape is a text-block array; the conversion is the compiler's. */
    readonly content: string;
    readonly timestamp: number;
}
/**
 * One model-visible message a CALLER may state.
 *
 * The support set is text-only user history, host-canonical assistant text
 * history, and the current user message. Provider-generated assistant turns,
 * tool-result history, multimodal content and custom message kinds are not
 * accepted and are not inferred. Extending the set is a REGISTRATION — a new
 * member here, in the wire schema and in both validators — never a parser
 * relaxation.
 *
 * Host-canonical assistant text counts toward input tokens exactly like user
 * text: nothing on any limit or counting path special-cases it.
 */
export type InputPreparationMessageV1 = InputPreparationUserMessageV1 | InputPreparationHostCanonicalAssistantMessageV1;
/**
 * One complete model-visible tool schema. `parameters` is the full JSON schema
 * the model sees; a partial or elided schema is not accepted, because the whole
 * point of this surface is counting what the provider will actually be sent.
 *
 * This is the WHOLE model-visible declaration, not a summary of one: the native
 * compiler's own tool projection is what crosses into the compile, so every
 * field here reaches the request body. `constrainedSampling` is part of that
 * declaration on the pinned runtime — it becomes `tools[].strict` on the wire —
 * so it is carried rather than stripped. It is a DEVICE observation like the
 * rest of this shape: it comes off the real tool definition the daemon
 * assembled, never off a Host statement, and it is absent when the definition
 * declares none. The two refused native forms (`strict: "require"` and
 * `type: "grammar"`) are not in the type: the prepared boundary refuses both,
 * so a value this SDK cannot compile cannot be constructed here either.
 */
export interface InputPreparationToolV1 {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly constrainedSampling?: false | {
        readonly type: 'json_schema';
        readonly strict: 'prefer';
    };
}
/**
 * The authorized input snapshot a CALLER states: prompt text and user history,
 * and nothing else.
 *
 * `tools` is deliberately absent. The model-visible tool schemas are a LOCAL
 * observation — only this device can say which MCP toolset servers it has and
 * what they publish — so they are assembled by
 * `daemon/prepared-tool-surface.ts` from the request's `requiredToolsets` and
 * joined onto this snapshot inside the daemon. A caller that could state a
 * tool schema could have tokens counted for a tool no server offers.
 */
export interface InputPreparationSnapshotV1 {
    readonly prompt: InputPreparationPromptSnapshotV1;
    readonly messages: readonly InputPreparationMessageV1[];
}
/**
 * What the native compiler is actually handed: the caller's snapshot plus the
 * daemon-derived tool manifest. Produced only inside the daemon, never parsed
 * off a wire.
 */
export interface InputPreparationCompiledSnapshotV1 extends Omit<InputPreparationSnapshotV1, 'prompt'> {
    readonly prompt: InputPreparationCompiledPromptSnapshotV1;
    readonly tools: readonly InputPreparationToolV1[];
}
/**
 * One preparation request (§10.3.1).
 *
 * `requestId` is the caller's own preparation identity and is deliberately NOT
 * a task id: it namespaces idempotency together with the AUTHENTICATED scope
 * and Agent, so a caller cannot reach another scope's record by guessing one.
 *
 * `requiredToolsets` is the ONLY thing a caller says about tools: which of
 * this device's configured MCP toolsets the preparation needs, by id. The
 * daemon resolves them against its own registry, observes the servers itself,
 * and derives both the model-visible schemas and the executor fingerprints
 * from what those servers reported. There is no `toolExecutors` field and no
 * `snapshot.tools` field, and their absence is the contract: a caller that
 * could state either could have tokens counted against a manifest this device
 * never observed.
 *
 * `permissionMode` is DECLARED, never inferred. A preparation counts one
 * concrete manifest, and the manifest is the policy-filtered set for exactly
 * one mode (`mcp/projection.ts`'s `filterMcpObservationForPolicy`). The daemon
 * validates the value and pins it onto the binding; it grants nothing.
 *
 * There is no `runtimeIdentity`, `compilerVersion` or `policyIdentity` field:
 * those are derived from the verified installed artifact closure and the
 * daemon's own configured policy, never from caller text.
 */
export interface InputPreparationRequestV1 {
    readonly format: typeof INPUT_PREPARATION_REQUEST_FORMAT;
    readonly version: typeof INPUT_PREPARATION_VERSION;
    readonly requestId: string;
    /** Must equal the daemon's configured {@link InputPreparationLimitsPolicyV1.revision} exactly. */
    readonly policyRevision: string;
    readonly scope: InputPreparationScopeClaimV1;
    readonly source: InputPreparationSourceV1;
    readonly selection: InputPreparationSelectionV1;
    /** The mode the counted manifest is filtered for. */
    readonly permissionMode: PermissionMode;
    /** Configured MCP toolset ids. The locator is the toolset id; MCP only. */
    readonly requiredToolsets: readonly string[];
    readonly snapshot: InputPreparationSnapshotV1;
    /**
     * The Host's accounting ruling for this preparation, carried verbatim onto
     * the binding. Optional on the wire and defaulted NOWHERE: a request that
     * omits it produces a receipt that says so.
     */
    readonly accountingPolicyRef?: InputPreparationAccountingPolicyRefV1;
}
/**
 * The request keys this contract RETIRED in version 2, named so a daemon can
 * refuse them by name instead of answering a generic shape error.
 *
 * A caller still sending either is not sending a slightly wrong request — it
 * is asserting authority over the tool manifest that this version moved to the
 * device, so it is refused as `unsupported_input` and told which key.
 */
export declare const INPUT_PREPARATION_RETIRED_REQUEST_KEYS: readonly ['toolExecutors'];
/** The snapshot keys retired in version 2. Same rule, one level down. */
export declare const INPUT_PREPARATION_RETIRED_SNAPSHOT_KEYS: readonly ['tools'];
/**
 * The prompt-snapshot keys retired in version 2. `selectedTools` must equal the
 * model-visible manifest exactly by native contract, so stating it is stating
 * the manifest through the prompt.
 */
export declare const INPUT_PREPARATION_RETIRED_PROMPT_KEYS: readonly ['selectedTools'];
/** Params for `input_preparation.lookup` and `input_preparation.cancel`. */
export interface InputPreparationLookupParamsV1 {
    readonly requestId: string;
    readonly scope: InputPreparationScopeClaimV1;
}
/**
 * Cancel takes no free-text reason on purpose: the durable record answers with
 * a stable code, and an accepted-but-unused field is how a caller comes to
 * believe it can annotate authority-owned state.
 */
export interface InputPreparationCancelParamsV1 {
    readonly requestId: string;
    readonly scope: InputPreparationScopeClaimV1;
}
/**
 * Required byte / call / deadline / retention policy (§10.3.6 and the
 * Owner-approved limits boundary of 2026-09-14).
 *
 * Every field is REQUIRED and this package supplies no default for any of them.
 * No numeric value here is an S0 value; a fixture number in a test is a fixture
 * number. A daemon with no `inputPreparation` section keeps the whole feature
 * disabled and answers `input_preparation_unconfigured`; a daemon configured
 * with an INVALID policy fails at construction rather than starting with an
 * allowance nobody validated.
 */
export interface InputPreparationLimitsPolicyV1 {
    /** Opaque operator-assigned revision. A request must present this exact string. */
    readonly revision: string;
    /** Maximum normalized request bytes accepted from one caller. */
    readonly maxRequestBytes: number;
    /** Maximum bytes of one retained artifact (D plus P(D) plus envelope). */
    readonly maxArtifactBytes: number;
    /** Maximum retained artifact bytes summed across one authenticated scope. */
    readonly maxScopeAggregateBytes: number;
    /** Maximum preparations in flight across the daemon at one instant. */
    readonly maxInFlight: number;
    /**
     * Maximum counter invocations one authenticated scope may consume, ever,
     * within retention. Consumed only by a configured counter; a daemon without
     * one never reserves against it.
     */
    readonly maxCounterCallsPerScope: number;
    /** Bound on one counter invocation. */
    readonly counterTimeoutMs: number;
    /** Bound on one whole preparation, counter included. */
    readonly preparationDeadlineMs: number;
    /** How long a prepared artifact stays readable. */
    readonly retentionMs: number;
    /** How long the record tombstone outlives its artifact, so an expired key never reads as fresh. */
    readonly retryHorizonMs: number;
}
/** Thrown by {@link validateInputPreparationLimits} — a configuration fault, never a request fault. */
export declare class InputPreparationPolicyError extends Error {
    constructor(message: string);
}
/**
 * Validate a limits policy and return a frozen private copy.
 *
 * Fails closed on anything that is not a finite positive safe integer, on a
 * missing or empty revision, on an unknown field, and on the three relations
 * that would otherwise let one bound silently defeat another:
 *
 * - `counterTimeoutMs <= preparationDeadlineMs` — a counter bound larger than
 *   the whole preparation's bound is not a bound.
 * - `preparationDeadlineMs <= retentionMs` — an artifact that expires before
 *   its own preparation can finish is a guaranteed false negative.
 * - `maxArtifactBytes <= maxScopeAggregateBytes` — a per-artifact allowance
 *   above the per-scope total makes the aggregate unreachable.
 */
export declare function validateInputPreparationLimits(value: unknown): InputPreparationLimitsPolicyV1;
/** Why a resolver refused. Never echoed back with the trusted values it compared against. */
export type InputPreparationDenialReasonV1 = 'unknown_device' | 'unknown_agent' | 'unknown_profile' | 'profile_revision_drift' | 'disclosure_denied';
/** The trusted local record a resolver answers with. */
export interface InputPreparationAuthorityGrantV1 {
    /**
     * Stable identifier for the authenticated local scope this grant belongs to.
     * It is the first component of the durable idempotency namespace, so two
     * different scopes can never collide on one `requestId`.
     */
    readonly scopeId: string;
    readonly deviceId: string;
    readonly agentRef: string;
    readonly profileId: string;
    readonly profileRevision: string;
}
export type InputPreparationAuthorityOutcomeV1 = {
    readonly authorized: true;
    readonly grant: InputPreparationAuthorityGrantV1;
} | {
    readonly authorized: false;
    readonly reason: InputPreparationDenialReasonV1;
};
/** A trusted Host decision binding the exact source pair to the supplied snapshot. */
export type InputPreparationSourceAuthorityOutcomeV1 = {
    readonly authorized: true;
    readonly source: InputPreparationSourceV1;
} | {
    readonly authorized: false;
    readonly reason: InputPreparationDenialReasonV1;
};
export interface InputPreparationSourceAuthorityRequestV1 {
    readonly grant: InputPreparationAuthorityGrantV1;
    readonly source: InputPreparationSourceV1;
    readonly snapshot: InputPreparationSnapshotV1;
}
/**
 * The configured local authority. It owns the device/Agent/Profile records this
 * daemon trusts and decides whether the claimed scope may be disclosed at all.
 *
 * A REJECTED promise means the authority is unavailable, which is a refusal —
 * never a reason to proceed on the caller's claim (§10.3.1). The service also
 * re-checks that the returned grant actually matches the claim, so a resolver
 * that answers with a different device/Agent/profile than the one asked about
 * cannot launder an identity through this seam.
 */
export interface InputPreparationAuthorityResolver {
    resolveScope(claim: InputPreparationScopeClaimV1): Promise<InputPreparationAuthorityOutcomeV1>;
    /** Independently verify source and snapshot under the already verified scope grant. */
    resolveSource(request: InputPreparationSourceAuthorityRequestV1): Promise<InputPreparationSourceAuthorityOutcomeV1>;
}
/**
 * The exact INFERENCE target one counter call is bound to.
 *
 * `endpoint` is the inference target identity — the `selection.model.baseUrl`
 * this preparation would be executed against — and NOT the URL of the
 * counting/tokenizer HTTP call the adapter placed. The two are separate facts:
 * a counter adapter may count over a tokenizer route, a sibling host, or an
 * offline tokenizer, and this field says nothing about which. Whether the
 * counting route is equivalent to the inference route for accounting purposes
 * is UNPROVEN here and is external evidence work; the SDK asserts only that a
 * count is bound to the inference identity it was taken for.
 */
export interface InputPreparationCounterTargetV1 {
    /** The inference target identity (`selection.model.baseUrl`). Not the counting call's URL. */
    readonly endpoint: string;
    readonly modelId: string;
}
/**
 * Everything a counter adapter is given, and nothing else: the bound counted
 * projection P(D), the exact target, and an explicit call policy. No D, no
 * credentials, no scope identity, no request body, no filesystem handle.
 */
export interface InputPreparationCounterRequestV1 {
    readonly counterProjection: string;
    readonly target: InputPreparationCounterTargetV1;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
}
/**
 * Whether the counted projection covered the whole request.
 *
 * `covered: false` with a `reason` is a legitimate, useful answer — it is what
 * keeps a receipt honestly not-ready instead of admitting an Execution on a
 * partial count.
 */
export interface InputPreparationCoverageProofV1 {
    readonly covered: boolean;
    readonly reason?: string;
}
/**
 * The authority behind a count.
 *
 * `test_fixture` is a first-class value, not a debug flag: a fixture result can
 * never produce a `ready` receipt, which is what stops an offline suite from
 * ever looking like production accounting evidence (§10.3.3).
 */
export type InputPreparationCounterAuthorityV1 = 'provider' | 'test_fixture';
/**
 * What the provider side of a count asserted, and which exact projection it
 * was asserted about.
 *
 * Required on every result, fixture included. A number without the identity of
 * the bytes it was taken over is not evidence: the service compares
 * `projectionDigest` against the artifact's own
 * {@link InputPreparationProjectionV1.digest} and `endpoint`/`modelId` against
 * the counted target, and a missing or mismatched one refuses the count as
 * `counter_unavailable` rather than persisting a number bound to nothing.
 *
 * `asserted` is the provider's own answer, verbatim: the HTTP status it
 * returned, the usage fields it reported, and a digest of the response those
 * came from. The SDK stores it and compares nothing inside it — re-deriving a
 * usage number locally is the shadow accounting this whole surface exists to
 * avoid.
 *
 * It carries no O (output) or W (whole-request) field, deliberately. The Host
 * holds its own request, and `binding.requestDigest` is what ties this evidence
 * to it.
 *
 * `endpoint` here is the INFERENCE target identity (`selection.model.baseUrl`)
 * the count is bound to — never the URL of the counting/tokenizer HTTP call.
 * Nothing in this SDK proves the counting route and the inference route are
 * equivalent; establishing that is external evidence work.
 *
 * `method` and `methodVersion` are recorded as SIBLINGS on
 * {@link InputPreparationCounterEvidenceV1}, deliberately NOT bound into this
 * providerEvidence object. They are co-recorded, not asserted-about: the
 * digest/target comparison covers `projectionDigest` and `endpoint`/`modelId`
 * only. Binding the counting-method identity into providerEvidence would be a
 * WIRE-SHAPE change and requires an Owner ruling, so it is not done here.
 */
export interface InputPreparationCounterProviderEvidenceV1 {
    /** SHA-256 hex of the exact counted projection this count was taken over. */
    readonly projectionDigest: string;
    /**
     * The INFERENCE target identity this count is bound to — the same
     * `selection.model.baseUrl` carried by {@link InputPreparationCounterTargetV1},
     * NOT the URL of the counting/tokenizer HTTP call that produced `asserted`.
     * The service compares it against the counted target and nothing else.
     */
    readonly endpoint: string;
    readonly modelId: string;
    readonly asserted: {
        readonly httpStatus: number;
        /** The usage fields the provider reported, verbatim. Never re-derived here. */
        readonly usageFields: Readonly<Record<string, number>>;
        /** Digest of the provider response the usage fields were read from. */
        readonly responseDigest: string;
    };
}
export interface InputPreparationCounterResultV1 {
    /** Counting method identity, e.g. the provider tokenizer route. */
    readonly method: string;
    readonly methodVersion: string;
    readonly authority: InputPreparationCounterAuthorityV1;
    /** The provider's count over P(D). An optional tightener, never the size evidence. */
    readonly value: number;
    readonly coverage: InputPreparationCoverageProofV1;
    /** What the provider asserted, and the projection identity it asserted it about. */
    readonly providerEvidence: InputPreparationCounterProviderEvidenceV1;
}
/**
 * The separately authorized, OPTIONAL counter. Exactly one method, and it
 * performs no live call in B-P2 tests.
 *
 * A daemon without one still prepares: it compiles, persists and can reach
 * ready with no counter call and no `maxCounterCallsPerScope` reservation
 * consumed, because the size evidence is `artifact.requestBytes`, measured by
 * the daemon's own compiler. A configured counter is a tightener whose
 * evidence must itself be provider-authoritative and covered, or the receipt
 * stays unready.
 *
 * There is deliberately no fallback implementation anywhere in this package: no
 * `chars/4`, no heuristic padding, no reuse of a count taken from a different
 * projection, and no numeric budget, window or template constant. Those are
 * Host authority.
 */
export interface InputPreparationCounterAdapter {
    count(request: InputPreparationCounterRequestV1): Promise<InputPreparationCounterResultV1>;
}
/** Persisted counter evidence, exactly as the adapter reported it. */
export interface InputPreparationCounterEvidenceV1 extends InputPreparationCounterResultV1 {
    readonly target: InputPreparationCounterTargetV1;
    readonly calledAt: string;
    readonly completedAt: string;
}
/**
 * The runtime and compiler identity behind one artifact, derived from the
 * VERIFIED installed package closure — the manifest name/version actually on
 * disk plus the fork provenance it records — and never from a caller-supplied
 * label (§10.3.1).
 */
export interface InputPreparationRuntimeIdentityV1 {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly upstreamBase: string;
    readonly upstreamCommit: string;
    readonly forkBuild: number;
    /** The native envelope format tag this compiler produced. */
    readonly envelopeFormat: string;
    /** The native provider-request format tag this compiler produced. */
    readonly requestFormat: string;
    readonly compilerVersion: number;
}
/**
 * The ONE spelling of a runtime identity string.
 *
 * It binds every artifact through `CompilePreparedInputRequest.binding` and it
 * binds every tool-executor fingerprint. Those two must agree exactly, so the
 * formula lives here rather than being written out at each site — beside the
 * identity shape itself, so the prepared LAUNCH entry can re-derive the same
 * string without importing the preparation service.
 */
export declare function inputPreparationRuntimeIdentityString(runtime: InputPreparationRuntimeIdentityV1): string;
/**
 * Everything a receipt discloses about the stored artifact: identities, sizes
 * and the native compiler's structural projection contract. Never D itself,
 * never P(D), never the snapshot — a scoped reference plus a digest is content
 * identity, not a disclosure channel.
 */
export interface InputPreparationArtifactSummaryV1 {
    /** Digest of the low-level provider request D. */
    readonly requestDigest: string;
    /** Digest of the whole native envelope (snapshot, context, request, manifest). */
    readonly envelopeDigest: string;
    readonly toolManifestDigest: string;
    /**
     * The exact UTF-8 byte length of D, measured by this daemon's own compiler.
     * The one size evidence a receipt carries: the Host rules its budget against
     * it. There is no second byte-bound field and no token estimate here.
     */
    readonly requestBytes: number;
    readonly projectionBytes: number;
    /**
     * What the native compiler proved about P(D), copied verbatim. The SDK
     * re-derives no part of it except the digest, which it recomputes over the
     * envelope's own counted-projection bytes and refuses on mismatch.
     */
    readonly projection: InputPreparationProjectionV1;
    /**
     * Every top-level key of D outside P(D), classified by the compiler-owned
     * table and copied verbatim. Empty when {@link InputPreparationProjectionV1.kind}
     * is `unknown`, because the compiler claims nothing in that case.
     */
    readonly residual: readonly InputPreparationResidualKeyV1[];
    /**
     * Digest of everything the device OBSERVED for this preparation — the
     * projected tools, their executor fingerprints, the launch attestation and
     * the implementation identities. A later consumer re-observes and compares
     * this one value rather than re-deriving a manifest.
     */
    readonly observationDigest: string;
    /**
     * Digest of the subset of those facts that can be re-derived WITHOUT
     * spawning a server: the launch attestation, the toolset definition
     * revisions, the configured argv and the implementation identities. This is
     * what a replay of an already-recorded `requestId` compares against, because
     * re-probing to detect drift would create the second executor fact the
     * idempotency key exists to prevent.
     */
    readonly toolBindingDigest: string;
    /**
     * Per model-visible tool name: `attested`, or `unavailable:<reason>`. The
     * evidence behind `executor_identity_unproven`, so a reader is not asked to
     * take that readiness reason on trust.
     */
    readonly toolImplementationKinds: Readonly<Record<string, string>>;
}
/** The immutable binding a receipt carries and a later consumer must re-present. */
export interface InputPreparationBindingV1 {
    readonly scopeId: string;
    readonly deviceId: string;
    readonly agentRef: string;
    readonly profileId: string;
    readonly profileRevision: string;
    readonly source: InputPreparationSourceV1;
    readonly target: InputPreparationCounterTargetV1;
    readonly policyRevision: string;
    /**
     * The mode the counted manifest was filtered for, recorded so a consumer can
     * COMPARE it without re-deriving the request digest: an Execution offered
     * under a different mode registers a different tool set than the one these
     * tokens were counted for.
     */
    readonly permissionMode: PermissionMode;
    readonly runtime: InputPreparationRuntimeIdentityV1;
    /** Digest over the whole normalized request, scope and runtime identity. */
    readonly requestDigest: string;
    /**
     * The Host's accounting ruling this preparation was requested under, copied
     * verbatim from the request. Absent when the request named none — never
     * filled in, and never narrowed to one this device would have chosen.
     */
    readonly accountingPolicyRef?: InputPreparationAccountingPolicyRefV1;
}
/**
 * The committed Execution one counted preparation is bound to (§10.3.7).
 *
 * Written exactly once per record, by `InputPreparationStore.pin`, through a
 * compare-and-set inside the store's own serialized closure. It is the record's
 * single-consumer proof: a preparation counts ONE request, so a second runner
 * that reaches the same reference finds the pin occupied and declines with zero
 * claim and zero dispatch.
 *
 * A control client cannot set it. The only writer is the daemon's offer
 * admission, after it has sealed a manifest it already proved equal to this
 * record's binding and artifact summary — which is why `manifestDigest` is
 * here: the pin names the exact sealed Execution that consumed the record, so a
 * later reader does not have to take "some task claimed it" on trust.
 *
 * `sealedAt` is the moment the manifest was sealed, not the moment the append
 * landed: the seal is the fact being recorded.
 */
export interface InputPreparationPinV1 {
    /** The protocol task id of the Execution that consumed this preparation. */
    readonly taskId: string;
    /** `inputPreparationDigest` over the sealed `RuntimeOperationManifest`. */
    readonly manifestDigest: string;
    readonly sealedAt: string;
}
/**
 * Durable lifecycle state of one preparation record.
 *
 * - `reserved` — reserved durably; nothing compiled or counted yet.
 * - `counting` — artifact persisted, and a counter call was durably reserved
 *   and dispatched. Only a daemon with a configured counter enters it.
 * - `prepared` — the artifact is persisted and, when a counter is configured,
 *   the counter answered and the receipt carries its evidence. A daemon with
 *   no counter goes straight from `reserved` to `prepared`.
 * - `cancelled` — explicitly cancelled, or its deadline elapsed, with the call
 *   provably never placed. Terminal.
 * - `failed` — compilation, a policy bound or a durable write refused it.
 *   Terminal.
 * - `counter_interrupted` — the counter call started and its outcome is
 *   unknown (timeout, abort, or a thrown adapter). Terminal and OBSERVABLE: it
 *   is never automatically retried under the same request, because a repeat
 *   could be a second billed call against an outcome that may already have
 *   happened (§10.3.5).
 *
 * The last four are terminal and never transition again.
 */
export type InputPreparationStateV1 = 'reserved' | 'counting' | 'prepared' | 'cancelled' | 'failed' | 'counter_interrupted';
/**
 * Why a receipt is not ready. An empty list is the only thing that makes
 * `ready` true.
 *
 * `ready` answers exactly one question — CAN THIS PREPARATION BE CONSUMED —
 * and it is deliberately not Host budget admission. A ready receipt says the
 * artifact is intact, its projection is content-complete, every residual key
 * is ruled by an applicable Host accounting policy, D is text only, every
 * executor identity is attested, and — only when a counter is configured —
 * that count is provider-authoritative and covered. It says nothing about
 * whether the Host's budget allows the spend; the Host rules
 * `requestBytes + C + max_tokens <= window` itself.
 *
 * - `not_prepared` — the record is `reserved` or `counting`, or holds no
 *   artifact.
 * - `counter_authority_not_production` / `counter_coverage_incomplete` — a
 *   counter IS present on the record and its evidence is a fixture, or it did
 *   not cover the projection. An absent counter produces neither.
 * - `request_content_not_text` — D carries a message content part whose
 *   `type` is not `text`. The first release admits text-only D.
 *
 * - `projection_unknown` — the native compiler's projection kind is not
 *   `content_complete`, so it claims nothing about what P(D) covers.
 * - `residual_not_ruled` — the artifact carries a residual key the binding's
 *   accounting policy does not rule on.
 * - `accounting_policy_missing` — the request named no accounting policy.
 * - `accounting_policy_inapplicable` — the named policy was ruled for a
 *   different runtime or a different endpoint/model.
 * - `runtime_contract_superseded` — the record's binding declares a
 *   prepared-compiler version other than the one this build prepares and
 *   consumes against. The artifact is not re-read through the current contract
 *   and is not translated: a projection frozen under another compiler's
 *   classification table is evidence about a request this build cannot
 *   re-derive.
 */
export type InputPreparationReadinessReasonV1 = 'not_prepared' | 'counter_interrupted' | 'cancelled' | 'failed' | 'artifact_expired' | 'counter_authority_not_production' | 'counter_coverage_incomplete' | 'request_content_not_text' | 'projection_unknown' | 'residual_not_ruled' | 'accounting_policy_missing' | 'accounting_policy_inapplicable' | 'executor_identity_unproven' | 'runtime_contract_superseded';
/**
 * The scoped reference plus readiness evidence one preparation answers with.
 *
 * `reference` identifies the record inside the authenticated scope that created
 * it. It is not a capability: `lookup`/`cancel` re-resolve authority on every
 * call and derive the record key from the TRUSTED grant, so presenting another
 * scope's reference finds nothing.
 */
export interface InputPreparationReceiptV1 {
    readonly format: typeof INPUT_PREPARATION_RECEIPT_FORMAT;
    readonly version: typeof INPUT_PREPARATION_VERSION;
    readonly reference: string;
    readonly requestId: string;
    readonly state: InputPreparationStateV1;
    readonly binding: InputPreparationBindingV1;
    readonly artifact?: InputPreparationArtifactSummaryV1;
    readonly counter?: InputPreparationCounterEvidenceV1;
    /** True only when {@link readinessReasons} is empty. */
    readonly ready: boolean;
    readonly readinessReasons: readonly InputPreparationReadinessReasonV1[];
    /** Present on `failed`/`cancelled`/`counter_interrupted`; a stable code, not provider text. */
    readonly detail?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly artifactExpiresAt: string;
    readonly recordExpiresAt: string;
    /** Present once a committed Execution consumed this record. See {@link InputPreparationPinV1}. */
    readonly pin?: InputPreparationPinV1;
}
/**
 * Every typed rejection the three control methods can answer with. Each is a
 * distinct fact; none of them ever returns a partial or synthesized result.
 *
 * - `input_preparation_unconfigured` — this daemon has no `inputPreparation`
 *   section, so the whole surface is off. Checked first, before params are
 *   parsed, so a disabled daemon reveals nothing about request shapes.
 * - `bad_request` — the params are not the one strict shape (unknown field,
 *   wrong type, wrong version/format tag).
 * - `authority_unavailable` — the configured resolver could not answer. A
 *   refusal, never a reason to trust the claim.
 * - `scope_denied` — the resolver refused the claim, or answered with a grant
 *   that does not match what was asked about.
 * - `policy_revision_mismatch` — the request's `policyRevision` is not this
 *   daemon's configured revision.
 * - `runtime_identity_unavailable` — the installed native closure could not be
 *   verified, so no artifact can carry a runtime identity.
 * - `unsupported_input` — the input is outside the declared first support set,
 *   or the native compiler refused it. Nothing is filled in.
 * - `limit_exceeded` — a configured byte / in-flight / counter-call bound.
 * - `request_conflict` — the same `(scope, Agent, requestId)` key already exists
 *   bound to a DIFFERENT normalized request digest.
 * - `not_found` — no record for this key in this scope.
 * - `counter_unavailable` — the configured counter adapter refused before
 *   doing work, or answered with evidence about another projection.
 * - `counter_interrupted` — the counter's outcome is unknown; the record says so
 *   and is not retried.
 * - `durable_write_failed` — a durable write was uncertain. The record is
 *   quarantined and revalidated before anything else is written.
 * - `cancelled` — the record was cancelled, or its deadline elapsed.
 *
 * These are the codes this surface OWNS, not every code its three verbs can
 * answer with. The control frame layer refuses first where it must, and the
 * shared `shutting_down` (`daemon/control-protocol.ts`) is the one that reaches
 * a well-formed, authorized call: a daemon that has begun shutting down answers
 * it before the service is consulted at all.
 */
export declare const INPUT_PREPARATION_ERROR_CODES: readonly ['input_preparation_unconfigured', 'bad_request', 'authority_unavailable', 'scope_denied', 'policy_revision_mismatch', 'runtime_identity_unavailable', 'unsupported_input', 'limit_exceeded', 'request_conflict', 'not_found', 'counter_unavailable', 'counter_interrupted', 'durable_write_failed', 'cancelled', 
/**
 * A required MCP toolset server could not be observed on this device. A
 * partial tool set is not a smaller preparation, it is a different one.
 */
'toolsets_unobservable', 
/**
 * No non-writable launch directory (or no trusted launcher) could be proven
 * for this preparation's servers, so nothing was spawned. The specific
 * `TrustedLaunchCwdUnavailableReason` travels in the record's `detail`.
 */
'launch_boundary_unavailable', 
/**
 * A repeat of an already-recorded `requestId` arrived after the facts its
 * executor fingerprints were frozen against changed. The recorded receipt is
 * not re-derived and no server is re-probed.
 */
'observation_drift', 
/**
 * The declared `permissionMode` exceeds this device's configured ceiling.
 * Never narrowed to an admissible mode: a preparation counts one concrete
 * manifest, and quietly counting a smaller one answers a question nobody
 * asked.
 */
'permission_mode_denied', 
/**
 * The `prompt_prepared` frame this preparation would be launched with does
 * not fit one RPC frame the native runtime will accept
 * (`RPC_MAX_FRAME_BYTES`). The bound is the RUNTIME's, not the operator's, so
 * it is decided before the operator's per-artifact byte policy: an artifact
 * that could never be delivered must not be counted, retained or charged
 * against a scope aggregate. Terminal — the same input recompiles to the same
 * frame, so nothing here retries.
 */
'rpc_frame_too_large', 
/**
 * The input-preparation lane is OFF on this daemon because its durable
 * record log holds a record written in a record schema version this build
 * does not read (a leftover from before a version cut). Everything else on
 * the daemon runs; only this lane refuses, typed, until an operator
 * archives the record log named in the message. Nothing is migrated, read
 * forward or deleted.
 */
'input_preparation_record_log_unsupported'];
export type InputPreparationErrorCodeV1 = (typeof INPUT_PREPARATION_ERROR_CODES)[number];
/**
 * The two digests that bind one prepared tool surface, written ONCE here.
 *
 * `daemon/prepared-tool-surface.ts` computes them while it assembles a
 * preparation, and `adapters/pi/prepared-tools.ts` recomputes them at launch
 * to decide whether the device still matches the artifact it is about to send.
 * Two copies of either formula would make "the launch matches the preparation"
 * an agreement between two serializers rather than a property of one.
 *
 * They live beside {@link inputPreparationDigest} rather than in the daemon
 * module, so the in-process prepared launch entry can reach them without
 * pulling the registry, the probe and the policy resolver into a subprocess
 * that uses none of them.
 */
/** One projected server, reduced to exactly what a binding digest commits to. */
export interface PreparedToolBindingServerDigestInputV1 {
    readonly serverName: string;
    readonly toolsetId: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly implementation: ToolImplementationIdentityV1;
}
export interface PreparedToolBindingDigestInputV1 {
    readonly launch: McpLaunchAttestation;
    readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
    /** Canonically ordered by server name; the canonical JSON preserves array order. */
    readonly servers: readonly PreparedToolBindingServerDigestInputV1[];
}
/**
 * The spawn-free half: the launch attestation, the definition revisions, the
 * configured argv and the implementation identities.
 */
export declare function preparedToolBindingDigest(input: PreparedToolBindingDigestInputV1): string;
/**
 * The Pi-native half of a prepared Main tool set, bound to the ADMITTED policy
 * that selected it — not merely to the mode.
 *
 * `allowTools`/`denyTools` are what actually decide which built-ins a task gets
 * (`adapters/pi/permission-mapping.ts`), so a digest that bound only `mode`
 * would validate a launch whose native half is a different set from the one
 * that was counted.
 *
 * Absent while the native half is not countable: `daemon/prepared-tool-surface.ts`
 * assembles a preparation with no native tools at all, so there is no selection
 * to bind and the key is omitted rather than written as an empty one.
 */
export interface PreparedNativeToolSelectionV1 {
    /** Model-visible native tool names, in registration order. Never empty. */
    readonly names: readonly string[];
    /** The admitted policy that produced `names`, whole. */
    readonly policy: {
        readonly mode: PermissionMode;
        readonly allowTools?: readonly string[];
        readonly denyTools?: readonly string[];
    };
}
export interface PreparedToolSurfaceDigestInputV1 {
    readonly launch: McpLaunchAttestation;
    readonly permissionMode: PermissionMode;
    readonly runtimeIdentity: string;
    readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
    readonly tools: readonly InputPreparationToolV1[];
    readonly toolExecutors: Readonly<Record<string, string>>;
    readonly implementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
    /** Omitted while the prepared native half stays empty; see the type above. */
    readonly nativeSelection?: PreparedNativeToolSelectionV1;
}
/** The whole observed surface: the schemas, the executors, the launch and the identities. */
export declare function preparedToolSurfaceObservationDigest(input: PreparedToolSurfaceDigestInputV1): string;
// ==== @byok-sdk/client dist/lifecycle/create-service-lifecycle.d.ts ====
import { type LaunchdDeps } from './launchd';
import { type SystemdDeps } from './systemd';
import { type WinswDeps } from './winsw';
import type { ServiceDefinition, ServiceLifecycle } from './service-types';
export declare class UnsupportedServicePlatformError extends Error {
    constructor(platform: string);
}
export interface CreateServiceLifecycleOptions {
    /**
     * Overrides `process.platform` — test-only seam for exercising a
     * specific platform's generator/install logic from any host (combine
     * with a mocked `deps.run`/`deps.fs`, since the real launchctl/systemctl/
     * WinSW binaries obviously aren't present on the "wrong" OS).
     */
    platform?: NodeJS.Platform;
    /** Platform-specific DI seams (mocked exec, mocked fs, mocked homedir/getuid) — only the fields matching the resolved platform are ever read. */
    deps?: LaunchdDeps & SystemdDeps & WinswDeps;
}
/**
 * Platform-dispatched entry point for M3-4's lifecycle API: manages the
 * daemon as a background OS service via the platform's own idiomatic
 * mechanism —
 *
 *  - **macOS**: a launchd LaunchAgent (`launchd.ts`).
 *  - **Linux**: a systemd user unit (`systemd.ts`).
 *  - **Windows**: a WinSW-wrapped Windows Service (`winsw.ts`) — Node has no
 *    native SCM control-handler support in core, so a wrapper is used
 *    rather than hand-rolling the SCM protocol; see `winsw.ts`'s own doc
 *    comment for why WinSW specifically.
 *
 * Every implementation delegates crash-restart entirely to the OS
 * supervisor (`KeepAlive`/`Restart=on-failure`/`<onfailure>`) — none of them
 * runs an in-process supervisor loop.
 *
 * Deliberately does NOT try to auto-resolve `ServiceDefinition.program`'s
 * `command`/`agentBin` from `import.meta.resolve`/`import.meta.url`-style
 * introspection the way `adapters/pi/resolve-bin.ts` does for pi's required
 * package. That pattern is a genuinely hazardous fit here: a
 * relative path from THIS source file to `bin/byok-agent.ts` (`../bin/...`,
 * since `lifecycle/` and `bin/` are sibling directories under `src/`) does
 * NOT survive tsup's bundling unchanged — `src/index.ts` and
 * `src/bin/byok-agent.ts` are two SEPARATE, independently-bundled tsup
 * entries (see `tsup.config.ts`), so any code from `lifecycle/` ends up
 * inlined into `dist/index.js` itself, whose OWN directory is `dist/`, not
 * `dist/lifecycle/` — a path relative to "wherever this bundled code
 * actually runs from" would need to be `./bin/byok-agent.js` there, the
 * OPPOSITE of the `../bin/...` that's correct in unbundled `src/`. Guessing
 * across that bundle boundary is exactly the class of hazard
 * `templates/packaging/sea/README.md` had to empirically work around for
 * pi's own resolution path. Rather than add a second such hazard, this
 * module requires the caller to supply an explicit, already-resolved
 * `program.command`/args (see `service-types.ts`'s `nodeAgentProgram` —
 * still just a formatting convenience, not a resolution mechanism) — the
 * `install`/`uninstall`/`service-*` CLI subcommands (`bin/commands/service.ts`)
 * default `agentBin` to `process.argv[1]` instead, which Node always
 * populates correctly with the actual script path being run regardless of
 * how it was invoked, bundled or not.
 */
export declare function createServiceLifecycle(def: ServiceDefinition, opts?: CreateServiceLifecycleOptions): ServiceLifecycle;
// ==== @byok-sdk/client dist/lifecycle/exec-runner.d.ts ====
/**
 * Result of running an external command, regardless of its exit code.
 * `code !== 0` is an ordinary, expected outcome for several callers in this
 * module (e.g. `launchctl bootout` on a service that isn't currently
 * loaded, `systemctl --user is-active` on an inactive unit) — it is NOT
 * treated as a thrown error. See {@link Runner}'s own doc comment for what
 * DOES reject.
 */
export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}
/**
 * Runs an external service-manager CLI (`launchctl`, `systemctl`, a
 * WinSW-produced `.exe`, `sc.exe`) and resolves with its exit code +
 * captured stdout/stderr — it deliberately does NOT reject just because the
 * command exited non-zero (see {@link RunResult}'s doc comment: that is
 * everyday signal for several callers here, not failure). It DOES reject
 * for a genuine spawn failure (the executable itself couldn't be found/run
 * at all, e.g. `ENOENT`) — see {@link defaultRunner}'s implementation for
 * how the two are told apart. Callers that need "ran and returned 0 or
 * throw" wrap this with {@link runOrThrow}.
 *
 * The DI seam every one of `launchd.ts`/`systemd.ts`/`winsw.ts` accepts
 * (`LaunchdDeps.run`/`SystemdDeps.run`/`WinswDeps.run`) — this is what lets
 * the install/uninstall/start/stop/status logic for all three platforms be
 * unit-tested from any single host OS with a plain mock, per M3-4's own
 * verification requirement, without ever shelling out for real in tests.
 */
export type Runner = (command: string, args: string[]) => Promise<RunResult>;
/**
 * Real implementation: `child_process.execFile`, never a shell
 * (`exec`/`shell: true`) — the same reasoning as the pi adapter's own
 * `detect()` (see `templates/packaging/sea/README.md`'s "Windows note" and
 * `adapters/pi/pi-adapter.ts`): no shell-quoting hazard for a service name,
 * config path, or WinSW install directory containing spaces or special
 * characters. Every command this module ever invokes (`launchctl`,
 * `systemctl`, a WinSW-produced `.exe`, `sc.exe`) is a genuine native
 * executable, never a `.cmd`/`.bat` shell script, so the one real caveat of
 * `execFile`-without-`shell` on Windows (a `.cmd`/`.bat` target can't be
 * `CreateProcess`'d directly) never applies here.
 *
 * Node's `execFile` callback distinguishes two failure shapes on its error
 * argument: when the target process ran and merely exited non-zero, `error.code`
 * is that NUMERIC exit code; when the executable itself couldn't be spawned
 * (e.g. `ENOENT`), `error.code` is an ERRNO STRING and there is no real exit
 * code at all. This implementation resolves the first case as an ordinary
 * {@link RunResult} (letting callers decide whether a given non-zero exit
 * matters) and rejects only the second (a real inability to run the
 * command at all, which every caller should hear about).
 */
export declare const defaultRunner: Runner;
/**
 * Runs `command`/`args` via `run` and throws a clear, labeled error if it
 * exits non-zero — for the subset of calls across launchd/systemd/WinSW
 * that must actually succeed for `install()`/`start()` to honestly report
 * "the service is now running" (e.g. `launchctl bootstrap`, `systemctl
 * start`, `winsw install`). Callers that instead want best-effort/tolerant
 * semantics (e.g. "stop if running, no-op if already stopped") call `run`
 * directly and ignore the result — see `launchd.ts`/`systemd.ts`/
 * `winsw.ts`'s own `uninstall()`/`stop()` implementations.
 */
export declare function runOrThrow(run: Runner, command: string, args: string[], label: string): Promise<RunResult>;
/**
 * Describes what a "genuinely nothing to do" outcome looks like for a
 * best-effort stop/uninstall step whose target may legitimately already be
 * absent (not currently loaded/enabled/installed) — as opposed to a genuine
 * failure (permission denied, service busy, a manager fault, the manager
 * itself unreachable) that must NOT be treated the same way. See
 * {@link isIdempotentAbsence}.
 */
export interface IdempotentAbsence {
    /** Exit codes that ALONE mean "already absent", independent of any stdout/stderr text (e.g. Windows's `ERROR_SERVICE_DOES_NOT_EXIST`, 1060). */
    codes?: readonly number[];
    /** Case-insensitive patterns checked against `stdout + "\n" + stderr`; a match means "already absent/not loaded/does not exist" for this platform's tool. */
    patterns: readonly RegExp[];
    /**
     * Case-insensitive patterns checked against the SAME `stdout + "\n" +
     * stderr` text, and consulted BEFORE `codes`/`patterns`: a match here
     * means "this is a genuine failure", full stop, even if `codes`/`patterns`
     * would otherwise call the result idempotent absence. Exists because a
     * connectivity/permission/manager-unreachable error can be textually
     * indistinguishable from — or reuse the very same generic OS errno string
     * as — a genuine "not loaded"/"does not exist" message. Concretely: on a
     * headless host with no reachable `systemd --user` D-Bus session (common
     * for exactly the SSH/no-lingering boxes this daemon runs on),
     * `systemctl --user disable --now` fails with `Failed to connect to bus:
     * No such file or directory` — the SAME "No such file or directory" text
     * a genuinely-absent unit can also produce, but here it means "we could
     * not even ask the manager", not "the manager confirms it's gone".
     * Conflating the two previously let this REAL failure look identical to
     * idempotent absence and then delete the still-relevant plist/unit/exe
     * (cross-model-review P1 #7, round 2 — the same re-orphan shape the
     * original `codes`/`patterns` split was meant to fix in round 1). Each
     * platform module supplies its own `neverAbsence` for the same reason it
     * supplies its own `patterns`/`codes`: the actual wording is tool-specific
     * — see `launchd.ts`/`systemd.ts`/`winsw.ts`'s own constants.
     */
    neverAbsence?: readonly RegExp[];
}
/**
 * Distinguishes a KNOWN idempotent "already absent / not loaded / does not
 * exist" outcome (safe to still proceed with cleanup) from a genuine
 * failure. A non-zero exit is ambiguous on its own: `launchctl bootout`,
 * `systemctl disable --now`, and a WinSW `stop`+`uninstall` all use the SAME
 * non-zero exit for both "there was nothing to stop/unregister" (fine, an
 * everyday outcome — see this module's own {@link RunResult} doc comment)
 * and "I refused/failed to do it" (not fine) — conflating the two
 * previously let a real failure look identical to success and then delete
 * the plist/unit/exe out from under a still-running service
 * (cross-model-review P1 #7: an orphaned, uncontrollable process). Each
 * platform module supplies its own `patterns`/`codes` because the actual
 * wording/codes are tool-specific — see `launchd.ts`/`systemd.ts`/
 * `winsw.ts`'s own constants.
 *
 * `absence.neverAbsence` is checked FIRST (right after the unambiguous
 * `code === 0` success case) and, on a match, wins outright over any
 * `codes`/`patterns` match — see {@link IdempotentAbsence.neverAbsence}'s
 * own doc comment for why a connectivity/permission/manager-unreachable
 * signal must never be reclassified as absence no matter what else matches
 * (cross-model-review P1 #7, round 2).
 */
export declare function isIdempotentAbsence(result: RunResult, absence: IdempotentAbsence): boolean;
/**
 * Runs `command`/`args` via `run` for a best-effort stop/uninstall step and
 * throws a clear, labeled error UNLESS the result is either a genuine
 * success or a known idempotent "already absent" outcome (see
 * {@link isIdempotentAbsence}). Unlike {@link runOrThrow} (which throws on
 * ANY non-zero exit, for calls that must actually succeed), this is the
 * tolerant-but-not-blind form each platform's `uninstall()` needs: proceed
 * to delete the plist/unit/exe+xml ONLY when this resolves without
 * throwing; a thrown error here means "do NOT delete the control files —
 * surface this to the caller so they can retry" (see each platform's own
 * `uninstall()`). Each platform's standalone `stop()` uses the same
 * function for the same reason: tolerate "already stopped/not loaded", but
 * surface — rather than silently swallow — a genuine failure (permission
 * denied, manager unreachable) instead of misreporting it as "stopped"
 * (cross-model-review P1 #7, round 2, second half).
 */
export declare function runIdempotent(run: Runner, command: string, args: string[], label: string, absence: IdempotentAbsence): Promise<RunResult>;
// ==== @byok-sdk/client dist/lifecycle/launchd.d.ts ====
import { promises as fsp } from 'node:fs';
import { type Runner } from './exec-runner';
import { type ServiceDefinition, type ServiceLifecycle, type ServiceProgram } from './service-types';
/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment for why a mocked `run` is enough to unit-test all of this file's install/uninstall/start/stop/status logic on any host OS. */
export interface LaunchdDeps {
    run?: Runner;
    fs?: Pick<typeof fsp, 'mkdir' | 'writeFile' | 'rm' | 'stat'>;
    homedir?: () => string;
    /** Defaults to `process.getuid` — macOS/Linux only; this module is never constructed on `win32` (see `create-service-lifecycle.ts`). */
    getuid?: () => number;
}
/**
 * Generates a launchd LaunchAgent plist for `label` running `program`,
 * logging to `logDir`. Pure/no I/O — unit-tested directly for exact content
 * shape.
 *
 * - `RunAtLoad`: true — starts immediately on `launchctl bootstrap`.
 * - `KeepAlive.SuccessfulExit: false` — the standard, widely-documented
 *   launchd idiom for "restart only on crash/non-zero-or-signaled exit, do
 *   NOT restart after a clean `exit(0)`". This is the crash-restart M3-4
 *   asks for, delegated entirely to launchd — nothing in this SDK
 *   supervises the process itself.
 * - `ThrottleInterval: 10` — matches the WinSW recipe's `onfailure delay="10
 *   sec"` (see `winsw.ts`) so a crash-looping process backs off at a
 *   comparable rate on every platform, rather than launchd's own default
 *   (which is already 10s, but left implicit is easy to mistake for
 *   "unthrottled").
 * - `StandardOutPath`/`StandardErrorPath` under `logDir` — this is what M3-4
 *   asks for explicitly ("StandardOut/Error paths under storeDir"), unlike
 *   `systemd.ts`'s unit (which ALSO writes append-mode log files under
 *   `logDir` for cross-platform parity, even though systemd's own native
 *   idiom is the journal).
 */
export declare function generateLaunchdPlist(def: {
    label: string;
    program: ServiceProgram;
    logDir: string;
}): string;
/**
 * macOS LaunchAgent lifecycle, built on the modern `launchctl` subcommand
 * interface (`bootstrap`/`bootout`/`enable`/`kickstart`/`print`, targeting
 * `gui/<uid>` — the per-user GUI domain LaunchAgents run in — rather than
 * the legacy `load`/`unload`/`start`/`stop`).
 *
 * `start`/`stop` mapping (a real nuance worth documenting, not an arbitrary
 * choice): `KeepAlive` means a plain signal-kill (`launchctl kill`) would
 * just have launchd immediately restart the job — that's the crash-restart
 * feature working exactly as designed, but it means "kill" can't implement
 * a genuine "stop" on its own. `bootout` (fully unloading the job from the
 * domain) is the only primitive that stops it without KeepAlive fighting
 * back, so `stop()` = `bootout` and `start()` = `bootstrap` again (reload
 * from the still-on-disk plist) — not `kickstart`, which only force-restarts
 * an ALREADY-loaded job.
 */
export declare function createLaunchdLifecycle(def: ServiceDefinition, deps?: LaunchdDeps): ServiceLifecycle;
// ==== @byok-sdk/client dist/lifecycle/service-types.d.ts ====
/**
 * What the OS service manager should actually execute to run the daemon in
 * the background. Deliberately requires an explicit `command` (an absolute
 * path is strongly recommended, not just a bare command name) rather than
 * ever trying to auto-resolve one internally — see
 * `create-service-lifecycle.ts`'s module doc comment for why. A bare
 * command name relies on the OS service manager's own minimal PATH, which
 * commonly does NOT include nvm/volta/homebrew node install directories —
 * a frequent real-world "service can't find node" bug on every one of the
 * three platforms this module supports.
 */
export interface ServiceProgram {
    command: string;
    /**
     * Args passed verbatim to `command` — e.g. `[agentBinPath, 'start',
     * '--config', configPath]` for a plain node + script run (see
     * {@link nodeAgentProgram}), or `['start', '--config', configPath]` alone
     * if `command` is already a self-contained bundled binary (see
     * `templates/packaging/`). Every platform generator passes these through
     * untouched — `winsw.ts` emits one `<argument>` element per entry rather
     * than a single shell-quoted string specifically so a path containing
     * spaces never needs manual escaping (see that file's doc comment).
     */
    args: string[];
    /** Working directory for the running service process. Each platform generator has its own documented default (see `launchd.ts`/`systemd.ts`/`winsw.ts`) when omitted. */
    cwd?: string;
}
export interface NodeAgentProgramOptions {
    /** Absolute path to the `byok-agent` entry script to run. No auto-detection — see `create-service-lifecycle.ts`'s doc comment. */
    agentBin: string;
    /** Absolute path to the JSON config file `byok-agent start` should load — resolve this to an absolute path BEFORE calling, since the service will run with the OS service manager's own cwd, not the caller's. */
    configPath: string;
    /** Node executable to invoke `agentBin` with. Defaults to `process.execPath` (the currently running node) — always an absolute, real path, unlike a bare `node` on PATH. */
    nodeBin?: string;
    cwd?: string;
}
/**
 * Convenience builder for the common case: run `node <agentBin> start
 * --config <configPath>` as the service's program. Still requires the
 * caller to supply an absolute `agentBin` — this helper is a formatting
 * convenience only, not a resolution mechanism.
 */
export declare function nodeAgentProgram(opts: NodeAgentProgramOptions): ServiceProgram;
export interface ServiceDefinition {
    /** Stable service identifier — becomes the launchd `Label`, the systemd unit's basename, and the WinSW `<id>` (sanitized per-platform via {@link sanitizeServiceName}). Typically `DaemonConfig.productId`. */
    name: string;
    /** Human-readable display name — systemd `Description=`, WinSW `<name>`/`<description>`. Defaults to `name` if omitted. */
    displayName?: string;
    /** What to run — see {@link ServiceProgram}. */
    program: ServiceProgram;
    /** Directory the service's stdout/stderr logs are written under (created if missing). On Windows this also doubles as the default WinSW install directory — see `windows.installDir`. */
    logDir: string;
    /**
     * Windows/WinSW-only inputs. Required when actually constructing a
     * lifecycle on `win32` (`create-service-lifecycle.ts` throws a clear
     * error otherwise); ignored on macOS/Linux.
     */
    windows?: {
        /**
         * Absolute path to the product-bundled WinSW executable. Decision-6
         * boundary: this SDK never bundles or downloads this binary itself —
         * see `templates/service/winsw/README.md`. The lifecycle copies it
         * into `installDir` under this service's own name (WinSW's own
         * convention: the exe and its XML config must share a basename).
         */
        winswBin: string;
        /** Directory the renamed WinSW exe + generated XML are installed into. Defaults to `logDir`. */
        installDir?: string;
    };
}
/** Options for {@link ServiceLifecycle.install} — an escape hatch for the rare case of reinstalling with a changed program (e.g. after an upgrade moved the agent binary) without reconstructing the whole lifecycle object. Omit to reuse the program given to `createServiceLifecycle`. */
export interface ServiceInstallOptions {
    program?: ServiceProgram;
}
export interface ServiceStatusResult {
    /** Whether the platform's own service manager has this service registered at all (a plist/unit/WinSW-config file present — checked directly, not inferred from `running`). */
    installed: boolean;
    /** Whether it's currently running, per the platform's own authoritative query (`launchctl print`, `systemctl --user is-active`, `sc.exe query`) — never a locally-cached guess. `false` here means "confirmed not running" ONLY when `determinate` is also `true` — see that field's own doc comment. */
    running: boolean;
    /**
     * Finding P1 #2 (residual, round 3): whether `running`/`installed` above
     * were actually CONFIRMED by a clean query, as opposed to a fallback
     * because the platform's own service-manager tool could not be asked at
     * all. `run()` (`exec-runner.ts`'s `Runner`) resolves an ordinary
     * non-throwing `RunResult` for a bus-connect failure, an unreachable
     * launchd GUI domain, or a permission-denied query — the SAME shape a
     * genuine "not running" query returns — so without this field, a caller
     * receiving `running: false` could not tell "the manager confirms it's
     * not running" apart from "the manager could not even be asked" (both
     * silently collapsed into the same boolean). Concretely:
     *
     * - `true`: either an authoritative "running"/"active" match, or a query
     *   that resolved with a KNOWN clean "not running"/"not loaded"/"not
     *   found" result.
     * - `false`: the query itself could not be answered — a
     *   connectivity/permission/manager-unreachable failure (each platform
     *   classifies this with the SAME `neverAbsence`-style pattern list its
     *   `uninstall()`/`stop()` already use for the identical reason — see
     *   `systemd.ts`/`launchd.ts`/`winsw.ts`'s own
     *   `*_CONNECTIVITY_OR_PERMISSION_FAILURE` constants). `running: false`
     *   in this case is a FALLBACK, not a confirmed fact.
     *
     * Callers that must not fail open on an unreachable manager (see
     * `bin/commands/unpair.ts`'s `checkServiceState`) must treat
     * `determinate: false` exactly the same as a thrown `status()` call.
     */
    determinate: boolean;
    /** Raw human-readable output from the underlying platform tool, for the `service-status` CLI subcommand and debugging. Never parsed further than the booleans above. */
    detail: string;
}
/**
 * The lifecycle API M3-4 asks for: `install(opts) / uninstall() / start() /
 * stop() / status()`. Every method but `install` is deliberately
 * parameterless — the service's identity/program/logDir are already fixed
 * at `createServiceLifecycle(definition, ...)` construction time (mirrors
 * `createDaemon(config)`'s own "5-line launcher" shape), so `uninstall`/
 * `start`/`stop`/`status` always act on that one already-known service.
 *
 * Crash-restart is ALWAYS delegated to the OS supervisor (launchd
 * `KeepAlive`, systemd `Restart=on-failure`, WinSW `<onfailure>`) — no
 * implementation of this interface runs an in-process supervisor loop of
 * its own.
 *
 * Idempotency convention shared by every platform implementation: `install`
 * and `start` hard-fail (throw) if the final "make it actually running"
 * step fails, since silently doing nothing there would misreport success.
 * `stop` is best-effort/tolerant ONLY of a KNOWN idempotent "already
 * stopped"/"not loaded"/"not installed" result (mirrors `Daemon.unpair()`'s
 * own "safe to call at any point in the lifecycle" convention in
 * `daemon/create-daemon.ts` for that idempotent case) — a genuine failure
 * (permission denied, manager unreachable, the exe locked/busy) is thrown
 * instead of being misreported as "stopped", using the same precise
 * classifier `uninstall` uses (cross-model-review P1 #7, round 2, second
 * half: silently swallowing a real `stop()` failure undermines the operator's
 * ability to trust "stopped" at all). `uninstall` is tolerant ONLY of a
 * KNOWN idempotent "not loaded"/"does not exist"/"already absent" result
 * from its stop+unregister step (see `exec-runner.ts`'s
 * `isIdempotentAbsence`) — a genuine failure (permission denied, service
 * busy, manager error, manager UNREACHABLE — e.g. no reachable systemd
 * `--user` D-Bus session or launchd GUI domain for this uid, textually
 * indistinguishable from "already absent" unless explicitly excluded, see
 * `exec-runner.ts`'s `IdempotentAbsence.neverAbsence`) is thrown instead,
 * and the plist/unit/winsw exe+xml are deliberately left in place, so a
 * still-running service never loses its control files and becomes an
 * orphan nobody can stop/uninstall (cross-model-review P1 #7).
 */
export interface ServiceLifecycle {
    /** Writes the platform service definition and registers + starts it with the OS service manager. Safe to call again later (e.g. after an upgrade): overwrites the definition and reloads it. */
    install(opts?: ServiceInstallOptions): Promise<void>;
    /** Stops (if running) and fully removes the service registration + generated definition file. Safe to call when not installed. Throws — and leaves the control file in place — if the underlying service manager reports a genuine failure rather than success/"not installed"; see this interface's own doc comment. */
    uninstall(): Promise<void>;
    /** Starts an already-installed service. Throws a clear error if it isn't installed. */
    start(): Promise<void>;
    /** Stops a running service without uninstalling it. Safe to call when already stopped (or not installed/not loaded). Throws if the underlying service manager reports a genuine failure instead (e.g. permission denied, manager unreachable) rather than silently reporting success; see this interface's own doc comment. */
    stop(): Promise<void>;
    /** Current installed/running state, queried fresh from the platform's own service manager. */
    status(): Promise<ServiceStatusResult>;
}
/**
 * Sanitizes a free-form product/service identifier into something safe to
 * embed in a launchd `Label`, a systemd unit filename, and a WinSW `<id>`
 * (which doubles as a Windows service name AND a generated filename) — the
 * intersection of all three platforms' safe-identifier rules is
 * "letters, digits, `.`, `-`, `_`". Anything outside that set collapses to
 * `-`. A LEADING `-` is then stripped even though `-` is itself an allowed
 * character: `systemctl`'s argument parser (and, generally, any
 * getopt-style CLI) mistakes a bare positional argument starting with `-`
 * for an option rather than the service/unit name — e.g. `systemctl --user
 * enable --now -foo.service` — which would otherwise misparse every one of
 * `launchd.ts`/`systemd.ts`/`winsw.ts`'s own `run()` calls that pass this
 * sanitized name straight through as a CLI argument (cross-model-review P1
 * #8). Called independently by each platform module (not once centrally) so
 * every one of `launchd.ts`/`systemd.ts`/`winsw.ts` stays correct even when
 * used directly, without going through `createServiceLifecycle`'s
 * dispatcher.
 */
export declare function sanitizeServiceName(name: string): string;
// ==== @byok-sdk/client dist/lifecycle/systemd.d.ts ====
import { promises as fsp } from 'node:fs';
import { type Runner } from './exec-runner';
import { type ServiceDefinition, type ServiceLifecycle, type ServiceProgram } from './service-types';
/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment. */
export interface SystemdDeps {
    run?: Runner;
    fs?: Pick<typeof fsp, 'mkdir' | 'writeFile' | 'rm' | 'stat'>;
    homedir?: () => string;
}
/**
 * Generates a systemd user unit for `name` running `program`, logging to
 * `logDir`. Pure/no I/O — unit-tested directly for exact content shape, and
 * (locally, when `systemd-analyze` is available) verified with
 * `systemd-analyze verify` — see `templates/service/systemd/README.md`.
 *
 * `Restart=on-failure` + `RestartSec=10` is the crash-restart M3-4 asks for,
 * delegated entirely to systemd. `StandardOutput`/`StandardError` are
 * pointed at append-mode files under `logDir` for parity with the launchd
 * plist's `StandardOutPath`/`StandardErrorPath` and the WinSW `<logpath>` —
 * systemd's own native idiom (the journal, `journalctl --user -u <name>`)
 * still works unconditionally alongside this (systemd always journals
 * unit's output; explicitly setting `StandardOutput=append:...` needs
 * systemd >= 240, present on every currently-supported distro this SDK
 * targets) and is documented in the README as the alternative.
 */
export declare function generateSystemdUnit(def: {
    name: string;
    displayName: string;
    program: ServiceProgram;
    logDir: string;
}): string;
/**
 * Linux systemd **user** service lifecycle (`~/.config/systemd/user/`,
 * `systemctl --user ...`) — deliberately not a system-wide unit under
 * `/etc/systemd/system/`, so install/uninstall never needs root, matching
 * launchd's per-user LaunchAgent (not a system Daemon) and WinSW's
 * per-machine Windows Service the same way each platform's own idiomatic
 * "run this in the background for me" mechanism works.
 *
 * Requires a running systemd **user instance** for this user (normal on any
 * desktop/login-manager session, and on modern systemd with
 * `loginctl enable-linger` for a headless box) — a bare container with no
 * systemd user session at all will fail every `systemctl --user` call here
 * with a clear error surfaced from `runOrThrow`, not a silent no-op.
 */
export declare function createSystemdLifecycle(def: ServiceDefinition, deps?: SystemdDeps): ServiceLifecycle;
// ==== @byok-sdk/client dist/lifecycle/winsw.d.ts ====
import { promises as fsp } from 'node:fs';
import { type Runner } from './exec-runner';
import { type ServiceDefinition, type ServiceLifecycle, type ServiceProgram } from './service-types';
/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment. */
export interface WinswDeps {
    run?: Runner;
    fs?: Pick<typeof fsp, 'mkdir' | 'writeFile' | 'rm' | 'stat' | 'copyFile'>;
}
/**
 * Generates a WinSW (https://github.com/winsw/winsw) service descriptor XML
 * for `id` running `program`, logging to `logDir`. Pure/no I/O — unit-tested
 * directly for exact content shape; the REAL proof this is valid WinSW XML
 * is the `windows-service-smoke` CI job (`.github/workflows/ci.yml`), which
 * actually runs `winsw install` against generated output on a real
 * `windows-latest` runner — this macOS dev box cannot execute WinSW at all.
 *
 * Each argument becomes its own `<argument>` element (WinSW's supported
 * repeatable-element form) rather than a single space-joined `<arguments>`
 * string — this sidesteps shell-style quoting entirely for a config path
 * containing spaces, the exact same concern the pi adapter's
 * `execFile`-without-`shell` note raises for Windows (see
 * `templates/packaging/sea/README.md`'s "Windows note": WinSW itself
 * launches `<executable>` directly, no shell involved, so an unescaped
 * space in a single `<arguments>` string would be split in the wrong
 * place — one `<argument>` per token has no such ambiguity).
 *
 * `<onfailure action="restart" delay="10 sec"/>` (with a second, longer
 * backoff on repeated failure) is the crash-restart M3-4 asks for,
 * delegated entirely to WinSW/the Windows SCM — nothing in this SDK
 * supervises the process itself. `<startmode>Automatic</startmode>` mirrors
 * launchd's `RunAtLoad`/systemd's `WantedBy=default.target`: the service
 * also starts automatically on the next machine boot, not just right now.
 */
export declare function generateWinswXml(def: {
    id: string;
    displayName: string;
    program: ServiceProgram;
    logDir: string;
}): string;
/**
 * Windows Service lifecycle via WinSW — the standard, widely-used .NET
 * service wrapper that gives any exe/command real Windows Service Control
 * Manager (SCM) integration (crash-restart, logging, boot autostart)
 * without this SDK hand-rolling the SCM protocol in Node (which has no
 * native control-handler support in core — the reason a wrapper is needed
 * at all).
 *
 * Decision-6 boundary: the product supplies the WinSW binary
 * (`def.windows.winswBin`); this module only generates the correct config
 * and drives install/uninstall/start/stop/status around it. WinSW's own
 * convention is that its executable and XML config share a basename in the
 * same directory (`<id>.exe` + `<id>.xml`), so `install()` copies the
 * product-supplied binary into place under that name rather than invoking
 * it in place — this is the version-agnostic approach documented across
 * WinSW v2/v3, unlike relying on a specific `--config` CLI flag that may
 * differ between major versions.
 *
 * `status()` queries `sc.exe` (the real Windows SCM query tool, always
 * present) rather than parsing WinSW's own `status` subcommand text —
 * authoritative ground truth independent of WinSW's own output, and the
 * exact tool `templates/service/winsw/smoke-test.mjs` / the CI job also
 * assert against.
 */
export declare function createWinswLifecycle(def: ServiceDefinition, deps?: WinswDeps): ServiceLifecycle;
// ==== @byok-sdk/client dist/local-state-relocation.d.ts ====
export declare class LocalStateRelocationError extends Error {
    constructor(message: string);
}
export declare class LocalStateRelocationBusyError extends LocalStateRelocationError {
    constructor(message: string);
}
export declare class LocalStateRelocationIntegrityError extends LocalStateRelocationError {
    constructor(message: string);
}
export interface LocalStateRelocationInput {
    readonly productId: string;
    readonly sourceStoreDir: string;
    readonly sourceHostStorageRoot: string;
    readonly destinationStoreDir: string;
    readonly destinationHostStorageRoot: string;
}
export interface LocalStateRelocationLease extends LocalStateRelocationInput {
    release(): Promise<void>;
}
declare function acquire(input: LocalStateRelocationInput): Promise<LocalStateRelocationLease>;
export declare const localStateRelocation: Readonly<{
    acquire: typeof acquire;
}>;
export {};
// ==== @byok-sdk/client dist/mcp-server/dispatch.d.ts ====
/**
 * JSON-RPC 2.0 classification and per-session id bookkeeping.
 *
 * Everything here runs BEFORE a tool handler can be reached. A message that
 * does not classify as a well-formed request never reaches `callTool`, which is
 * the point: a server's tool logic should never have to defend itself against a
 * malformed envelope, and today's four hand-rolled helpers each do, differently.
 */
/** A JSON-RPC 2.0 id this core will answer: a string, or an INTEGER number. `0` is valid and common. */
export type McpServerRequestId = string | number;
export type ClassifiedMessage = {
    readonly kind: 'request';
    readonly id: McpServerRequestId;
    readonly method: string;
    readonly params: Record<string, unknown> | undefined;
} | {
    readonly kind: 'notification';
    readonly method: string;
    readonly params: Record<string, unknown> | undefined;
}
/** `id` is `undefined` when no usable id could be read at all — the one case where a response may omit or null it. */
 | {
    readonly kind: 'invalid';
    readonly id: McpServerRequestId | undefined;
    readonly message: string;
};
/**
 * The official client sends monotonic INTEGER ids starting at `0`
 * (`_requestMessageId = 0`), so every id test must be a type test. `if (!id)`
 * and `if (id)` are both bugs against a real peer's very first request.
 */
export declare function isUsableRequestId(value: unknown): value is McpServerRequestId;
/**
 * Classifies one already-parsed JSON value.
 *
 * The id is read FIRST, so a message that is invalid for some other reason
 * still echoes the id the peer can correlate. A batch array is classified
 * `invalid` rather than expanded: this core does not implement batch receipt,
 * which is exactly why the advertised version list excludes every revision that
 * makes receiving one a MUST.
 */
export declare function classifyJsonRpcMessage(value: unknown): ClassifiedMessage;
/**
 * Per-session record of every request id already answered.
 *
 * BOUNDED, deliberately. A session that issues more than `capacity` distinct
 * ids can no longer detect a replay of an EVICTED id; that is the trade taken
 * against an unbounded set a peer could grow on purpose. The official client's
 * ids are monotonic integers from 0, so eviction never produces a false
 * positive against a real peer.
 */
export declare class SeenRequestIds {
    private readonly seen;
    private readonly order;
    private readonly capacity;
    constructor(capacity: number);
    /** `true` when this id has already been used in this session. */
    has(id: McpServerRequestId): boolean;
    /** Records the id, evicting the oldest once `capacity` is reached. */
    add(id: McpServerRequestId): void;
    /** `"7"` and `7` are different JSON-RPC ids and must not collide. */
    static key(id: McpServerRequestId): string;
}
// ==== @byok-sdk/client dist/mcp-server/index.d.ts ====
import { type McpServerRequestId } from './dispatch';
/** The revisions this core implements and will answer `initialize` with. Final; see the module header for each entry's and each exclusion's citation. */
export declare const MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS: readonly string[];
/** Inbound: maximum bytes between two newlines before the session fails closed. */
export declare const MCP_SERVER_MAX_LINE_BYTES = 1048576;
/**
 * Outbound: maximum UTF-8 bytes of one encoded frame. Matches
 * `MCP_MAX_FRAME_BYTES` in `src/mcp/client.ts`, so an SDK server and an SDK
 * client agree on the same 1 MiB ceiling in both directions.
 */
export declare const MCP_SERVER_MAX_FRAME_BYTES = 1048576;
/** Maximum `tools/call` requests in flight or queued at once. */
export declare const MCP_SERVER_MAX_IN_FLIGHT = 64;
/** Maximum distinct request ids remembered per session for duplicate detection. */
export declare const MCP_SERVER_MAX_SEEN_IDS = 4096;
export interface McpServerToolDefinition {
    readonly name: string;
    readonly description?: string;
    /** Caller-supplied, passed through verbatim. The core never authors, validates against, or rewrites it. */
    readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface McpServerToolCall {
    readonly name: string;
    /**
     * The peer's `params.arguments` when the key was present; it is always a plain
     * object because any present non-object (null, array, scalar) is refused at the
     * protocol layer with -32602 before dispatch. `undefined` means the key was absent.
     */
    readonly arguments: Readonly<Record<string, unknown>> | undefined;
    /** Aborted when the peer sends `notifications/cancelled` for this request id. */
    readonly signal: AbortSignal;
}
/**
 * The handler's return value is written as the JSON-RPC `result` VERBATIM, and
 * a thrown {@link McpServerToolError} as the `error`. Mapping a domain failure
 * onto either is the SERVER'S decision, not this core's: a handler that returns
 * normally always produces a `result`.
 */
export type McpServerToolHandler = (call: McpServerToolCall) => Promise<Record<string, unknown>>;
/** Opt-in. A handler throws this to author its own JSON-RPC `error`; returning normally always produces a `result`. */
export declare class McpServerToolError extends Error {
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, message: string, data?: unknown);
}
/** One encoded frame exceeded the outbound cap. Nothing was written for it — never a truncated prefix. */
export declare class McpServerFrameTooLargeError extends Error {
    /** The id of the request whose response could not be sent, or `undefined` for an unsolicited notification. */
    readonly requestId: McpServerRequestId | undefined;
    readonly bytes: number;
    readonly limitBytes: number;
    constructor(requestId: McpServerRequestId | undefined, bytes: number, limitBytes: number);
}
/**
 * Supplying one of these is the ONLY way to make the core advertise
 * `{ tools: { listChanged: true } }`. The core subscribes once at construction
 * and unsubscribes when the session closes.
 */
export interface McpServerToolsListChangedEmitter {
    /** Called once with the notifier to invoke when the tool list changes. Returns an unsubscribe. */
    onToolsListChanged(notify: () => void): () => void;
}
export type McpServerCloseReason = 
/** The read side ended. */
{
    readonly kind: 'eof';
}
/** A single inbound line exceeded `maxLineBytes`; nothing was parsed or answered. */
 | {
    readonly kind: 'frame-limit';
    readonly limitBytes: number;
}
/** A single outbound frame exceeded `maxOutboundFrameBytes`; nothing was written for it. */
 | {
    readonly kind: 'outbound-frame-limit';
    readonly limitBytes: number;
    readonly bytes: number;
    readonly error: McpServerFrameTooLargeError;
};
export interface McpServerOptions {
    readonly serverInfo: {
        readonly name: string;
        readonly version: string;
    };
    readonly tools: readonly McpServerToolDefinition[];
    readonly callTool: McpServerToolHandler;
    /**
     * Opt-in only. Supplying a real emitter makes the core advertise
     * `{ tools: { listChanged: true } }` and emit
     * `notifications/tools/list_changed`. Omitted, the core advertises
     * `{ tools: {} }`. There is no other way to influence the advertised
     * capabilities.
     */
    readonly toolsListChanged?: McpServerToolsListChangedEmitter;
    /** Default {@link MCP_SERVER_MAX_LINE_BYTES}. Fail closed and close on exceed. */
    readonly maxLineBytes?: number;
    /** Default {@link MCP_SERVER_MAX_FRAME_BYTES}. Outbound cap; an over-cap frame is never partially written. */
    readonly maxOutboundFrameBytes?: number;
    /** Default {@link MCP_SERVER_MAX_IN_FLIGHT}. Over-limit `tools/call` requests get a typed `-32000` refusal. */
    readonly maxInFlight?: number;
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
    /** Called at most once, when the read side ends or a bound is breached. An explicit `close()` does not fire it. */
    readonly onClose?: (reason: McpServerCloseReason) => void;
}
export interface McpServerHandle {
    /** Stops reading and writing and aborts every in-flight call. Does NOT fire `onClose`. Idempotent. */
    close(): void;
}
/**
 * Serves `options.tools` as a tools-only MCP server over one NDJSON stdio
 * session.
 *
 * Throws at construction for the two caller faults it can see — an empty tool
 * list and two tools sharing a name — because a server that advertises the
 * `tools` capability with nothing callable is a silent dead end: the peer
 * connects, then every `tools/call` fails on its side.
 */
export declare function serveMcpOverStdio(options: McpServerOptions): McpServerHandle;
// ==== @byok-sdk/client dist/mcp/authority-error.d.ts ====
/**
 * The MCP authority error, on a module of its own and importing nothing.
 *
 * `mcp/client.ts` owns the single MCP client authority, but the client's own
 * module graph reaches `@modelcontextprotocol/client`. Modules that must
 * IDENTIFY an authority refusal without taking that graph — the daemon-free
 * adapters closure above all (`dist-subpath-closure.test.ts` guards the
 * emitted bundle against exactly this edge) — import the class from here.
 * One definition, re-exported by `mcp/client.ts`, so `instanceof` is exact
 * everywhere and no second error type is minted.
 */
export declare class McpAuthorityError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
// ==== @byok-sdk/client dist/mcp/client.d.ts ====
import { type ToolImplementationFsProbe, type ToolImplementationIdentityV1 } from '../daemon/tool-implementation-identity';
import { type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { McpAuthorityError } from './authority-error';
export { McpAuthorityError };
/**
 * The SDK's single MCP client authority.
 *
 * Every place this package talks MCP goes through here: the daemon's
 * admission observation (`../daemon/mcp-tools-probe.ts`), the Pi ordinary
 * extension (`../adapters/pi/mcp-extension.ts`), and the frozen projection the
 * prepared launch entry consumes. One authority is the point — a second
 * hand-rolled JSON-RPC dialect (or a third-party adapter's) would be a second
 * place for the framing, the bounds and the name rules to diverge.
 *
 * Protocol, framing and request correlation come from
 * `@modelcontextprotocol/client@2.0.0`. Only the process layer is ours, and
 * only because the bounds below cannot be expressed through the package's own
 * `StdioClientTransport`: it exposes a per-frame `maxBufferSize` and the
 * child's stderr, but no hook on stdout, so the total-stdout cap that
 * `mcp-tools-probe.ts` has always enforced would be silently lost. Spawning
 * ourselves also keeps the environment explicit — `StdioClientTransport`
 * falls back to `getDefaultEnvironment()` when `env` is omitted, and this SDK
 * never lets an MCP child inherit the daemon's ambient environment.
 *
 * stdio only. No HTTP, no SSE, no OAuth, no unix socket.
 */
/**
 * Hard cap on the bytes one server may write to stdout across the whole
 * lifetime of an OBSERVATION client, carried over verbatim from the probe this
 * replaces. The observation reads a fixed handshake, so a server still
 * streaming past this is either broken or hostile; either way it must not grow
 * the daemon's heap while an offer waits on admission.
 *
 * Deliberately NOT a default: a long-lived call client legitimately receives
 * more than this across many `tools/call` answers, and a lifetime cap there
 * would fail a healthy session at an arbitrary point. Callers that have a
 * bounded lifecycle opt in; everyone else is bounded per frame instead.
 */
export declare const MCP_OBSERVATION_MAX_STDOUT_BYTES = 1048576;
/**
 * Hard cap on a single JSON-RPC frame, always applied. A server that never
 * emits a newline cannot make the client accumulate without limit: the read
 * buffer rejects at this size and the connection fails closed.
 */
export declare const MCP_MAX_FRAME_BYTES = 1048576;
/** Default ceiling for one request/response round trip. */
export declare const MCP_DEFAULT_REQUEST_TIMEOUT_MS = 10000;
/**
 * A failure of the server's ENVIRONMENT rather than its answer: it could not
 * be spawned, it exited before answering, the deadline expired, the pipe
 * broke. These may well succeed later and stay retryable.
 */
export declare class McpTransportError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** The exact stdio server this client drives. Command and args only, like the registry. */
export interface McpStdioServerSpec {
    readonly command: string;
    readonly args?: readonly string[];
    /**
     * Layered on top of `env` exactly as the runtime path layers it. Only
     * SDK-reserved servers ever carry one; host toolset configuration rejects
     * the field outright (`../daemon/toolset-registry.ts`).
     */
    readonly env?: Readonly<Record<string, string>>;
}
export interface McpStdioClientOptions {
    /** Prefix on every error message, so a failure names the thing that failed. */
    readonly label?: string;
    /**
     * The exact base environment the RUNTIME child of this task receives
     * (`buildRuntimeEnv`) — never `process.env`. Required, deliberately: a
     * caller that forgets it fails to compile rather than silently reinstating
     * a blanket passthrough of the daemon's own credentials.
     */
    readonly env: Readonly<Record<string, string>>;
    /** Working directory for the child — the same one the runtime CLI is spawned in. */
    readonly cwd?: string;
    /** Per-request deadline. */
    readonly timeoutMs?: number;
    /** Opt-in lifetime stdout cap; see {@link MCP_OBSERVATION_MAX_STDOUT_BYTES}. */
    readonly maxStdoutBytes?: number;
    /**
     * What this SDK has established about the implementation behind the command
     * below (`../daemon/tool-implementation-identity.ts`).
     *
     * Every spawn of an ATTESTED server re-measures it first — see
     * {@link McpStdioClient.connect}. This is the one choke point both spawn
     * points share: the daemon's admission probe and the Pi extension's pool
     * both build their child through this class, so neither can start an
     * attested server that no longer measures the way it was attested.
     *
     * Absent, or `unavailable`, means no claim was made about this server and
     * there is nothing to re-measure. It never means "assume it is fine": the
     * receipt that carried such an identity already says the implementation is
     * unproven.
     */
    readonly implementation?: ToolImplementationIdentityV1;
    /** Test seam, forwarded verbatim; see {@link ToolImplementationFsProbe}. */
    readonly implementationFsProbe?: ToolImplementationFsProbe;
}
/**
 * One connected stdio MCP server.
 *
 * The lifecycle is explicit and total: `connect()` starts the child and
 * completes `initialize`, `close()` always ends the child. There is no lazy
 * reconnect and no keep-alive hook — a caller that needs the server holds the
 * client, and a caller that is finished closes it.
 */
export declare class McpStdioClient {
    private readonly server;
    private readonly options;
    private readonly client;
    private readonly transport;
    private readonly label;
    private readonly timeoutMs;
    private connected;
    constructor(server: McpStdioServerSpec, options: McpStdioClientOptions);
    /**
     * Start the child and complete `initialize`.
     *
     * An attested implementation is re-measured BEFORE the spawn, every time:
     * the artifact, the interpreter of an `interpreter+bundle`, and the
     * environment this child is about to be handed. Resolve and launch are two
     * different moments, and an identity established at the first one asserts
     * nothing about the second — so the check runs here rather than being cached
     * with the identity.
     *
     * A failure is a refusal, not a downgrade: the connection is never opened
     * with the identity quietly demoted to `unavailable`, because a server that
     * was attested and no longer measures the same is a server that changed
     * under a claim somebody relied on. It surfaces as {@link McpAuthorityError}
     * so the daemon declines the offer permanently — re-offering spawns the same
     * changed file and reaches the same verdict.
     */
    connect(signal?: AbortSignal): Promise<void>;
    /** The server's self-reported identity, as returned by `initialize`. */
    serverInfo(): {
        readonly name: string;
        readonly version: string;
    };
    /** The protocol version this connection negotiated. */
    protocolVersion(): string;
    /** Every tool the server reports, across every page. */
    listTools(signal?: AbortSignal): Promise<readonly Tool[]>;
    /**
     * Invoke one tool. An aborted `signal` cancels in band — the protocol layer
     * sends `notifications/cancelled` for the in-flight request — so a cancelled
     * call does not orphan work on the server.
     */
    callTool(name: string, args: Readonly<Record<string, unknown>> | undefined, options?: {
        readonly signal?: AbortSignal;
        readonly timeoutMs?: number;
    }): Promise<CallToolResult>;
    /** Always safe to call, including before `connect()` and more than once. */
    close(): Promise<void>;
    /**
     * Map one thrown value onto the two-way split callers act on.
     *
     * The split is retryability, and it follows WHO is at fault. A server that
     * answered — with a result that is not a valid `tools/list`, with a result
     * type nothing can read, with more pages than the client will walk, or for a
     * capability it never advertised — has stated a permanent fact about itself;
     * re-offering the task would ask the same command and get the same answer
     * forever. A server that timed out, closed, or could not be written to may
     * well succeed later.
     *
     * A JSON-RPC error response the server sent is split the same way, by
     * {@link AUTHORITY_PROTOCOL_ERROR_CODES}: a rejection of the REQUEST is
     * permanent, a report of the server's own condition is not.
     *
     * An {@link McpAuthorityError} raised inside the transport (an oversized
     * stream, a refused frame) surfaces through the client's `onerror` funnel
     * and arrives here unchanged.
     */
    private classify;
}
// ==== @byok-sdk/client dist/mcp/observation.d.ts ====
import { type McpStdioClientOptions, type McpStdioServerSpec } from './client';
/**
 * Tool names an adapter is allowed to pre-grant must be OBSERVED, never
 * configured: the daemon's own `mcpToolsets` config carries `command`/`args`
 * only (see `../daemon/toolset-registry.ts`), so the single authority for
 * "which tools does this server actually expose" is the server's own
 * `tools/list` answer.
 *
 * A name that survives this filter is about to be interpolated into runtime
 * CLI authority — `--allowedTools mcp__<server>__<tool>` for claude,
 * `mcp_servers.<server>.tools.<tool>.approval_mode` for codex, and the
 * registered Pi tool name for pi. A comma, a dot, a quote, or whitespace in a
 * tool name would forge additional grants or a different config key out of one
 * legitimate one.
 *
 * A server that reports ANY name outside this shape fails the whole
 * observation — it is rejected, and the task is declined permanently rather
 * than partially granted. Granting the well-formed subset and silently
 * dropping the rest would hand the model a toolset it can only half call, and
 * would let one bad name ride along with good ones. The shape is deliberately
 * narrower than MCP's own (unbounded) name rule.
 */
export declare const GRANTABLE_TOOL_NAME: RegExp;
/**
 * The same rule for the SERVER half of the identifier, enforced at grant
 * resolution (`../adapters/mcp-tool-grants.ts`). A projected server name is
 * interpolated into `mcp__<server>__<tool>` for claude and into the flat TOML
 * key `mcp_servers.<server>.tools.<tool>.approval_mode` for codex: a `.` would
 * split that key into a different table, and a quote, comma, or space would
 * forge a second grant out of one.
 */
export declare const GRANTABLE_MCP_SERVER_NAME: RegExp;
/** One tool exactly as its server described it. The model-visible truth, unedited. */
export interface McpToolDescriptor {
    readonly name: string;
    /** Empty string when the server supplied none; never inferred. */
    readonly description: string;
    /** The server's own JSON Schema, passed through verbatim. */
    readonly inputSchema: unknown;
}
/** Everything one `initialize` + `tools/list` exchange established about a server. */
export interface McpServerObservation {
    readonly serverName: string;
    readonly serverInfo: {
        readonly name: string;
        readonly version: string;
    };
    readonly protocolVersion: string;
    /** Ordered by tool name, code unit. */
    readonly tools: readonly McpToolDescriptor[];
}
/**
 * One observed tool plus the operator's classification of it.
 *
 * `readOnly` comes from device toolset configuration
 * (`McpToolsetConfig.readOnlyTools`) and from nowhere else — never from the
 * tool's name, its description, its schema, or the server's own
 * `annotations.readOnlyHint`, which is a self-assessment rather than a
 * security authority. The field is deliberately three-state:
 *
 * - `true`  — the device config lists this `(server, tool)` as read-only.
 * - `false` — the config classifies this tool's TOOLSET but not this tool, so
 *             it counts as a mutation tool. That is the fail-closed default: a
 *             tool an operator forgot to classify is never granted under a
 *             restricted policy.
 * - absent  — the toolset carries no classification at all. Not "it mutates"
 *             but "nobody said", which is why it stays distinguishable: a
 *             non-`auto` policy is then refused outright instead of silently
 *             resolving to an empty toolset.
 */
export interface McpClassifiedToolDescriptor extends McpToolDescriptor {
    readonly readOnly?: boolean;
}
/**
 * One observed server together with the toolset it was projected from and the
 * operator classification of each of its tools.
 *
 * Both additions are the daemon's facts, not the server's, so they are
 * attached here rather than inside {@link McpServerObservation}: the core
 * observes servers and knows nothing about the registry. Carrying them ON the
 * entry instead of in parallel `serverName -> …` maps is deliberate — two
 * structures that must agree are two structures that can disagree, and both
 * the projection's ordering and its policy filter are derived from these.
 */
export interface McpToolsetServerObservation extends Omit<McpServerObservation, 'tools'> {
    readonly toolsetId: string;
    /** Ordered by tool name, code unit. */
    readonly tools: readonly McpClassifiedToolDescriptor[];
}
/**
 * Join one raw server observation to the daemon facts about it: which toolset
 * projected it, and which of its tools the device's operator declared
 * read-only.
 *
 * `readOnlyTools` is `null` when the toolset declares no classification at
 * all — every tool then comes back unclassified, and a non-`auto` policy fails
 * later rather than being resolved into "nothing is read-only" here. A
 * declared name the server does not expose is a STALE configuration and is
 * rejected: the operator classified a tool that no longer exists, so the rest
 * of the declaration cannot be trusted to describe this server either. It
 * throws {@link McpAuthorityError} for the same reason an ungrantable tool
 * name does — the answer will not change on a retry.
 */
export declare function classifyMcpToolsetServerObservation(observation: McpServerObservation, binding: {
    readonly toolsetId: string;
    readonly readOnlyTools: readonly string[] | null;
}): McpToolsetServerObservation;
export interface ObserveMcpServerOptions extends Omit<McpStdioClientOptions, 'maxStdoutBytes'> {
    readonly signal?: AbortSignal;
}
/**
 * Structural JSON equality: same keys, same values, arrays positionally.
 *
 * Object key ORDER is not part of a JSON value, so a server that re-emits the
 * same schema with its keys in another order has not changed anything and must
 * not read as drift. This is deliberately a comparison rather than a canonical
 * serialization: introducing a second canonical form here would make this
 * module a rival authority to the native `canonicalPreparedValue` that every
 * digest in this package is computed with.
 */
export declare function jsonEquals(left: unknown, right: unknown): boolean;
/**
 * Start the exact configured stdio server, complete `initialize` +
 * `tools/list`, and return everything it said about itself.
 *
 * No `tools/call` is ever sent, so an authenticated task binding stays unused
 * until the real runtime invokes it. The child is always gone before this
 * resolves — the observation proves the server can start and enumerate its
 * tools; whoever runs it spawns their own copy.
 */
export declare function observeMcpServer(serverName: string, server: McpStdioServerSpec, options: ObserveMcpServerOptions): Promise<McpServerObservation>;
/** Why a re-observation is not the observation that was frozen. */
export type McpObservationDriftReason = 'tool_added' | 'tool_removed' | 'tool_description_changed' | 'tool_schema_changed' | 'server_info_changed' | 'protocol_version_changed';
export interface McpObservationDrift {
    readonly reason: McpObservationDriftReason;
    /** Absent for the two server-level reasons. */
    readonly toolName?: string;
    readonly detail: string;
}
/**
 * Compare a fresh observation against a frozen one and report EVERY way they
 * differ.
 *
 * Set equality, not containment: a tool that appeared is as much a drift as
 * one that vanished. A server that grew a tool between preparation and launch
 * is offering the model authority nobody froze, priced or disclosed — so an
 * extra tool is rejected rather than skipped, exactly like a missing one.
 *
 * The reasons are distinct on purpose. "The schema changed" and "a tool
 * disappeared" are different operational events with different fixes, and
 * collapsing them into one "drift" would hide which one happened.
 */
export declare function diffMcpObservation(frozen: McpServerObservation, observed: McpServerObservation): readonly McpObservationDrift[];
// ==== @byok-sdk/client dist/release-identity.d.ts ====
/** Local Agent application-release identity. It is observability data, never a protocol or capability gate. */
export interface LocalAgentReleaseIdentity {
    /** Canonical strict SemVer owned by the final Local Agent distribution. */
    version: string;
    /** Optional bounded build/content identity owned by the same distribution. */
    buildId?: string;
}
export declare const LOCAL_AGENT_RELEASE_VERSION_MAX_LENGTH = 128;
export declare const LOCAL_AGENT_RELEASE_BUILD_ID_MAX_LENGTH = 128;
/**
 * Validates, copies, and freezes a release identity at a composition boundary.
 * No normalization is performed: non-canonical input is rejected instead of
 * being rewritten into another authority.
 */
export declare function resolveLocalAgentReleaseIdentity(input: LocalAgentReleaseIdentity | undefined): Readonly<LocalAgentReleaseIdentity>;
// ==== @byok-sdk/client dist/runtime-failure.d.ts ====
/** Closed lifecycle phases for failures after an offer has been admitted. */
export type RuntimeFailurePhase = 'start' | 'run';
/** Closed semantic axis. Retryability is explicit and is never inferred from this field. */
export type RuntimeFailureCategory = 'semantic' | 'infrastructure' | 'authority';
/** The adapter's explicit retry judgment consumed by TaskRunner. */
export type RuntimeRetryDisposition = 'retryable' | 'non-retryable';
/** Disposal is deliberately separate from start/run retryability authority. */
export type RuntimeDisposalStage = 'signal' | 'quiescence' | 'cleanup';
export interface RuntimeDisposalFailureInput {
    stage: RuntimeDisposalStage;
    /** Audit-safe operational reason. It must not contain task instructions or provider credentials. */
    reason: string;
}
export interface RuntimeExecutionFailureInput {
    phase: RuntimeFailurePhase;
    category: RuntimeFailureCategory;
    retry: RuntimeRetryDisposition;
    /** Stable operator-facing reason. Provider diagnostics may be included, but are never parsed by TaskRunner. */
    reason: string;
}
/**
 * Expected failure of an owned runtime-resource disposal barrier. This never
 * carries task retryability: semantic terminal authority may already have
 * been published when disposal begins.
 */
export declare class RuntimeDisposalFailure extends Error {
    readonly stage: RuntimeDisposalStage;
    constructor(input: RuntimeDisposalFailureInput, options?: ErrorOptions);
}
export declare function isRuntimeDisposalFailure(value: unknown): value is RuntimeDisposalFailure;
/**
 * The only expected post-admission failure value accepted from a runtime
 * adapter. Diagnostic AgentEvents remain observability; this value alone is
 * terminal control authority.
 */
export declare class RuntimeExecutionFailure extends Error {
    readonly phase: RuntimeFailurePhase;
    readonly category: RuntimeFailureCategory;
    readonly retry: RuntimeRetryDisposition;
    constructor(input: RuntimeExecutionFailureInput, options?: ErrorOptions);
}
export declare function isRuntimeExecutionFailure(value: unknown): value is RuntimeExecutionFailure;
export interface RuntimeFailureProjection {
    reason: string;
    retryable: boolean;
}
/**
 * Exhaustive wire projection for a valid typed failure. A failure from the
 * wrong phase is an invalid adapter state and must be handled as an untyped
 * contract violation by the caller.
 */
export declare function projectRuntimeExecutionFailure(failure: RuntimeExecutionFailure): RuntimeFailureProjection;
export declare const RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON: Readonly<{
    start: string;
    run: string;
}>;
/**
 * Validate an adapter boundary. Unknown values and typed failures reported
 * for the wrong phase fail closed; their source value is returned only as a
 * local diagnostic cause and never influences wire semantics.
 */
export declare function projectRuntimeBoundaryFailure(value: unknown, expectedPhase: RuntimeFailurePhase): RuntimeFailureProjection & {
    contractViolation: boolean;
};
/** A failed startup whose process tree has not yielded a disposal receipt. */
export declare class RuntimeStartupDisposalFailure extends Error {
    readonly retryDisposal: () => Promise<void>;
    constructor(retryDisposal: () => Promise<void>, options?: ErrorOptions);
}
export declare function isRuntimeStartupDisposalFailure(value: unknown): value is RuntimeStartupDisposalFailure;
// ==== @byok-sdk/client dist/sdk-reserved-helper-host.d.ts ====
export declare const BYOK_SDK_HELPER_SUBCOMMAND = "__byok_sdk_helper";
export type SdkReservedHelperKind = 'agent-message-mcp' | 'agent-memory-mcp' | 'approval-mcp' | 'agent-team-mcp' | 'mcp-env' | 'pi-rpc' | 'pi-prepared';
export interface SdkHelperHostConfig {
    /**
     * Run SDK-reserved helpers by re-entering the product's single-file/SEA
     * executable. The product entrypoint must call
     * {@link runSdkReservedHelperCommand} before its own argument parser.
     */
    readonly mode: 'self-executable';
    /** Absolute product executable path. Defaults to this process's executable. */
    readonly executable?: string;
    /** Absolute SDK-bearing entry script when executable is an interpreter. */
    readonly entry?: string;
}
export interface ResolvedSdkReservedHelperBin {
    readonly command: string;
    readonly args: readonly string[];
    readonly source: 'dist-script' | 'self-executable';
}
/** SDK-owned launcher shape used by every reserved stdio helper. */
export declare function resolveSdkReservedHelperBin(kind: SdkReservedHelperKind, host?: SdkHelperHostConfig): ResolvedSdkReservedHelperBin;
/**
 * Product entrypoint seam for single-file/SEA hosts. Returns `false` without
 * side effects for normal product commands; a reserved command is handled to
 * stdio EOF before this resolves `true`.
 */
export declare function runSdkReservedHelperCommand(argv?: readonly string[]): Promise<boolean>;
// ==== @byok-sdk/client dist/sdk-reserved-mcp.d.ts ====
/** SDK-owned names shared by daemon injection, adapter policy, and MCP helpers. */
export declare const AGENT_MESSAGE_MCP_SERVER_NAME = "byokagentmessage";
export declare const AGENT_MESSAGE_TOOL_NAME = "send_agent_message";
export declare const AGENT_MEMORY_MCP_SERVER_NAME = "byokagentmemory";
export declare const AGENT_TEAM_MCP_SERVER_NAME = "byokagentteam";
/** The MCP server NAME the claude adapter registers `byok-approval-mcp` under in its generated `--mcp-config` — combined with `APPROVAL_TOOL_NAME` (single-sourced from `bin/approval-mcp-server.ts`) to form the `mcp__<server>__<tool>` identifier `--permission-prompt-tool` expects. Lives here, beside the other reserved names, so `toolset-registry.ts`'s host-config rejection and the adapters' own "never treat a reserved server as a projected toolset server" rule read from one list. */
export declare const APPROVAL_MCP_SERVER_NAME = "byokapproval";
/**
 * Every MCP server name the SDK owns. A server under one of these names is
 * never a projected host toolset server: `toolset-registry.ts` refuses to
 * configure one, and the adapters grant each reserved server exactly the
 * fixed tool its own protocol needs rather than anything observed.
 *
 * A frozen tuple rather than a `Set`: `Object.freeze` on a `Set` freezes the
 * object's own properties and leaves `add`/`delete` fully functional, so the
 * previous shape advertised an immutability it did not have. Three entries
 * make `includes` the same cost as a hash lookup, and the array really is
 * immutable. Use {@link isReservedMcpServerName} rather than reaching for
 * membership directly.
 */
export declare const RESERVED_MCP_SERVER_NAMES: readonly ["byokagentmessage", "byokagentmemory", "byokapproval", "byokagentteam"];
/** Whether `name` is one of the SDK-owned MCP server names above. */
export declare function isReservedMcpServerName(name: string): boolean;
// ==== @byok-sdk/client dist/types.d.ts ====
import type { ToolImplementationAuthority, ToolImplementationUnavailableReasonV1 } from '@byok-sdk/implementation-identity';
import type { PiRuntimeLaunchResources } from './adapters/pi/runtime-launch';
import type { AgentEvent, PermissionMode, PermissionPolicy, TaskOfferPayload } from '@byok-sdk/protocol';
import type { InputPreparationModelV1 } from './input-preparation';
import type { RuntimeEnvironmentRequirements } from './daemon/environment';
import type { McpLaunchBinding } from './daemon/trusted-launch-cwd';
import type { ToolImplementationIdentityV1 } from './daemon/tool-implementation-identity';
import type { AgentRef } from './agent-home';
import type { McpToolsetServerObservation } from './mcp/observation';
export type { AgentRef } from './agent-home';
export type { McpServerObservation, McpToolDescriptor, McpToolsetServerObservation, } from './mcp/observation';
export type { AgentEgressPolicy } from '@byok-sdk/protocol';
export type { RuntimeEnvironmentRequirements } from './daemon/environment';
export type { LaunchCwdRejection, McpLaunchBinding, McpLaunchCwdConfig, TrustedLaunchCwd, TrustedLaunchCwdUnavailableReason, } from './daemon/trusted-launch-cwd';
export interface GitWorkspaceConfig {
    mode: 'local-checkpoints';
}
/**
 * Failure vocabulary shared by the detection contract and local diagnostics.
 */
export declare const RUNTIME_DETECTION_FAILURE_KINDS: readonly ['not-found', 'not-executable', 'timeout', 'probe-failed', 'refused'];
/**
 * One probe outcome, never a separately authored presence boolean. Authentication
 * observation retains each adapter's native status/env-name probe and never
 * reads credential storage. Failure variants contain no arbitrary diagnostics.
 */
export type RuntimeDetectResult = {
    readonly kind: 'available';
    readonly version?: string;
    readonly authPresent?: boolean;
} | {
    readonly kind: Exclude<typeof RUNTIME_DETECTION_FAILURE_KINDS[number], 'refused'>;
} | {
    readonly kind: 'refused';
    readonly reason: RuntimeDetectionRefusalReason;
};
export type RuntimeDetectionRefusalReason = ToolImplementationUnavailableReasonV1 | 'installation_observation_unsupported' | 'native_identity_mismatch' | 'launch_cwd_unavailable';
/** Explicit scope, never a launch environment or task/lane-selection authority. */
export type RuntimeInstallationObservationContext = {
    readonly authority: ToolImplementationAuthority;
} & ({
    readonly scope: 'entry';
    readonly runtimeEntry: 'pi-rpc' | 'pi-prepared';
} | {
    readonly scope: 'enabled-top-level';
});
/** What a runtime adapter can do, advertised so the daemon can pick/validate adapters. */
export interface RuntimeCapabilities {
    readonly steer: boolean;
    readonly resume: boolean;
    /**
     * Whether this adapter can project task-scoped, locally configured MCP
     * servers into the runtime without accepting executable definitions from
     * the remote task. Omission is fail-closed and means unsupported.
     */
    readonly mcpToolsets?: boolean;
    /**
     * Whether this adapter can genuinely pause a running session on
     * `needs_approval` and resume it from an out-of-band decision — i.e.
     * whether {@link Session.resolveApproval} really resolves rather than
     * throwing. This is the ONLY source of truth for the wire's
     * `RuntimeInfo.capabilities.approvalInteractive` (`daemon/
     * create-daemon.ts`'s `toRuntimeInfoCapabilities`); the daemon no longer
     * hardcodes a value.
     *
     * Required, deliberately: a new adapter (or a test fake) that forgets to
     * declare it fails to compile rather than silently defaulting to a claim
     * it cannot back.
     */
    readonly approvalInteractive: boolean;
    /** Subset of {@link PermissionPolicy}'s `mode` values this adapter can express without widening. */
    readonly permissionModes: readonly string[];
}
/** One local stdio MCP server definition. Remote task payloads can never supply this shape. */
export interface McpStdioServerConfig {
    command: string;
    args?: readonly string[];
    /** SDK-reserved task-scoped servers may receive child-only context. Host toolset configuration rejects this field. */
    env?: Readonly<Record<string, string>>;
}
/** A logical group of local MCP servers selectable by a wire-level toolset id. */
export interface McpToolsetConfig {
    mcpServers: Readonly<Record<string, McpStdioServerConfig>>;
    /**
     * The operator's own read/mutation classification of this toolset's tools,
     * per `(server, tool)`. It is what makes a permission mode other than `auto`
     * expressible for a toolset task at all.
     *
     * The device configuration owner declares it and nothing else may. A
     * server's own `annotations.readOnlyHint` is that server's self-assessment
     * rather than a security authority, and a tool's name, description or schema
     * is not evidence of anything — inferring the classification from any of
     * them would be exactly the heuristic that makes a permission boundary
     * meaningless.
     *
     * Two fail-closed defaults follow, both enforced by
     * `filterMcpObservationForPolicy` (`mcp/projection.ts`): a tool the server
     * exposes that this declaration omits is treated as a MUTATION tool, and a
     * toolset carrying no declaration at all cannot run under a non-`auto`
     * policy — the refusal names the missing classification rather than quietly
     * running with every tool enabled.
     *
     * The registry validates it strictly (every server named here must be
     * defined in `mcpServers`, every tool name must be grantable, no
     * duplicates), the daemon cross-checks it against each server's own
     * `tools/list` answer before admission (a classified tool the server does not
     * expose is a stale config and is rejected), and it is folded into the
     * toolset's `definitionRevision` — so changing a classification changes the
     * toolset revision and therefore every executor fingerprint derived from it.
     */
    readOnlyTools?: Readonly<Record<string, readonly string[]>>;
}
/** Lifecycle facts a device host may explicitly report for one configured toolset. */
export type McpToolsetLifecycleState = 'installed' | 'unauthorized' | 'starting' | 'ready' | 'degraded' | 'crashed' | 'incompatible';
/**
 * One host-owned lifecycle observation. The SDK validates and projects this
 * evidence but never derives it from executable configuration or command
 * presence. `reasonCode` is a bounded machine code, not arbitrary log text.
 */
export interface McpToolsetObservation {
    state: McpToolsetLifecycleState;
    observedAt: string;
    version?: string;
    reasonCode?: string;
}
/** Redacted status for one configured toolset; executable definitions are absent by construction. */
export interface McpToolsetStatus {
    id: string;
    serverCount: number;
    definitionRevision: string;
    observation?: Readonly<McpToolsetObservation>;
}
/** Content-addressed status of the daemon's complete device-local toolset registry. */
export interface McpToolsetRegistryStatus {
    revision: string;
    toolsets: readonly Readonly<McpToolsetStatus>[];
}
/** Receipt returned after an atomic, expected-revision registry reload. */
export interface McpToolsetReloadReceipt {
    previousRevision: string;
    revision: string;
    changed: boolean;
    toolsets: readonly Readonly<McpToolsetStatus>[];
}
/**
 * M4 Phase 3: the out-of-band approval channel `TaskRunner` (`daemon/
 * task-runner.ts`) hands to a prepared operation's `start()` via
 * `RuntimeOperationStartInput.approvalChannel`, for a runtime whose approval mechanism genuinely needs
 * to reach back into the daemon from OUTSIDE the adapter's own process — the
 * claude adapter's concrete case: `claude`'s `--permission-prompt-tool`
 * resolves a pending permission entirely inside a SEPARATE MCP-server child
 * process claude itself spawns (see `bin/byok-approval-mcp.ts`), which has
 * no in-process handle to this task's `Session` at all and must instead call
 * back into the SAME daemon over its control socket. `storeDir`/`productId`
 * are exactly what that out-of-process helper needs to find and authenticate
 * against this daemon's control socket (`daemon/control-protocol.ts`
 * `controlEndpointPath`/`controlTokenPath`); `taskId` is how its request gets
 * correlated back to THIS task once it arrives. `resolve()` is the
 * daemon-side counterpart: it resolves the single most-recently-registered
 * pending approval for this task (via `TaskRunner.requestApproval`'s own
 * `ApprovalRegistry` entry — see `daemon/approvals.ts`), and rejects if none
 * is currently pending, mirroring `Session.resolveApproval`'s own
 * no-notion-of-approval-pending fail-closed contract one level up.
 *
 * Optional and adapter-agnostic on purpose: only an adapter whose runtime
 * genuinely supports an out-of-band pause (claude, today) ever reads this;
 * every other adapter (pi, codex) ignores it exactly as before this field
 * existed.
 */
export interface ApprovalChannel {
    taskId: string;
    storeDir: string;
    productId: string;
    /** Default wait (ms) before the daemon force-resolves an unanswered approval request as a fail-closed rejection — see `TaskRunner.requestApproval`. */
    timeoutMs: number;
    /** Resolve the single currently-pending out-of-band approval for this task. Rejects if none is pending right now. */
    resolve(approved: boolean, reason?: string): Promise<void>;
}
/**
 * A running (or resumable) unit of work on a runtime. One `Session` maps to
 * one underlying runtime process/session for the lifetime of a task.
 */
export interface Session {
    /** Opaque runtime session id, reported back to the server via `task.complete.sessionRef`. */
    sessionRef: string;
    /** Normalized events for this session; the daemon batches these into `task.progress`. */
    events: AsyncIterable<AgentEvent>;
    /** Inject steering text into a running turn (mid-stream). */
    steer(text: string): Promise<void>;
    /** Send a new instruction on the same session after it has gone idle. */
    followUp(task: TaskOfferPayload): Promise<void>;
    /** Best-effort abort of the current turn (used for `task.cancel`). */
    interrupt(): Promise<void>;
    /**
     * Bounded, idempotent disposal receipt. Resolution proves every
     * adapter-owned process and task-scoped resource is quiescent. Expected
     * failure rejects with `RuntimeDisposalFailure` and never changes task
     * semantics.
     */
    close(): Promise<void>;
    /**
     * Resolve a session paused on `needs_approval` (protocol §5). The
     * server's own state has already moved by the time this is called (§4 —
     * `task.approve`/`task.reject` are best-effort notifications, not
     * requests awaiting a reply): `approved: true` must make the session
     * resume producing events (`task.progress` continuing is the proof);
     * `approved: false` means the caller will immediately follow up with
     * `interrupt()` + `close()` and report `task.fail` — an adapter that has
     * no notion of `needs_approval` at all (i.e. never emits one) should
     * throw a descriptive error here rather than silently no-op, since a
     * caller receiving `task.approve`/`task.reject` for one of its tasks
     * implies something upstream expected approval support that isn't there.
     */
    resolveApproval(approved: boolean, reason?: string): Promise<void>;
}
/**
 * Immutable runtime facts shared by discovery and one prepared operation.
 *
 * The SDK snapshots this value before each offer and never consults adapter
 * capability authority again during admission, claim, environment projection,
 * or start. Credential declarations are names only, never values.
 */
export interface RuntimeAdapterDescriptor {
    readonly id: string;
    readonly capabilities: RuntimeCapabilities;
    readonly environmentRequirements: RuntimeEnvironmentRequirements;
    /** Explicit opt-in to authoritative `task.offer.dispatchSelection` semantics. */
    readonly supportsDispatchSelection: boolean;
    /**
     * Whether this adapter actually CONSUMES
     * {@link RuntimeAdapterPrepareInput.mcpToolsetTools} — i.e. whether it
     * needs the daemon to observe each projected toolset server before
     * admission, because it binds those tools into the runtime's own surface:
     * claude's `--allowedTools`, codex's `enabled_tools` + per-tool
     * `approval_mode`, and pi's per-tool registration of the observed schemas.
     *
     * The daemon uses this, and only this, to decide whether to pay for the
     * pre-admission `tools/list` observation of every projected server
     * (`daemon/mcp-tools-probe.ts`). An adapter that consumes no observation
     * never makes an offer wait on one it has no use for.
     *
     * Omission is fail-closed in the direction that matters: no observation
     * means no names and no schemas, and an adapter that does consume the
     * observation rejects a projected server it has neither for
     * (`adapters/mcp-tool-grants.ts`). A grant is never widened by a missing
     * declaration.
     */
    readonly requiresMcpToolsetToolObservation?: boolean;
    /**
     * HOW this adapter's MCP toolset server children get the trusted launch
     * working directory (`daemon/trusted-launch-cwd.ts`).
     *
     * `'direct-cwd'` — the adapter spawns the servers itself and passes the
     * directory to `spawn` (pi: its SDK-owned extension opens each server from
     * the task-scoped config the adapter writes).
     *
     * `'launcher-wrapped'` — an external CLI spawns the servers from a
     * configuration format with no per-server cwd field (claude's `mcpServers`
     * JSON, codex's `-c mcp_servers.*`), so the adapter must rewrite each
     * server's `command`/`args` through this package's
     * `bin/byok-launch-cwd.mjs`.
     *
     * Optional, including for an adapter declaring `capabilities.mcpToolsets`.
     * `TaskRunner` resolves the trusted directory for every such task and hands
     * it to the adapter, but it resolves a LAUNCHER only for
     * `'launcher-wrapped'`; a host platform where no launcher is available then
     * declines the offer non-retryably. An adapter that declares nothing is
     * admitted with no launcher, exactly like `'direct-cwd'`, and is itself
     * responsible for starting its MCP server children in the trusted
     * directory it was handed: the SDK cannot make a third-party adapter launch
     * through a launcher by declining here. The three bundled adapters all
     * declare their mode explicitly.
     */
    readonly mcpServerLaunch?: 'direct-cwd' | 'launcher-wrapped';
    /**
     * Whether this adapter GENERATES a reserved approval MCP server of its own
     * when it is started under `policy.mode: 'confirm'` (claude's
     * `--permission-prompt-tool` server, `adapters/claude/claude-adapter.ts`).
     *
     * Such a server exists nowhere in the daemon's projected `mcpServers` map,
     * so the daemon cannot see it by counting that map — but it is an MCP
     * server child of the task like any other, and it must start in the same
     * proven-non-writable launch directory (`daemon/trusted-launch-cwd.ts`).
     * `TaskRunner` therefore resolves the launch binding for a `confirm`-mode
     * task on an adapter that declares this, even when the task projects no
     * host toolset and needs no reserved helper at all.
     *
     * Omission means "generates none": an adapter that generates one and does
     * not declare it would receive no binding and its own fail-closed guard
     * refuses the start rather than launching the server unwrapped.
     */
    readonly generatesApprovalMcpServer?: boolean;
}
/** The pure input to one adapter admission decision. It contains no credential values or workspace resources. */
export interface RuntimeAdapterPrepareInput {
    /** Admission cancellation; late pure results are discarded and never started. */
    signal?: AbortSignal;
    offer: TaskOfferPayload;
    policy: PermissionPolicy;
    descriptor: RuntimeAdapterDescriptor;
    requiredToolsetIds: readonly string[];
    /** Locally resolved MCP authority; available for pure admission validation only. */
    mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
    /** {@link McpToolsetToolObservation} for exactly the projected toolset servers in `mcpServers`. */
    mcpToolsetTools?: McpToolsetToolObservation;
}
/**
 * What each projected toolset MCP server said about itself when the daemon
 * started it and read its own `initialize` + `tools/list` answer
 * (`daemon/mcp-tools-probe.ts`), keyed by the projected server name.
 * SDK-reserved servers are never keyed here — they carry their own fixed,
 * single-tool grants inside the adapters.
 *
 * This is the ONLY authority an adapter may bind a runtime to. Device toolset
 * configuration carries `command`/`args` only, so a configured value could
 * never say what a server exposes; a tool absent from this observation is a
 * tool no runtime is ever told about.
 *
 * It carries FULL descriptors — name, description and the server's own
 * `inputSchema` — plus the server identity and negotiated protocol version,
 * because the three runtimes need different parts of the same fact and only
 * one of them can be authoritative. claude and codex pre-grant by name; pi
 * registers one tool per MCP tool with the real schema; the prepared launch
 * path binds the schema digest into a frozen tool manifest. The names-only
 * view every grant resolver uses is DERIVED from this
 * (`mcp/projection.ts`'s `mcpToolsetToolNames`), never carried alongside it —
 * a separately transported name list would be a second authority free to
 * disagree with the schemas the model was actually shown.
 */
export type McpToolsetToolObservation = Readonly<Record<string, McpToolsetServerObservation>>;
/** A permanent or currently-unavailable pre-claim admission rejection. */
export interface RuntimeAdapterRejectedOperation {
    kind: 'reject';
    reason: string;
    retryable: boolean;
}
/** The side-effect-free adapter decision made before TaskRunner claims an offer. */
export interface RuntimeAdapterPreparedOperation {
    kind: 'prepared';
    operation: PreparedRuntimeOperation;
}
export type RuntimeAdapterPrepareResult = RuntimeAdapterRejectedOperation | RuntimeAdapterPreparedOperation;
/**
 * Credential-free immutable identity for one admitted runtime operation.
 * It can be emitted, compared, and passed to a prepared operation, but never
 * serializes environment values or credential material.
 */
export interface RuntimeOperationManifest {
    readonly taskId: string;
    /** Selected runtime id; lane/provider/model, when present, live only in `dispatchSelection`. */
    readonly runtimeId: string;
    readonly descriptor: RuntimeAdapterDescriptor;
    readonly policy: PermissionPolicy;
    readonly requiredToolsetIds: readonly string[];
    /** The credential-free runtime/lane/provider/model authority for this operation. */
    readonly dispatchSelection?: TaskOfferPayload['dispatchSelection'];
    readonly sessionRef?: string;
    /** Strict Agent identity, present only for task.offer_for_agent. */
    readonly agentRef?: AgentRef;
    /** Canonical runtime cwd; for an Agent task this is the Agent home root. */
    readonly cwd?: string;
    /** Opaque local lease identity sealed with the Agent manifest. */
    readonly lease?: {
        readonly leaseId: string;
        readonly canonicalHome: string;
    };
    readonly workspace: {
        readonly workspaceDir: string;
        readonly workspaceId?: string;
        readonly baseline?: string;
    };
    /** Names are audit-safe; credential values intentionally never enter the manifest. */
    readonly forwardedEnvironmentNames: readonly string[];
}
/**
 * The durable identity of one already-counted preparation record
 * (`daemon/input-preparation-store.ts`'s {@link InputPreparationRecordKey} plus
 * its derived `recordId`).
 *
 * Carried so a prepared launch names the record it consumes rather than being
 * handed anonymous bytes: the launch is refused if the artifact on disk does
 * not carry this `recordId`.
 */
export interface RuntimePreparedLaunchReferenceV1 {
    readonly scopeId: string;
    readonly agentRef: string;
    readonly requestId: string;
    readonly recordId: string;
}
/**
 * The independently trusted expectations the native prepared-input verifier
 * requires (`@earendil-works/pi-coding-agent/prepared-session-input`'s
 * `PreparedSessionExpectedV1`).
 *
 * They come from the DURABLE record — its artifact summary and its binding —
 * never from the artifact file itself. The native contract is explicit that a
 * value read out of the envelope can never serve as its own expectation, so
 * carrying them here is what makes the envelope on disk checkable at all.
 */
export interface RuntimePreparedLaunchExpectationV1 {
    /** `InputPreparationArtifactSummaryV1.envelopeDigest`. */
    readonly envelopeDigest: string;
    /** `InputPreparationArtifactSummaryV1.toolManifestDigest`. */
    readonly toolManifestDigest: string;
    /** The exact model identity the record's binding pinned. */
    readonly model: InputPreparationModelV1;
    /** The compiler binding the record's request was compiled under. */
    readonly binding: {
        readonly inputIdentity: string;
        readonly runtimeIdentity: string;
        readonly policyIdentity: string;
        readonly profileRevision: string;
    };
}
/**
 * Everything one prepared Execution needs to launch the frozen request it was
 * counted for.
 *
 * There is no `instruction` here and no way to supply one: the user request is
 * already inside the frozen envelope, and a prepared run that accepted a
 * separate instruction would have two answers to what it is about to send.
 *
 * The admitted permission POLICY is not repeated — it is
 * `RuntimeOperationManifest.policy`, already sealed. Only the mode the manifest
 * was COUNTED for is carried, so the adapter can refuse a manifest admitted
 * under a different mode instead of discovering the divergence as tool drift.
 */
export interface RuntimePreparedLaunchV1 {
    readonly reference: RuntimePreparedLaunchReferenceV1;
    /**
     * Absolute path of the retained `InputPreparationArtifact` JSON.
     *
     * A path rather than inline bytes on purpose: the artifact carries D, P(D)
     * and the whole native envelope, and there is exactly one retained copy of
     * it. A second inline representation would be a second authority over the
     * same bytes.
     */
    readonly artifactPath: string;
    readonly expected: RuntimePreparedLaunchExpectationV1;
    /** The mode `daemon/prepared-tool-surface.ts` filtered the counted manifest for. */
    readonly permissionMode: PermissionMode;
    readonly toolBindingDigest: string;
    readonly observationDigest: string;
    /** The same trusted launch boundary the preparation observed every server under. */
    readonly launch: McpLaunchBinding;
    /** The implementation identity the preparation resolved per projected server. */
    readonly toolImplementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
    /** `toolsetId` -> the registry definition revision the preparation bound. */
    readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
}
/** Runtime resources shared by every start variant. */
interface RuntimeOperationStartBase {
    readonly runtimeLaunch?: PiRuntimeLaunchResources;
    /** Exact daemon MCP admission environment; Pi requires it and never inherits runtime credentials. */
    readonly mcpEnv?: Readonly<Record<string, string>>;
    /** Startup cancellation only; rejection must preserve unresolved process ownership. */
    readonly signal?: AbortSignal;
    readonly manifest: RuntimeOperationManifest;
    readonly env: NodeJS.ProcessEnv;
    /** Local MCP authority resolved from logical wire ids. */
    readonly mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
    /** {@link McpToolsetToolObservation} for exactly the projected toolset servers in `mcpServers`. */
    readonly mcpToolsetTools?: McpToolsetToolObservation;
    /**
     * The proven-non-writable directory every MCP toolset server child of this
     * task is launched in, plus the launcher an external CLI needs to reach it.
     *
     * Resolved ONCE per offer by `TaskRunner` (`daemon/trusted-launch-cwd.ts`)
     * and carried here so every spawn site of one task agrees on one directory.
     * Present whenever `mcpServers` is; an adapter that finds MCP servers
     * without it must refuse rather than fall back to its own cwd.
     */
    readonly mcpLaunch?: McpLaunchBinding;
    /**
     * What this daemon established about the implementation behind each
     * projected toolset server, keyed by projected server name
     * (`daemon/tool-implementation-identity.ts`).
     *
     * Resolved ONCE per offer by `TaskRunner`, alongside the launch binding
     * above and for the same reason: the admission probe and every adapter spawn
     * of one task must be talking about the same install. An adapter that spawns
     * toolset servers itself carries these values to its spawn point unchanged;
     * it never resolves its own.
     */
    readonly mcpToolImplementations?: Readonly<Record<string, ToolImplementationIdentityV1>>;
    /** Optional, adapter-agnostic out-of-band approval channel. */
    readonly approvalChannel?: ApprovalChannel;
}
/** The ordinary start: a resolved instruction the runtime turns into its own first request. */
export interface RuntimeOperationInstructionStartInput extends RuntimeOperationStartBase {
    readonly kind: 'instruction';
    readonly instruction: string;
}
/**
 * The prepared start: an already-compiled, already-counted provider request the
 * runtime must send verbatim.
 *
 * A separate variant rather than an optional field beside `instruction`,
 * because the two are mutually exclusive authority over the same bytes: with
 * both reachable on one shape every adapter would have to decide which one
 * wins, and the answer would be written three times.
 */
export interface RuntimeOperationPreparedStartInput extends RuntimeOperationStartBase {
    readonly kind: 'prepared';
    readonly preparation: RuntimePreparedLaunchV1;
}
/**
 * Runtime resources only available after TaskRunner has sealed the manifest and
 * claimed the task.
 *
 * Discriminated, not an optional bag: an adapter that does not implement the
 * prepared lane must refuse it by name, and a union is what makes forgetting to
 * a compile error rather than a silently ignored field.
 */
export type RuntimeOperationStartInput = RuntimeOperationInstructionStartInput | RuntimeOperationPreparedStartInput;
/** A pinned provider/runtime decision. `start()` receives resources only, never a raw offer. */
export interface PreparedRuntimeOperation {
    /** Resource phase after workspace resolution and before claim; never reads a credential. */
    resolveRuntimeLaunch?(input: {
        kind: 'instruction' | 'prepared';
        cwd: string;
        env: Readonly<Record<string, string | undefined>>;
        projectionRoot: string;
        authority?: ToolImplementationAuthority;
    }): Promise<PiRuntimeLaunchResources>;
    start(input: RuntimeOperationStartInput): Promise<Session>;
}
/**
 * Uniform public adapter seam. `prepare()` is required and must not spawn,
 * create temp files, mutate a workspace, allocate a session id, or read a
 * credential value. There is intentionally no direct `RuntimeAdapter.start`.
 */
export interface RuntimeAdapter {
    readonly descriptor: RuntimeAdapterDescriptor;
    /** Readiness probing must not mutate an Agent home or allocate execution ownership. */
    detect(signal?: AbortSignal): Promise<RuntimeDetectResult>;
    /** Configured local installation observation. Absence refuses; it never falls back to detect. */
    detectInstallation?(context: RuntimeInstallationObservationContext, signal?: AbortSignal): Promise<RuntimeDetectResult>;
    prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
}
/** Copy then deeply freeze descriptor authority so callers cannot retain a mutable source reference. */
export declare function freezeRuntimeAdapterDescriptor(descriptor: RuntimeAdapterDescriptor): RuntimeAdapterDescriptor;
/** Copy then freeze the complete safe operation authority just before claim. */
export declare function sealRuntimeOperationManifest(manifest: RuntimeOperationManifest): RuntimeOperationManifest;
/**
 * Thrown by a prepared operation's `start()` when an already admitted task
 * cannot continue because an internal invariant was violated. Permanent
 * offer semantics are rejected by `RuntimeAdapter.prepare()` before claim;
 * this class remains for post-claim operational/session failures whose
 * retryability is already part of the frozen task behavior.
 */
export declare class PolicyUnsupportedError extends Error {
    constructor(message: string);
}
/**
 * Thrown by {@link Session.steer} on an adapter whose runtime has no
 * mid-turn steering channel at all (`descriptor.capabilities.steer === false`) — a
 * permanent property of the runtime, never a transient failure. Typed
 * rather than a bare `Error` so the daemon can classify an inbound
 * `task.steer` for such a runtime as non-retryable (record + ack, cursor
 * advances) instead of stalling the cursor on it forever, without matching
 * on message strings.
 */
export declare class SteerUnsupportedError extends Error {
    /** The `RuntimeAdapter.descriptor.id` that cannot steer (e.g. `claude`, `codex`). */
    readonly runtimeId: string;
    constructor(runtimeId: string, message: string);
}
// ==== @byok-sdk/client dist/util/secure-dir.d.ts ====
import { type Runner } from '../lifecycle/exec-runner';
/**
 * Pure command-construction seam (finding F7) — kept separate from the
 * actual `icacls` invocation below so it's unit-testable on ANY host OS,
 * not just win32 (this whole SDK is developed on darwin/linux — see
 * `templates/service/winsw/smoke-test.mjs`'s own header comment on the
 * identical constraint for WinSW itself).
 *
 * Removes inherited ACEs (`/inheritance:r`) and grants FULL CONTROL,
 * recursively (`(OI)(CI)F` — Object Inherit, Container Inherit, Full
 * control — so anything created under `dir` afterward inherits the SAME
 * restriction without needing to be re-ACL'd individually) to exactly
 * three principals:
 *
 * - the current user, via `os.userInfo().username` — deliberately NOT the
 *   `%USERNAME%` environment variable a hand-typed reference command might
 *   use: an env var can be stale, unset, or (in an unusual but real
 *   embedding) spoofed by whatever set up this process's environment;
 *   querying the OS directly cannot be. This one genuinely has to be a
 *   NAME (icacls has no "current user" SID shorthand), but it's the
 *   account's real name, not a translated built-in label.
 * - `SYSTEM` and `Administrators` — both needed for a Windows-SERVICE
 *   topology, where the daemon runs as `SYSTEM` (a WinSW-installed
 *   service's default account) while an operator's interactive CLI
 *   invocation runs as a normal user against the SAME `storeDir` — see
 *   `control-protocol.ts`'s `controlPipeName` doc comment for the
 *   identical service-account rationale on the pipe-naming side. Finding
 *   R4: referenced by their WELL-KNOWN SIDs ({@link SYSTEM_SID} /
 *   {@link ADMINISTRATORS_SID}), not the display names `SYSTEM`/
 *   `Administrators` — those two names are LOCALIZED (e.g. a
 *   French-language Windows renders the Administrators group as
 *   "Administrateurs"), so `icacls ... /grant Administrators:...` would
 *   silently fail to resolve (and thus fail the whole hardening step) on
 *   any non-English install. The SIDs themselves are invariant across
 *   every locale/edition; `icacls` accepts SID form directly when prefixed
 *   with `*` (its own documented syntax).
 *
 * Returns a plain ARGV array with NO manually-embedded quote characters —
 * this is meant for `child_process.execFile`'s array form (this codebase's
 * own established convention for every external command it ever runs; see
 * `lifecycle/exec-runner.ts`'s `defaultRunner`), which is never a shell and
 * so has no shell-quoting hazard for a `dir`/username containing spaces —
 * Node's own Windows argv encoding (used internally by `execFile`/`spawn`
 * when given an array) already quotes/escapes each element correctly
 * regardless of embedded whitespace. Hand-rolling literal `"` characters
 * into an array element bound for that API would risk DOUBLE-quoting
 * instead of fixing anything — the icacls reference command sometimes
 * quoted as `"%USERNAME%":(OI)(CI)F` is a shell/cmd.exe-level concern that
 * simply does not apply once argv is passed as an array with no shell
 * involved.
 */
export declare function buildIcaclsArgs(dir: string, username: string): string[];
/** Restrictive ACL for one already-created file; no inheritance flags because the target cannot contain children. */
export declare function buildIcaclsFileArgs(filePath: string, username: string): string[];
export interface EnsureSecureDirOptions {
    /** DI for tests — see `lifecycle/exec-runner.ts`'s identical `Runner` seam. Defaults to `defaultRunner` (real `execFile`, never a shell). */
    run?: Runner;
    /** DI for tests — lets the win32 branch below be exercised (with a fake `run`) from any host OS, mirroring `control-protocol.ts`'s `controlEndpointPath` platform-override convention. Defaults to `process.platform`. */
    platform?: NodeJS.Platform;
}
/**
 * Finding R4 (cross-model re-review — F7 residual): thrown by
 * {@link ensureSecureDir} on win32 when `icacls` either could not be run at
 * all (e.g. missing binary, or a restricted service account lacking
 * permission to spawn it) or ran and exited non-zero (e.g. it couldn't
 * resolve a principal, or was itself denied). This directory's contents —
 * `device.json` (an Ed25519 private key + access token) or `control.token`
 * (the control socket's HMAC secret) — would otherwise be protected by
 * nothing but the OS's own default ACL, typically readable by any local
 * user; see `docs/security.md`'s own note on why this is now fail-closed
 * rather than a logged-and-ignored warning. See {@link ensureSecureDir}'s
 * own doc comment for how each caller (`DeviceStore.save`,
 * `control-server.ts`'s `startControlServer`) reacts to this.
 */
export declare class SecureDirHardeningError extends Error {
    readonly dir: string;
    constructor(dir: string, reason: string);
}
export declare class SecureFileHardeningError extends Error {
    readonly filePath: string;
    constructor(filePath: string, reason: string);
}
/**
 * Creates (if needed) and secures `dir`: POSIX `{mode: 0o700}` plus a
 * best-effort `chmod` re-assertion on every platform (unchanged from
 * before this fix — this is what actually restricts access on
 * darwin/linux), PLUS — win32 only — a restrictive DACL via `icacls` (see
 * `buildIcaclsArgs`'s own doc comment for exactly what it grants/removes).
 *
 * Finding R4 (cross-model re-review): the win32 `icacls` step is now
 * FAIL-CLOSED — it used to be best-effort (logged via `console.warn`,
 * never thrown), which meant a host where `icacls` genuinely can't run
 * (missing binary, a locked-down service account) would silently create
 * `storeDir` with NO Windows-side ACL protection at all and carry on as if
 * nothing were wrong. Now it THROWS {@link SecureDirHardeningError}
 * instead, on both failure shapes (the spawn itself failing, or `icacls`
 * running and exiting non-zero). Each real caller already has (or gets,
 * via this fix) an appropriate reaction:
 *
 * - `control-server.ts`'s `startControlServer` calls this as the very
 *   FIRST thing, before any socket/pipe exists — a thrown error here
 *   propagates out of `startControlServer` with nothing to clean up (no
 *   F9-style orphan-listener risk), straight into `create-daemon.ts`'s
 *   `start()`'s EXISTING "any non-`AnotherControlServerRunningError` bind
 *   failure degrades non-fatally" catch block: logs a loud
 *   `console.warn` naming the reason (this error's own message) and
 *   continues the rest of the daemon WITHOUT a control socket — the
 *   correct "graceful path" for a control-IPC-layer failure, unchanged
 *   code, already exactly right once this function starts throwing.
 * - `DeviceStore.save()` calls this before ever writing `device.json` —
 *   a thrown error here propagates directly out of `AuthManager.pair()`
 *   (called during `pair()`, before any credential is persisted) as a
 *   clear, typed, actionable rejection — pairing simply fails rather than
 *   silently leaving an unprotected device keypair/access token on disk.
 *
 * Non-win32 (darwin/linux) behavior is completely unchanged — the POSIX
 * `mkdir`/`chmod` calls above are the only enforcement there, and never
 * throw on their own best-effort `chmod` failure (that one stays
 * genuinely benign — an `EPERM` against a directory this process doesn't
 * own — see the inline comment on it).
 */
export declare function ensureSecureDir(dir: string, opts?: EnsureSecureDirOptions): Promise<void>;
/** Re-asserts 0600 on POSIX and a non-inherited owner/SYSTEM/Admin DACL on Windows. */
export declare function ensureSecureFile(filePath: string, opts?: EnsureSecureDirOptions): Promise<void>;
